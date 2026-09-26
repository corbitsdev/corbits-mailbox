import { describe, expect, spyOn, test } from "bun:test";
import { SSEStreamingApi } from "hono/streaming";
import { createMailboxRoutes, MAX_PENDING_SSE_EVENTS } from "../src/mount.js";
import {
  createInMemoryMailboxEventBus,
  type MailboxEventBus,
  type MailboxEventScope,
} from "../src/bus.js";
import { writeMailboxMessage } from "../src/write.js";
import { allowAllGrants, mountAs, withTestDb, seedScope } from "./helpers.js";
import type { MailboxDb } from "../src/db.js";

const SCOPE = { tenantId: "t1", principalId: "p1" };

function routes(
  db: MailboxDb,
  bus: MailboxEventBus,
  scope: MailboxEventScope,
  heartbeatIntervalMs?: number,
) {
  return mountAs(
    scope,
    createMailboxRoutes({
      db,
      requireGrant: allowAllGrants,
      bus,
      senderAddressFor: () => `sender@${scope.tenantId}.example`,
      deliver: () => {},
      heartbeatIntervalMs,
    }),
  );
}

/** Read frames until `done(text)` is satisfied, or give up after `timeoutMs`. */
async function readUntil(
  body: ReadableStream<Uint8Array>,
  done: (text: string) => boolean,
  timeoutMs = 5_000,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), 250),
        ),
      ]);
      if (chunk.value !== undefined) text += decoder.decode(chunk.value);
      if (done(text)) return text;
    }
    return text;
  } finally {
    await reader.cancel();
  }
}

describe("in-memory bus", () => {
  test("closing one subscriber leaves the others on the same scope", () => {
    const bus = createInMemoryMailboxEventBus();
    const a: string[] = [];
    const b: string[] = [];
    const offA = bus.subscribe(SCOPE, (e) => a.push(e.id));
    bus.subscribe(SCOPE, (e) => b.push(e.id));
    offA();
    bus.publish(SCOPE, { type: "mailbox", id: "x" });
    expect(a).toEqual([]);
    expect(b).toEqual(["x"]);
  });

  test("a double-called unsubscribe must not evict a later subscriber", () => {
    const bus = createInMemoryMailboxEventBus();
    const a: string[] = [];
    const offA = bus.subscribe(SCOPE, (e) => a.push(e.id));
    offA(); // tab A closes -> set for p1 becomes empty and is deleted
    const b: string[] = [];
    bus.subscribe(SCOPE, (e) => b.push(e.id)); // tab B opens (new Set)
    offA(); // mount.ts calls unsubscribe twice (onAbort + finally)
    bus.publish(SCOPE, { type: "mailbox", id: "evt" });
    expect(a).toEqual([]);
    expect(b).toEqual(["evt"]); // B is still subscribed
  });

  test("a throw mid-set still delivers to every remaining listener", () => {
    // Fan-out is best-effort per connection. One bad listener must not turn
    // publish into "first throw wins" and skip every open tab behind it.
    const bus = createInMemoryMailboxEventBus();
    const order: string[] = [];
    bus.subscribe(SCOPE, () => order.push("a"));
    bus.subscribe(SCOPE, () => {
      order.push("b");
      throw new Error("mid");
    });
    bus.subscribe(SCOPE, () => order.push("c"));
    expect(() =>
      bus.publish(SCOPE, { type: "mailbox", id: "x" }),
    ).not.toThrow();
    expect(order).toEqual(["a", "b", "c"]);
  });
});

