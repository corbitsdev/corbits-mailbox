import { describe, expect, test } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  applyMailboxMigrations,
  runMailboxMigrations,
} from "../src/migrations.js";
import { principalMail } from "../src/schema.js";
import { SchemaTypeMismatchError } from "../src/schema-check.js";
import {
  createMailboxDb,
  dbConfigFromUrl,
  TEST_DATABASE_URL,
  migrationSandbox,
} from "./helpers.js";

const { admin, dropMailboxSchema, fromEmpty } = migrationSandbox();

describe("runMailboxMigrations", () => {
  test("points the FKs at the host schema it is given", async () => {
    await fromEmpty(async ({ client }) => {
      await admin.unsafe(`DROP SCHEMA IF EXISTS "host_cp" CASCADE`);
      await admin.unsafe(`CREATE SCHEMA "host_cp"`);
      await admin.unsafe(`CREATE TABLE "host_cp"."tenant" ("id" text PRIMARY KEY)`);
      await admin.unsafe(`CREATE TABLE "host_cp"."principal" ("id" text PRIMARY KEY)`);
      try {
        await runMailboxMigrations(dbConfigFromUrl(TEST_DATABASE_URL), {
          schema: "host_cp",
        });
        const targets = await client<{ target: string }[]>`
          SELECT DISTINCT confrelid::regclass::text AS target
            FROM pg_constraint
           WHERE contype = 'f'
             AND connamespace = 'mailbox'::regnamespace
             AND confrelid::regclass::text NOT LIKE 'mailbox.%'
           ORDER BY target`;
        expect(targets.map((row) => row.target)).toEqual([
          "host_cp.principal",
          "host_cp.tenant",
        ]);
      } finally {
        await dropMailboxSchema();
        await admin.unsafe(`DROP SCHEMA "host_cp" CASCADE`);
      }
    });
  });

  test("refuses an empty schema name", async () => {
    await expect(
      runMailboxMigrations(dbConfigFromUrl(TEST_DATABASE_URL), { schema: "" }),
    ).rejects.toThrow("schema name must not be empty");
  });

  test("builds the full schema from an empty database", async () => {
    await fromEmpty(async ({ db }) => {
      await applyMailboxMigrations(db, "public");

      // The mail plane reads 1-1 with Interchange's `session_mail`: the message
      // as delivered, plus the cached header columns and this package's scope.
      // Nothing mutable is on it.
      const mailColumns = await db.execute<{ column_name: string }>(
        sql`SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'mailbox' AND table_name = 'principal_mail'
            ORDER BY column_name`,
      );
      expect(mailColumns.map((c) => c.column_name)).toEqual([
        "address",
        "created_at",
        "direction",
        "flags",
        "folder",
        "from_address",
        "id",
        "in_reply_to",
        "message_id",
        "message_key",
        "modseq",
        "principal_id",
        "raw",
        "references",
        "refs",
        "subject",
        "tenant_id",
        "to_addresses",
        "uid",
      ]);

      // The pre-native management layer ("mailbox"."mailbox") is gone.
      const stateTable = await db.execute<{ exists: boolean }>(
        sql`SELECT EXISTS (SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'mailbox' AND table_name = 'mailbox') AS exists`,
      );
      expect(stateTable[0]?.exists).toBe(false);

      const mailIndexes = await db.execute<{ indexname: string }>(
        sql`SELECT indexname FROM pg_indexes
            WHERE schemaname = 'mailbox' AND tablename = 'principal_mail'
            ORDER BY indexname`,
      );
      // The mail plane keeps exactly five access paths: the dedupe constraint,
      // the keyset the default page seeks on, and the three the thread read
      // adds — the msg-id lookup, the GIN index serving the `refs` containment
      // filter, and the thread's own oldest-first keyset.
      // The schema.ts parity suite below holds schema.ts to this same list.
      expect(mailIndexes.map((i) => i.indexname)).toEqual([
        "principal_mail_pkey",
        "principal_mail_refs_idx",
        "principal_mail_tenant_id_principal_id_created_at_id_asc_idx",
        "principal_mail_tenant_id_principal_id_created_at_id_idx",
        "principal_mail_tenant_id_principal_id_message_id_idx",
        "principal_mail_tenant_id_principal_id_message_key_idx",
      ]);

      // The dedupe index is partial: NULL-key external mail is unconstrained.
      const partial = await db.execute<{ indexdef: string }>(
        sql`SELECT indexdef FROM pg_indexes WHERE schemaname = 'mailbox'
            AND indexname = 'principal_mail_tenant_id_principal_id_message_key_idx'`,
      );
      expect(partial[0]?.indexdef).toContain("WHERE (message_key IS NOT NULL)");
    });
  });

  test("0005 leaves uid and modseq NOT NULL: every write path is the native store now", async () => {
    await fromEmpty(async ({ db }) => {
      await applyMailboxMigrations(db, "public");
      const rows = await db.execute<{ column_name: string; is_nullable: string }>(
        sql`SELECT column_name, is_nullable FROM information_schema.columns
            WHERE table_schema = 'mailbox' AND table_name = 'principal_mail'
              AND column_name IN ('uid', 'modseq')
            ORDER BY column_name`,
      );
      expect(rows.map((r) => [r.column_name, r.is_nullable])).toEqual([
        ["modseq", "NO"],
        ["uid", "NO"],
      ]);
    });
  });

  test("the keyset index matches the list query's ORDER BY exactly", async () => {
    await fromEmpty(async ({ db }) => {
      await applyMailboxMigrations(db, "public");
      const [row] = await db.execute<{ indexdef: string }>(
        sql`SELECT indexdef FROM pg_indexes WHERE schemaname = 'mailbox'
            AND indexname = 'principal_mail_tenant_id_principal_id_created_at_id_idx'`,
      );
      // Carrying id and matching DESC is what turns the row-value seek into an
      // Index Cond instead of a Filter plus an Incremental Sort per page.
      expect(row?.indexdef).toContain(
        "(tenant_id, principal_id, created_at DESC, id DESC)",
      );
    });
  });

  test("principal_mail's FKs are exactly the control-plane pair, both CASCADE", async () => {
    // The FKs are the reason there is no separate-database mode: a row can
    // only belong to a tenant and principal the host knows, and offboarding
    // either carries the mailbox rows out with it.
    await fromEmpty(async ({ db }) => {
      await applyMailboxMigrations(db, "public");
      const rows = await db.execute<{
        constraint_name: string;
        table_name: string;
        delete_rule: string;
      }>(sql`
        SELECT tc.constraint_name, ccu.table_name, rc.delete_rule
          FROM information_schema.table_constraints tc
          JOIN information_schema.referential_constraints rc
            ON rc.constraint_name = tc.constraint_name
           AND rc.constraint_schema = tc.table_schema
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = tc.constraint_name
           AND ccu.constraint_schema = tc.table_schema
         WHERE tc.table_schema = 'mailbox' AND tc.table_name = 'principal_mail'
           AND tc.constraint_type = 'FOREIGN KEY'
         ORDER BY tc.constraint_name
      `);
      expect(
        rows.map((r) => [r.constraint_name, r.table_name, r.delete_rule]),
      ).toEqual([
        ["principal_mail_principal_id_principal_id_fk", "principal", "CASCADE"],
        ["principal_mail_tenant_id_tenant_id_fk", "tenant", "CASCADE"],
      ]);
    });
  });

  test("builds into the mailbox schema regardless of the session search_path", async () => {
    // The DDL is schema-qualified end to end, so a host whose connection
    // selects some other search_path still gets (and finds) this package's
    // tables in "mailbox", never a copy in whatever schema is current.
    await dropMailboxSchema();
    await admin.unsafe(`DROP SCHEMA IF EXISTS mbx_elsewhere CASCADE`);
    await admin.unsafe(`CREATE SCHEMA mbx_elsewhere`);
    const client = postgres(TEST_DATABASE_URL, {
      onnotice: () => {},
      connection: { search_path: "mbx_elsewhere" },
    });
    try {
      await applyMailboxMigrations(drizzle(client), "public");
      const found = await admin.unsafe(
        `SELECT to_regclass('mailbox.principal_mail') AS t,
                to_regclass('mbx_elsewhere.principal_mail') AS stray`,
      );
      expect(found[0]!.t).not.toBeNull();
      expect(found[0]!.stray).toBeNull();
    } finally {
      await client.end();
      await admin.unsafe(`DROP SCHEMA IF EXISTS mbx_elsewhere CASCADE`);
    }
  });

  test("closing the handle it opened drains the pool", async () => {
    const { db, close } = createMailboxDb(TEST_DATABASE_URL);
    await applyMailboxMigrations(db, "public");
    await close();
    // A closed pool refuses further work rather than hanging the process.
    expect(async () => {
      await db.execute(sql`SELECT 1`);
    }).toThrow();
  });
});

