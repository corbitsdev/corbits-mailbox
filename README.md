# @corbits/mailbox

Give a **person** in an Interchange hub an inbox: list, read, flag, send, and live updates over SSE. You mount its routes on a Hono app you already have. Postgres holds the mail. This package ships **no UI**.

## Runtime support

Node >= 24 consumes built `dist/`. Bun >= 1.2 runs TypeScript source. Peers: `@intx/hub-api`, `@intx/log`, `@intx/mailbox`, `@intx/mime`, `@intx/types`, `drizzle-orm`, `hono`, `postgres`.

## Quickstart

```bash
npm add @corbits/mailbox @intx/hub-api @intx/log @intx/mailbox @intx/mime @intx/types drizzle-orm hono postgres
```

```ts
import {
  createInMemoryMailboxEventBus,
  createMailboxDb,
  createMailboxRoutes,
  runMailboxMigrations,
} from "@corbits/mailbox";

const { db, close } = createMailboxDb(databaseUrl);
await runMailboxMigrations(db);

app.route(
  "/api/tenants/:tenantId/mailbox",
  createMailboxRoutes({
    db,
    bus: createInMemoryMailboxEventBus(),
    requireGrant,
    senderAddressFor: ({ principalId }) => addressOf(principalId),
    deliver: (message) => transport.send(message),
  }),
);

process.once("SIGTERM", close);
```

`app` is the host's `Hono<TenantEnv>` behind its tenant middleware, `requireGrant` comes from `@intx/hub-api`'s `createRequireGrant`, and `addressOf` and `transport` are the host's own directory and mail transport. `runMailboxMigrations` creates the `mailbox` schema; it needs the host's `tenant` and `principal` tables to exist first.

| `deps`                | Type                                                              | What the host provides                                                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db`                  | `MailboxDb`                                                       | Mail lives there (schema `mailbox`). `createMailboxDb` opens a handle; a hub that already has one passes it instead.                                                                   |
| `bus`                 | `MailboxEventBus`                                                 | SSE fan-out only; mail itself is Postgres. `createInMemoryMailboxEventBus()` for a single process; a shared bus when several processes must fan the same inbox events.                  |
| `requireGrant`        | `RequireGrant`                                                    | Gates reads on `mailbox:*` `read`, send on `create`, and the flag and move verbs on `manage`.                                                                                          |
| `senderAddressFor`    | `(principal: ResolvedPrincipal) => string`                        | That person's From: address, from the host's own directory.                                                                                                                             |
| `deliver`             | `(message: OutgoingMailboxMessage) => void`                       | The host's mail transport. Called once per send with `{ raw, from, to, messageId }` after the message is filed in `Sent`. This package builds MIME; transmission is the host's job.      |
| `heartbeatIntervalMs` | `number` (optional)                                               | SSE keep-alive period. Defaults to 25s.                                                                                                                                                 |

### Routes

Paths are relative to where the host mounts the sub-app. Every route reads or writes only the caller's own mailbox.

| Method | Path                         | Purpose                                                                                     |
| ------ | ---------------------------- | ------------------------------------------------------------------------------------------- |
| GET    | `/me/inbox`                  | List a folder newest first. `?folder=` INBOX (default), Sent, Archive, Trash; `?limit=`, `?cursor=`. |
| GET    | `/me/inbox/threads`          | A folder as threads (REFERENCES algorithm). `?folder=` as above.                           |
| GET    | `/me/inbox/threads/:rootUid` | One thread, rooted at `rootUid`. `?folder=` as above.                                      |
| POST   | `/me/inbox/send`             | Build a message from `{ to, subject?, body, inReplyTo? }`, file it in `Sent`, call `deliver`. |
| GET    | `/me/inbox/events`           | Server-sent `mailbox` events for the caller, with a heartbeat.                              |
| POST   | `/me/inbox/:uid/read`        | Set `\Seen` on a message in `?folder=` (INBOX by default).                                  |
| POST   | `/me/inbox/:uid/unread`      | Clear `\Seen` on a message in `?folder=` (INBOX by default).                                |
| POST   | `/me/inbox/:uid/archive`     | Move from INBOX to Archive.                                                                 |
| POST   | `/me/inbox/:uid/trash`       | Move from INBOX to Trash.                                                                   |
| POST   | `/me/inbox/:uid/restore`     | Move back to INBOX from `?folder=` (Archive by default).                                    |

### Agent-originated mail

`createMailboxRoutes` covers a person's own inbox. A message that originates elsewhere — an agent replying through the host's own transport — reaches that inbox by wrapping the host's existing persist function with `createMailboxPersist`, once, at host construction:

```ts
import {
  createMailboxPersist,
  type AuthorizeMailboxSender,
  type MailboxDb,
  type MailboxEventBus,
  type MailboxPersistArgs,
} from "@corbits/mailbox";

export function wrapPersistMail<R>(
  db: MailboxDb,
  bus: MailboxEventBus,
  opts: {
    upstream: (args: MailboxPersistArgs) => Promise<R>;
    authorizeSender: AuthorizeMailboxSender;
  },
): (args: MailboxPersistArgs) => Promise<R> {
  return createMailboxPersist(db, {
    upstream: opts.upstream,
    authorizeSender: opts.authorizeSender,
    bus,
  });
}
```

`authorizeSender` is the host's own check that a sender address is one it recognizes right now — a hub answers by looking up the tenant a mailbox-routable address (a person, or a live agent run) currently resolves to, and refusing anything else. `upstream` is the host's own pre-existing mail-persist path — the write it already made before this package existed; `createMailboxPersist` calls it unconditionally and layers the durable inbox write on top, so a transport failure never costs a recipient the copy that makes the message readable later. Call the wrapped `persistMail` wherever the host currently delegates an outbound frame; it does both writes.

## How it works

Writes go through a native `MailboxStore` (uid/modseq always set). Search and threads are `@intx/mailbox` run over that store. `POST /me/inbox/send` builds the RFC 5322 message and files a copy in `Sent`, then calls the host's `deliver` exactly once to transmit it.

See [ARCHITECTURE.md](./ARCHITECTURE.md).

## Development

```bash
git clone https://github.com/corbitsdev/corbits-mailbox.git
cd corbits-mailbox
bun install
docker run -d --name mailbox-pg -p 5433:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=mailbox_core postgres:16

bun run typecheck
bun run test
bun run build
```

Tests expect `postgres://postgres:postgres@localhost:5433/mailbox_core` (override with `MAILBOX_TEST_DATABASE_URL`). The end-to-end suites in `tests/` create and drop a database each, so that role needs `CREATEDB`. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

LGPL-2.1-only. See [LICENSE](./LICENSE).
