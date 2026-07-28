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
import { mailbox, principalMail } from "./schema.js";
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

/** `name(col asc, col desc)` plus `unique`/`partial` markers. */
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
      return `${config.name}(${columns})${suffix}`;
    })
    .sort();
}

// `pg_get_indexdef` renders `CREATE [UNIQUE] INDEX <name> ON <tbl> USING btree
// (<cols>)[ WHERE (<pred>)]`, with DESC spelled out and ASC left implicit.
function canonicalizeIndexDef(def: string): IndexDescriptor {
  const match =
    /^CREATE (UNIQUE )?INDEX (\S+) ON \S+ USING btree \((.*?)\)( WHERE .*)?$/.exec(
      def,
    );
  if (match === null) throw new Error(`unparsed index definition: ${def}`);
  const [, unique, name, columnList, where] = match;
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
  return `${name}(${columns})${suffix}`;
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

// Both tables, not just the mail plane: `mailbox` is a public export too, and
// the divergence this suite exists to catch — a declared index the migrations
// never create — is exactly as invisible on the newer table as on the older
// one.
const TABLES = [
  { name: "principal_mail", declared: principalMail },
  { name: "mailbox", declared: mailbox },
] as const;

describe("schema.ts vs. the DDL runMailboxMigrations actually creates", () => {
  for (const { name, declared } of TABLES) {
    it(`${name}: declares exactly the indexes the live table has, in the same column order`, async () => {
      expect(declaredIndexes(declared)).toEqual(await liveIndexes(name));
    });
  }

  it("indexes the triage columns per tenant_id+principal_id, not as bare single columns", async () => {
    const live = await liveIndexes("mailbox");
    for (const column of ["priority", "classification", "status", "assignee"]) {
      expect(live).toContain(
        `mailbox_tenant_id_principal_id_${column}_idx(tenant_id asc, principal_id asc, ${column} asc)`,
      );
    }
    // Bare single-column forms must stay absent: an index on a low-cardinality
    // column is not an access path the planner would choose.
    expect(
      live.filter((descriptor) =>
        /^mailbox_(priority|classification|status|assignee)_idx\(/.test(
          descriptor,
        ),
      ),
    ).toEqual([]);
  });

  it("keeps the keyset access path on the mail plane, where the split left it", async () => {
    expect(await liveIndexes("principal_mail")).toContain(
      "principal_mail_tenant_id_principal_id_created_at_id_idx(tenant_id asc, principal_id asc, created_at desc, id desc)",
    );
  });

  it("carries one partial index per view predicate on mailbox", async () => {
    // Including unread: every message has an eagerly-created management row,
    // so the unread count is an index-only scan on this partial index.
    const live = await liveIndexes("mailbox");
    for (const name of ["archived_at", "trashed_at", "unread"]) {
      expect(live).toContain(
        `mailbox_tenant_id_principal_id_${name}_idx(tenant_id asc, principal_id asc) [partial]`,
      );
    }
  });
});