// The drizzle table object is a public export, so a host can point
// `drizzle-kit push`/`generate` at it. If it declares an index the migrations
// do not create, or with a different column order, that host's schema silently
// diverges from the one this package's queries were planned against.
describe("schema.ts vs. the DDL applyMailboxMigrations actually creates", () => {
  /** `name USING method(col asc, col desc)` plus `unique`/`partial` markers. */
  type IndexDescriptor = string;

  function declaredIndexes(): IndexDescriptor[] {
    return getTableConfig(principalMail)
      .indexes.map((index) => {
        const config = index.config;
        const columns = config.columns
          .map((column) => {
            // An expression index has no `.name`; fail rather than compare it
            // as blank.
            const name = (column as { name?: string }).name;
            if (name === undefined) {
              throw new Error(
                `index ${config.name} uses an expression column this parity check cannot canonicalize`,
              );
            }
            const order =
              (column as { indexConfig?: { order?: string } }).indexConfig
                ?.order ?? "asc";
            return `${name} ${order}`;
          })
          .join(", ");
        const flags = [
          config.unique === true ? "unique" : null,
          config.where !== undefined ? "partial" : null,
        ].filter((flag) => flag !== null);
        const suffix = flags.length > 0 ? ` [${flags.join(" ")}]` : "";
        // The access method matters: `refs @> …` is only servable by GIN.
        const method = (config as { method?: string }).method ?? "btree";
        return `${config.name} USING ${method}(${columns})${suffix}`;
      })
      .sort();
  }

  // `pg_get_indexdef` renders `CREATE [UNIQUE] INDEX <name> ON <tbl> USING
  // <method> (<cols>)[ WHERE (<pred>)]`, with DESC spelled out and ASC implicit.
  function canonicalizeIndexDef(def: string): IndexDescriptor {
    const match =
      /^CREATE (UNIQUE )?INDEX (\S+) ON \S+ USING (\S+) \((.*?)\)( WHERE .*)?$/.exec(
        def,
      );
    if (match === null) throw new Error(`unparsed index definition: ${def}`);
    const [, unique, name, method, columnList, where] = match;
    const columns = columnList!
      .split(", ")
      .map((column) => {
        const desc = / DESC$/.test(column);
        const bare = column.replace(/ (DESC|ASC)$/, "").replace(/ NULLS.*$/, "");
        return `${bare} ${desc ? "desc" : "asc"}`;
      })
      .join(", ");
    const flags = [
      unique !== undefined ? "unique" : null,
      where !== undefined ? "partial" : null,
    ].filter((flag) => flag !== null);
    const suffix = flags.length > 0 ? ` [${flags.join(" ")}]` : "";
    return `${name} USING ${method}(${columns})${suffix}`;
  }

  test("principal_mail: declares exactly the indexes the live table has, in the same column order", async () => {
    await fromEmpty(async ({ db }) => {
      await applyMailboxMigrations(db, "public");
      const rows = await db.execute<{ indexdef: string }>(sql`
        SELECT indexdef FROM pg_indexes
         WHERE schemaname = 'mailbox'
           AND tablename = 'principal_mail'
           AND indexname <> 'principal_mail_pkey'
      `);
      const live = rows.map((row) => canonicalizeIndexDef(row.indexdef)).sort();
      expect(declaredIndexes()).toEqual(live);
    });
  });
});

