// The live consequence of the multipart body extraction: externally delivered
// mail arrives as multipart/alternative, so both the list snippet and the
// detail body are projected from a frame the read path has to walk, not just
// slice after its headers.
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

async function insertRaw(raw: Uint8Array): Promise<string> {
  const [row] = await db
    .insert(principalMail)
    .values({
      tenantId: SCOPE.tenantId,
      principalId: SCOPE.principalId,
      address: "user-1@acme.example",
      direction: "inbound",
      raw,
    })
    .returning({ id: principalMail.id });
  return row!.id;
}

describe("read path over a multipart frame", () => {
  test("the list snippet is the readable text, not the MIME envelope", async () => {
    await insertRaw(MULTIPART);
    const page = await listUserMailbox(db, {
      ...SCOPE,
      limit: 10,
      view: "all",
      priorities: TEST_VOCABULARY.priorities,
    });
    expect(page.items[0]!.snippet).toBe(
      "Hello human, this is the readable text.",
    );
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
