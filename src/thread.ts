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

// One bad backfill would otherwise emit a warn line per bad row per page per
// request — the same steady-state log spam `read.ts`'s `DroppedRefs` exists to
// avoid. Collected per read and reported once, with a bounded sample of ids.
const DROPPED_REFERENCES_SAMPLE = 5;

type DroppedReferences = { rowIds: string[]; summary: string | null };

function newDroppedReferences(): DroppedReferences {
  return { rowIds: [], summary: null };
}

function reportDroppedReferences(dropped: DroppedReferences): void {
  if (dropped.rowIds.length === 0) return;
  logger.warn(
    "mailbox references column failed schema; dropped for {rows} row(s)",
    {
      rows: dropped.rowIds.length,
      sampleRowIds: dropped.rowIds.slice(0, DROPPED_REFERENCES_SAMPLE),
      summary: dropped.summary,
    },
  );
}

function readRowReferences(
  stored: unknown,
  rowId: string,
  dropped: DroppedReferences,
): string[] {
  if (stored === null || stored === undefined) return [];
  const parsed = MsgIdListSchema(stored);
  if (parsed instanceof type.errors) {
    dropped.rowIds.push(rowId);
    dropped.summary ??= parsed.summary;
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
 * One node of the ref-scoped ancestry graph — a message and just enough of it
 * to resolve (and, when necessary, cut) its candidate parent edge. `createdAt`
 * is the same sortable microsecond text the cursor is minted from, so nodes
 * from different queries (the page, and any ancestor batches fetched to walk
 * a chain) compare with a plain string `<`.
 */
type ThreadNode = {
  id: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  createdAt: string;
};

// Defensive cap on how many nodes a single read will walk while resolving
// ancestry and breaking cycles. A real conversation's chain is nowhere near
// this deep; the cap exists so a pathological or adversarial reference graph
// degrades (bailing out of further expansion, which can only ever turn a
// resolved parent into `null`, never fabricate one) rather than reading an
// unbounded number of rows.
const MAX_THREAD_ANCESTRY_NODES = 2000;

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
 * **`parentId` chains are acyclic.** Nothing stops a delivered frame's
 * `In-Reply-To`/`References` from naming a msg-id that (directly, or through
 * further ancestors) points back at the frame itself — RFC 5256 step 1.B calls
 * this out explicitly. Left unresolved a cycle would either loop a client's
 * ancestry walk forever or silently make a message a descendant of one of its
 * own descendants, so before a page is projected, every resolved parent edge
 * that would close a loop is cut: the LATER-created message in the cycle (ties
 * broken by id) becomes a root (`parentId: null`) instead, and every other
 * message in the cycle keeps its resolved parent. Which edge is cut is
 * deterministic and depends only on the cycle's members, never on where the
 * cursor happens to land, so a cycle's shape does not change from one page to
 * the next.
 *
 * The ancestor lookup deliberately spans the whole ref-scoped set rather than
 * the current page: a chain crossing a page boundary must not report a parent
 * on one page and `null` on another, which is exactly what a page-local resolve
 * would do. Ancestors are fetched breadth-first, one batch per hop, so a chain
 * (or a cycle) reaching beyond the messages the page directly names is still
 * resolved correctly; each batch is served by
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

  const dropped = newDroppedReferences();
  const projected = pageRows.map((row) => ({
    row,
    references: readRowReferences(row.references, row.id, dropped),
  }));
  reportDroppedReferences(dropped);

  // The ancestry graph: every node discovered so far, by id, plus the
  // oldest-carrier msg-id -> id map candidates resolve through. Seeded with
  // the page itself, then expanded breadth-first to whatever the page's rows
  // (and, in turn, THEIR ancestors) name — the graph a cycle could hide in.
  const nodes = new Map<string, ThreadNode>();
  const byMessageId = new Map<string, string>();

  function addNode(node: ThreadNode): void {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
    if (node.messageId === null) return;
    const existingId = byMessageId.get(node.messageId);
    if (existingId === undefined) {
      byMessageId.set(node.messageId, node.id);
      return;
    }
    // Oldest carrier wins — nothing makes a msg-id unique (it is the sender's
    // identifier), so ties resolve to whichever row sorts first, deterministic
    // and stable regardless of fetch order.
    const existing = nodes.get(existingId)!;
    if (
      node.createdAt < existing.createdAt ||
      (node.createdAt === existing.createdAt && node.id < existingId)
    ) {
      byMessageId.set(node.messageId, node.id);
    }
  }

  for (const { row, references } of projected) {
    addNode({
      id: row.id,
      messageId: row.messageId,
      inReplyTo: row.inReplyTo,
      references,
      createdAt: row.createdAtText,
    });
  }

  // Breadth-first expansion: each hop resolves one more round of msg-ids that
  // the nodes discovered so far point at, until nothing new turns up or the
  // safety cap is hit. Bounded and cheap in the overwhelmingly common case
  // (no cycle, a chain a few hops deep) and the only way to prove a cycle
  // absent rather than merely absent from the current page.
  let frontier = new Set<string>();
  for (const node of nodes.values()) {
    if (node.inReplyTo !== null) frontier.add(node.inReplyTo);
    for (const reference of node.references) frontier.add(reference);
  }
  const queried = new Set<string>();
  while (frontier.size > 0 && nodes.size < MAX_THREAD_ANCESTRY_NODES) {
    const toFetch = [...frontier].filter((messageId) => !queried.has(messageId));
    for (const messageId of toFetch) queried.add(messageId);
    frontier = new Set();
    if (toFetch.length === 0) break;
    const fetched = await fetchThreadNodesByMessageId(db, scopeConditions, toFetch);
    for (const node of fetched) {
      addNode(node);
      if (node.inReplyTo !== null && !queried.has(node.inReplyTo)) {
        frontier.add(node.inReplyTo);
      }
      for (const reference of node.references) {
        if (!queried.has(reference)) frontier.add(reference);
      }
    }
  }

  // Candidate parent, per node, before cycle-breaking: RFC 5256's
  // In-Reply-To-first, then References newest-to-oldest, first candidate
  // present under this scope and ref — excluding the node itself, since a
  // frame naming its own msg-id is not its own parent.
  const rawParent = new Map<string, string | null>();
  for (const node of nodes.values()) {
    const candidates = [
      ...(node.inReplyTo !== null ? [node.inReplyTo] : []),
      ...[...node.references].reverse(),
    ];
    let parent: string | null = null;
    for (const candidate of candidates) {
      const found = byMessageId.get(candidate);
      if (found !== undefined && found !== node.id) {
        parent = found;
        break;
      }
    }
    rawParent.set(node.id, parent);
  }

  const finalParent = resolveAcyclicParents(nodes, rawParent);

  const items = projected.map(({ row, references }) => {
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
      parentId: finalParent.get(row.id) ?? null,
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
 * Break every reference cycle in the candidate-parent graph, per RFC 5256
 * step 1.B: walk each node's raw-parent chain with a per-walk visited set, and
 * when a walk revisits a node already on its own path, the path from that node
 * to the end IS the cycle. Cut it by nulling out the parent of the
 * LATER-created member (ties broken by the larger id) — that member becomes a
 * root; every other member of the cycle keeps its raw parent. A node's outcome
 * never depends on which node the walk started from, only on the cycle's own
 * membership, so the result is the same regardless of `nodes` iteration order.
 */
function resolveAcyclicParents(
  nodes: Map<string, ThreadNode>,
  rawParent: Map<string, string | null>,
): Map<string, string | null> {
  const finalParent = new Map<string, string | null>();
  const done = new Set<string>();

  function isLater(a: string, b: string): boolean {
    const nodeA = nodes.get(a)!;
    const nodeB = nodes.get(b)!;
    if (nodeA.createdAt !== nodeB.createdAt) {
      return nodeA.createdAt > nodeB.createdAt;
    }
    return a > b;
  }

  for (const start of nodes.keys()) {
    if (done.has(start)) continue;
    const path: string[] = [];
    let current: string | null = start;
    while (current !== null && !done.has(current)) {
      const cycleStart = path.indexOf(current);
      if (cycleStart !== -1) {
        const cycle = path.slice(cycleStart);
        const cut = cycle.reduce((worst, candidate) =>
          isLater(candidate, worst) ? candidate : worst,
        );
        finalParent.set(cut, null);
        break;
      }
      path.push(current);
      current = rawParent.get(current) ?? null;
    }
    for (const id of path) {
      if (!finalParent.has(id)) finalParent.set(id, rawParent.get(id) ?? null);
      done.add(id);
    }
  }
  return finalParent;
}

/**
 * Fetch full ancestry nodes (not just ids) for a batch of msg-ids, within the
 * same scope and ref the thread page was read under — the per-hop query the
 * breadth-first ancestor walk issues, served by
 * `principal_mail_tenant_id_principal_id_message_id_idx`.
 */
async function fetchThreadNodesByMessageId(
  db: MailboxDb,
  scopeConditions: SQL[],
  messageIds: string[],
): Promise<ThreadNode[]> {
  if (messageIds.length === 0) return [];
  const rows = await db
    .select({
      id: principalMail.id,
      messageId: principalMail.messageId,
      inReplyTo: principalMail.inReplyTo,
      references: principalMail.references,
      createdAtText: sql<string>`to_char(${principalMail.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(principalMail)
    .where(
      and(...scopeConditions, inArray(principalMail.messageId, messageIds)),
    )
    .orderBy(asc(principalMail.createdAt), asc(principalMail.id));
  const dropped = newDroppedReferences();
  const nodes = rows.map((row) => ({
    id: row.id,
    messageId: row.messageId,
    inReplyTo: row.inReplyTo,
    references: readRowReferences(row.references, row.id, dropped),
    createdAt: row.createdAtText,
  }));
  reportDroppedReferences(dropped);
  return nodes;
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