// `CREATE TABLE IF NOT EXISTS` matches on the table NAME only. A host that
// already owns a `principal_mail` would get a silent no-op and every read
// decoding ITS columns through OUR codec. Each case plants such a table and
// asserts the boot is rejected with nothing it ran left applied.
describe("boot against a host table this package did not create", () => {
  /** Whether the rejected boot left the table it creates behind. */
  async function stateTableExists(): Promise<boolean> {
    const [row] = await admin<{ exists: boolean }[]>`
      SELECT to_regclass('"mailbox"."mailbox_state"') IS NOT NULL AS exists`;
    return row!.exists;
  }

  /** Throws if the boot SUCCEEDS, rather than yielding an `undefined`. */
  async function bootFailure(promise: Promise<void>): Promise<Error> {
    try {
      await promise;
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected the boot to be rejected, but it succeeded");
  }

  /** Plants a host `principal_mail` with the given column DDL. */
  async function plantPrincipalMail(columns: string): Promise<void> {
    await admin.unsafe(`CREATE SCHEMA "mailbox"`);
    await admin.unsafe(`CREATE TABLE "mailbox"."principal_mail" (${columns})`);
  }

  const BASE_COLUMNS = `
    "id" text PRIMARY KEY,
    "tenant_id" text NOT NULL,
    "principal_id" text NOT NULL,
    "address" text NOT NULL,
    "direction" text NOT NULL,
    "raw" bytea NOT NULL,
    "from_address" text,
    "message_key" text,
    "refs" jsonb`;

  test("rejects a pre-existing table whose column TYPE diverges", async () => {
    await fromEmpty(async ({ db }) => {
      // `created_at` still a `timestamptz`: invisible to every query until a
      // non-UTC host serves the wrong page.
      await plantPrincipalMail(`${BASE_COLUMNS},
        "subject" text,
        "created_at" timestamptz NOT NULL DEFAULT now()`);
      const failure = await bootFailure(applyMailboxMigrations(db, "public"));
      expect(failure).toBeInstanceOf(SchemaTypeMismatchError);
      expect((failure as SchemaTypeMismatchError).mismatches).toEqual([
        "principal_mail.created_at is timestamp with time zone, " +
          "expected timestamp without time zone",
      ]);
      // Rejected inside the migrations' transaction, so everything rolled back.
      expect(await stateTableExists()).toBe(false);
    });
  });

  test("rejects a pre-existing table with a column MISSING outright", async () => {
    await fromEmpty(async ({ db }) => {
      // No `subject`, a column no index covers. `refs` stays present: it is
      // GIN-indexed, so its absence would be rejected by the DDL, not this check.
      await plantPrincipalMail(`${BASE_COLUMNS},
        "created_at" timestamp NOT NULL DEFAULT now()`);
      const failure = await bootFailure(applyMailboxMigrations(db, "public"));
      expect(failure).toBeInstanceOf(SchemaTypeMismatchError);
      expect((failure as SchemaTypeMismatchError).mismatches).toEqual([
        "principal_mail.subject is missing (expected text)",
      ]);
      expect(await stateTableExists()).toBe(false);
    });
  });

  test("a rejected boot leaves the NEXT boot still rejecting", async () => {
    await fromEmpty(async ({ db }) => {
      await plantPrincipalMail(`${BASE_COLUMNS},
        "created_at" timestamptz NOT NULL DEFAULT now()`);
      await expect(applyMailboxMigrations(db, "public")).rejects.toThrow(
        SchemaTypeMismatchError,
      );
      // A guard that only fires on the first boot is one a restart disables.
      await expect(applyMailboxMigrations(db, "public")).rejects.toThrow(
        SchemaTypeMismatchError,
      );
      expect(await stateTableExists()).toBe(false);
    });
  });
});
