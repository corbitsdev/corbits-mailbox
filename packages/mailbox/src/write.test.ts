import { beforeEach, describe, expect, test } from "bun:test";
import {
  writeMailboxMessage,
  deliverInboxItems,
  mailboxKey,
  MAX_MAILBOX_REFS,
} from "./write.js";
import { getMailboxMessage } from "./read.js";
import { createInMemoryMailboxEventBus } from "./bus.js";
import { withTestDb, seedScope } from "./test-helpers.js";
import type { MailboxDb } from "./db.js";

let db: MailboxDb;

beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, "t1", "p1", "p2");
});

describe("writeMailboxMessage", () => {
  test("inserts a row and returns its id", async () => {
    const result = await writeMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "agent@t1.example",
      subject: "Hello",
      body: "World",
    });
    expect(result).not.toBeNull();
    expect(typeof result?.id).toBe("string");
  });

  test("dedupes on (tenantId, principalId, messageKey): second write returns null", async () => {
    const args = {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "agent@t1.example",
      subject: "Hello",
      body: "World",
      messageKey: "gate:run1:signal",
    };
    const first = await writeMailboxMessage(db, args);
    const second = await writeMailboxMessage(db, args);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  test("a write to a scope the control plane does not know is an FK rejection", async () => {
    // The FKs are the enforcement: a mailbox that cannot exist is a caller
    // bug, not a deliverable outcome.
    await expect(
      writeMailboxMessage(db, {
        tenantId: "t1",
        principalId: "nobody-seeded-this",
        address: "ghost@t1.example",
        fromAddress: "agent@t1.example",
        subject: "Hello",
        body: "World",
      }),
    ).rejects.toThrow();
    await expect(
      writeMailboxMessage(db, {
        tenantId: "no-such-tenant",
        principalId: "p1",
        address: "p1@t1.example",
        fromAddress: "agent@t1.example",
        subject: "Hello",
        body: "World",
      }),
    ).rejects.toThrow();
  });

  test("a triaged write lands both rows, and the deduped retry clobbers neither", async () => {
    // The mail row and its triage row commit in ONE transaction: the retry
    // must dedupe to null while the first write's triage stamp stands.
    const args = {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "agent@t1.example",
      subject: "Hello",
      body: "World",
      messageKey: "triaged-once",
      priority: "urgent",
      status: "needs-action",
    };
    const first = await writeMailboxMessage(db, args);
    expect(first).not.toBeNull();

    const retry = await writeMailboxMessage(db, { ...args, priority: "low" });
    expect(retry).toBeNull();

    const detail = await getMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      id: first!.id,
    });
    expect(detail?.priority).toBe("urgent");
    expect(detail?.status).toBe("needs-action");
  });

  test("keyless (messageKey undefined) writes are never deduped against each other", async () => {
    const args = {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "agent@t1.example",
      subject: "Hello",
      body: "World",
    };
    const first = await writeMailboxMessage(db, args);
    const second = await writeMailboxMessage(db, args);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.id).not.toBe(second?.id);
  });

  test("caps refs at 20 entries with truncation (no throw)", async () => {
    const refs = Array.from({ length: 25 }, (_, i) => ({
      kind: "task",
      id: `task-${i}`,
    }));
    const result = await writeMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "agent@t1.example",
      subject: "Hello",
      body: "World",
      messageKey: "capped",
      refs,
    });
    expect(result).not.toBeNull();
    const message = await getMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      id: result!.id,
    });
    expect(message?.refs?.length).toBe(MAX_MAILBOX_REFS);
  });

  test("flattens embedded newlines in subject/from to prevent header injection", async () => {
    const result = await writeMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "agent@t1.example",
      subject: "Hello\r\nBcc: attacker@evil.example",
      body: "World",
      messageKey: "injected",
    });
    const message = await getMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      id: result!.id,
    });
    expect(message?.subject).not.toContain("\n");
    expect(message?.subject).not.toContain("\r");
  });

  test("notify (bus.publish) failure never fails the write", async () => {
    const failingBus = {
      publish() {
        throw new Error("boom");
      },
      subscribe() {
        return () => {};
      },
    };
    const result = await writeMailboxMessage(
      db,
      {
        tenantId: "t1",
        principalId: "p1",
        address: "p1@t1.example",
        fromAddress: "agent@t1.example",
        subject: "Hello",
        body: "World",
        messageKey: "notify-fail",
      },
      failingBus,
    );
    expect(result).not.toBeNull();
  });

  test("successful write publishes to the bus", async () => {
    const bus = createInMemoryMailboxEventBus();
    const received: string[] = [];
    bus.subscribe({ tenantId: "t1", principalId: "p1" }, (event) =>
      received.push(event.id),
    );
    await writeMailboxMessage(
      db,
      {
        tenantId: "t1",
        principalId: "p1",
        address: "p1@t1.example",
        fromAddress: "agent@t1.example",
        subject: "Hello",
        body: "World",
        messageKey: "notify-ok",
      },
      bus,
    );
    expect(received.length).toBe(1);
  });
});

