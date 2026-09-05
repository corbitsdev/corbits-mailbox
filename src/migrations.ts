import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { MailboxDb } from "./db.js";
import { assertExpectedColumnTypes } from "./schema-check.js";

// Own migration ledger, in this package's own schema — never shared with any
// host table, so mounting never collides with (or depends on) the host's own
// migration bookkeeping.
const LEDGER_TABLE = "corbits_mailbox_migrations";

// A fixed advisory-lock key for this package, so several app instances booting
// at once serialize here instead of racing the same CREATE TABLE. Advisory
// locks are namespaced by this integer alone, so it is deliberately arbitrary
// and specific to @corbits/mailbox.
const LOCK_KEY = 0x0a27_2c01;

// Statements are literal DDL — no interpolated values — so they render to a
// stable string and can be hashed into a ledger checksum. Editing a shipped
// statement changes its checksum, and the runner then refuses to boot rather
// than silently leaving old environments on the old schema while fresh ones get
// the new one.
export type Migration = {
  id: string;
  statements: SQL[];
  /**
   * When set, the runner calls `assertExpectedColumnTypes` immediately before
   * executing `statements[assertColumnsBeforeStatement]`, inside this
   * migration's own step transaction. Purely a runner-ordering knob — it does
   * not change `statements` and so cannot change `migrationChecksum`. See
   * `0003_mail_references`, where it exists so a host whose "principal_mail"
   * predates this package (and so is missing "refs") fails here with the named
   * `SchemaTypeMismatchError` instead of at the CREATE INDEX statement below,
   * as a raw, unfriendly Postgres "column \"refs\" does not exist".
   */
  assertColumnsBeforeStatement?: number;
};

