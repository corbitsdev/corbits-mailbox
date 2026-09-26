import { beforeEach, describe, expect, test } from "bun:test";
import {
  writeMailboxMessage,
  deliverInboxItems,
  MAX_MAILBOX_FRAME_BYTES,
} from "../src/write.js";
import {
  createInMemoryMailboxEventBus,
  type MailboxEvent,
} from "../src/bus.js";
import { openNativeMailboxStore } from "../src/native-store.js";
import { withTestDb, seedScope } from "./helpers.js";
import type { MailboxDb } from "../src/db.js";

let db: MailboxDb;

beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, "t1", "p1");
});

function args(over: Partial<Parameters<typeof writeMailboxMessage>[1]> = {}) {
  return {
    tenantId: "t1",
    principalId: "p1",
    address: "p1@t1.example",
    fromAddress: "sender@t1.example",
    subject: "Hi",
    body: "Body",
    ...over,
  };
}

describe("writeMailboxMessage", () => {
  test("appends into the principal's INBOX with a fresh uid", async () => {
    const written = await writeMailboxMessage(db, args());
    expect(written).not.toBeNull();
    expect(written!.uid).toBe(1);
    const store = await openNativeMailboxStore(db, {
      tenantId: "t1",
      principalId: "p1",
      folder: "INBOX",
    });
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]!.envelope.subject).toBe("Hi");
  });

  test("rejects a blank scope before touching the store", async () => {
    await expect(
      writeMailboxMessage(db, args({ tenantId: "" })),
    ).rejects.toThrow(RangeError);
  });

  test("a second write with the same messageId is a no-op", async () => {
    const first = await writeMailboxMessage(
      db,
      args({ messageId: "<fixed@t1.example>" }),
    );
    const second = await writeMailboxMessage(
      db,
      args({ messageId: "<fixed@t1.example>", subject: "Different" }),
    );
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    const store = await openNativeMailboxStore(db, {
      tenantId: "t1",
      principalId: "p1",
      folder: "INBOX",
    });
    expect(store.messages).toHaveLength(1);
  });

  test("a non-bracketed messageId is refused", async () => {
    await expect(
      writeMailboxMessage(db, args({ messageId: "not-a-msg-id" })),
    ).rejects.toThrow(RangeError);
  });

  test("threading headers are normalized before both the frame and the envelope", async () => {
    const written = await writeMailboxMessage(
      db,
      args({ inReplyTo: "  <parent@t1.example>\n" }),
    );
    const store = await openNativeMailboxStore(db, {
      tenantId: "t1",
      principalId: "p1",
      folder: "INBOX",
    });
    const message = store.find(written!.uid)!;
    expect(message.envelope.inReplyTo).toBe("<parent@t1.example>");
  });

  test("publishes a `create` event when a bus is supplied", async () => {
    const bus = createInMemoryMailboxEventBus();
    const seen: MailboxEvent[] = [];
    bus.subscribe({ tenantId: "t1", principalId: "p1" }, (e) => seen.push(e));
    const written = await writeMailboxMessage(db, args(), bus);
    expect(seen).toEqual([{ type: "mailbox", id: written!.id, op: "create" }]);
  });

  test("a body/subject at the frame-byte cap is refused before any append", async () => {
    const huge = "a".repeat(MAX_MAILBOX_FRAME_BYTES);
    await expect(writeMailboxMessage(db, args({ body: huge }))).rejects.toThrow(
      RangeError,
    );
    const store = await openNativeMailboxStore(db, {
      tenantId: "t1",
      principalId: "p1",
      folder: "INBOX",
    });
    expect(store.messages).toHaveLength(0);
  });

  test("writes into a non-default folder when asked", async () => {
    await writeMailboxMessage(db, args({ folder: "Sent" }));
    const inbox = await openNativeMailboxStore(db, {
      tenantId: "t1",
      principalId: "p1",
      folder: "INBOX",
    });
    const sent = await openNativeMailboxStore(db, {
      tenantId: "t1",
      principalId: "p1",
      folder: "Sent",
    });
    expect(inbox.messages).toHaveLength(0);
    expect(sent.messages).toHaveLength(1);
  });
});

describe("deliverInboxItems", () => {
  function item(
    over: Partial<Parameters<typeof deliverInboxItems>[1][number]> = {},
  ) {
    return {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "adapter@t1.example",
      subject: "Ingress",
      body: "Body",
      source: "gmail",
      externalId: "ext-1",
      ...over,
    };
  }

  test("delivers a new item and dedupes a redelivery of the same (source, externalId)", async () => {
    const [first] = await deliverInboxItems(db, [item()]);
    const [second] = await deliverInboxItems(db, [item()]);
    expect(first!.id).not.toBeNull();
    expect(second!.id).toBeNull();
    const store = await openNativeMailboxStore(db, {
      tenantId: "t1",
      principalId: "p1",
      folder: "INBOX",
    });
    expect(store.messages).toHaveLength(1);
  });

  test("distinct externalIds deliver as distinct messages", async () => {
    const results = await deliverInboxItems(db, [
      item({ externalId: "a" }),
      item({ externalId: "b" }),
    ]);
    expect(results.map((r) => r.id).every((id) => id !== null)).toBe(true);
    const store = await openNativeMailboxStore(db, {
      tenantId: "t1",
      principalId: "p1",
      folder: "INBOX",
    });
    expect(store.messages).toHaveLength(2);
  });

  test("enqueue runs once per newly-delivered item, after its append settles", async () => {
    const seen: string[] = [];
    await deliverInboxItems(db, [item()], {
      enqueue: ({ id }) => seen.push(id),
    });
    await deliverInboxItems(db, [item()], {
      enqueue: ({ id }) => seen.push(id),
    });
    // The redelivery deduped, so enqueue must not fire a second time.
    expect(seen).toHaveLength(1);
  });

  test("a throwing enqueue does not lose the delivered item", async () => {
    const results = await deliverInboxItems(db, [item()], {
      enqueue: () => {
        throw new Error("hook exploded");
      },
    });
    expect(results[0]!.id).not.toBeNull();
  });
});
