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

import { and, eq, inArray } from "drizzle-orm";
import { getLogger } from "@intx/log";
import { hostPrincipal, mailbox, principalMail } from "./schema.js";
import type { MailboxDb } from "./db.js";
import { publishMailboxEvent, type MailboxEventBus } from "./bus.js";
import { decodeMailFrame } from "./frame.js";
import { resolveMailboxRecipients } from "./recipients.js";
import { assertMailboxScope } from "./write.js";

const logger = getLogger(["corbits-mailbox", "persist"]);

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

export type CreateMailboxPersistOpts<R> = {
  /** The host's own persist path. Always called, for every frame. */
  upstream: (args: MailboxPersistArgs) => Promise<R>;
  authorizeSender: AuthorizeMailboxSender;
  /** Best-effort live signal per inserted row. */
  bus?: MailboxEventBus;
  /** Best-effort hook per inserted row; a throw is logged, never propagated. */
  onRow?: (row: PersistedMailboxRow) => void;
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
    // still persists — `raw` stays authoritative and the read path re-derives
    // what it can — so a failed parse is the expected case here, not a fault.
    const decoded = decodeMailFrame(raw);
    const subject = decoded?.headers.get("subject") ?? null;
    const fromAddress = decoded?.headers.get("from") ?? null;

    // Mail rows and their management rows commit together: the management row
    // is created eagerly with the message (see `writeMailboxMessage`), and a
    // message without one is unreachable by every mutation.
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
          })),
        )
        .returning({ id: principalMail.id });
      await tx.insert(mailbox).values(
        mailRows.map((row, index) => ({
          id: row.id,
          tenantId: auth.tenantId,
          principalId: resolved[index]!.principalId,
        })),
      );
      return mailRows;
    });

    // `returning` preserves VALUES order, so ids line up with recipients.
    for (const [index, recipient] of resolved.entries()) {
      const row = inserted[index];
      if (!row) continue;
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
      logger.error("mailbox write failed for mail from {senderAddress}", {
        senderAddress: args.senderAddress,
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
