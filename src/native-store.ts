import { sql, TransactionRollbackError } from "drizzle-orm";
import type {
  MailboxStore,
  StoredEnvelope,
  StoredMessage,
} from "@intx/mailbox";
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
 * A `MailboxStore` (see `@intx/mailbox`'s `mailbox.ts`) backed by the
 * `mailbox.principal_mail` / `mailbox.mailbox_state` tables migration
 * `0004_native_mailbox_store` added, instead of an in-process array. One
 * instance is scoped to a single (tenant, principal, folder) mailbox, which is
 * the same scope `@intx/mailbox`'s `executeSearch`/`executeThread` pure
 * functions already assume (`mailboxName` names the one mailbox
 * `store.messages` holds).
 *
 * Reads via plain tagged `sql`, not the `schema.ts` drizzle table objects:
 * `schema-check.ts` asserts those objects against the live columns at boot,
 * so they stay limited to what that check needs.
 *
 * `MailboxStore`'s mutating methods (`append`/`addFlags`/`removeFlags`/
 * `remove`) are synchronous in `@intx/mailbox`'s interface — an in-memory backing
 * can satisfy that trivially, a Postgres-backed one cannot make the write
 * durable before returning. This backing keeps a fully materialized in-memory
 * mirror (loaded once by `openNativeMailboxStore`) so every synchronous method
 * answers from it immediately and stays interface-correct, while queuing the
 * matching Postgres statement onto `store.settled` — a promise every write
 * chains onto, in order, so two writes for the same mailbox never race each
 * other at the database. Call `await store.settled` before trusting a write
 * has actually landed (every test in `native-store.test.ts` does).
 *
 * `settled` never rejects, and `append` must return its uid synchronously, so
 * it takes the uid from this instance's counter and cannot allocate it
 * atomically: two instances appending at once collide on the unique uid index
 * and the later write is lost. Hosts write through `appendMessage`,
 * `writeMailboxMessage` or `createMailboxPersist` instead, which allocate the
 * uid from `mailbox_state` inside the insert's transaction and reject when the
 * insert fails.
 */
export type NativeMailboxStore = MailboxStore & {
  readonly tenantId: string;
  readonly principalId: string;
  readonly folder: string;
  /** Resolves once every write queued so far has been applied to Postgres. */
  readonly settled: Promise<void>;
  /**
   * Appends with a uid allocated atomically in Postgres. Resolves to that uid
   * once the row has landed, or to `null` when this mailbox already holds the
   * envelope's Message-ID from `sender`, the host-authorized envelope sender.
   * Rejects when the insert fails.
   */
  appendMessage(
    raw: Uint8Array,
    envelope: StoredEnvelope,
    flags: string[],
    sender: string,
  ): Promise<number | null>;
};

// Postgres text and jsonb refuse U+0000, so a NUL in any cached header or
// envelope field would fail the whole insert. `raw` keeps every byte.
function withoutNul(value: string): string {
  return value.replaceAll("\0", "");
}

function cleanEnvelope(envelope: StoredEnvelope): StoredEnvelope {
  return {
    messageId: withoutNul(envelope.messageId),
    from: withoutNul(envelope.from),
    to: envelope.to.map(withoutNul),
    subject: withoutNul(envelope.subject),
    date: envelope.date,
    inReplyTo:
      envelope.inReplyTo === undefined
        ? undefined
        : withoutNul(envelope.inReplyTo),
    references: envelope.references.map(withoutNul),
    interchangeType: envelope.interchangeType,
    interchangeCorrelationId: envelope.interchangeCorrelationId,
  };
}

type Row = {
  id: string;
  uid: string | number;
  modseq: string | number;
  flags: string[];
  subject: string | null;
  from_address: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  references: unknown;
  to_addresses: unknown;
  // Text, not Date: drizzle's postgres-js driver disables the wire-protocol
  // type parser for every timestamp OID (including timestamptz), so the
  // driver always hands back raw text — formatted below with an explicit
  // 'Z' so `new Date(...)` reads it as UTC regardless of the query's or
  // host's session timezone.
  created_at: string;
};

