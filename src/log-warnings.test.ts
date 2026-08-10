// The diagnostics this package emits are part of its contract — the ref cap
// and the validate-on-read drop both silently discard caller data, so the warn
// that says so is the only trace. Nothing asserted them; this installs a memory
// sink and does.
//
// It also pins the aggregation fix: one bad backfill used to emit a warn line
// PER BAD ROW PER PAGE PER REQUEST.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { configureSync, getConfig, getLogger } from "@intx/log";
import { sql } from "drizzle-orm";
import { writeMailboxMessage, MAX_MAILBOX_REFS } from "./write.js";
import { createMailboxPersist } from "./persist.js";
import { listUserMailbox } from "./read.js";
import { withTestDb, seedScope, TEST_VOCABULARY } from "./test-helpers.js";
import type { MailboxDb } from "./db.js";

type Captured = { category: readonly string[]; level: string; props: unknown };

const captured: Captured[] = [];
let previous: ReturnType<typeof getConfig>;

beforeAll(() => {
  previous = getConfig();
  configureSync({
    reset: true,
    sinks: {
      memory: (record) => {
        captured.push({
          category: record.category,
          level: record.level,
          props: record.properties,
        });
      },
    },
    loggers: [{ category: [], lowestLevel: "debug", sinks: ["memory"] }],
  });
  // Touching a logger here proves the sink is wired before any assertion runs.
  getLogger(["corbits-mailbox"]).debug("memory sink installed");
});

afterAll(() => {
  if (previous !== null) {
    configureSync({
      reset: true,
      sinks: previous.sinks,
      loggers: previous.loggers,
    });
  }
});

let db: MailboxDb;
beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, "t1", "p1");
  captured.length = 0;
});

function warnings(module: string): Captured[] {
  return captured.filter(
    (r) => r.level === "warning" && r.category[1] === module,
  );
}

test("refs past the cap are truncated AND the truncation is warned", async () => {
  const refs = Array.from({ length: MAX_MAILBOX_REFS + 7 }, (_, i) => ({
    kind: "run",
    id: `r${i}`,
  }));
  await writeMailboxMessage(db, {
    tenantId: "t1",
    principalId: "p1",
    address: "p1@t1.example",
    fromAddress: "a@t1.example",
    subject: "capped",
    body: "body",
    messageKey: "cap-warn",
    refs,
  });

  const warns = warnings("write");
  expect(warns.length).toBe(1);
  expect(warns[0]!.props).toMatchObject({
    messageKey: "cap-warn",
    received: MAX_MAILBOX_REFS + 7,
    kept: MAX_MAILBOX_REFS,
  });

  // The warn is not cosmetic: only the cap was persisted.
  const page = await listUserMailbox(db, {
    priorities: TEST_VOCABULARY.priorities,
    tenantId: "t1",
    principalId: "p1",
    limit: 10,
    view: "all",
  });
  expect(page.items[0]!.refs!.length).toBe(MAX_MAILBOX_REFS);
});

test("delivery to an unknown principal is skipped AND the skip is warned", async () => {
  const persist = createMailboxPersist(db, {
    upstream: async () => undefined,
    authorizeSender: () => ({ tenantId: "t1", domain: "t1.example" }),
  });
  await persist({
    senderAddress: "ins_dep@t1.example",
    recipients: ["usr_p1@t1.example", "usr_ghost@t1.example"],
    raw: Buffer.from("From: a@b.c\r\n\r\nbody", "utf8"),
  });

  const warns = warnings("persist");
  expect(warns.length).toBe(1);
  expect(warns[0]!.props).toMatchObject({
    tenantId: "t1",
    addresses: ["usr_ghost@t1.example"],
  });

  // The warn is the only trace of the skip; the known recipient still got its
  // copy.
  const page = await listUserMailbox(db, {
    priorities: TEST_VOCABULARY.priorities,
    tenantId: "t1",
    principalId: "p1",
    limit: 10,
    view: "all",
  });
  expect(page.items.length).toBe(1);
});

test("many bad refs rows in one page produce ONE aggregated warn", async () => {
  const BAD_ROWS = 12;
  for (let i = 0; i < BAD_ROWS; i++) {
    await db.execute(sql`
      INSERT INTO "mailbox"."principal_mail"
        ("tenant_id","principal_id","address","direction","raw","subject","refs")
      VALUES ('t1','p1','p1@t1.example','inbound',
              ${Buffer.from("From: a@b.c\r\n\r\nbody", "utf8")},
              ${`bad-${i}`}, '[{"nope":true}]'::jsonb)`);
  }
  captured.length = 0;

  const page = await listUserMailbox(db, {
    priorities: TEST_VOCABULARY.priorities,
    tenantId: "t1",
    principalId: "p1",
    limit: 100,
    view: "all",
  });
  expect(page.items.length).toBe(BAD_ROWS);
  for (const item of page.items) expect(item.refs).toBeUndefined();

  const warns = warnings("read");
  expect(warns.length).toBe(1);
  expect(warns[0]!.props).toMatchObject({ rows: BAD_ROWS });
  // Bounded sample, so the log line cannot grow with the size of the backfill.
  expect(
    (warns[0]!.props as { sampleRowIds: string[] }).sampleRowIds.length,
  ).toBe(5);
});
