// The write boundary that stands in for the foreign key `principal_mail`
// deliberately does not have. A row written under a blank tenant or principal
// is not merely odd: every read and mutation in this package is scoped by
// equality on both columns, so the row is unreachable forever. These tests
// prove the refusal happens on the way in, and that the database stays clean.
import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { writeMailboxMessage, deliverInboxItems } from "./write.js";
import {
  enrichMailboxMessage,
  assignMailboxMessage,
} from "./mutations.js";
import { createMailboxPersist } from "./persist.js";
import { assertMailboxScope, MailboxScopeIdsSchema } from "./write.js";
import { buildMailFrame } from "./frame.js";
import { withTestDb, seedScope } from "./test-helpers.js";
import type { MailboxDb } from "./db.js";

let db: MailboxDb;

beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, "t1", "p1", "p2");
});

const BLANK = ["", " ", "\t", "\n", "   "] as const;

async function rowCount(): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM "mailbox"."principal_mail"`,
  );
  return rows[0]!.n;
}

function writeArgs(overrides: { tenantId: string; principalId: string }) {
  return {
    tenantId: overrides.tenantId,
    principalId: overrides.principalId,
    address: "p1@t1.example",
    fromAddress: "agent@t1.example",
    subject: "Hello",
    body: "World",
  };
}

describe("assertMailboxScope", () => {
  test("accepts ordinary identifiers", () => {
    expect(() =>
      assertMailboxScope({ tenantId: "acme", principalId: "user-1" }),
    ).not.toThrow();
  });

  test("rejects empty and whitespace-only ids, on either side", () => {
    for (const blank of BLANK) {
      expect(() =>
        assertMailboxScope({ tenantId: blank, principalId: "user-1" }),
      ).toThrow(RangeError);
      expect(() =>
        assertMailboxScope({ tenantId: "acme", principalId: blank }),
      ).toThrow(RangeError);
    }
  });

  test("does not trim on the caller's behalf: a padded id is a real, distinct id", () => {
    // Rewriting `" acme"` to `"acme"` would make the row unreachable by the
    // exact string the caller believes it wrote — the same failure the check
    // exists to prevent, just with an extra space.
    expect(() =>
      assertMailboxScope({ tenantId: " acme", principalId: "user-1" }),
    ).not.toThrow();
    const parsed = MailboxScopeIdsSchema({
      tenantId: " acme",
      principalId: "user-1",
    });
    expect(parsed).toEqual({ tenantId: " acme", principalId: "user-1" });
  });
});

describe("writeMailboxMessage rejects a blank scope", () => {
  test("throws RangeError and writes nothing", async () => {
    for (const blank of BLANK) {
      await expect(
        writeMailboxMessage(
          db,
          writeArgs({ tenantId: blank, principalId: "p1" }),
        ),
      ).rejects.toThrow(RangeError);
      await expect(
        writeMailboxMessage(
          db,
          writeArgs({ tenantId: "t1", principalId: blank }),
        ),
      ).rejects.toThrow(RangeError);
    }
    expect(await rowCount()).toBe(0);
  });
});

describe("deliverInboxItems rejects a blank scope", () => {
  function item(tenantId: string, principalId: string, externalId: string) {
    return {
      tenantId,
      principalId,
      address: "p1@t1.example",
      fromAddress: "agent@t1.example",
      subject: "Hello",
      body: "World",
      source: "test",
      externalId,
    };
  }

  test("refuses the whole batch before delivering any of it", async () => {
    // The good item is FIRST on purpose: a per-item check inside the loop
    // would have delivered it before reaching the bad one, and an adapter
    // retrying the batch would then deliver it twice.
    await expect(
      deliverInboxItems(db, [
        item("t1", "p1", "ok"),
        item("t1", "  ", "blank-principal"),
      ]),
    ).rejects.toThrow(RangeError);
    expect(await rowCount()).toBe(0);
  });

  test("delivers a batch whose scopes are all valid", async () => {
    const results = await deliverInboxItems(db, [
      item("t1", "p1", "a"),
      item("t1", "p2", "b"),
    ]);
    expect(results.every((r) => r.id !== null)).toBe(true);
    expect(await rowCount()).toBe(2);
  });
});

describe("enrich and assign reject a blank scope", () => {
  test("both throw RangeError", async () => {
    const written = await writeMailboxMessage(
      db,
      writeArgs({ tenantId: "t1", principalId: "p1" }),
    );
    const id = written!.id;
    await expect(
      enrichMailboxMessage(
        db,
        { tenantId: "", principalId: "p1", id },
        {
          priority: "high",
        },
      ),
    ).rejects.toThrow(RangeError);
    await expect(
      enrichMailboxMessage(
        db,
        { tenantId: "t1", principalId: " ", id },
        {
          priority: "high",
        },
      ),
    ).rejects.toThrow(RangeError);
    await expect(
      assignMailboxMessage(db, { tenantId: " ", principalId: "p1", id }, "p2"),
    ).rejects.toThrow(RangeError);
    await expect(
      assignMailboxMessage(db, { tenantId: "t1", principalId: "", id }, "p2"),
    ).rejects.toThrow(RangeError);
  });
});

describe("the persist seam refuses a blank tenant from the host's authorizer", () => {
  test("no rows are written, and the upstream persist still stands", async () => {
    const raw = buildMailFrame({
      from: "ins_agent@t1.example",
      to: "usr_p1@t1.example",
      subject: "Hi",
      body: "there",
      messageId: "<m1@t1.example>",
    });
    let upstreamCalls = 0;
    const persist = createMailboxPersist(db, {
      upstream: async () => {
        upstreamCalls += 1;
        return "upstream-ok" as const;
      },
      // A host authorizer that hands back a blank tenant. With a foreign key
      // this would have been the database's refusal; here it is ours.
      authorizeSender: () => ({ tenantId: "   ", domain: "t1.example" }),
    });

    const result = await persist({
      senderAddress: "ins_agent@t1.example",
      recipients: ["usr_p1@t1.example"],
      raw,
    });

    // Dual-write independence is preserved: the mailbox refusal is logged,
    // never propagated to a caller whose upstream persist already committed.
    expect(result).toBe("upstream-ok");
    expect(upstreamCalls).toBe(1);
    expect(await rowCount()).toBe(0);
  });
});
