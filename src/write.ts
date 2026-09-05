import { sql } from "drizzle-orm";
import { type } from "arktype";
import { getLogger } from "@intx/log";
import { mailbox, principalMail } from "./schema.js";
import type { MailboxDb } from "./db.js";
import { publishMailboxEvent, type MailboxEventBus } from "./bus.js";
import {
  assertMsgId,
  buildMailFrame,
  generateMailboxMessageId,
  headerValue,
} from "./frame.js";
import type { MailboxRef } from "./read.js";

const logger = getLogger(["corbits-mailbox", "write"]);

// The write boundary for the scope columns.
//
// The control-plane FKs already refuse a tenant or principal the host does not
// know — including the blank one — but an FK violation surfaces as a driver
// error deep in the insert, long after the caller who typed `""` (or `"  "`,
// which some host might genuinely have as an id) lost its stack. These schemas
// refuse the blank scope at the arktype trust boundary on the way in, where
// the caller can still be blamed precisely.

/**
 * A scope identifier: a string with at least one non-whitespace character.
 *
 * Whitespace-only is rejected as well as empty because `" "` is not a
 * meaningful tenant and is far more likely to be a mis-trimmed header or a
 * template that interpolated nothing than a deliberate identifier. The value is
 * NOT trimmed on the caller's behalf — silently rewriting an identifier would
 * make the row unreachable by the exact string the caller believes it wrote.
 */
export const MailboxScopeIdSchema = type("string").narrow(
  (value, ctx) =>
    value.trim().length > 0 ||
    ctx.mustBe("a non-empty, non-whitespace identifier"),
);

/** The (tenant, principal) pair every mailbox row is addressed by. */
export const MailboxScopeIdsSchema = type({
  tenantId: MailboxScopeIdSchema,
  principalId: MailboxScopeIdSchema,
});
export type MailboxScopeIds = typeof MailboxScopeIdsSchema.infer;

/**
 * Refuse a blank mailbox scope before it reaches the database.
 *
 * `RangeError` for the same reason the bulk cap and the empty enrichment throw
 * it: this is a caller bug, not a request outcome, and the mount layer already
 * renders a `RangeError` from this package as a 400.
 */
export function assertMailboxScope(scope: {
  tenantId: string;
  principalId: string;
}): void {
  const result = MailboxScopeIdsSchema(scope);
  if (result instanceof type.errors) {
    throw new RangeError(`invalid mailbox scope: ${result.summary}`);
  }
}

/** The tenant half alone, for the tenant-wide purge path. */
export function assertMailboxTenantId(tenantId: string): void {
  const result = MailboxScopeIdSchema(tenantId);
  if (result instanceof type.errors) {
    throw new RangeError(`invalid mailbox tenantId: ${result.summary}`);
  }
}

// A single row's `refs` is a compact set of pointers, not a dumping ground.
// Cap what a writer can persist so a runaway producer can never inflate one
// row's jsonb blob unboundedly; extras past the cap are dropped (logged).
export const MAX_MAILBOX_REFS = 20;

// Hard ceiling on a single durable frame (headers + body after build, or raw
// bytes on the transport path). Multi-megabyte MIME would be copied once per
// recipient and re-decoded on detail reads; refuse at the write boundary with
// RangeError (same posture as the bulk-id and page-limit caps — never clamp).
export const MAX_MAILBOX_FRAME_BYTES = 1_048_576;

/** Throw `RangeError` when `raw` is strictly larger than `MAX_MAILBOX_FRAME_BYTES`. */
export function assertMailboxFrameBytes(raw: Uint8Array): void {
  if (raw.byteLength > MAX_MAILBOX_FRAME_BYTES) {
    throw new RangeError(
      `mailbox frame exceeds ${MAX_MAILBOX_FRAME_BYTES} bytes`,
    );
  }
}