export const MIGRATIONS: Migration[] = [
  {
    id: "0001_principal_mailbox",
    statements: [
      // Everything this package owns lives in its own schema in the HOST's
      // database. The FKs below are the reason there is no separate-database
      // mode: they can only hold when the control plane and the mail plane
      // share one database.
      sql`CREATE SCHEMA IF NOT EXISTS "mailbox"`,
      // THE MAIL PLANE. Column for column what `session_mail` is, plus the
      // cached header columns and the scope this package keys on. Immutable
      // once written: everything a human does to a message afterwards lands in
      // `"mailbox"."mailbox"`, below.
      //
      // The scope columns carry HARD FKs to the host's control plane with
      // ON DELETE CASCADE: a row can only belong to a tenant and principal the
      // host knows, and offboarding either carries the mailbox rows out with
      // it. Constraint names follow drizzle's convention so a host pointing
      // drizzle-kit at the exported table objects converges on the same names.
      sql`CREATE TABLE IF NOT EXISTS "mailbox"."principal_mail" (
         "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
         "tenant_id" text NOT NULL,
         "principal_id" text NOT NULL,
         "address" text NOT NULL,
         "direction" text NOT NULL,
         "raw" bytea NOT NULL,
         "subject" text,
         "from_address" text,
         "message_key" text,
         "refs" jsonb,
         "created_at" timestamp NOT NULL DEFAULT now(),
         CONSTRAINT "principal_mail_tenant_id_tenant_id_fk"
           FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant" ("id") ON DELETE CASCADE,
         CONSTRAINT "principal_mail_principal_id_principal_id_fk"
           FOREIGN KEY ("principal_id") REFERENCES "public"."principal" ("id") ON DELETE CASCADE
       )`,
      // Dedupe is partial on purpose: mail that arrives without a stable
      // message key (most external mail) is left unconstrained rather than
      // collapsed onto a single NULL-keyed row per mailbox.
      sql`CREATE UNIQUE INDEX IF NOT EXISTS "principal_mail_tenant_id_principal_id_message_key_idx"
         ON "mailbox"."principal_mail" ("tenant_id", "principal_id", "message_key")
         WHERE "message_key" IS NOT NULL`,
      // The list query orders by (created_at DESC, id DESC) and seeks with a
      // row-value comparison on the same pair. Carrying id and matching the
      // sort direction is what turns each page into an Index Cond; an index
      // stopping at created_at ASC can only Filter the seek and must
      // Incremental Sort every page.
      //
      // This index stays on the mail plane, which is what keeps the default
      // `created_at` page a single-table Index Scan after the split.
      sql`CREATE INDEX IF NOT EXISTS "principal_mail_tenant_id_principal_id_created_at_id_idx"
         ON "mailbox"."principal_mail" ("tenant_id", "principal_id", "created_at" DESC, "id" DESC)`,
      // THE MANAGEMENT LAYER, keyed by mail id and created eagerly with the
      // message — all-NULL means delivered-and-untouched. The id FK to this
      // package's own mail plane is what makes a mail row and its management
      // state one lifecycle; the scope FKs mirror the mail plane's for the
      // same reason they exist there.
      //
      // "priority" and "status" are plain text with no CHECK: the vocabulary is
      // the host's, and a constraint here would freeze one product's taxonomy
      // into every adopter's database.
      sql`CREATE TABLE IF NOT EXISTS "mailbox"."mailbox" (
         "id" text PRIMARY KEY REFERENCES "mailbox"."principal_mail" ("id") ON DELETE CASCADE,
         "tenant_id" text NOT NULL,
         "principal_id" text NOT NULL,
         "read_at" timestamp,
         "archived_at" timestamp,
         "trashed_at" timestamp,
         "priority" text,
         "classification" text,
         "status" text,
         "assignee" text,
         CONSTRAINT "mailbox_tenant_id_tenant_id_fk"
           FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant" ("id") ON DELETE CASCADE,
         CONSTRAINT "mailbox_principal_id_principal_id_fk"
           FOREIGN KEY ("principal_id") REFERENCES "public"."principal" ("id") ON DELETE CASCADE
       )`,
      // Triage access paths. Every mailbox query is already scoped to
      // (tenant_id, principal_id), so that pair leads and the triage column is
      // the trailing key — the shape a "my high-priority mail" or "my
      // needs-action mail" filter can actually seek on. A bare single-column
      // index on a low-cardinality column is one the planner would never
      // choose.
      sql`CREATE INDEX IF NOT EXISTS "mailbox_tenant_id_principal_id_priority_idx"
         ON "mailbox"."mailbox" ("tenant_id", "principal_id", "priority")`,
      sql`CREATE INDEX IF NOT EXISTS "mailbox_tenant_id_principal_id_classification_idx"
         ON "mailbox"."mailbox" ("tenant_id", "principal_id", "classification")`,
      sql`CREATE INDEX IF NOT EXISTS "mailbox_tenant_id_principal_id_status_idx"
         ON "mailbox"."mailbox" ("tenant_id", "principal_id", "status")`,
      // `assignee` is the delegation ref: mail is the single work surface, so
      // handing an item to someone else stamps this column rather than
      // forwarding a copy. Same (tenant_id, principal_id)-leading shape, because the
      // "what have I delegated to X" filter is always scoped to one mailbox.
      sql`CREATE INDEX IF NOT EXISTS "mailbox_tenant_id_principal_id_assignee_idx"
         ON "mailbox"."mailbox" ("tenant_id", "principal_id", "assignee")`,
      // One partial index per view predicate. Rows are created eagerly with
      // their messages, which is what makes the unread index possible: the
      // unread count becomes an index-only scan here rather than a LEFT JOIN
      // over the principal's whole history.
      sql`CREATE INDEX IF NOT EXISTS "mailbox_tenant_id_principal_id_unread_idx"
         ON "mailbox"."mailbox" ("tenant_id", "principal_id")
         WHERE "read_at" IS NULL
           AND "archived_at" IS NULL
           AND "trashed_at" IS NULL`,
      sql`CREATE INDEX IF NOT EXISTS "mailbox_tenant_id_principal_id_archived_at_idx"
         ON "mailbox"."mailbox" ("tenant_id", "principal_id")
         WHERE "archived_at" IS NOT NULL
           AND "trashed_at" IS NULL`,
      sql`CREATE INDEX IF NOT EXISTS "mailbox_tenant_id_principal_id_trashed_at_idx"
         ON "mailbox"."mailbox" ("tenant_id", "principal_id")
         WHERE "trashed_at" IS NOT NULL`,
    ],
  },
  {
    // The threading headers, cached alongside `subject` and `from_address` so
    // the list projection can render a thread without loading `raw`. Additive
    // and nullable: nothing about an existing row becomes invalid, and a frame
    // carrying neither header keeps both columns NULL.
    id: "0002_mail_threading_headers",
    statements: [
      sql`ALTER TABLE "mailbox"."principal_mail"
         ADD COLUMN IF NOT EXISTS "message_id" text`,
      sql`ALTER TABLE "mailbox"."principal_mail"
         ADD COLUMN IF NOT EXISTS "in_reply_to" text`,
      // Backfill from the frozen frame, so rows written before these columns
      // existed project the same headers a row written after them does —
      // otherwise threading would silently start at the upgrade.
      //
      // The header section is sliced out of `raw` at the BYTEA level, before
      // any text conversion runs, by searching for the first blank-line
      // separator (`\r\n\r\n`, falling back to a bare `\n\n` for frames that
      // never had their line endings normalized) — a body line that happens
      // to begin `Message-ID:` still cannot be mistaken for a header, exactly
      // as the original text-level split guaranteed. No separator at all
      // means no reliable header/body boundary, so the whole frame is
      // searched, matching the pre-existing degrade for a headerless frame.
      //
      // Postgres `text` cannot hold a NUL byte (0x00) in ANY encoding — that is
      // a server-side invariant, not an encoding limitation, so choosing UTF8
      // over LATIN1 would not have helped, and Postgres's own `bytea` has no
      // `replace`/`regexp_replace` overload to lean on either (PG16). A single
      // legacy frame with a NUL anywhere in `raw` (a binary attachment is the
      // common case) used to abort the entire UPDATE — and with it, every
      // boot, forever, because the migration ledger row for 0002 would never
      // commit.
      //
      // `clean_bytes` rebuilds the (already header-only) bytea slice one byte
      // at a time via `get_byte`/`set_byte`, keeping every byte except 0x00,
      // so NUL cannot reach `convert_from` at all — the conversion can no
      // longer fail on this row. LATIN1 still accepts every remaining byte
      // value 0-255, so header names and msg-ids (both ASCII) survive
      // unchanged. A NUL is not expected in a real header, so stripping it
      // here costs nothing for well-formed mail and only spares the migration
      // from a legacy body's bytes it should never have been reading. The
      // per-byte scan runs only over the (small, already-sliced) header
      // section of rows still missing both cached columns, once, at upgrade.
      sql`UPDATE "mailbox"."principal_mail" AS pm
         SET "message_id" = h."message_id", "in_reply_to" = h."in_reply_to"
         FROM (
           SELECT "id",
             substring(head from '(?ni)^Message-ID:[[:space:]]*(<[^<>]+>)') AS "message_id",
             substring(head from '(?ni)^In-Reply-To:[[:space:]]*(<[^<>]+>)') AS "in_reply_to"
           FROM (
             SELECT "id",
               replace(
                 convert_from(clean_bytes, 'LATIN1'),
                 chr(13) || chr(10), chr(10)
               ) AS head
             FROM (
               SELECT sliced."id",
                 COALESCE(
                   (SELECT string_agg(set_byte(decode('00', 'hex'), 0, b), ''::bytea ORDER BY i)
                      FROM generate_series(0, octet_length(sliced.head_bytes) - 1) AS i,
                           LATERAL (SELECT get_byte(sliced.head_bytes, i) AS b) AS byte
                     WHERE b <> 0),
                   ''::bytea
                 ) AS clean_bytes
               FROM (
                 SELECT "id",
                   CASE
                     WHEN position(decode('0d0a0d0a', 'hex') IN "raw") > 0
                       THEN substring("raw" FOR position(decode('0d0a0d0a', 'hex') IN "raw") - 1)
                     WHEN position(decode('0a0a', 'hex') IN "raw") > 0
                       THEN substring("raw" FOR position(decode('0a0a', 'hex') IN "raw") - 1)
                     ELSE "raw"
                   END AS head_bytes
                 FROM "mailbox"."principal_mail"
                 WHERE "message_id" IS NULL AND "in_reply_to" IS NULL
               ) sliced
             ) cleaned
           ) heads
         ) h
         WHERE pm."id" = h."id"
           AND (h."message_id" IS NOT NULL OR h."in_reply_to" IS NOT NULL)`,
    ],
  },
  {
    // The third threading header, plus the three access paths a thread read
    // needs. `references` completes what 0002 started: RFC 5256 linking walks
    // `In-Reply-To` first and then the `References` chain newest-first, and
    // `readMailboxThread` runs on the list path, which never loads `raw`.
    id: "0003_mail_references",
    // See `assertColumnsBeforeStatement` on `Migration`: this runs the column
    // check right before the GIN index below, which is the first statement in
    // this migration that would otherwise fail with a raw Postgres error
    // ("column \"refs\" does not exist") on a host whose "principal_mail"
    // predates this package, rather than the named diagnostic.
    assertColumnsBeforeStatement: 3,
    statements: [
      sql`ALTER TABLE "mailbox"."principal_mail"
         ADD COLUMN IF NOT EXISTS "references" jsonb`,
      // Msg-id lookup: `readMailboxMessageByMessageId`, and the one ancestor
      // map query `readMailboxThread` issues per read.
      sql`CREATE INDEX IF NOT EXISTS "principal_mail_tenant_id_principal_id_message_id_idx"
         ON "mailbox"."principal_mail" ("tenant_id", "principal_id", "message_id")`,
      // The keyset access path `readMailboxThread` actually orders by:
      // oldest-first, `(created_at, id)`, scoped to `(tenant_id, principal_id)`.
      // `0001`'s index already covers a query shaped like this via a BACKWARD
      // scan (it is declared `created_at DESC, id DESC`, for the list path's
      // newest-first order) — but a plan is easier to reason about, and to
      // pin in a test, when the thread path has its own index matching its
      // own `ORDER BY` verbatim rather than depending on Postgres choosing to
      // scan another index in reverse. Same three leading columns
      // `principal_mail_tenant_id_principal_id_created_at_id_idx` carries, in
      // the direction `readMailboxThread` actually asks for.
      sql`CREATE INDEX IF NOT EXISTS "principal_mail_tenant_id_principal_id_created_at_id_asc_idx"
         ON "mailbox"."principal_mail" ("tenant_id", "principal_id", "created_at" ASC, "id" ASC)`,
      // The ref filter is jsonb containment; only GIN serves it. Default
      // `jsonb_ops`, matching what `schema.ts` declares.
      sql`CREATE INDEX IF NOT EXISTS "principal_mail_refs_idx"
         ON "mailbox"."principal_mail" USING gin ("refs")`,
      // Backfill from the frozen frame, on exactly the terms 0002 backfills
      // its two columns: the header section is sliced out of `raw` at the
      // BYTEA level so a body line beginning `References:` cannot be mistaken
      // for a header, and every NUL byte is stripped from that slice before
      // `convert_from` runs, because Postgres `text` cannot hold 0x00 in any
      // encoding and one legacy frame carrying one would otherwise abort the
      // whole UPDATE — and with it every boot, forever.
      //
      // One step 0002 did not need: `References` is the header that FOLDS.
      // RFC 2822 §2.2.3 caps a line at 78 characters, so a chain of more than
      // a couple of ids is written across continuation lines, and a regex
      // anchored to one line would see only the first fragment. The header
      // section is unfolded first — every newline followed by whitespace
      // collapses to a single space — after which each header is one line and
      // the value is everything to the end of it.
      //
      // Msg-ids are then extracted with the same `<[^<>]+>` shape
      // `parseMsgIdList` uses at runtime, in order, so a row backfilled here
      // and a row written after the upgrade project the same chain. A frame
      // with no References (or none that parse) keeps the column NULL rather
      // than storing an empty array: absent and empty are the same thing here,
      // and NULL is the cheaper of the two.
      sql`UPDATE "mailbox"."principal_mail" AS pm
         SET "references" = h."references"
         FROM (
           SELECT "id",
             (
               SELECT jsonb_agg(m[1] ORDER BY ord)
                 FROM regexp_matches(
                        COALESCE(substring(head from '(?ni)^References:[ \t]*(.*)$'), ''),
                        '<[^<>]+>', 'g'
                      ) WITH ORDINALITY AS matched(m, ord)
             ) AS "references"
           FROM (
             SELECT "id",
               regexp_replace(
                 replace(
                   convert_from(clean_bytes, 'LATIN1'),
                   chr(13) || chr(10), chr(10)
                 ),
                 chr(10) || '[ \t]+', ' ', 'g'
               ) AS head
             FROM (
               SELECT sliced."id",
                 COALESCE(
                   (SELECT string_agg(set_byte(decode('00', 'hex'), 0, b), ''::bytea ORDER BY i)
                      FROM generate_series(0, octet_length(sliced.head_bytes) - 1) AS i,
                           LATERAL (SELECT get_byte(sliced.head_bytes, i) AS b) AS byte
                     WHERE b <> 0),
                   ''::bytea
                 ) AS clean_bytes
               FROM (
                 SELECT "id",
                   CASE
                     WHEN position(decode('0d0a0d0a', 'hex') IN "raw") > 0
                       THEN substring("raw" FOR position(decode('0d0a0d0a', 'hex') IN "raw") - 1)
                     WHEN position(decode('0a0a', 'hex') IN "raw") > 0
                       THEN substring("raw" FOR position(decode('0a0a', 'hex') IN "raw") - 1)
                     ELSE "raw"
                   END AS head_bytes
                 FROM "mailbox"."principal_mail"
                 WHERE "references" IS NULL
               ) sliced
             ) cleaned
           ) heads
         ) h
         WHERE pm."id" = h."id"
           AND h."references" IS NOT NULL`,
    ],
  },
];

