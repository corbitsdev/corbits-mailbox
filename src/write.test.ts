import { beforeEach, describe, expect, test } from "bun:test";
import {
  writeMailboxMessage,
  writeMailboxMessages,
  deliverInboxItems,
  mailboxKey,
  MAX_MAILBOX_REFS,
  MAX_MAILBOX_FRAME_BYTES,
} from "./write.js";
import { decodeMailFrame } from "./frame.js";
import { getMailboxMessage, listUserMailbox } from "./read.js";
import { countUnreadActiveMailbox } from "./mutations.js";
import { createInMemoryMailboxEventBus } from "./bus.js";
import { withTestDb, seedScope, TEST_VOCABULARY } from "./test-helpers.js";
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

  test("cached inReplyTo agrees between the list and detail projections", async () => {
    // The list projection serves `principal_mail.in_reply_to` (the cached
    // column); detail serves the header out of `raw`. Before normalizing
    // `inReplyTo` once on the way in, an untrimmed caller value was cached
    // verbatim while `buildMailFrame` trimmed the same value into the header
    // — so the same message projected two different inReplyTo strings
    // depending only on which route read it.
    const written = await writeMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "agent@t1.example",
      subject: "ws",
      body: "b",
      inReplyTo: "  <parent@t1.example>  ",
    });
    expect(written).not.toBeNull();

    const page = await listUserMailbox(db, {
      tenantId: "t1",
      principalId: "p1",
      limit: 50,
      view: "all",
      priorities: TEST_VOCABULARY.priorities,
    });
    const listed = page.items.find((m) => m.id === written!.id);
    const detail = await getMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      id: written!.id,
    });

    expect(detail?.inReplyTo).toBe("<parent@t1.example>");
    expect(listed?.inReplyTo).toBe("<parent@t1.example>");
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
    const received: Array<{ id: string; op?: string }> = [];
    bus.subscribe({ tenantId: "t1", principalId: "p1" }, (event) =>
      received.push(event),
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
    // A new message is a `create` — a listener can tell delivery apart from
    // a mutation without re-fetching and diffing.
    expect(received[0]?.op).toBe("create");
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

  test("a newly delivered item publishes a `create` event", async () => {
    const bus = createInMemoryMailboxEventBus();
    const received: Array<{ id: string; op?: string }> = [];
    bus.subscribe({ tenantId: "t1", principalId: "p1" }, (event) =>
      received.push(event),
    );
    await deliverInboxItems(
      db,
      [
        {
          tenantId: "t1",
          principalId: "p1",
          address: "p1@t1.example",
          fromAddress: "sender@ext.example",
          subject: "Delivered",
          body: "Body",
          source: "gmail",
          externalId: "op-create",
        },
      ],
      { bus },
    );
    expect(received).toHaveLength(1);
    expect(received[0]?.op).toBe("create");
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

  test("writeMailboxMessage refuses when headers plus body exceed the frame cap", async () => {
    // Each field alone is under the cap; the built MIME frame is not.
    const half = Math.floor(MAX_MAILBOX_FRAME_BYTES / 2);
    await expect(
      writeMailboxMessage(db, {
        tenantId: "t1",
        principalId: "p1",
        address: "p1@t1.example",
        fromAddress: "agent@t1.example",
        subject: "s".repeat(half),
        body: "b".repeat(half),
        messageKey: "frame-cap-sum",
      }),
    ).rejects.toThrow(RangeError);
    expect(await mailRowCount()).toBe(0);
  });

  test("deliverInboxItems accepts a near-cap frame and refuses body at the cap", async () => {
    const ok = await deliverInboxItems(db, [
      {
        tenantId: "t1",
        principalId: "p1",
        address: "p1@t1.example",
        fromAddress: "sender@ext.example",
        subject: "near",
        body: nearCapBody,
        source: "gmail",
        externalId: "near-cap",
      },
    ]);
    expect(ok).toHaveLength(1);
    expect(ok[0]!.id).not.toBeNull();
    expect(ok[0]!.messageKey).toBe(mailboxKey.inbox("gmail", "near-cap"));

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
    expect(await mailRowCount()).toBe(1);
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

describe("caller-supplied messageId, direction, and messageKey", () => {
  async function rawFrame(id: string): Promise<Uint8Array> {
    const rows = await db.execute<{ raw: Uint8Array }>(
      sql`SELECT raw FROM "mailbox"."principal_mail" WHERE id = ${id}`,
    );
    return rows[0]!.raw;
  }

  async function rowColumns(id: string): Promise<{
    direction: string;
    message_id: string | null;
    message_key: string | null;
  }> {
    const rows = await db.execute<{
      direction: string;
      message_id: string | null;
      message_key: string | null;
    }>(
      sql`SELECT direction, message_id, message_key FROM "mailbox"."principal_mail" WHERE id = ${id}`,
    );
    return rows[0]!;
  }

  test("a caller-supplied Message-ID round-trips to the stored frame header and the cached column", async () => {
    const messageId = "<caller-mid-1@example.com>";
    const written = await writeMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "agent@t1.example",
      subject: "Hello",
      body: "World",
      messageId,
    });
    expect(written).not.toBeNull();

    const raw = await rawFrame(written!.id);
    const decoded = decodeMailFrame(raw);
    expect(decoded?.messageId).toBe(messageId);

    const columns = await rowColumns(written!.id);
    expect(columns.message_id).toBe(messageId);
  });

  test("an invalid caller-supplied messageId is refused with RangeError", async () => {
    await expect(
      writeMailboxMessage(db, {
        tenantId: "t1",
        principalId: "p1",
        address: "p1@t1.example",
        fromAddress: "agent@t1.example",
        subject: "Hello",
        body: "World",
        messageId: "not-a-msg-id",
      }),
    ).rejects.toThrow(RangeError);
  });

  test("omitting messageId still mints one, as before", async () => {
    const written = await writeMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "agent@t1.example",
      subject: "Hello",
      body: "World",
    });
    const columns = await rowColumns(written!.id);
    expect(columns.message_id).toMatch(/^<.+@.+>$/);
  });

  test("direction defaults to inbound and can be set to outbound", async () => {
    const inbound = await writeMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "agent@t1.example",
      subject: "Hello",
      body: "World",
    });
    expect((await rowColumns(inbound!.id)).direction).toBe("inbound");

    const outbound = await writeMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "agent@t1.example",
      subject: "Sent",
      body: "World",
      direction: "outbound",
    });
    expect((await rowColumns(outbound!.id)).direction).toBe("outbound");
  });

  test("an explicit messageKey is honored over the default transport key", async () => {
    const written = await writeMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "agent@t1.example",
      subject: "Hello",
      body: "World",
      messageKey: "custom:my-key",
    });
    expect((await rowColumns(written!.id)).message_key).toBe("custom:my-key");
  });

  test("omitting messageKey defaults to the package's transport key, keyed off messageId", async () => {
    const messageId = "<default-key-1@example.com>";
    const written = await writeMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "agent@t1.example",
      subject: "Hello",
      body: "World",
      messageId,
    });
    expect((await rowColumns(written!.id)).message_key).toBe(
      mailboxKey.transport(messageId, "p1"),
    );

    // A retry with the SAME caller-supplied messageId therefore dedupes.
    const retry = await writeMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "agent@t1.example",
      subject: "Hello",
      body: "World",
      messageId,
    });
    expect(retry).toBeNull();
  });
});

