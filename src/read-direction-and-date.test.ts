// `direction = 'inbound'` appears in six predicates and had no test at all, and
// the `date` header -> `created_at` fallback was equally unasserted. Both are
// silent-wrong-answer failures: an outbound row leaking into an inbox, or a
// date that quietly becomes the row's insert time.
import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { listUserMailbox, getMailboxMessage } from "./read.js";
import {
  countUnreadActiveMailbox,
  markMailboxMessageRead,
  applyMailboxBulkAction,
} from "./mutations.js";
import { withTestDb, seedScope, TEST_VOCABULARY } from "./test-helpers.js";
import type { MailboxDb } from "./db.js";

let db: MailboxDb;
const SCOPE = { tenantId: "t1", principalId: "p1" };

beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, "t1", "p1");
});

function frame(headers: string): Buffer {
  return Buffer.from(`${headers}\r\n\r\nbody`, "utf8");
}

async function insert(args: {
  direction: string;
  headers: string;
  createdAt: string;
  subject: string;
}): Promise<string> {
  const [row] = await db.execute<{ id: string }>(sql`
    INSERT INTO "mailbox"."principal_mail"
      ("tenant_id","principal_id","address","direction","raw","subject","created_at")
    VALUES ('t1','p1','p1@t1.example', ${args.direction},
            ${frame(args.headers)}, ${args.subject}, ${args.createdAt}::timestamp)
    RETURNING "id"`);
  // Mirror delivery: an inbound message gets its management row eagerly.
  // Outbound rows are host-written and never get one — nothing in this
  // package writes outbound.
  if (args.direction === "inbound") {
    await db.execute(sql`
      INSERT INTO "mailbox"."mailbox" ("id","tenant_id","principal_id")
      VALUES (${row!.id}, 't1', 'p1')`);
  }
  return row!.id;
}

describe("direction filtering", () => {
  test("list returns inbound rows and never outbound ones", async () => {
    await insert({
      direction: "inbound",
      headers: "From: a@b.c\r\nSubject: In",
      createdAt: "2026-07-25T12:00:02Z",
      subject: "In",
    });
    await insert({
      direction: "outbound",
      headers: "From: a@b.c\r\nSubject: Out",
      createdAt: "2026-07-25T12:00:01Z",
      subject: "Out",
    });
    const page = await listUserMailbox(db, {
      ...SCOPE,
      limit: 50,
      view: "all",
      priorities: TEST_VOCABULARY.priorities,
    });
    expect(page.items.map((i) => i.subject)).toEqual(["In"]);
  });

  test("detail read refuses an outbound row for the same principalId", async () => {
    const outboundId = await insert({
      direction: "outbound",
      headers: "From: a@b.c\r\nSubject: Out",
      createdAt: "2026-07-25T12:00:01Z",
      subject: "Out",
    });
    expect(
      await getMailboxMessage(db, { ...SCOPE, id: outboundId }),
    ).toBeNull();
  });

  test("unread-count ignores outbound rows", async () => {
    await insert({
      direction: "outbound",
      headers: "From: a@b.c\r\nSubject: Out",
      createdAt: "2026-07-25T12:00:01Z",
      subject: "Out",
    });
    expect(await countUnreadActiveMailbox(db, SCOPE)).toBe(0);
    await insert({
      direction: "inbound",
      headers: "From: a@b.c\r\nSubject: In",
      createdAt: "2026-07-25T12:00:02Z",
      subject: "In",
    });
    expect(await countUnreadActiveMailbox(db, SCOPE)).toBe(1);
  });

  test("mutations refuse an outbound row, single and bulk", async () => {
    const outboundId = await insert({
      direction: "outbound",
      headers: "From: a@b.c\r\nSubject: Out",
      createdAt: "2026-07-25T12:00:01Z",
      subject: "Out",
    });
    expect(await markMailboxMessageRead(db, { ...SCOPE, id: outboundId })).toBe(
      false,
    );
    expect(
      await applyMailboxBulkAction(db, SCOPE, "trash", [outboundId]),
    ).toEqual([{ id: outboundId, ok: false }]);
    // And the message is genuinely untouched, not merely reported as such: an
    // outbound row has no management row for a mutation to update.
    const rows = await db.execute<{ id: string }>(
      sql`SELECT id FROM "mailbox"."mailbox" WHERE id = ${outboundId}`,
    );
    expect(rows.length).toBe(0);
  });
});

describe("date header -> createdAt fallback", () => {
  async function insertDated(
    headers: string,
    createdAt: string,
  ): Promise<string> {
    return insert({
      direction: "inbound",
      headers,
      createdAt,
      subject: "S",
    });
  }

  async function listDate(headers: string, createdAt: string): Promise<string> {
    await insertDated(headers, createdAt);
    const page = await listUserMailbox(db, {
      priorities: TEST_VOCABULARY.priorities,
      ...SCOPE,
      limit: 1,
      view: "all",
    });
    return page.items[0]!.date;
  }

  async function detailDate(
    headers: string,
    createdAt: string,
  ): Promise<string> {
    const id = await insertDated(headers, createdAt);
    const detail = await getMailboxMessage(db, { ...SCOPE, id });
    return detail!.date;
  }

  test("list uses created_at (never opens the frame for a Date header)", async () => {
    // List no longer selects/decodes raw, so the Date header cannot win here.
    const date = await listDate(
      "From: a@b.c\r\nDate: Tue, 21 Jul 2026 09:30:00 +0000",
      "2026-07-25T12:00:00Z",
    );
    expect(date).toBe("2026-07-25T12:00:00.000Z");
  });

  test("detail: a valid Date header wins over created_at", async () => {
    const date = await detailDate(
      "From: a@b.c\r\nDate: Tue, 21 Jul 2026 09:30:00 +0000",
      "2026-07-25T12:00:00Z",
    );
    expect(date).toBe("2026-07-21T09:30:00.000Z");
  });

  test("detail: no Date header at all falls back to created_at", async () => {
    const date = await detailDate("From: a@b.c", "2026-07-25T12:00:00Z");
    expect(date).toBe("2026-07-25T12:00:00.000Z");
  });

  test("detail: an UNPARSEABLE Date header falls back to created_at, not NaN", async () => {
    // The branch that had no coverage: `new Date(header)` yields Invalid Date,
    // whose toISOString() throws. Falling back is the only safe answer.
    const date = await detailDate(
      "From: a@b.c\r\nDate: not a date at all",
      "2026-07-25T12:00:00Z",
    );
    expect(date).toBe("2026-07-25T12:00:00.000Z");
  });
});
