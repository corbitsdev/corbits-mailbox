// @corbits/mailbox — a backend-only, mountable NATIVE Interchange mailbox for
// human principals. This library exists ONLY to give a human principal a
// native `@intx/mailbox` `MailboxStore` over Postgres, and the routes that
// let a host's UI list, read, and file it — nothing else.
export { createMailboxRoutes, MAX_MAILBOX_PAGE_LIMIT } from "./mount.js";
export type {
  CreateMailboxRoutesDeps,
  ResolvedPrincipal,
  OutgoingMailboxMessage,
} from "./mount.js";

export { runMailboxMigrations, MigrationChecksumError } from "./migrations.js";

export { SchemaTypeMismatchError } from "./schema-check.js";

export type { MailboxDb } from "./db.js";

// The native `MailboxStore` over `mailbox.principal_mail` /
// `mailbox.mailbox_state` — `@intx/mailbox`'s `executeSearch`/`executeThread`
// run over it unmodified.
export {
  createPrincipalMailboxStore,
  openNativeMailboxStore,
  moveNativeMailboxMessage,
} from "./native-store.js";
export type { NativeMailboxStore } from "./native-store.js";

// Blank-scope refusal at the boundary (nicer than an FK violation's stack),
// and explicit offboarding tools for hosts that manage deletion themselves —
// the control-plane FKs cascade on tenant/principal delete either way.
export {
  assertMailboxScope,
  assertMailboxTenantId,
  MailboxScopeIdSchema,
  MailboxScopeIdsSchema,
  MAX_MAILBOX_FRAME_BYTES,
  assertMailboxFrameBytes,
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
  deliverInboxItems,
} from "./write.js";
export type {
  WriteMailboxMessageArgs,
  InboxItem,
  DeliverInboxItemsOpts,
  DeliveredInboxItem,
} from "./write.js";

export { buildMailFrame, generateMailboxMessageId } from "./frame.js";

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
