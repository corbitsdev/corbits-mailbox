// Thread reads: the conversation under one entity ref, and the msg-id lookup
// that makes an externally-delivered reply findable.
//
// The whole module runs on the LIST path — it never selects `principal_mail.raw`
// and never decodes a MIME frame. That is not an optimization: a thread is read
// on every conversation open, and a projection that had to decode one frame per
// row would make the cached threading columns (`message_id`, `in_reply_to`,
// `references`) pointless. They exist for exactly this reader.

import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { type } from "arktype";
import { getLogger } from "@intx/log";
import { base64urlDecode, base64urlEncode } from "@intx/types";
import { mailbox, principalMail } from "./schema.js";
import type { MailboxDb } from "./db.js";
import {
  MailboxRefSchema,
  PRINCIPAL_MAIL_LIST_COLUMNS,
  STATE_COLUMNS,
  newDroppedRefs,
  reportDroppedRefs,
  toMailboxMessage,
  type MailboxMessage,
  type MailboxRef,
} from "./read.js";

const logger = getLogger(["corbits-mailbox", "thread"]);

export const DEFAULT_MAILBOX_THREAD_LIMIT = 50;
/** Same ceiling the HTTP list surface enforces; a thread page is not cheaper. */
export const MAX_MAILBOX_THREAD_LIMIT = 200;

/** The (tenant, principal) mailbox a thread read is answered from. */
export type MailboxThreadScope = { tenantId: string; principalId: string };

/**
 * One message as the thread read projects it.
 *
 * `references` is ALWAYS present, `[]` for a message with no ancestry — a chain
 * of no ancestors is an empty chain, not an absent one, and a client walking it
 * should never have to branch. `parentId` is likewise always present and is
 * `null`, never omitted and never invented, when the nearest ancestor is not in
 * this mailbox under this ref.
 *
 * `createdAt` is Postgres's own microsecond rendering, the same string the
 * cursor is minted from — deliberately not a JS `Date`, which holds only
 * milliseconds.
 */
export const MailboxThreadMessageSchema = type({
  id: "string",
  messageId: "string",
  "inReplyTo?": "string",
  references: "string[]",
  fromAddress: "string",
  "subject?": "string",
  createdAt: "string",
  read: "boolean",
  archived: "boolean",
  parentId: "string | null",
});
export type MailboxThreadMessage = typeof MailboxThreadMessageSchema.infer;

export const MailboxThreadResponseSchema = type({
  messages: MailboxThreadMessageSchema.array(),
  "nextCursor?": "string",
});

export type MailboxThreadPage = {
  items: MailboxThreadMessage[];
  nextCursor?: string;
};

export type MailboxThreadArgs = {
  /** The entity the thread hangs off; matched on `kind` and `id` alone. */
  ref: MailboxRef;
  cursor?: string;
  /** 1..`MAX_MAILBOX_THREAD_LIMIT`; defaults to `DEFAULT_MAILBOX_THREAD_LIMIT`. */
  limit?: number;
};

// The same microsecond rendering `to_char` produces below, and the same shape
// the list cursor pins — a cursor is interpolated into a `::timestamp` cast, so
// it must be exactly what this package MINTS rather than merely something
// `new Date()` tolerates.
const CURSOR_CREATED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

const MailboxThreadCursorSchema = type({
  createdAt: "string",
  id: "string",
  /** Canonical rendering of the ref the page was minted under. */
  ref: "string",
});
export type MailboxThreadCursor = typeof MailboxThreadCursorSchema.infer;

/**
 * A stable string identifying which ref a thread page was produced under.
 *
 * JSON-encoded as a pair rather than joined with a separator: a `kind` or `id`
 * containing the separator would otherwise let two different refs render the
 * same string, and a cursor is only meaningful against the exact result set it
 * was minted from.
 */
export function canonicalMailboxThreadRef(ref: MailboxRef): string {
  return JSON.stringify([ref.kind, ref.id]);
}

export function encodeMailboxThreadCursor(
  row: { createdAt: string; id: string },
  ref: MailboxRef,
): string {
  const payload: MailboxThreadCursor = {
    createdAt: row.createdAt,
    id: row.id,
    ref: canonicalMailboxThreadRef(ref),
  };
  return base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
}

/**
 * Decode an opaque thread cursor, or null when it is malformed — bad base64,
 * non-JSON, wrong shape, or a `createdAt` that is not the exact rendering this
 * package mints. Null so a route can answer 400 rather than hand a crafted
 * value to Postgres.
 */
