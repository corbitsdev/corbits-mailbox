# corbits-mailbox

**[`@corbits/mailbox`](./package.json)** — a universal, principal-keyed inbox,
mountable onto a Hono host backed by an Interchange-shaped Postgres. Its tables
live in a dedicated `mailbox` schema in the host's database, foreign-keyed to
the host's `tenant` and `principal` tables. Backend only; this package ships no
UI.

Requires `@intx` 0.2.2 or newer.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the data model.

## Dual-write persist

```ts
import { createMailboxPersist } from "@corbits/mailbox";

const persist = createMailboxPersist(db, {
  upstream: hostMailTransport.persist,
  authorizeSender: (address) => resolveActiveInstance(address),
  // Called once per frame, before the transaction — every recipient row
  // gets the same refs, so a bus subscriber sees them on the `create` event.
  resolveRefs: ({ decoded }) =>
    decoded ? [{ kind: "workbench", id: decoded.messageId ?? "" }] : undefined,
});
```

`resolveRefs` runs after `upstream` resolves and serially with it, and its
refs are frozen at the frame's first successful insert — a retry still runs
the resolver but a different result on that later call is discarded. Return
a small set with the load-bearing ref first: the list is capped at
`MAX_MAILBOX_REFS` by truncating from the end.

See ARCHITECTURE.md's persist section for the full contract, including
`resolveRefs`'s dual-write-failure semantics.

## Install

```sh
# from npm (ships prebuilt dist/)
bun add @corbits/mailbox

# from git (prepare hook builds dist/ on the way in)
bun add github:corbitsdev/corbits-mailbox
```

## Layout

| | |
| --- | --- |
| `src/` | The published package. Owns `principal_mail` (the message, immutable) and `mailbox` (the management layer, created eagerly with each message). |
| `examples/reference-host` | Mounts it on a real `@intx/hub-api` app against a live Postgres and asserts the acceptance scenarios end to end. |

## Write paths

`src/write.ts` exports two batch write functions, each for a different shape
of caller:

- **`deliverInboxItems`** — the notify-item path. One external item (an
  ingress adapter: a mail connector, a webhook), fanned out to every
  addressed principal, deduped on `mailboxKey.inbox(source, externalId)`.
- **`writeMailboxMessages`** — the conversation path. An arbitrary batch of
  `{ scope, args }` pairs — for example a sender's own outbound copy
  alongside every recipient's inbound copy of the same turn — committed in
  one transaction with per-row dedupe on the `messageKey` unique index.

Both commit every new row in the call as a single transaction (or none), and
publish bus events only after commit, one per row actually written. See
[ARCHITECTURE.md](./ARCHITECTURE.md) for the full write-path writeup,
including `writeMailboxMessage`'s caller-supplied `messageId`, `direction`,
and default `messageKey`.

## Thread reads

```ts
import {
  readMailboxThread,
  readMailboxMessageByMessageId,
} from "@corbits/mailbox";

// The conversation under one entity ref, oldest first, keyset-paged.
const page = await readMailboxThread(
  db,
  { tenantId, principalId },
  { ref: { kind: "workbench", id: "wb-1" }, limit: 50 },
);
// page.items: { id, messageId, inReplyTo?, references, fromAddress, subject?,
//               createdAt, read, archived, parentId }
// page.nextCursor: pass back as `cursor` for the next page.

// One message by its Message-ID, scoped to this mailbox.
const message = await readMailboxMessageByMessageId(
  db,
  { tenantId, principalId },
  "<child@acme.example>",
);
```

`parentId` is resolved by RFC 5256 References linking — `In-Reply-To` first,
then the `References` chain newest-to-oldest — across the whole ref-scoped set,
not just the current page. It is `null`, never fabricated, when the nearest
ancestor is not in this mailbox under this ref. Subjects are never used to
group. A cursor is bound to the ref that minted it; paging it into a different
ref is a `RangeError`, as is a malformed cursor or an out-of-range limit.

## Working on it

```sh
bun install
docker run -d --name mailbox-pg -p 5433:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=mailbox_core postgres:16

bun run test    # unit + integration
bun run build   # dist/ (JS + .d.ts)
bun test --cwd examples/reference-host      # acceptance scenarios
```

Tests and the example expect `postgres://postgres:postgres@localhost:5433/mailbox_core`;
override with `MAILBOX_TEST_DATABASE_URL` / `MAILBOX_DATABASE_URL`.

## Conventions

Strict TypeScript, arktype at boundaries, drizzle for data access. Dependencies come
from public `@intx/*` on npm only.

## License

LGPL-2.1-only. See [LICENSE](./LICENSE).
