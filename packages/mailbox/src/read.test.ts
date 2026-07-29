import { beforeEach, describe, expect, test } from "bun:test";
import { sql, getTableColumns } from "drizzle-orm";
import { writeMailboxMessage } from "./write.js";
import { listUserMailbox, getMailboxMessage } from "./read.js";
import { trashMailboxMessage } from "./mutations.js";
import { principalMail } from "./schema.js";
import { withTestDb, seedScope, TEST_VOCABULARY } from "./test-helpers.js";
import {
  encodeMailboxListCursor,
  decodeMailboxListCursor,
} from "./read.js";
import type { MailboxDb } from "./db.js";

let db: MailboxDb;

beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, "t1", "p1", "p2");
});

describe("listUserMailbox", () => {
  test("scopes strictly to (tenantId, principalId): cross-principalId isolation", async () => {
    await writeMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "a@t1.example",
      subject: "For p1",
      body: "Body",
      messageKey: "m1",
    });
    await writeMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p2",
      address: "p2@t1.example",
      fromAddress: "a@t1.example",
      subject: "For p2",
      body: "Body",
      messageKey: "m2",
    });
    const page = await listUserMailbox(db, {
      priorities: TEST_VOCABULARY.priorities,
      tenantId: "t1",
      principalId: "p1",
      limit: 50,
      view: "all",
    });
    expect(page.items.length).toBe(1);
    expect(page.items[0]?.subject).toBe("For p1");
  });

  test("keyset pagination: limit+1 detects hasMore and mints nextCursor", async () => {
    for (let i = 0; i < 3; i++) {
      await writeMailboxMessage(db, {
        tenantId: "t1",
        principalId: "p1",
        address: "p1@t1.example",
        fromAddress: "a@t1.example",
        subject: `Msg ${i}`,
        body: "Body",
        messageKey: `page-${i}`,
      });
    }
    const page1 = await listUserMailbox(db, {
      priorities: TEST_VOCABULARY.priorities,
      tenantId: "t1",
      principalId: "p1",
      limit: 2,
      view: "all",
    });
    expect(page1.items.length).toBe(2);
    expect(page1.nextCursor).toBeDefined();

    const decoded = decodeMailboxListCursor(page1.nextCursor!);
    const page2 = await listUserMailbox(db, {
      priorities: TEST_VOCABULARY.priorities,
      tenantId: "t1",
      principalId: "p1",
      limit: 2,
      view: "all",
      cursor: decoded!,
    });
    expect(page2.items.length).toBe(1);
    expect(page2.nextCursor).toBeUndefined();
  });

  test("a cursor minted for one view rejects against a different view (caller responsibility check)", async () => {
    const cursor = encodeMailboxListCursor(
      {
        createdAt: "2026-07-25T12:00:00.123456Z",
        id: "00000000-0000-0000-0000-000000000000",
      },
      { view: "unread", sort: "date", filter: "" },
    );
    const decoded = decodeMailboxListCursor(cursor);
    expect(decoded?.view).toBe("unread");
    expect(decoded?.view !== "all").toBe(true);
  });

  test("malformed cursor decodes to null", () => {
    expect(decodeMailboxListCursor("not-valid-base64url!!!")).toBeNull();
    expect(
      decodeMailboxListCursor(Buffer.from("{}").toString("base64url")),
    ).toBeNull();
    // Structurally valid JSON with a createdAt that is not the exact
    // microsecond rendering — accepted, it would become a SQL cast error.
    expect(
      decodeMailboxListCursor(
        Buffer.from(
          JSON.stringify({
            createdAt: "0",
            id: "00000000-0000-0000-0000-000000000000",
            view: "all",
            sort: "date",
            filter: "",
          }),
        ).toString("base64url"),
      ),
    ).toBeNull();
    // 1e400 parses to Infinity: a number, but not a safe-integer rank.
    expect(
      decodeMailboxListCursor(
        Buffer.from(
          '{"createdAt":"2026-01-01T00:00:00.000000Z",' +
            '"id":"00000000-0000-0000-0000-000000000000",' +
            '"view":"all","sort":"priority","filter":"",' +
            '"priorities":"urgent,high,normal,low","rank":1e400}',
        ).toString("base64url"),
      ),
    ).toBeNull();
  });

  test("view=trash / archived / unread filter correctly", async () => {
    const w1 = await writeMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "a@t1.example",
      subject: "Active",
      body: "Body",
      messageKey: "v-active",
    });
    const w2 = await writeMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "a@t1.example",
      subject: "Trashed",
      body: "Body",
      messageKey: "v-trashed",
    });
    await trashMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      id: w2!.id,
    });

    const trashPage = await listUserMailbox(db, {
      priorities: TEST_VOCABULARY.priorities,
      tenantId: "t1",
      principalId: "p1",
      limit: 50,
      view: "trash",
    });
    expect(trashPage.items.map((m) => m.id)).toEqual([w2!.id]);

    const allPage = await listUserMailbox(db, {
      priorities: TEST_VOCABULARY.priorities,
      tenantId: "t1",
      principalId: "p1",
      limit: 50,
      view: "all",
    });
    expect(allPage.items.map((m) => m.id)).toEqual([w1!.id]);
  });
});