// `messageKey` is the caller's own identifier and is absent for externally
// delivered mail, which is never deduped — the warning below carries whatever
// the caller actually supplied rather than minting an id nobody can correlate.
export function boundRefs(
  refs: MailboxRef[] | undefined,
  messageKey: string | null,
  /** Extra correlation fields merged into the truncation log line, e.g. `senderAddress` on the persist path. */
  extra?: Record<string, unknown>,
): MailboxRef[] | undefined {
  if (refs === undefined || refs.length === 0) return undefined;
  if (refs.length <= MAX_MAILBOX_REFS) return refs;
  logger.warn("mailbox refs truncated to the cap for {messageKey}", {
    messageKey,
    received: refs.length,
    kept: MAX_MAILBOX_REFS,
    ...extra,
  });
  return refs.slice(0, MAX_MAILBOX_REFS);
}

export type WriteMailboxMessageArgs = {
  tenantId: string;
  principalId: string;
  address: string;
  fromAddress: string;
  subject: string;
  body: string;
  /**
   * Idempotency key; a second write with the same key is a no-op (returns
   * null). Omitted, a write still gets a stable key of its own: the package's
   * transport key (`mailboxKey.transport`), derived from the frame's
   * `messageId` and the recipient `principalId` — so a caller that retries
   * the exact same `messageId` collapses onto one row without having to mint
   * its own key, while two independent writes with different (minted)
   * `messageId`s never collide.
   */
  messageKey?: string;
  /**
   * The complete msg-id (angle brackets included) this write's frame carries
   * as its `Message-ID:` header, and the value cached in
   * `principal_mail.message_id`. `RangeError` (via `assertMsgId`) when it is
   * not a bracketed msg-id. Omitted, one is minted the way it always was —
   * `generateMailboxMessageId`.
   */
  messageId?: string;
  /**
   * `"inbound"` (default) or `"outbound"`. The mailbox row's own copy of who
   * sent it: an inbound row is delivered mail, an outbound row is the
   * sender's durable copy of a message they sent. Purely a stored fact —
   * this package's inbox views stay inbound-only regardless of what a caller
   * writes here (see ARCHITECTURE.md's Known limits).
   */
  direction?: "inbound" | "outbound";
  inReplyTo?: string;
  /**
   * The thread's ancestry, oldest first; each entry a bracketed msg-id. Emitted
   * as a folded `References:` header on the frame this write builds — see
   * `buildMailFrame`. `RangeError` on an entry that is not a bracketed msg-id.
   */
  references?: string[];
  refs?: MailboxRef[];
  /**
   * Triage known at write time. Values are the HOST's vocabulary — this
   * package has none of its own — so they are plain strings here and are
   * validated at the mount boundary, which is where the vocabulary lives.
   * The message's `mailbox` row is created with the message either way;
   * these stamp it at delivery.
   */
  priority?: string;
  classification?: string;
  status?: string;
};

/**
 * Drizzle transaction handle used by the shared insert path. Both the root
 * `db.transaction` callback and a nested savepoint expose the same `insert`.
 */
type MailboxInsertTx = {
  insert: MailboxDb["insert"];
};

/**
 * Normalize the threading fields once, on the way in, so the value cached in
 * `principal_mail.in_reply_to` and the value that ends up in the frame's
 * `In-Reply-To:` header are the SAME string.
 *
 * `buildMailFrame` already runs every threading value through `headerValue`
 * before writing it into `raw` — trimmed and newline-flattened. Without this,
 * `insertMailboxMessage` cached `args.inReplyTo` untrimmed, so a caller
 * passing `"  <parent@x> "` produced a row whose list projection (served from
 * the cached column) differed from its detail projection (served from the
 * frame) for the exact same message. Applying the same normalization here,
 * once, before either the cache write or the frame encode, is what keeps them
 * in agreement — not two independent trims that could drift apart.
 */
function normalizeThreadingArgs<
  T extends {
    messageId?: string;
    inReplyTo?: string;
    references?: string[];
  },
>(args: T): T {
  const normalized: T = { ...args };
  if (args.messageId !== undefined) {
    normalized.messageId = headerValue(args.messageId);
  }
  if (args.inReplyTo !== undefined) {
    normalized.inReplyTo = headerValue(args.inReplyTo);
  }
  if (args.references !== undefined) {
    normalized.references = args.references.map(headerValue);
  }
  return normalized;
}

