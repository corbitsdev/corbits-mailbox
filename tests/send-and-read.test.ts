import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import {
  createInMemoryMailboxEventBus,
  createMailboxPersist,
} from "../src/index.js";
import { seedScope } from "../src/test-helpers.js";
import {
  as,
  createTestApp,
  createTestDb,
  jsonAs,
  testTenant,
  type TestDb,
} from "./lib/db-harness.js";

const TENANT = testTenant("t1");

let testDb: TestDb | undefined;
let app: Hono<TenantEnv>;

beforeAll(async () => {
  const { db } = (testDb = await createTestDb());
  await seedScope(db, TENANT.id, "alice", "bob");
  // The host's transport files each sent message into its recipients' inboxes.
  const persist = createMailboxPersist(db, {
    upstream: async () => {},
    authorizeSender: () => ({ tenantId: TENANT.id, domain: TENANT.domain }),
  });
  app = createTestApp({
    db,
    bus: createInMemoryMailboxEventBus(),
    senderAddressFor: ({ principalId }) => `${principalId}@${TENANT.domain}`,
    deliver: ({ from, to, raw }) => persist({ senderAddress: from, recipients: to, raw }),
  });
});

afterAll(async () => {
  await testDb?.close();
});

type ListBody = {
  messages: {
    uid: number;
    envelope: { from: string; subject: string };
    raw: string;
  }[];
};

test("a message sent over HTTP is listed and readable in the recipient's inbox", async () => {
  const sent = await app.request("/mailbox/me/inbox/send", {
    method: "POST",
    headers: jsonAs(TENANT.id, "alice"),
    body: JSON.stringify({ to: ["bob@t1.example"], subject: "Lunch", body: "Noon?" }),
  });
  expect(sent.status).toBe(200);

  const inbox = await app.request("/mailbox/me/inbox", {
    headers: as(TENANT.id, "bob"),
  });
  expect(inbox.status).toBe(200);
  const { messages } = (await inbox.json()) as ListBody;
  expect(messages).toHaveLength(1);
  const [message] = messages;
  expect(message!.envelope.from).toBe("alice@t1.example");
  expect(message!.envelope.subject).toBe("Lunch");
  expect(Buffer.from(message!.raw, "base64").toString()).toContain("Noon?");

  const thread = await app.request(`/mailbox/me/inbox/threads/${message!.uid}`, {
    headers: as(TENANT.id, "bob"),
  });
  expect(thread.status).toBe(200);
  const { thread: root } = (await thread.json()) as {
    thread: { uid: number; envelope: { subject: string }; children: unknown[] };
  };
  expect(root.uid).toBe(message!.uid);
  expect(root.envelope.subject).toBe("Lunch");

  const aliceInbox = await app.request("/mailbox/me/inbox", {
    headers: as(TENANT.id, "alice"),
  });
  expect(((await aliceInbox.json()) as ListBody).messages).toHaveLength(0);
});
