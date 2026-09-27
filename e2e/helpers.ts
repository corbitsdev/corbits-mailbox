import { afterAll, beforeAll } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import postgres from "postgres";
import type { DBConfig } from "@intx/db";
import type { RequireGrant, TenantEnv, TenantRow } from "@intx/hub-api";
import {
  createMailboxRoutes,
  runMailboxMigrations,
  type CreateMailboxRoutesDeps,
  type MailboxDb,
} from "../src/index.js";
import { applyMailboxMigrations } from "../src/migrations.js";
import type { ResolvedPrincipal } from "../src/mount.js";

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
async function createHostControlPlane(
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

export type TestDb = {
  db: MailboxDb;
  close: () => Promise<void>;
};

// The mailbox pins its tables to the "mailbox" schema and its FKs to
// "public", so a suite is isolated by database rather than by schema.
async function admin<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    return await run(sql);
  } finally {
    await sql.end();
  }
}

export type EmptyTestDb = TestDb & { config: DBConfig };

/** A fresh database with only the host control plane, before any mailbox migration. */
export async function createEmptyTestDb(): Promise<EmptyTestDb> {
  const name = `mailbox_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  await admin((sql) => sql.unsafe(`CREATE DATABASE "${name}"`));
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const client = postgres(url.toString(), { onnotice: () => {} });
  const db = drizzle(client);
  const close = async () => {
    await client.end();
    await admin((sql) => sql.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`));
  };
  try {
    await createHostControlPlane(db);
  } catch (err) {
    await close();
    throw err;
  }
  return { db, close, config: dbConfigFromUrl(url.toString()) };
}

/** A fresh database with the host control plane and every mailbox migration applied. */
export async function createTestDb(): Promise<TestDb> {
  const { db, close, config } = await createEmptyTestDb();
  try {
    await runMailboxMigrations(config, { schema: "public" });
  } catch (err) {
    await close();
    throw err;
  }
  return { db, close };
}

/** Request headers naming the tenant and principal the test host authenticates the request as. */
const TENANT_HEADER = "x-test-tenant";
const PRINCIPAL_HEADER = "x-test-principal";

export function testTenant(id: string): TenantRow {
  return {
    id,
    name: id,
    slug: id,
    domain: `${id}.example`,
    parentId: null,
    config: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/** Headers for a request made as `principalId` in `tenantId`. */
export function as(tenantId: string, principalId: string): Headers {
  return new Headers({
    [TENANT_HEADER]: tenantId,
    [PRINCIPAL_HEADER]: principalId,
  });
}

/** `as`, for a JSON request body. */
export function jsonAs(tenantId: string, principalId: string): Headers {
  const headers = as(tenantId, principalId);
  headers.set("content-type", "application/json");
  return headers;
}

/**
 * A host app that plays the tenant middleware: every request runs as the
 * tenant and principal named by `TENANT_HEADER` and `PRINCIPAL_HEADER`, and
 * the mailbox routes are mounted under `/mailbox`.
 */
export function createTestApp(
  deps: Pick<
    CreateMailboxRoutesDeps,
    "db" | "bus" | "senderAddressFor" | "deliver"
  >,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  app.use(async (c, next) => {
    const tenantId = c.req.header(TENANT_HEADER);
    const principalId = c.req.header(PRINCIPAL_HEADER);
    if (tenantId === undefined || principalId === undefined) {
      return c.json({ error: "unauthenticated" }, 401);
    }
    c.set("tenant", testTenant(tenantId));
    c.set("principal", {
      id: principalId,
      tenantId,
      kind: "user",
      refId: principalId,
      status: "active",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    await next();
  });
  app.route(
    "/mailbox",
    createMailboxRoutes({
      db: deps.db,
      bus: deps.bus,
      requireGrant: allowAllGrants,
      senderAddressFor: deps.senderAddressFor,
      deliver: deps.deliver,
    }),
  );
  return app;
}

// Every case here builds the `mailbox` schema from empty. The tables are
// hard-qualified to that one schema, so the isolation is DROP SCHEMA "mailbox"
// CASCADE before each case rather than a private search_path — and because
// suites run sequentially in one process, dropping it out from under the other
// files only matters if it stays dropped. It does not: `afterAll` re-runs the
// (idempotent) migrations, and so does every case, so the suites are
// ordering-independent. The control-plane stub tables in `public` must exist
// before any migration run — the FKs land on them.
// Every case here builds the `mailbox` schema from empty. The tables are
// hard-qualified to that one schema, so the isolation is DROP SCHEMA "mailbox"
// CASCADE before each case rather than a private search_path — and because
// suites run sequentially in one process, dropping it out from under the other
// files only matters if it stays dropped. It does not: `afterAll` re-runs the
// (idempotent) migrations, and so does every case, so the suites are
// ordering-independent. The control-plane stub tables in `public` must exist
// before any migration run — the FKs land on them.

/**
 * Registers the suite's hooks and returns its admin client plus the helpers
 * that rebuild the schema from empty. Call once per test file: each file gets
 * its own client, closed by its own `afterAll`.
 */
export function migrationSandbox() {
  const admin = postgres(TEST_DATABASE_URL, { onnotice: () => {} });
  const adminDb = drizzle(admin);

  beforeAll(async () => {
    await createHostControlPlane(adminDb);
  });

  afterAll(async () => {
    // Leave the schema the way every other suite expects to find it, whatever
    // the last case did to it.
    await dropMailboxSchema();
    await applyMailboxMigrations(adminDb, "public");
    await admin.end();
  });

  /** Drop this package's schema so the next migration run builds from empty. */
  async function dropMailboxSchema(): Promise<void> {
    await admin.unsafe(`DROP SCHEMA IF EXISTS "mailbox" CASCADE`);
  }

  /** Runs `fn` against a freshly-dropped schema and always drains its pool. */
  async function fromEmpty(
    fn: (h: ReturnType<typeof handle>) => Promise<void>,
  ): Promise<void> {
    await dropMailboxSchema();
    const h = handle();
    try {
      await fn(h);
    } finally {
      await h.client.end();
    }
  }

  return { admin, dropMailboxSchema, fromEmpty };
}

export function handle() {
  const client = postgres(TEST_DATABASE_URL, { onnotice: () => {} });
  return { client, db: drizzle(client) };
}
