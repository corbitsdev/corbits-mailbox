# @corbits/mailbox

A Corbits hub module that gives human principals in an Interchange hub an IMAP-style mailbox, mounted as Hono routes on `@intx/hub-api` and stored in the hub's Postgres. The hub is Interchange's multi-tenant control plane; a principal is an account with its own identity and permissions, and a grant is a permission a principal holds on a resource. The routes list, thread, flag, move and send mail, each checked against the caller's grants, with live updates over SSE.

## Why @corbits/mailbox?

1. **Interchange's own mail model.** A person's inbox is a native `@intx/mailbox` store, so search and REFERENCES threading run on Interchange's own code.
2. **Mounts like any hub route.** `createMailboxRoutes` returns a `Hono<TenantEnv>` sub-app. Every route runs through the hub's `requireGrant` and reads only the caller's own mailbox.
3. **Migrations that replay safely.** Every SQL file is idempotent and runs on every boot under an advisory lock, so several replicas can start at once.

It ships no UI and no mail transport: the host renders the inbox and sends the mail.

## Install

```bash
bun add @corbits/mailbox \
  @intx/db @intx/hub-api @intx/log @intx/mailbox @intx/mime @intx/types \
  drizzle-orm hono hono-openapi postgres \
  @standard-community/standard-json @standard-community/standard-openapi
```

The two `@standard-community` packages are `hono-openapi`'s own peers. Runs on Node >= 24 or Bun >= 1.2.

## Quickstart

```ts
import { createDB, type DBConfig } from "@intx/db";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import type { Hono } from "hono";
import {
  createInMemoryMailboxEventBus,
  createMailboxRoutes,
  runMailboxMigrations,
} from "@corbits/mailbox";

declare const app: Hono<TenantEnv>;
declare const dbConfig: DBConfig;
declare const requireGrant: RequireGrant;

await runMailboxMigrations(dbConfig, { schema: "public" });
const { db, close } = createDB(dbConfig);

app.route(
  "/api/tenants/:tenantId/mailbox",
  createMailboxRoutes({
    db,
    bus: createInMemoryMailboxEventBus(),
    requireGrant,
    senderAddressFor: ({ principalId }) => `${principalId}@example.com`,
    deliver: (message) => console.log(message.raw),
  }),
);

process.once("SIGTERM", close);
```

`GET /api/tenants/<tenant>/mailbox/me/inbox` now returns the caller's inbox as `{ "messages": [...] }`.

## Where it fits

