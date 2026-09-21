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

Peers: `@intx/log` `^0.2.2`, `hono` `^4.12`, `postgres` `^3.4`, `drizzle-orm` `^0.45`. Postgres 13+. A hub also already has `@intx/hub-api` / `@intx/hub-sessions` / `@intx/db`.

There are **two** host seams. Workbench uses (1) today. (2) is how a person sends from the inbox UI.

**1. Agent frames land in the person's inbox** — wrap the hub's `persistMail` so every outbound agent mail dual-writes a mailbox row. This is Workbench `apps/hub/src/mailbox-persist.ts`.

```ts
import { createMailboxPersist } from "@corbits/mailbox";

lookups.persistMail = createMailboxPersist(mailboxDb, {
  upstream: hubPersistMail, // existing Interchange persistMail
  authorizeSender: hubAuthorizeMailboxSender, // live run → { tenantId, domain }
  bus: mailboxBus,
});
```

`authorizeSender` is the host's call: only a live agent instance may write. Recipients outside that tenant domain are skipped.

**2. HTTP inbox for the signed-in person** — mount under the hub tenant prefix. `resolvePrincipal` reads the same tenant/principal the hub middleware already set. `senderAddressFor` is their From:. `deliver` is the **host mail router** (SMTP, sidecar `routeMail`, whatever the hub already uses to send MIME) — not a log line.

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
  deliver: (message) => hubSendMime(message),
});

app.route("/api/tenants/:tenantId/mailbox", mailboxApp);
```

`hubSendMime` is **your** existing outbound path: `{ raw: Uint8Array, from, to, messageId }`. Workbench does **not** pass `deliver` / `senderAddressFor` yet and still sends `vocabulary` — that catch-up is [CL-8789](https://linear.app/abklabs/issue/CL-8789). Until the hub wires `deliver`, `POST .../mailbox/me/inbox/send` files Sent and then has nowhere to put the bytes.

Solutions Builder does not mount this package; it talks to the hub.

In-tree composition proof: `examples/reference-host` (`createApp` from `@intx/hub-api` + this mount). Hub-scale samples belong in [corbitsdev/examples](https://github.com/corbitsdev/examples).

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
