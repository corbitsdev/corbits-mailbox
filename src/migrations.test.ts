// Migration idempotency and the legacy-row backfills: a replay or a cold
// start that breaks here corrupts every deployed host's mail on upgrade.
import { describe, expect, test } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { applyMailboxMigrations } from "./migrations.js";
import { buildMailFrame } from "./frame.js";
import {
  seedScope,
  TEST_DATABASE_URL,
  handle,
  migrationSandbox,
} from "../e2e/helpers.js";

const { admin, dropMailboxSchema, fromEmpty } = migrationSandbox();

describe("legacy-row backfills", () => {
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
});

describe("replay", () => {
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
