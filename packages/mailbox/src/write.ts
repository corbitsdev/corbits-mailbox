import { sql } from "drizzle-orm";
import { type } from "arktype";
import { getLogger } from "@intx/log";
import { mailbox, principalMail } from "./schema.js";
import type { MailboxDb } from "./db.js";
import { publishMailboxEvent, type MailboxEventBus } from "./bus.js";
import { buildMailFrame, generateMailboxMessageId } from "./frame.js";
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

// `messageKey` is the caller's own identifier and is absent for externally
// delivered mail, which is never deduped — the warning below carries whatever
// the caller actually supplied rather than minting an id nobody can correlate.
function boundRefs(
  refs: MailboxRef[] | undefined,
  messageKey: string | null,
): MailboxRef[] | undefined {
  if (refs === undefined || refs.length === 0) return undefined;
  if (refs.length <= MAX_MAILBOX_REFS) return refs;
  logger.warn("mailbox refs truncated to the cap for {messageKey}", {
    messageKey,
    received: refs.length,
    kept: MAX_MAILBOX_REFS,
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
  /** Idempotency key; a second write with the same key is a no-op (returns null). */
  messageKey?: string;
  inReplyTo?: string;
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
 * Insert the mail row and its eager management row on the given handle.
 * Returns the new id, or null when a non-null messageKey already existed
 * (`onConflictDoNothing`). Caller owns scope validation and any surrounding
 * transaction.
 */
async function insertMailboxMessage(
  tx: MailboxInsertTx,
  args: WriteMailboxMessageArgs,
): Promise<{ id: string } | null> {
  const messageId = generateMailboxMessageId(args.fromAddress);
  const frameArgs: Parameters<typeof buildMailFrame>[0] = {
    from: args.fromAddress,
    to: args.address,
    subject: args.subject,
    body: args.body,
    messageId,
  };
  if (args.inReplyTo !== undefined) frameArgs.inReplyTo = args.inReplyTo;
  const raw = buildMailFrame(frameArgs);
  const refs = boundRefs(args.refs, args.messageKey ?? null);

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
      direction: "inbound",
      raw: Buffer.from(raw),
      subject: args.subject,
      fromAddress: args.fromAddress,
      messageKey: args.messageKey ?? null,
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
 * and a Postgres FK violation on a tenant or principal the host's control
 * plane does not know — writing to a mailbox that cannot exist is a caller
 * bug, not a deliverable outcome.
 *
 * Returns the new row id, or null when the messageKey was already written.
 * When `bus` is supplied, a successful insert also publishes a live signal
 * to the recipient — strictly best-effort: a publish failure is logged and
 * never turns a successful write into a caller-visible error.
 */
export async function writeMailboxMessage(
  db: MailboxDb,
  args: WriteMailboxMessageArgs,
  bus?: MailboxEventBus,
): Promise<{ id: string } | null> {
  assertMailboxScope(args);
  // One transaction for the mail row and its management row.
  const row = await db.transaction(async (tx) => insertMailboxMessage(tx, args));
  if (!row) return null;

  if (bus) {
    publishMailboxEvent(
      bus,
      { tenantId: args.tenantId, principalId: args.principalId },
      row.id,
      logger,
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
export const mailboxKey = {
  inbox: (source: string, externalId: string) =>
    `inbox2:${source.length}:${source}:${externalId}`,
  gate: (gateId: string) => `gate:${gateId}`,
  run: (runId: string) => `run:${runId}`,
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
 * checked for EVERY item before the first row is written. After that
 * prevalidation, all new mail + management rows for the call commit in ONE
 * `db.transaction` (or none): a mid-batch FK / driver failure rolls back every
 * new row from that call. Deduped keys (`id: null`) are no-ops inside the
 * transaction without breaking atomicity. Bus publish and `enqueue` run only
 * after commit, and only for newly inserted ids; a throwing `enqueue` is
 * logged and swallowed (same posture as `publishMailboxEvent`).
 */
export async function deliverInboxItems(
  db: MailboxDb,
  items: InboxItem[],
  opts?: DeliverInboxItemsOpts,
): Promise<DeliveredInboxItem[]> {
  for (const item of items) assertMailboxScope(item);

  type Inserted = { id: string; item: InboxItem };
  const { results, inserted } = await db.transaction(async (tx) => {
    const results: DeliveredInboxItem[] = [];
    const inserted: Inserted[] = [];
    for (const item of items) {
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
      if (item.refs !== undefined) writeArgs.refs = item.refs;
      if (item.priority !== undefined) writeArgs.priority = item.priority;
      if (item.classification !== undefined) {
        writeArgs.classification = item.classification;
      }
      if (item.status !== undefined) writeArgs.status = item.status;
      const written = await insertMailboxMessage(tx, writeArgs);
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