describe("writeMailboxMessages (one-transaction batch write)", () => {
  async function mailRows(): Promise<
    Array<{ id: string; principal_id: string; direction: string }>
  > {
    return db.execute<{ id: string; principal_id: string; direction: string }>(
      sql`SELECT id, principal_id, direction FROM "mailbox"."principal_mail"`,
    );
  }

  test("a batch of three — one outbound for the sender, two inbound for recipients — commits atomically", async () => {
    const bus = createInMemoryMailboxEventBus();
    const receivedP1: Array<{ id: string; op?: string }> = [];
    const receivedP2: Array<{ id: string; op?: string }> = [];
    bus.subscribe({ tenantId: "t1", principalId: "p1" }, (e) =>
      receivedP1.push(e),
    );
    bus.subscribe({ tenantId: "t1", principalId: "p2" }, (e) =>
      receivedP2.push(e),
    );

    const ids = await writeMailboxMessages(
      db,
      [
        {
          scope: { tenantId: "t1", principalId: "p1" },
          args: {
            address: "p1@t1.example",
            fromAddress: "p1@t1.example",
            subject: "Sent",
            body: "Hi p2",
            direction: "outbound",
          },
        },
        {
          scope: { tenantId: "t1", principalId: "p1" },
          args: {
            address: "p1@t1.example",
            fromAddress: "p1@t1.example",
            subject: "Recv",
            body: "Hi p1",
            direction: "inbound",
          },
        },
        {
          scope: { tenantId: "t1", principalId: "p2" },
          args: {
            address: "p2@t1.example",
            fromAddress: "p1@t1.example",
            subject: "Recv",
            body: "Hi p2",
            direction: "inbound",
          },
        },
      ],
      { bus },
    );

    expect(ids.length).toBe(3);
    const rows = await mailRows();
    expect(rows.length).toBe(3);
    // p1 receives two events (its outbound sent-copy and its inbound copy),
    // p2 receives one (its inbound copy) — one bus event per written row.
    expect(receivedP1.length).toBe(2);
    expect(receivedP2.length).toBe(1);
    expect(receivedP1.every((e) => e.op === "create")).toBe(true);
    expect(receivedP2[0]?.op).toBe("create");
  });

  test("a failing third item rolls back the whole batch, leaving zero rows", async () => {
    await expect(
      writeMailboxMessages(db, [
        {
          scope: { tenantId: "t1", principalId: "p1" },
          args: {
            address: "p1@t1.example",
            fromAddress: "p1@t1.example",
            subject: "Sent",
            body: "Hi p2",
            direction: "outbound",
          },
        },
        {
          scope: { tenantId: "t1", principalId: "p2" },
          args: {
            address: "p2@t1.example",
            fromAddress: "p1@t1.example",
            subject: "Recv",
            body: "Hi p2",
            direction: "inbound",
          },
        },
        {
          scope: { tenantId: "t1", principalId: "nobody-seeded-this" },
          args: {
            address: "ghost@t1.example",
            fromAddress: "p1@t1.example",
            subject: "Bad",
            body: "Bad",
          },
        },
      ]),
    ).rejects.toThrow();

    expect((await mailRows()).length).toBe(0);
  });

  test("retrying an already-committed batch (same messageIds, no messageKey) writes nothing and returns null ids", async () => {
    const messageId1 = "<batch-retry-1@example.com>";
    const messageId2 = "<batch-retry-2@example.com>";
    const items = [
      {
        scope: { tenantId: "t1", principalId: "p1" },
        args: {
          address: "p1@t1.example",
          fromAddress: "p1@t1.example",
          subject: "Sent",
          body: "Hi p2",
          direction: "outbound" as const,
          messageId: messageId1,
        },
      },
      {
        scope: { tenantId: "t1", principalId: "p2" },
        args: {
          address: "p2@t1.example",
          fromAddress: "p1@t1.example",
          subject: "Recv",
          body: "Hi p2",
          direction: "inbound" as const,
          messageId: messageId2,
        },
      },
    ];

    const first = await writeMailboxMessages(db, items);
    expect(first.length).toBe(2);

    const retry = await writeMailboxMessages(db, items);
    expect(retry.map((r) => r.id)).toEqual([null, null]);
    expect((await mailRows()).length).toBe(2);
  });

  test("events fire only after commit, and only for newly-written rows", async () => {
    const bus = createInMemoryMailboxEventBus();
    const received: Array<{ id: string }> = [];
    bus.subscribe({ tenantId: "t1", principalId: "p1" }, (e) =>
      received.push(e),
    );

    const messageId = "<batch-events-1@example.com>";
    const item = {
      scope: { tenantId: "t1", principalId: "p1" },
      args: {
        address: "p1@t1.example",
        fromAddress: "p1@t1.example",
        subject: "Hello",
        body: "World",
        messageId,
      },
    };

    const first = await writeMailboxMessages(db, [item], { bus });
    expect(first.length).toBe(1);
    expect(received.map((e) => e.id)).toEqual(
      first.map((row) => row.id).filter((id): id is string => id !== null),
    );

    // Dedupe: the retry writes nothing and must not publish a second event.
    const retry = await writeMailboxMessages(db, [item], { bus });
    expect(retry.map((r) => r.id)).toEqual([null]);
    expect(received.length).toBe(1);
  });

  test("a messageKey override is honored inside a batch", async () => {
    const results = await writeMailboxMessages(db, [
      {
        scope: { tenantId: "t1", principalId: "p1" },
        args: {
          address: "p1@t1.example",
          fromAddress: "p1@t1.example",
          subject: "Hello",
          body: "World",
          messageKey: "custom:batch-key",
        },
      },
    ]);
    expect(results[0]?.messageKey).toBe("custom:batch-key");
    const rows = await db.execute<{ message_key: string }>(
      sql`SELECT message_key FROM "mailbox"."principal_mail" WHERE id = ${results[0]?.id}`,
    );
    expect(rows[0]?.message_key).toBe("custom:batch-key");
  });

  test("returns { messageKey, id } per item, in item order, including the default-keyed items", async () => {
    const messageId = "<batch-order-1@example.com>";
    const results = await writeMailboxMessages(db, [
      {
        scope: { tenantId: "t1", principalId: "p1" },
        args: {
          address: "p1@t1.example",
          fromAddress: "p1@t1.example",
          subject: "Sent",
          body: "Hi p2",
          direction: "outbound",
          messageId,
        },
      },
      {
        scope: { tenantId: "t1", principalId: "p2" },
        args: {
          address: "p2@t1.example",
          fromAddress: "p1@t1.example",
          subject: "Recv",
          body: "Hi p2",
          direction: "inbound",
          messageId,
        },
      },
    ]);
    expect(results).toEqual([
      { messageKey: `transport:mid:${messageId}:p1:outbound`, id: expect.any(String) },
      { messageKey: `transport:mid:${messageId}:p2`, id: expect.any(String) },
    ]);
  });

  test("invalid scope on a later item is refused before any row is written", async () => {
    await expect(
      writeMailboxMessages(db, [
        {
          scope: { tenantId: "t1", principalId: "p1" },
          args: {
            address: "p1@t1.example",
            fromAddress: "p1@t1.example",
            subject: "Hello",
            body: "World",
          },
        },
        {
          scope: { tenantId: "t1", principalId: "  " },
          args: {
            address: "p1@t1.example",
            fromAddress: "p1@t1.example",
            subject: "Hello",
            body: "World",
          },
        },
      ]),
    ).rejects.toThrow(RangeError);
    expect((await mailRows()).length).toBe(0);
  });

  test("mailbox management row is created for outbound rows written through the batch path too", async () => {
    const results = await writeMailboxMessages(db, [
      {
        scope: { tenantId: "t1", principalId: "p1" },
        args: {
          address: "p1@t1.example",
          fromAddress: "p1@t1.example",
          subject: "Hello",
          body: "World",
          direction: "outbound",
        },
      },
    ]);
    const rows = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM "mailbox"."mailbox" WHERE id = ${results[0]?.id}`,
    );
    expect(rows[0]!.n).toBe(1);
  });
});

describe("outbound rows and the inbox read model", () => {
  const base = {
    tenantId: "t1",
    principalId: "p1",
    address: "p1@t1.example",
    fromAddress: "p1@t1.example",
    subject: "Hello",
    body: "World",
  };

  test("an outbound row is created already-read: excluded from the unread view and count without a direction predicate", async () => {
    const written = await writeMailboxMessage(db, {
      ...base,
      direction: "outbound",
    });
    expect(written).not.toBeNull();

    const scope = { tenantId: "t1", principalId: "p1" };
    const page = await listUserMailbox(db, {
      ...scope,
      priorities: TEST_VOCABULARY.priorities,
      view: "unread",
      limit: 50,
    });
    expect(page.items.length).toBe(0);
    expect(
      await getMailboxMessage(db, { ...scope, id: written!.id }),
    ).toBeNull();
    expect(
      await getMailboxMessage(db, { ...scope, id: written!.id, direction: "all" }),
    ).not.toBeNull();

    expect(await countUnreadActiveMailbox(db, scope)).toBe(0);
  });

  test("listUserMailbox and getMailboxMessage accept an explicit direction filter", async () => {
    const outbound = await writeMailboxMessage(db, {
      ...base,
      direction: "outbound",
      messageId: "<direction-filter-1@example.com>",
    });
    const inbound = await writeMailboxMessage(db, {
      ...base,
      direction: "inbound",
      messageId: "<direction-filter-2@example.com>",
    });
    const scope = { tenantId: "t1", principalId: "p1" };

    const outboundPage = await listUserMailbox(db, {
      ...scope,
      priorities: TEST_VOCABULARY.priorities,
      view: "all",
      limit: 50,
      direction: "outbound",
    });
    expect(outboundPage.items.map((i) => i.id)).toEqual([outbound!.id]);

    const allPage = await listUserMailbox(db, {
      ...scope,
      priorities: TEST_VOCABULARY.priorities,
      view: "all",
      limit: 50,
      direction: "all",
    });
    expect(new Set(allPage.items.map((i) => i.id))).toEqual(
      new Set([outbound!.id, inbound!.id]),
    );

    expect(
      await getMailboxMessage(db, {
        ...scope,
        id: outbound!.id,
        direction: "outbound",
      }),
    ).not.toBeNull();
  });
});

describe("default messageKey collisions", () => {
  const base = {
    tenantId: "t1",
    principalId: "p1",
    address: "p1@t1.example",
    fromAddress: "p1@t1.example",
    subject: "Hello",
    body: "World",
  };

  test("same caller Message-ID to the same principal in both directions writes two distinct rows", async () => {
    const messageId = "<turn-1@t1.example>";
    const results = await writeMailboxMessages(db, [
      {
        scope: { tenantId: "t1", principalId: "p1" },
        args: { ...base, direction: "outbound", messageId, subject: "Sent" },
      },
      {
        scope: { tenantId: "t1", principalId: "p1" },
        args: { ...base, direction: "inbound", messageId, subject: "Recv" },
      },
    ]);
    expect(results.length).toBe(2);
    expect(results.every((r) => r.id !== null)).toBe(true);
  });

  test("two distinct messages that reuse one caller Message-ID for the same principal collide", async () => {
    const messageId = "<reused@t1.example>";
    const a = await writeMailboxMessage(db, { ...base, messageId, subject: "A" });
    const b = await writeMailboxMessage(db, { ...base, messageId, subject: "B" });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  test("default write key equals persist.ts's transport key shape for the same Message-ID + principal", async () => {
    const messageId = "<shared@t1.example>";
    const written = await writeMailboxMessage(db, { ...base, messageId });
    const rows = await db.execute<{ message_key: string }>(
      sql`SELECT message_key FROM "mailbox"."principal_mail" WHERE id = ${written!.id}`,
    );
    expect(rows[0]!.message_key).toBe(`transport:mid:${messageId}:p1`);
  });
});