/**
 * Encode args into a durable MIME frame.
 *
 * Uses the caller's `messageId` (already validated as a bracketed msg-id by
 * `assertMsgId` below) when supplied, else mints a fresh one exactly as
 * before. Either way the id is returned alongside the bytes rather than
 * re-parsed out of them: it is what the row's `message_id` cache stores, and
 * re-decoding a frame this function just built to recover a value it already
 * had is work with a failure mode attached.
 */
function encodeMailboxFrame(args: WriteMailboxMessageArgs): {
  raw: Uint8Array;
  messageId: string;
} {
  if (args.messageId !== undefined) assertMsgId(args.messageId, "messageId");
  const messageId = args.messageId ?? generateMailboxMessageId(args.fromAddress);
  const frameArgs: Parameters<typeof buildMailFrame>[0] = {
    from: args.fromAddress,
    to: args.address,
    subject: args.subject,
    body: args.body,
    messageId,
  };
  if (args.inReplyTo !== undefined) frameArgs.inReplyTo = args.inReplyTo;
  if (args.references !== undefined) frameArgs.references = args.references;
  return { raw: buildMailFrame(frameArgs), messageId };
}

/**
 * Cheap pre-encode refusal: body or any header field alone at the frame-byte
 * cap cannot produce a legal frame (headers always add more). Full built-frame
 * assert still runs after encode.
 */
function assertMailboxStringFieldsFit(args: {
  body: string;
  subject: string;
  fromAddress: string;
  address: string;
  inReplyTo?: string;
  references?: string[];
}): void {
  const fields = [args.body, args.subject, args.fromAddress, args.address];
  if (args.inReplyTo !== undefined) fields.push(args.inReplyTo);
  if (args.references !== undefined) fields.push(...args.references);
  for (const field of fields) {
    if (Buffer.byteLength(field) >= MAX_MAILBOX_FRAME_BYTES) {
      throw new RangeError(
        `mailbox frame exceeds ${MAX_MAILBOX_FRAME_BYTES} bytes`,
      );
    }
  }
}

/**
 * Insert the mail row and its eager management row on the given handle.
 * Returns the new id, or null when a non-null messageKey already existed
 * (`onConflictDoNothing`). Caller owns scope validation, frame encoding, and
 * any surrounding transaction. `raw` is re-asserted against
 * `MAX_MAILBOX_FRAME_BYTES` here as defense in depth.
 */
async function insertMailboxMessage(
  tx: MailboxInsertTx,
  args: WriteMailboxMessageArgs,
  raw: Uint8Array,
  messageId: string,
): Promise<{ id: string } | null> {
  assertMailboxFrameBytes(raw);
  const messageKey = args.messageKey ?? mailboxKey.transport(messageId, args.principalId);
  const refs = boundRefs(args.refs, messageKey);

  // The management row is created EAGERLY with the message: every mutation and
  // the unread count are then plain operations on `mailbox`, and the unread
  // partial index can serve the hottest endpoint. Split across transactions, a
  // crash between the two would commit the mail row alone — and a retry then
  // hits the messageKey dedupe and returns null, leaving a message no mutation
  // can reach.
  const rows = await tx
    .insert(principalMail)
    .values({
      tenantId: args.tenantId,
      principalId: args.principalId,
      address: args.address,
      direction: args.direction ?? "inbound",
      raw: Buffer.from(raw),
      subject: args.subject,
      fromAddress: args.fromAddress,
      messageKey,
      messageId,
      inReplyTo: args.inReplyTo ?? null,
      refs: refs ?? null,
    })
    .onConflictDoNothing({
      target: [
        principalMail.tenantId,
        principalMail.principalId,
        principalMail.messageKey,
      ],
      where: sql`${principalMail.messageKey} IS NOT NULL`,
    })
    .returning({ id: principalMail.id });

  const inserted = rows[0];
  if (!inserted) return null;

  await tx.insert(mailbox).values({
    id: inserted.id,
    tenantId: args.tenantId,
    principalId: args.principalId,
    priority: args.priority ?? null,
    classification: args.classification ?? null,
    status: args.status ?? null,
  });
  return inserted;
}

