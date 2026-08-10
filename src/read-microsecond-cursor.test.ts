import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { writeMailboxMessage } from "./write.js";
import { listUserMailbox } from "./read.js";
import { decodeMailboxListCursor } from "./read.js";
import { withTestDb, seedScope, TEST_VOCABULARY } from "./test-helpers.js";
import type { MailboxDb } from "./db.js";

let db: MailboxDb;

beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, "t1", "p1");
});

// `created_at` is `timestamp DEFAULT now()` — MICROsecond precision. A cursor
// that only carries millisecond precision rounds down, so every row inside the
// [.123000, .123456) window becomes permanently unreachable. These rows sit in
// the same millisecond and differ only in microseconds, which is exactly what
// `now()` produces under a burst of writes.
describe("keyset pagination at microsecond precision", () => {
  beforeEach(async () => {
    for (let i = 1; i <= 4; i++) {
      const written = await writeMailboxMessage(db, {
        tenantId: "t1",
        principalId: "p1",
        address: "p1@t1.example",
        fromAddress: "a@t1.example",
        subject: `Micro ${i}`,
        body: "Body",
        messageKey: `micro-${i}`,
      });
      await db.execute(
        sql`UPDATE "mailbox"."principal_mail"
            SET "created_at" = ${`2026-07-25T12:00:00.00000${i}Z`}::timestamp
            WHERE "id" = ${written!.id}`,
      );
    }
  });

  test("paginating one row at a time sees every microsecond-separated row exactly once", async () => {
    const seen: string[] = [];
    let cursor = undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await listUserMailbox(db, {
        priorities: TEST_VOCABULARY.priorities,
        tenantId: "t1",
        principalId: "p1",
        limit: 1,
        view: "all",
        ...(cursor ? { cursor } : {}),
      });
      for (const item of page.items) seen.push(item.subject!);
      if (page.nextCursor === undefined) break;
      const decoded = decodeMailboxListCursor(page.nextCursor);
      expect(decoded).not.toBeNull();
      cursor = decoded!;
    }
    expect(seen).toEqual(["Micro 4", "Micro 3", "Micro 2", "Micro 1"]);
    expect(new Set(seen).size).toBe(4);
  });

  test("a cursor round-trips full microsecond precision, not a truncated millisecond", async () => {
    const page = await listUserMailbox(db, {
      priorities: TEST_VOCABULARY.priorities,
      tenantId: "t1",
      principalId: "p1",
      limit: 1,
      view: "all",
    });
    const decoded = decodeMailboxListCursor(page.nextCursor!);
    // .000004 must survive: a millisecond-precision cursor would read .000Z.
    expect(decoded!.createdAt).toBe("2026-07-25T12:00:00.000004Z");
  });

  test("the id DESC tie-break is reachable for rows sharing an exact timestamp", async () => {
    await db.execute(sql`TRUNCATE TABLE "mailbox"."principal_mail", "mailbox"."mailbox"`);
    for (let i = 1; i <= 3; i++) {
      const written = await writeMailboxMessage(db, {
        tenantId: "t1",
        principalId: "p1",
        address: "p1@t1.example",
        fromAddress: "a@t1.example",
        subject: `Tie ${i}`,
        body: "Body",
        messageKey: `tie-${i}`,
      });
      await db.execute(
        sql`UPDATE "mailbox"."principal_mail"
            SET "created_at" = '2026-07-25T12:00:00.123456Z'::timestamp
            WHERE "id" = ${written!.id}`,
      );
    }
    const seen: string[] = [];
    let cursor = undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await listUserMailbox(db, {
        priorities: TEST_VOCABULARY.priorities,
        tenantId: "t1",
        principalId: "p1",
        limit: 1,
        view: "all",
        ...(cursor ? { cursor } : {}),
      });
      for (const item of page.items) seen.push(item.subject!);
      if (page.nextCursor === undefined) break;
      cursor = decodeMailboxListCursor(page.nextCursor)!;
    }
    expect(seen.length).toBe(3);
    expect(new Set(seen).size).toBe(3);
  });
});
