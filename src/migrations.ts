import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { DBConfig } from "@intx/db";
import type { MailboxDb } from "./db.js";
import { assertExpectedColumnTypes } from "./schema-check.js";

// <pkg>/migrations sits next to both <pkg>/src and <pkg>/dist.
const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");

// A fixed advisory-lock key for this package, so several app instances booting
// at once serialize here instead of racing the same CREATE TABLE. Advisory
// locks are namespaced by this integer alone, so it is deliberately arbitrary
// and specific to @corbits/mailbox.
const LOCK_KEY = 0x0a27_2c01;

/**
 * Applies every `migrations/*.sql` in filename order on each run, the same
 * way Interchange `runMigrations` does: every file is idempotent, so there is
 * no ledger. The `"public".` FK references are rewritten to `hostSchema`.
 * `@intx/db` only applies its own migrations folder, so this cannot wrap it.
 *
 * One transaction holds a transaction-scoped advisory lock, so concurrent cold
 * starts serialize instead of racing the same `CREATE TABLE IF NOT EXISTS`,
 * which is not itself race-safe. `client_min_messages` is lowered for that
 * transaction so each replayed `IF NOT EXISTS` does not print a NOTICE.
 */
export async function applyMailboxMigrations(
  db: MailboxDb,
  hostSchema: string,
): Promise<void> {
  const hostIdent = `"${hostSchema.replace(/"/g, '""')}".`;
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL client_min_messages = warning`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
    for (const file of files) {
      const ddl = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      await tx.execute(sql.raw(ddl.replace(/"public"\.(?=")/g, hostIdent)));
    }

    // Last, on the same transaction, so it sees exactly the schema the DDL
    // above just produced — and so a host whose pre-existing tables shadow ours
    // fails the boot instead of silently reading its columns through our codec,
    // with nothing left applied. See schema-check.ts.
    await assertExpectedColumnTypes(tx);
  });
}

/**
 * Takes the same `config` and `schema` the host passes Interchange's
 * `runMigrations`: `schema` is where the host's `tenant` and `principal`
 * tables live, and the mailbox FKs point there. The mailbox's own tables
 * always live in the `mailbox` schema.
 */
export async function runMailboxMigrations(
  config: DBConfig,
  options: { schema: string },
): Promise<void> {
  if (options.schema.length === 0) {
    throw new Error("runMailboxMigrations: schema name must not be empty");
  }
  const client = postgres({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl ?? false,
    max: 1,
    onnotice: () => undefined,
  });
  try {
    await applyMailboxMigrations(drizzle(client), options.schema);
  } finally {
    await client.end({ timeout: 5 });
  }
}