const DIALECT = new PgDialect();

/**
 * Fingerprint of a migration's rendered DDL. Recorded next to the id, so an
 * edit to an already-applied migration is caught on the next boot instead of
 * leaving deployed environments silently on the old schema forever while fresh
 * databases get the new one.
 *
 * Runs of whitespace are collapsed before hashing, so reindenting a template
 * literal is not a schema change and does not lock every deployed host out on
 * its next boot. Identical, character for character, to
 * `@corbits/artifact-core`'s and `@corbits/analytics-core`'s: three sibling
 * packages must not disagree about what "the same migration" means.
 */
export function migrationChecksum(migration: Migration): string {
  const rendered = migration.statements
    .map((statement) =>
      DIALECT.sqlToQuery(statement).sql.replace(/\s+/g, " ").trim(),
    )
    .join(";\n");
  return createHash("sha256").update(rendered).digest("hex");
}

export class MigrationChecksumError extends Error {
  constructor(id: string, recorded: string, current: string) {
    super(
      `Migration "${id}" has changed since it was applied to this database ` +
        `(recorded ${recorded}, now ${current}). A shipped migration must never ` +
        `be edited — add a new one instead.`,
    );
    this.name = "MigrationChecksumError";
  }
}

/**
 * Idempotent migration runner. Safe to call on every boot, from every
 * instance: takes a transaction-scoped advisory lock before reading the
 * ledger, so concurrent cold starts serialize here instead of racing the same
 * CREATE TABLE. `CREATE TABLE IF NOT EXISTS` is not itself race-safe — the
 * existence check and the pg_type insert are not atomic — so the lock, not the
 * IF NOT EXISTS, is what makes this safe.
 *
 * Each applied migration is recorded with a checksum of its statements. A
 * shipped migration that is later edited fails loudly here instead of leaving
 * already-migrated environments silently behind fresh ones.
 *
 * The run also lowers `client_min_messages` to `warning` for the duration of
 * the transaction. Every DDL statement here is deliberately `IF NOT EXISTS`,
 * and on the second and every later boot Postgres answers each one with a
 * NOTICE (`relation "…" already exists, skipping`). postgres.js has no notice
 * handler by default, so it dumps the raw notice OBJECT to the console —
 * meaning a perfectly clean re-boot of a runner documented as "safe to call on
 * every boot" printed a wall of what looked like errors on every replica start.
 * `SET LOCAL` scopes the change to this transaction and stops at NOTICE:
 * WARNING and above still reach the host untouched. It is set on the connection
 * rather than via a client option so it holds for ANY handle a host hands in,
 * including one this package did not construct.
 *
 * Each migration applies inside its own nested transaction (a savepoint under
 * the outer one), so a migration is all-or-nothing with its ledger row and can
 * never be recorded as applied with only some of its statements run. With one
 * migration this is equivalent to the flat form; the moment a second lands it
 * stops being equivalent, and a runner that rolls back inconsistently is not
 * something to discover then.
 */
