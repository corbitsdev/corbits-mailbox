// THE GUARD THE REST OF THE SUITE COULD NOT BE.
//
// `created_at` is `timestamp without time zone` holding UTC. Every other test
// in this package runs against a Postgres session whose `TimeZone` is UTC, and
// under a UTC session a zoneless timestamp and a `timestamptz` render and
// compare identically — so the tie-group, page-boundary and microsecond-cursor
// suites all pass whether the read path casts correctly or not. They cannot
// fail on this, which means they are not guarding it.
//
// This file pins the session to a non-UTC zone and re-asks the same questions.
// It is the only place in the suite where `to_char(created_at AT TIME ZONE
// 'UTC', …)` and a `::timestamptz` cursor cast produce different answers from
// the correct forms, and both of those are what this package shipped before
// the move off `timestamptz` to zoneless `timestamp`.
//
// It runs against its OWN pool, because the session `TimeZone` is a
// connection setting and the shared suite pool must stay UTC. The tables are
// the shared `mailbox`-schema ones — suites run sequentially in one process,
// and the fixture rows are truncated in before the assertions run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { runMailboxMigrations } from "./migrations.js";
import { listUserMailbox } from "./read.js";
import { decodeMailboxListCursor } from "./read.js";
import {
  createHostControlPlane,
  seedScope,
  TEST_DATABASE_URL,
  TEST_VOCABULARY,
} from "./test-helpers.js";
import type { MailboxDb } from "./db.js";

// UTC-5 in July, and never UTC at any time of year, so the skew this catches is
// a full five hours rather than something a loose assertion could round away.
const SESSION_TZ = "America/New_York";

const client = postgres(TEST_DATABASE_URL, {
  onnotice: () => {},
  connection: { TimeZone: SESSION_TZ },
});
let db: MailboxDb;

// Four instants, one second apart, written as explicit UTC wall-clock values.
// They are inserted with an explicit `::timestamp` rather than through
// `writeMailboxMessage`'s `DEFAULT now()` so the FIXTURE cannot itself be
// skewed by the session zone — this file is testing the read path, and a
// fixture that moved with the session would make the assertions vacuous.
const INSTANTS = [
  "2026-07-25T12:00:00.000001",
  "2026-07-25T12:00:00.000002",
  "2026-07-25T12:00:00.000003",
  "2026-07-25T12:00:00.000004",
];

beforeAll(async () => {
  db = drizzle(client);
  await createHostControlPlane(db);
  await runMailboxMigrations(db);
  await db.execute(
    sql`TRUNCATE TABLE "mailbox"."principal_mail", "mailbox"."mailbox"`,
  );
  await seedScope(db, "t1", "p1");
  for (const [i, instant] of INSTANTS.entries()) {
    await db.execute(sql`
      INSERT INTO "mailbox"."principal_mail"
        ("tenant_id", "principal_id", "address", "direction", "raw",
         "subject", "from_address", "created_at")
      VALUES ('t1', 'p1', 'p1@t1.example', 'inbound',
              ${Buffer.from(`Subject: N${i}\r\n\r\nBody`)},
              ${`N${i}`}, 'a@t1.example', ${instant}::timestamp)
    `);
  }
});

afterAll(async () => {
  await client.end();
});

const scope = {
  priorities: TEST_VOCABULARY.priorities,
  tenantId: "t1",
  principalId: "p1",
  view: "all" as const,
};

describe("mailbox reads on a non-UTC Postgres session", () => {
  test("the session really is not UTC, or nothing below proves anything", async () => {
    const rows = await db.execute<{ tz: string }>(
      sql`SELECT current_setting('TimeZone') AS tz`,
    );
    expect(rows[0]!.tz).toBe(SESSION_TZ);
  });

  test("the cursor renders the stored UTC instant, not the session's local time", async () => {
    // Fails against the shipped `to_char(created_at AT TIME ZONE 'UTC', …)`:
    // with a zoneless column that expression REINTERPRETS the value as UTC and
    // renders it in the session zone, yielding `…T07:00:00.000004Z` — a local
    // time wearing a `Z`.
    const page = await listUserMailbox(db, { ...scope, limit: 1 });
    const cursor = decodeMailboxListCursor(page.nextCursor!);
    expect(cursor).not.toBeNull();
    expect(cursor!.createdAt).toBe("2026-07-25T12:00:00.000004Z");
  });

  test("paging one row at a time still sees every row exactly once", async () => {
    // Fails against a `::timestamptz` cursor cast: the cursor string is
    // resolved through the session zone before it is compared to the zoneless
    // column, so the seek lands five hours away from the row it was minted
    // from. Every remaining row is on the wrong side of it and the second page
    // comes back empty — silently, and still as an `Index Cond`, which is why
    // no plan inspection would have caught this either.
    const seen: string[] = [];
    let cursor = undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await listUserMailbox(db, {
        ...scope,
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      for (const item of page.items) seen.push(item.subject!);
      if (page.nextCursor === undefined) break;
      const decoded = decodeMailboxListCursor(page.nextCursor);
      expect(decoded).not.toBeNull();
      cursor = decoded!;
    }
    expect(seen).toEqual(["N3", "N2", "N1", "N0"]);
  });

  test("a page taken with a cursor matches the same slice taken without one", async () => {
    // The equivalence the UTC suite already asserts, re-asked where the two
    // implementations diverge.
    const full = await listUserMailbox(db, { ...scope, limit: 10 });
    const first = await listUserMailbox(db, { ...scope, limit: 2 });
    const rest = await listUserMailbox(db, {
      ...scope,
      limit: 10,
      cursor: decodeMailboxListCursor(first.nextCursor!)!,
    });
    expect([...first.items, ...rest.items].map((m) => m.subject)).toEqual(
      full.items.map((m) => m.subject),
    );
  });

  test("the stored instant survives the round trip as UTC", async () => {
    // `date` comes off the row's `created_at` as a JS Date. If the column had
    // been written or read through the session zone, this would be 17:00Z.
    const page = await listUserMailbox(db, { ...scope, limit: 4 });
    expect(page.items.map((m) => m.date)).toEqual([
      "2026-07-25T12:00:00.000Z",
      "2026-07-25T12:00:00.000Z",
      "2026-07-25T12:00:00.000Z",
      "2026-07-25T12:00:00.000Z",
    ]);
  });
});
