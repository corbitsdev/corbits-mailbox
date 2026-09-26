import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { applyMailboxMigrations } from "../src/migrations.js";
import { seedScope, migrationSandbox } from "./helpers.js";

const { fromEmpty } = migrationSandbox();

test("0004 carries folder and \\Seen out of a pre-0.1.0 mailbox table", async () => {
  await fromEmpty(async ({ db }) => {
    // Rebuild the pre-0.1.0 shape: no IMAP columns, no counters, and the
    // management table that held read/archive/trash state.
    await applyMailboxMigrations(db, "public");
    await db.execute(sql`DROP TABLE "mailbox"."mailbox_state"`);
    await db.execute(
      sql`ALTER TABLE "mailbox"."principal_mail"
          DROP COLUMN "folder", DROP COLUMN "uid",
          DROP COLUMN "modseq", DROP COLUMN "flags"`,
    );
    await db.execute(sql`CREATE TABLE "mailbox"."mailbox" (
      "id" text PRIMARY KEY,
      "read_at" timestamp,
      "archived_at" timestamp,
      "trashed_at" timestamp
    )`);
    await seedScope(db, "acme", "user-1");
    const raw = Buffer.from(
      "From: bot@acme.example\r\nSubject: legacy\r\n\r\nBody\r\n",
    );
    for (const id of ["read", "archived", "trashed", "both", "untouched"]) {
      await db.execute(sql`
        INSERT INTO "mailbox"."principal_mail"
          ("id","tenant_id","principal_id","address","direction","raw")
        VALUES (${id},'acme','user-1','user-1@acme.example','inbound',${raw})
      `);
    }
    await db.execute(sql`
      INSERT INTO "mailbox"."mailbox" ("id","read_at","archived_at","trashed_at")
      VALUES ('read', now(), NULL, NULL),
             ('archived', NULL, now(), NULL),
             ('trashed', now(), NULL, now()),
             ('both', NULL, now(), now()),
             ('untouched', NULL, NULL, NULL)
    `);

    await applyMailboxMigrations(db, "public");

    const rows = await db.execute<{
      id: string;
      folder: string;
      flags: string[];
    }>(
      sql`SELECT "id", "folder", "flags" FROM "mailbox"."principal_mail" ORDER BY "id"`,
    );
    expect([...rows]).toEqual([
      { id: "archived", folder: "Archive", flags: [] },
      { id: "both", folder: "Trash", flags: [] },
      { id: "read", folder: "INBOX", flags: ["\\Seen"] },
      { id: "trashed", folder: "Trash", flags: ["\\Seen"] },
      { id: "untouched", folder: "INBOX", flags: [] },
    ]);
  });
});