[Interchange](https://github.com/faremeter/interchange) runs AI agents as principals with their own identity, permissions and credentials, and its hub holds tenants, principals and grants.

- **Runs in:** the hub, as routes on its Hono app and tables in its Postgres.
- **Plugs into:** [`@intx/hub-api`](https://github.com/faremeter/interchange/tree/main/packages/hub-api) routes and grants, [`@intx/db`](https://github.com/faremeter/interchange/tree/main/packages/db) (its `DBConfig`, and its `tenant` and `principal` tables as FK targets), and [`@intx/mailbox`](https://github.com/faremeter/interchange/tree/main/packages/mailbox) search and threading.
- **Pairs with:** [`@corbits/artifacts`](https://github.com/corbitsdev/corbits-artifacts) and [`@corbits/memory`](https://github.com/corbitsdev/corbits-memory), the other Corbits hub modules.

## Reference

### `createMailboxRoutes(deps)`

| `deps`                | Type                                        | What the host provides                                                                                                      |
| --------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `db`                  | `MailboxDb`                                 | The hub's own database handle. Mail lives in its `mailbox` schema.                                                          |
| `bus`                 | `MailboxEventBus`                           | SSE fan-out. `createInMemoryMailboxEventBus()` for one process; a shared bus when several processes serve the same inboxes. |
| `requireGrant`        | `RequireGrant`                              | From `@intx/hub-api`'s `createRequireGrant`.                                                                                |
| `senderAddressFor`    | `(principal: ResolvedPrincipal) => string`  | The person's From: address, from the host's directory.                                                                      |
| `deliver`             | `(message: OutgoingMailboxMessage) => void` | The host's mail transport. Called once per send with `{ raw, from, to, messageId }`, after the message is filed in `Sent`.  |
| `heartbeatIntervalMs` | `number` (optional)                         | SSE keep-alive period. Defaults to 25s.                                                                                     |

### Routes

Paths are relative to where the host mounts the sub-app. Every route returns 403 when the request has no principal.

| Method | Path                         | Grant                | Purpose                                                                                                        |
| ------ | ---------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------- |
| GET    | `/me/inbox`                  | `mailbox:*` `read`   | List a folder newest first. `?folder=` INBOX (default), Sent, Archive, Trash; `?limit=` (max 200), `?cursor=`. |
| GET    | `/me/inbox/threads`          | `mailbox:*` `read`   | A folder as threads (REFERENCES algorithm). `?folder=` as above.                                               |
| GET    | `/me/inbox/threads/:rootUid` | `mailbox:*` `read`   | One thread, rooted at `rootUid`. `?folder=` as above.                                                          |
| GET    | `/me/inbox/events`           | `mailbox:*` `read`   | Server-sent `mailbox` events for the caller, with a heartbeat.                                                 |
| POST   | `/me/inbox/send`             | `mailbox:*` `create` | Build a message from `{ to, subject?, body, inReplyTo? }`, file it in `Sent`, call `deliver`.                  |
| POST   | `/me/inbox/:uid/read`        | `mailbox:*` `manage` | Set `\Seen` on a message in `?folder=` (INBOX by default).                                                     |
| POST   | `/me/inbox/:uid/unread`      | `mailbox:*` `manage` | Clear `\Seen` on a message in `?folder=` (INBOX by default).                                                   |
| POST   | `/me/inbox/:uid/archive`     | `mailbox:*` `manage` | Move from INBOX to Archive.                                                                                    |
| POST   | `/me/inbox/:uid/trash`       | `mailbox:*` `manage` | Move from INBOX to Trash.                                                                                      |
| POST   | `/me/inbox/:uid/restore`     | `mailbox:*` `manage` | Move back to INBOX from `?folder=` (Archive by default).                                                       |

The grant is `mailbox:*` rather than a per-message resource because every query is already scoped to the caller's own tenant and principal.

### `runMailboxMigrations(dbConfig, { schema })`

Takes the same arguments as `@intx/db`'s `runMigrations`. `schema` holds the host's `tenant` and `principal` tables, which must exist first; the mailbox tables always live in the `mailbox` schema. Call it on every boot. It throws `SchemaTypeMismatchError`, and applies nothing, when a table the host already owns in the `mailbox` schema has columns of the wrong type.

### Other exports

| Export                                                                                            | Use                                                                                          |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `createMailboxPersist(db, opts)`                                                                  | Wraps the host's mail-persist function so agent mail lands in a person's inbox.              |
| `writeMailboxMessage(db, args, bus?)`                                                             | Files one message in a mailbox.                                                              |
| `deliverInboxItems(db, items, opts?)`                                                             | Files notification items from an ingress adapter, deduplicated by source and external id.    |
| `openNativeMailboxStore(db, scope)`, `createPrincipalMailboxStore(db, scope)`                     | The `@intx/mailbox` `MailboxStore` for one folder, or for all of a principal's folders.      |
| `moveNativeMailboxMessage(db, scope, from, uid, to)`                                              | Moves one message between folders.                                                           |
| `purgeTenantMailbox(db, tenantId)`, `purgePrincipalMailbox(db, scope)`                            | Deletes a tenant's or principal's mail for hosts that soft-delete. Returns the count.        |
| `createInMemoryMailboxEventBus()`, `MailboxEventSchema`, `MAILBOX_EVENT_OPS`                      | The single-process event bus and the event shape a shared bus must carry.                    |
| `buildMailFrame(args)`, `generateMailboxMessageId(from)`, `parseAddressList(header)`              | RFC 5322 helpers.                                                                            |
| `resolveMailboxRecipients(addresses, domain)`                                                     | Maps addresses on the tenant's domain to the principals whose mailboxes receive the message. |
| `assertMailboxScope`, `assertMailboxTenantId`, `assertMailboxFrameBytes`, `MailboxScopeIdsSchema` | Scope and frame-size checks the write paths run.                                             |
| `MAX_MAILBOX_PAGE_LIMIT`, `MAX_MAILBOX_RECIPIENTS`, `MAX_MAILBOX_FRAME_BYTES`                     | Page size (200), recipients per frame, and frame size (1 MiB) limits.                        |

## Using with Interchange

The host's tenant middleware sets `tenant` and `principal` on the context; the routes read the caller from there, the same principal `requireGrant` authorizes. Grant each person `mailbox:*` with the `read`, `create` and `manage` actions they need.

Mail that an agent sends reaches a person's inbox when the host wraps its existing persist function once, at construction:

```ts
import {
  createMailboxPersist,
  type AuthorizeMailboxSender,
  type MailboxDb,
  type MailboxEventBus,
  type MailboxPersistArgs,
} from "@corbits/mailbox";

declare const db: MailboxDb;
declare const bus: MailboxEventBus;
declare const persistMail: (args: MailboxPersistArgs) => Promise<void>;
declare const authorizeSender: AuthorizeMailboxSender;

const persist = createMailboxPersist(db, {
  upstream: persistMail,
  authorizeSender,
  bus,
});
```

`authorizeSender` says whether a sender address belongs to the host right now, and to which tenant. `upstream` is the host's existing persist path; it always runs.

## Upgrading from 0.1

- `mountMailbox(app, opts)` is replaced by `app.route(path, createMailboxRoutes(deps))`. `deps.requireGrant` is required.
- The `resolvePrincipal` option is gone; the caller comes from the context's `tenant` and `principal`. The list routes return 403 without one, not an empty list.
- `runMailboxMigrations(db)` is now `runMailboxMigrations(dbConfig, { schema })`. `createMailboxDb` and `MigrationChecksumError` are no longer exported.
- `principalMail`, `mailboxPgSchema` and the schema-check helpers are no longer exported.
- `@intx/db`, `@intx/hub-api` and `hono-openapi` are now peers.
- Existing databases upgrade on the first boot with no manual step. A 0.1.0 database keeps every row; the migration ledger table is dropped.

## License

LGPL-2.1-only. See [LICENSE](https://github.com/corbitsdev/corbits-mailbox/blob/main/LICENSE).
