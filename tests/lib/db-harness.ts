import { drizzle } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import postgres from "postgres";
import type { TenantEnv } from "@intx/hub-api";
import {
  createInMemoryMailboxEventBus,
  createMailboxRoutes,
  runMailboxMigrations,
  type CreateMailboxRoutesDeps,
  type MailboxDb,
} from "../../src/index.js";
import {
  allowAllGrants,
  createHostControlPlane,
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

/** A fresh database with the host control plane and every mailbox migration applied. */
export async function createTestDb(): Promise<TestDb> {
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
    await runMailboxMigrations(db);
  } catch (err) {
    await close();
    throw err;
  }
  return { db, close };
}

export const TEST_TENANT = {
  id: "t1",
  name: "t1",
  slug: "t1",
  domain: "t1.example",
  parentId: null,
  config: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

/** Request header naming the principal the test host authenticates the request as. */
export const PRINCIPAL_HEADER = "x-test-principal";

/**
 * A host app that plays the tenant middleware: every request runs as
 * `TEST_TENANT` and the principal named by `PRINCIPAL_HEADER`, and the
 * mailbox routes are mounted under `/mailbox`.
 */
export function createTestApp(
  deps: Pick<CreateMailboxRoutesDeps, "db" | "senderAddressFor" | "deliver">,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  app.use(async (c, next) => {
    const principalId = c.req.header(PRINCIPAL_HEADER);
    if (principalId === undefined) return c.json({ error: "unauthenticated" }, 401);
    c.set("tenant", TEST_TENANT);
    c.set("principal", {
      id: principalId,
      tenantId: TEST_TENANT.id,
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
      bus: createInMemoryMailboxEventBus(),
      requireGrant: allowAllGrants,
      senderAddressFor: deps.senderAddressFor,
      deliver: deps.deliver,
    }),
  );
  return app;
}
