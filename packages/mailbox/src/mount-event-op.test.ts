// CL-5018: the live event must name the operation that fired so a listener
// can react without re-fetching and diffing against remembered state.
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mountMailbox } from "./mount.js";
import {
  createInMemoryMailboxEventBus,
  type MailboxEvent,
  type MailboxEventOp,
} from "./bus.js";
import { writeMailboxMessage } from "./write.js";
import { withTestDb, seedScope, TEST_VOCABULARY } from "./test-helpers.js";
import type { MailboxDb } from "./db.js";

let db: MailboxDb;
const P = { tenantId: "t1", principalId: "p1" };

beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, P.tenantId, P.principalId);
});

function buildApp(bus: ReturnType<typeof createInMemoryMailboxEventBus>) {
  const app = new Hono();
  mountMailbox(app, {
    db,
    bus,
    resolvePrincipal: () => P,
    vocabulary: TEST_VOCABULARY,
  });
  return app;
}

async function seedMessage(messageKey: string): Promise<string> {
  const written = await writeMailboxMessage(db, {
    ...P,
    address: "p1@t1.example",
    fromAddress: "a@t1.example",
    subject: "Hi",
    body: "Body",
    messageKey,
  });
  return written!.id;
}

describe("single-message mutations publish their op", () => {
  const cases: Array<{ verb: string; op: MailboxEventOp; seedKey: string }> = [
    { verb: "read", op: "mark_read", seedKey: "op-read" },
    { verb: "unread", op: "mark_unread", seedKey: "op-unread" },
    { verb: "trash", op: "trash", seedKey: "op-trash" },
    { verb: "archive", op: "archive", seedKey: "op-archive" },
    { verb: "restore", op: "restore", seedKey: "op-restore" },
  ];

  for (const { verb, op, seedKey } of cases) {
    test(`POST .../${verb} publishes op "${op}"`, async () => {
      const id = await seedMessage(seedKey);
      const bus = createInMemoryMailboxEventBus();
      const received: MailboxEvent[] = [];
      bus.subscribe(P, (e) => received.push(e));
      const app = buildApp(bus);

      const res = await app.request(`/me/inbox/${id}/${verb}`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      expect(received).toEqual([{ type: "mailbox", id, op }]);
    });
  }
});

describe("enrich and assign publish their own op", () => {
  test("enrich publishes op 'enrich'", async () => {
    const id = await seedMessage("op-enrich");
    const bus = createInMemoryMailboxEventBus();
    const received: MailboxEvent[] = [];
    bus.subscribe(P, (e) => received.push(e));
    const app = buildApp(bus);

    const res = await app.request(`/me/inbox/${id}/enrich`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priority: "urgent" }),
    });

    expect(res.status).toBe(200);
    expect(received).toEqual([{ type: "mailbox", id, op: "enrich" }]);
  });

  test("assign publishes op 'assign'", async () => {
    const id = await seedMessage("op-assign");
    const bus = createInMemoryMailboxEventBus();
    const received: MailboxEvent[] = [];
    bus.subscribe(P, (e) => received.push(e));
    const app = buildApp(bus);

    const res = await app.request(`/me/inbox/${id}/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignee: "teammate-1" }),
    });

    expect(res.status).toBe(200);
    expect(received).toEqual([{ type: "mailbox", id, op: "assign" }]);
  });
});

describe("bulk mutation publishes the requested action as op", () => {
  test("bulk trash publishes op 'trash' for every updated id", async () => {
    const idA = await seedMessage("op-bulk-a");
    const idB = await seedMessage("op-bulk-b");
    const bus = createInMemoryMailboxEventBus();
    const received: MailboxEvent[] = [];
    bus.subscribe(P, (e) => received.push(e));
    const app = buildApp(bus);

    const res = await app.request("/me/inbox/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "trash", ids: [idA, idB] }),
    });

    expect(res.status).toBe(200);
    expect(received).toHaveLength(2);
    expect(received.every((e) => e.op === "trash")).toBe(true);
    expect(new Set(received.map((e) => e.id))).toEqual(new Set([idA, idB]));
  });
});

describe("delivery publishes op 'create'", () => {
  test("writeMailboxMessage against the same bus a mount would use", async () => {
    const bus = createInMemoryMailboxEventBus();
    const received: MailboxEvent[] = [];
    bus.subscribe(P, (e) => received.push(e));

    await writeMailboxMessage(
      db,
      {
        ...P,
        address: "p1@t1.example",
        fromAddress: "a@t1.example",
        subject: "New",
        body: "Body",
        messageKey: "op-create-write",
      },
      bus,
    );

    expect(received).toHaveLength(1);
    expect(received[0]?.op).toBe("create");
  });
});
