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
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  applyMailboxMigrations,
  runMailboxMigrations,
} from "./migrations.js";
import { buildMailFrame } from "./frame.js";
import { principalMail } from "./schema.js";
import {
  expectedColumnTypes,
  SchemaTypeMismatchError,
} from "./schema-check.js";
import {
  createHostControlPlane,
  createMailboxDb,
  dbConfigFromUrl,
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
  await dropMailboxSchema();
  await applyMailboxMigrations(adminDb, "public");
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

  test("0004 carries folder and \\Seen out of a pre-0.1.0 mailbox table", async () => {
    await fromEmpty(async ({ db }) => {
      // Rebuild the pre-0.1.0 shape: no IMAP columns, no counters, and the
      // management table that held read/archive/trash state.
      await applyMailboxMigrations(db, "public");
      await db.execute(sql`DROP TABLE "mailbox"."mailbox_state"`);
      await db.execute(
        sql`ALTER TABLE "mailbox"."principal_mail"
            DROP COLUMN "folder", DROP COLUMN "uid",
            DROP COLUMN "modseq", DROP COLUMN "flags"`,
      );
      await db.execute(sql`CREATE TABLE "mailbox"."mailbox" (
        "id" text PRIMARY KEY,
        "read_at" timestamp,
        "archived_at" timestamp,
        "trashed_at" timestamp
      )`);
      await seedScope(db, "acme", "user-1");
      const raw = Buffer.from(
        "From: bot@acme.example\r\nSubject: legacy\r\n\r\nBody\r\n",
      );
      for (const id of ["read", "archived", "trashed", "both", "untouched"]) {
        await db.execute(sql`
          INSERT INTO "mailbox"."principal_mail"
            ("id","tenant_id","principal_id","address","direction","raw")
          VALUES (${id},'acme','user-1','user-1@acme.example','inbound',${raw})
        `);
      }
      await db.execute(sql`
        INSERT INTO "mailbox"."mailbox" ("id","read_at","archived_at","trashed_at")
        VALUES ('read', now(), NULL, NULL),
               ('archived', NULL, now(), NULL),
               ('trashed', now(), NULL, now()),
               ('both', NULL, now(), now()),
               ('untouched', NULL, NULL, NULL)
      `);

      await applyMailboxMigrations(db, "public");

      const rows = await db.execute<{ id: string; folder: string; flags: string[] }>(
        sql`SELECT "id", "folder", "flags" FROM "mailbox"."principal_mail" ORDER BY "id"`,
      );
      expect([...rows]).toEqual([
        { id: "archived", folder: "Archive", flags: [] },
        { id: "both", folder: "Trash", flags: [] },
        { id: "read", folder: "INBOX", flags: ["\\Seen"] },
        { id: "trashed", folder: "Trash", flags: ["\\Seen"] },
        { id: "untouched", folder: "INBOX", flags: [] },
      ]);
    });
  });

  test("0002 backfills the threading headers from legacy rows' raw", async () => {
    // The state every already-deployed host is in at upgrade: rows written
    // before the cached columns existed, so `raw` carries the headers and the
    // columns are NULL. Without the backfill, threading would silently begin at
    // the upgrade and every older message would project no parent.
    await fromEmpty(async ({ db }) => {
      // Build the pre-0002 schema, then seed through it.
      await applyMailboxMigrations(db, "public");
      await db.execute(
        sql`ALTER TABLE "mailbox"."principal_mail"
            DROP COLUMN "message_id", DROP COLUMN "in_reply_to"`,
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
      for (const [i, [key, raw]] of [
        ["legacy-threaded", threaded],
        ["legacy-headerless", headerless],
        ["legacy-invalid-utf8", invalidUtf8],
      ].entries() as IterableIterator<[number, readonly [string, Uint8Array]]>) {
        // uid/modseq are NOT NULL as of 0005 — supplied explicitly since these
        // rows simulate pre-native legacy inserts that predate the native
        // store's own uid assignment.
        await db.execute(sql`
          INSERT INTO "mailbox"."principal_mail"
            ("tenant_id","principal_id","address","direction","raw","message_key","uid","modseq")
          VALUES ('acme','user-1','user-1@acme.example','inbound',
                  ${Buffer.from(raw)}, ${key}, ${i + 1}, ${i + 1})
        `);
      }

      await applyMailboxMigrations(db, "public");

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
    // with it the boot), which meant every subsequent boot failed
    // forever. This is RED against the pre-fix backfill (LATIN1-decoding the
    // entire `raw`, NUL included) and GREEN once only the NUL-stripped header
    // slice reaches `convert_from`.
    await fromEmpty(async ({ db }) => {
      await applyMailboxMigrations(db, "public");
      await db.execute(
        sql`ALTER TABLE "mailbox"."principal_mail"
            DROP COLUMN "message_id", DROP COLUMN "in_reply_to"`,
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
      for (const [i, [key, raw]] of [
        ["nul-ok", ok],
        ["nul-body", nulBody],
      ].entries() as IterableIterator<[number, readonly [string, Uint8Array]]>) {
        await db.execute(sql`
          INSERT INTO "mailbox"."principal_mail"
            ("tenant_id","principal_id","address","direction","raw","message_key","uid","modseq")
          VALUES ('acme','user-1','user-1@acme.example','inbound',
                  ${Buffer.from(raw)}, ${key}, ${i + 1}, ${i + 1})
        `);
      }

      await applyMailboxMigrations(db, "public");

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
      await applyMailboxMigrations(db, "public");
      await db.execute(
        sql`ALTER TABLE "mailbox"."principal_mail" DROP COLUMN "references"`,
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
      for (const [i, [key, raw]] of [
        ["refs-folded", folded],
        ["refs-none", none],
        ["refs-decoy", decoy],
      ].entries() as IterableIterator<[number, readonly [string, Uint8Array]]>) {
        await db.execute(sql`
          INSERT INTO "mailbox"."principal_mail"
            ("tenant_id","principal_id","address","direction","raw","message_key","uid","modseq")
          VALUES ('acme','user-1','user-1@acme.example','inbound',
                  ${Buffer.from(raw)}, ${key}, ${i + 1}, ${i + 1})
        `);
      }

      await applyMailboxMigrations(db, "public");

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
      await applyMailboxMigrations(db, "public");
      await db.execute(
        sql`ALTER TABLE "mailbox"."principal_mail"
            DROP COLUMN "message_id", DROP COLUMN "in_reply_to"`,
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
      for (const [i, [key, text]] of cases.entries()) {
        await db.execute(sql`
          INSERT INTO "mailbox"."principal_mail"
            ("tenant_id","principal_id","address","direction","raw","message_key","uid","modseq")
          VALUES ('acme','user-1','user-1@acme.example','inbound',
                  ${Buffer.from(enc.encode(text))}, ${key}, ${i + 1}, ${i + 1})
        `);
      }
      await applyMailboxMigrations(db, "public");
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

  test("replays every file: a second run changes nothing and keeps no ledger", async () => {
    await fromEmpty(async ({ db }) => {
      await applyMailboxMigrations(db, "public");
      await applyMailboxMigrations(db, "public");
      const [row] = await db.execute<{ ledger: string | null }>(
        sql`SELECT to_regclass('"mailbox"."corbits_mailbox_migrations"')::text AS ledger`,
      );
      expect(row?.ledger).toBeNull();
    });
  });

  test("a replay takes no table lock that would block mail reads or writes", async () => {
    await fromEmpty(async ({ client, db }) => {
      await applyMailboxMigrations(db, "public");
      await client.begin(async (tx) => {
        // Held open, so any lock the replay requests on principal_mail waits.
        await tx`LOCK TABLE "mailbox"."principal_mail", "mailbox"."mailbox_state" IN ROW EXCLUSIVE MODE`;
        const replay = postgres(TEST_DATABASE_URL, {
          max: 1,
          onnotice: () => {},
          connection: { lock_timeout: 2000 },
        });
        try {
          await applyMailboxMigrations(drizzle(replay), "public");
        } finally {
          await replay.end();
        }
      });
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

describe("applyMailboxMigrations under concurrent cold start", () => {
  // `CREATE TABLE IF NOT EXISTS` is NOT race-safe: the existence check and the
  // pg_type insert are not atomic, so without an advisory lock the losers crash
  // with 23505 on (typname, typnamespace).
  test("four instances booting at once all succeed", async () => {
    await dropMailboxSchema();
    const runners = Array.from({ length: 4 }, () => handle());
    const results = await Promise.allSettled(
      runners.map((r) => applyMailboxMigrations(r.db, "public")),
    );
    await Promise.all(runners.map((r) => r.client.end()));

    const failures = results.flatMap((r) =>
      r.status === "rejected" ? [String((r.reason as Error).message)] : [],
    );
    expect(failures).toEqual([]);

    const [found] = await admin.unsafe(
      `SELECT to_regclass('mailbox.mailbox_state') AS t`,
    );
    expect(found!.t).not.toBeNull();
  });

  test("a second wave against an already-migrated schema is a no-op for all", async () => {
    await dropMailboxSchema();
    const first = handle();
    await applyMailboxMigrations(first.db, "public");
    await first.client.end();

    const runners = Array.from({ length: 3 }, () => handle());
    const results = await Promise.allSettled(
      runners.map((r) => applyMailboxMigrations(r.db, "public")),
    );
    await Promise.all(runners.map((r) => r.client.end()));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
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

describe("expectedColumnTypes", () => {
  test("is derived from the drizzle tables: the mail plane alone, since 0005 dropped the management table", () => {
    const tables = new Set(expectedColumnTypes().map((e) => e.table));
    expect(tables).toEqual(new Set(["principal_mail"]));
  });

  test("expects zoneless timestamps and text ids on every relevant column", () => {
    const byKey = new Map(
      expectedColumnTypes().map((e) => [`${e.table}.${e.column}`, e.dataType]),
    );
    expect(byKey.get("principal_mail.created_at")).toBe(
      "timestamp without time zone",
    );
    expect(byKey.get("principal_mail.id")).toBe("text");
    expect(byKey.get("principal_mail.raw")).toBe("bytea");
    expect(byKey.get("principal_mail.refs")).toBe("jsonb");
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
