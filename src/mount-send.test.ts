// POST /me/inbox/send: builds an RFC 5322 message, appends it to the
// caller's Sent folder, and hands it to the host's `deliver` — this package
// owns no transport of its own.
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mountMailbox, type OutgoingMailboxMessage } from "./mount.js";
import { createInMemoryMailboxEventBus } from "./bus.js";
import { openNativeMailboxStore } from "./native-store.js";
import { withTestDb, seedScope } from "./test-helpers.js";
import type { MailboxDb } from "./db.js";

let db: MailboxDb;
const SCOPE = { tenantId: "t1", principalId: "p1" };
const FROM = "p1@t1.example";

beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, SCOPE.tenantId, SCOPE.principalId);
});

function buildApp(deliveries: OutgoingMailboxMessage[]) {
  const app = new Hono();
  mountMailbox(app, {
    db,
    bus: createInMemoryMailboxEventBus(),
    resolvePrincipal: () => SCOPE,
    senderAddressFor: () => FROM,
    deliver: (message) => {
      deliveries.push(message);
    },
  });
  return app;
}

describe("POST /me/inbox/send", () => {
  test("appends to Sent, calls deliver, and returns messageId + uid", async () => {
    const deliveries: OutgoingMailboxMessage[] = [];
    const app = buildApp(deliveries);

    const res = await app.request("/me/inbox/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: ["bob@example.com"],
        subject: "Hi",
        body: "Hello there",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { messageId: string; uid: number };
    expect(body.messageId).toMatch(/^<.+@.+>$/);
    expect(body.uid).toBe(1);

    // The Sent folder copy is durable and readable through the native store.
    const sent = await openNativeMailboxStore(db, { ...SCOPE, folder: "Sent" });
    expect(sent.messages).toHaveLength(1);
    const stored = sent.messages[0]!;
    expect(stored.envelope.messageId).toBe(body.messageId);
    expect(stored.envelope.from).toBe(FROM);
    // Recipients are cached on `principal_mail` at write time and read back
    // by `toEnvelope`, so listing Sent carries them without loading `raw`.
    expect(stored.envelope.to).toEqual(["bob@example.com"]);
    expect(stored.envelope.subject).toBe("Hi");
    const raw = await sent.readRaw(stored.uid);
    const decodedRaw = new TextDecoder().decode(raw);
    expect(decodedRaw).toContain("Hello there");
    expect(decodedRaw).toContain("To: bob@example.com");

    // The host's `deliver` was handed the same message, exactly once.
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.from).toBe(FROM);
    expect(deliveries[0]!.to).toEqual(["bob@example.com"]);
    expect(deliveries[0]!.messageId).toBe(body.messageId);
    expect(new TextDecoder().decode(deliveries[0]!.raw)).toContain(
      "Hello there",
    );
  });

  test("derives In-Reply-To/References from the parent message", async () => {
    const deliveries: OutgoingMailboxMessage[] = [];
    const app = buildApp(deliveries);

    const first = await app.request("/me/inbox/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: ["bob@example.com"], body: "Root" }),
    });
    const { messageId: rootId } = (await first.json()) as { messageId: string };

    const reply = await app.request("/me/inbox/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: ["bob@example.com"],
        body: "Reply",
        inReplyTo: rootId,
      }),
    });
    expect(reply.status).toBe(200);
    const { uid: replyUid } = (await reply.json()) as { uid: number };

    const sent = await openNativeMailboxStore(db, { ...SCOPE, folder: "Sent" });
    const stored = sent.find(replyUid)!;
    expect(stored.envelope.inReplyTo).toBe(rootId);
    expect(stored.envelope.references).toEqual([rootId]);
  });

  test("400s on a malformed body without calling deliver", async () => {
    const deliveries: OutgoingMailboxMessage[] = [];
    const app = buildApp(deliveries);

    const res = await app.request("/me/inbox/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: [], body: "no recipients" }),
    });

    expect(res.status).toBe(400);
    expect(deliveries).toHaveLength(0);
  });

  test("403s with no resolvable principal", async () => {
    const app = new Hono();
    mountMailbox(app, {
      db,
      bus: createInMemoryMailboxEventBus(),
      resolvePrincipal: () => null,
      senderAddressFor: () => FROM,
      deliver: () => {},
    });

    const res = await app.request("/me/inbox/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: ["bob@example.com"], body: "Hi" }),
    });
    expect(res.status).toBe(403);
  });
});
