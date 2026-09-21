# @corbits/mailbox

Give a **person** in an Interchange hub an inbox: list, read, flag, send, SSE. You mount it on a Hono app you already have. Postgres holds the mail. This package ships **no UI**.

## Runtime support

Node >= 24 consumes built `dist/`. Bun >= 1.2 runs TypeScript source. Peers: `@intx/log`, `drizzle-orm`, `hono`, `postgres`.

## Quickstart

Install this package **and** the peers it expects the host to provide:

```bash
bun add @corbits/mailbox @intx/log hono postgres drizzle-orm
# npm  add @corbits/mailbox @intx/log hono postgres drizzle-orm
# pnpm add @corbits/mailbox @intx/log hono postgres drizzle-orm
# yarn add @corbits/mailbox @intx/log hono postgres drizzle-orm
```

`@intx/log` `^0.2.2`, `hono` `^4.12`, `postgres` `^3.4`, `drizzle-orm` `^0.45` (see `peerDependencies`). Postgres 13+ with a database URL.

Minimum that actually runs — a fixed demo principal (swap for session auth) and a `deliver` that logs instead of sending mail:

```ts
import { Hono } from "hono";
import {
  createInMemoryMailboxEventBus,
  createMailboxDb,
  mountMailbox,
  runMailboxMigrations,
} from "@corbits/mailbox";

const { db } = createMailboxDb(
  process.env.DATABASE_URL ??
    "postgres://postgres:postgres@localhost:5433/mailbox_core",
);
await runMailboxMigrations(db);

const DEMO = { tenantId: "tnt_demo", principalId: "usr_demo" };

const app = new Hono();
mountMailbox(app, {
  db,
  bus: createInMemoryMailboxEventBus(),
  resolvePrincipal: () => DEMO,
  senderAddressFor: (p) => `${p.principalId}@demo.example`,
  deliver: async (message) => {
    console.log("deliver", message.from, "→", message.to);
  },
});

Bun.serve({ port: 3000, fetch: app.fetch });
console.log("GET http://127.0.0.1:3000/me/inbox");
```

```bash
curl http://127.0.0.1:3000/me/inbox
```

That lists the demo user's inbox (empty until something writes a row). `POST /me/inbox/send` files `Sent` and calls `deliver` with `{ raw, from, to, messageId }`.

From your own backend, insert a row without HTTP:

```ts
import { writeMailboxMessage } from "@corbits/mailbox";

await writeMailboxMessage(db, {
  tenantId: DEMO.tenantId,
  principalId: DEMO.principalId,
  address: "usr_demo@demo.example",
  fromAddress: "bot@demo.example",
  subject: "Run finished",
  body: "The job completed.",
});
```

In-tree host: `examples/reference-host`. Richer hub-shaped samples belong in [corbitsdev/examples](https://github.com/corbitsdev/examples), not this README.

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
