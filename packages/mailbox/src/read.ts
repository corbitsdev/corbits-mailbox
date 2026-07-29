import {
  and,
  desc,
  eq,
  getTableColumns,
  isNotNull,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";
import { type } from "arktype";
import { getLogger } from "@intx/log";
import { base64urlDecode, base64urlEncode } from "@intx/types";
import { mailbox, principalMail, type MailboxJoinedRow } from "./schema.js";
import { priorityRank, canonicalMailboxPriorities } from "./vocabulary.js";
import type { MailboxDb } from "./db.js";
import { decodeMailFrame, type DecodedFrame } from "./frame.js";
import { parseAddressList } from "./recipients.js";

const logger = getLogger(["corbits-mailbox", "read"]);

const SNIPPET_MAX_CHARS = 160;

// Structured entity references surfaced as a message's "Related" action row.
// Kept intentionally generic (kind/id/label) so this package makes no
// assumption about what entity kinds a host cares about.
export const MailboxRefSchema = type({
  kind: "string",
  id: "string",
  "label?": "string",
});
export type MailboxRef = typeof MailboxRefSchema.infer;

export const MailboxRefArraySchema = MailboxRefSchema.array();

export const MAILBOX_VIEWS = ["all", "unread", "archived", "trash"] as const;
export const MailboxInboxViewSchema = type.enumerated(...MAILBOX_VIEWS);
export type MailboxInboxView = typeof MailboxInboxViewSchema.infer;

/**
 * The inbox sorts by priority, not only by arrival. `date` is
 * newest-first; `priority` is most-urgent-first, newest-first within a
 * priority band.
 */
export const MAILBOX_SORTS = ["date", "priority"] as const;
export const MailboxSortSchema = type.enumerated(...MAILBOX_SORTS);
export type MailboxSort = typeof MailboxSortSchema.infer;

// The exact rendering `encodeMailboxListCursor` receives from `listUserMailbox`'s
// `to_char(…, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` — microseconds and all.
const CURSOR_CREATED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

const MailboxListCursorSchema = type({
  createdAt: "string",
  id: "string",
  view: MailboxInboxViewSchema,
  sort: MailboxSortSchema,
  /**
   * The priority rank of the row the cursor points at — the keyset's leading
   * component under `sort=priority`, and meaningless (absent) under `date`.
   */
  "rank?": "number",
  /**
   * Canonical rendering of the host's priority ordering at the moment the page
   * was minted — present under `sort=priority` for the same reason `rank` is,
   * and meaningless (absent) under `date`. See `canonicalMailboxPriorities`.
   */
  "priorities?": "string",
  /**
   * Canonical rendering of the filters the page was minted under; see
   * `canonicalMailboxFilter`.
   */
  filter: "string",
});
export type MailboxListCursor = typeof MailboxListCursorSchema.infer;

/**
 * The enrichment/delegation filters a list request can narrow by. Every field
 * is optional; an absent field filters nothing.
 */
export const MailboxFilterSchema = type({
  "priority?": "string",
  "classification?": "string",
  "status?": "string",
  "assignee?": "string",
});
export type MailboxFilter = typeof MailboxFilterSchema.infer;

const FILTER_KEYS = [
  "priority",
  "classification",
  "status",
  "assignee",
] as const;

/**
 * A stable string identifying which filters a page was produced under.
 *
 * A keyset cursor is only meaningful against the exact result set it was minted
 * from — that is already why the view is embedded and a cross-view cursor is a
 * 400. Filters partition the same way: paging a `priority=high` cursor into an
 * unfiltered list would skip every non-high message newer than the cursor, and
 * do it silently. Embedding this string lets the route refuse instead.
 */
export function canonicalMailboxFilter(filter: MailboxFilter): string {
  return FILTER_KEYS.filter((key) => filter[key] !== undefined)
    .map((key) => `${key}=${encodeURIComponent(filter[key]!)}`)
    .join("&");
}

/**
 * `createdAt` is the timestamp rendered by Postgres, carrying full microsecond
 * precision. It deliberately never passes through a JS `Date`, which holds only
 * milliseconds — truncating it silently strands every row inside the rounded-off
 * microsecond window on the far side of the cursor.
 */
export function encodeMailboxListCursor(
  row: { createdAt: string; id: string; rank?: number },
  shape: {
    view: MailboxInboxView;
    sort: MailboxSort;
    filter: string;
    /** The host's canonical priority ordering; required under `sort=priority`. */
    priorities?: string;
  },
): string {
  const payload: {
    createdAt: string;
    id: string;
    view: MailboxInboxView;
    sort: MailboxSort;
    filter: string;
    rank?: number;
    priorities?: string;
  } = {
    createdAt: row.createdAt,
    id: row.id,
    view: shape.view,
    sort: shape.sort,
    filter: shape.filter,
  };
  if (shape.sort === "priority") {
    payload.rank = row.rank;
    payload.priorities = shape.priorities;
  }
  return base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
}

/**
 * Decode an opaque list cursor, embedding the view, sort and filters it was
 * minted for so a cursor from one result set used against another is rejected —
 * the caller compares those fields and answers 400. A malformed cursor (bad
 * base64, non-JSON, wrong shape, bad date) also returns null so the route can
 * answer 400 rather than trust it.
 */
export function decodeMailboxListCursor(raw: string): MailboxListCursor | null {
  let json: string;
  try {
    // `base64urlDecode` is `atob`-backed and DOES throw on a non-base64
    // character — unlike `Buffer.from(raw, "base64url")`, which silently
    // returns garbage. Without this catch a hand-typed cursor is a 500.
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
  const result = MailboxListCursorSchema(parsed);
  if (result instanceof type.errors) return null;
  // `createdAt` is interpolated into a `::timestamp` cast, so it must be
  // exactly the shape this package MINTS (see `encodeMailboxListCursor` /
  // `to_char` in `listUserMailbox`) — not merely something JS `new Date()`
  // tolerates. JS and Postgres disagree at the margins (`new Date("0")` is
  // year 2000; `'0'::timestamp` raises), and a crafted cursor must be a 400,
  // never a PostgresError 500.
  // Both checks: the regex pins the shape, and `Date` (strict for ISO input)
  // rejects out-of-range fields the regex cannot see, like month 99.
  if (!CURSOR_CREATED_AT.test(result.createdAt)) return null;
  if (Number.isNaN(new Date(result.createdAt).getTime())) return null;
  // Same class of hole for `rank`: JSON admits `1e400` (Infinity), which is a
  // "number" but not a rank any row was ever minted with.
  if (result.rank !== undefined && !Number.isSafeInteger(result.rank)) {
    return null;
  }
  // A priority-sorted cursor without its leading keyset component cannot seek,
  // and one without the ordering that component was computed under cannot be
  // checked against the current ordering. Either way it is malformed, and
  // saying so is the only honest answer.
  if (result.sort === "priority") {
    if (result.rank === undefined) return null;
    if (result.priorities === undefined) return null;
  }
  return result;
}

// Sender display: turning a raw `From:` header into something a person can
// read. The control-plane half CANNOT live here — only the host knows what an
// address belongs to — so what follows is the pure half (extracting the
// address a display name is keyed by, and deciding whether a resolved label is
// worth surfacing) plus the `SenderDisplayResolver` seam a host implements to
// supply the labels.

/**
 * The bare mailbox address inside a `From:` header value. `"Jane Doe"
 * <j@x.example>` is keyed by `j@x.example`; a header that is already a bare
 * address is its own key.
 */
export function extractSenderMailboxAddress(fromHeader: string): string {
  const trimmed = fromHeader.trim();
  const start = trimmed.indexOf("<");
  const end = trimmed.lastIndexOf(">");
  if (start >= 0 && end > start) {
    return trimmed.slice(start + 1, end).trim();
  }
  return trimmed;
}

/**
 * Pick the display name for a `From:` header, or `undefined` when there is
 * nothing worth showing.
 *
 * A label is only surfaced when it is genuinely a *different* rendering of the
 * sender: a resolver that echoes back the address itself (or the whole header)
 * has resolved nothing, and emitting `fromDisplay` in that case would make a
 * client render the same string twice.
 */
export function attachFromDisplay(
  fromHeader: string,
  displays: Map<string, string>,
): string | undefined {
  const address = extractSenderMailboxAddress(fromHeader);
  const display = displays.get(address);
  if (
    display === undefined ||
    display === address ||
    display === fromHeader.trim()
  ) {
    return undefined;
  }
  return display;
}

/**
 * The host seam for the control-plane half of sender display. Given the tenant
 * and the raw `From:` header values on a page of messages, return a map from
 * **normalized mailbox address** (what `extractSenderMailboxAddress` returns —
 * not the full header) to the label to show.
 *
 * Batched per read on purpose: a per-message resolver turns one inbox page into
 * fifty directory lookups. Addresses the host cannot resolve are simply absent
 * from the map; there is no need to echo them back.
 */
export type SenderDisplayResolver = (
  tenantId: string,
  fromHeaders: string[],
) => Promise<Map<string, string>> | Map<string, string>;

/**
 * One message as the read path projects it. Exported as an arktype schema, not
 * just a type: a consumer
 * decoding this package's JSON off the wire needs something it can validate
 * with, not only something it can cast to.
 *
 * `from` is ALWAYS present — the "header -> cached column -> default" chain
 * ends in `""`, so a row whose frame is unparseable and whose `from_address`
 * column is NULL still projects a `from`, and a client never has to branch on
 * its absence. `subject` has no such default: an empty subject line is a real,
 * distinct thing from no subject line, so it stays optional.
 */
export const MailboxMessageSchema = type({
  id: "string",
  from: "string",
  to: "string[]",
  "fromDisplay?": "string",
  "subject?": "string",
  date: "string",
  messageId: "string",
  read: "boolean",
  "snippet?": "string",
  "refs?": MailboxRefArraySchema,
  "priority?": "string",
  "classification?": "string",
  "status?": "string",
  /** Delegation: the principal this item was handed to, if any. */
  "assignee?": "string",
});
export type MailboxMessage = typeof MailboxMessageSchema.infer;

export const MailboxMessageDetailSchema = MailboxMessageSchema.and({
  body: "string",
});
export type MailboxMessageDetail = typeof MailboxMessageDetailSchema.infer;

/**
 * The `GET /me/inbox` HTTP response envelope — note `messages`, not `items`:
 * `listUserMailbox` returns the in-process `MailboxPage` shape, while this is
 * what actually goes over the wire and what a client validates.
 */
export const MailboxListResponseSchema = type({
  messages: MailboxMessageSchema.array(),
  "nextCursor?": "string",
});

// Every message has a management row, created eagerly with it, so the LEFT
// JOIN below is belt-and-braces rather than load-bearing: `IS NULL` reads the
// same for an all-NULL row (delivered-and-untouched) as it would for a row a
// direct host write somehow skipped, and the join can never drop a message.
function viewConditions(view: MailboxInboxView) {
  switch (view) {
    case "unread":
      return [
        isNull(mailbox.trashedAt),
        isNull(mailbox.archivedAt),
        isNull(mailbox.readAt),
      ];
    case "archived":
      return [isNotNull(mailbox.archivedAt), isNull(mailbox.trashedAt)];
    case "trash":
      return [isNotNull(mailbox.trashedAt)];
    // No `default` — every view is spelled out, so adding one to
    // MAILBOX_VIEWS without deciding its predicate is a type error here
    // rather than a silent fall-through to the "all" filter.
    case "all":
      return [isNull(mailbox.trashedAt), isNull(mailbox.archivedAt)];
  }
}

function toISODate(dateHeader: string | undefined, createdAt: Date): string {
  if (dateHeader === undefined) return createdAt.toISOString();
  const parsed = new Date(dateHeader);
  if (Number.isNaN(parsed.getTime())) return createdAt.toISOString();
  return parsed.toISOString();
}

// One bad backfill would otherwise emit a warn line per bad row per page per
// request — steady-state log spam that buries the signal. Bad rows are
// collected per read and reported once, with a bounded sample of ids.
type DroppedRefs = { rowIds: string[]; summary: string | null };
const DROPPED_REFS_SAMPLE = 5;

function newDroppedRefs(): DroppedRefs {
  return { rowIds: [], summary: null };
}

function reportDroppedRefs(dropped: DroppedRefs): void {
  if (dropped.rowIds.length === 0) return;
  logger.warn("mailbox refs column failed schema; dropped for {rows} row(s)", {
    rows: dropped.rowIds.length,
    sampleRowIds: dropped.rowIds.slice(0, DROPPED_REFS_SAMPLE),
    summary: dropped.summary,
  });
}

// Validates the stored `refs` jsonb ON READ, not just on write. A row whose
// stored blob no longer matches the current schema (or was never valid)
// degrades to no refs (logged) rather than ever 500ing the read.
function readRowRefs(
  stored: MailboxJoinedRow["refs"],
  rowId: string,
  dropped: DroppedRefs,
): MailboxRef[] | undefined {
  if (stored === null || stored === undefined) return undefined;
  const parsed = MailboxRefArraySchema(stored);
  if (parsed instanceof type.errors) {
    dropped.rowIds.push(rowId);
    dropped.summary ??= parsed.summary;
    return undefined;
  }
  return parsed.length > 0 ? parsed : undefined;
}

// On the detail path the raw frame is authoritative: for each field, fall
// back header-value -> cached column -> default. On the list path `decoded`
// is null (list never selects `principal_mail.raw`), so subject/from come
// only from the cached columns and snippet is omitted. Never throws — a
// malformed frame degrades to the cached columns rather than failing the read.
//
// `raw` is intentionally absent from the row type: list selects every
// principal_mail column except it, and toMailboxMessage never needs it
// (the caller decodes outside and threads the result through `decoded`).
function toMailboxMessage(
  row: Omit<MailboxJoinedRow, "raw">,
  decoded: DecodedFrame | null,
  dropped: DroppedRefs,
): MailboxMessage {
  const headers = decoded?.headers;

  // `to` is a list, so a multi-recipient header is split into its addresses
  // rather than surfaced as one joined string.
  const toHeader = headers?.get("to");
  const to =
    toHeader === undefined ? [row.address] : parseAddressList(toHeader);

  const message: MailboxMessage = {
    id: row.id,
    // header -> cached column -> default. The default is `""`, not omission:
    // see MailboxMessageSchema.
    from: headers?.get("from") ?? row.fromAddress ?? "",
    to,
    date: toISODate(headers?.get("date"), row.createdAt),
    messageId: headers?.get("message-id") ?? row.id,
    read: row.readAt !== null,
  };
  const subject = headers?.get("subject") ?? row.subject ?? undefined;
  if (subject !== undefined) message.subject = subject;
  if (decoded !== null && decoded.body.length > 0) {
    message.snippet = decoded.body.slice(0, SNIPPET_MAX_CHARS);
  }
  const refs = readRowRefs(row.refs, row.id, dropped);
  if (refs !== undefined) message.refs = refs;
  if (row.priority !== null) message.priority = row.priority;
  if (row.classification !== null) message.classification = row.classification;
  if (row.status !== null) message.status = row.status;
  if (row.assignee !== null) message.assignee = row.assignee;
  return message;
}

/**
 * Stamp `fromDisplay` onto every message whose sender the host could resolve to
 * a distinct human label. Resolution is batched into ONE call for the whole
 * page — a resolver is typically a directory lookup, and doing it per message
 * turns a 50-row page into 50 round trips.
 *
 * Strictly additive and best-effort: a resolver that throws costs the page its
 * display names (logged), never the page itself. The raw `From:` header is
 * already the authoritative value in `from`.
 */
async function applySenderDisplays(
  messages: MailboxMessage[],
  tenantId: string,
  resolve: SenderDisplayResolver | undefined,
): Promise<void> {
  if (resolve === undefined || messages.length === 0) return;
  const headers = messages
    .map((message) => message.from)
    .filter((from) => from.length > 0);
  if (headers.length === 0) return;
  let displays: Map<string, string>;
  try {
    displays = await resolve(tenantId, headers);
  } catch (err) {
    logger.warn("sender display resolver failed; serving raw From headers", {
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return;
  }
  for (const message of messages) {
    const display = attachFromDisplay(message.from, displays);
    if (display !== undefined) message.fromDisplay = display;
  }
}

function filterConditions(filter: MailboxFilter): SQL[] {
  const columns = {
    priority: mailbox.priority,
    classification: mailbox.classification,
    status: mailbox.status,
    assignee: mailbox.assignee,
  } as const;
  const conditions: SQL[] = [];
  for (const [key, column] of Object.entries(columns)) {
    const value = filter[key as keyof MailboxFilter];
    if (value !== undefined) conditions.push(sql`${column} = ${value}`);
  }
  return conditions;
}

/** The management columns, projected through the LEFT JOIN. */
const STATE_COLUMNS = {
  readAt: mailbox.readAt,
  archivedAt: mailbox.archivedAt,
  trashedAt: mailbox.trashedAt,
  priority: mailbox.priority,
  classification: mailbox.classification,
  status: mailbox.status,
  assignee: mailbox.assignee,
} as const;

export type MailboxScope = {
  tenantId: string;
  principalId: string;
  limit: number;
  cursor?: MailboxListCursor;
  view: MailboxInboxView;
  /** Defaults to `date` (newest first). */
  sort?: MailboxSort;
  /** Enrichment/delegation narrowing; see `MailboxFilterSchema`. */
  filter?: MailboxFilter;
  /**
   * The host's priority vocabulary, most urgent first. There is no default:
   * the ranking `sort=priority` uses is generated from this list, and the
   * package has no taxonomy of its own to fall back on.
   */
  priorities: readonly string[];
  /** Host seam for turning sender addresses into human labels; see `SenderDisplayResolver`. */
  resolveSenderDisplays?: SenderDisplayResolver;
};

export type MailboxPage = {
  items: MailboxMessage[];
  nextCursor?: string;
};

/**
 * List the caller's durable inbound mailbox, newest first, scoped to
 * (tenantId, principalId). Keyset pagination ordered createdAt DESC, id DESC;
 * fetches limit+1 rows to detect whether another page follows.
 *
 * Does NOT select `principal_mail.raw` and does NOT call `decodeMailFrame`.
 * Subject/from come from the cached columns; snippet is omitted. Detail
 * (`getMailboxMessage`) is the only path that loads the full MIME frame.
 */
export async function listUserMailbox(
  db: MailboxDb,
  scope: MailboxScope,
): Promise<MailboxPage> {
  const sort: MailboxSort = scope.sort ?? "date";
  const filter: MailboxFilter = scope.filter ?? {};
  const PRIORITY_RANK = priorityRank(scope.priorities);
  const conditions = [
    eq(principalMail.tenantId, scope.tenantId),
    eq(principalMail.principalId, scope.principalId),
    eq(principalMail.direction, "inbound"),
    ...viewConditions(scope.view),
    ...filterConditions(filter),
  ];
  if (scope.cursor) {
    // Row-value comparison, matching the ORDER BY below exactly. Compared as
    // `timestamp` at full precision, so a row sharing a millisecond with the
    // cursor is still ordered by its microseconds and then by id.
    //
    // The cast is on the CURSOR, never on the column. `created_at` is
    // `timestamp without time zone` holding UTC; casting it — with
    // `AT TIME ZONE` or `::timestamptz` — costs the index outright, because
    // `timestamp → timestamptz` is STABLE, not IMMUTABLE, and a STABLE
    // expression cannot serve an index condition. Measured on 80k rows: this
    // form is an `Index Cond`, 4 buffers / 0.08ms; with the cast moved to the
    // column it becomes a `Filter` that removes 44,001 rows, 415 buffers /
    // 11.7ms.
    //
    // `::timestamp`, not `::timestamptz`, is also the only CORRECT cast. A
    // `timestamptz` literal compared against a zoneless column is resolved
    // through the SESSION's TimeZone, so the same cursor selects a different
    // page on a host whose server runs anywhere but UTC — silently, and still
    // as an `Index Cond`, which is why no plan inspection would have caught it.
    // See `read-non-utc-session.test.ts`.
    //
    // Under `sort=priority` the rank leads the keyset. It is negated on both
    // sides so all three components run in the same direction — a row-value
    // comparison cannot mix ASC and DESC, and `rank ASC` is exactly
    // `(-rank) DESC`.
    conditions.push(
      sort === "priority"
        ? sql`((0 - ${PRIORITY_RANK}), ${principalMail.createdAt}, ${principalMail.id}) < (${0 - scope.cursor.rank!}, ${scope.cursor.createdAt}::timestamp, ${scope.cursor.id})`
        : sql`(${principalMail.createdAt}, ${principalMail.id}) < (${scope.cursor.createdAt}::timestamp, ${scope.cursor.id})`,
    );
  }
  const orderBy =
    sort === "priority"
      ? [
          sql`${PRIORITY_RANK} ASC`,
          desc(principalMail.createdAt),
          desc(principalMail.id),
        ]
      : [desc(principalMail.createdAt), desc(principalMail.id)];
  // Explicit columns — every principal_mail column EXCEPT `raw`. Loading the
  // full MIME frame on every list row was the dominant cost of inbox reads;
  // subject/from already live in cached columns, and list does not surface a
  // body or snippet.
  const rows = await db
    .select({
      id: principalMail.id,
      tenantId: principalMail.tenantId,
      principalId: principalMail.principalId,
      address: principalMail.address,
      direction: principalMail.direction,
      subject: principalMail.subject,
      fromAddress: principalMail.fromAddress,
      messageKey: principalMail.messageKey,
      refs: principalMail.refs,
      createdAt: principalMail.createdAt,
      ...STATE_COLUMNS,
      // Postgres renders the timestamp; a JS Date would drop the microseconds.
      // Formatted explicitly rather than via ::text, whose output depends on
      // the server's DateStyle.
      //
      // NO `AT TIME ZONE 'UTC'`. The column is `timestamp without time zone`
      // already holding UTC, so there is nothing to convert: `AT TIME ZONE`
      // would REINTERPRET it as a timestamptz and then render it in the
      // SESSION's zone, stamping a `Z` onto a local-time string. The cursor
      // minted from it would then seek to the wrong row on any host not running
      // in UTC — and the `Z` makes the output look right while it does.
      createdAtText: sql<string>`to_char(${principalMail.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      priorityRank: PRIORITY_RANK,
    })
    .from(principalMail)
    .leftJoin(mailbox, eq(mailbox.id, principalMail.id))
    .where(and(...conditions))
    .orderBy(...orderBy)
    .limit(scope.limit + 1);

  const hasMore = rows.length > scope.limit;
  const pageRows = hasMore ? rows.slice(0, scope.limit) : rows;
  const dropped = newDroppedRefs();
  const items = pageRows.map((row) => toMailboxMessage(row, null, dropped));
  reportDroppedRefs(dropped);
  await applySenderDisplays(items, scope.tenantId, scope.resolveSenderDisplays);
  const page: MailboxPage = { items };
  if (hasMore) {
    // `hasMore` means rows.length > limit >= 1, so the page is non-empty.
    const last = pageRows[pageRows.length - 1]!;
    page.nextCursor = encodeMailboxListCursor(
      {
        createdAt: last.createdAtText,
        id: last.id,
        rank: Number(last.priorityRank),
      },
      {
        view: scope.view,
        sort,
        filter: canonicalMailboxFilter(filter),
        priorities: canonicalMailboxPriorities(scope.priorities),
      },
    );
  }
  return page;
}

/**
 * Read one mailbox message with its full text body, scoped to
 * (tenantId, principalId). Returns null when no row matches. A stored frame the
 * MIME parser rejects degrades to an empty body (logged) — never a 500.
 */
export async function getMailboxMessage(
  db: MailboxDb,
  args: {
    tenantId: string;
    principalId: string;
    id: string;
    resolveSenderDisplays?: SenderDisplayResolver;
  },
): Promise<MailboxMessageDetail | null> {
  const [row] = await db
    .select({ ...getTableColumns(principalMail), ...STATE_COLUMNS })
    .from(principalMail)
    .leftJoin(mailbox, eq(mailbox.id, principalMail.id))
    .where(
      and(
        eq(principalMail.id, args.id),
        eq(principalMail.tenantId, args.tenantId),
        eq(principalMail.principalId, args.principalId),
        eq(principalMail.direction, "inbound"),
      ),
    )
    .limit(1);
  if (!row) return null;

  // Decoded once and threaded through — the frame is the authority for both
  // the headers and the body.
  const decoded = decodeMailFrame(row.raw);
  if (decoded === null) {
    logger.error("stored mailbox frame failed to parse; serving empty body", {
      messageId: row.id,
    });
  }
  const dropped = newDroppedRefs();
  const message = toMailboxMessage(row, decoded, dropped);
  reportDroppedRefs(dropped);
  await applySenderDisplays(
    [message],
    args.tenantId,
    args.resolveSenderDisplays,
  );
  const detail: MailboxMessageDetail = Object.assign(message, {
    body: decoded === null ? "" : decoded.body,
  });
  return detail;
}
