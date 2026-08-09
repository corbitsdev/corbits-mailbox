import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { type } from "arktype";
import { mailbox } from "./schema.js";
import type { MailboxDb } from "./db.js";
import { assertMailboxScope } from "./write.js";

export type MailboxMutationScope = { tenantId: string; principalId: string };

export const MAILBOX_BULK_ACTIONS = [
  "mark_read",
  "mark_unread",
  "trash",
  "archive",
  "restore",
] as const;
export type MailboxBulkAction = (typeof MAILBOX_BULK_ACTIONS)[number];

export const MAX_BULK_MAILBOX_IDS = 50;

// Every management row is created WITH its message (see `writeMailboxMessage`
// / `createMailboxPersist`), so every mutation here is a plain scoped UPDATE:
// a message that is not this principal's produces no matching row, which the
// callers read as 404. The row carries the same (tenant_id, principal_id) as
// its mail row — `principal_mail` is immutable, so they can never drift.
function scopedMailbox(scope: MailboxMutationScope, extra: SQL[]) {
  return and(
    eq(mailbox.tenantId, scope.tenantId),
    eq(mailbox.principalId, scope.principalId),
    ...extra,
  )!;
}

type ActionRule = {
  set: Record<string, SQL>;
  /** Rows the action refuses to touch — excluded rows return nothing (404). */
  guards: SQL[];
};

const NULL = sql`NULL`;

/**
 * One owner per rule; the single-message and bulk paths differ only in whether
 * they target one id or many.
 *
 * `COALESCE` makes read/trash/archive idempotent: re-applying never clobbers
 * the original timestamp. Trash-wins precedence lives here once: trashing
 * clears archived, and archiving refuses an already-trashed row.
 */
const ACTION_RULES: Record<MailboxBulkAction, ActionRule> = {
  mark_read: {
    set: { read_at: sql`COALESCE(${mailbox.readAt}, now())` },
    guards: [],
  },
  mark_unread: {
    set: { read_at: NULL },
    guards: [isNull(mailbox.archivedAt), isNull(mailbox.trashedAt)],
  },
  trash: {
    set: {
      trashed_at: sql`COALESCE(${mailbox.trashedAt}, now())`,
      archived_at: NULL,
    },
    guards: [],
  },
  archive: {
    set: {
      archived_at: sql`COALESCE(${mailbox.archivedAt}, now())`,
      trashed_at: NULL,
    },
    guards: [isNull(mailbox.trashedAt)],
  },
  restore: {
    set: { archived_at: NULL, trashed_at: NULL },
    guards: [],
  },
};

function updateMailboxState(
  db: MailboxDb,
  scope: MailboxMutationScope,
  target: SQL,
  set: Record<string, SQL>,
  guards: SQL[],
): Promise<{ id: string }[]> {
  const setList = sql.join(
    Object.entries(set).map(
      ([column, value]) => sql`${sql.identifier(column)} = ${value}`,
    ),
    sql`, `,
  );
  return db.execute<{ id: string }>(sql`
    UPDATE ${mailbox}
       SET ${setList}
     WHERE ${scopedMailbox(scope, [target, ...guards])}
    RETURNING ${mailbox.id}
  `) as unknown as Promise<{ id: string }[]>;
}

async function applyToOne(
  db: MailboxDb,
  scope: MailboxMutationScope & { id: string },
  action: MailboxBulkAction,
): Promise<boolean> {
  const rule = ACTION_RULES[action];
  const updated = await updateMailboxState(
    db,
    scope,
    eq(mailbox.id, scope.id),
    rule.set,
    rule.guards,
  );
  return updated.length > 0;
}

/** Idempotent: repeated read-marking never clobbers the original readAt. */
export function markMailboxMessageRead(
  db: MailboxDb,
  scope: MailboxMutationScope & { id: string },
): Promise<boolean> {
  return applyToOne(db, scope, "mark_read");
}

/** Refused once the message is archived or trashed. */
export function markMailboxMessageUnread(
  db: MailboxDb,
  scope: MailboxMutationScope & { id: string },
): Promise<boolean> {
  return applyToOne(db, scope, "mark_unread");
}

/** Trash wins: trashing always clears archived. */
export function trashMailboxMessage(
  db: MailboxDb,
  scope: MailboxMutationScope & { id: string },
): Promise<boolean> {
  return applyToOne(db, scope, "trash");
}

/** Archiving an already-trashed item is refused (trash-wins precedence). */
export function archiveMailboxMessage(
  db: MailboxDb,
  scope: MailboxMutationScope & { id: string },
): Promise<boolean> {
  return applyToOne(db, scope, "archive");
}

export function restoreMailboxMessage(
  db: MailboxDb,
  scope: MailboxMutationScope & { id: string },
): Promise<boolean> {
  return applyToOne(db, scope, "restore");
}

/**
 * Count the caller's unread, non-archived, non-trashed mail. Counts on
 * `mailbox` alone — every message has a management row from delivery — which
 * is what lets `mailbox_tenant_id_principal_id_unread_idx` serve this, the
 * hottest endpoint, as an index-only scan.
 */
