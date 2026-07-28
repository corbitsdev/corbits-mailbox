// The exported message schemas, alongside MailboxRef. These are
// runtime arktype schemas, not type aliases, so a consumer decoding this
// package's JSON off the wire has something to validate with. This suite proves
// they accept what the read path actually emits and reject what it never would.
import { beforeEach, describe, expect, test } from "bun:test";
import { type } from "arktype";
import {
  getMailboxMessage,
  listUserMailbox,
  MailboxMessageDetailSchema,
  MailboxMessageSchema,
  MailboxListResponseSchema,
} from "./read.js";
import { writeMailboxMessage } from "./write.js";
import { Hono } from "hono";
import { mountMailbox } from "./mount.js";
import { createInMemoryMailboxEventBus } from "./bus.js";
import { withTestDb, seedScope, TEST_VOCABULARY } from "./test-helpers.js";
import type { MailboxDb } from "./db.js";

let db: MailboxDb;
const SCOPE = { tenantId: "acme", principalId: "user-1" };

beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, "acme", "user-1");
});

function accepts(schema: type.Any, value: unknown): boolean {
  return !(schema(value) instanceof type.errors);
}

async function seed(): Promise<string> {
  const written = await writeMailboxMessage(db, {
    ...SCOPE,
    address: "user-1@acme.example",
    fromAddress: "bot@acme.example",
    subject: "Hello",
    body: "Body",
    messageKey: crypto.randomUUID(),
    priority: "high",
    classification: "deal-risk",
    status: "needs-action",
    refs: [{ kind: "deal", id: "d-1", label: "Acme renewal" }],
  });
  return written!.id;
}

describe("MailboxMessageSchema", () => {
  test("accepts a real listed message, refs and enrichment included", async () => {
    await seed();
    const page = await listUserMailbox(db, {
      ...SCOPE,
      limit: 10,
      view: "all",
      priorities: TEST_VOCABULARY.priorities,
    });
    const message = page.items[0];
    expect(message?.refs).toEqual([
      { kind: "deal", id: "d-1", label: "Acme renewal" },
    ]);
    expect(accepts(MailboxMessageSchema, message)).toBe(true);
  });

  test("rejects a message missing `from`, which the projection always sets", async () => {
    await seed();
    const page = await listUserMailbox(db, {
      ...SCOPE,
      limit: 10,
      view: "all",
      priorities: TEST_VOCABULARY.priorities,
    });
    const { from: _dropped, ...withoutFrom } = page.items[0]!;
    expect(accepts(MailboxMessageSchema, withoutFrom)).toBe(false);
  });

  test("rejects a malformed refs entry rather than passing it through", () => {
    expect(
      accepts(MailboxMessageSchema, {
        id: "m-1",
        from: "bot@acme.example",
        to: ["user-1@acme.example"],
        date: "2026-07-25T00:00:00.000Z",
        messageId: "<x@acme.example>",
        read: false,
        refs: [{ kind: "deal" }],
      }),
    ).toBe(false);
  });

  test("rejects a non-boolean `read`, the field a client branches on", () => {
    expect(
      accepts(MailboxMessageSchema, {
        id: "m-1",
        from: "bot@acme.example",
        to: ["user-1@acme.example"],
        date: "2026-07-25T00:00:00.000Z",
        messageId: "<x@acme.example>",
        read: "false",
      }),
    ).toBe(false);
  });
});

describe("MailboxMessageDetailSchema", () => {
  test("accepts a real detail read", async () => {
    const id = await seed();
    const detail = await getMailboxMessage(db, { ...SCOPE, id });
    expect(detail?.body).toContain("Body");
    expect(accepts(MailboxMessageDetailSchema, detail)).toBe(true);
  });

  test("rejects a list item, which carries no body", async () => {
    await seed();
    const page = await listUserMailbox(db, {
      ...SCOPE,
      limit: 10,
      view: "all",
      priorities: TEST_VOCABULARY.priorities,
    });
    expect(accepts(MailboxMessageDetailSchema, page.items[0])).toBe(false);
  });
});

describe("MailboxListResponseSchema", () => {
  // Validated against the actual HTTP body the mounted route returns, not
  // against an envelope the test assembled itself — a schema that only ever
  // sees a hand-built object proves nothing about what ships.
  function inbox() {
    const app = new Hono();
    mountMailbox(app, {
      vocabulary: TEST_VOCABULARY,
      db,
      bus: createInMemoryMailboxEventBus(),
      resolvePrincipal: () => SCOPE,
    });
    return app;
  }

  test("accepts the wire response, with and without a nextCursor", async () => {
    await seed();
    await seed();

    const full = await (await inbox().request("/me/inbox")).json();
    expect((full as { nextCursor?: string }).nextCursor).toBeUndefined();
    expect(accepts(MailboxListResponseSchema, full)).toBe(true);

    const paged = await (await inbox().request("/me/inbox?limit=1")).json();
    expect((paged as { nextCursor?: string }).nextCursor).toBeDefined();
    expect(accepts(MailboxListResponseSchema, paged)).toBe(true);
  });

  test("rejects the in-process MailboxPage shape, which uses `items`", async () => {
    await seed();
    const page = await listUserMailbox(db, {
      ...SCOPE,
      limit: 10,
      view: "all",
      priorities: TEST_VOCABULARY.priorities,
    });
    expect(accepts(MailboxListResponseSchema, page)).toBe(false);
  });

  test("rejects an envelope whose messages are not messages", () => {
    expect(
      accepts(MailboxListResponseSchema, { messages: [{ id: "m-1" }] }),
    ).toBe(false);
  });
});
