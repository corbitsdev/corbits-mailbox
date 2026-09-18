// The transport dual-write seam. Two edge cases live here and nowhere else:
// sender authorization, and dual-write independence (an upstream throw still
// attempts the mailbox write).
//
// A host's mail transport already persists its own record of a frame (the
// sender's outbound copy, agent-instance deliveries), and this package
// additionally lands a durable inbound row — through the native store's
// `append`, so it always carries a uid/modseq — in every addressed
// principal's INBOX. Two writes, two owners, and the whole point is that
// neither can take the other down.
//
// The "active instance only" predicate itself is NOT implementable here and is
// not ours to implement: deciding whether a sender address belongs to a live
// agent instance is the host's call, not a schema fact. So it is a seam —
// `authorizeSender` — and the *enforcement* is ours: a sender the host declines
// to authorize gets NO mailbox row, while the frame is still delegated upstream
// exactly as it would have been.

import { and, eq, inArray, or, sql } from "drizzle-orm";
import { getLogger } from "@intx/log";
import { hostPrincipal } from "./schema.js";
import type { MailboxDb } from "./db.js";
import { openNativeMailboxStore } from "./native-store.js";
import { publishMailboxEvent, type MailboxEventBus } from "./bus.js";
import { decodeMailFrame, parseMsgIdList } from "./frame.js";
import {
  resolveMailboxRecipients,
  type ResolvedRecipient,
} from "./recipients.js";
import { assertMailboxScope, assertMailboxFrameBytes } from "./write.js";

const logger = getLogger(["corbits-mailbox", "persist"]);

// Cap the sender-controlled recipient list before resolve / inArray / one
// append per recipient. Hard refuse, never clamp.
export const MAX_MAILBOX_RECIPIENTS = 50;

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
 */
export type AuthorizeMailboxSender = (
  senderAddress: string,
) => Promise<SenderAuthorization | null> | SenderAuthorization | null;

/** One durable inbound message, announced after its append settles. */
export type PersistedMailboxRow = {
  id: string;
  tenantId: string;
  principalId: string;
  recipientAddress: string;
  senderAddress: string;
};

export type CreateMailboxPersistOpts<R> = {
  /** The host's own persist path. Always called, for every frame. */
  upstream: (args: MailboxPersistArgs) => Promise<R>;
  authorizeSender: AuthorizeMailboxSender;
  /** Best-effort live signal per delivered message. */
  bus?: MailboxEventBus;
  /** Best-effort hook per delivered message; a throw is logged, never propagated. */
  onRow?: (row: PersistedMailboxRow) => void;
};

/**
 * Wrap a host's mail-persist function so every addressed principal also gets a
 * durable INBOX message.
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
    // Guardrails before authorize/resolve/append: a multi-megabyte frame or a
    // thousands-long recipient list would amplify memory and per-principal
    // copies. RangeError is caught by attemptMailboxWrite (dual-write
    // independence) but still prevents any partial delivery.
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
    // caller having typed one. A throw here is caught by
    // `attemptMailboxWrite` and logged loudly.
    for (const recipient of addressed) {
      assertMailboxScope({
        tenantId: auth.tenantId,
        principalId: recipient.principalId,
      });
    }

    // Recipient local parts are SENDER-controlled, and a principal the
    // control plane does not know cannot own a native mailbox. Filtering
    // here keeps one typo'd address from costing every real recipient on the
    // same frame their durable copy.
    // A local part names a principal by id (`usr_<id>` or bare) or, the way
    // Interchange stamps a person's From, by `refId`. Addresses arrive
    // lowercased, so the refId match is case-insensitive.
    const locals = addressed.map((recipient) => recipient.principalId);
    const rows = await db
      .select({ id: hostPrincipal.id, refId: hostPrincipal.refId })
      .from(hostPrincipal)
      .where(
        and(
          eq(hostPrincipal.tenantId, auth.tenantId),
          or(
            inArray(hostPrincipal.id, locals),
            inArray(sql`lower(${hostPrincipal.refId})`, locals),
          ),
        ),
      );
    const byId = new Map(rows.map((row) => [row.id, row.id]));
    const byRefId = new Map(rows.map((row) => [row.refId.toLowerCase(), row.id]));
    const resolved: ResolvedRecipient[] = [];
    const unknown: ResolvedRecipient[] = [];
    for (const recipient of addressed) {
      const principalId =
        byId.get(recipient.principalId) ?? byRefId.get(recipient.principalId);
      if (principalId === undefined) unknown.push(recipient);
      else resolved.push({ address: recipient.address, principalId });
    }
    if (unknown.length > 0) {
      logger.warn("skipping mailbox delivery to unknown principals", {
        tenantId: auth.tenantId,
        addresses: unknown.map((recipient) => recipient.address),
      });
    }
    if (resolved.length === 0) return;

    // A frame the MIME parser rejects still delivers — `raw` stays
    // authoritative — but its envelope degrades to what little this package
    // can infer, matching what `writeMailboxMessage` mints when a caller
    // supplies none of these fields.
    const decoded = decodeMailFrame(raw);
    const subject = decoded?.headers.get("subject") ?? "";
    const fromAddress = decoded?.headers.get("from") ?? senderAddress;
    const messageId = decoded?.messageId ?? null;
    const inReplyTo =
      parseMsgIdList(decoded?.headers.get("in-reply-to"))[0] ?? undefined;
    const references = decoded?.references ?? [];

    // One append per recipient, into their own INBOX — the native store has
    // no multi-recipient batch. Deduped on messageId within each recipient's
    // mailbox: a retried frame (same Message-ID) never delivers twice to the
    // same principal.
    for (const recipient of resolved) {
      const store = await openNativeMailboxStore(db, {
        tenantId: auth.tenantId,
        principalId: recipient.principalId,
        folder: "INBOX",
      });
      if (
        messageId !== null &&
        store.messages.some((m) => m.envelope.messageId === messageId)
      ) {
        continue;
      }
      const uid = store.append(
        raw,
        {
          messageId: messageId ?? "",
          from: fromAddress,
          to: [recipient.address],
          subject,
          date: new Date(),
          inReplyTo,
          references,
          interchangeType: undefined,
          interchangeCorrelationId: undefined,
        },
        [],
      );
      await store.settled;
      announce({
        id: `${auth.tenantId}:${recipient.principalId}:INBOX:${uid}`,
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
      const messageId = decodeMailFrame(args.raw)?.messageId ?? null;
      logger.error("mailbox write failed for mail from {senderAddress}", {
        senderAddress: args.senderAddress,
        messageId,
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
