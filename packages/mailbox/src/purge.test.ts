// The control-plane FKs cascade on tenant/principal delete, but hosts that
// soft-delete their control-plane rows never fire them — the exported purges
// exist for those hosts. These tests hold them to what the cascade would have
// done: everything for that tenant, nothing belonging to anyone else,
// whatever view the rows are in.
import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { purgeTenantMailbox, purgePrincipalMailbox } from "./purge.js";
import { writeMailboxMessage } from "./write.js";
import {
  trashMailboxMessage,
  archiveMailboxMessage,
} from "./mutations.js";
import { mailbox, principalMail } from "./schema.js";
import { withTestDb, seedScope } from "./test-helpers.js";
import type { MailboxDb } from "./db.js";

let db: MailboxDb;

beforeEach(async () => {
  db = await withTestDb();
});

async function seed(
  tenantId: string,
  principalId: string,
  subject: string,
): Promise<string> {
  await seedScope(db, tenantId, principalId);
  const written = await writeMailboxMessage(db, {
    tenantId,
    principalId,
    address: `${principalId}@${tenantId}.example`,
    fromAddress: `agent@${tenantId}.example`,
    subject,
    body: "body",
  });
  return written!.id;
}

async function countFor(tenantId: string, principalId?: string) {
  const rows = await db
    .select({ id: principalMail.id })
    .from(principalMail)
    .where(
      principalId === undefined
        ? eq(principalMail.tenantId, tenantId)
        : and(
            eq(principalMail.tenantId, tenantId),
            eq(principalMail.principalId, principalId),
          ),
    );
  return rows.length;
}

async function countMailboxFor(tenantId: string, principalId?: string) {
  const rows = await db
    .select({ id: mailbox.id })
    .from(mailbox)
    .where(
      principalId === undefined
        ? eq(mailbox.tenantId, tenantId)
        : and(
            eq(mailbox.tenantId, tenantId),
            eq(mailbox.principalId, principalId),
          ),
    );
  return rows.length;
}

describe("purgeTenantMailbox", () => {
  test("deletes every row for the tenant and returns how many", async () => {
    await seed("acme", "user-1", "a");
    await seed("acme", "user-2", "b");
    await seed("globex", "user-1", "c");

    expect(await purgeTenantMailbox(db, "acme")).toBe(2);
    expect(await countFor("acme")).toBe(0);
    // The other tenant is untouched — an FK cascade would not have reached it
    // either, and a purge that did would be a cross-tenant data loss.
    expect(await countFor("globex")).toBe(1);
  });

  test("reaches archived and trashed rows, not just the active inbox", async () => {
    const archived = await seed("acme", "user-1", "archived");
    const trashed = await seed("acme", "user-1", "trashed");
    await seed("acme", "user-1", "active");
    await archiveMailboxMessage(db, {
      tenantId: "acme",
      principalId: "user-1",
      id: archived,
    });
    await trashMailboxMessage(db, {
      tenantId: "acme",
      principalId: "user-1",
      id: trashed,
    });

    // An offboarded tenant's trash is as much their data as their inbox.
    expect(await purgeTenantMailbox(db, "acme")).toBe(3);
    expect(await countFor("acme")).toBe(0);
  });

  test("clears the tenant's mailbox rows as well as its principal_mail rows", async () => {
    const archived = await seed("acme", "user-1", "archived");
    await seed("acme", "user-1", "untouched");
    await archiveMailboxMessage(db, {
      tenantId: "acme",
      principalId: "user-1",
      id: archived,
    });
    // Precondition: every message has its eagerly-created management row.
    expect(await countMailboxFor("acme")).toBe(2);

    // The purge returns MESSAGES deleted, not rows across both tables.
    expect(await purgeTenantMailbox(db, "acme")).toBe(2);
    expect(await countFor("acme")).toBe(0);
    expect(await countMailboxFor("acme")).toBe(0);
  });

  test("purging a tenant with no mail is 0, not an error", async () => {
    expect(await purgeTenantMailbox(db, "nobody")).toBe(0);
  });

  test("refuses a blank tenantId rather than deleting leaked rows", async () => {
    await seed("acme", "user-1", "a");
    for (const blank of ["", " ", "\t"]) {
      await expect(purgeTenantMailbox(db, blank)).rejects.toThrow(RangeError);
    }
    expect(await countFor("acme")).toBe(1);
  });

  test("runs inside a caller's transaction, so a tenant delete can be atomic", async () => {
    await seed("acme", "user-1", "a");
    // The whole point of taking the `db` handle: a host offboarding a tenant
    // passes its transaction and the mailbox purge commits or rolls back with
    // the control-plane delete, exactly as a cascade would have.
    await expect(
      db.transaction(async (tx) => {
        expect(
          await purgeTenantMailbox(tx as unknown as MailboxDb, "acme"),
        ).toBe(1);
        throw new Error("host rolled back");
      }),
    ).rejects.toThrow("host rolled back");
    expect(await countFor("acme")).toBe(1);
  });
});

describe("purgePrincipalMailbox", () => {
  test("deletes one principal's mail and leaves the tenant's other mailboxes", async () => {
    await seed("acme", "user-1", "a");
    await seed("acme", "user-1", "b");
    await seed("acme", "user-2", "c");

    expect(
      await purgePrincipalMailbox(db, {
        tenantId: "acme",
        principalId: "user-1",
      }),
    ).toBe(2);
    expect(await countFor("acme", "user-1")).toBe(0);
    expect(await countFor("acme", "user-2")).toBe(1);
  });

  test("clears the principal's mailbox rows and leaves another principal's", async () => {
    const mine = await seed("acme", "user-1", "a");
    const theirs = await seed("acme", "user-2", "b");
    for (const [principalId, id] of [
      ["user-1", mine],
      ["user-2", theirs],
    ] as const) {
      await archiveMailboxMessage(db, { tenantId: "acme", principalId, id });
    }
    expect(await countMailboxFor("acme")).toBe(2);

    expect(
      await purgePrincipalMailbox(db, {
        tenantId: "acme",
        principalId: "user-1",
      }),
    ).toBe(1);
    expect(await countMailboxFor("acme", "user-1")).toBe(0);
    expect(await countMailboxFor("acme", "user-2")).toBe(1);
  });

  test("is tenant-scoped: the same principal id in another tenant survives", async () => {
    await seed("acme", "user-1", "a");
    await seed("globex", "user-1", "b");

    expect(
      await purgePrincipalMailbox(db, {
        tenantId: "acme",
        principalId: "user-1",
      }),
    ).toBe(1);
    expect(await countFor("globex", "user-1")).toBe(1);
  });

  test("refuses a blank scope on either side", async () => {
    await expect(
      purgePrincipalMailbox(db, { tenantId: "", principalId: "user-1" }),
    ).rejects.toThrow(RangeError);
    await expect(
      purgePrincipalMailbox(db, { tenantId: "acme", principalId: "  " }),
    ).rejects.toThrow(RangeError);
  });
});