export async function countUnreadActiveMailbox(
  db: MailboxDb,
  scope: MailboxMutationScope,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(mailbox)
    .where(
      scopedMailbox(scope, [
        isNull(mailbox.readAt),
        isNull(mailbox.archivedAt),
        isNull(mailbox.trashedAt),
      ]),
    );
  // An aggregate with no GROUP BY always returns exactly one row.
  return row!.count;
}

/**
 * The triage stamp: mail is the single work surface, so triage
 * *enriches* the message's management row rather than spawning a second object.
 * Every field is optional and applied independently — an omitted key leaves the
 * stored value alone, and an explicit `null` clears it. That distinction is the
 * whole point: re-classifying an item must not silently wipe its priority.
 *
 * `priority` and `status` are plain strings HERE and validated against the
 * host's vocabulary at the mount boundary, where that vocabulary is known.
 *
 * Exported as an arktype schema, not a bare type, because it is a request-body
 * shape a host will parse untrusted JSON into.
 */
export const MailboxEnrichmentSchema = type({
  "priority?": "string|null",
  "classification?": "string|null",
  "status?": "string|null",
});
export type MailboxEnrichment = typeof MailboxEnrichmentSchema.infer;

const ENRICHMENT_COLUMNS = {
  priority: "priority",
  classification: "classification",
  status: "status",
} as const;

/**
 * Stamp triage metadata onto one message's management row, scoped to
 * (tenantId, principalId) — a principal can only enrich their own mail.
 * Returns false when no message is in scope.
 *
 * Throws `RangeError` on an enrichment that sets nothing: an UPDATE with an
 * empty SET clause is not a no-op worth reporting as success, it is a caller
 * bug. Same for a blank tenantId or principalId (see `assertMailboxScope`).
 */
export async function enrichMailboxMessage(
  db: MailboxDb,
  scope: MailboxMutationScope & { id: string },
  enrichment: MailboxEnrichment,
): Promise<boolean> {
  assertMailboxScope(scope);
  const set: Record<string, SQL> = {};
  // Read with `in`, not a truthiness check: `null` is a meaningful value here
  // (clear the field) and must be distinguished from an absent key.
  for (const [key, column] of Object.entries(ENRICHMENT_COLUMNS)) {
    if (!(key in enrichment)) continue;
    const value = enrichment[key as keyof MailboxEnrichment];
    set[column] = value === null ? sql`NULL` : sql`${value}`;
  }
  if (Object.keys(set).length === 0) {
    throw new RangeError(
      "enrichment must set at least one of priority, classification, status",
    );
  }

  const updated = await updateMailboxState(
    db,
    scope,
    eq(mailbox.id, scope.id),
    set,
    [],
  );
  return updated.length > 0;
}

/**
 * Delegation as the optional `assignee` ref rather than a forwarded copy: handing
 * an item to a teammate stamps their principal onto the row rather than
 * copying the mail into their mailbox. `null` un-assigns.
 *
 * The assignee string is opaque to this package — it is whatever the host's
 * `resolvePrincipal` produces — so there is nothing here to validate beyond
 * "a string or null".
 */
export const MailboxAssignmentSchema = type({ assignee: "string|null" });
export type MailboxAssignment = typeof MailboxAssignmentSchema.infer;

/**
 * Assign (or un-assign) one message, scoped to (tenantId, principalId).
 * Returns false when no message is in scope. Throws `RangeError` on a blank
 * tenantId or principalId, as the enrichment path does.
 */
export async function assignMailboxMessage(
  db: MailboxDb,
  scope: MailboxMutationScope & { id: string },
  assignee: string | null,
): Promise<boolean> {
  assertMailboxScope(scope);
  const updated = await updateMailboxState(
    db,
    scope,
    eq(mailbox.id, scope.id),
    { assignee: assignee === null ? sql`NULL` : sql`${assignee}` },
    [],
  );
  return updated.length > 0;
}

export type BulkMailboxResult = { id: string; ok: boolean };

/**
 * Bulk mutation, capped at MAX_BULK_MAILBOX_IDS ids. Partial-success:
 * returns a per-id result rather than failing the whole batch when some ids
 * are out of scope (unknown, wrong principal, or excluded by an active-only
 * guard for that action).
 */
export async function applyMailboxBulkAction(
  db: MailboxDb,
  scope: MailboxMutationScope,
  action: MailboxBulkAction,
  ids: string[],
): Promise<BulkMailboxResult[]> {
  if (ids.length > MAX_BULK_MAILBOX_IDS) {
    throw new RangeError(
      `bulk mailbox action accepts at most ${MAX_BULK_MAILBOX_IDS} ids`,
    );
  }

  const rule = ACTION_RULES[action];
  const updated = await updateMailboxState(
    db,
    scope,
    inArray(mailbox.id, ids),
    rule.set,
    rule.guards,
  );
  const updatedSet = new Set(updated.map((r) => r.id));
  return ids.map((id) => ({ id, ok: updatedSet.has(id) }));
}
