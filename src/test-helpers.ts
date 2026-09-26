import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { MailboxDb } from "./db.js";
import { applyMailboxMigrations } from "./migrations.js";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import type { DBConfig } from "@intx/db";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import type { ResolvedPrincipal } from "./mount.js";

export const TEST_DATABASE_URL =
  process.env.MAILBOX_TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/mailbox_core";

/**
 * Opens a standalone handle. `close` drains the pool — without it a suite
 * keeps an open socket and never exits.
 */
export function createMailboxDb(connectionString: string): {
  db: MailboxDb;
  close: () => Promise<void>;
} {
  const client = postgres(connectionString);
  return { db: drizzle(client), close: () => client.end() };
}

/** `url` as the `DBConfig` Interchange's migration runners take. */
export function dbConfigFromUrl(url: string): DBConfig {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.slice(1),
  };
}

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
      "tenant_id" text NOT NULL REFERENCES "tenant" ("id") ON DELETE CASCADE,
      "ref_id" text NOT NULL
    )
  `);
  // A test database created before ref_id existed keeps its table.
  await db.execute(sql`
    ALTER TABLE "principal" ADD COLUMN IF NOT EXISTS "ref_id" text NOT NULL DEFAULT ''
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
      sql`INSERT INTO "principal" ("id", "tenant_id", "ref_id") VALUES (${principalId}, ${tenantId}, ${principalId}) ON CONFLICT DO NOTHING`,
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
    await applyMailboxMigrations(db, "public");
    return db;
  })();
  const db = await shared;
  // The control plane is reset too, so no test inherits another's scopes.
  await db.execute(
    sql`TRUNCATE TABLE "mailbox"."principal_mail", "mailbox"."mailbox_state"`,
  );
  await db.execute(sql`TRUNCATE TABLE "tenant", "principal" CASCADE`);
  return db;
}

/** A `requireGrant` that lets every request through, for route tests. */
export const allowAllGrants: RequireGrant = () => async (_c, next) => {
  await next();
};

/**
 * `routes` behind a stand-in for the host's tenant middleware that puts
 * `scope` on the context, or nothing when `scope` is null.
 */
export function mountAs(
  scope: ResolvedPrincipal | null,
  routes: Hono<TenantEnv>,
): Hono<TenantEnv> {
  const host = new Hono<TenantEnv>();
  if (scope) {
    const now = new Date();
    host.use(async (c, next) => {
      c.set("tenant", {
        id: scope.tenantId,
        name: scope.tenantId,
        slug: scope.tenantId,
        domain: `${scope.tenantId}.example`,
        parentId: null,
        config: null,
        createdAt: now,
        updatedAt: now,
      });
      c.set("principal", {
        id: scope.principalId,
        tenantId: scope.tenantId,
        kind: "user",
        refId: scope.principalId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await next();
    });
  }
  return host.route("/", routes);
}
