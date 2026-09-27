import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createInMemoryMailboxEventBus,
  writeMailboxMessage,
  type MailboxEventBus,
} from "../src/index.js";
import {
  seedScope,
  as,
  createTestApp,
  createTestDb,
  type TestDb,
} from "./helpers.js";

let testDb: TestDb | undefined;

beforeAll(async () => {
  testDb = await createTestDb();
  await seedScope(testDb.db, "t1", "bob");
});

afterAll(async () => {
  await testDb?.close();
});

/** The in-memory bus, counting live subscriptions. */
function countingBus(): { bus: MailboxEventBus; live: () => number } {
  const inner = createInMemoryMailboxEventBus();
  let live = 0;
  return {
    live: () => live,
    bus: {
      publish: (scope, event) => inner.publish(scope, event),
      subscribe: (scope, listener) => {
        live += 1;
        const unsubscribe = inner.subscribe(scope, listener);
        let done = false;
        return () => {
          if (done) return;
          done = true;
          live -= 1;
          unsubscribe();
        };
      },
    },
  };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  done: (text: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 5_000;
  while (!done(text) && Date.now() < deadline) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  return text;
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a connected client receives new mail live and unsubscribes on disconnect", async () => {
  const { db } = testDb!;
  const { bus, live } = countingBus();
  const app = createTestApp({
    db,
    bus,
    senderAddressFor: ({ principalId }) => `${principalId}@t1.example`,
    deliver: () => {},
  });
  const abort = new AbortController();
  const res = await app.request("/mailbox/me/inbox/events", {
    headers: as("t1", "bob"),
    signal: abort.signal,
  });
  expect(res.status).toBe(200);
  await waitFor(() => live() === 1);
  expect(live()).toBe(1);

  await writeMailboxMessage(
    db,
    {
      tenantId: "t1",
      principalId: "bob",
      address: "bob@t1.example",
      fromAddress: "alice@t1.example",
      subject: "Live",
      body: "now",
    },
    bus,
  );

  const reader = res.body!.getReader();
  const text = await readUntil(reader, (t) => t.includes("event: mailbox"));
  expect(text).toContain("event: mailbox");
  expect(text).toContain('"op":"create"');

  abort.abort();
  await reader.cancel();
  await waitFor(() => live() === 0);
  expect(live()).toBe(0);
});
