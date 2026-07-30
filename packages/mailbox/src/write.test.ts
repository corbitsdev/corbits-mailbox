import { beforeEach, describe, expect, test } from "bun:test";
import {
  writeMailboxMessage,
  deliverInboxItems,
  mailboxKey,
  MAX_MAILBOX_REFS,
  MAX_MAILBOX_FRAME_BYTES,
} from "./write.js";
import { getMailboxMessage } from "./read.js";
import { createInMemoryMailboxEventBus } from "./bus.js";
import { withTestDb, seedScope } from "./test-helpers.js";
import type { MailboxDb } from "./db.js";
import { sql } from "drizzle-orm";


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

  test("mid-batch FK failure rolls back every new row from the same call", async () => {
    // One transaction for the whole batch: a later nonblank-but-unknown principal
    // must not leave the earlier good item committed.
    await expect(
      deliverInboxItems(db, [
        {
          tenantId: "t1",
          principalId: "p1",
          address: "p1@t1.example",
          fromAddress: "sender@ext.example",
          subject: "Good",
          body: "Body",
          source: "gmail",
          externalId: "atomic-good",
        },
        {
          tenantId: "t1",
          principalId: "nobody-seeded-this",
          address: "ghost@t1.example",
          fromAddress: "sender@ext.example",
          subject: "Bad",
          body: "Body",
          source: "gmail",
          externalId: "atomic-bad",
        },
      ]),
    ).rejects.toThrow();

    // Redelivery of the good item must insert (id !== null). If the first
    // call had partially committed, onConflictDoNothing would return null.
    const redelivery = await deliverInboxItems(db, [
      {
        tenantId: "t1",
        principalId: "p1",
        address: "p1@t1.example",
        fromAddress: "sender@ext.example",
        subject: "Good",
        body: "Body",
        source: "gmail",
        externalId: "atomic-good",
      },
    ]);
    expect(redelivery[0]?.id).not.toBeNull();
  });

  test("deduped keys are no-ops inside the batch without breaking atomicity", async () => {
    const item = {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "sender@ext.example",
      subject: "Already",
      body: "Body",
      source: "gmail",
      externalId: "atomic-dedupe",
    };
    const [first] = await deliverInboxItems(db, [item]);
    expect(first?.id).not.toBeNull();

    // Replay of the first + a new sibling in one call: the dedupe is a no-op
    // and the new row still commits.
    const batch = await deliverInboxItems(db, [
      item,
      { ...item, externalId: "atomic-dedupe-sibling" },
    ]);
    expect(batch[0]?.id).toBeNull();
    expect(batch[1]?.id).not.toBeNull();

    // Same shape, but the new sibling is followed by an FK failure: the sibling
    // must roll back; the already-committed first item stays.
    await expect(
      deliverInboxItems(db, [
        item,
        { ...item, externalId: "atomic-dedupe-should-roll-back" },
        {
          ...item,
          principalId: "nobody-seeded-this",
          address: "ghost@t1.example",
          externalId: "atomic-dedupe-fk",
        },
      ]),
    ).rejects.toThrow();

    const rolledBack = await deliverInboxItems(db, [
      { ...item, externalId: "atomic-dedupe-should-roll-back" },
    ]);
    expect(rolledBack[0]?.id).not.toBeNull();
  });

  test("enqueue throw does not reject delivery after commit", async () => {
    const results = await deliverInboxItems(
      db,
      [
        {
          tenantId: "t1",
          principalId: "p1",
          address: "p1@t1.example",
          fromAddress: "sender@ext.example",
          subject: "Hook boom",
          body: "Body",
          source: "gmail",
          externalId: "enqueue-throw",
        },
      ],
      {
        enqueue: () => {
          throw new Error("hook boom");
        },
      },
    );
    expect(results[0]?.id).not.toBeNull();
    const detail = await getMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      id: results[0]!.id!,
    });
    expect(detail).not.toBeNull();
  });

  test("deduped deliveries skip enqueue", async () => {
    const item = {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "sender@ext.example",
      subject: "Once",
      body: "Body",
      source: "gmail",
      externalId: "enqueue-skip-dedupe",
    };
    await deliverInboxItems(db, [item], {
      enqueue: () => {
        /* first delivery may call */
      },
    });
    const enqueued: string[] = [];
    const replay = await deliverInboxItems(db, [item], {
      enqueue: ({ id }) => enqueued.push(id),
    });
    expect(replay[0]?.id).toBeNull();
    expect(enqueued).toEqual([]);
  });

  test("bus publish and enqueue run only after a successful batch commit", async () => {
    const bus = createInMemoryMailboxEventBus();
    const received: string[] = [];
    bus.subscribe({ tenantId: "t1", principalId: "p1" }, (event) =>
      received.push(event.id),
    );
    const enqueued: string[] = [];

    await expect(
      deliverInboxItems(
        db,
        [
          {
            tenantId: "t1",
            principalId: "p1",
            address: "p1@t1.example",
            fromAddress: "sender@ext.example",
            subject: "Would publish",
            body: "Body",
            source: "gmail",
            externalId: "post-commit-good",
          },
          {
            tenantId: "t1",
            principalId: "nobody-seeded-this",
            address: "ghost@t1.example",
            fromAddress: "sender@ext.example",
            subject: "FK boom",
            body: "Body",
            source: "gmail",
            externalId: "post-commit-bad",
          },
        ],
        {
          bus,
          enqueue: ({ id }) => enqueued.push(id),
        },
      ),
    ).rejects.toThrow();

    expect(received).toEqual([]);
    expect(enqueued).toEqual([]);
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

describe("frame size hard cap", () => {
  async function mailRowCount(): Promise<number> {
    const rows = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM "mailbox"."principal_mail"`,
    );
    return rows[0]!.n;
  }

  // Headers add a few hundred bytes; leave headroom under the cap so near-cap
  // acceptance is not flaky on UUID/Date length. Body alone at the cap cannot
  // produce a legal frame (headers always add more) and is refused by both the
  // batch body precheck and the built-frame assert.
  const nearCapBody = "x".repeat(MAX_MAILBOX_FRAME_BYTES - 2048);
  const atCapBody = "x".repeat(MAX_MAILBOX_FRAME_BYTES);
  const overCapBody = "x".repeat(MAX_MAILBOX_FRAME_BYTES + 1);

  test("writeMailboxMessage accepts a near-cap frame and refuses an oversize one", async () => {
    const base = {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "agent@t1.example",
      subject: "cap",
    };
    const ok = await writeMailboxMessage(db, {
      ...base,
      body: nearCapBody,
      messageKey: "frame-cap-ok",
    });
    expect(ok).not.toBeNull();

    await expect(
      writeMailboxMessage(db, {
        ...base,
        body: overCapBody,
        messageKey: "frame-cap-over",
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      writeMailboxMessage(db, {
        ...base,
        body: overCapBody,
        messageKey: "frame-cap-over",
      }),
    ).rejects.toThrow(/mailbox frame exceeds/);

    // Only the near-cap row exists.
    expect(await mailRowCount()).toBe(1);
  });

  test("writeMailboxMessage refuses an oversize subject without writing", async () => {
    await expect(
      writeMailboxMessage(db, {
        tenantId: "t1",
        principalId: "p1",
        address: "p1@t1.example",
        fromAddress: "agent@t1.example",
        subject: "s".repeat(MAX_MAILBOX_FRAME_BYTES),
        body: "small",
        messageKey: "frame-cap-subject",
      }),
    ).rejects.toThrow(RangeError);
    expect(await mailRowCount()).toBe(0);
  });

  test("deliverInboxItems refuses body at the frame-byte cap with no durable write", async () => {

    // Body alone === MAX cannot produce a legal frame; prevalidation must refuse
    // before opening a transaction (not only body > MAX).
    await expect(
      deliverInboxItems(db, [
        {
          tenantId: "t1",
          principalId: "p1",
          address: "p1@t1.example",
          fromAddress: "sender@ext.example",
          subject: "at cap body",
          body: atCapBody,
          source: "gmail",
          externalId: "frame-at-cap",
        },
      ]),
    ).rejects.toThrow(RangeError);
    expect(await mailRowCount()).toBe(0);
  });

  test("deliverInboxItems refuses an oversized frame with no durable write", async () => {
    await expect(
      deliverInboxItems(db, [
        {
          tenantId: "t1",
          principalId: "p1",
          address: "p1@t1.example",
          fromAddress: "sender@ext.example",
          subject: "too big",
          body: overCapBody,
          source: "gmail",
          externalId: "frame-over",
        },
      ]),
    ).rejects.toThrow(RangeError);
    expect(await mailRowCount()).toBe(0);
  });

  test("deliverInboxItems prevalidates frame size for the whole batch", async () => {
    // Good item first: encode+assert of every item runs before the transaction,
    // so an oversize later item refuses with zero durable rows.
    await expect(
      deliverInboxItems(db, [
        {
          tenantId: "t1",
          principalId: "p1",
          address: "p1@t1.example",
          fromAddress: "sender@ext.example",
          subject: "ok",
          body: "small",
          source: "gmail",
          externalId: "batch-ok",
        },
        {
          tenantId: "t1",
          principalId: "p2",
          address: "p2@t1.example",
          fromAddress: "sender@ext.example",
          subject: "s".repeat(MAX_MAILBOX_FRAME_BYTES),
          body: "small",
          source: "gmail",
          externalId: "batch-over-subject",
        },
      ]),
    ).rejects.toThrow(RangeError);
    expect(await mailRowCount()).toBe(0);
  });
});

