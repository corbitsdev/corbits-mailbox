// Every case here builds the `mailbox` schema from empty. The tables are
// hard-qualified to that one schema, so the isolation is DROP SCHEMA "mailbox"
// CASCADE before each case rather than a private search_path — and because the
// whole suite runs sequentially in one process, dropping it out from under the
// other files only matters if it stays dropped. It does not: `afterAll`
// re-runs the (idempotent) migrations, and so does every case, so the suite is
// ordering-independent. The control-plane stub tables in `public` must exist
// before any migration run — the FKs land on them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { createMailboxDb } from "./db.js";
import {
  MIGRATIONS,
  MigrationChecksumError,
  runMailboxMigrations,
} from "./migrations.js";
import { buildMailFrame } from "./frame.js";
import {
  createHostControlPlane,
  seedScope,
  TEST_DATABASE_URL,
} from "./test-helpers.js";

const admin = postgres(TEST_DATABASE_URL, { onnotice: () => {} });
const adminDb = drizzle(admin);

beforeAll(async () => {
  await createHostControlPlane(adminDb);
});

afterAll(async () => {
  // Leave the schema the way every other suite expects to find it, whatever
  // the last case here did to it.
  await runMailboxMigrations(adminDb);
  await admin.end();
});

/** Drop this package's schema so the next migration run builds from empty. */
async function dropMailboxSchema(): Promise<void> {
  await admin.unsafe(`DROP SCHEMA IF EXISTS "mailbox" CASCADE`);
}

function handle() {
  const client = postgres(TEST_DATABASE_URL, { onnotice: () => {} });
  return { client, db: drizzle(client) };
}

/** Runs `fn` against a freshly-dropped schema and always drains its pool. */
async function fromEmpty(
  fn: (h: ReturnType<typeof handle>) => Promise<void>,
): Promise<void> {
  await dropMailboxSchema();
  const h = handle();
  try {
    await fn(h);
  } finally {
    await h.client.end();
  }
}

