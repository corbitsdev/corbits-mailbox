# @corbits/mailbox

Give a **person** in an Interchange hub an inbox: list, read, flag, send, SSE. You mount it on a Hono app you already have. Postgres holds the mail. This package ships **no UI**.

## Runtime support

Node >= 24 consumes built `dist/`. Bun >= 1.2 runs TypeScript source. Peers: `@intx/log`, `drizzle-orm`, `hono`, `postgres`.

## Quickstart

```bash
bun add @corbits/mailbox @intx/log @intx/hub-api @intx/db @intx/hub-sessions hono postgres drizzle-orm
```

**Run the host this package ships:** [`examples/reference-host`](./examples/reference-host). That file calls `createApp` from `@intx/hub-api`, then this:

```ts
const api = new Hono<AppEnv>();
mountMailbox(api, {
  db, // hub.db — Postgres. Mail is not in-memory.
  resolvePrincipal: (ctx) => {
    const user = (ctx as Context<AppEnv>).get("user");
    if (!user) return null;
    const [tenantId, principalId] = user.id.split(":");
    return tenantId && principalId ? { tenantId, principalId } : null;
  },
  senderAddressFor: ({ tenantId, principalId }) =>
    `${principalId}@${tenantId}.example`,
  deliver: (message) => sendRawMail(message),
});
app.route("/api", api);
```

`db` and `app` come from `createApp` / `createDB` in that file. Mail **rows** are Postgres. `deliver` is not storage — the library already wrote Sent. `sendRawMail` is the hub’s outbound transport (SMTP, SES, sidecar `routeMail`). The example host implements it as a test spy so acceptance tests can assert the send happened without opening SMTP. Production must actually send `message.raw`.

Inbox paths: `GET/POST /api/me/inbox…`.

Agent mail into a person’s inbox is `createMailboxPersist` wrapping the hub’s `persistMail`, passed **into** hub construction — not `lookups.persistMail`. Workbench still mutates lookups and still omits `deliver`: [CL-8789](https://linear.app/abklabs/issue/CL-8789), [CL-8790](https://linear.app/abklabs/issue/CL-8790).

SBA uses the hub; it does not mount this package.

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