function toEnvelope(row: Row): StoredEnvelope {
  const references = Array.isArray(row.references)
    ? (row.references as string[])
    : [];
  const to = Array.isArray(row.to_addresses)
    ? (row.to_addresses as string[])
    : [];
  return {
    messageId: row.message_id ?? "",
    from: row.from_address ?? "",
    to,
    subject: row.subject ?? "",
    date: new Date(row.created_at),
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
  db: Pick<MailboxDb, "execute">,
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

  // Column is `timestamp without time zone` holding UTC. drizzle's postgres-js
  // driver returns every timestamp column as raw text (its type parser is
  // disabled for those OIDs), and a bare value would come back ambiguous — so
  // format it as an explicit UTC instant here rather than trust the caller's
  // (or postgres session's) local timezone to reinterpret it. The column is
  // a naive UTC value, so no AT TIME ZONE: that would re-render it in the
  // session zone. Never cast inside WHERE — that would break the index.
  const rows = await db.execute<Row>(sql`
    SELECT "id", "uid", "modseq", "flags", "subject", "from_address",
           "message_id", "in_reply_to", "references", "to_addresses",
           to_char("created_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "created_at"
    FROM "mailbox"."principal_mail"
    WHERE "tenant_id" = ${tenantId} AND "principal_id" = ${principalId} AND "folder" = ${folder}
    ORDER BY "uid" ASC
  `);
  const messages: (StoredMessage & { rowId: string })[] =
    rows.map(toStoredMessage);
  const byUid = new Map(messages.map((m) => [m.uid, m]));

  // Every queued write chains onto the last, so two writes to the same
  // mailbox are applied to Postgres in the order they were made in memory,
  // never racing each other. `settled` always resolves (never rejects) so one
  // failed write does not wedge every later one from being attempted; a
  // caller that needs to observe a failure awaits the promise `enqueue`
  // returns, not `store.settled`.
  let settled: Promise<void> = Promise.resolve();
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const done = settled.then(work);
    settled = done.then(
      () => undefined,
      () => undefined,
    );
    return done;
  }

  function requireMessage(uid: number): StoredMessage & { rowId: string } {
    const msg = byUid.get(uid);
    if (msg === undefined) {
      throw new Error(`Message UID ${uid} not found in mailbox "${folder}"`);
    }
    return msg;
  }

  function append(
    raw: Uint8Array,
    rawEnvelope: StoredEnvelope,
    flags: string[],
  ) {
    const envelope = cleanEnvelope(rawEnvelope);
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
      db.transaction(async (tx) => {
        await tx.execute(sql`
          INSERT INTO "mailbox"."principal_mail"
            ("id", "tenant_id", "principal_id", "address", "direction", "raw",
             "subject", "from_address", "sender_address", "message_id", "in_reply_to",
             "references", "to_addresses", "created_at", "folder", "uid", "modseq", "flags")
          VALUES (
            ${rowId}, ${tenantId}, ${principalId}, ${envelope.from || envelope.to[0] || ""},
            'inbound', ${Buffer.from(raw)}, ${envelope.subject}, ${envelope.from},
            ${envelope.from}, ${envelope.messageId || null}, ${envelope.inReplyTo ?? null},
            ${envelope.references.length > 0 ? JSON.stringify(envelope.references) : null},
            ${envelope.to.length > 0 ? JSON.stringify(envelope.to) : null},
            ${envelope.date.toISOString()}, ${folder}, ${uid}, ${modseq}, ${pgTextArrayLiteral(flags)}::text[]
          )
        `);
        await tx.execute(sql`
          UPDATE "mailbox"."mailbox_state"
          SET "uid_next" = GREATEST("uid_next", ${uid + 1}),
              "highest_modseq" = GREATEST("highest_modseq", ${modseq})
          WHERE "tenant_id" = ${tenantId} AND "principal_id" = ${principalId} AND "folder" = ${folder}
        `);
      }),
    );
    return uid;
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

    append,

    async appendMessage(raw, rawEnvelope, flags, sender) {
      const envelope = cleanEnvelope(rawEnvelope);
      const rowId = crypto.randomUUID();
      const landed = await enqueue(() =>
        db.transaction(async (tx) => {
          const [counters] = await tx.execute<{
            uid: string | number;
            modseq: string | number;
          }>(sql`
            UPDATE "mailbox"."mailbox_state"
            SET "uid_next" = "uid_next" + 1, "highest_modseq" = "highest_modseq" + 1
            WHERE "tenant_id" = ${tenantId} AND "principal_id" = ${principalId} AND "folder" = ${folder}
            RETURNING "uid_next" - 1 AS "uid", "highest_modseq" AS "modseq"
          `);
          const uid = Number(counters!.uid);
          const modseq = Number(counters!.modseq);
          // The mailbox_state row lock taken above serializes appends to this
          // mailbox, so a concurrent writer with the same Message-ID has
          // either committed (and this conflicts) or waits behind this one.
          const inserted = await tx.execute(sql`
            INSERT INTO "mailbox"."principal_mail"
              ("id", "tenant_id", "principal_id", "address", "direction", "raw",
               "subject", "from_address", "sender_address", "message_id", "in_reply_to",
               "references", "to_addresses", "created_at", "folder", "uid", "modseq", "flags")
            VALUES (
              ${rowId}, ${tenantId}, ${principalId}, ${envelope.from || envelope.to[0] || ""},
              'inbound', ${Buffer.from(raw)}, ${envelope.subject}, ${envelope.from},
              ${withoutNul(sender)}, ${envelope.messageId || null}, ${envelope.inReplyTo ?? null},
              ${envelope.references.length > 0 ? JSON.stringify(envelope.references) : null},
              ${envelope.to.length > 0 ? JSON.stringify(envelope.to) : null},
              ${envelope.date.toISOString()}, ${folder}, ${uid}, ${modseq}, ${pgTextArrayLiteral(flags)}::text[]
            )
            ON CONFLICT ("tenant_id", "principal_id", "folder", "message_id", "sender_address")
              WHERE "message_id" IS NOT NULL
              DO NOTHING
            RETURNING "id"
          `);
          if (inserted.length === 0) {
            tx.rollback();
          }
          return { uid, modseq };
        }),
      ).catch((err: unknown) => {
        if (err instanceof TransactionRollbackError) return null;
        throw err;
      });
      if (landed === null) return null;

      const { uid, modseq } = landed;
      state.uidNext = Math.max(state.uidNext, uid + 1);
      state.highestModSeq = Math.max(state.highestModSeq, modseq);
      const message: StoredMessage & { rowId: string } = {
        rowId,
        uid,
        modseq,
        flags: new Set(flags),
        envelope,
      };
      messages.push(message);
      byUid.set(uid, message);
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
        db
          .execute(sql`
          UPDATE "mailbox"."principal_mail"
          SET "flags" = ${pgTextArrayLiteral(nextFlags)}::text[], "modseq" = ${modseq}
          WHERE "id" = ${msg.rowId}
        `)
          .then(() =>
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
        db
          .execute(sql`
          UPDATE "mailbox"."principal_mail"
          SET "flags" = ${pgTextArrayLiteral(nextFlags)}::text[], "modseq" = ${modseq}
          WHERE "id" = ${msg.rowId}
        `)
          .then(() =>
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

/** `moveNativeMailboxMessage` found no message with that uid. */
export class MailboxMessageNotFoundError extends Error {
  override name = "MailboxMessageNotFoundError";
}

/**
 * Move a message from one folder to another for the same (tenant, principal).
 * Not part of `@intx/mailbox`'s `MailboxStore` interface — IMAP MOVE reassigns a
 * fresh UID in the destination mailbox and bumps ITS counters, which needs
 * both folders' `mailbox_state` rows, so this operates directly on the
 * database rather than through two `NativeMailboxStore` instances (each of
 * which only knows its own folder's counters). Returns the message's new uid
 * in `toFolder`, in one transaction, so a move that fails (the uid is not in
 * `fromFolder`, or `toFolder` already holds its Message-ID from the same
 * sender) changes nothing. Any already-open `NativeMailboxStore` for either folder must
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
  return db.transaction(async (tx) => {
    // Lock both folders' state rows in one fixed order, so moves in opposite
    // directions queue instead of deadlocking.
    await readState(tx, tenantId, principalId, toFolder);
    await tx.execute(sql`
      SELECT 1 FROM "mailbox"."mailbox_state"
      WHERE "tenant_id" = ${tenantId} AND "principal_id" = ${principalId}
        AND "folder" IN (${fromFolder}, ${toFolder})
      ORDER BY "folder"
      FOR UPDATE
    `);
    const rows = await tx.execute<{ id: string }>(sql`
      SELECT "id" FROM "mailbox"."principal_mail"
      WHERE "tenant_id" = ${tenantId} AND "principal_id" = ${principalId}
        AND "folder" = ${fromFolder} AND "uid" = ${uid}
      FOR UPDATE
    `);
    const row = rows[0];
    if (row === undefined) {
      throw new MailboxMessageNotFoundError(
        `Message UID ${uid} not found in mailbox "${fromFolder}"`,
      );
    }

    const bumped = await tx.execute<{
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

    await tx.execute(sql`
      UPDATE "mailbox"."principal_mail"
      SET "folder" = ${toFolder}, "uid" = ${newUid}, "modseq" = ${newModseq}
      WHERE "id" = ${row.id}
    `);
    await tx.execute(sql`
      UPDATE "mailbox"."mailbox_state"
      SET "highest_modseq" = "highest_modseq" + 1
      WHERE "tenant_id" = ${tenantId} AND "principal_id" = ${principalId} AND "folder" = ${fromFolder}
    `);
    return newUid;
  });
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