export async function runMailboxMigrations(db: MailboxDb): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL client_min_messages = warning`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);

    // `checksum` is NOT NULL from the first migration this package ever ships.
    // There is no such thing as a ledger written before checksums existed —
    // 0.1.0 is the first public release and it carries a single squashed
    // `0001` — so there is no pre-checksum row to adopt and the column needs no
    // backfilling ALTER. That keeps immutability enforcement unconditional:
    // every recorded row has a checksum, so every edit to a shipped migration
    // is caught, with no adopt-silently path that lets exactly one through.
    // The schema must exist before the ledger can live in it — created here as
    // well as in 0001 so the ledger's home never depends on which migrations
    // have run yet.
    await tx.execute(sql`CREATE SCHEMA IF NOT EXISTS "mailbox"`);
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS "mailbox".${sql.identifier(LEDGER_TABLE)} (
        "id" text PRIMARY KEY,
        "checksum" text NOT NULL,
        "applied_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = await tx.execute<{ id: string; checksum: string }>(
      sql`SELECT "id", "checksum" FROM "mailbox".${sql.identifier(LEDGER_TABLE)}`,
    );
    const appliedById = new Map(applied.map((row) => [row.id, row.checksum]));

    for (const migration of MIGRATIONS) {
      const expected = migrationChecksum(migration);
      const recorded = appliedById.get(migration.id);
      if (recorded !== undefined) {
        if (recorded !== expected) {
          throw new MigrationChecksumError(migration.id, recorded, expected);
        }
        continue;
      }
      await tx.transaction(async (step) => {
        for (const [index, statement] of migration.statements.entries()) {
          if (migration.assertColumnsBeforeStatement === index) {
            await assertExpectedColumnTypes(step);
          }
          await step.execute(statement);
        }
        await step.execute(
          sql`INSERT INTO "mailbox".${sql.identifier(LEDGER_TABLE)} ("id", "checksum") VALUES (${migration.id}, ${expected})`,
        );
      });
    }

    // Last, on the same transaction, so it sees exactly the schema the DDL
    // above just produced — and so a host whose pre-existing tables shadow ours
    // fails the boot instead of silently reading its columns through our codec.
    // Because it is the SAME transaction, a rejected boot rolls the ledger row
    // back with it: nothing is left recorded as applied. See schema-check.ts.
    await assertExpectedColumnTypes(tx);
  });
}
