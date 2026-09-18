# corbits-mailbox

**[`@corbits/mailbox`](./package.json)** has one job: give a human principal
a native Interchange mailbox — a real `@intx/mailbox` `MailboxStore` backed by
Postgres, plus the thin HTTP routes a host's UI needs to list, read, and file
it. Backend only; this package ships no UI. Everything the earlier,
pre-native version of this package did — triage (priority/classification/
status/assignee), delegation, host-defined vocabularies, its own
threading/search, `/me/threads*` — is gone. The vendored `@intx/mailbox`
`executeSearch`/`executeThread` are the search and thread primitives now, run
directly over the native store.

Requires `@intx` 0.2.2 or newer and Node 24 or newer.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the data model.

## Mount

```ts
import { mountMailbox, createInMemoryMailboxEventBus } from "@corbits/mailbox";

mountMailbox(app, {
  db,
  bus: createInMemoryMailboxEventBus(),
  resolvePrincipal: (ctx) => resolveCallerFromRequest(ctx),
  senderAddressFor: (principal) => resolveCallerAddress(principal),
  deliver: (message) => hostMailTransport.send(message),
});
```

## Routes

All under `/me/inbox`, scoped to the principal `resolvePrincipal` resolves for
the request. With no resolvable principal, list returns an empty page (200);
every other route returns 403.

| | |
| --- | --- |
| `GET /me/inbox` | Newest first, keyset-paginated by uid. `?folder=` (`INBOX` default, `Sent`, `Archive`, or `Trash`), `?limit=`, `?cursor=`. Each item carries its `uid`, `flags`, parsed `envelope`, and base64 `raw` — the vendored `executeSearch` over the folder's native store, with envelope + raw fetched per ref. |
| `POST /me/inbox/:uid/read` | `addFlags(uid, ["\Seen"])` |
| `POST /me/inbox/:uid/unread` | `removeFlags(uid, ["\Seen"])` |
| `POST /me/inbox/:uid/archive` | `moveNativeMailboxMessage` INBOX → Archive |
| `POST /me/inbox/:uid/trash` | `moveNativeMailboxMessage` INBOX → Trash |
| `POST /me/inbox/:uid/restore` | `moveNativeMailboxMessage` (`?folder=`, default Archive) → INBOX |
| `GET /me/inbox/events` | SSE stream of `mailbox` events (`create`/`mark_read`/`mark_unread`/`archive`/`trash`/`restore`) for the caller's mailbox, plus a heartbeat every 25s. |
| `GET /me/inbox/threads` | The vendored `executeThread` (REFERENCES) over the folder's native store — roots + children, each ref carrying the same envelope fields as `GET /me/inbox`. `?folder=`. |
| `GET /me/inbox/threads/:rootUid` | The single native thread rooted at `rootUid`, same per-ref envelope fields. `?folder=`. |
| `POST /me/inbox/send` | Body `{ to, subject?, body, inReplyTo? }`; builds an RFC 5322 message, appends it to the caller's `Sent` folder, and returns `{ messageId, uid }`. |

`POST /me/inbox/send` only builds the message and files the caller's own
`Sent` copy — the host's `deliver` mount dep owns actually getting the
message to its recipients.

## Writing into a mailbox

Every write path — host code, ingress adapters, and the transport dual-write
seam — lands through `NativeMailboxStore.append`, so uid/modseq are always
set. There is no other write path left.

```ts
import { writeMailboxMessage, deliverInboxItems } from "@corbits/mailbox";

// One message, appended into the principal's INBOX. Deduped on `messageId`
// within that mailbox — a caller-supplied or minted one.
await writeMailboxMessage(db, {
  tenantId,
  principalId,
  address: "usr_alice@acme.example",
  fromAddress: "bot@acme.example",
  subject: "Run finished",
  body: "...",
}, bus);

// Ingress adapters (mail connectors, webhooks): one item per external
// (source, externalId), deduped on a messageId minted from that pair.
await deliverInboxItems(db, [
  { tenantId, principalId, address, fromAddress, subject, body, source: "gmail", externalId: "msg-1" },
], { bus, enqueue: ({ id, item }) => hostTriage(id, item) });
```

## Dual-write persist

```ts
import { createMailboxPersist } from "@corbits/mailbox";

const persist = createMailboxPersist(db, {
  upstream: hostMailTransport.persist,
  authorizeSender: (address) => resolveActiveInstance(address),
  bus,
});
```

`upstream` throwing still attempts the mailbox append (and the upstream error
re-throws unchanged); a mailbox-append failure is logged and never rejects a
persist upstream already completed. One append per resolved recipient, into
their INBOX, deduped on the frame's Message-ID within that mailbox.

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
| `src/` | The published package. Owns `principal_mail` (the mail plane) and `mailbox_state` (per-folder IMAP counters) — the two tables `NativeMailboxStore` reads and writes. |
| `examples/reference-host` | Mounts it on a real `@intx/hub-api` app against a live Postgres and asserts the acceptance scenarios end to end. |

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
