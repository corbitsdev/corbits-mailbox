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

  // One transaction for the mail row and its management row. The management
  // row is created EAGERLY, with the message: every mutation and the unread
  // count are then plain operations on `mailbox`, and the unread partial index
  // can serve the hottest endpoint. Split across transactions, a crash between
  // the two would commit the mail row alone — and a retry then hits the
  // messageKey dedupe and returns null, leaving a message no mutation can
  // reach.
  const row = await db.transaction(async (tx) => {
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
  });
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
 */
export const mailboxKey = {
  inbox: (source: string, externalId: string) =>
    `inbox:${source}:${externalId}`,
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
  /** Optional host-supplied triage hook; called once per newly-delivered row. */
  enqueue?: (delivered: { id: string; item: InboxItem }) => void;
};

/** `id` is null exactly when the item was deduped — no row was written. */
export type DeliveredInboxItem = { messageKey: string; id: string | null };

/**
 * Shared delivery seam for ingress adapters (mail connectors, webhooks,
 * anything durable-fanning-out into principal mailboxes). Dedupe key is
 * `inbox:<source>:<externalId>` — the same external item re-delivered by a
 * retried adapter never writes twice. Triage logic itself is NOT this
 * package's concern: `enqueue`, if given, is called and nothing more.
 *
 * Throws `RangeError` on a blank tenantId or principalId anywhere in the batch,
 * checked for EVERY item before the first row is written. `writeMailboxMessage`
 * would refuse the bad item on its own, but only after delivering the items
 * ahead of it — leaving an adapter that retries the whole batch to re-deliver
 * them. Validating up front makes the refusal all-or-nothing.
 */
export async function deliverInboxItems(
  db: MailboxDb,
  items: InboxItem[],
  opts?: DeliverInboxItemsOpts,
): Promise<DeliveredInboxItem[]> {
  for (const item of items) assertMailboxScope(item);
  const results: DeliveredInboxItem[] = [];
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
    const written = await writeMailboxMessage(db, writeArgs, opts?.bus);
    if (written === null) {
      results.push({ messageKey, id: null });
      continue;
    }
    results.push({ messageKey, id: written.id });
    if (opts?.enqueue) {
      opts.enqueue({ id: written.id, item });
    }
  }
  return results;
}
