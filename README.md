# @corbits/mailbox

Give a **person** in an Interchange hub an inbox: list, read, flag, send, SSE. You mount it on a Hono app you already have. Postgres holds the mail. This package ships **no UI**.

## Runtime support

Node >= 24 consumes built `dist/`. Bun >= 1.2 runs TypeScript source. Peers: `@intx/log`, `drizzle-orm`, `hono`, `postgres`.

## Quickstart

```bash
npm add @corbits/mailbox
pnpm add @corbits/mailbox
yarn add @corbits/mailbox
bun add @corbits/mailbox
```

You bring three things this library will not invent:

1. A **Postgres** database (same one as the hub — mailbox tables live in schema `mailbox`).
2. A **Hono** app with middleware that can tell you who the HTTP caller is.
3. A **mail transport** that can actually deliver bytes (SMTP, the hub’s mail router, etc.).

Migrate once, then mount:

```ts
import { Hono } from "hono";
import {
  createInMemoryMailboxEventBus,
  createMailboxDb,
  mountMailbox,
  runMailboxMigrations,
} from "@corbits/mailbox";

const { db } = createMailboxDb(process.env.DATABASE_URL!);
await runMailboxMigrations(db);

const app = new Hono();

mountMailbox(app, {
  db,
  bus: createInMemoryMailboxEventBus(),
  // Who is this request? Return null for anonymous.
  resolvePrincipal: (ctx) => yourAuth.principalFrom(ctx),
  // Their From: address when they hit POST /me/inbox/send.
  senderAddressFor: (principal) => `${principal.principalId}@your-tenant.example`,
  // Put the RFC 5322 message on the wire. We already filed Sent.
  deliver: (message) => yourMail.send(message.raw, message.to),
});
```

That is the whole product. Routes are under `/me/inbox` for whoever `resolvePrincipal` returned.

```bash
curl -H "Cookie: …" http://localhost:3000/me/inbox
```

Anonymous list is an empty page. Every other route is 403 until you resolve a principal.

To drop a message into someone’s inbox from **your** backend (not from the HTTP send route):

```ts
import { writeMailboxMessage } from "@corbits/mailbox";

await writeMailboxMessage(db, {
  tenantId,
  principalId,
  address: "usr_alice@acme.example",
  fromAddress: "bot@acme.example",
  subject: "Run finished",
  body: "…",
});
```

A full hub wiring lives in `examples/reference-host`.

## How it works

Writes go through a native `MailboxStore` (uid/modseq always set). Search and threads are vendored `@intx/mailbox` over that store. `POST /me/inbox/send` only builds the message and files `Sent` — `deliver` is how it leaves the machine.

See [ARCHITECTURE.md](./ARCHITECTURE.md), [PRODUCT.md](./PRODUCT.md), and [IMPLEMENTATION.md](./IMPLEMENTATION.md) if those files are in the tree.

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