export function decodeMailboxThreadCursor(
  raw: string,
): MailboxThreadCursor | null {
  let json: string;
  try {
    // `base64urlDecode` is `atob`-backed and DOES throw on a non-base64
    // character, unlike `Buffer.from(raw, "base64url")`.
    json = new TextDecoder().decode(base64urlDecode(raw));
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const result = MailboxThreadCursorSchema(parsed);
  if (result instanceof type.errors) return null;
  if (!CURSOR_CREATED_AT.test(result.createdAt)) return null;
  if (Number.isNaN(new Date(result.createdAt).getTime())) return null;
  return result;
}

// The stored `references` blob is validated ON READ for the same reason `refs`
// is: nothing in Postgres constrains its shape, and a row written by an older
// version (or by the host directly) still reaches this projection. A blob that
// fails degrades to no ancestry — logged — rather than failing the read.
const MsgIdListSchema = type("string[]");

function readRowReferences(stored: unknown, rowId: string): string[] {
  if (stored === null || stored === undefined) return [];
  const parsed = MsgIdListSchema(stored);
  if (parsed instanceof type.errors) {
    logger.warn("mailbox references column failed schema; dropped for {rowId}", {
      rowId,
      summary: parsed.summary,
    });
    return [];
  }
  return parsed;
}

/**
 * The ref predicate: jsonb containment, so a stored ref carrying an extra
 * `label` still matches a `{ kind, id }` query. Served by the GIN index
 * `principal_mail_refs_idx`.
 */
function refCondition(ref: MailboxRef) {
  return sql`${principalMail.refs} @> ${JSON.stringify([{ kind: ref.kind, id: ref.id }])}::jsonb`;
}

function assertThreadArgs(args: MailboxThreadArgs): number {
  const ref = MailboxRefSchema(args.ref);
  if (ref instanceof type.errors) {
    throw new RangeError(`invalid mailbox thread ref: ${ref.summary}`);
  }
  const limit = args.limit ?? DEFAULT_MAILBOX_THREAD_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_MAILBOX_THREAD_LIMIT
  ) {
    throw new RangeError(
      `mailbox thread limit must be an integer in 1..${MAX_MAILBOX_THREAD_LIMIT}`,
    );
  }
  return limit;
}

/**
 * Resolve the cursor, refusing one minted for a different ref.
 *
 * A keyset cursor is only meaningful against the result set that produced it.
 * Paging a cursor from one ref into another ref's thread would silently skip
 * every message older than the cursor, so this is a `RangeError` — the same
 * posture the list path takes when a cursor's view, sort or filter disagrees.
 */
function resolveThreadCursor(
  args: MailboxThreadArgs,
): MailboxThreadCursor | undefined {
  if (args.cursor === undefined) return undefined;
  const cursor = decodeMailboxThreadCursor(args.cursor);
  if (cursor === null) throw new RangeError("malformed mailbox thread cursor");
  if (cursor.ref !== canonicalMailboxThreadRef(args.ref)) {
    throw new RangeError("mailbox thread cursor was minted for a different ref");
  }
  return cursor;
}

/**
 * Read the conversation under one entity ref, oldest first, keyset-paged on
 * `(created_at, id)` and scoped to `(tenantId, principalId)`.
 *
 * **Parents are resolved by RFC 5256 References linking, over the whole
 * ref-scoped set — never by subject.** For each message the candidate ancestors
 * are its `In-Reply-To` followed by its `References` chain walked
 * newest-to-oldest, and the first candidate that is present in THIS mailbox
 * under THIS ref wins. An ancestor that is not present yields `parentId: null`:
 * a message whose parent lives in someone else's mailbox, or under a different
 * ref, is a root of what this reader can see, and inventing a node for it would
 * be a lie about the conversation.
 *
 * The ancestor lookup deliberately spans the whole ref-scoped set rather than
 * the current page: a chain crossing a page boundary must not report a parent
 * on one page and `null` on another, which is exactly what a page-local resolve
 * would do. It costs ONE extra query per read — a msg-id map over the ids the
 * page actually references, served by
 * `principal_mail_tenant_id_principal_id_message_id_idx`.
 *
 * Throws `RangeError` on a malformed ref, an out-of-range limit, and a cursor
 * that is malformed or was minted for a different ref.
 */
