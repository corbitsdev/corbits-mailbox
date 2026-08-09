// The live consequence of the multipart body extraction: externally delivered
// mail arrives as multipart/alternative, so the detail body is projected from
// a frame the read path has to walk. List rows no longer decode the frame —
// they project subject/from from the cached columns only, with no snippet.
import { beforeEach, describe, expect, test } from "bun:test";
import { getMailboxMessage, listUserMailbox } from "./read.js";
import { principalMail } from "./schema.js";
import { withTestDb, seedScope, TEST_VOCABULARY } from "./test-helpers.js";
import type { MailboxDb } from "./db.js";

let db: MailboxDb;
const SCOPE = { tenantId: "acme", principalId: "user-1" };

beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, "acme", "user-1");
});

const MULTIPART = new TextEncoder().encode(
  [
    "From: sender@example.com",
    "To: user-1@acme.example",
    "Subject: Multipart hello",
    "Message-ID: <mp@example.com>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="BOUND"',
    "",
    "--BOUND",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hello human, this is the readable text.",
    "--BOUND",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Hello human</p>",
    "--BOUND--",
    "",
  ].join("\r\n"),
);

async function insertRaw(
  raw: Uint8Array,
  cached: { subject?: string; fromAddress?: string } = {},
): Promise<string> {
  const [row] = await db
    .insert(principalMail)
    .values({
      tenantId: SCOPE.tenantId,
      principalId: SCOPE.principalId,
      address: "user-1@acme.example",
      direction: "inbound",
      raw,
      subject: cached.subject,
      fromAddress: cached.fromAddress,
    })
    .returning({ id: principalMail.id });
  return row!.id;
}

describe("read path over a multipart frame", () => {
  test("list omits snippet and projects subject/from from cached columns", async () => {
    await insertRaw(MULTIPART, {
      subject: "Multipart hello",
      fromAddress: "sender@example.com",
    });
    const page = await listUserMailbox(db, {
      ...SCOPE,
      limit: 10,
      view: "all",
      priorities: TEST_VOCABULARY.priorities,
    });
    expect(page.items[0]!.snippet).toBeUndefined();
    expect(page.items[0]!.subject).toBe("Multipart hello");
    expect(page.items[0]!.from).toBe("sender@example.com");
  });

  test("the detail body is the text/plain alternative, not the html one", async () => {
    const id = await insertRaw(MULTIPART);
    const detail = await getMailboxMessage(db, { ...SCOPE, id });
    expect(detail!.body).toBe("Hello human, this is the readable text.");
    expect(detail!.subject).toBe("Multipart hello");
  });

  test("a multipart frame with no boundary in its body reads as an empty body", async () => {
    const id = await insertRaw(
      new TextEncoder().encode(
        [
          "From: sender@example.com",
          "To: user-1@acme.example",
          "Subject: Broken",
          'Content-Type: multipart/alternative; boundary="BOUND"',
          "",
          "no boundary delimiter anywhere in this body",
          "",
        ].join("\r\n"),
      ),
    );
    const detail = await getMailboxMessage(db, { ...SCOPE, id });
    expect(detail!.body).toBe("");
    expect(detail!.snippet).toBeUndefined();
    expect(detail!.subject).toBe("Broken");
  });
});
