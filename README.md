# @corbits/mailbox

A native Interchange mailbox for human principals: a Postgres-backed `@intx/mailbox` `MailboxStore` plus the HTTP routes a host UI needs to list, read, and file it. Backend only — this package ships no UI.

## Install

Requires Node 24+ and `@intx` 0.2.2 or newer.

```bash
npm install @corbits/mailbox
pnpm add @corbits/mailbox
yarn add @corbits/mailbox
bun add @corbits/mailbox
```

Peer stack: `@intx/log`, `drizzle-orm`, `hono`, `postgres`.

## Use

```ts
import {
  createInMemoryMailboxEventBus,
  mountMailbox,
  runMailboxMigrations,
} from "@corbits/mailbox";

await runMailboxMigrations(db);
mountMailbox(app, {
  db,
  bus: createInMemoryMailboxEventBus(),
  resolvePrincipal: (ctx) => resolveCallerFromRequest(ctx),
  senderAddressFor: (principal) => resolveCallerAddress(principal),
  deliver: (message) => hostMailTransport.send(message),
});
```

Routes land under `/me/inbox`, scoped to the principal `resolvePrincipal` returns.

## Full example

```ts
import {
  createInMemoryMailboxEventBus,
  createMailboxPersist,
  deliverInboxItems,
  mountMailbox,
  runMailboxMigrations,
  writeMailboxMessage,
} from "@corbits/mailbox";

await runMailboxMigrations(db);
const bus = createInMemoryMailboxEventBus();

mountMailbox(app, {
  db,
  bus,
  resolvePrincipal: (ctx) => resolveCallerFromRequest(ctx),
  senderAddressFor: (principal) => resolveCallerAddress(principal),
  deliver: (message) => hostMailTransport.send(message),
});

await writeMailboxMessage(
  db,
  {
    tenantId,
    principalId,
    address: "usr_alice@acme.example",
    fromAddress: "bot@acme.example",
    subject: "Run finished",
    body: "…",
  },
  bus,
);

await deliverInboxItems(
  db,
  [
    {
      tenantId,
      principalId,
      address,
      fromAddress,
      subject,
      body,
      source: "gmail",
      externalId: "msg-1",
    },
  ],
  { bus },
);

const persist = createMailboxPersist(db, {
  upstream: hostMailTransport.persist,
  authorizeSender: (address) => resolveActiveInstance(address),
  bus,
});
```

`POST /me/inbox/send` only builds the RFC 5322 message and files the caller's `Sent` copy — `deliver` owns putting it on the wire.

## How it works

Every write lands through `NativeMailboxStore.append` (uid/modseq always set). Search and threading are the vendored `@intx/mailbox` `executeSearch` / `executeThread` over that store. `mountMailbox` exposes `/me/inbox` (list, flags, archive/trash/restore, SSE, threads, send). With no resolvable principal, list returns an empty page; every other route returns 403.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the data model.

## Contributing

```sh
bun install
docker run -d --name mailbox-pg -p 5433:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=mailbox_core postgres:16

bun run typecheck
bun run test             # unit + integration
bun run build            # dist/ (JS + .d.ts)
bun run test:acceptance  # builds, then examples/reference-host
```

Tests and the example expect `postgres://postgres:postgres@localhost:5433/mailbox_core`; override with `MAILBOX_TEST_DATABASE_URL` / `MAILBOX_DATABASE_URL`. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

LGPL-2.1-only. See [LICENSE](./LICENSE).
