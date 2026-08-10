// `CREATE TABLE IF NOT EXISTS` matches on the table NAME and nothing else. A
// host that already owns a table called `mailbox` or `principal_mail` gets a
// silent no-op, a ledger row saying the migration applied, and from then on
// every read in this package decoding ITS columns through OUR codec. Nothing
// errors; the data is just wrong.
//
// Each case here plants exactly that situation — a pre-existing table with a
// divergent column type, and one with a column missing outright — and asserts
// the boot is REJECTED, and that the rejection leaves no ledger row behind to
// make the next boot skip the check.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { runMailboxMigrations } from "./migrations.js";
import {
  expectedColumnTypes,
  SchemaTypeMismatchError,
} from "./schema-check.js";
import { createHostControlPlane, TEST_DATABASE_URL } from "./test-helpers.js";

const admin = postgres(TEST_DATABASE_URL, { onnotice: () => {} });

beforeAll(async () => {
  await createHostControlPlane(drizzle(admin));
});

afterAll(async () => {
  // Leave the schema rebuilt for whatever suite runs after this one — the
  // planted conflicting table has to go first, or the rebuild rejects too.
  await admin.unsafe(`DROP SCHEMA IF EXISTS "mailbox" CASCADE`);
  await runMailboxMigrations(drizzle(admin));
  await admin.end();
});

function handle() {
  const client = postgres(TEST_DATABASE_URL, { onnotice: () => {} });
  return { client, db: drizzle(client) };
}

// The tables are hard-qualified to the "mailbox" schema, so a pre-existing
// host table can only shadow ours from INSIDE that schema: each case drops it,
// recreates it empty, and plants the conflicting table there.
async function inFreshSchema(
  _name: string,
  fn: (h: ReturnType<typeof handle>) => Promise<void>,
): Promise<void> {
  await admin.unsafe(`DROP SCHEMA IF EXISTS "mailbox" CASCADE`);
  await admin.unsafe(`CREATE SCHEMA "mailbox"`);
  const h = handle();
  try {
    await fn(h);
  } finally {
    await h.client.end();
  }
}

async function countOf(query: string): Promise<number> {
  const rows = (await admin.unsafe(query)) as unknown as { n: number }[];
  return rows[0]!.n;
}

