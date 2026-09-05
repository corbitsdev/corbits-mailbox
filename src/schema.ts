import {
  customType,
  index,
  jsonb,
  pgSchema,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Everything this package owns lives in its own `mailbox` Postgres schema in
 * the HOST's database — never in `public`, and never in a database of its own.
 * The host's control plane and the mail plane share one database so the FKs
 * below can hold.
 */
export const mailboxPgSchema = pgSchema("mailbox");

/**
 * The host's `principal` table, declared (never created) for the recipient
 * existence check at delivery — this package never migrates it; Interchange
 * owns it. Only the columns this package reads are named.
 */
export const hostPrincipal = pgTable("principal", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
});

/**
 * Surrogate key for this package's OWN rows: a database-generated uuid stored
 * as `text`.
 *
 * `text`, not `uuid`, because Interchange's own schema is
 * `text("id").primaryKey()` on every table and these packages mount onto
 * Interchange hosts — an id should not change type at the seam — and because
 * mounting onto a database that ALREADY owns a table of this name does not then
 * require rewriting its existing text ids.
 *
 * Deliberately not an Interchange-style prefixed id: `generateId` in
 * `@intx/hub-common` mints ids only for kinds Interchange owns, and minting
 * lookalike prefixes here would shadow that scheme with a second, unowned one.
 *
 * Identical to `@corbits/artifact-core`'s and `@corbits/analytics-core`'s
 * helpers of the same name.
 */