/**
 * Insert one durable mailbox row, deduped on (tenantId, principalId,
 * messageKey) via a partial unique index that only constrains rows with a
 * non-null messageKey — externally-delivered mail with no key is never
 * deduped or constrained by it.
 *
 * Throws `RangeError` on a blank tenantId or principalId (see `assertMailboxScope`),
 * when the built frame exceeds `MAX_MAILBOX_FRAME_BYTES`, and a Postgres FK
 * violation on a tenant or principal the host's control plane does not know —
 * writing to a mailbox that cannot exist is a caller bug, not a deliverable
 * outcome.
 *
 * Returns the new row id, or null when the messageKey was already written.
 * When `bus` is supplied, a successful insert also publishes a live signal
 * to the recipient — strictly best-effort: a publish failure is logged and
 * never turns a successful write into a caller-visible error.
 */
export async function writeMailboxMessage(
  db: MailboxDb,
  rawArgs: WriteMailboxMessageArgs,
  bus?: MailboxEventBus,
): Promise<{ id: string } | null> {
  assertMailboxScope(rawArgs);
  const args = normalizeThreadingArgs(rawArgs);
  // Refuse obviously oversize string fields before allocating the full encode.
  assertMailboxStringFieldsFit(args);
  // Encode and size-check the built frame before opening a transaction so
  // oversize input never pays for a begin/rollback.
  const { raw, messageId } = encodeMailboxFrame(args);
  assertMailboxFrameBytes(raw);
  // One transaction for the mail row and its management row.
  const row = await db.transaction(async (tx) =>
    insertMailboxMessage(tx, args, raw, messageId),
  );
  if (!row) return null;

  if (bus) {
    publishMailboxEvent(
      bus,
      { tenantId: args.tenantId, principalId: args.principalId },
      row.id,
      logger,
      "create",
    );
  }
  return { id: row.id };
}

/**
 * Idempotency-key namespaces. Every hub-authored write prefixes its key with
 * the namespace that minted it, so two producers keying off the same
 * underlying id never collide on one row: an approval gate (`gate:<id>`) and
 * the run it belongs to (`run:<id>`) each get their own mailbox message even
 * when `<id>` is identical.
 *
 * Inbox keys use a versioned length-prefixed encoding
 * (`inbox2:${source.length}:${source}:${externalId}`) so the encoding is
 * injective over the (source, externalId) pair — (`a:b`,`c`) and (`a`,`b:c`)
 * never share a key. (A NUL-join would also be injective, but Postgres text
 * rejects U+0000.) The `inbox2:` prefix keeps the space disjoint from pre-upgrade
 * `inbox:<source>:<externalId>` keys: length-prefix alone would false-collide
 * when a historical source was pure decimal (e.g. old `inbox:5:gmail:123` ==
 * length-prefixed `inbox:5:gmail:123` for source=`gmail`). Pre-upgrade rows will
 * not dedupe against the new encoding and cannot false-collide with it — no
 * migration is performed; redelivery after upgrade may insert a second row.
 */
// `transport` is the default `writeMailboxMessage` / `writeMailboxMessages`
// fall back to when a caller supplies no `messageKey` of its own: keyed on
// the frame's own `messageId` (caller-supplied or minted) plus the recipient
// `principalId`, matching `persist.ts`'s transport dual-write key shape
// (`transport:mid:<Message-ID>:<principalId>`) without importing from it —
// that file owns a second fallback (content-hash) for frames with no
// Message-ID at all, which never happens on this package's own write path,
// where a `messageId` is always present by the time a row is inserted.
export const mailboxKey = {
  inbox: (source: string, externalId: string) =>
    `inbox2:${source.length}:${source}:${externalId}`,
  gate: (gateId: string) => `gate:${gateId}`,
  run: (runId: string) => `run:${runId}`,
  transport: (messageId: string, principalId: string) =>
    `transport:mid:${messageId}:${principalId}`,
} as const;

