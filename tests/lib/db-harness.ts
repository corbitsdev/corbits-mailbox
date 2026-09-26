import { drizzle } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import postgres from "postgres";
import type { DBConfig } from "@intx/db";
import type { TenantEnv, TenantRow } from "@intx/hub-api";
import {
  createMailboxRoutes,
  runMailboxMigrations,
  type CreateMailboxRoutesDeps,
  type MailboxDb,
} from "../../src/index.js";
import {
  allowAllGrants,
  createHostControlPlane,
  dbConfigFromUrl,
  TEST_DATABASE_URL,
} from "../../src/test-helpers.js";

export type TestDb = {
  db: MailboxDb;
  close: () => Promise<void>;
};

// The mailbox pins its tables to the "mailbox" schema and its FKs to
// "public", so a suite is isolated by database rather than by schema.
async function admin<T>(
  run: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
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
export const TENANT_HEADER = "x-test-tenant";
export const PRINCIPAL_HEADER = "x-test-principal";

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
  return new Headers({ [TENANT_HEADER]: tenantId, [PRINCIPAL_HEADER]: principalId });
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
  deps: Pick<CreateMailboxRoutesDeps, "db" | "bus" | "senderAddressFor" | "deliver">,
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
