import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import {
  createInMemoryMailboxEventBus,
  purgePrincipalMailbox,
  writeMailboxMessage,
} from "../src/index.js";
import {
  seedScope,
  as,
  createTestApp,
  createTestDb,
  type TestDb,
} from "./helpers.js";

let testDb: TestDb | undefined;
let app: Hono<TenantEnv>;
let uid: number;

beforeAll(async () => {
  testDb = await createTestDb();
  const { db } = testDb;
  await seedScope(db, "tA", "alice");
  await seedScope(db, "tB", "mallory");
  app = createTestApp({
    db,
    bus: createInMemoryMailboxEventBus(),
    senderAddressFor: ({ principalId }) => `${principalId}@example`,
    deliver: () => {},
  });
  const written = await writeMailboxMessage(db, {
    tenantId: "tA",
    principalId: "alice",
    address: "alice@tA.example",
    fromAddress: "bob@tA.example",
    subject: "Private",
    body: "tenant A only",
  });
  uid = written!.uid;
});

afterAll(async () => {
  await testDb?.close();
});

type ListBody = { messages: { uid: number }[] };

async function list(tenantId: string, principalId: string): Promise<ListBody> {
  const res = await app.request("/mailbox/me/inbox", {
    headers: as(tenantId, principalId),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ListBody;
}

test("a principal in another tenant cannot list or read tenant A's mail", async () => {
  expect((await list("tA", "alice")).messages).toHaveLength(1);

  expect((await list("tB", "mallory")).messages).toEqual([]);
  expect((await list("tB", "alice")).messages).toEqual([]);

  const thread = await app.request(`/mailbox/me/inbox/threads/${uid}`, {
    headers: as("tB", "mallory"),
  });
  expect(thread.status).toBe(404);
  const flag = await app.request(`/mailbox/me/inbox/${uid}/read`, {
    method: "POST",
    headers: as("tB", "mallory"),
  });
  expect(flag.status).toBe(404);

  const ownFlag = await app.request(`/mailbox/me/inbox/${uid}/read`, {
    method: "POST",
    headers: as("tA", "alice"),
  });
  expect(ownFlag.status).toBe(200);
});

test("purging a principal removes their mail from the routes", async () => {
  const purged = await purgePrincipalMailbox(testDb!.db, {
    tenantId: "tA",
    principalId: "alice",
  });
  expect(purged).toBe(1);
  expect((await list("tA", "alice")).messages).toEqual([]);
});
