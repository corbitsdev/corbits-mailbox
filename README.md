# @corbits/mailbox

Give a **person** in an Interchange hub an inbox: list, read, flag, send, SSE. You mount it on a Hono app you already have. Postgres holds the mail. This package ships **no UI**.

## Runtime support

Node >= 24 consumes built `dist/`. Bun >= 1.2 runs TypeScript source. Peers: `@intx/log`, `drizzle-orm`, `hono`, `postgres`.

## Quickstart

Install the package and the host peers:

```bash
bun add @corbits/mailbox @intx/log hono postgres drizzle-orm
# npm  add @corbits/mailbox @intx/log hono postgres drizzle-orm
# pnpm add @corbits/mailbox @intx/log hono postgres drizzle-orm
# yarn add @corbits/mailbox @intx/log hono postgres drizzle-orm
```

Peers: `@intx/log` `^0.2.2`, `hono` `^4.12`, `postgres` `^3.4`, `drizzle-orm` `^0.45`. A hub also has `@intx/hub-api`, `@intx/hub-sessions`, `@intx/db`. Postgres 13+.

A **generic Interchange hub** does two things with this package. Neither is a demo user or `console.log`.

**1. Give the hub a persist function that also writes the inbox.**  
Interchange already persists outbound mail (`persistMail`: `{ senderAddress, recipients, raw }`). Wrap it so each addressed **person** also gets a mailbox row. Pass the **wrapper** into hub construction as `persistMail` — the same slot you used for the unwrapped function. Do not assign onto a `lookups` object; that bag is hub-private.

```ts
import { createMailboxPersist } from "@corbits/mailbox";

const persistMail = createMailboxPersist(mailboxDb, {
  upstream: hubPersistMail, // what you already passed into the hub
  authorizeSender, // live run address → { tenantId, domain } or skip
  bus: mailboxBus,
});
// createApp / session setup: persistMail,
```

`authorizeSender` is host policy (Workbench: live run only). Recipients outside `domain` are skipped.

**2. Mount the person's HTTP inbox** on the hub app, under the tenant routes, using the same principal the hub session middleware already set.

```ts
import { Hono } from "hono";
import {
  createInMemoryMailboxEventBus,
  mountMailbox,
  runMailboxMigrations,
} from "@corbits/mailbox";

await runMailboxMigrations(mailboxDb);
const mailboxBus = createInMemoryMailboxEventBus();
const mailboxApp = new Hono();

mountMailbox(mailboxApp, {
  db: mailboxDb,
  bus: mailboxBus,
  resolvePrincipal: (ctx) => {
    const c = ctx as { get(k: "tenant" | "principal"): { id: string } };
    return {
      tenantId: c.get("tenant").id,
      principalId: c.get("principal").id,
    };
  },
  senderAddressFor: (p) => `${p.principalId}@${mailDomain}`,
  deliver: (message) => sendMime(message),
});

app.route("/api/tenants/:tenantId/mailbox", mailboxApp);
```

`sendMime` is the hub's real outbound MIME path (`{ raw, from, to, messageId }`). Same transport you use for other human mail, not a log.

Today Workbench does (1) by writing `lookups.persistMail` after the fact and (2) without `deliver` / `senderAddressFor`. That is host debt: [CL-8789](https://linear.app/abklabs/issue/CL-8789) (mount), [CL-8790](https://linear.app/abklabs/issue/CL-8790) (pass persistMail at construction). Solutions Builder talks to the hub; it does not mount this package.

In-tree: `examples/reference-host` (`@intx/hub-api` `createApp` + this mount). Larger hosts: [corbitsdev/examples](https://github.com/corbitsdev/examples).

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
