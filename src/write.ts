// The write boundary over the native `MailboxStore`. Every host-facing write
// path (`writeMailboxMessage`, `deliverInboxItems`, and `persist.ts`'s
// transport dual-write) lands through `NativeMailboxStore.append`, so uid and
// modseq are always set — there is no second, uid-less insert path left in
// this package.

import { type } from "arktype";
import { getLogger } from "@intx/log";
import type { MailboxDb } from "./db.js";
import { openNativeMailboxStore } from "./native-store.js";
import { publishMailboxEvent, type MailboxEventBus } from "./bus.js";
import {
  assertMsgId,
  buildMailFrame,
  generateMailboxMessageId,
  headerValue,
} from "./frame.js";

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
 * `RangeError` for the same reason the frame-byte cap throws it: this is a
 * caller bug, not a request outcome, and the mount layer renders a
 * `RangeError` from this package as a 400.
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

// Hard ceiling on a single durable frame (headers + body after build, or raw
// bytes on the transport path). Multi-megabyte MIME would be copied once per
// recipient and re-decoded on read; refuse at the write boundary with
// RangeError — never clamp.
export const MAX_MAILBOX_FRAME_BYTES = 1_048_576;

/** Throw `RangeError` when `raw` is strictly larger than `MAX_MAILBOX_FRAME_BYTES`. */
export function assertMailboxFrameBytes(raw: Uint8Array): void {
  if (raw.byteLength > MAX_MAILBOX_FRAME_BYTES) {
    throw new RangeError(
      `mailbox frame exceeds ${MAX_MAILBOX_FRAME_BYTES} bytes`,
    );
  }
}

export type WriteMailboxMessageArgs = {
  tenantId: string;
  principalId: string;
  address: string;
  fromAddress: string;
  subject: string;
  body: string;
  /**
   * The complete msg-id (angle brackets included) this write's frame carries
   * as its `Message-ID:` header. `RangeError` (via `assertMsgId`) when it is
   * not a bracketed msg-id. Omitted, one is minted —
   * `generateMailboxMessageId`. Also the write's idempotency key: a second
   * write carrying the same `messageId` into the same (tenant, principal,
   * folder) mailbox is a no-op (returns `null`).
   */
  messageId?: string;
  inReplyTo?: string;
  /**
   * The thread's ancestry, oldest first; each entry a bracketed msg-id. Emitted
   * as a folded `References:` header on the frame this write builds — see
   * `buildMailFrame`. `RangeError` on an entry that is not a bracketed msg-id.
   */
  references?: string[];
  /** Defaults to `"INBOX"`. */
  folder?: string;
};

/**
 * Normalize the threading fields once, on the way in, so the value cached in
 * the store's envelope and the value that ends up in the frame's headers are
 * the SAME string. `buildMailFrame` already runs every threading value
 * through `headerValue` before writing it into `raw` — applying the same
 * normalization here, once, keeps the envelope and the frame in agreement.
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
 * Encode args into a durable MIME frame. Uses the caller's `messageId`
 * (already validated as a bracketed msg-id by `assertMsgId` below) when
 * supplied, else mints a fresh one.
 */
function encodeMailboxFrame(args: WriteMailboxMessageArgs): {
  raw: Uint8Array;
  messageId: string;
} {
  if (args.messageId !== undefined) assertMsgId(args.messageId, "messageId");
  const messageId =
    args.messageId ?? generateMailboxMessageId(args.fromAddress);
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
 * Append one durable message into a principal's native mailbox, deduped on
 * `messageId` within the target (tenant, principal, folder) mailbox: a second
 * write carrying the same `messageId` is a no-op and returns `null`.
 *
 * Throws `RangeError` on a blank tenantId/principalId (see
 * `assertMailboxScope`), a non-msg-id `messageId`/`inReplyTo`/`references`
 * entry, or a built frame over `MAX_MAILBOX_FRAME_BYTES`.
 *
 * When `bus` is supplied, a successful append also publishes a live signal to
 * the recipient — best-effort, same posture as everywhere else in this
 * package.
 */
export async function writeMailboxMessage(
  db: MailboxDb,
  rawArgs: WriteMailboxMessageArgs,
  bus?: MailboxEventBus,
): Promise<{ id: string; uid: number } | null> {
  assertMailboxScope(rawArgs);
  const args = normalizeThreadingArgs(rawArgs);
  assertMailboxStringFieldsFit(args);
  const { raw, messageId } = encodeMailboxFrame(args);
  assertMailboxFrameBytes(raw);

  const folder = args.folder ?? "INBOX";
  const store = await openNativeMailboxStore(db, {
    tenantId: args.tenantId,
    principalId: args.principalId,
    folder,
  });
  if (store.messages.some((m) => m.envelope.messageId === messageId)) {
    return null;
  }
  const uid = store.append(
    raw,
    {
      messageId,
      from: args.fromAddress,
      to: [args.address],
      subject: args.subject,
      date: new Date(),
      inReplyTo: args.inReplyTo,
      references: args.references ?? [],
      interchangeType: undefined,
      interchangeCorrelationId: undefined,
    },
    [],
  );
  await store.settled;

  const id = `${args.tenantId}:${args.principalId}:${folder}:${uid}`;
  if (bus) {
    publishMailboxEvent(
      bus,
      { tenantId: args.tenantId, principalId: args.principalId },
      id,
      logger,
      "create",
    );
  }
  return { id, uid };
}

/**
 * One externally-sourced item an ingress adapter (mail connector, webhook,
 * anything durable-fanning-out into principal mailboxes) wants delivered.
 * `source` + `externalId` are the adapter's own dedupe key: redelivering the
 * same external item is a no-op, by minting the same `messageId` from them
 * when the item carries none of its own.
 */
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
};

export type DeliverInboxItemsOpts = {
  bus?: MailboxEventBus;
  /**
   * Optional host hook, called once per newly-delivered item, strictly after
   * its append settles. Best-effort: a throw is logged with the item's id and
   * never rejects the delivery.
   */
  enqueue?: (delivered: { id: string; item: InboxItem }) => void;
};

/** `id` is null exactly when the item deduped against an existing message. */
export type DeliveredInboxItem = { id: string | null };

/**
 * Shared delivery seam for ingress adapters. Each item is delivered with
 * `writeMailboxMessage`, one append at a time (the native store has no
 * multi-row batch — see `NativeMailboxStore`), deduped on a `messageId` minted
 * from `(source, externalId)` when the item carries none of its own, so the
 * same external item redelivered by a retried adapter never appends twice.
 */
export async function deliverInboxItems(
  db: MailboxDb,
  items: InboxItem[],
  opts?: DeliverInboxItemsOpts,
): Promise<DeliveredInboxItem[]> {
  const results: DeliveredInboxItem[] = [];
  for (const item of items) {
    const messageId = `<inbox-${item.source}-${item.externalId}@mailbox.invalid>`;
    const writeArgs: WriteMailboxMessageArgs = {
      tenantId: item.tenantId,
      principalId: item.principalId,
      address: item.address,
      fromAddress: item.fromAddress,
      subject: item.subject,
      body: item.body,
      messageId,
    };
    if (item.inReplyTo !== undefined) writeArgs.inReplyTo = item.inReplyTo;
    if (item.references !== undefined) writeArgs.references = item.references;
    const written = await writeMailboxMessage(db, writeArgs, opts?.bus);
    results.push({ id: written?.id ?? null });
    if (written && opts?.enqueue) {
      try {
        opts.enqueue({ id: written.id, item });
      } catch (err) {
        logger.error("mailbox enqueue failed for {id}", {
          id: written.id,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
  }
  return results;
}
