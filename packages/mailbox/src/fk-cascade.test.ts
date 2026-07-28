// The control-plane FKs carry ON DELETE CASCADE: offboarding a tenant or a
// principal in the host's control plane carries the mailbox rows out with it —
// a database behavior, not a purge function someone has to remember to call.
import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { writeMailboxMessage } from "./write.js";
import { mailbox, principalMail } from "./schema.js";
import { withTestDb, seedScope } from "./test-helpers.js";
import type { MailboxDb } from "./db.js";

let db: MailboxDb;

beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, "acme", "user-1", "user-2");
  await seedScope(db, "globex", "user-3");
});

async function seed(tenantId: string, principalId: string): Promise<string> {
  const written = await writeMailboxMessage(db, {
    tenantId,
    principalId,
    address: `${principalId}@${tenantId}.example`,
    fromAddress: `agent@${tenantId}.example`,
    subject: "s",
    body: "b",
    // Triage materializes the `mailbox` row, so the cascade is asserted
    // through BOTH tables.
    priority: "high",
  });
  return written!.id;
}

async function mailCountFor(tenantId: string): Promise<number> {
  const rows = await db
    .select()
    .from(principalMail)
    .where(eq(principalMail.tenantId, tenantId));
  return rows.length;
}

async function mailboxCountFor(tenantId: string): Promise<number> {
  const rows = await db
    .select()
    .from(mailbox)
    .where(eq(mailbox.tenantId, tenantId));
  return rows.length;
}

describe("control-plane ON DELETE CASCADE", () => {
  test("deleting a tenant removes its mail and triage rows, nobody else's", async () => {
    await seed("acme", "user-1");
    await seed("acme", "user-2");
    await seed("globex", "user-3");

    await db.execute(sql`DELETE FROM "tenant" WHERE "id" = 'acme'`);

    expect(await mailCountFor("acme")).toBe(0);
    expect(await mailboxCountFor("acme")).toBe(0);
    expect(await mailCountFor("globex")).toBe(1);
    expect(await mailboxCountFor("globex")).toBe(1);
  });

  test("deleting a principal removes its mail and triage rows, nobody else's", async () => {
    await seed("acme", "user-1");
    await seed("acme", "user-2");

    await db.execute(sql`DELETE FROM "principal" WHERE "id" = 'user-1'`);

    const rows = await db
      .select({ principalId: principalMail.principalId })
      .from(principalMail)
      .where(eq(principalMail.tenantId, "acme"));
    expect(rows.map((r) => r.principalId)).toEqual(["user-2"]);
    const triage = await db
      .select({ principalId: mailbox.principalId })
      .from(mailbox)
      .where(eq(mailbox.tenantId, "acme"));
    expect(triage.map((r) => r.principalId)).toEqual(["user-2"]);
  });
});