describe("deliverInboxItems", () => {
  test("dedupes on mailboxKey.inbox(source, externalId)", async () => {
    const item = {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "sender@ext.example",
      subject: "Ext mail",
      body: "Body",
      source: "gmail",
      externalId: "ext-1",
    };
    const first = await deliverInboxItems(db, [item]);
    const second = await deliverInboxItems(db, [item]);
    expect(first[0]?.id).not.toBeNull();
    expect(second[0]?.id).toBeNull();
    expect(second[0]?.messageKey).toBe(mailboxKey.inbox("gmail", "ext-1"));
  });

  test("colon-bearing source/externalId pairs do not collide", async () => {
    const base = {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "sender@ext.example",
      subject: "Ext mail",
      body: "Body",
    };
    // ("a:b","c") vs ("a","b:c") used to share `inbox:a:b:c` under colon-join.
    const left = await deliverInboxItems(db, [
      { ...base, source: "a:b", externalId: "c" },
    ]);
    const right = await deliverInboxItems(db, [
      { ...base, source: "a", externalId: "b:c" },
    ]);
    expect(left[0]?.id).not.toBeNull();
    expect(right[0]?.id).not.toBeNull();
    expect(left[0]?.id).not.toBe(right[0]?.id);
    expect(left[0]?.messageKey).not.toBe(right[0]?.messageKey);
    expect(left[0]?.messageKey).toBe(mailboxKey.inbox("a:b", "c"));
    expect(right[0]?.messageKey).toBe(mailboxKey.inbox("a", "b:c"));
  });

  test("true replay still returns id=null", async () => {
    const item = {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "sender@ext.example",
      subject: "Replay",
      body: "Body",
      source: "a:b",
      externalId: "c",
    };
    const first = await deliverInboxItems(db, [item]);
    const replay = await deliverInboxItems(db, [item]);
    expect(first[0]?.id).not.toBeNull();
    expect(replay[0]?.id).toBeNull();
    expect(replay[0]?.messageKey).toBe(first[0]?.messageKey);
  });

  test("empty and unicode source/externalId components stay distinct", async () => {
    const base = {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "sender@ext.example",
      subject: "Unicode",
      body: "Body",
    };
    const pairs: Array<[string, string]> = [
      ["", "x"],
      ["x", ""],
      ["café", "id"],
      ["cafe", "id"],
      ["src", "外部"],
      ["src", "外部-2"],
    ];
    const delivered = [];
    for (const [source, externalId] of pairs) {
      const [row] = await deliverInboxItems(db, [
        { ...base, source, externalId },
      ]);
      delivered.push(row);
    }
    const ids = delivered.map((r) => r?.id);
    const keys = delivered.map((r) => r?.messageKey);
    expect(ids.every((id) => id !== null && id !== undefined)).toBe(true);
    expect(new Set(ids).size).toBe(pairs.length);
    expect(new Set(keys).size).toBe(pairs.length);
  });

  test("multi-recipient delivery creates one row per recipient", async () => {
    const base = {
      address: "shared@ext.example",
      fromAddress: "sender@ext.example",
      subject: "Broadcast",
      body: "Body",
      source: "gmail",
      externalId: "broadcast-1",
    };
    const results = await deliverInboxItems(db, [
      { ...base, tenantId: "t1", principalId: "p1" },
      { ...base, tenantId: "t1", principalId: "p2" },
    ]);
    expect(results.filter((r) => r.id !== null).length).toBe(2);
    const p1Message = await getMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      id: results[0]!.id!,
    });
    const p2Message = await getMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p2",
      id: results[1]!.id!,
    });
    expect(p1Message).not.toBeNull();
    expect(p2Message).not.toBeNull();
  });

  test("calls the host enqueue hook once per newly-delivered row", async () => {
    const enqueued: string[] = [];
    await deliverInboxItems(
      db,
      [
        {
          tenantId: "t1",
          principalId: "p1",
          address: "p1@t1.example",
          fromAddress: "sender@ext.example",
          subject: "Ext mail",
          body: "Body",
          source: "gmail",
          externalId: "ext-enqueue",
        },
      ],
      { enqueue: ({ id }) => enqueued.push(id) },
    );
    expect(enqueued.length).toBe(1);
  });
});

describe("mailboxKey namespaces", () => {
  test("gate: and run: never collide for the same underlying id", async () => {
    const base = {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "triage@t1.example",
      body: "Body",
    };
    expect(mailboxKey.gate("wf-1")).toBe("gate:wf-1");
    expect(mailboxKey.run("wf-1")).toBe("run:wf-1");

    const gate = await writeMailboxMessage(db, {
      ...base,
      subject: "Approval needed",
      messageKey: mailboxKey.gate("wf-1"),
    });
    const run = await writeMailboxMessage(db, {
      ...base,
      subject: "Run finished",
      messageKey: mailboxKey.run("wf-1"),
    });
    expect(gate).not.toBeNull();
    expect(run).not.toBeNull();
    expect(gate!.id).not.toBe(run!.id);
  });

  test("re-writing the same namespaced key is a no-op", async () => {
    const args = {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "triage@t1.example",
      subject: "Approval needed",
      body: "Body",
      messageKey: mailboxKey.gate("wf-2"),
    };
    expect(await writeMailboxMessage(db, args)).not.toBeNull();
    expect(await writeMailboxMessage(db, args)).toBeNull();
  });

  test("inbox keys are versioned length-prefixed and injective over source/externalId", () => {
    expect(mailboxKey.inbox("gmail", "123")).toBe("inbox2:5:gmail:123");
    expect(mailboxKey.inbox("a:b", "c")).toBe("inbox2:3:a:b:c");
    expect(mailboxKey.inbox("a", "b:c")).toBe("inbox2:1:a:b:c");
    expect(mailboxKey.inbox("a:b", "c")).not.toBe(mailboxKey.inbox("a", "b:c"));
    // disjoint from pre-upgrade `inbox:<source>:<externalId>` (no false collision
    // when historical source was pure decimal, e.g. source="5")
    expect(mailboxKey.inbox("gmail", "123")).not.toBe("inbox:5:gmail:123");
    // gate/run stay colon-prefixed single-segment namespaces
    expect(mailboxKey.gate("wf-1")).toBe("gate:wf-1");
    expect(mailboxKey.run("wf-1")).toBe("run:wf-1");
  });
});