describe("SSE stream", () => {
  test("delivers an event to the subscribed principalId only", async () => {
    const db = await withTestDb();
    await seedScope(db, "t1", "p1");
    const bus = createInMemoryMailboxEventBus();
    const app = routes(db, bus, SCOPE);
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

  test("tenant isolation end-to-end: same principalId, different tenant, no event", async () => {
    const db = await withTestDb();
    await seedScope(db, "tenantA", "alice");
    await seedScope(db, "tenantB", "alice");
    const bus = createInMemoryMailboxEventBus();
    const app = routes(db, bus, { tenantId: "tenantA", principalId: "alice" });
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
    // Short heartbeat so the handler notices the overflow-close promptly.
    const app = routes(db, bus, SCOPE, 50);
    const res = await app.request("/me/inbox/events");
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    // give the handler a tick to register its subscription
    await new Promise((r) => setTimeout(r, 50));
    // The client never reads. Every event is a nudge the client would refetch
    // from Postgres anyway, so past the cap the connection must close rather
    // than park one pending write per event forever.
    for (let i = 0; i <= MAX_PENDING_SSE_EVENTS + 5; i++) {
      bus.publish(SCOPE, { type: "mailbox", id: `evt-${i}` });
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
    bus.publish(SCOPE, { type: "mailbox", id: "after-close" });
  });

  test("a write failure while draining does not become an unhandled rejection", async () => {
    // drain() is fired with `void`; a rejected writeSSE must be caught inside
    // so it closes the stream cleanly instead of escaping as an unhandled
    // rejection that the process (or a host) has to notice later.
    //
    // Hono's StreamingApi.write swallows writer errors, so cancelling the
    // client never makes writeSSE reject in practice. Stub writeSSE to force
    // the drain catch path and assert cleanup + unsubscribe.
    const db = await withTestDb();
    await seedScope(db, "t1", "p1");
    const realBus = createInMemoryMailboxEventBus();
    let activeSubs = 0;
    const bus: MailboxEventBus = {
      publish(s, event) {
        realBus.publish(s, event);
      },
      subscribe(s: MailboxEventScope, listener) {
        activeSubs++;
        const off = realBus.subscribe(s, listener);
        let done = false;
        return () => {
          // mount unsubscribes from onAbort and finally; count once.
          if (done) return;
          done = true;
          activeSubs--;
          off();
        };
      },
    };
    // Short heartbeat so the loop notices `closed` and runs finally promptly.
    const app = routes(db, bus, SCOPE, 50);
    const writeSSE = spyOn(
      SSEStreamingApi.prototype,
      "writeSSE",
    ).mockRejectedValue(new Error("simulated socket death"));
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const res = await app.request("/me/inbox/events");
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      // give the handler a tick to register its subscription
      await new Promise((r) => setTimeout(r, 50));
      expect(activeSubs).toBe(1);
      // One publish is enough: drain awaits writeSSE, which rejects.
      bus.publish(SCOPE, { type: "mailbox", id: "force-drain-reject" });
      // Wait past one heartbeat so the loop exits on `closed` and finally
      // unsubscribes.
      await new Promise((r) => setTimeout(r, 200));
      expect(writeSSE).toHaveBeenCalled();
      expect(rejections).toEqual([]);
      expect(activeSubs).toBe(0);
      // Publish after the failure path must still be a no-op, not a throw.
      expect(() =>
        bus.publish(SCOPE, { type: "mailbox", id: "still-safe" }),
      ).not.toThrow();
      await reader.cancel();
    } finally {
      process.off("unhandledRejection", onRejection);
      writeSSE.mockRestore();
    }
  });
});

// `describeRoute` promises "a heartbeat comment every 25s". An idle stream and
// a dead keep-alive look identical until a proxy drops the connection, so the
// frames themselves are asserted.
describe("SSE heartbeat", () => {
  test("emits a heartbeat comment on an otherwise idle stream", async () => {
    const db = await withTestDb();
    const app = routes(db, createInMemoryMailboxEventBus(), SCOPE, 20);
    const res = await app.request("/me/inbox/events");
    expect(res.status).toBe(200);

    // Nothing is ever published on this stream, so a heartbeat is the ONLY
    // thing that can arrive.
    const text = await readUntil(res.body!, (t) => t.includes(": heartbeat"));
    expect(text).toContain(": heartbeat\n\n");
  });

  test("keeps emitting heartbeats rather than sending exactly one", async () => {
    const db = await withTestDb();
    const app = routes(db, createInMemoryMailboxEventBus(), SCOPE, 20);
    const res = await app.request("/me/inbox/events");

    const text = await readUntil(
      res.body!,
      (t) => t.split(": heartbeat").length - 1 >= 3,
    );
    expect(text.split(": heartbeat").length - 1).toBeGreaterThanOrEqual(3);
  });

  test("heartbeats are comments, so they never look like mailbox events", async () => {
    const db = await withTestDb();
    const app = routes(db, createInMemoryMailboxEventBus(), SCOPE, 20);
    const res = await app.request("/me/inbox/events");

    const text = await readUntil(res.body!, (t) => t.includes(": heartbeat"));
    // A client parsing this must not see a nameless event or stray data — an
    // SSE comment line starts with ':' and carries neither.
    expect(text).not.toContain("event:");
    expect(text).not.toContain("data:");
  });

  test("a real event still comes through while heartbeats are running", async () => {
    const db = await withTestDb();
    await seedScope(db, SCOPE.tenantId, SCOPE.principalId);
    const bus = createInMemoryMailboxEventBus();
    const app = routes(db, bus, SCOPE, 20);
    const res = await app.request("/me/inbox/events");

    const body = res.body!;
    // Registered on the next tick so the handler's subscription exists first.
    setTimeout(() => {
      void writeMailboxMessage(
        db,
        {
          ...SCOPE,
          address: "p@b.c",
          fromAddress: "a@b.c",
          subject: "hi",
          body: "hello",
        },
        bus,
      );
    }, 60);

    const text = await readUntil(body, (t) => t.includes("event: mailbox"));
    expect(text).toContain("event: mailbox");
    expect(text).toContain(": heartbeat");
  });

  test("mount refuses a non-positive or non-finite heartbeatIntervalMs", async () => {
    // Zero/negative would spin a tight sleep/write loop per open connection;
    // NaN/Infinity are the same class of host misconfiguration. Fail at mount,
    // not on the first request, same as a bad vocabulary.
    const db = await withTestDb();
    const bus = createInMemoryMailboxEventBus();
    for (const heartbeatIntervalMs of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(() => routes(db, bus, SCOPE, heartbeatIntervalMs)).toThrow(
        RangeError,
      );
    }
  });
});
