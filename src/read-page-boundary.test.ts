import { beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { listUserMailbox } from "./read.js";
import { decodeMailboxListCursor } from "./read.js";
import { withTestDb, seedScope, TEST_VOCABULARY } from "./test-helpers.js";
import type { MailboxDb } from "./db.js";

let db: MailboxDb;

beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, "t1", "p1");
});

async function seed(timestamps: string[]) {
  for (let i = 0; i < timestamps.length; i++) {
    await db.execute(sql`
      INSERT INTO "mailbox"."principal_mail"
        ("tenant_id","principal_id","address","direction","raw","subject","created_at")
      VALUES ('t1','p1','p1@t1.example','inbound',
              ${Buffer.from(`From: a@b.com\r\nSubject: S${i}\r\n\r\nbody`, "utf8")},
              ${`S${i}`}, ${timestamps[i]}::timestamp)`);
  }
}

async function walkEveryPage(limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: ReturnType<typeof decodeMailboxListCursor> | undefined;
  for (let guard = 0; guard < 20000; guard++) {
    const page = await listUserMailbox(db, {
      priorities: TEST_VOCABULARY.priorities,
      tenantId: "t1",
      principalId: "p1",
      limit,
      view: "all",
      ...(cursor ? { cursor } : {}),
    });
    for (const item of page.items) seen.push(item.id);
    if (page.nextCursor === undefined) return seen;
    const decoded = decodeMailboxListCursor(page.nextCursor);
    expect(decoded).not.toBeNull();
    cursor = decoded!;
  }
  throw new Error("pagination did not terminate");
}

// The keyset predicate is ROW(created_at, id) < ROW(cursor...). `id` is a
// random uuid, so a tie group's internal order is not the insertion order and
// not the index order; a page boundary that lands inside a tie group is the
// only place the predicate can skip or repeat a row.
test("a tie group larger than the page never skips or repeats a row", async () => {
  await seed(Array.from({ length: 120 }, () => "2026-07-25T12:00:00.123456Z"));
  const baseline = await walkEveryPage(120);
  expect(baseline.length).toBe(120);
  for (const limit of [1, 7, 13, 119]) {
    const seen = await walkEveryPage(limit);
    expect(seen.length).toBe(120);
    expect(new Set(seen).size).toBe(120);
    expect(seen).toEqual(baseline);
  }
});

// A page boundary that lands exactly on a tie-group boundary is the adjacent
// off-by-one: limit == group size, limit == group size +/- 1.
test("page boundaries aligned to tie-group boundaries stay stable", async () => {
  await seed([
    ...Array.from({ length: 10 }, () => "2026-07-25T12:00:03.000000Z"),
    ...Array.from({ length: 10 }, () => "2026-07-25T12:00:02.000000Z"),
    ...Array.from({ length: 10 }, () => "2026-07-25T12:00:01.000000Z"),
  ]);
  const baseline = await walkEveryPage(30);
  for (const limit of [9, 10, 11, 20]) {
    expect(await walkEveryPage(limit)).toEqual(baseline);
  }
});

// Rows separated only by microseconds inside one millisecond: a cursor that
// ever round-trips through a JS Date truncates to the millisecond and strands
// every row in the rounded-off window.
test("a microsecond ladder inside one millisecond survives pagination", async () => {
  await seed(
    Array.from(
      { length: 200 },
      (_, i) => `2026-07-25T12:00:00.000${String(i).padStart(3, "0")}Z`,
    ),
  );
  const seen = await walkEveryPage(11);
  expect(seen.length).toBe(200);
  expect(new Set(seen).size).toBe(200);
});

// Stored `refs` is host-controlled jsonb. Every shape a bad backfill can leave
// behind must degrade to "no refs", never throw out of the read path.
test("every malformed refs shape degrades instead of throwing", async () => {
  const malformed = [
    "null",
    "{}",
    '"a string"',
    "42",
    "true",
    "[null]",
    "[1,2,3]",
    '["a"]',
    "[{}]",
    '[{"kind":"x"}]',
    '[{"id":"x"}]',
    '[{"kind":1,"id":"x"}]',
    '[{"kind":"x","id":"y","label":5}]',
    '[{"kind":"x","id":"y"},{"bad":true}]',
    '[[{"kind":"x","id":"y"}]]',
    '{"0":{"kind":"x","id":"y"}}',
  ];
  for (let i = 0; i < malformed.length; i++) {
    await db.execute(sql`
      INSERT INTO "mailbox"."principal_mail"
        ("tenant_id","principal_id","address","direction","raw","subject","refs","created_at")
      VALUES ('t1','p1','p1@t1.example','inbound',
              ${Buffer.from(`From: a@b.com\r\nSubject: B${i}\r\n\r\nbody`, "utf8")},
              ${`B${i}`}, ${malformed[i]}::jsonb,
              ${`2026-07-25T12:00:00.0000${String(i).padStart(2, "0")}Z`}::timestamp)`);
  }
  const page = await listUserMailbox(db, {
    priorities: TEST_VOCABULARY.priorities,
    tenantId: "t1",
    principalId: "p1",
    limit: 100,
    view: "all",
  });
  expect(page.items.length).toBe(malformed.length);
  for (const item of page.items) expect(item.refs).toBeUndefined();
});
