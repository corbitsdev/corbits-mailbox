// The "header -> cached column -> default" chain the projected message
// resolves through. Every rung is exercised here, including the bottom one:
// a row whose stored frame the MIME parser rejects AND whose cached columns are
// NULL. That case used to project no `from` at all, so a consumer had to branch
// on a field the schema says is always there.
import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { type } from "arktype";
import {
  getMailboxMessage,
  listUserMailbox,
  MailboxMessageDetailSchema,
} from "./read.js";
import { writeMailboxMessage } from "./write.js";
import { withTestDb, seedScope, TEST_VOCABULARY } from "./test-helpers.js";
import type { MailboxDb } from "./db.js";

let db: MailboxDb;
const SCOPE = { tenantId: "acme", principalId: "user-1" };

beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, "acme", "user-1");
});

async function write(over: { subject?: string } = {}): Promise<string> {
  const written = await writeMailboxMessage(db, {
    ...SCOPE,
    address: "user-1@acme.example",
    fromAddress: "bot@acme.example",
    subject: over.subject ?? "Original subject",
    body: "Body text",
    messageKey: crypto.randomUUID(),
  });
  return written!.id;
}

/** Replace the stored frame with bytes `parseHeaderSection` rejects. */
async function corruptFrame(id: string): Promise<void> {
  await db.execute(
    sql`UPDATE "mailbox"."principal_mail" SET "raw" = '\\xdeadbeef'::bytea WHERE "id" = ${id}`,
  );
}

async function clearCachedColumns(id: string): Promise<void> {
  await db.execute(
    sql`UPDATE "mailbox"."principal_mail"
        SET "subject" = NULL, "from_address" = NULL WHERE "id" = ${id}`,
  );
}

/** Rewrite a cached column so it can be told apart from the header value. */
async function setCachedColumns(
  id: string,
  from: string,
  subject: string,
): Promise<void> {
  await db.execute(
    sql`UPDATE "mailbox"."principal_mail"
        SET "from_address" = ${from}, "subject" = ${subject} WHERE "id" = ${id}`,
  );
}

describe("from/subject fallback chain", () => {
  test("rung 1: the frame's headers win over the cached columns", async () => {
    const id = await write();
    // The cached columns are deliberately made to disagree with the frame. If
    // the read path preferred them, these are the values that would surface.
    await setCachedColumns(id, "stale@acme.example", "Stale subject");

    const detail = await getMailboxMessage(db, { ...SCOPE, id });
    expect(detail?.from).toBe("bot@acme.example");
    expect(detail?.subject).toBe("Original subject");
  });

  test("rung 2: cached columns are used when the frame will not parse", async () => {
    const id = await write();
    await setCachedColumns(id, "cached@acme.example", "Cached subject");
    await corruptFrame(id);

    const detail = await getMailboxMessage(db, { ...SCOPE, id });
    expect(detail?.from).toBe("cached@acme.example");
    expect(detail?.subject).toBe("Cached subject");
  });

  test("rung 3: from defaults to an empty string, never to absence", async () => {
    const id = await write();
    await corruptFrame(id);
    await clearCachedColumns(id);

    const detail = await getMailboxMessage(db, { ...SCOPE, id });
    expect(detail).not.toBeNull();
    // Both assertions matter: `""` is the specified default, and the key must
    // actually be present so a consumer never has to test for it.
    expect(detail!.from).toBe("");
    expect("from" in detail!).toBe(true);
  });

  test("rung 3: subject stays absent, because no-subject is not empty-subject", async () => {
    const id = await write();
    await corruptFrame(id);
    await clearCachedColumns(id);

    const detail = await getMailboxMessage(db, { ...SCOPE, id });
    expect("subject" in detail!).toBe(false);
  });

  test("an explicitly empty subject header survives as an empty string", async () => {
    const id = await write({ subject: "" });
    const detail = await getMailboxMessage(db, { ...SCOPE, id });
    // Distinct from the case above: the frame carries a `Subject:` line with
    // no value, so the field is present and empty rather than missing.
    expect(detail!.subject).toBe("");
  });

  test("the list path uses cached columns only (never decodes the frame)", async () => {
    const id = await write();
    // Stale cache would lose to headers on detail; list never opens the frame,
    // so the cached values surface even when they disagree with the raw MIME.
    await setCachedColumns(id, "list-cache@acme.example", "List cache subject");

    const page = await listUserMailbox(db, {
      ...SCOPE,
      limit: 10,
      view: "all",
      priorities: TEST_VOCABULARY.priorities,
    });
    const item = page.items.find((message) => message.id === id);
    expect(item).toBeDefined();
    expect(item!.from).toBe("list-cache@acme.example");
    expect(item!.subject).toBe("List cache subject");
    expect(item!.snippet).toBeUndefined();
  });

  test("a fully degraded message still satisfies the published schema", async () => {
    const id = await write();
    await corruptFrame(id);
    await clearCachedColumns(id);

    const detail = await getMailboxMessage(db, { ...SCOPE, id });
    const validated = MailboxMessageDetailSchema(detail);
    expect(validated instanceof type.errors).toBe(false);
  });
});
