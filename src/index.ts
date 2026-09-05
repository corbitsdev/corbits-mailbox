// @corbits/mailbox — a backend-only, mountable principal-keyed inbox.
export {
  mountMailbox,
  MAX_MAILBOX_PAGE_LIMIT,
  MAX_PENDING_SSE_EVENTS,
} from "./mount.js";
export type { MountMailboxOpts, ResolvedPrincipal } from "./mount.js";

export { runMailboxMigrations, MigrationChecksumError } from "./migrations.js";

// Boot-time assertion that the live column types are the ones this package's
// codec assumes — `CREATE TABLE IF NOT EXISTS` matches on the table NAME alone,
// so a host that already owns a `mailbox` or `principal_mail` table would
// otherwise have its columns read through our decoder in silence.
export {
  assertExpectedColumnTypes,
  expectedColumnTypes,
  SchemaTypeMismatchError,
} from "./schema-check.js";

export { createMailboxDb } from "./db.js";
export type { MailboxDb } from "./db.js";

// Two tables: the immutable mail plane, and the mutable management layer keyed
// by mail id. There is no `mailboxPriorities`/`mailboxStatuses` export and no
// `MailboxPriority`/`MailboxStatus` type — the vocabulary is the host's, passed
// to `mountMailbox`.
export { principalMail, mailbox, mailboxPgSchema } from "./schema.js";
export type {
  PrincipalMailRow,
  PrincipalMailInsert,
  MailboxRow,
  MailboxInsert,
  MailboxStateColumns,
  MailboxJoinedRow,
} from "./schema.js";

export {
  assertMailboxVocabulary,
  canonicalMailboxPriorities,
  priorityRank,
} from "./vocabulary.js";
export type { MailboxVocabulary } from "./vocabulary.js";

// Blank-scope refusal at the boundary (nicer than an FK violation's stack),
// and explicit offboarding tools for hosts that manage deletion themselves —
// the control-plane FKs cascade on tenant/principal delete either way.
export {
  assertMailboxScope,
  assertMailboxTenantId,
  MailboxScopeIdSchema,
  MailboxScopeIdsSchema,
} from "./write.js";
export type { MailboxScopeIds } from "./write.js";

export { purgeTenantMailbox, purgePrincipalMailbox } from "./purge.js";

export {
  createInMemoryMailboxEventBus,
  MailboxEventSchema,
  MAILBOX_EVENT_OPS,
} from "./bus.js";
export type {
  MailboxEventBus,
  MailboxEvent,
  MailboxEventScope,
  MailboxEventOp,
} from "./bus.js";

export {
  writeMailboxMessage,
  writeMailboxMessages,
  deliverInboxItems,
  mailboxKey,
  MAX_MAILBOX_REFS,
  MAX_MAILBOX_FRAME_BYTES,
  assertMailboxFrameBytes,
} from "./write.js";
export type {
  WriteMailboxMessageArgs,
  WriteMailboxMessagesItem,
  WriteMailboxMessagesOpts,
  InboxItem,
  DeliverInboxItemsOpts,
  DeliveredInboxItem,
} from "./write.js";

export {
  buildMailFrame,
  generateMailboxMessageId,
  MESSAGE_ID_FALLBACK_DOMAIN,
} from "./frame.js";

export {
  extractSenderMailboxAddress,
  attachFromDisplay,
} from "./read.js";
export type { SenderDisplayResolver } from "./read.js";

export { createMailboxPersist, MAX_MAILBOX_RECIPIENTS } from "./persist.js";
export type {
  MailboxPersistArgs,
  SenderAuthorization,
  AuthorizeMailboxSender,
  PersistedMailboxRow,
  CreateMailboxPersistOpts,
} from "./persist.js";

export { parseAddressList, resolveMailboxRecipients } from "./recipients.js";
export type { ResolvedRecipient } from "./recipients.js";

export {
  listUserMailbox,
  getMailboxMessage,
  MailboxMessageSchema,
  MailboxMessageDetailSchema,
  MailboxListResponseSchema,
} from "./read.js";
export type {
  MailboxMessage,
  MailboxMessageDetail,
  MailboxScope,
  MailboxPage,
} from "./read.js";

// Thread reads: the conversation under one entity ref, parents resolved by
// RFC 5256 References linking (never by subject), and the msg-id lookup.
export {
  readMailboxThread,
  readMailboxMessageByMessageId,
  canonicalMailboxThreadRef,
  encodeMailboxThreadCursor,
  decodeMailboxThreadCursor,
  MailboxThreadMessageSchema,
  MailboxThreadResponseSchema,
  DEFAULT_MAILBOX_THREAD_LIMIT,
  MAX_MAILBOX_THREAD_LIMIT,
} from "./thread.js";
export type {
  MailboxThreadScope,
  MailboxThreadArgs,
  MailboxThreadMessage,
  MailboxThreadPage,
  MailboxThreadCursor,
} from "./thread.js";

export {
  markMailboxMessageRead,
  markMailboxMessageUnread,
  archiveMailboxMessage,
  trashMailboxMessage,
  restoreMailboxMessage,
  countUnreadActiveMailbox,
  applyMailboxBulkAction,
  enrichMailboxMessage,
  assignMailboxMessage,
  MailboxEnrichmentSchema,
  MailboxAssignmentSchema,
  MAX_BULK_MAILBOX_IDS,
  MAILBOX_BULK_ACTIONS,
} from "./mutations.js";
export type {
  MailboxMutationScope,
  MailboxBulkAction,
  BulkMailboxResult,
  MailboxEnrichment,
  MailboxAssignment,
} from "./mutations.js";

export { MailboxRefSchema, MailboxRefArraySchema } from "./read.js";
export type { MailboxRef } from "./read.js";

export {
  MailboxInboxViewSchema,
  MailboxSortSchema,
  MailboxFilterSchema,
  MAILBOX_VIEWS,
  MAILBOX_SORTS,
  canonicalMailboxFilter,
  encodeMailboxListCursor,
  decodeMailboxListCursor,
} from "./read.js";
export type {
  MailboxInboxView,
  MailboxSort,
  MailboxFilter,
  MailboxListCursor,
} from "./read.js";