export async function readMailboxThread(
  db: MailboxDb,
  scope: MailboxThreadScope,
  args: MailboxThreadArgs,
): Promise<MailboxThreadPage> {
  const limit = assertThreadArgs(args);
  const cursor = resolveThreadCursor(args);

  const scopeConditions = [
    eq(principalMail.tenantId, scope.tenantId),
    eq(principalMail.principalId, scope.principalId),
    eq(principalMail.direction, "inbound"),
    refCondition(args.ref),
  ];
  const conditions = [...scopeConditions];
  if (cursor) {
    // Row-value comparison matching the ORDER BY exactly, with the cast on the
    // CURSOR and never on the column — `timestamp → timestamptz` is STABLE, so
    // a cast on the column side cannot serve an index condition, and a
    // `timestamptz` literal would resolve through the session's TimeZone and
    // seek to a different row on a non-UTC host. Same rule as `listUserMailbox`.
    conditions.push(
      sql`(${principalMail.createdAt}, ${principalMail.id}) > (${cursor.createdAt}::timestamp, ${cursor.id})`,
    );
  }

  const rows = await db
    .select({
      id: principalMail.id,
      messageId: principalMail.messageId,
      inReplyTo: principalMail.inReplyTo,
      references: principalMail.references,
      fromAddress: principalMail.fromAddress,
      subject: principalMail.subject,
      // Postgres renders the timestamp; a JS Date would drop the microseconds
      // the cursor is minted from. No `AT TIME ZONE`: the column is
      // `timestamp without time zone` already holding UTC.
      createdAtText: sql<string>`to_char(${principalMail.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      readAt: mailbox.readAt,
      archivedAt: mailbox.archivedAt,
    })
    .from(principalMail)
    .leftJoin(mailbox, eq(mailbox.id, principalMail.id))
    .where(and(...conditions))
    .orderBy(asc(principalMail.createdAt), asc(principalMail.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const projected = pageRows.map((row) => ({
    row,
    references: readRowReferences(row.references, row.id),
  }));

  // Every msg-id the page could possibly link to, resolved in one query
  // against the whole ref-scoped set.
  const referenced = new Set<string>();
  for (const { row, references } of projected) {
    if (row.inReplyTo !== null) referenced.add(row.inReplyTo);
    for (const reference of references) referenced.add(reference);
  }
  const ancestors = await ancestorIdsByMessageId(
    db,
    scopeConditions,
    [...referenced],
  );

  const items = projected.map(({ row, references }) => {
    // RFC 5256: the immediate parent first, then the chain newest-to-oldest.
    const candidates = [
      ...(row.inReplyTo !== null ? [row.inReplyTo] : []),
      ...[...references].reverse(),
    ];
    let parentId: string | null = null;
    for (const candidate of candidates) {
      const found = ancestors.get(candidate);
      // A frame naming its own msg-id is not its own parent.
      if (found !== undefined && found !== row.id) {
        parentId = found;
        break;
      }
    }
    const item: MailboxThreadMessage = {
      id: row.id,
      // The row id is the last resort, not the cache: a frame with no
      // Message-ID still needs a stable handle. Same rule as the list path.
      messageId: row.messageId ?? row.id,
      references,
      fromAddress: row.fromAddress ?? "",
      createdAt: row.createdAtText,
      read: row.readAt !== null,
      archived: row.archivedAt !== null,
      parentId,
    };
    if (row.inReplyTo !== null) item.inReplyTo = row.inReplyTo;
    if (row.subject !== null) item.subject = row.subject;
    return item;
  });

  const page: MailboxThreadPage = { items };
  if (hasMore) {
    // `hasMore` means rows.length > limit >= 1, so the page is non-empty.
    const last = pageRows[pageRows.length - 1]!;
    page.nextCursor = encodeMailboxThreadCursor(
      { createdAt: last.createdAtText, id: last.id },
      args.ref,
    );
  }
  return page;
}

/**
 * Map every supplied msg-id to the id of the message carrying it, within the
 * same scope and ref the thread page was read under. Ties (nothing makes a
 * msg-id unique — it is the sender's identifier) resolve to the OLDEST
 * carrier, so a parent does not change when a duplicate arrives later.
 */
async function ancestorIdsByMessageId(
  db: MailboxDb,
  scopeConditions: SQL[],
  messageIds: string[],
): Promise<Map<string, string>> {
  if (messageIds.length === 0) return new Map();
  const rows = await db
    .select({ id: principalMail.id, messageId: principalMail.messageId })
    .from(principalMail)
    .where(
      and(...scopeConditions, inArray(principalMail.messageId, messageIds)),
    )
    .orderBy(asc(principalMail.createdAt), asc(principalMail.id));
  const byMessageId = new Map<string, string>();
  for (const row of rows) {
    if (row.messageId === null) continue;
    if (!byMessageId.has(row.messageId)) byMessageId.set(row.messageId, row.id);
  }
  return byMessageId;
}

/**
 * Look one message up by its `Message-ID`, scoped to (tenantId, principalId).
 * Returns null when this mailbox holds no such message — including when
 * another principal's does, which is the whole point of the scope.
 *
 * Nothing makes a msg-id unique (it is the sender's identifier, and two
 * externally-delivered frames may carry the same one), so the OLDEST match
 * wins — a stable answer rather than whichever row the planner reached first.
 *
 * Served from the cached `message_id` column, on the list projection: this is
 * a lookup, not a detail read, and it never loads `raw`.
 */
export async function readMailboxMessageByMessageId(
  db: MailboxDb,
  scope: MailboxThreadScope,
  messageId: string,
): Promise<MailboxMessage | null> {
  const [row] = await db
    .select({ ...PRINCIPAL_MAIL_LIST_COLUMNS, ...STATE_COLUMNS })
    .from(principalMail)
    .leftJoin(mailbox, eq(mailbox.id, principalMail.id))
    .where(
      and(
        eq(principalMail.tenantId, scope.tenantId),
        eq(principalMail.principalId, scope.principalId),
        eq(principalMail.direction, "inbound"),
        eq(principalMail.messageId, messageId),
      ),
    )
    .orderBy(asc(principalMail.createdAt), asc(principalMail.id))
    .limit(1);
  if (!row) return null;

  const dropped = newDroppedRefs();
  const message = toMailboxMessage(row, null, dropped);
  reportDroppedRefs(dropped);
  return message;
}