export type InboxItem = {
  tenantId: string;
  principalId: string;
  address: string;
  fromAddress: string;
  subject: string;
  body: string;
  source: string;
  externalId: string;
  /** The immediate parent's msg-id, brackets included. */
  inReplyTo?: string;
  /** The thread's ancestry, oldest first; see `WriteMailboxMessageArgs`. */
  references?: string[];
  refs?: MailboxRef[];
  // An adapter that already knows an item's triage verdict stamps it
  // at delivery rather than writing the row and immediately updating it.
  // Host vocabulary; see `WriteMailboxMessageArgs`.
  priority?: string;
  classification?: string;
  status?: string;
};

export type DeliverInboxItemsOpts = {
  bus?: MailboxEventBus;
  /**
   * Optional host-supplied triage hook; called once per newly-delivered row,
   * strictly after the batch commits. Best-effort: a throw is logged with the
   * message id and never rejects the delivery — the durable row already exists,
   * and a host whose hook permanently fails on the first try must triage
   * independently (retries of this call will dedupe and skip enqueue).
   */
  enqueue?: (delivered: { id: string; item: InboxItem }) => void;
};

/** `id` is null exactly when the item was deduped — no row was written. */
export type DeliveredInboxItem = { messageKey: string; id: string | null };

/**
 * Shared delivery seam for ingress adapters (mail connectors, webhooks,
 * anything durable-fanning-out into principal mailboxes). Dedupe key is
 * `mailboxKey.inbox(source, externalId)` (versioned length-prefixed;
 * injective over the pair) — the same external item re-delivered by a retried
 * adapter never writes twice. Triage logic itself is NOT this package's concern:
 * `enqueue`, if given, is invoked after commit for each newly inserted id.
 *
 * Throws `RangeError` on a blank tenantId or principalId anywhere in the batch,
 * and when any item's string fields or built frame exceed the frame-byte cap —
 * every item is scope-checked, field-checked, encoded, and frame-asserted
 * BEFORE the transaction opens so oversize input never begins a multi-row
 * insert. After that prevalidation, all new mail + management rows for the
 * call commit in ONE `db.transaction` (or none). Deduped keys (`id: null`) are
 * no-ops inside the transaction without breaking atomicity. Bus publish and
 * `enqueue` run only after commit, and only for newly inserted ids; a throwing
 * `enqueue` is logged and swallowed (same posture as `publishMailboxEvent`).
 */
