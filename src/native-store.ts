import { sql } from "drizzle-orm";
import type { MailboxStore, StoredEnvelope, StoredMessage } from "@intx/mailbox";
import type { MailboxDb } from "./db.js";

// drizzle's `sql` tag spreads a bare array interpolation as a comma-separated
// list of its own parameters (empty renders as the syntax error `()`) rather
// than binding it as one `text[]` value — the same reason `sql.join` exists
// for IN-lists. A Postgres array literal cast is what actually binds as a
// single `text[]` parameter.
function pgTextArrayLiteral(items: readonly string[]): string {
  const escape = (item: string) =>
    `"${item.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `{${items.map(escape).join(",")}}`;
}

/**
 * A `MailboxStore` (see `vendor/intx-mailbox/src/mailbox.ts`) backed by the
 * `mailbox.principal_mail` / `mailbox.mailbox_state` tables migration
 * `0004_native_mailbox_store` added, instead of an in-process array. One
 * instance is scoped to a single (tenant, principal, folder) mailbox, which is
 * the same scope the vendored `executeSearch`/`executeThread` pure functions
 * already assume (`mailboxName` names the one mailbox `store.messages` holds).
 *
 * Deliberately reads via plain tagged `sql`, not the `schema.ts` drizzle table
 * objects: those objects are pinned by `schema-check.ts` and
 * `schema-ddl-parity.test.ts` to the columns the OLD read/write paths depend
 * on, and this slice must not widen what those assert.
 *
 * `MailboxStore`'s mutating methods (`append`/`addFlags`/`removeFlags`/
 * `remove`) are synchronous in the vendored interface — an in-memory backing
 * can satisfy that trivially, a Postgres-backed one cannot make the write
 * durable before returning. This backing keeps a fully materialized in-memory
 * mirror (loaded once by `openNativeMailboxStore`) so every synchronous method
 * answers from it immediately and stays interface-correct, while queuing the
 * matching Postgres statement onto `store.settled` — a promise every write
 * chains onto, in order, so two writes for the same mailbox never race each
 * other at the database. Call `await store.settled` before trusting a write
 * has actually landed (every test in `native-store.test.ts` does).
 */
export type NativeMailboxStore = MailboxStore & {
  readonly tenantId: string;
  readonly principalId: string;
  readonly folder: string;
  /** Resolves once every write queued so far has been applied to Postgres. */
  readonly settled: Promise<void>;
};

type Row = {
  id: string;
  uid: string | number;
  modseq: string | number;
  flags: string[];
  raw: Uint8Array;
  subject: string | null;
  from_address: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  references: unknown;
  created_at: Date;
};

function toEnvelope(row: Row): StoredEnvelope {
  const references = Array.isArray(row.references)
    ? (row.references as string[])
    : [];
  return {
    messageId: row.message_id ?? "",
    from: row.from_address ?? "",
    to: [],
    subject: row.subject ?? "",
    date: row.created_at,
    inReplyTo: row.in_reply_to ?? undefined,
    references,
    interchangeType: undefined,
    interchangeCorrelationId: undefined,
  };
}

function toStoredMessage(row: Row): StoredMessage & { rowId: string } {
  return {
    rowId: row.id,
    uid: Number(row.uid),
    modseq: Number(row.modseq),
    flags: new Set(row.flags),
    envelope: toEnvelope(row),
  };
}

async function readState(
  db: MailboxDb,
  tenantId: string,
  principalId: string,
  folder: string,
): Promise<{ uidValidity: number; uidNext: number; highestModSeq: number }> {
  const rows = await db.execute<{
    uid_validity: string | number;
    uid_next: string | number;
    highest_modseq: string | number;
  }>(sql`
    SELECT "uid_validity", "uid_next", "highest_modseq"
    FROM "mailbox"."mailbox_state"
    WHERE "tenant_id" = ${tenantId} AND "principal_id" = ${principalId} AND "folder" = ${folder}
  `);
  if (rows[0] !== undefined) {
    return {
      uidValidity: Number(rows[0].uid_validity),
      uidNext: Number(rows[0].uid_next),
      highestModSeq: Number(rows[0].highest_modseq),
    };
  }
  const uidValidity = Math.floor(Date.now() / 1000);
  await db.execute(sql`
    INSERT INTO "mailbox"."mailbox_state"
      ("tenant_id", "principal_id", "folder", "uid_validity", "uid_next", "highest_modseq")
    VALUES (${tenantId}, ${principalId}, ${folder}, ${uidValidity}, 1, 0)
    ON CONFLICT ("tenant_id", "principal_id", "folder") DO NOTHING
  `);
  return { uidValidity, uidNext: 1, highestModSeq: 0 };
}

/**
 * Load a `NativeMailboxStore` for one (tenant, principal, folder) mailbox:
 * fetches its counters and materializes every stored message into memory.
 * Call again (a fresh instance) to observe writes made by another instance
 * once their `settled` promise has resolved — this store does not itself
 * poll or subscribe.
 */
export async function openNativeMailboxStore(
  db: MailboxDb,
  scope: { tenantId: string; principalId: string; folder: string },
): Promise<NativeMailboxStore> {
  const { tenantId, principalId, folder } = scope;
  const state = await readState(db, tenantId, principalId, folder);

  const rows = await db.execute<Row>(sql`
    SELECT "id", "uid", "modseq", "flags", "raw", "subject", "from_address",
           "message_id", "in_reply_to", "references", "created_at"
    FROM "mailbox"."principal_mail"
    WHERE "tenant_id" = ${tenantId} AND "principal_id" = ${principalId} AND "folder" = ${folder}
    ORDER BY "uid" ASC
  `);
  const messages: (StoredMessage & { rowId: string })[] = rows.map(toStoredMessage);
  const byUid = new Map(messages.map((m) => [m.uid, m]));

  // Every queued write chains onto the last, so two writes to the same
  // mailbox are applied to Postgres in the order they were made in memory,
  // never racing each other. `settled` always resolves (never rejects) so one
  // failed write does not wedge every later one from being attempted; a
  // caller that needs to observe a failure awaits the promise `enqueue`
  // itself was given, not `store.settled`.
  let settled: Promise<void> = Promise.resolve();
  function enqueue(work: () => Promise<unknown>): void {
    settled = settled.then(work).then(
      () => undefined,
      () => undefined,
    );
  }

  function requireMessage(uid: number): StoredMessage & { rowId: string } {
    const msg = byUid.get(uid);
    if (msg === undefined) {
      throw new Error(`Message UID ${uid} not found in mailbox "${folder}"`);
    }
    return msg;
  }

  const store: NativeMailboxStore = {
    tenantId,
    principalId,
    folder,
    uidValidity: state.uidValidity,
    get uidNext() {
      return state.uidNext;
    },
    get highestModSeq() {
      return state.highestModSeq;
    },
    get messages() {
      return messages;
    },
    get settled() {
      return settled;
    },

    append(raw, envelope, flags) {
      const uid = state.uidNext;
      const modseq = state.highestModSeq + 1;
      state.uidNext += 1;
      state.highestModSeq = modseq;
      const rowId = crypto.randomUUID();
      const message: StoredMessage & { rowId: string } = {
        rowId,
        uid,
        modseq,
        flags: new Set(flags),
        envelope,
      };
      messages.push(message);
      byUid.set(uid, message);

      enqueue(() =>
        db.execute(sql`
          INSERT INTO "mailbox"."principal_mail"
            ("id", "tenant_id", "principal_id", "address", "direction", "raw",
             "subject", "from_address", "message_id", "in_reply_to", "references",
             "created_at", "folder", "uid", "modseq", "flags")
          VALUES (
            ${rowId}, ${tenantId}, ${principalId}, ${envelope.from || envelope.to[0] || ""},
            'inbound', ${Buffer.from(raw)}, ${envelope.subject}, ${envelope.from},
            ${envelope.messageId || null}, ${envelope.inReplyTo ?? null},
            ${envelope.references.length > 0 ? JSON.stringify(envelope.references) : null},
            ${envelope.date.toISOString()}, ${folder}, ${uid}, ${modseq}, ${pgTextArrayLiteral(flags)}::text[]
          )
        `).then(() =>
          db.execute(sql`
            UPDATE "mailbox"."mailbox_state"
            SET "uid_next" = ${state.uidNext}, "highest_modseq" = ${state.highestModSeq}
            WHERE "tenant_id" = ${tenantId} AND "principal_id" = ${principalId} AND "folder" = ${folder}
          `),
        ),
      );
      return uid;
    },

    async readRaw(uid) {
      await settled;
      const rows2 = await db.execute<{ raw: Uint8Array }>(sql`
        SELECT "raw" FROM "mailbox"."principal_mail"
        WHERE "tenant_id" = ${tenantId} AND "principal_id" = ${principalId}
          AND "folder" = ${folder} AND "uid" = ${uid}
      `);
      if (rows2[0] === undefined) {
        throw new Error(`Message UID ${uid} not found`);
      }
      return new Uint8Array(rows2[0].raw);
    },

    find(uid) {
      return byUid.get(uid);
    },

    addFlags(uid, flags) {
      const msg = requireMessage(uid);
      for (const flag of flags) msg.flags.add(flag);
      const modseq = state.highestModSeq + 1;
      state.highestModSeq = modseq;
      msg.modseq = modseq;
      const nextFlags = [...msg.flags];
      enqueue(() =>
        db.execute(sql`
          UPDATE "mailbox"."principal_mail"
          SET "flags" = ${pgTextArrayLiteral(nextFlags)}::text[], "modseq" = ${modseq}
          WHERE "id" = ${msg.rowId}
        `).then(() =>
          db.execute(sql`
            UPDATE "mailbox"."mailbox_state" SET "highest_modseq" = ${modseq}
            WHERE "tenant_id" = ${tenantId} AND "principal_id" = ${principalId} AND "folder" = ${folder}
          `),
        ),
      );
      return msg;
    },

    removeFlags(uid, flags) {
      const msg = requireMessage(uid);
      for (const flag of flags) msg.flags.delete(flag);
      const modseq = state.highestModSeq + 1;
      state.highestModSeq = modseq;
      msg.modseq = modseq;
      const nextFlags = [...msg.flags];
      enqueue(() =>
        db.execute(sql`
          UPDATE "mailbox"."principal_mail"
          SET "flags" = ${pgTextArrayLiteral(nextFlags)}::text[], "modseq" = ${modseq}
          WHERE "id" = ${msg.rowId}
        `).then(() =>
          db.execute(sql`
            UPDATE "mailbox"."mailbox_state" SET "highest_modseq" = ${modseq}
            WHERE "tenant_id" = ${tenantId} AND "principal_id" = ${principalId} AND "folder" = ${folder}
          `),
        ),
      );
      return msg;
    },

    remove(uid) {
      const msg = requireMessage(uid);
      const idx = messages.indexOf(msg);
      messages.splice(idx, 1);
      byUid.delete(uid);
      enqueue(() =>
        db.execute(sql`
          DELETE FROM "mailbox"."principal_mail" WHERE "id" = ${msg.rowId}
        `),
      );
    },
  };

  return store;
}

/**
 * Move a message from one folder to another for the same (tenant, principal).
 * Not part of the vendored `MailboxStore` interface — IMAP MOVE reassigns a
 * fresh UID in the destination mailbox and bumps ITS counters, which needs
 * both folders' `mailbox_state` rows, so this operates directly on the
 * database rather than through two `NativeMailboxStore` instances (each of
 * which only knows its own folder's counters). Returns the message's new uid
 * in `toFolder`. Any already-open `NativeMailboxStore` for either folder must
 * be reopened with `openNativeMailboxStore` to see the result.
 */
export async function moveNativeMailboxMessage(
  db: MailboxDb,
  scope: { tenantId: string; principalId: string },
  fromFolder: string,
  uid: number,
  toFolder: string,
): Promise<number> {
  const { tenantId, principalId } = scope;
  const rows = await db.execute<{ id: string }>(sql`
    SELECT "id" FROM "mailbox"."principal_mail"
    WHERE "tenant_id" = ${tenantId} AND "principal_id" = ${principalId}
      AND "folder" = ${fromFolder} AND "uid" = ${uid}
  `);
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Message UID ${uid} not found in mailbox "${fromFolder}"`);
  }

  await readState(db, tenantId, principalId, toFolder);
  const bumped = await db.execute<{
    uid_next: string | number;
    highest_modseq: string | number;
  }>(sql`
    UPDATE "mailbox"."mailbox_state"
    SET "uid_next" = "uid_next" + 1, "highest_modseq" = "highest_modseq" + 1
    WHERE "tenant_id" = ${tenantId} AND "principal_id" = ${principalId} AND "folder" = ${toFolder}
    RETURNING "uid_next" - 1 AS "uid_next", "highest_modseq"
  `);
  const newUid = Number(bumped[0]!.uid_next);
  const newModseq = Number(bumped[0]!.highest_modseq);

  await db.execute(sql`
    UPDATE "mailbox"."principal_mail"
    SET "folder" = ${toFolder}, "uid" = ${newUid}, "modseq" = ${newModseq}
    WHERE "id" = ${row.id}
  `);
  await db.execute(sql`
    UPDATE "mailbox"."mailbox_state"
    SET "highest_modseq" = "highest_modseq" + 1
    WHERE "tenant_id" = ${tenantId} AND "principal_id" = ${principalId} AND "folder" = ${fromFolder}
  `);
  return newUid;
}

/**
 * Entry point matching the task's shape: a factory scoped to one (tenant,
 * principal) that opens per-folder `NativeMailboxStore`s and can move a
 * message between them.
 */
export function createPrincipalMailboxStore(
  db: MailboxDb,
  scope: { tenantId: string; principalId: string },
): {
  open(folder: string): Promise<NativeMailboxStore>;
  move(fromFolder: string, uid: number, toFolder: string): Promise<number>;
} {
  return {
    open: (folder) => openNativeMailboxStore(db, { ...scope, folder }),
    move: (fromFolder, uid, toFolder) =>
      moveNativeMailboxMessage(db, scope, fromFolder, uid, toFolder),
  };
}