const surrogateId = () =>
  text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()::text`);

// bytea column type — the frozen `raw` MIME frame. drizzle-orm has no
// built-in bytea helper; this mirrors the shape drizzle's own bytea customType
// examples use.
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  toDriver(value) {
    return Buffer.from(value);
  },
  fromDriver(value) {
    return new Uint8Array(value);
  },
});

// HARD control-plane foreign keys: `tenant_id` and `principal_id` reference
// the host's `tenant` and `principal` tables with ON DELETE CASCADE. The
// columns are named to read 1-1 with Interchange's own `session_mail`
// (`tenant_id`, `direction`, `raw`, `created_at`). The FKs mean a row can only
// ever belong to a tenant and principal the control plane knows, and deleting
// either carries the mailbox rows out with it. The constraints live in the
// migration DDL, the single owner of the live schema — they are deliberately
// NOT restated as drizzle `.references()` thunks here.
//
// THE MAIL PLANE. `principal_mail` is the message as delivered and nothing
// more, so it reads 1-1 with `session_mail`: every column the two share means
// the same thing. It is IMMUTABLE — `raw` was already frozen, and now so is
// every row. Everything a human does to a message afterwards lives in
// `mailbox`, below.
export const principalMail = mailboxPgSchema.table(
  "principal_mail",
  {
    id: surrogateId(),
    tenantId: text("tenant_id").notNull(),
    principalId: text("principal_id").notNull(),
    address: text("address").notNull(),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    raw: bytea("raw").notNull(),
    subject: text("subject"),
    fromAddress: text("from_address"),
    messageKey: text("message_key"),
    // The threading headers, cached off `raw` at write for the SAME reason
    // `subject` and `from_address` are: list never loads the MIME frame, so a
    // client renders a thread from the projection alone instead of fetching
    // every message's `raw` to read two headers. `raw` stays authoritative —
    // detail re-derives both from the frame. Nullable because a frame the MIME
    // parser rejects, or one carrying no such header, still persists.
    messageId: text("message_id"),
    inReplyTo: text("in_reply_to"),
    // The `References:` chain, OLDEST FIRST, as a jsonb array of bracketed
    // msg-ids — cached for the same reason `in_reply_to` is, and needed by the
    // same reader: `readMailboxThread` resolves a parent by RFC 5256 linking
    // (In-Reply-To, then References newest-first), and it runs on the list
    // path, which never loads `raw`. Plain `jsonb` with no `$type<string[]>()`
    // for the reason spelled out on `refs`: nothing in Postgres constrains the
    // blob's shape, so every reader validates it instead.
    references: jsonb("references"),
    // Plain `jsonb` with NO `$type<MailboxRef[]>()`. A `$type` here is a claim
    // the column cannot keep: nothing in Postgres constrains this blob's shape,
    // and a row written by an older version (or by the host directly) will
    // still be handed to the read path. Typing it as `unknown` is what the
    // column actually guarantees, and it forces every reader through
    // `readRowRefs`, which validates. Matches both sibling cores.
    refs: jsonb("refs"),
    // BARE `timestamp`, no `withTimezone`. Every timestamp column in this
    // package and in both sibling cores is `timestamp without time zone`
    // holding UTC, which is what Interchange's own tables use — an instant
    // should not change type at the seam.
    //
    // The consequence is a hard rule for every query touching this column: the
    // COLUMN IS NEVER CAST. `timestamp → timestamptz` is STABLE, not IMMUTABLE,
    // so a cast on the column side (`created_at AT TIME ZONE 'UTC'`,
    // `created_at::timestamptz`) cannot serve an index condition and drops the
    // keyset page out of `Index Cond` into `Filter` over the principal's whole
    // history. Cast the CURSOR instead — see `listUserMailbox`.
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  // EVERY index below must match the live DDL that `runMailboxMigrations`
  // produces, statement for statement. This table object is a public export, so
  // a host that points `drizzle-kit push`/`generate` at it recreates exactly
  // what is declared here — an index declared here but dropped by a migration
  // (or declared with a different column order) silently reintroduces itself
  // into that host's schema. `schema-ddl-parity.test.ts` diffs the two,
  // for BOTH tables.
  (t) => [
    // (tenant_id, principal_id, created_at DESC, id DESC) — matches the list query's
    // ORDER BY and its row-value cursor seek exactly, so paging is an Index
    // Cond with no sort. Created by migration `0001_principal_mailbox`.
    //
    // This index is the reason the split is safe for the default view: the
    // `created_at` keyset never leaves this table, so the highest-traffic page
    // is still a single-table Index Scan that stops at `limit + 1` rows.
    index("principal_mail_tenant_id_principal_id_created_at_id_idx").on(
      t.tenantId,
      t.principalId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    uniqueIndex("principal_mail_tenant_id_principal_id_message_key_idx")
      .on(t.tenantId, t.principalId, t.messageKey)
      .where(sql`${t.messageKey} IS NOT NULL`),
    // Msg-id lookup, scoped the way every other access path here is. It serves
    // both `readMailboxMessageByMessageId` and the ancestor map
    // `readMailboxThread` builds — the latter probes it once per read with an
    // `IN` list of every msg-id the page references, so this is the difference
    // between one index scan and a sequential scan of the mailbox's history.
    // Not unique: a msg-id is the SENDER's identifier, and nothing stops two
    // externally-delivered frames from carrying the same one.
    // Created by migration `0003_mail_references`.
    index("principal_mail_tenant_id_principal_id_message_id_idx").on(
      t.tenantId,
      t.principalId,
      t.messageId,
    ),
    // `readMailboxThread`'s own keyset order: oldest first, `(created_at, id)`,
    // scoped the same way every other access path here is. The list-path index
    // above covers the same three columns in the opposite direction and a
    // backward scan of it would serve this query too, but this index lets the
    // thread path's plan match its `ORDER BY` directly rather than depending
    // on the planner choosing to scan the other index in reverse.
    // Created by migration `0003_mail_references`.
    index("principal_mail_tenant_id_principal_id_created_at_id_asc_idx").on(
      t.tenantId,
      t.principalId,
      t.createdAt.asc(),
      t.id.asc(),
    ),
    // The ref filter is `refs @> [{"kind":…,"id":…}]`, which only a GIN index
    // can serve. Default `jsonb_ops` rather than `jsonb_path_ops`: the
    // containment query is what both support, and staying on the default
    // opclass keeps this index renderable by `drizzle-kit` from the table
    // object above exactly as the migration creates it.
    index("principal_mail_refs_idx").using("gin", t.refs),
  ],
);

// THE MANAGEMENT LAYER. Keyed by mail id, one row per message, created
// EAGERLY with the message in the same transaction: all-NULL means
// delivered-and-untouched. Guaranteed presence is what lets every mutation be
// a plain UPDATE and the unread count an index-only scan on this table.
//
// `tenant_id`/`principal_id` are carried alongside the id so every index and
// every purge here is scoped the same way the mail plane's are, without a join.
// They cannot drift from the mail row's: `principal_mail` is immutable.
//
// `priority` and `status` are PLAIN TEXT with no enum. Their vocabulary is the
// host's, supplied through `MountMailboxOpts` — see `vocabulary.ts`. Shipping a
// closed list here would have made one product's taxonomy every adopter's.
export const mailbox = mailboxPgSchema.table(
  "mailbox",
  {
    // The same surrogate key as the mail row's — always the mail row's id,
    // never generated here. The FK (and its ON DELETE CASCADE) lives in the
    // migration DDL with the others.
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    principalId: text("principal_id").notNull(),
    // Bare `timestamp`, for the reason spelled out on `principal_mail.created_at`.
    readAt: timestamp("read_at"),
    archivedAt: timestamp("archived_at"),
    trashedAt: timestamp("trashed_at"),
    priority: text("priority"),
    classification: text("classification"),
    status: text("status"),
    /**
     * Delegation as an optional ref rather than a forwarded copy: the principal
     * this item was handed to. Deliberately no FK: an assignment must survive
     * the assignee's principal being offboarded — the item still belongs to
     * THIS mailbox, and losing the row with someone else's departure would be
     * wrong.
     */
    assignee: text("assignee"),
  },
  (t) => [
    // The triage columns are indexed PER TENANT+PRINCIPAL, so each is a
    // composite leading with the scope every mailbox query already filters on —
    // never the bare single-column form, which a planner would not choose for a
    // low-cardinality column anyway.
    index("mailbox_tenant_id_principal_id_priority_idx").on(
      t.tenantId,
      t.principalId,
      t.priority,
    ),
    index("mailbox_tenant_id_principal_id_classification_idx").on(
      t.tenantId,
      t.principalId,
      t.classification,
    ),
    index("mailbox_tenant_id_principal_id_status_idx").on(
      t.tenantId,
      t.principalId,
      t.status,
    ),
    // "What have I delegated to X" is always scoped to one mailbox, so the
    // scope leads here too.
    index("mailbox_tenant_id_principal_id_assignee_idx").on(
      t.tenantId,
      t.principalId,
      t.assignee,
    ),
    // One partial index per view predicate. Eager row creation is what makes
    // the unread one possible at all: with every message carrying a row, the
    // unread count is an index-only scan here instead of a LEFT JOIN over the
    // principal's whole history.
    index("mailbox_tenant_id_principal_id_unread_idx")
      .on(t.tenantId, t.principalId)
      .where(
        sql`${t.readAt} IS NULL AND ${t.archivedAt} IS NULL AND ${t.trashedAt} IS NULL`,
      ),
    index("mailbox_tenant_id_principal_id_archived_at_idx")
      .on(t.tenantId, t.principalId)
      .where(sql`${t.archivedAt} IS NOT NULL AND ${t.trashedAt} IS NULL`),
    index("mailbox_tenant_id_principal_id_trashed_at_idx")
      .on(t.tenantId, t.principalId)
      .where(sql`${t.trashedAt} IS NOT NULL`),
  ],
);

export type PrincipalMailRow = typeof principalMail.$inferSelect;
export type PrincipalMailInsert = typeof principalMail.$inferInsert;
export type MailboxRow = typeof mailbox.$inferSelect;
export type MailboxInsert = typeof mailbox.$inferInsert;

/**
 * The management columns as the read path projects them alongside a mail row.
 * Every one is nullable twice over: nullable in the table, and null again for
 * every message that has no `mailbox` row at all.
 */
export type MailboxStateColumns = {
  readAt: Date | null;
  archivedAt: Date | null;
  trashedAt: Date | null;
  priority: string | null;
  classification: string | null;
  status: string | null;
  assignee: string | null;
};

/** One message with its management state, as the LEFT JOIN produces it. */
export type MailboxJoinedRow = PrincipalMailRow & MailboxStateColumns;
