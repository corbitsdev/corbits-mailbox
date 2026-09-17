// The drizzle table object is a public export, so a host can point
// `drizzle-kit push`/`generate` at it. If it declares an index the migrations
// do not create — or creates one with a different column order — that host's
// schema silently diverges from the one this package's queries were planned
// against. This suite diffs the two after a real migration run.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { principalMail } from "./schema.js";
import { runMailboxMigrations } from "./migrations.js";
import { createHostControlPlane, TEST_DATABASE_URL } from "./test-helpers.js";

// The tables live in this package's own `mailbox` schema, so what is compared
// is exactly what the migration built there — running the (idempotent)
// migrations here keeps the suite independent of which file ran first. The
// control-plane stub tables must exist for the migration's FKs to land.
const SCHEMA = "mailbox";
const client = postgres(TEST_DATABASE_URL, { onnotice: () => {} });

beforeAll(async () => {
  const db = drizzle(client);
  await createHostControlPlane(db);
  await runMailboxMigrations(db);
});

afterAll(async () => {
  await client.end();
});

/** `name USING method(col asc, col desc)` plus `unique`/`partial` markers. */
type IndexDescriptor = string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- one canonicalizer
// for both tables; `getTableConfig` is invariant in its table generic.
function declaredIndexes(table: any): IndexDescriptor[] {
  const { indexes } = getTableConfig(table);
  return indexes
    .map((index) => {
      const config = index.config;
      const columns = config.columns
        .map((column) => {
          // Every index here is over plain columns; an expression index would
          // have no `.name` and must be added to this canonicalizer before it
          // can be compared at all, rather than silently comparing as blank.
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
      // The access method is part of the descriptor, not decoration: a GIN
      // index and a btree index over the same column serve different queries,
      // and `refs @> …` is only servable by the former.
      const method = (config as { method?: string }).method ?? "btree";
      return `${config.name} USING ${method}(${columns})${suffix}`;
    })
    .sort();
}

// `pg_get_indexdef` renders `CREATE [UNIQUE] INDEX <name> ON <tbl> USING
// <method> (<cols>)[ WHERE (<pred>)]`, with DESC spelled out and ASC left
// implicit.
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

async function liveIndexes(table: string): Promise<IndexDescriptor[]> {
  const rows = await drizzle(client).execute<{ indexdef: string }>(sql`
    SELECT indexdef FROM pg_indexes
     WHERE schemaname = ${SCHEMA}
       AND tablename = ${table}
       AND indexname <> ${`${table}_pkey`}
  `);
  return rows.map((row) => canonicalizeIndexDef(row.indexdef)).sort();
}

// `mailbox.mailbox` (the pre-native management layer) was dropped in
// `0005_drop_pre_native_columns` — the mail plane is the only table left to
// hold to this parity.
const TABLES = [{ name: "principal_mail", declared: principalMail }] as const;

describe("schema.ts vs. the DDL runMailboxMigrations actually creates", () => {
  for (const { name, declared } of TABLES) {
    it(`${name}: declares exactly the indexes the live table has, in the same column order`, async () => {
      expect(declaredIndexes(declared)).toEqual(await liveIndexes(name));
    });
  }

  it("keeps the keyset access path on the mail plane, where the split left it", async () => {
    expect(await liveIndexes("principal_mail")).toContain(
      "principal_mail_tenant_id_principal_id_created_at_id_idx USING btree(tenant_id asc, principal_id asc, created_at desc, id desc)",
    );
  });

  it("no longer has a live mailbox.mailbox table", async () => {
    const rows = await drizzle(client).execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${SCHEMA} AND table_name = 'mailbox'
      ) AS "exists"
    `);
    expect(rows[0]!.exists).toBe(false);
  });
});
