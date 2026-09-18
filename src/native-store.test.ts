import { beforeEach, describe, expect, it } from "bun:test";
import { executeSearch, executeThread } from "@intx/mailbox";
import type { StoredEnvelope } from "@intx/mailbox";
import {
  createPrincipalMailboxStore,
  moveNativeMailboxMessage,
  openNativeMailboxStore,
} from "./native-store.js";
import { seedScope, withTestDb } from "./test-helpers.js";
import type { MailboxDb } from "./db.js";
import { sql } from "drizzle-orm";

const TENANT_ID = "tenant-native";
const PRINCIPAL_ID = "principal-native";

let db: MailboxDb;

beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, TENANT_ID, PRINCIPAL_ID);
});

function envelope(overrides: Partial<StoredEnvelope> = {}): StoredEnvelope {
  return {
    messageId: "<m1@example.com>",
    from: "sender@example.com",
    to: ["recipient@example.com"],
    subject: "Hello",
    date: new Date("2026-01-01T00:00:00.000Z"),
    inReplyTo: undefined,
    references: [],
    interchangeType: undefined,
    interchangeCorrelationId: undefined,
    ...overrides,
  };
}

describe("native MailboxStore over the principal mailbox tables", () => {
  it("append -> find -> flags -> modseq", async () => {
    const inbox = await openNativeMailboxStore(db, {
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      folder: "INBOX",
    });

    expect(inbox.uidNext).toBe(1);
    expect(inbox.highestModSeq).toBe(0);

    const raw = new TextEncoder().encode("From: sender@example.com\r\n\r\nBody");
    const uid = inbox.append(raw, envelope(), []);
    expect(uid).toBe(1);
    expect(inbox.uidNext).toBe(2);
    expect(inbox.highestModSeq).toBe(1);

    const found = inbox.find(uid);
    expect(found?.envelope.subject).toBe("Hello");
    expect(found?.modseq).toBe(1);

    const flagged = inbox.addFlags(uid, ["\\Seen"]);
    expect(flagged.flags.has("\\Seen")).toBe(true);
    expect(flagged.modseq).toBe(2);
    expect(inbox.highestModSeq).toBe(2);

    const unflagged = inbox.removeFlags(uid, ["\\Seen"]);
    expect(unflagged.flags.has("\\Seen")).toBe(false);
    expect(unflagged.modseq).toBe(3);

    await inbox.settled;

    // A fresh instance sees exactly what was persisted, not just the
    // in-memory mirror.
    const reopened = await openNativeMailboxStore(db, {
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      folder: "INBOX",
    });
    expect(reopened.uidNext).toBe(2);
    expect(reopened.highestModSeq).toBe(3);
    const reopenedMsg = reopened.find(uid);
    expect(reopenedMsg?.flags.has("\\Seen")).toBe(false);
    expect(reopenedMsg?.modseq).toBe(3);
    const rawBack = await reopened.readRaw(uid);
    expect(new TextDecoder().decode(rawBack)).toBe("From: sender@example.com\r\n\r\nBody");
  });

  it("remove drops a message", async () => {
    const inbox = await openNativeMailboxStore(db, {
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      folder: "INBOX",
    });
    const uid = inbox.append(new Uint8Array([1, 2, 3]), envelope(), []);
    inbox.remove(uid);
    expect(inbox.find(uid)).toBeUndefined();
    await inbox.settled;

    const reopened = await openNativeMailboxStore(db, {
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      folder: "INBOX",
    });
    expect(reopened.find(uid)).toBeUndefined();
    expect(reopened.messages.length).toBe(0);
  });

  it("moves a message between folders, assigning a fresh uid", async () => {
    const store = createPrincipalMailboxStore(db, {
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
    });
    const inbox = await store.open("INBOX");
    const uid = inbox.append(new Uint8Array([9]), envelope(), []);
    await inbox.settled;

    const newUid = await store.move("INBOX", uid, "Archive");
    expect(newUid).toBe(1);

    const inboxAfter = await store.open("INBOX");
    expect(inboxAfter.find(uid)).toBeUndefined();

    const archive = await store.open("Archive");
    expect(archive.find(newUid)?.envelope.messageId).toBe("<m1@example.com>");

    // The moved message got its own move alone in the target mailbox.
    expect(archive.messages.length).toBe(1);

    // Moving again gets the next uid in Archive, not a collision.
    const inbox2 = await store.open("INBOX");
    const uid2 = inbox2.append(new Uint8Array([10]), envelope(), []);
    await inbox2.settled;
    const secondMove = await store.move("INBOX", uid2, "Archive");
    expect(secondMove).toBe(2);
  });

  it("runs the vendored executeSearch and executeThread over the native store", async () => {
    const inbox = await openNativeMailboxStore(db, {
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      folder: "INBOX",
    });

    const rootUid = inbox.append(
      new Uint8Array([1]),
      envelope({ messageId: "<root@example.com>", subject: "Thread root" }),
      [],
    );
    inbox.append(
      new Uint8Array([2]),
      envelope({
        messageId: "<reply@example.com>",
        subject: "Re: Thread root",
        inReplyTo: "<root@example.com>",
        references: ["<root@example.com>"],
      }),
      [],
    );
    await inbox.settled;

    const refs = await executeSearch("INBOX", inbox, { from: "sender@example.com" });
    expect(refs).toEqual([
      { uid: 1, mailbox: "INBOX" },
      { uid: 2, mailbox: "INBOX" },
    ]);
    expect(refs[0]).toHaveProperty("uid");
    expect(refs[0]).toHaveProperty("mailbox");

    const threads = await executeThread("INBOX", inbox, "references");
    expect(threads.length).toBe(1);
    const [thread] = threads;
    expect(thread!.ref).toEqual({ uid: rootUid, mailbox: "INBOX" });
    expect(thread!.children.length).toBe(1);
    expect(thread!.children[0]!.ref.uid).toBe(2);
  });

  // Regression for CL-8448: the raw SELECT must return the true instant, not
  // the bare timestamp reinterpreted in the host's local TZ.
  it("envelope.date survives a round trip as the true write instant", async () => {
    const inbox = await openNativeMailboxStore(db, {
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      folder: "INBOX",
    });
    const writeInstant = new Date();
    const uid = inbox.append(new Uint8Array([1]), envelope({ date: writeInstant }), []);
    await inbox.settled;
    // A host's session zone is rarely UTC; the read must not depend on it.
    await db.execute(sql`SET TIME ZONE 'America/Los_Angeles'`);

    const reopened = await openNativeMailboxStore(db, {
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      folder: "INBOX",
    });
    const msg = reopened.find(uid);
    expect(
      Math.abs(msg!.envelope.date.getTime() - writeInstant.getTime()),
    ).toBeLessThan(1000);
  });
});
