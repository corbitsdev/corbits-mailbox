// POST /me/inbox/send: builds an RFC 5322 message, appends it to the
// caller's Sent folder, and hands it to the host's `deliver` — this package
// owns no transport of its own.
import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  createMailboxRoutes,
  type OutgoingMailboxMessage,
} from "../src/mount.js";
import { createInMemoryMailboxEventBus } from "../src/bus.js";
import { openNativeMailboxStore } from "../src/native-store.js";
import { MAX_MAILBOX_FRAME_BYTES } from "../src/write.js";
import { allowAllGrants, mountAs, withTestDb, seedScope } from "./helpers.js";
import type { MailboxDb } from "../src/db.js";

let db: MailboxDb;
const SCOPE = { tenantId: "t1", principalId: "p1" };
const FROM = "p1@t1.example";

beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, SCOPE.tenantId, SCOPE.principalId);
});

function buildApp(deliveries: OutgoingMailboxMessage[], sender = FROM) {
  const app = mountAs(
    SCOPE,
    createMailboxRoutes({
      db,
      requireGrant: allowAllGrants,
      bus: createInMemoryMailboxEventBus(),
      senderAddressFor: () => sender,
      deliver: (message) => {
        deliveries.push(message);
      },
    }),
  );
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

  function send(app: ReturnType<typeof buildApp>, body: object) {
    return app.request("/me/inbox/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("400s on a recipient carrying CR, LF or NUL, before any append or deliver", async () => {
    const deliveries: OutgoingMailboxMessage[] = [];
    const app = buildApp(deliveries);
    for (const to of [
      "bob@example.com\r\nBcc: evil@example.com",
      "bob@example.com\nX: 1",
      "bob\u0000@example.com",
    ]) {
      const res = await send(app, { to: [to], body: "Hi" });
      expect(res.status).toBe(400);
    }
    expect(deliveries).toHaveLength(0);
    const sent = await openNativeMailboxStore(db, { ...SCOPE, folder: "Sent" });
    expect(sent.messages).toHaveLength(0);
  });

  test("mints the Message-ID from the addr-spec of a display-name sender", async () => {
    const deliveries: OutgoingMailboxMessage[] = [];
    const app = buildApp(deliveries, "Pat <p1@t1.example>");
    const res = await send(app, { to: ["bob@example.com"], body: "Hi" });
    expect(res.status).toBe(200);
    const { messageId } = (await res.json()) as { messageId: string };
    expect(messageId).toMatch(/^<[^<>]+@t1\.example>$/);
    expect(deliveries[0]!.from).toBe("Pat <p1@t1.example>");
  });

  test("mints under hub.invalid when the host's sender has no addr-spec", async () => {
    const deliveries: OutgoingMailboxMessage[] = [];
    const app = buildApp(deliveries, "Pat");
    const res = await send(app, { to: ["bob@example.com"], body: "Hi" });
    expect(res.status).toBe(200);
    const { messageId } = (await res.json()) as { messageId: string };
    expect(messageId).toMatch(/^<[^<>]+@hub\.invalid>$/);
  });

  test("400s on a frame over the size cap without calling deliver", async () => {
    const deliveries: OutgoingMailboxMessage[] = [];
    const app = buildApp(deliveries);
    const res = await send(app, {
      to: ["bob@example.com"],
      body: "x".repeat(MAX_MAILBOX_FRAME_BYTES),
    });
    expect(res.status).toBe(400);
    expect(deliveries).toHaveLength(0);
    const sent = await openNativeMailboxStore(db, { ...SCOPE, folder: "Sent" });
    expect(sent.messages).toHaveLength(0);
  });

  test("403s with no resolvable principal", async () => {
    const app = mountAs(
      null,
      createMailboxRoutes({
        db,
        requireGrant: allowAllGrants,
        bus: createInMemoryMailboxEventBus(),
        senderAddressFor: () => FROM,
        deliver: () => {},
      }),
    );

    const res = await app.request("/me/inbox/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: ["bob@example.com"], body: "Hi" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /me/inbox/send when deliver fails", () => {
  function failingApp(error: Error) {
    return mountAs(
      SCOPE,
      createMailboxRoutes({
        db,
        requireGrant: allowAllGrants,
        bus: createInMemoryMailboxEventBus(),
        senderAddressFor: () => FROM,
        deliver: () => {
          throw error;
        },
      }),
    );
  }

  function send(app: ReturnType<typeof failingApp>) {
    return app.request("/me/inbox/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: ["bob@example.com"], body: "Hi" }),
    });
  }

  test("keeps the Sent copy, flags it $Undelivered, and propagates the HTTP status", async () => {
    const events: string[] = [];
    const bus = createInMemoryMailboxEventBus();
    bus.subscribe(SCOPE, (e) => events.push(`${e.id}:${e.op}`));
    const app = mountAs(
      SCOPE,
      createMailboxRoutes({
        db,
        requireGrant: allowAllGrants,
        bus,
        senderAddressFor: () => FROM,
        deliver: () => {
          throw new HTTPException(409, { message: "run finished" });
        },
      }),
    );

    const res = await send(app);
    expect(res.status).toBe(409);

    const sent = await openNativeMailboxStore(db, { ...SCOPE, folder: "Sent" });
    expect(sent.messages).toHaveLength(1);
    expect([...sent.messages[0]!.flags]).toContain("$Undelivered");
    expect(events).toEqual(["Sent:1:create", "Sent:1:undelivered"]);

    const list = await app.request("/me/inbox?folder=Sent");
    const { messages } = (await list.json()) as {
      messages: { flags: string[] }[];
    };
    expect(messages[0]!.flags).toContain("$Undelivered");
  });

  test("a non-HTTP failure still rejects and flags the Sent copy", async () => {
    const app = failingApp(new Error("transport down"));
    const res = await send(app);
    expect(res.status).toBe(500);
    const sent = await openNativeMailboxStore(db, { ...SCOPE, folder: "Sent" });
    expect([...sent.messages[0]!.flags]).toContain("$Undelivered");
  });
});
