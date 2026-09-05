// The transport dual-write seam. Two edge cases live here and nowhere else:
// sender authorization, and dual-write independence (an upstream throw still
// attempts the mailbox write).
//
// Both are properties of ONE wrapper: a host's mail transport already persists
// its own record of a frame (the sender's outbound copy, agent-instance
// deliveries), and this package additionally lands a durable inbound row in
// every addressed principal's mailbox. Two writes, two owners, and the whole
// point is that neither can take the other down.
//
// The "active instance only" predicate itself is NOT implementable here and is
// not ours to implement: deciding whether a sender address belongs to a live
// agent instance is the host's call, not a schema fact. So it is a seam —
// `authorizeSender` — and the *enforcement* is ours: a sender the host declines
// to authorize gets NO mailbox row, while the frame is still delegated upstream
// exactly as it would have been.

import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { type } from "arktype";
import { getLogger } from "@intx/log";
import { hostPrincipal, mailbox, principalMail } from "./schema.js";
import type { MailboxDb } from "./db.js";
import { publishMailboxEvent, type MailboxEventBus } from "./bus.js";
import { decodeMailFrame, parseMsgIdList, type DecodedFrame } from "./frame.js";
import { resolveMailboxRecipients } from "./recipients.js";
import { MailboxRefArraySchema, type MailboxRef } from "./read.js";
import {
  assertMailboxScope,
  assertMailboxFrameBytes,
  boundRefs,
} from "./write.js";

const logger = getLogger(["corbits-mailbox", "persist"]);

/**
 * Tags a thrown error with the persist stage that produced it, so the
 * dual-write failure log can name `resolveRefs` specifically instead of a
 * generic "mailbox write failed". The wrapped error is what's logged and
 * (never here) rethrown — see `attemptMailboxWrite`.
 */
class MailboxPersistStageError extends Error {
  readonly stage: string;
  constructor(stage: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "MailboxPersistStageError";
    this.stage = stage;
  }
}

// Cap the sender-controlled recipient list before resolve / inArray / multi-row
// insert. Matches MAX_BULK_MAILBOX_IDS posture: hard refuse, never clamp.
export const MAX_MAILBOX_RECIPIENTS = 50;

/**
 * Package-owned idempotency key for one transport dual-write row.
 *
 * Stable across retries of the same frame+recipient so `onConflictDoNothing`
 * collapses a re-delivery into a single durable inbound row (no outbox, no
 * extra table — reuses the partial unique index on message_key):
 * - Prefer Message-ID from the decoded frame when present:
 *   `transport:mid:<Message-ID>:<principalId>`
 * - Else content-hash the raw bytes:
 *   `transport:raw:<sha256(raw)>:<principalId>`
 */