export async function deliverInboxItems(
  db: MailboxDb,
  items: InboxItem[],
  opts?: DeliverInboxItemsOpts,
): Promise<DeliveredInboxItem[]> {
  type Prepared = {
    item: InboxItem;
    messageKey: string;
    writeArgs: WriteMailboxMessageArgs;
    raw: Uint8Array;
    messageId: string;
  };
  const prepared: Prepared[] = [];
  for (const item of items) {
    assertMailboxScope(item);
    assertMailboxStringFieldsFit(item);
    const messageKey = mailboxKey.inbox(item.source, item.externalId);
    const writeArgs: WriteMailboxMessageArgs = {
      tenantId: item.tenantId,
      principalId: item.principalId,
      address: item.address,
      fromAddress: item.fromAddress,
      subject: item.subject,
      body: item.body,
      messageKey,
    };
    if (item.inReplyTo !== undefined) writeArgs.inReplyTo = item.inReplyTo;
    if (item.references !== undefined) writeArgs.references = item.references;
    if (item.refs !== undefined) writeArgs.refs = item.refs;
    if (item.priority !== undefined) writeArgs.priority = item.priority;
    if (item.classification !== undefined) {
      writeArgs.classification = item.classification;
    }
    if (item.status !== undefined) writeArgs.status = item.status;
    const normalizedWriteArgs = normalizeThreadingArgs(writeArgs);
    const { raw, messageId } = encodeMailboxFrame(normalizedWriteArgs);
    assertMailboxFrameBytes(raw);
    prepared.push({
      item,
      messageKey,
      writeArgs: normalizedWriteArgs,
      raw,
      messageId,
    });
  }

  type Inserted = { id: string; item: InboxItem };
  const { results, inserted } = await db.transaction(async (tx) => {
    const results: DeliveredInboxItem[] = [];
    const inserted: Inserted[] = [];
    for (const { item, messageKey, writeArgs, raw, messageId } of prepared) {
      const written = await insertMailboxMessage(tx, writeArgs, raw, messageId);
      if (written === null) {
        results.push({ messageKey, id: null });
        continue;
      }
      results.push({ messageKey, id: written.id });
      inserted.push({ id: written.id, item });
    }
    return { results, inserted };
  });

  // Post-commit only: live signals and host triage for newly inserted ids.

  for (const { id, item } of inserted) {
    if (opts?.bus) {
      publishMailboxEvent(
        opts.bus,
        { tenantId: item.tenantId, principalId: item.principalId },
        id,
        logger,
        "create",
      );
    }
    if (!opts?.enqueue) continue;
    try {
      opts.enqueue({ id, item });
    } catch (err) {
      logger.error("mailbox enqueue failed for {rowId}", {
        rowId: id,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  return results;
}

/** One item of a `writeMailboxMessages` batch: an address plus the scope it lands in. */
export type WriteMailboxMessagesItem = {
  scope: MailboxScopeIds;
  args: WriteMailboxMessageArgs;
};

export type WriteMailboxMessagesOpts = {
  /** Best-effort live signal per inserted row, published only after commit. */
  bus?: MailboxEventBus;
};

/**
 * Write an entire conversation turn — a sender's own outbound copy alongside
 * every recipient's inbound copy, or any other mixed-scope, mixed-direction
 * batch — as ONE transaction. This is the conversation path; `deliverInboxItems`
 * remains the notify-item path (ingress adapters fanning one external item out
 * to durable rows) and is unchanged by this function's existence.
 *
 * Each item is scope-checked, field-checked, encoded, and frame-asserted
 * BEFORE the transaction opens — same prevalidation discipline as
 * `deliverInboxItems` — so oversize or malformed input never begins a
 * multi-row insert. All rows then commit together inside one
 * `db.transaction`: a throw from any single item (a caller bug, or a control-
 * plane FK the item's scope does not satisfy) rolls back every row the batch
 * would otherwise have written, including ones already inserted earlier in
 * the same call.
 *
 * Dedupe is per row, on `(tenantId, principalId, messageKey)` via
 * `onConflictDoNothing` on the existing partial unique index — the same
 * mechanism `writeMailboxMessage` and `deliverInboxItems` use. A row whose
 * `messageKey` collides with one already committed is a no-op inside the
 * transaction, not a rollback trigger; retrying an entire successful batch
 * therefore commits nothing the second time and returns no ids.
 *
 * Returns the ids of rows this call actually inserted, in item order,
 * skipping any item deduped by its messageKey. Bus events publish only after
 * commit, one per written row — never for a deduped item, and never before
 * the transaction is durable.
 */
export async function writeMailboxMessages(
  db: MailboxDb,
  items: WriteMailboxMessagesItem[],
  opts?: WriteMailboxMessagesOpts,
): Promise<string[]> {
  type Prepared = {
    scope: MailboxScopeIds;
    writeArgs: WriteMailboxMessageArgs;
    raw: Uint8Array;
    messageId: string;
  };
  const prepared: Prepared[] = [];
  for (const { scope, args } of items) {
    assertMailboxScope(scope);
    const writeArgs: WriteMailboxMessageArgs = {
      ...normalizeThreadingArgs(args),
      tenantId: scope.tenantId,
      principalId: scope.principalId,
    };
    assertMailboxStringFieldsFit(writeArgs);
    const { raw, messageId } = encodeMailboxFrame(writeArgs);
    assertMailboxFrameBytes(raw);
    prepared.push({ scope, writeArgs, raw, messageId });
  }

  type Inserted = { id: string; scope: MailboxScopeIds };
  const inserted: Inserted[] = await db.transaction(async (tx) => {
    const inserted: Inserted[] = [];
    for (const { scope, writeArgs, raw, messageId } of prepared) {
      const written = await insertMailboxMessage(tx, writeArgs, raw, messageId);
      if (written === null) continue;
      inserted.push({ id: written.id, scope });
    }
    return inserted;
  });

  // Post-commit only: live signals for newly inserted ids, one per row.
  if (opts?.bus) {
    for (const { id, scope } of inserted) {
      publishMailboxEvent(opts.bus, scope, id, logger, "create");
    }
  }

  return inserted.map((row) => row.id);
}