/** The ledger row count, or 0 when the ledger table itself does not exist. */
async function ledgerRows(schema: string): Promise<number> {
  const exists = await countOf(
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = '${schema}'
        AND table_name = 'corbits_mailbox_migrations'`,
  );
  if (exists === 0) return 0;
  return countOf(
    `SELECT count(*)::int AS n FROM "${schema}"."corbits_mailbox_migrations"`,
  );
}

/**
 * The error `runMailboxMigrations` rejected with. A boot that SUCCEEDS is the
 * failure every case below is written to catch, so it must not slip through as
 * an `undefined` that the assertions then read properties off.
 */
async function bootFailure(promise: Promise<void>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the boot to be rejected, but it succeeded");
}

describe("expectedColumnTypes", () => {
  test("is derived from the drizzle tables, covering both of them", () => {
    const expected = expectedColumnTypes();
    const tables = new Set(expected.map((e) => e.table));
    expect(tables).toEqual(new Set(["principal_mail", "mailbox"]));
  });

  test("expects zoneless timestamps and text ids on every relevant column", () => {
    const byKey = new Map(
      expectedColumnTypes().map((e) => [`${e.table}.${e.column}`, e.dataType]),
    );
    // The two conventions this package just adopted, asserted from the
    // derivation rather than from the DDL — so reverting either the schema or
    // the migration on its own is caught here as well as by the parity suite.
    for (const key of [
      "principal_mail.created_at",
      "mailbox.read_at",
      "mailbox.archived_at",
      "mailbox.trashed_at",
    ]) {
      expect(byKey.get(key)).toBe("timestamp without time zone");
    }
    expect(byKey.get("principal_mail.id")).toBe("text");
    expect(byKey.get("mailbox.id")).toBe("text");
    expect(byKey.get("principal_mail.raw")).toBe("bytea");
    expect(byKey.get("principal_mail.refs")).toBe("jsonb");
  });
});

describe("boot against a host table this package did not create", () => {
  test("a fresh, correct database boots and records the migration", async () => {
    await inFreshSchema("mbx_check_ok", async ({ db }) => {
      await runMailboxMigrations(db);
      expect(await ledgerRows("mailbox")).toBe(1);
    });
  });

  test("rejects a pre-existing table whose column TYPE diverges", async () => {
    const schema = "mailbox";
    await inFreshSchema(schema, async ({ db }) => {
      // The host's own `principal_mail`: same name, `created_at` still a
      // `timestamptz` — the exact type this package just moved off, and the one
      // whose difference is invisible to every query until a non-UTC host
      // serves the wrong page.
      await admin.unsafe(`
        CREATE TABLE "${schema}"."principal_mail" (
          "id" text PRIMARY KEY,
          "tenant_id" text NOT NULL,
          "principal_id" text NOT NULL,
          "address" text NOT NULL,
          "direction" text NOT NULL,
          "raw" bytea NOT NULL,
          "subject" text,
          "from_address" text,
          "message_key" text,
          "refs" jsonb,
          "created_at" timestamptz NOT NULL DEFAULT now()
        )`);
      const failure = await bootFailure(runMailboxMigrations(db));
      expect(failure).toBeInstanceOf(SchemaTypeMismatchError);
      expect((failure as SchemaTypeMismatchError).mismatches).toEqual([
        "principal_mail.created_at is timestamp with time zone, " +
          "expected timestamp without time zone",
      ]);
    });
    // THE POINT: the boot was rejected inside the migration's own transaction,
    // so the ledger row rolled back with it. Had it been recorded, the next
    // boot would skip the migration entirely and sail past the mismatch.
    expect(await ledgerRows(schema)).toBe(0);
  });

  test("rejects a pre-existing table with a column MISSING outright", async () => {
    const schema = "mailbox";
    await inFreshSchema(schema, async ({ db }) => {
      // A host `principal_mail` carrying the scope and the frame but none of
      // the cached header columns. Nothing errors on such a schema: `subject`
      // and `refs` are read through the codec, so every message would just
      // quietly lose its "Related" row and fall back to the frame for its
      // subject.
      //
      // Both missing columns are ones NO index covers — see the case below for
      // why that distinction matters.
      await admin.unsafe(`
        CREATE TABLE "${schema}"."principal_mail" (
          "id" text PRIMARY KEY,
          "tenant_id" text NOT NULL,
          "principal_id" text NOT NULL,
          "address" text NOT NULL,
          "direction" text NOT NULL,
          "raw" bytea NOT NULL,
          "from_address" text,
          "message_key" text,
          "created_at" timestamp NOT NULL DEFAULT now()
        )`);
      const failure = await bootFailure(runMailboxMigrations(db));
      expect(failure).toBeInstanceOf(SchemaTypeMismatchError);
      expect((failure as SchemaTypeMismatchError).mismatches).toEqual([
        "principal_mail.subject is missing (expected text)",
        "principal_mail.refs is missing (expected jsonb)",
      ]);
    });
    expect(await ledgerRows(schema)).toBe(0);
  });

  test("a missing INDEXED column is rejected earlier still, by the DDL itself", async () => {
    // Not every missing column reaches the schema check: the migration's own
    // `CREATE INDEX IF NOT EXISTS` runs first and Postgres answers 42703 for a
    // column that is not there. That is a perfectly good rejection — it is
    // loud, it is inside the same transaction, and it leaves no ledger row —
    // but it is NOT a `SchemaTypeMismatchError`, and a host catching only that
    // type would miss it. Pinned here so the difference is documented rather
    // than discovered.
    const schema = "mailbox";
    await inFreshSchema(schema, async ({ db }) => {
      await admin.unsafe(`
        CREATE TABLE "${schema}"."mailbox" (
          "id" text PRIMARY KEY,
          "tenant_id" text NOT NULL,
          "principal_id" text NOT NULL,
          "read_at" timestamp,
          "archived_at" timestamp,
          "trashed_at" timestamp,
          "priority" text,
          "classification" text
        )`);
      const failure = await bootFailure(runMailboxMigrations(db));
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(SchemaTypeMismatchError);
      expect(failure.message).toContain(
        "mailbox_tenant_id_principal_id_status_idx",
      );
    });
    expect(await ledgerRows(schema)).toBe(0);
  });

  test("names every mismatch at once rather than only the first", async () => {
    const schema = "mailbox";
    await inFreshSchema(schema, async ({ db }) => {
      await admin.unsafe(`
        CREATE TABLE "${schema}"."mailbox" (
          "id" uuid PRIMARY KEY,
          "tenant_id" text NOT NULL,
          "principal_id" text NOT NULL,
          "read_at" timestamptz,
          "archived_at" timestamp,
          "trashed_at" timestamp,
          "priority" text,
          "classification" text,
          "status" text,
          "assignee" text
        )`);
      const failure = (await bootFailure(
        runMailboxMigrations(db),
      )) as SchemaTypeMismatchError;
      expect(failure.mismatches).toEqual([
        "mailbox.id is uuid, expected text",
        "mailbox.read_at is timestamp with time zone, " +
          "expected timestamp without time zone",
      ]);
      // The message is what a host operator actually sees, so it has to say
      // what to do about it, not just what is wrong.
      expect(failure.message).toContain("CREATE TABLE IF NOT EXISTS");
      expect(failure.message).toContain("Rename or move the conflicting table");
    });
    expect(await ledgerRows(schema)).toBe(0);
  });

  test("a rejected boot leaves the NEXT boot still rejecting", async () => {
    const schema = "mailbox";
    await inFreshSchema(schema, async ({ db }) => {
      await admin.unsafe(`
        CREATE TABLE "${schema}"."mailbox" (
          "id" text PRIMARY KEY,
          "tenant_id" text NOT NULL,
          "principal_id" text NOT NULL,
          "read_at" timestamptz,
          "archived_at" timestamp,
          "trashed_at" timestamp,
          "priority" text,
          "classification" text,
          "status" text,
          "assignee" text
        )`);
      await expect(runMailboxMigrations(db)).rejects.toThrow(
        SchemaTypeMismatchError,
      );
      // No "it already applied, skip it" shortcut on the second attempt: the
      // ledger is empty, so the check runs again and fails again. A guard that
      // only fires on the first boot is one a restart disables.
      await expect(runMailboxMigrations(db)).rejects.toThrow(
        SchemaTypeMismatchError,
      );
      expect(await ledgerRows(schema)).toBe(0);
      // And the sound table was rolled back too — a partially-built schema
      // would be its own quiet trap.
      const rows = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM information_schema.tables
             WHERE table_schema = 'mailbox'
               AND table_name = 'principal_mail'`,
      );
      expect(rows[0]!.n).toBe(0);
    });
  });
});