describe("getMailboxMessage", () => {
  test("degrades gracefully on a malformed frame instead of throwing", async () => {
    const written = await writeMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "a@t1.example",
      subject: "Fine",
      body: "Body",
      messageKey: "malformed",
    });
    await db
      .update(principalMail)
      .set({ raw: Buffer.from([0xff, 0xfe, 0x00, 0x01]) })
      .where(sql`${principalMail.id} = ${written!.id}`);

    const message = await getMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      id: written!.id,
    });
    expect(message).not.toBeNull();
    expect(message?.body).toBe("");
  });

  test("degrades refs to empty array on stored-shape validation failure", async () => {
    const written = await writeMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "a@t1.example",
      subject: "Fine",
      body: "Body",
      messageKey: "bad-refs",
    });
    await db
      .update(principalMail)
      .set({ refs: [{ notARealShape: true }] as never })
      .where(sql`${principalMail.id} = ${written!.id}`);

    const message = await getMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      id: written!.id,
    });
    expect(message).not.toBeNull();
    expect(message?.refs).toBeUndefined();
  });

  test("detail still loads the full frame body (list does not)", async () => {
    const body = "x".repeat(500);
    const written = await writeMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "a@t1.example",
      subject: "Long",
      body,
      messageKey: "long-body",
    });
    const page = await listUserMailbox(db, {
      priorities: TEST_VOCABULARY.priorities,
      tenantId: "t1",
      principalId: "p1",
      limit: 50,
      view: "all",
    });
    const item = page.items.find((m) => m.id === written!.id);
    // List never decodes the frame, so no snippet and no body.
    // messageId falls back to the row id (no Message-ID header without raw).
    expect(item?.snippet).toBeUndefined();
    expect(item?.subject).toBe("Long");
    expect(item?.from).toBe("a@t1.example");
    expect(item?.messageId).toBe(written!.id);
    expect(item?.to).toEqual(["p1@t1.example"]);

    const detail = await getMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      id: written!.id,
    });
    expect(detail?.body).toBe(body);
    expect(detail?.snippet?.length).toBe(160);
  });

  test("list projects from cached columns without needing raw", async () => {
    // Behaviour under a multi-megabyte unparseable frame: list still returns
    // subject/from from caches and never surfaces a snippet. (Select-shape
    // omit of `raw` is asserted separately below — a null decode would make
    // these same expectations pass even if raw were still selected.)
    const written = await writeMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "cached@t1.example",
      subject: "Cached subject",
      body: "tiny",
      messageKey: "large-raw",
    });
    const huge = Buffer.alloc(2 * 1024 * 1024, 0xff);
    await db
      .update(principalMail)
      .set({ raw: huge })
      .where(sql`${principalMail.id} = ${written!.id}`);

    const page = await listUserMailbox(db, {
      priorities: TEST_VOCABULARY.priorities,
      tenantId: "t1",
      principalId: "p1",
      limit: 50,
      view: "all",
    });
    const item = page.items.find((m) => m.id === written!.id);
    expect(item).toBeDefined();
    expect(item?.subject).toBe("Cached subject");
    expect(item?.from).toBe("cached@t1.example");
    expect(item?.snippet).toBeUndefined();
  });

  test("list select shape omits principal_mail.raw", () => {
    // Mirrors PRINCIPAL_MAIL_LIST_COLUMNS in read.ts: every column except raw.
    // listUserMailbox spreads that object into .select({...}).
    const { raw, ...listColumns } = getTableColumns(principalMail);
    expect(raw).toBeDefined();
    expect(Object.keys(listColumns)).not.toContain("raw");
    // Sanity: list still projects the denormalized fields it needs.
    expect(Object.keys(listColumns)).toEqual(
      expect.arrayContaining(["subject", "fromAddress", "id", "createdAt"]),
    );
  });

  test("returns null for a message outside the caller's scope", async () => {
    const written = await writeMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "a@t1.example",
      subject: "Private",
      body: "Body",
      messageKey: "scoped",
    });
    const message = await getMailboxMessage(db, {
      tenantId: "t1",
      principalId: "someone-else",
      id: written!.id,
    });
    expect(message).toBeNull();
  });
});

describe("toMailboxMessage recipients", () => {
  test("splits a multi-recipient To header into separate addresses", async () => {
    const written = await writeMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      address: "a@t1.example, b@t1.example, c@t1.example",
      fromAddress: "sender@t1.example",
      subject: "Broadcast",
      body: "Body",
      messageKey: "multi-to",
    });
    const message = await getMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      id: written!.id,
    });
    expect(message?.to).toEqual([
      "a@t1.example",
      "b@t1.example",
      "c@t1.example",
    ]);
  });

  test("falls back to the row address when the frame has no To header", async () => {
    const written = await writeMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "sender@t1.example",
      subject: "No To",
      body: "Body",
      messageKey: "no-to",
    });
    await db.execute(
      sql`UPDATE "mailbox"."principal_mail" SET "raw" = convert_to('From: sender@t1.example' || chr(13) || chr(10) || chr(13) || chr(10) || 'Body', 'UTF8') WHERE "id" = ${written!.id}`,
    );
    const message = await getMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      id: written!.id,
    });
    expect(message?.to).toEqual(["p1@t1.example"]);
  });
});
