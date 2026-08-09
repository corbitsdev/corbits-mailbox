import { createMailboxDb, type MailboxDb } from "./db.js";
import { runMailboxMigrations } from "./migrations.js";
import type { MailboxVocabulary } from "./vocabulary.js";
import { sql } from "drizzle-orm";

/**
 * A host vocabulary for the suite to mount with. The package ships none of its
 * own, so this list plays the host's role: it lives on THIS side of the mount
 * boundary.
 */
export const TEST_VOCABULARY: MailboxVocabulary = {
  priorities: ["urgent", "high", "normal", "low"],
  statuses: ["needs-action", "done"],
};

export const TEST_DATABASE_URL =
  process.env.MAILBOX_TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/mailbox_core";

/**
 * The minimum control plane the FKs require: the host's `tenant` and
 * `principal` tables, with only the columns the mailbox references. Real
 * Interchange tables carry more columns; the FKs don't care.
 */
export async function createHostControlPlane(
  db: Pick<MailboxDb, "execute">,
): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "tenant" ("id" text PRIMARY KEY)
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "principal" (
      "id" text PRIMARY KEY,
      "tenant_id" text NOT NULL REFERENCES "tenant" ("id") ON DELETE CASCADE
    )
  `);
}

/**
 * Register a (tenant, principal) scope with the control plane so the mailbox
 * FKs accept writes under it. Idempotent — tests seed the scopes they use and
 * never care whether another test already did.
 */
export async function seedScope(
  db: Pick<MailboxDb, "execute">,
  tenantId: string,
  ...principalIds: string[]
): Promise<void> {
  await db.execute(
    sql`INSERT INTO "tenant" ("id") VALUES (${tenantId}) ON CONFLICT DO NOTHING`,
  );
  for (const principalId of principalIds) {
    await db.execute(
      sql`INSERT INTO "principal" ("id", "tenant_id") VALUES (${principalId}, ${tenantId}) ON CONFLICT DO NOTHING`,
    );
  }
}

// One pool for the whole test process. `withTestDb` is called from a
// `beforeEach` in most suites, and a fresh pool per test leaks connections
// until Postgres refuses with "sorry, too many clients already". Migrating
// once and truncating per test gives every test the same empty-mailbox
// precondition without the leak. Suites that need their own schema
// (migrations.test.ts) open their own handles and close them.
let shared: Promise<MailboxDb> | undefined;

export async function withTestDb(): Promise<MailboxDb> {
  shared ??= (async () => {
    const { db } = createMailboxDb(TEST_DATABASE_URL);
    // The control plane must exist before the mailbox migrations can FK to it
    // — same order a real host boots in.
    await createHostControlPlane(db);
    await runMailboxMigrations(db);
    return db;
  })();
  const db = await shared;
  // `mailbox` references `principal_mail`, so both are truncated in one
  // statement rather than leaving the management layer behind. The control
  // plane is reset too, so no test inherits another's scopes.
  await db.execute(
    sql`TRUNCATE TABLE "mailbox"."principal_mail", "mailbox"."mailbox"`,
  );
  await db.execute(sql`TRUNCATE TABLE "tenant", "principal" CASCADE`);
  return db;
}
