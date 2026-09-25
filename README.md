# @corbits/mailbox

Give a **person** in an Interchange hub an inbox: list, read, flag, send, and live updates over SSE. You mount it on a Hono app you already have. Postgres holds the mail. This package ships **no UI**.

## Runtime support

Node >= 24 consumes built `dist/`. Bun >= 1.2 runs TypeScript source. Peers: `@intx/log`, `@intx/mailbox`, `@intx/mime`, `@intx/types`, `drizzle-orm`, `hono`, `postgres`.

## Quickstart

```bash
bun add @corbits/mailbox @intx/log @intx/mailbox @intx/mime @intx/types hono postgres drizzle-orm
# or: npm install @corbits/mailbox @intx/log @intx/mailbox @intx/mime @intx/types hono postgres drizzle-orm
# or: pnpm add @corbits/mailbox @intx/log @intx/mailbox @intx/mime @intx/types hono postgres drizzle-orm
# or: yarn add @corbits/mailbox @intx/log @intx/mailbox @intx/mime @intx/types hono postgres drizzle-orm
```

`mountMailbox(app, opts)` adds the inbox routes to your app. Every field of `opts` is a host responsibility:

| `opts`                | Type                                          | What the host provides                                                                                                                                                                                       |
| --------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `db`                  | `MailboxDb`                                   | Mail lives there (schema `mailbox`). `createMailboxDb` opens a handle; a hub that already has one passes it as `db` instead.                                                                                 |
| `resolvePrincipal`    | `(ctx: unknown) => ResolvedPrincipal \| null` | Who this HTTP request is. Return `{ tenantId, principalId }` or `null` for anonymous requests.                                                                                                               |
| `senderAddressFor`    | `(principal: ResolvedPrincipal) => string`    | That person's From: address, as resolved from the host's own directory.                                                                                                                                      |
| `deliver`             | `(message: OutgoingMailboxMessage) => void`   | The host's mail transport. Called once per send with `{ raw, from, to, messageId }` after the message has been filed in Postgres. This package builds MIME and files `Sent`; transmission is the host's job. |
| `bus`                 | `MailboxEventBus`                             | SSE fan-out only; mail itself is Postgres. `createInMemoryMailboxEventBus()` for a single-process host; a shared bus when several host processes must fan the same inbox events.                             |
| `heartbeatIntervalMs` | `number` (optional)                           | SSE keep-alive period. Defaults to 25s.                                                                                                                                                                      |

Wire it as one function your app calls at boot with its own `databaseUrl` and the two things only the host can answer — `senderAddressFor` and `deliver` — as typed parameters, not example bodies:

```ts
import { Hono } from "hono";
import {
  createInMemoryMailboxEventBus,
  createMailboxDb,
  mountMailbox,
  type MailboxDb,
  type MailboxEventBus,
  type MountMailboxOpts,
} from "@corbits/mailbox";

export function installMailbox(
  app: Hono,
  opts: {
    databaseUrl: string;
    resolvePrincipal?: MountMailboxOpts["resolvePrincipal"];
    senderAddressFor: MountMailboxOpts["senderAddressFor"];
    deliver: MountMailboxOpts["deliver"];
  },
): { db: MailboxDb; bus: MailboxEventBus } {
  const { db } = createMailboxDb(opts.databaseUrl);
  // In-process fan-out for a single hub instance; pass a shared bus instead
  // once more than one process needs to see the same SSE events.
  const bus = createInMemoryMailboxEventBus();

  const mailboxApp = new Hono();
  mountMailbox(mailboxApp, {
    db,
    bus,
    resolvePrincipal:
      opts.resolvePrincipal ??
      ((ctx) => {
        const c = ctx as {
          get(k: "tenant" | "principal"): { id: string } | undefined;
        };
        const tenant = c.get("tenant");
        const principal = c.get("principal");
        return tenant && principal
          ? { tenantId: tenant.id, principalId: principal.id }
          : null;
      }),
    senderAddressFor: opts.senderAddressFor,
    deliver: opts.deliver,
  });
  // Mounted under the tenant it belongs to, alongside a host's other
  // session-authenticated routes.
  app.route("/api/tenants/:tenantId/mailbox", mailboxApp);

  return { db, bus };
}
```

`resolvePrincipal` defaults to reading whatever identity the host's own auth/tenant middleware already placed on the request context; pass your own to read it differently. `senderAddressFor` is a lookup into the host's own directory — a hub with `principal`/`tenant` tables answers with that person's address, lowercased, at their tenant's mail domain. `deliver` is the host's real mail transport — a hub with a request pipeline of its own hands the built frame back into it (so a message addressed to a running agent reaches it through the same route stack as everything else), rather than putting a byte on a wire itself here.

Routes the mount adds: `/me/inbox…`.

### Agent-originated mail

`mountMailbox` covers a person's own inbox. A message that originates elsewhere — an agent replying through the host's own transport — reaches that inbox by wrapping the host's existing persist function with `createMailboxPersist`, once, at host construction:

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

Tests expect `postgres://postgres:postgres@localhost:5433/mailbox_core` (override with `MAILBOX_TEST_DATABASE_URL` / `MAILBOX_DATABASE_URL`). See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

LGPL-2.1-only. See [LICENSE](./LICENSE).
