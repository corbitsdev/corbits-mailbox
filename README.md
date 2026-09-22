# @corbits/mailbox

Give a **person** in an Interchange hub an inbox: list, read, flag, send, SSE. You mount it on a Hono app you already have. Postgres holds the mail. This package ships **no UI**.

## Runtime support

Node >= 24 consumes built `dist/`. Bun >= 1.2 runs TypeScript source. Peers: `@intx/log`, `drizzle-orm`, `hono`, `postgres`.

## Quickstart

```bash
bun add @corbits/mailbox @intx/log hono postgres drizzle-orm
# or: npm install @corbits/mailbox @intx/log hono postgres drizzle-orm
# or: pnpm add @corbits/mailbox @intx/log hono postgres drizzle-orm
# or: yarn add @corbits/mailbox @intx/log hono postgres drizzle-orm
```

This is not an app. A hub mounts it. The only **complete** program here is [`examples/reference-host`](./examples/reference-host) (`createApp` + this mount, Postgres, acceptance tests).

`mountMailbox(app, opts)` — every field is a **host** function except `db`:

| `opts` | What you pass |
| --- | --- |
| `db` | The hub’s existing drizzle/Postgres handle. Mail is stored there (schema `mailbox`). |
| `resolvePrincipal` | Who this HTTP request is. Return `{ tenantId, principalId }` or `null`. |
| `senderAddressFor` | That person’s From: address as **your directory** stores it (not a string you invent in the mount). |
| `deliver` | After Send has been filed in Postgres, **transmit** `{ raw, from, to, messageId }`. This package does not send SMTP. |
| `bus` | Optional. SSE only. Default is fine for one hub process. |

Run the migrations once at host boot, before mounting (same order as
[`examples/reference-host/src/index.ts`](./examples/reference-host/src/index.ts)):

```ts
import { runMailboxMigrations, mountMailbox } from "@corbits/mailbox";

await runMailboxMigrations(db);

mountMailbox(app, {
  db,
  resolvePrincipal,
  senderAddressFor,
  deliver,
  // bus omitted: the default in-process bus is fine for one hub process.
});
```

**`resolvePrincipal` in a real hub** (Workbench already does this — tenant and principal are already on the request):

```ts
resolvePrincipal: (ctx) => {
  const c = ctx as { get(k: "tenant" | "principal"): { id: string } | undefined };
  const tenant = c.get("tenant");
  const principal = c.get("principal");
  if (!tenant || !principal) return null;
  return { tenantId: tenant.id, principalId: principal.id };
};
```

Do **not** copy `user.id.split(":")`. That is only the reference-host test encoding (`tenantId:principalId` stuffed into one Better Auth user id). Production IDs are two fields on the hub context.

**`deliver`:** you pass a function **you already have** to send MIME. There is no `sendRawMail` export. The example host keeps an array so tests can assert “send was called” without SMTP. Workbench does not pass `deliver` yet ([CL-8789](https://linear.app/abklabs/issue/CL-8789)).

**Agent → person’s inbox** is `createMailboxPersist` wrapping the hub’s `persistMail`, passed in at hub construction ([CL-8790](https://linear.app/abklabs/issue/CL-8790) — don’t assign `lookups.persistMail`). SBA uses the hub; it does not mount this package.

Routes the mount adds: `/me/inbox…` (host usually nests them under `/api`).

## How it works

Writes go through a native `MailboxStore` (uid/modseq always set). Search and threads are vendored `@intx/mailbox` over that store. `POST /me/inbox/send` only builds the message and files `Sent` — `deliver` is how it leaves the machine.

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
