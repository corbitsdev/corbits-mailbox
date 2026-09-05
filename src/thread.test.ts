// Thread reads are the one path that has to be right about *ancestry*, not
// just about scope: a fabricated parent silently reshapes a conversation, and
// a parent that changes when the reader turns the page is worse than none at
// all. Every test here pins one of those two properties.
import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { writeMailboxMessage } from "./write.js";
import { principalMail } from "./schema.js";
import {
  readMailboxThread,
  readMailboxMessageByMessageId,
  decodeMailboxThreadCursor,
} from "./thread.js";
import { withTestDb, seedScope } from "./test-helpers.js";
import type { MailboxDb } from "./db.js";

let db: MailboxDb;

const WORKBENCH = { kind: "workbench", id: "wb-1" } as const;
const OTHER_WORKBENCH = { kind: "workbench", id: "wb-2" } as const;

beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, "t1", "p1", "p2");
});

/**
 * `writeMailboxMessage` mints the frame's Message-ID itself, so a test that
 * wants to reply to a message has to read the minted id back — exactly as a
 * caller threading a real conversation would.
 */
async function send(args: {
  principalId?: string;
  subject: string;
  inReplyTo?: string;
  references?: string[];
  refs?: { kind: string; id: string }[];
  messageKey: string;
}): Promise<{ id: string; messageId: string }> {
  const principalId = args.principalId ?? "p1";
  const written = await writeMailboxMessage(db, {
    tenantId: "t1",
    principalId,
    address: `${principalId}@t1.example`,
    fromAddress: "sender@t1.example",
    subject: args.subject,
    body: "Body",
    messageKey: args.messageKey,
    ...(args.inReplyTo !== undefined ? { inReplyTo: args.inReplyTo } : {}),
    ...(args.references !== undefined ? { references: args.references } : {}),
    ...(args.refs !== undefined ? { refs: args.refs } : {}),
  });
  const [row] = await db
    .select({ messageId: principalMail.messageId })
    .from(principalMail)
    .where(eq(principalMail.id, written!.id));
  return { id: written!.id, messageId: row!.messageId! };
}

