# @corbits/mailbox

Give a **person** in an Interchange hub an inbox: list, read, flag, send, and live updates over SSE. You mount it on a Hono app you already have. Postgres holds the mail. This package ships **no UI**.

## Runtime support

Node >= 24 consumes built `dist/`. Bun >= 1.2 runs TypeScript source. Peers: `@intx/log`, `drizzle-orm`, `hono`, `postgres`.

## Quickstart

```bash
bun add @corbits/mailbox @intx/log hono postgres drizzle-orm
# or: npm install @corbits/mailbox @intx/log hono postgres drizzle-orm
# or: pnpm add @corbits/mailbox @intx/log hono postgres drizzle-orm
# or: yarn add @corbits/mailbox @intx/log hono postgres drizzle-orm
```

`mountMailbox(app, opts)` adds the inbox routes to your app. Every field of `opts` is a host responsibility:

| `opts` | Type | What the host provides |
| --- | --- | --- |
| `db` | `MailboxDb` | Mail lives there (schema `mailbox`). `createMailboxDb` opens a handle; a hub that already has one passes it as `db` instead. |
| `resolvePrincipal` | `(ctx: unknown) => ResolvedPrincipal \| null` | Who this HTTP request is. Return `{ tenantId, principalId }` or `null` for anonymous requests. |
| `senderAddressFor` | `(principal: ResolvedPrincipal) => string` | That person's From: address, as resolved from the host's own directory. |
| `deliver` | `(message: OutgoingMailboxMessage) => void` | The host's mail transport. Called once per send with `{ raw, from, to, messageId }` after the message has been filed in Postgres. This package builds MIME and files `Sent`; transmission is the host's job. |
| `bus` | `MailboxEventBus` (optional) | SSE fan-out only. Omit it for a single-process host; the default in-process bus applies. Pass a shared bus when several host processes must fan the same inbox events. |
| `heartbeatIntervalMs` | `number` (optional) | SSE keep-alive period. Defaults to 25s. |

The program below is complete: it opens a handle with `createMailboxDb`, runs the migrations, and mounts the inbox on a fresh Hono app. A hub with several processes passes a shared `bus`; otherwise the default in-process bus applies.

```ts
import { Hono } from "hono";
import {
  createMailboxDb,
  mountMailbox,
  runMailboxMigrations,
} from "@corbits/mailbox";

const DATABASE_URL = "postgres://localhost/mailbox";
const { db } = createMailboxDb(DATABASE_URL);

await runMailboxMigrations(db);

const app = new Hono();
mountMailbox(app, {
  db,
  resolvePrincipal: (ctx) => {
    const c = ctx as {
      get(k: "tenant" | "principal"): { id: string } | undefined;
    };
    const tenant = c.get("tenant");
    const principal = c.get("principal");
    if (!tenant || !principal) return null;
    return { tenantId: tenant.id, principalId: principal.id };
  },
  senderAddressFor: ({ principalId, tenantId }) =>
    `${principalId}@${tenantId}.example`,
  deliver: (message) => {
    console.log(`filed ${message.messageId} for ${message.to.join(", ")}`);
  },
});

export default app;
```

The inline `resolvePrincipal` reads whatever identity the host middleware already placed on the request context and maps it to `{ tenantId, principalId }`. `senderAddressFor` answers that person's From: address from the host's own directory; `deliver` transmits what the package already filed in `Sent`.

Agent-originated mail reaches a person's inbox through `createMailboxPersist`, which wraps the host's own persistence function and is passed in at hub construction.

Routes the mount adds: `/me/inbox…` (hosts typically nest them under `/api`).

## How it works

Writes go through a native `MailboxStore` (uid/modseq always set). Search and threads are vendored `@intx/mailbox` over that store. `POST /me/inbox/send` builds the RFC 5322 message and files a copy in `Sent`, then calls the host's `deliver` exactly once to transmit it.

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
bun run test:acceptance
```

Tests expect `postgres://postgres:postgres@localhost:5433/mailbox_core` (override with `MAILBOX_TEST_DATABASE_URL` / `MAILBOX_DATABASE_URL`). See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

LGPL-2.1-only. See [LICENSE](./LICENSE).
