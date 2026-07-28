import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { mountMailbox, MAX_PENDING_SSE_EVENTS } from "./mount.js";
import { createInMemoryMailboxEventBus } from "./bus.js";
import { withTestDb, seedScope, TEST_VOCABULARY } from "./test-helpers.js";
import { writeMailboxMessage } from "./write.js";

describe("SSE stream", () => {
  test("delivers an event to the subscribed principalId only", async () => {
    const db = await withTestDb();
    await seedScope(db, "t1", "p1");
    const bus = createInMemoryMailboxEventBus();
    const app = mountMailbox(new Hono(), {
      vocabulary: TEST_VOCABULARY,
      db,
      bus,
      resolvePrincipal: () => ({ tenantId: "t1", principalId: "p1" }),
    });
    const res = await app.request("/me/inbox/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    // give the handler a tick to register its subscription
    await new Promise((r) => setTimeout(r, 50));
    await writeMailboxMessage(
      db,
      {
        tenantId: "t1",
        principalId: "p1",
        address: "p@b.c",
        fromAddress: "a@b.c",
        subject: "hi",
        body: "hello",
      },
      bus,
    );
    const chunk = await Promise.race([
      reader.read().then((r) => new TextDecoder().decode(r.value)),
      new Promise<string>((r) => setTimeout(() => r("__TIMEOUT__"), 3000)),
    ]);
    await reader.cancel();
    expect(chunk).not.toBe("__TIMEOUT__");
    expect(chunk).toContain("mailbox");
  });

  test("unsubscribe isolation: one closed stream does not stop another", async () => {
    const bus = createInMemoryMailboxEventBus();
    const scope = { tenantId: "t1", principalId: "p1" };
    const seenA: string[] = [];
    const seenB: string[] = [];
    const offA = bus.subscribe(scope, (e) => seenA.push(e.id));
    bus.subscribe(scope, (e) => seenB.push(e.id));
    offA();
    bus.publish(scope, { type: "mailbox", id: "x" });
    expect(seenA).toEqual([]);
    expect(seenB).toEqual(["x"]);
  });

  test("tenant isolation end-to-end: same principalId, different tenant, no event", async () => {
    const db = await withTestDb();
    await seedScope(db, "tenantA", "alice");
    await seedScope(db, "tenantB", "alice");
    const bus = createInMemoryMailboxEventBus();
    const app = mountMailbox(new Hono(), {
      vocabulary: TEST_VOCABULARY,
      db,
      bus,
      resolvePrincipal: () => ({ tenantId: "tenantA", principalId: "alice" }),
    });
    const res = await app.request("/me/inbox/events");
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    // give the handler a tick to register its subscription
    await new Promise((r) => setTimeout(r, 50));
    // ONE pending read for both races: a losing race branch would otherwise
    // keep an orphaned read holding the next chunk.
    const firstChunk = reader
      .read()
      .then((r) => new TextDecoder().decode(r.value));
    // tenantB's alice gets mail; tenantA's stream must stay silent.
    await writeMailboxMessage(
      db,
      {
        tenantId: "tenantB",
        principalId: "alice",
        address: "alice@b.example",
        fromAddress: "a@b.example",
        subject: "for the OTHER alice",
        body: "hello",
      },
      bus,
    );
    const crossTenant = await Promise.race([
      firstChunk,
      new Promise<string>((r) => setTimeout(() => r("__TIMEOUT__"), 300)),
    ]);
    expect(crossTenant).toBe("__TIMEOUT__");
    // And the stream is still live for its OWN scope, so the silence above was
    // isolation, not a dead connection.
    await writeMailboxMessage(
      db,
      {
        tenantId: "tenantA",
        principalId: "alice",
        address: "alice@a.example",
        fromAddress: "a@a.example",
        subject: "for this alice",
        body: "hello",
      },
      bus,
    );
    const ownTenant = await Promise.race([
      firstChunk,
      new Promise<string>((r) => setTimeout(() => r("__TIMEOUT__"), 3000)),
    ]);
    await reader.cancel();
    expect(ownTenant).not.toBe("__TIMEOUT__");
    expect(ownTenant).toContain("mailbox");
  });

  test("a consumer that stops reading is disconnected at the pending cap, not buffered for", async () => {
    const db = await withTestDb();
    await seedScope(db, "t1", "p1");
    const bus = createInMemoryMailboxEventBus();
    const scope = { tenantId: "t1", principalId: "p1" };
    const app = mountMailbox(new Hono(), {
      vocabulary: TEST_VOCABULARY,
      db,
      bus,
      resolvePrincipal: () => scope,
      // Short heartbeat so the handler notices the overflow-close promptly.
      heartbeatIntervalMs: 50,
    });
    const res = await app.request("/me/inbox/events");
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    // give the handler a tick to register its subscription
    await new Promise((r) => setTimeout(r, 50));
    // The client never reads. Every event is a nudge the client would refetch
    // from Postgres anyway, so past the cap the connection must close rather
    // than park one pending write per event forever.
    for (let i = 0; i <= MAX_PENDING_SSE_EVENTS + 5; i++) {
      bus.publish(scope, { type: "mailbox", id: `evt-${i}` });
    }
    const deadline = Date.now() + 3000;
    let done = false;
    while (!done && Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: boolean }>((r) =>
          setTimeout(() => r({ done: false }), 200),
        ),
      ]);
      done = result.done;
    }
    expect(done).toBe(true);
    // The subscription is gone with the connection: publishing again reaches
    // nobody and, more to the point, throws nothing.
    bus.publish(scope, { type: "mailbox", id: "after-close" });
  });
});
