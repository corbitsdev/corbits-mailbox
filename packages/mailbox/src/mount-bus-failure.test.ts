// `bus.publish` runs AFTER the write
// commits, so a throwing host bus must never surface as a 500 the client will
// retry forever — the same invariant `writeMailboxMessage` already documents.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { mountMailbox } from "./mount.js";
import { writeMailboxMessage } from "./write.js";
import { withTestDb, seedScope, TEST_VOCABULARY } from "./test-helpers.js";

const P = { tenantId: "tbus", principalId: "pbus" };
const failingBus = {
  publish() {
    throw new Error("broker down");
  },
  subscribe() {
    return () => {};
  },
};

async function seed(db: Awaited<ReturnType<typeof withTestDb>>) {
  await seedScope(db, P.tenantId, P.principalId);
  const written = await writeMailboxMessage(db, {
    ...P,
    address: "pbus@t.example",
    fromAddress: "a@t.example",
    subject: "s",
    body: "b",
  });
  return written!.id;
}

describe("a failing host event bus never fails an applied mutation", () => {
  test("single-message mutation still answers 200", async () => {
    const db = await withTestDb();
    const id = await seed(db);
    const app = mountMailbox(new Hono(), {
      vocabulary: TEST_VOCABULARY,
      db,
      bus: failingBus,
      resolvePrincipal: () => P,
    });
    const res = await app.request(`/me/inbox/${id}/read`, { method: "POST" });
    const rows = await db.execute<{ read_at: string | null }>(
      sql`SELECT read_at FROM "mailbox"."mailbox" WHERE id = ${id}`,
    );
    // The row was already mutated; the caller must not be told it failed.
    expect(rows[0]!.read_at).not.toBeNull();
    expect(res.status).toBe(200);
  });

  test("bulk mutation still answers 200", async () => {
    const db = await withTestDb();
    const id = await seed(db);
    const app = mountMailbox(new Hono(), {
      vocabulary: TEST_VOCABULARY,
      db,
      bus: failingBus,
      resolvePrincipal: () => P,
    });
    const res = await app.request("/me/inbox/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "trash", ids: [id] }),
    });
    const rows = await db.execute<{ trashed_at: string | null }>(
      sql`SELECT trashed_at FROM "mailbox"."mailbox" WHERE id = ${id}`,
    );
    expect(rows[0]!.trashed_at).not.toBeNull();
    expect(res.status).toBe(200);
  });
});