function transportMessageKey(
  messageId: string | null | undefined,
  raw: Uint8Array,
  principalId: string,
): string {
  const mid = messageId?.trim();
  if (mid) return `transport:mid:${mid}:${principalId}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  return `transport:raw:${hash}:${principalId}`;
}

export type MailboxPersistArgs = {
  senderAddress: string;
  recipients: string[];
  raw: Uint8Array;
};

/**
 * What the host says about an authorized sender: which tenant the resulting
 * mailbox rows belong to, and the mail domain that tenant owns. Recipients
 * outside `domain` are skipped, so cross-tenant delivery is impossible by
 * construction rather than by a check someone can forget.
 */
export type SenderAuthorization = { tenantId: string; domain: string };

/**
 * Host seam for sender authorization. Return `null` to refuse: the mailbox
 * write is skipped entirely and the frame is still delegated upstream.
 *
 * The reference behavior is: resolve the
 * sender address to an agent instance that has not ended, and refuse anything
 * else. A host implements that against its own control plane.
 */
export type AuthorizeMailboxSender = (
  senderAddress: string,
) => Promise<SenderAuthorization | null> | SenderAuthorization | null;

/** One durable inbound row, announced after its insert commits. */
export type PersistedMailboxRow = {
  id: string;
  tenantId: string;
  principalId: string;
  recipientAddress: string;
  senderAddress: string;
};

/**
 * Host seam for stamping every recipient row of one frame with the same
 * `refs`. Called once per frame, before the transaction opens — NOT once per
 * recipient — so a host pointing every row at the same upstream entity
 * (`{ kind: "workbench", id }`) does one lookup, not N.
 *
 * The result is validated with `MailboxRefArraySchema` and capped at
 * `MAX_MAILBOX_REFS` the same way `writeMailboxMessage`'s `refs` argument is;
 * see `boundRefs`. Returning `undefined` (or an empty array) stores no refs.
 *
 * A throwing `resolveRefs` is handled exactly like a mailbox-write failure
 * under the dual-write contract: logged, upstream still runs (it already
 * ran, or still will, independently of this), and no mailbox row is written
 * for that frame. See ARCHITECTURE.md's persist section.
 */
export type ResolveMailboxRefs = (
  args: MailboxPersistArgs & {
    senderAuthorization: SenderAuthorization;
    decoded: DecodedFrame | null;
  },
) => Promise<MailboxRef[] | undefined> | MailboxRef[] | undefined;

export type CreateMailboxPersistOpts<R> = {
  /** The host's own persist path. Always called, for every frame. */
  upstream: (args: MailboxPersistArgs) => Promise<R>;
  authorizeSender: AuthorizeMailboxSender;
  /** Best-effort live signal per inserted row. */
  bus?: MailboxEventBus;
  /** Best-effort hook per inserted row; a throw is logged, never propagated. */
  onRow?: (row: PersistedMailboxRow) => void;
  /**
   * Resolve the `refs` every recipient row of one frame gets, INSIDE the
   * existing single transaction — so the post-commit bus event and any SSE
   * subscriber already see them. See `ResolveMailboxRefs`.
   */
  resolveRefs?: ResolveMailboxRefs;
};

/**
 * Wrap a host's mail-persist function so every addressed principal also gets a
 * durable `principal_mail` row.
 *
 * **Dual-write independence** is the contract, in both directions:
 *
 * - `upstream` throwing still attempts the mailbox write, and the upstream
 *   error is then re-thrown unchanged. A transport that cannot reach a
 *   recipient's live session must not also cost that recipient the durable
 *   copy — that copy is precisely what makes the message readable later.
 * - A mailbox-write failure is logged loudly and NEVER rejects a persist
 *   upstream already completed. Reporting failure for a delivery that did
 *   happen invites a retry that double-delivers it.
 */
export function createMailboxPersist<R>(
  db: MailboxDb,
  opts: CreateMailboxPersistOpts<R>,
): (args: MailboxPersistArgs) => Promise<R> {
  function announce(row: PersistedMailboxRow): void {
    if (opts.bus) {
      publishMailboxEvent(
        opts.bus,
        { tenantId: row.tenantId, principalId: row.principalId },
        row.id,
        logger,
        "create",
      );
    }
    if (!opts.onRow) return;
    try {
      opts.onRow(row);
    } catch (err) {
      logger.error("mailbox row hook failed for {rowId}", {
        rowId: row.id,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  async function writeMailboxRows({
    senderAddress,
    recipients,
    raw,
  }: MailboxPersistArgs): Promise<void> {
    // Guardrails before authorize/resolve/SQL: a multi-megabyte frame or a
    // thousands-long recipient list would amplify memory, parameter lists, and
    // per-principal bytea copies. RangeError is caught by attemptMailboxWrite
    // (dual-write independence) but still prevents any partial insert.
    assertMailboxFrameBytes(raw);
    if (recipients.length > MAX_MAILBOX_RECIPIENTS) {
      throw new RangeError(
        `mailbox recipients exceed ${MAX_MAILBOX_RECIPIENTS}`,
      );
    }

    const auth = await opts.authorizeSender(senderAddress);
    if (auth === null) {
      logger.error(
        "Skipping mailbox delivery from unauthorized sender {senderAddress}",
        { senderAddress },
      );
      return;
    }

    const addressed = resolveMailboxRecipients(recipients, auth.domain);
    if (addressed.length === 0) return;

    // The tenant comes from the host's authorizer and the principals from
    // recipient addresses, so this path can produce a blank scope without any
    // caller having typed one. A throw here is caught by `attemptMailboxWrite`
    // and logged loudly, which is the correct outcome: the upstream persist
    // still stands, and the operator hears about an authorizer returning a
    // blank tenant instead of accumulating rows nobody can ever read.
    for (const recipient of addressed) {
      assertMailboxScope({
        tenantId: auth.tenantId,
        principalId: recipient.principalId,
      });
    }

    // Recipient local parts are SENDER-controlled, and the scope FKs refuse a
    // principal the control plane does not know. Filtering here (rather than
    // letting the insert throw) keeps one typo'd address from costing every
    // real recipient on the same frame their durable copy — and is what
    // stops external mail from minting unreachable phantom mailboxes.
    const known = new Set(
      (
        await db
          .select({ id: hostPrincipal.id })
          .from(hostPrincipal)
          .where(
            and(
              eq(hostPrincipal.tenantId, auth.tenantId),
              inArray(
                hostPrincipal.id,
                addressed.map((recipient) => recipient.principalId),
              ),
            ),
          )
      ).map((row) => row.id),
    );
    const resolved = addressed.filter((recipient) =>
      known.has(recipient.principalId),
    );
    const unknown = addressed.filter(
      (recipient) => !known.has(recipient.principalId),
    );
    if (unknown.length > 0) {
      logger.warn("skipping mailbox delivery to unknown principals", {
        tenantId: auth.tenantId,
        addresses: unknown.map((recipient) => recipient.address),
      });
    }
    if (resolved.length === 0) return;

    // Cached columns, parsed once at write. A frame the MIME parser rejects
    // still persists — `raw` stays authoritative for detail; list uses these
    // caches only — so a failed parse is the expected case here, not a fault.
    const decoded = decodeMailFrame(raw);
    const subject = decoded?.headers.get("subject") ?? null;
    const fromAddress = decoded?.headers.get("from") ?? null;
    const messageId = decoded?.messageId ?? null;
    // Cache the same shape migration `0002_mail_threading_headers` backfills
    // from legacy frames: the first BRACKETED msg-id in `In-Reply-To`, or
    // `null` — never the raw header value. An externally delivered frame's
    // `In-Reply-To` is not validated on this path (see `assertMsgId`'s
    // JSDoc), so it can be a bare id, several ids, or otherwise malformed;
    // caching that raw junk would make the cached column disagree with what
    // an upgrade's backfill would have produced for the same frame.
    const inReplyTo = parseMsgIdList(decoded?.headers.get("in-reply-to"))[0] ?? null;

    // Resolved ONCE per frame, before the transaction — every recipient row
    // gets the same refs, and a resolver that hits an upstream entity does one
    // lookup regardless of recipient count. A throw here propagates out of
    // `writeMailboxRows` exactly like any other pre-transaction failure:
    // `attemptMailboxWrite` catches and logs it, upstream still stands, and no
    // mailbox row is written for this frame.
    let refs: MailboxRef[] | undefined;
    if (opts.resolveRefs) {
      let resolvedRefs: MailboxRef[] | undefined;
      try {
        resolvedRefs = await opts.resolveRefs({
          senderAddress,
          recipients,
          raw,
          senderAuthorization: auth,
          decoded,
        });
      } catch (err) {
        throw new MailboxPersistStageError("resolveRefs", err);
      }
      if (resolvedRefs !== undefined && resolvedRefs.length > 0) {
        const validated = MailboxRefArraySchema(resolvedRefs);
        if (validated instanceof type.errors) {
          throw new RangeError(`invalid mailbox refs: ${validated.summary}`);
        }
        refs = boundRefs(validated, messageId, { senderAddress });
      }
    }

    // Mail rows and their management rows commit together: the management row
    // is created eagerly with the message (see `writeMailboxMessage`), and a
    // message without one is unreachable by every mutation. messageKey makes
    // the insert idempotent under transport retry — same onConflictDoNothing
    // pattern as `writeMailboxMessage` on the partial unique index (keys use
    // the transport: namespace, not inbox/gate/run).
    const inserted = await db.transaction(async (tx) => {
      const mailRows = await tx
        .insert(principalMail)
        .values(
          resolved.map((recipient) => ({
            tenantId: auth.tenantId,
            principalId: recipient.principalId,
            address: recipient.address,
            direction: "inbound" as const,
            raw: Buffer.from(raw),
            subject,
            fromAddress,
            messageId,
            inReplyTo,
            refs: refs ?? null,
            messageKey: transportMessageKey(
              messageId,
              raw,
              recipient.principalId,
            ),
          })),
        )
        .onConflictDoNothing({
          target: [
            principalMail.tenantId,
            principalMail.principalId,
            principalMail.messageKey,
          ],
          where: sql`${principalMail.messageKey} IS NOT NULL`,
        })
        .returning({
          id: principalMail.id,
          principalId: principalMail.principalId,
        });
      // `returning` only includes rows that actually inserted; a retry conflict
      // yields an empty list and must not invent management rows.
      if (mailRows.length > 0) {
        await tx.insert(mailbox).values(
          mailRows.map((row) => ({
            id: row.id,
            tenantId: auth.tenantId,
            principalId: row.principalId,
          })),
        );
      }
      return mailRows;
    });

    const byPrincipal = new Map(
      resolved.map((recipient) => [recipient.principalId, recipient]),
    );
    for (const row of inserted) {
      const recipient = byPrincipal.get(row.principalId);
      if (!recipient) continue;
      announce({
        id: row.id,
        tenantId: auth.tenantId,
        principalId: recipient.principalId,
        recipientAddress: recipient.address,
        senderAddress,
      });
    }
  }

  async function attemptMailboxWrite(args: MailboxPersistArgs): Promise<void> {
    try {
      await writeMailboxRows(args);
    } catch (err) {
      // Decoded independently of `writeMailboxRows`'s own decode: the throw
      // may have happened before that decode ran (e.g. authorizeSender), and
      // this log line must still correlate to a messageId when one exists.
      const messageId = decodeMailFrame(args.raw)?.messageId ?? null;
      logger.error("mailbox write failed for mail from {senderAddress}", {
        senderAddress: args.senderAddress,
        messageId,
        ...(err instanceof MailboxPersistStageError ? { stage: err.stage } : {}),
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  return async (args) => {
    let result: R;
    try {
      result = await opts.upstream(args);
    } catch (upstreamErr) {
      await attemptMailboxWrite(args);
      throw upstreamErr;
    }
    await attemptMailboxWrite(args);
    return result;
  };
}