describe("runMailboxMigrations", () => {
  test("builds the full schema from an empty database", async () => {
    await fromEmpty(async ({ db }) => {
      await runMailboxMigrations(db);

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
        "from_address",
        "id",
        "in_reply_to",
        "message_id",
        "message_key",
        "principal_id",
        "raw",
        "references",
        "refs",
        "subject",
        "tenant_id",
      ]);

      const stateColumns = await db.execute<{ column_name: string }>(
        sql`SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'mailbox' AND table_name = 'mailbox'
            ORDER BY column_name`,
      );
      expect(stateColumns.map((c) => c.column_name)).toEqual([
        "archived_at",
        "assignee",
        "classification",
        "id",
        "principal_id",
        "priority",
        "read_at",
        "status",
        "tenant_id",
        "trashed_at",
      ]);

      const mailIndexes = await db.execute<{ indexname: string }>(
        sql`SELECT indexname FROM pg_indexes
            WHERE schemaname = 'mailbox' AND tablename = 'principal_mail'
            ORDER BY indexname`,
      );
      // The mail plane keeps exactly four access paths: the dedupe constraint,
      // the keyset the default page seeks on, and the two the thread read adds
      // — the msg-id lookup and the GIN index serving the `refs` containment
      // filter. `schema-ddl-parity.test.ts` holds schema.ts to this same list.
      expect(mailIndexes.map((i) => i.indexname)).toEqual([
        "principal_mail_pkey",
        "principal_mail_refs_idx",
        "principal_mail_tenant_id_principal_id_created_at_id_idx",
        "principal_mail_tenant_id_principal_id_message_id_idx",
        "principal_mail_tenant_id_principal_id_message_key_idx",
      ]);

      const stateIndexes = await db.execute<{ indexname: string }>(
        sql`SELECT indexname FROM pg_indexes
            WHERE schemaname = 'mailbox' AND tablename = 'mailbox'
            ORDER BY indexname`,
      );
      // The management layer carries the triage filters and one partial index
      // per view predicate — eager rows are what make the unread one possible.
      expect(stateIndexes.map((i) => i.indexname)).toEqual([
        "mailbox_pkey",
        "mailbox_tenant_id_principal_id_archived_at_idx",
        "mailbox_tenant_id_principal_id_assignee_idx",
        "mailbox_tenant_id_principal_id_classification_idx",
        "mailbox_tenant_id_principal_id_priority_idx",
        "mailbox_tenant_id_principal_id_status_idx",
        "mailbox_tenant_id_principal_id_trashed_at_idx",
        "mailbox_tenant_id_principal_id_unread_idx",
      ]);

      // The dedupe index is partial: NULL-key external mail is unconstrained.
      const partial = await db.execute<{ indexdef: string }>(
        sql`SELECT indexdef FROM pg_indexes WHERE schemaname = 'mailbox'
            AND indexname = 'principal_mail_tenant_id_principal_id_message_key_idx'`,
      );
      expect(partial[0]?.indexdef).toContain("WHERE (message_key IS NOT NULL)");
    });
  });

  test("the keyset index matches the list query's ORDER BY exactly", async () => {
    await fromEmpty(async ({ db }) => {
      await runMailboxMigrations(db);
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

  test("the partial indexes match their view predicates", async () => {
    await fromEmpty(async ({ db }) => {
      await runMailboxMigrations(db);
      const rows = await db.execute<{
        indexname: string;
        indexdef: string;
      }>(
        sql`SELECT indexname, indexdef FROM pg_indexes
            WHERE schemaname = 'mailbox'
              AND indexname LIKE 'mailbox_tenant_id_principal_id_%_idx'
              AND indexdef LIKE '%WHERE%'
            ORDER BY indexname`,
      );
      const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));
      expect([...byName.keys()]).toEqual([
        "mailbox_tenant_id_principal_id_archived_at_idx",
        "mailbox_tenant_id_principal_id_trashed_at_idx",
        "mailbox_tenant_id_principal_id_unread_idx",
      ]);
      for (const def of byName.values()) {
        expect(def).toContain("(tenant_id, principal_id)");
      }
      expect(
        byName.get("mailbox_tenant_id_principal_id_archived_at_idx"),
      ).toContain("archived_at IS NOT NULL) AND (trashed_at IS NULL");
      expect(
        byName.get("mailbox_tenant_id_principal_id_trashed_at_idx"),
      ).toContain("trashed_at IS NOT NULL");
      expect(
        byName.get("mailbox_tenant_id_principal_id_unread_idx"),
      ).toContain(
        "read_at IS NULL) AND (archived_at IS NULL) AND (trashed_at IS NULL",
      );
    });
  });

  // The split gives the archived/trash views two possible plans, and which one
  // wins is a question about the DATA, not about the schema: drive from the
  // mail keyset (ordering free, but scan until 51 archived messages turn up) or
  // drive from the mailbox partial index (enumerate the whole view, then sort
  // it). Both cases below are seeded and asserted rather than assumed.
  async function seedViewPlan(
    db: ReturnType<typeof handle>["db"],
    archivedEvery: number,
  ) {
    await seedScope(db, "acme", "user-1");
    await db.execute(sql`
      INSERT INTO "mailbox"."principal_mail"
        ("tenant_id","principal_id","address","direction","raw","created_at")
      SELECT 'acme','user-1','user-1@acme.example','inbound','\\x00'::bytea,
             now() - (g || ' seconds')::interval
      FROM generate_series(1, 20000) g
    `);
    // A read mailbox: every message has been opened, so every one has a
    // management row, and only every `archivedEvery`-th is archived. That is
    // what makes the archived view SPARSE within a large `mailbox` rather than
    // simply small — the case where a partial index earns its keep.
    await db.execute(sql`
      INSERT INTO "mailbox"."mailbox" ("id","tenant_id","principal_id","read_at","archived_at")
      SELECT "id", "tenant_id", "principal_id", now(),
             CASE WHEN m.n % ${sql.raw(String(archivedEvery))} = 0 THEN now() END
        FROM (SELECT *, row_number() OVER (ORDER BY "created_at") AS n
                FROM "mailbox"."principal_mail") m
    `);
    await db.execute(sql`ANALYZE "mailbox"."principal_mail"`);
    await db.execute(sql`ANALYZE "mailbox"."mailbox"`);
    const plan = await db.execute<{ "QUERY PLAN": string }>(sql`
      EXPLAIN (ANALYZE)
      SELECT pm."id" FROM "mailbox"."principal_mail" pm
        LEFT JOIN "mailbox"."mailbox" mb ON mb."id" = pm."id"
      WHERE pm."tenant_id" = 'acme' AND pm."principal_id" = 'user-1'
        AND pm."direction" = 'inbound'
        AND mb."archived_at" IS NOT NULL AND mb."trashed_at" IS NULL
      ORDER BY pm."created_at" DESC, pm."id" DESC
      LIMIT 51
    `);
    return plan.map((r) => r["QUERY PLAN"]).join("\n");
  }

  test("a dense archived view pages off the mail keyset with no sort", async () => {
    await fromEmpty(async ({ db }) => {
      await runMailboxMigrations(db);
      // One in twenty archived: a page of 51 is reachable within ~1000 mail
      // rows, so the planner takes the ordering for free rather than sorting.
      const text = await seedViewPlan(db, 20);
      expect(text).toContain(
        "principal_mail_tenant_id_principal_id_created_at_id_idx",
      );
      expect(text).not.toContain("Sort Method");
    });
  });

  test("a sparse archived view pages off the mailbox partial index", async () => {
    await fromEmpty(async ({ db }) => {
      await runMailboxMigrations(db);
      // One in four thousand archived: walking the mail keyset would scan the
      // principal's whole history to fill one page, so the partial index —
      // which enumerates the entire view directly — wins even with the sort.
      const text = await seedViewPlan(db, 4000);
      expect(text).toContain("mailbox_tenant_id_principal_id_archived_at_idx");
    });
  });

  test("0002 backfills the threading headers from legacy rows' raw", async () => {
    // The state every already-deployed host is in at upgrade: rows written
    // before the cached columns existed, so `raw` carries the headers and the
    // columns are NULL. Without the backfill, threading would silently begin at
    // the upgrade and every older message would project no parent.
    await fromEmpty(async ({ db }) => {
      // Build the pre-0002 schema, then seed through it.
      await runMailboxMigrations(db);
      await db.execute(
        sql`ALTER TABLE "mailbox"."principal_mail"
            DROP COLUMN "message_id", DROP COLUMN "in_reply_to"`,
      );
      await db.execute(
        sql`DELETE FROM "mailbox"."corbits_mailbox_migrations"
            WHERE "id" = '0002_mail_threading_headers'`,
      );
      await seedScope(db, "acme", "user-1");

      const threaded = buildMailFrame({
        from: "bot@acme.example",
        to: "user-1@acme.example",
        subject: "Re: legacy",
        body: "Body",
        messageId: "<child@acme.example>",
        inReplyTo: "<parent@acme.example>",
        references: ["<root@acme.example>", "<parent@acme.example>"],
      });
      // A frame with neither header, and one whose bytes are not valid UTF-8:
      // both must survive the backfill statement rather than abort it.
      const headerless = new TextEncoder().encode(
        "From: bot@acme.example\r\nSubject: no ids\r\n\r\nBody\r\n",
      );
      const invalidUtf8 = Uint8Array.from([
        ...new TextEncoder().encode("From: bot@acme.example\r\nMessage-ID: <bytes@acme.example>\r\n\r\n"),
        0xff,
        0xfe,
      ]);
      for (const [key, raw] of [
        ["legacy-threaded", threaded],
        ["legacy-headerless", headerless],
        ["legacy-invalid-utf8", invalidUtf8],
      ] as const) {
        await db.execute(sql`
          INSERT INTO "mailbox"."principal_mail"
            ("tenant_id","principal_id","address","direction","raw","message_key")
          VALUES ('acme','user-1','user-1@acme.example','inbound',
                  ${Buffer.from(raw)}, ${key})
        `);
      }

      await runMailboxMigrations(db);

      const rows = await db.execute<{
        message_key: string;
        message_id: string | null;
        in_reply_to: string | null;
      }>(sql`SELECT "message_key", "message_id", "in_reply_to"
             FROM "mailbox"."principal_mail" ORDER BY "message_key"`);
      expect(
        rows.map((r) => [r.message_key, r.message_id, r.in_reply_to]),
      ).toEqual([
        ["legacy-headerless", null, null],
        ["legacy-invalid-utf8", "<bytes@acme.example>", null],
        ["legacy-threaded", "<child@acme.example>", "<parent@acme.example>"],
      ]);
    });
  });

  test("0002 survives a legacy frame with a NUL byte in its body", async () => {
    // Postgres `text` cannot hold 0x00 in any encoding — a single legacy
    // frame with a NUL anywhere in `raw` used to abort the whole UPDATE (and
    // with it the ledger insert), which meant every subsequent boot failed
    // forever. This is RED against the pre-fix backfill (LATIN1-decoding the
    // entire `raw`, NUL included) and GREEN once only the NUL-stripped header
    // slice reaches `convert_from`.
    await fromEmpty(async ({ db }) => {
      await runMailboxMigrations(db);
      await db.execute(
        sql`ALTER TABLE "mailbox"."principal_mail"
            DROP COLUMN "message_id", DROP COLUMN "in_reply_to"`,
      );
      await db.execute(
        sql`DELETE FROM "mailbox"."corbits_mailbox_migrations"
            WHERE "id" = '0002_mail_threading_headers'`,
      );
      await seedScope(db, "acme", "user-1");

      const enc = new TextEncoder();
      const ok = enc.encode(
        "From: a@b.c\r\nMessage-ID: <ok@acme.example>\r\n\r\nBody\r\n",
      );
      const nulBody = Uint8Array.from([
        ...enc.encode(
          "From: a@b.c\r\nMessage-ID: <nul@acme.example>\r\n" +
            "Content-Type: application/octet-stream\r\n\r\n",
        ),
        0x00,
        0x41,
      ]);
      for (const [key, raw] of [
        ["nul-ok", ok],
        ["nul-body", nulBody],
      ] as const) {
        await db.execute(sql`
          INSERT INTO "mailbox"."principal_mail"
            ("tenant_id","principal_id","address","direction","raw","message_key")
          VALUES ('acme','user-1','user-1@acme.example','inbound',
                  ${Buffer.from(raw)}, ${key})
        `);
      }

      await runMailboxMigrations(db);

      const ledger = await db.execute<{ id: string }>(
        sql`SELECT "id" FROM "mailbox"."corbits_mailbox_migrations" ORDER BY "id"`,
      );
      expect(ledger.map((r) => r.id)).toEqual([
        "0001_principal_mailbox",
        "0002_mail_threading_headers",
        "0003_mail_references",
      ]);

      const rows = await db.execute<{
        message_key: string;
        message_id: string | null;
      }>(
        sql`SELECT "message_key", "message_id" FROM "mailbox"."principal_mail"
            ORDER BY "message_key"`,
      );
      expect(rows.map((r) => [r.message_key, r.message_id])).toEqual([
        ["nul-body", "<nul@acme.example>"],
        ["nul-ok", "<ok@acme.example>"],
      ]);
    });
  });

  test("0003 backfills the References chain, unfolding continuation lines", async () => {
    // `References` is the header that FOLDS: RFC 2822 caps a line at 78
    // characters, so a real chain of more than a couple of ids arrives split
    // across continuation lines. A backfill anchored to one line would cache
    // only the first fragment, and every older message would then link to the
    // wrong ancestor — worse than linking to none.
    await fromEmpty(async ({ db }) => {
      await runMailboxMigrations(db);
      await db.execute(
        sql`ALTER TABLE "mailbox"."principal_mail" DROP COLUMN "references"`,
      );
      await db.execute(
        sql`DELETE FROM "mailbox"."corbits_mailbox_migrations"
            WHERE "id" = '0003_mail_references'`,
      );
      await seedScope(db, "acme", "user-1");

      const enc = new TextEncoder();
      const folded = enc.encode(
        "From: bot@acme.example\r\n" +
          "Message-ID: <child@acme.example>\r\n" +
          "References: <root@acme.example>\r\n" +
          "\t<middle@acme.example>\r\n" +
          " <parent@acme.example>\r\n" +
          "\r\nBody\r\n",
      );
      const none = enc.encode(
        "From: bot@acme.example\r\nSubject: no chain\r\n\r\nBody\r\n",
      );
      // The body says `References:` at the start of a line; the header slice
      // must not reach it, and a NUL after it must not abort the UPDATE.
      const decoy = Uint8Array.from([
        ...enc.encode(
          "From: bot@acme.example\r\nMessage-ID: <decoy@acme.example>\r\n" +
            "\r\nReferences: <fake@acme.example>\r\n",
        ),
        0x00,
        0x41,
      ]);
      for (const [key, raw] of [
        ["refs-folded", folded],
        ["refs-none", none],
        ["refs-decoy", decoy],
      ] as const) {
        await db.execute(sql`
          INSERT INTO "mailbox"."principal_mail"
            ("tenant_id","principal_id","address","direction","raw","message_key")
          VALUES ('acme','user-1','user-1@acme.example','inbound',
                  ${Buffer.from(raw)}, ${key})
        `);
      }

      await runMailboxMigrations(db);

      const rows = await db.execute<{
        message_key: string;
        references: string[] | null;
      }>(sql`SELECT "message_key", "references"
             FROM "mailbox"."principal_mail" ORDER BY "message_key"`);
      expect(rows.map((r) => [r.message_key, r.references])).toEqual([
        ["refs-decoy", null],
        ["refs-folded", [
          "<root@acme.example>",
          "<middle@acme.example>",
          "<parent@acme.example>",
        ]],
        ["refs-none", null],
      ]);
    });
  });

  test("0002 backfill agrees with the runtime decoder on non-bracketed and multi-id In-Reply-To", async () => {
    // Characterization of the shared rule (see persist.ts): the FIRST
    // bracketed msg-id if present, else NULL. `parseMsgIdList` is what the
    // runtime path now uses too, so a frame decoded before or after the
    // upgrade projects the same cached `in_reply_to`.
    await fromEmpty(async ({ db }) => {
      await runMailboxMigrations(db);
      await db.execute(
        sql`ALTER TABLE "mailbox"."principal_mail"
            DROP COLUMN "message_id", DROP COLUMN "in_reply_to"`,
      );
      await db.execute(
        sql`DELETE FROM "mailbox"."corbits_mailbox_migrations"
            WHERE "id" = '0002_mail_threading_headers'`,
      );
      await seedScope(db, "acme", "user-1");
      const enc = new TextEncoder();
      const cases = [
        [
          "bare",
          "From: a@b.c\r\nMessage-ID: <x@acme.example>\r\nIn-Reply-To: foo@bar\r\n\r\nBody\r\n",
        ],
        [
          "multi",
          "From: a@b.c\r\nMessage-ID: <y@acme.example>\r\nIn-Reply-To: <a@x> <b@x>\r\n\r\nBody\r\n",
        ],
        [
          "folded",
          "From: a@b.c\r\nMessage-ID:\r\n <z@acme.example>\r\nIn-Reply-To:\r\n\t<p@x>\r\n\r\nBody\r\n",
        ],
        [
          "lf",
          "From: a@b.c\nMessage-ID: <lf@acme.example>\nIn-Reply-To: <p@x>\n\nMessage-ID: <body@x>\nBody\n",
        ],
      ] as const;
      for (const [key, text] of cases) {
        await db.execute(sql`
          INSERT INTO "mailbox"."principal_mail"
            ("tenant_id","principal_id","address","direction","raw","message_key")
          VALUES ('acme','user-1','user-1@acme.example','inbound',
                  ${Buffer.from(enc.encode(text))}, ${key})
        `);
      }
      await runMailboxMigrations(db);
      const rows = await db.execute<{
        message_key: string;
        message_id: string | null;
        in_reply_to: string | null;
      }>(
        sql`SELECT "message_key","message_id","in_reply_to"
            FROM "mailbox"."principal_mail" ORDER BY "message_key"`,
      );
      expect(
        rows.map((r) => [r.message_key, r.message_id, r.in_reply_to]),
      ).toEqual([
        ["bare", "<x@acme.example>", null],
        ["folded", "<z@acme.example>", "<p@x>"],
        ["lf", "<lf@acme.example>", "<p@x>"],
        ["multi", "<y@acme.example>", "<a@x>"],
      ]);
    });
  });

  test("is idempotent: running twice does not error and applies once", async () => {
    await fromEmpty(async ({ db }) => {
      await runMailboxMigrations(db);
      await runMailboxMigrations(db);

      const rows = await db.execute<{ id: string; count: string }>(
        sql`SELECT "id", count(*)::text AS count
            FROM "mailbox"."corbits_mailbox_migrations" GROUP BY "id" ORDER BY "id"`,
      );
      expect(rows.map((r) => [r.id, r.count])).toEqual([
        ["0001_principal_mailbox", "1"],
        ["0002_mail_threading_headers", "1"],
        ["0003_mail_references", "1"],
      ]);
    });
  });

  test("records a checksum per applied migration", async () => {
    await fromEmpty(async ({ db }) => {
      await runMailboxMigrations(db);
      const rows = await db.execute<{ id: string; checksum: string | null }>(
        sql`SELECT "id", "checksum" FROM "mailbox"."corbits_mailbox_migrations"`,
      );
      expect(rows.length).toBe(MIGRATIONS.length);
      for (const row of rows) {
        expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
      }
    });
  });

  test("refuses to boot when a shipped migration was edited after it applied", async () => {
    await fromEmpty(async ({ db }) => {
      await runMailboxMigrations(db);
      // Stand in for someone editing MIGRATIONS[0].statements in place: the
      // ledger now disagrees with the code, which is exactly the divergence
      // that used to be invisible — old environments skip the edit forever
      // while fresh ones get the new DDL.
      await db.execute(
        sql`UPDATE "mailbox"."corbits_mailbox_migrations"
            SET "checksum" = 'deadbeef' WHERE "id" = '0001_principal_mailbox'`,
      );
      // A NAMED error, matching both sibling cores: a host catching this to
      // tell "someone edited a migration" apart from "the database is down"
      // should not have to regex-match a message string.
      await expect(runMailboxMigrations(db)).rejects.toThrow(
        MigrationChecksumError,
      );
      await expect(runMailboxMigrations(db)).rejects.toThrow(
        /has changed since it was applied/,
      );
    });
  });

  test("has no nullable-checksum escape hatch in the ledger", async () => {
    await fromEmpty(async ({ db }) => {
      // The adopt-silently branch for "ledgers written before checksums
      // existed" is gone: 0.1.0 is the first public release, so no such ledger
      // can exist, and while the column was nullable the runner would accept
      // exactly one edit to a shipped migration without complaint. NOT NULL is
      // what makes the documented immutability guarantee unconditional.
      await runMailboxMigrations(db);
      // Drizzle wraps driver errors, so the NOT NULL violation is on `.cause`,
      // not on the message `toThrow` would match.
      const failure = await db
        .execute(
          sql`UPDATE "mailbox"."corbits_mailbox_migrations" SET "checksum" = NULL`,
        )
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(failure).not.toBeNull();
      expect(String((failure as { cause?: unknown }).cause)).toMatch(
        /null value in column "checksum"/,
      );
    });
  });

  test("creates its own ledger table distinct from any host table", async () => {
    await fromEmpty(async ({ db }) => {
      await runMailboxMigrations(db);
      const rows = await db.execute<{ exists: boolean }>(
        sql`SELECT EXISTS (SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'mailbox'
            AND table_name = 'corbits_mailbox_migrations') AS exists`,
      );
      expect(rows[0]?.exists).toBe(true);
    });
  });

  test("principal_mail's FKs are exactly the control-plane pair, both CASCADE", async () => {
    // The FKs are the reason there is no separate-database mode: a row can
    // only belong to a tenant and principal the host knows, and offboarding
    // either carries the mailbox rows out with it.
    await fromEmpty(async ({ db }) => {
      await runMailboxMigrations(db);
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

  test("mailbox FKs: its own mail plane plus the same control-plane pair", async () => {
    // The key to `principal_mail` is what makes a message and its triage state
    // one lifecycle; the scope FKs mirror the mail plane's for the same reason
    // they exist there.
    await fromEmpty(async ({ db }) => {
      await runMailboxMigrations(db);
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
         WHERE tc.table_schema = 'mailbox' AND tc.table_name = 'mailbox'
           AND tc.constraint_type = 'FOREIGN KEY'
         ORDER BY tc.constraint_name
      `);
      expect(
        rows.map((r) => [r.constraint_name, r.table_name, r.delete_rule]),
      ).toEqual([
        ["mailbox_id_fkey", "principal_mail", "CASCADE"],
        ["mailbox_principal_id_principal_id_fk", "principal", "CASCADE"],
        ["mailbox_tenant_id_tenant_id_fk", "tenant", "CASCADE"],
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
      await runMailboxMigrations(drizzle(client));
      const found = await admin.unsafe(
        `SELECT to_regclass('mailbox.principal_mail') AS t,
                to_regclass('mailbox.mailbox') AS m,
                to_regclass('mailbox.corbits_mailbox_migrations') AS l,
                to_regclass('mbx_elsewhere.principal_mail') AS stray`,
      );
      expect(found[0]!.t).not.toBeNull();
      expect(found[0]!.m).not.toBeNull();
      expect(found[0]!.l).not.toBeNull();
      expect(found[0]!.stray).toBeNull();
    } finally {
      await client.end();
      await admin.unsafe(`DROP SCHEMA IF EXISTS mbx_elsewhere CASCADE`);
    }
  });

  test("closing the handle it opened drains the pool", async () => {
    const { db, close } = createMailboxDb(TEST_DATABASE_URL);
    await runMailboxMigrations(db);
    await close();
    // A closed pool refuses further work rather than hanging the process.
    expect(async () => {
      await db.execute(sql`SELECT 1`);
    }).toThrow();
  });
});

describe("runMailboxMigrations under concurrent cold start", () => {
  // `CREATE TABLE IF NOT EXISTS` is NOT race-safe: the existence check and the
  // pg_type insert are not atomic, so without an advisory lock the losers crash
  // with 23505 on (typname, typnamespace). Pre-creating the ledger only moves
  // the collision to the principal_mailbox DDL.
  test("four instances booting at once all succeed", async () => {
    await dropMailboxSchema();
    const runners = Array.from({ length: 4 }, () => handle());
    const results = await Promise.allSettled(
      runners.map((r) => runMailboxMigrations(r.db)),
    );
    await Promise.all(runners.map((r) => r.client.end()));

    const failures = results.flatMap((r) =>
      r.status === "rejected" ? [String((r.reason as Error).message)] : [],
    );
    expect(failures).toEqual([]);

    const ledger = await admin.unsafe(
      `SELECT id FROM mailbox.corbits_mailbox_migrations ORDER BY id`,
    );
    expect(ledger.map((r) => r.id)).toEqual([
      "0001_principal_mailbox",
      "0002_mail_threading_headers",
      "0003_mail_references",
    ]);
  });

  test("a second wave against an already-migrated schema is a no-op for all", async () => {
    await dropMailboxSchema();
    const first = handle();
    await runMailboxMigrations(first.db);
    await first.client.end();

    const runners = Array.from({ length: 3 }, () => handle());
    const results = await Promise.allSettled(
      runners.map((r) => runMailboxMigrations(r.db)),
    );
    await Promise.all(runners.map((r) => r.client.end()));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });
});
