import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { writeMailboxMessage } from "./write.js";
import { mailbox } from "./schema.js";
import {
  markMailboxMessageRead,
  markMailboxMessageUnread,
  trashMailboxMessage,
  archiveMailboxMessage,
  restoreMailboxMessage,
  countUnreadActiveMailbox,
  applyMailboxBulkAction,
  MAX_BULK_MAILBOX_IDS,
} from "./mutations.js";
import { withTestDb, seedScope } from "./test-helpers.js";
import type { MailboxDb } from "./db.js";

let db: MailboxDb;
const scope = { tenantId: "t1", principalId: "p1" };

async function writeOne(messageKey: string) {
  const result = await writeMailboxMessage(db, {
    tenantId: scope.tenantId,
    principalId: scope.principalId,
    address: "p1@t1.example",
    fromAddress: "a@t1.example",
    subject: "Subject",
    body: "Body",
    messageKey,
  });
  return result!.id;
}

beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, "t1", "p1");
});

describe("markMailboxMessageRead", () => {
  test("is idempotent: repeated calls do not clobber the original readAt", async () => {
    const id = await writeOne("read-1");
    await markMailboxMessageRead(db, { ...scope, id });
    const [row1] = await db
      .select({ readAt: mailbox.readAt })
      .from(mailbox)
      .where(sql`${mailbox.id} = ${id}`);
    await new Promise((r) => setTimeout(r, 20));
    await markMailboxMessageRead(db, { ...scope, id });
    const [row2] = await db
      .select({ readAt: mailbox.readAt })
      .from(mailbox)
      .where(sql`${mailbox.id} = ${id}`);
    expect(row1?.readAt?.getTime() ?? null).toBe(
      row2?.readAt?.getTime() ?? null,
    );
  });
});

describe("trash/archive precedence", () => {
  test("trashing clears archivedAt (trash wins)", async () => {
    const id = await writeOne("precedence-1");
    await archiveMailboxMessage(db, { ...scope, id });
    const ok = await trashMailboxMessage(db, { ...scope, id });
    expect(ok).toBe(true);
    const [row] = await db
      .select()
      .from(mailbox)
      .where(sql`${mailbox.id} = ${id}`);
    expect(row?.trashedAt).not.toBeNull();
    expect(row?.archivedAt).toBeNull();
  });

  test("archiving an already-trashed item is refused", async () => {
    const id = await writeOne("precedence-2");
    await trashMailboxMessage(db, { ...scope, id });
    const ok = await archiveMailboxMessage(db, { ...scope, id });
    expect(ok).toBe(false);
    const [row] = await db
      .select()
      .from(mailbox)
      .where(sql`${mailbox.id} = ${id}`);
    expect(row?.archivedAt).toBeNull();
    expect(row?.trashedAt).not.toBeNull();
  });

  test("restore clears both archivedAt and trashedAt", async () => {
    const id = await writeOne("precedence-3");
    await trashMailboxMessage(db, { ...scope, id });
    const ok = await restoreMailboxMessage(db, { ...scope, id });
    expect(ok).toBe(true);
    const [row] = await db
      .select()
      .from(mailbox)
      .where(sql`${mailbox.id} = ${id}`);
    expect(row?.archivedAt).toBeNull();
    expect(row?.trashedAt).toBeNull();
  });
});

describe("countUnreadActiveMailbox", () => {
  test("excludes archived and trashed rows", async () => {
    const unreadId = await writeOne("unread-count-1");
    const archivedId = await writeOne("unread-count-2");
    const trashedId = await writeOne("unread-count-3");
    await archiveMailboxMessage(db, { ...scope, id: archivedId });
    await trashMailboxMessage(db, { ...scope, id: trashedId });
    const count = await countUnreadActiveMailbox(db, scope);
    expect(count).toBe(1);
    expect(unreadId).toBeDefined();
  });
});

describe("applyMailboxBulkAction", () => {
  test("is capped at 50 ids", async () => {
    const ids = Array.from(
      { length: MAX_BULK_MAILBOX_IDS + 1 },
      () => "00000000-0000-0000-0000-000000000000",
    );
    await expect(
      applyMailboxBulkAction(db, scope, "mark_read", ids),
    ).rejects.toThrow();
  });

  test("partial success: per-id result, unknown ids reported not-ok", async () => {
    const id = await writeOne("bulk-1");
    const unknownId = "00000000-0000-0000-0000-000000000000";
    const results = await applyMailboxBulkAction(db, scope, "mark_read", [
      id,
      unknownId,
    ]);
    expect(results).toEqual([
      { id, ok: true },
      { id: unknownId, ok: false },
    ]);
  });

  test("active-only guard: mark_unread skips already-archived rows", async () => {
    const id = await writeOne("bulk-2");
    await archiveMailboxMessage(db, { ...scope, id });
    const results = await applyMailboxBulkAction(db, scope, "mark_unread", [
      id,
    ]);
    expect(results).toEqual([{ id, ok: false }]);
  });

  test("bulk trash", async () => {
    const id = await writeOne("bulk-trash");
    const results = await applyMailboxBulkAction(db, scope, "trash", [id]);
    expect(results).toEqual([{ id, ok: true }]);
  });

  test("bulk archive skips already-trashed rows", async () => {
    const id = await writeOne("bulk-archive");
    await trashMailboxMessage(db, { ...scope, id });
    const results = await applyMailboxBulkAction(db, scope, "archive", [id]);
    expect(results).toEqual([{ id, ok: false }]);
  });

  test("bulk restore", async () => {
    const id = await writeOne("bulk-restore");
    await trashMailboxMessage(db, { ...scope, id });
    const results = await applyMailboxBulkAction(db, scope, "restore", [id]);
    expect(results).toEqual([{ id, ok: true }]);
  });
});