describe("readMailboxThread", () => {
  test("two replies with different In-Reply-To resolve to different parents", async () => {
    const root = await send({
      subject: "Root",
      refs: [WORKBENCH],
      messageKey: "root",
    });
    const first = await send({
      subject: "Re: Root",
      inReplyTo: root.messageId,
      references: [root.messageId],
      refs: [WORKBENCH],
      messageKey: "first",
    });
    const second = await send({
      subject: "Re: Re: Root",
      inReplyTo: first.messageId,
      references: [root.messageId, first.messageId],
      refs: [WORKBENCH],
      messageKey: "second",
    });

    const page = await readMailboxThread(
      db,
      { tenantId: "t1", principalId: "p1" },
      { ref: WORKBENCH },
    );
    const byId = new Map(page.items.map((item) => [item.id, item]));
    expect(page.items.map((item) => item.id)).toEqual([
      root.id,
      first.id,
      second.id,
    ]);
    expect(byId.get(root.id)?.parentId).toBeNull();
    expect(byId.get(first.id)?.parentId).toBe(root.id);
    expect(byId.get(second.id)?.parentId).toBe(first.id);
  });

  test("falls back to References, newest ancestor first, when In-Reply-To names nothing present", async () => {
    const root = await send({
      subject: "Root",
      refs: [WORKBENCH],
      messageKey: "root",
    });
    const middle = await send({
      subject: "Middle",
      inReplyTo: root.messageId,
      references: [root.messageId],
      refs: [WORKBENCH],
      messageKey: "middle",
    });
    // In-Reply-To names a message nobody in this mailbox has; References
    // carries the whole chain, and the NEWEST present ancestor wins.
    const leaf = await send({
      subject: "Leaf",
      inReplyTo: "<absent@t1.example>",
      references: [root.messageId, middle.messageId],
      refs: [WORKBENCH],
      messageKey: "leaf",
    });

    const page = await readMailboxThread(
      db,
      { tenantId: "t1", principalId: "p1" },
      { ref: WORKBENCH },
    );
    expect(page.items.find((item) => item.id === leaf.id)?.parentId).toBe(
      middle.id,
    );
  });

  test("a parent outside the principal's mailbox yields null, never a fabricated node", async () => {
    const foreign = await send({
      principalId: "p2",
      subject: "Not yours",
      refs: [WORKBENCH],
      messageKey: "foreign",
    });
    const reply = await send({
      subject: "Re: Not yours",
      inReplyTo: foreign.messageId,
      references: [foreign.messageId],
      refs: [WORKBENCH],
      messageKey: "reply",
    });

    const page = await readMailboxThread(
      db,
      { tenantId: "t1", principalId: "p1" },
      { ref: WORKBENCH },
    );
    expect(page.items.map((item) => item.id)).toEqual([reply.id]);
    expect(page.items[0]?.parentId).toBeNull();
  });

  test("a parent outside the ref yields null", async () => {
    const elsewhere = await send({
      subject: "Other workbench",
      refs: [OTHER_WORKBENCH],
      messageKey: "elsewhere",
    });
    const reply = await send({
      subject: "Re: Other workbench",
      inReplyTo: elsewhere.messageId,
      refs: [WORKBENCH],
      messageKey: "reply",
    });

    const page = await readMailboxThread(
      db,
      { tenantId: "t1", principalId: "p1" },
      { ref: WORKBENCH },
    );
    expect(page.items.map((item) => item.id)).toEqual([reply.id]);
    expect(page.items[0]?.parentId).toBeNull();
  });

  test("the refs filter excludes other workbenches", async () => {
    await send({
      subject: "Other",
      refs: [OTHER_WORKBENCH],
      messageKey: "other",
    });
    const mine = await send({
      subject: "Mine",
      refs: [WORKBENCH],
      messageKey: "mine",
    });
    await send({ subject: "Unreffed", messageKey: "unreffed" });

    const page = await readMailboxThread(
      db,
      { tenantId: "t1", principalId: "p1" },
      { ref: WORKBENCH },
    );
    expect(page.items.map((item) => item.subject)).toEqual(["Mine"]);
    expect(page.items[0]?.id).toBe(mine.id);
  });

  test("a chain spanning a page boundary keeps parentId stable across pages", async () => {
    // The parent of the first row on page two lives on page one, so a
    // resolver that only looked at the current page would answer null for it.
    const chain: { id: string; messageId: string }[] = [];
    let previous: { id: string; messageId: string } | undefined;
    for (let index = 0; index < 5; index += 1) {
      const message = await send({
        subject: `Message ${index}`,
        refs: [WORKBENCH],
        messageKey: `chain-${index}`,
        ...(previous !== undefined
          ? {
              inReplyTo: previous.messageId,
              references: chain.map((entry) => entry.messageId),
            }
          : {}),
      });
      chain.push(message);
      previous = message;
    }

    const whole = await readMailboxThread(
      db,
      { tenantId: "t1", principalId: "p1" },
      { ref: WORKBENCH },
    );
    const expected = new Map(
      whole.items.map((item) => [item.id, item.parentId]),
    );
    expect(whole.nextCursor).toBeUndefined();
    expect([...expected.values()]).toEqual([
      null,
      chain[0]!.id,
      chain[1]!.id,
      chain[2]!.id,
      chain[3]!.id,
    ]);

    const paged: { id: string; parentId: string | null }[] = [];
    let cursor: string | undefined;
    do {
      const page = await readMailboxThread(
        db,
        { tenantId: "t1", principalId: "p1" },
        { ref: WORKBENCH, limit: 2, ...(cursor !== undefined ? { cursor } : {}) },
      );
      for (const item of page.items) {
        paged.push({ id: item.id, parentId: item.parentId });
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    expect(paged.map((item) => item.id)).toEqual(chain.map((one) => one.id));
    for (const item of paged) {
      expect(item.parentId).toBe(expected.get(item.id)!);
    }
  });

  test("projects the threading headers and state without loading raw", async () => {
    const root = await send({
      subject: "Root",
      refs: [WORKBENCH],
      messageKey: "root",
    });
    const reply = await send({
      subject: "Re: Root",
      inReplyTo: root.messageId,
      references: [root.messageId],
      refs: [WORKBENCH],
      messageKey: "reply",
    });

    const page = await readMailboxThread(
      db,
      { tenantId: "t1", principalId: "p1" },
      { ref: WORKBENCH },
    );
    const item = page.items.find((one) => one.id === reply.id)!;
    expect(item.messageId).toBe(reply.messageId);
    expect(item.inReplyTo).toBe(root.messageId);
    expect(item.references).toEqual([root.messageId]);
    expect(item.fromAddress).toBe("sender@t1.example");
    expect(item.subject).toBe("Re: Root");
    expect(item.read).toBe(false);
    expect(item.archived).toBe(false);
    expect(item.createdAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
    );
    expect(page.items[0]?.references).toEqual([]);
  });

  test("refuses a cursor minted for a different ref", async () => {
    await send({ subject: "Mine", refs: [WORKBENCH], messageKey: "mine" });
    await send({ subject: "Mine 2", refs: [WORKBENCH], messageKey: "mine2" });
    const first = await readMailboxThread(
      db,
      { tenantId: "t1", principalId: "p1" },
      { ref: WORKBENCH, limit: 1 },
    );
    expect(first.nextCursor).toBeDefined();
    expect(
      readMailboxThread(
        db,
        { tenantId: "t1", principalId: "p1" },
        { ref: OTHER_WORKBENCH, cursor: first.nextCursor! },
      ),
    ).rejects.toThrow(RangeError);
  });

  test("refuses a malformed cursor and an out-of-range limit", async () => {
    expect(decodeMailboxThreadCursor("not-a-cursor")).toBeNull();
    expect(
      readMailboxThread(
        db,
        { tenantId: "t1", principalId: "p1" },
        { ref: WORKBENCH, cursor: "not-a-cursor" },
      ),
    ).rejects.toThrow(RangeError);
    expect(
      readMailboxThread(
        db,
        { tenantId: "t1", principalId: "p1" },
        { ref: WORKBENCH, limit: 0 },
      ),
    ).rejects.toThrow(RangeError);
  });
});

describe("readMailboxMessageByMessageId", () => {
  test("returns the principal's message", async () => {
    const message = await send({
      subject: "Findable",
      refs: [WORKBENCH],
      messageKey: "findable",
    });
    const found = await readMailboxMessageByMessageId(
      db,
      { tenantId: "t1", principalId: "p1" },
      message.messageId,
    );
    expect(found?.id).toBe(message.id);
    expect(found?.subject).toBe("Findable");
    expect(found?.refs).toEqual([WORKBENCH]);
  });

  test("another principal's message is null", async () => {
    const foreign = await send({
      principalId: "p2",
      subject: "Not yours",
      messageKey: "foreign",
    });
    expect(
      await readMailboxMessageByMessageId(
        db,
        { tenantId: "t1", principalId: "p1" },
        foreign.messageId,
      ),
    ).toBeNull();
    // …and is readable by the principal it belongs to, so the null above is
    // the scope filter rather than a lookup that never worked.
    expect(
      (
        await readMailboxMessageByMessageId(
          db,
          { tenantId: "t1", principalId: "p2" },
          foreign.messageId,
        )
      )?.id,
    ).toBe(foreign.id);
  });

  test("an unknown msg-id is null", async () => {
    expect(
      await readMailboxMessageByMessageId(
        db,
        { tenantId: "t1", principalId: "p1" },
        "<nobody@t1.example>",
      ),
    ).toBeNull();
  });
});

describe("thread edge cases: cycles, tie-breaks, scope", () => {
  /**
   * These tests write rows directly (bypassing `writeMailboxMessage`, which
   * mints its own Message-ID) so a scenario can pin exact msg-ids, exact
   * `createdAt` ordering, and — for the cycle tests — headers a real MIME
   * frame would never carry on its own but that RFC 5256 step 1.B still
   * requires a reader to survive.
   */
  async function insertRaw(args: {
    id: string;
    tenantId?: string;
    messageId: string | null;
    inReplyTo?: string | null;
    references?: string[] | null;
    createdAt: string;
    refs?: unknown;
  }): Promise<void> {
    await db.execute(sql`
      INSERT INTO "mailbox"."principal_mail"
        ("id","tenant_id","principal_id","address","direction","raw","message_id","in_reply_to","references","refs","created_at")
      VALUES (${args.id}, ${args.tenantId ?? "t1"}, 'p1', 'p1@t1.example', 'inbound', ${Buffer.from("x")},
              ${args.messageId}, ${args.inReplyTo ?? null},
              ${
                args.references === undefined || args.references === null
                  ? null
                  : JSON.stringify(args.references)
              }::jsonb,
              ${JSON.stringify(args.refs ?? [WORKBENCH])}::jsonb, ${args.createdAt}::timestamp)
    `);
  }

  test("a message whose References names its own Message-ID is not its own parent", async () => {
    await insertRaw({
      id: "a",
      messageId: "<a@x>",
      inReplyTo: "<a@x>",
      references: ["<a@x>"],
      createdAt: "2026-01-01T00:00:00.000001Z",
    });
    const page = await readMailboxThread(
      db,
      { tenantId: "t1", principalId: "p1" },
      { ref: WORKBENCH },
    );
    expect(page.items[0]?.parentId).toBeNull();
  });

  test("a mutual References cycle is broken: the LATER-created message becomes the root", async () => {
    await insertRaw({
      id: "a",
      messageId: "<a@x>",
      inReplyTo: "<b@x>",
      createdAt: "2026-01-01T00:00:00.000001Z",
    });
    await insertRaw({
      id: "b",
      messageId: "<b@x>",
      inReplyTo: "<a@x>",
      createdAt: "2026-01-01T00:00:00.000002Z",
    });
    const page = await readMailboxThread(
      db,
      { tenantId: "t1", principalId: "p1" },
      { ref: WORKBENCH },
    );
    const byId = new Map(page.items.map((i) => [i.id, i.parentId]));
    // b is later-created, so cutting b's edge breaks the cycle: a -> b -> null.
    expect(byId.get("a")).toBe("b");
    expect(byId.get("b")).toBeNull();
  });

  test("a child that is OLDER than its parent still resolves (ancestor map is not ordering-bound)", async () => {
    await insertRaw({
      id: "child",
      messageId: "<c@x>",
      inReplyTo: "<p@x>",
      createdAt: "2026-01-01T00:00:00.000001Z",
    });
    await insertRaw({
      id: "parent",
      messageId: "<p@x>",
      createdAt: "2026-01-02T00:00:00.000001Z",
    });
    const page = await readMailboxThread(
      db,
      { tenantId: "t1", principalId: "p1" },
      { ref: WORKBENCH, limit: 1 },
    );
    expect(page.items[0]?.id).toBe("child");
    expect(page.items[0]?.parentId).toBe("parent");
  });

  test("duplicate Message-ID: oldest carrier wins, and self is skipped even when a duplicate exists", async () => {
    await insertRaw({
      id: "dup-old",
      messageId: "<d@x>",
      createdAt: "2026-01-01T00:00:00.000001Z",
    });
    await insertRaw({
      id: "dup-new",
      messageId: "<d@x>",
      inReplyTo: "<d@x>",
      createdAt: "2026-01-01T00:00:00.000002Z",
    });
    await insertRaw({
      id: "reply",
      messageId: "<r@x>",
      inReplyTo: "<d@x>",
      createdAt: "2026-01-01T00:00:00.000003Z",
    });
    const page = await readMailboxThread(
      db,
      { tenantId: "t1", principalId: "p1" },
      { ref: WORKBENCH },
    );
    const byId = new Map(page.items.map((i) => [i.id, i.parentId]));
    expect(byId.get("reply")).toBe("dup-old");
    // dup-new names its own msg-id; the oldest carrier is dup-old, which is
    // NOT itself, so it links there.
    expect(byId.get("dup-new")).toBe("dup-old");
    const found = await readMailboxMessageByMessageId(
      db,
      { tenantId: "t1", principalId: "p1" },
      "<d@x>",
    );
    expect(found?.id).toBe("dup-old");
  });

  test("same principalId under another tenant is invisible to lookup and thread", async () => {
    await seedScope(db, "t2", "p1");
    await insertRaw({
      id: "other-tenant",
      tenantId: "t2",
      messageId: "<o@x>",
      createdAt: "2026-01-01T00:00:00.000001Z",
    });
    expect(
      await readMailboxMessageByMessageId(
        db,
        { tenantId: "t1", principalId: "p1" },
        "<o@x>",
      ),
    ).toBeNull();
    const page = await readMailboxThread(
      db,
      { tenantId: "t1", principalId: "p1" },
      { ref: WORKBENCH },
    );
    expect(page.items).toEqual([]);
  });

  test("ref match is exact on kind and id; a ref carrying an extra label still matches", async () => {
    await insertRaw({
      id: "labelled",
      messageId: "<l@x>",
      createdAt: "2026-01-01T00:00:00.000001Z",
      refs: [{ kind: "workbench", id: "wb-1", label: "L" }],
    });
    await insertRaw({
      id: "prefix",
      messageId: "<p@x>",
      createdAt: "2026-01-01T00:00:00.000002Z",
      refs: [{ kind: "workbench", id: "wb-10" }],
    });
    await insertRaw({
      id: "kind",
      messageId: "<k@x>",
      createdAt: "2026-01-01T00:00:00.000003Z",
      refs: [{ kind: "thread", id: "wb-1" }],
    });
    const page = await readMailboxThread(
      db,
      { tenantId: "t1", principalId: "p1" },
      { ref: WORKBENCH },
    );
    expect(page.items.map((i) => i.id)).toEqual(["labelled"]);
  });

  test("a malformed references blob degrades to [] rather than failing the read", async () => {
    await insertRaw({
      id: "bad",
      messageId: "<b@x>",
      createdAt: "2026-01-01T00:00:00.000001Z",
    });
    await db.execute(
      sql`UPDATE "mailbox"."principal_mail" SET "references" = '{"not":"a list"}'::jsonb WHERE id = 'bad'`,
    );
    const page = await readMailboxThread(
      db,
      { tenantId: "t1", principalId: "p1" },
      { ref: WORKBENCH },
    );
    expect(page.items[0]?.references).toEqual([]);
  });

  test("EXPLAIN: ref-filtered thread page uses the GIN index once the table is large", async () => {
    await db.execute(sql`
      INSERT INTO "mailbox"."principal_mail" ("tenant_id","principal_id","address","direction","raw","message_id","refs","created_at")
      SELECT 't1','p1','p1@t1.example','inbound', ${Buffer.from("x")}, '<m' || g || '@x>',
             jsonb_build_array(jsonb_build_object('kind','workbench','id','wb-' || (g % 500))),
             now() - (g || ' seconds')::interval
      FROM generate_series(1, 50000) g`);
    await db.execute(sql`ANALYZE "mailbox"."principal_mail"`);
    const plan = await db.execute<{ "QUERY PLAN": string }>(sql`
      EXPLAIN SELECT pm.id FROM "mailbox"."principal_mail" pm
      LEFT JOIN "mailbox"."mailbox" m ON m.id = pm.id
      WHERE pm.tenant_id = 't1' AND pm.principal_id = 'p1' AND pm.direction = 'inbound'
        AND pm.refs @> '[{"kind":"workbench","id":"wb-1"}]'::jsonb
      ORDER BY pm.created_at ASC, pm.id ASC LIMIT 51`);
    const text = plan.map((r) => r["QUERY PLAN"]).join("\n");
    expect(text).toContain("principal_mail_refs_idx");
    const lookup = await db.execute<{ "QUERY PLAN": string }>(sql`
      EXPLAIN SELECT pm.id FROM "mailbox"."principal_mail" pm
      WHERE pm.tenant_id = 't1' AND pm.principal_id = 'p1' AND pm.direction = 'inbound'
        AND pm.refs @> '[{"kind":"workbench","id":"wb-1"}]'::jsonb
        AND pm.message_id IN ('<m1@x>','<m501@x>')`);
    const ltext = lookup.map((r) => r["QUERY PLAN"]).join("\n");
    expect(ltext).toContain("principal_mail_tenant_id_principal_id_message_id_idx");
    // Bulk inserts of this size (needed for a realistic planner decision) run
    // past bun's default per-test timeout.
  }, 30000);

  test("EXPLAIN: a large, time-clustered ref pages via an Index Scan with a Limit, not a full sort", async () => {
    // 300k rows in the mailbox; the 50k newest of them all carry the SAME
    // ref, so the ref is both large (in absolute row count) and clustered at
    // one end of the created_at range — the shape that makes a page have to
    // choose between scanning the ordered btree with a Filter, or bitmapping
    // the GIN index and sorting every one of the ref's rows.
    await db.execute(sql`
      INSERT INTO "mailbox"."principal_mail" ("tenant_id","principal_id","address","direction","raw","message_id","refs","created_at")
      SELECT 't1','p1','p1@t1.example','inbound', ${Buffer.from("x")}, '<m' || g || '@x>',
             jsonb_build_array(jsonb_build_object(
               'kind','workbench',
               'id', CASE WHEN g <= 50000 THEN 'wb-1' ELSE 'wb-' || (g % 6000) END
             )),
             now() - (g || ' seconds')::interval
      FROM generate_series(1, 300000) g`);
    await db.execute(sql`ANALYZE "mailbox"."principal_mail"`);
    const plan = await db.execute<{ "QUERY PLAN": string }>(sql`
      EXPLAIN (ANALYZE, BUFFERS) SELECT pm.id FROM "mailbox"."principal_mail" pm
      LEFT JOIN "mailbox"."mailbox" m ON m.id = pm.id
      WHERE pm.tenant_id = 't1' AND pm.principal_id = 'p1' AND pm.direction = 'inbound'
        AND pm.refs @> '[{"kind":"workbench","id":"wb-1"}]'::jsonb
      ORDER BY pm.created_at ASC, pm.id ASC LIMIT 51`);
    const text = plan.map((r) => r["QUERY PLAN"]).join("\n");
    expect(text).toContain("Limit");
    expect(text).toContain("Index Scan");
    expect(text).not.toContain("Sort Key");
  }, 30000);
});

describe("the cached references column", () => {
  test("caches what the frame carries, so the thread read never touches raw", async () => {
    const root = await send({
      subject: "Root",
      refs: [WORKBENCH],
      messageKey: "root",
    });
    await send({
      subject: "Re: Root",
      inReplyTo: root.messageId,
      references: [root.messageId],
      refs: [WORKBENCH],
      messageKey: "reply",
    });
    const rows = await db
      .select({ references: principalMail.references })
      .from(principalMail)
      .where(
        and(
          eq(principalMail.tenantId, "t1"),
          eq(principalMail.principalId, "p1"),
          eq(principalMail.subject, "Re: Root"),
        ),
      );
    expect(rows[0]?.references).toEqual([root.messageId]);
  });
});
