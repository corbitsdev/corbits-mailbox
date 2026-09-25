import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  buildMailFrame,
  createMailboxPersist,
  moveNativeMailboxMessage,
  runMailboxMigrations as runPublishedMigrations,
} from "@corbits/mailbox-0.1.0";
import { runMailboxMigrations, type MailboxDb } from "../src/index.js";
import { seedScope } from "../src/test-helpers.js";
import { createEmptyTestDb, type EmptyTestDb } from "./lib/db-harness.js";

let testDb: EmptyTestDb | undefined;

beforeAll(async () => {
  testDb = await createEmptyTestDb();
});

afterAll(async () => {
  await testDb?.close();
});

/** Every mailbox row, column and index outside the ledger, as one comparable value. */
type Snapshot = { mail: { folder: string; flags: string[] }[]; state: unknown[] };

async function snapshot(db: MailboxDb): Promise<Snapshot> {
  const [row] = await db.execute<{ snapshot: Snapshot }>(sql`
    SELECT jsonb_build_object(
      'mail', (SELECT jsonb_agg(to_jsonb(m) ORDER BY m."id") FROM "mailbox"."principal_mail" m),
      'state', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s."tenant_id", s."principal_id", s."folder")
                  FROM "mailbox"."mailbox_state" s),
      'columns', (SELECT jsonb_agg(jsonb_build_array(table_name, column_name, data_type, is_nullable, column_default)
                           ORDER BY table_name, column_name)
                    FROM information_schema.columns
                    WHERE table_schema = 'mailbox' AND table_name <> 'corbits_mailbox_migrations'),
      'indexes', (SELECT jsonb_agg(indexdef ORDER BY indexname)
                    FROM pg_indexes
                    WHERE schemaname = 'mailbox' AND tablename <> 'corbits_mailbox_migrations')
    ) AS snapshot`);
  return row!.snapshot;
}

async function ledgerExists(db: MailboxDb): Promise<boolean> {
  const [row] = await db.execute<{ exists: boolean }>(
    sql`SELECT to_regclass('"mailbox"."corbits_mailbox_migrations"') IS NOT NULL AS exists`,
  );
  return row?.exists ?? false;
}

test("a database migrated by the published 0.1.0 runner upgrades with every row intact, and a replay changes nothing", async () => {
  const { db, config } = testDb!;
  await runPublishedMigrations(db);
  expect(await ledgerExists(db)).toBe(true);

  await seedScope(db, "t1", "alice", "bob");
  const persist = createMailboxPersist(db, {
    upstream: async () => {},
    authorizeSender: () => ({ tenantId: "t1", domain: "t1.example" }),
  });
  await persist({
    senderAddress: "alice@t1.example",
    recipients: ["bob@t1.example"],
    raw: buildMailFrame({
      from: "alice@t1.example",
      to: "bob@t1.example",
      subject: "Kickoff",
      body: "Agenda attached.",
      messageId: "<root@t1.example>",
    }),
  });
  await persist({
    senderAddress: "bob@t1.example",
    recipients: ["alice@t1.example"],
    raw: buildMailFrame({
      from: "bob@t1.example",
      to: "alice@t1.example",
      subject: "Re: Kickoff",
      body: "Thanks.",
      messageId: "<reply@t1.example>",
      inReplyTo: "<root@t1.example>",
      references: ["<root@t1.example>"],
    }),
  });
  await moveNativeMailboxMessage(db, { tenantId: "t1", principalId: "bob" }, "INBOX", 1, "Archive");
  await db.execute(
    sql`UPDATE "mailbox"."principal_mail" SET "flags" = ARRAY['\\Seen'] WHERE "folder" = 'INBOX'`,
  );

  const before = await snapshot(db);
  expect(before.mail.map((m) => [m.folder, m.flags]).sort()).toEqual([
    ["Archive", []],
    ["INBOX", ["\\Seen"]],
  ]);

  await runMailboxMigrations(config, { schema: "public" });
  expect(await ledgerExists(db)).toBe(false);
  expect(await snapshot(db)).toEqual(before);

  await runMailboxMigrations(config, { schema: "public" });
  expect(await snapshot(db)).toEqual(before);
});
