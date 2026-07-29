// The SSE keep-alive. `describeRoute` promises "a heartbeat comment every 25s"
// and the README repeats it, but nothing asserted a heartbeat frame was ever
// emitted — the loop could have been dead and every suite would still pass,
// because an idle stream and a broken keep-alive look identical until a proxy
// drops the connection in production.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mountMailbox } from "./mount.js";
import { createInMemoryMailboxEventBus } from "./bus.js";
import { writeMailboxMessage } from "./write.js";
import { withTestDb, seedScope, TEST_VOCABULARY } from "./test-helpers.js";
import type { MailboxDb } from "./db.js";

const SCOPE = { tenantId: "t1", principalId: "p1" };

function stream(db: MailboxDb, heartbeatIntervalMs: number) {
  const bus = createInMemoryMailboxEventBus();
  const app = mountMailbox(new Hono(), {
    vocabulary: TEST_VOCABULARY,
    db,
    bus,
    resolvePrincipal: () => SCOPE,
    heartbeatIntervalMs,
  });
  return { app, bus };
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

describe("SSE heartbeat", () => {
  test("emits a heartbeat comment on an otherwise idle stream", async () => {
    const db = await withTestDb();
    const { app } = stream(db, 20);
    const res = await app.request("/me/inbox/events");
    expect(res.status).toBe(200);

    // Nothing is ever published on this stream, so a heartbeat is the ONLY
    // thing that can arrive.
    const text = await readUntil(res.body!, (t) => t.includes(": heartbeat"));
    expect(text).toContain(": heartbeat\n\n");
  });

  test("keeps emitting heartbeats rather than sending exactly one", async () => {
    const db = await withTestDb();
    const { app } = stream(db, 20);
    const res = await app.request("/me/inbox/events");

    const text = await readUntil(
      res.body!,
      (t) => t.split(": heartbeat").length - 1 >= 3,
    );
    expect(text.split(": heartbeat").length - 1).toBeGreaterThanOrEqual(3);
  });

  test("heartbeats are comments, so they never look like mailbox events", async () => {
    const db = await withTestDb();
    const { app } = stream(db, 20);
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
    const { app, bus } = stream(db, 20);
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

  test("the default interval is the documented 25s, not the test override", async () => {
    const db = await withTestDb();
    const bus = createInMemoryMailboxEventBus();
    const app = mountMailbox(new Hono(), {
      vocabulary: TEST_VOCABULARY,
      db,
      bus,
      resolvePrincipal: () => SCOPE,
    });
    const res = await app.request("/me/inbox/events");

    // With no override, nothing may arrive within a second — otherwise the
    // override is leaking into the default and the 25s figure is fiction.
    const text = await readUntil(
      res.body!,
      (t) => t.includes(": heartbeat"),
      1_000,
    );
    expect(text).toBe("");
  });

  test("mount refuses a non-positive or non-finite heartbeatIntervalMs", async () => {
    // Zero/negative would spin a tight sleep/write loop per open connection;
    // NaN/Infinity are the same class of host misconfiguration. Fail at mount,
    // not on the first request, same as a bad vocabulary.
    const db = await withTestDb();
    const base = {
      vocabulary: TEST_VOCABULARY,
      db,
      bus: createInMemoryMailboxEventBus(),
      resolvePrincipal: () => SCOPE,
    };
    for (const heartbeatIntervalMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        mountMailbox(new Hono(), { ...base, heartbeatIntervalMs }),
      ).toThrow(RangeError);
    }
  });
});
