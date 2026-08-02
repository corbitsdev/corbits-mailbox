# @corbits/mailbox

A universal, principal-keyed inbox you mount onto an existing [Hono](https://hono.dev)
app. Backend only — this package ships no UI.

It owns two tables and its own migration ledger — all in a dedicated `mailbox`
Postgres schema in the host's database — and the `/api/me/inbox*` routes:

- **`principal_mail`** — the message as delivered, immutable. Reads 1-1 with
  Interchange's `session_mail`.
- **`mailbox`** — the mutable management layer keyed by mail id (read/archive/trash
  plus triage columns), created **eagerly with its message in one transaction**. An
  all-NULL row means delivered-and-untouched.

**Detail is frame-authoritative; list is not.** `GET …/inbox/:id` re-derives subject,
sender, recipients, date, Message-ID and snippet from the stored RFC 2822 frame
(cached columns as fallback), so a malformed frame degrades to a partial message rather
than a failed request. **List** never selects `raw` and never decodes: it projects
`subject`/`from` from the write-time cached columns, omits `snippet`, sets
`date` from `created_at`, `messageId` to the row id, and `to` to `[address]`.

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the data model and the design
rationale behind it.

## Requirements

| | |
| --- | --- |
| Runtime | Node 22+ or Bun 1.1+ |
| Postgres | 13+ |
| Control plane | Interchange-shaped `public.tenant` and `public.principal` tables in the **same database**, created before `runMailboxMigrations` — the mailbox tables carry hard foreign keys to both |
| Minimum `@intx/*` | **0.2.2** — 0.1.x does not compile (no `SidecarAuthenticator`, four-verb `SessionService`) |

`hono`, `drizzle-orm`, `postgres`, `@intx/log`, `@intx/mime` and `@intx/types` are
**peer dependencies**. Each breaks quietly with a second copy in the tree —
`@intx/log` configures LogTape's module-global registry, so two copies means your
sinks silently miss this package's logs. Install one copy of each at the top level.

## Install

```sh
npm install @corbits/mailbox
```

> **Not on npm yet.** Until the first release, consume it from a git checkout or an
> `npm pack` tarball. The `@intx/*` packages *are* published, at `0.2.2`.

## Mount

```ts
import { Hono } from "hono";
import {
  mountMailbox,
  runMailboxMigrations,
  createInMemoryMailboxEventBus,
} from "@corbits/mailbox";

// Your own drizzle handle. The mailbox never opens a second pool.
await runMailboxMigrations(db);

const api = new Hono();
mountMailbox(api, {
  db,
  bus: createInMemoryMailboxEventBus(),
  resolvePrincipal: (ctx) => {
    const user = (ctx as Context).get("user");
    return user ? { tenantId: user.tenantId, principalId: user.id } : null;
  },
  // Your taxonomy, not ours. `priorities` is ORDERED, most urgent first.
  vocabulary: {
    priorities: ["urgent", "high", "normal", "low"],
    statuses: ["needs-action", "done"],
  },
});

const app = new Hono();
app.route("/api", api);
```

Routes are registered root-relative and served under `/api` — the prefix Interchange
serves its own routes under. No `/v1`, no vendor prefix.

`examples/reference-host` in this repository is a complete `@intx/hub-api` host with
this package mounted and the acceptance suite pointed at it. Start there if you need
the whole `createApp` wiring.

No handle of your own? `createMailboxDb(url)` opens one and returns `{ db, close }`.

## The seams

| Seam | Contract |
| --- | --- |
| `db` | Your drizzle handle, pointed at the HOST's database — the one your control plane lives in. `MailboxDb` is schema-agnostic in the drizzle sense (every query names its table explicitly, nothing uses `db.query.*`), so a handle bound to your schema is assignable. There is no separate-database mode: the control-plane foreign keys can only hold when both planes share one database. |
| `resolvePrincipal(ctx)` | Takes the host context as `unknown`, returns `{ tenantId, principalId } \| null`. The only authentication seam — this package has no opinion about sessions, cookies or tokens. |
| `bus` | SSE fan-out, keyed by the `(tenantId, principalId)` pair (`MailboxEventScope`) — a principal id is only unique within its tenant, so a principal-only key would leak one tenant's events to another's same-named principal. The in-memory default suits a single process; supply a broker-backed `MailboxEventBus` to fan out across replicas. |
| `vocabulary` | **Required, no default.** Priority ranking, query validation and OpenAPI enums are all generated from your lists. |
| `resolveSenderDisplays` | Optional. Batched per read; turns sender addresses into human labels. Best-effort — a resolver that throws costs the page its labels, never the page. |
| `runMailboxMigrations` | Idempotent, advisory-locked, own ledger (`"mailbox"."corbits_mailbox_migrations"`). Call on every boot from every replica — after the host's control plane exists, since the DDL's foreign keys reference `public.tenant` and `public.principal`. Migrations are checksummed — editing one that already shipped fails the next boot loudly. |

## Routes

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/me/inbox` | List. `view=all\|unread\|archived\|trash`, `limit`, `cursor`, `sort=date\|priority`, plus `priority`/`classification`/`status`/`assignee` filters. |
| `GET` | `/api/me/inbox/unread-count` | Unread, non-archived, non-trashed count. |
| `GET` | `/api/me/inbox/events` | SSE stream, `: heartbeat` every 25s. See the client contract below. |
| `GET` | `/api/me/inbox/:id` | One message with its full body. |
| `POST` | `/api/me/inbox/:id/{read,unread,trash,archive,restore}` | Single-message mutations. |
| `POST` | `/api/me/inbox/:id/enrich` | Stamp triage `priority`/`classification`/`status`. |
| `POST` | `/api/me/inbox/:id/assign` | Delegate to another principal (`null` un-assigns). |
| `POST` | `/api/me/inbox/bulk` | One action across up to 50 ids, partial success. |

All routes carry `describeRoute`, so they appear in the host's OpenAPI document.

### The SSE client contract

**Events are non-durable nudges, not data.** Each event carries an id to
refetch and, when the publisher knows it, `op` — which operation fired
(`create`, `mark_read`, `mark_unread`, `trash`, `archive`, `restore`,
`enrich`, `assign`). `op` is **additive**: it is optional on the wire, so a
client that only reads `id` (the original shape) keeps working unchanged,
and a client that wants to react to a specific kind of change (e.g. badge a
new arrival differently from a read receipt) can switch on it instead of
re-fetching and diffing every message. Postgres remains the source of truth
either way — `op` narrows what changed, it does not replace a refetch when
you need the new state. The server queues at most `MAX_PENDING_SSE_EVENTS`
(100) events per connection — a consumer that stops reading is
**disconnected**, not buffered for. So the contract for any client:

- On **any** disconnect — network drop, server restart, or an overflow close —
  reconnect and **refetch from the API**: the list and the unread count. Never
  assume the stream told you everything that happened while you were away.
- Do not treat the stream as a change log. It may drop events (publish is
  best-effort after commit) and the server may close a stream whose consumer
  stops draining it.
- **Events can be missed, duplicated, or arrive out of order** — this is a
  best-effort nudge channel, not a durable log:
  - *Missed*: publish failures are logged and swallowed, never retried; an
    overflowing connection is disconnected, not buffered for.
  - *Duplicated*: an inbox item redelivered without a stable dedupe key
    inserts a second row and publishes a second `create`; a broker-backed bus
    a host supplies for multi-replica fan-out may itself redeliver. Treat a
    repeat of an already-applied `op` for the same `id` as a no-op.
  - *Out of order*: the default in-memory bus preserves publish order within
    one process for one mailbox, but a broker-backed bus, or multiple
    replicas publishing concurrently, gives no such guarantee. Never infer
    "later event = later state" from arrival order.

Four more behaviors to know before wiring a UI:

- **No-identity asymmetry** (the cross-core rule, not a mailbox quirk). With no
  resolvable principal, collection reads answer `200` with an empty result — "show me
  my inbox" has a truthful answer for someone with no inbox. Everything else names or
  streams a *specific* identity and answers `403`.
- **Cursors are bound to the result set that minted them.** Replaying one under a
  different view, sort or filter set is a `400`; paging a `priority=high` cursor into
  an unfiltered list would silently skip messages. Malformed cursors are also always
  a `400`, never a `500`: the timestamp must be exactly the microsecond shape this
  package mints and the priority rank a safe integer, so a crafted cursor never
  reaches Postgres.
- **`bulk` with `ids: []` is a `200`** (`{updated: 0, results: []}`), not a `400` — the
  partial-success contract applied to zero ids.
- **`limit` is rejected, never clamped.** Default 50, ceiling `MAX_MAILBOX_PAGE_LIMIT`
  (200). A caller handed 200 after asking for 500 advances its paging by 500 and skips
  the difference.
- **Frame size and transport recipient count are hard caps.** Direct write
  (`writeMailboxMessage` / `deliverInboxItems`) throws `RangeError` when a built
  frame would exceed `MAX_MAILBOX_FRAME_BYTES` (1 MiB). The transport dual-write
  path applies the same frame-byte cap and a hard ceiling of
  `MAX_MAILBOX_RECIPIENTS` (50) on the **raw** recipient address list (before
  domain filter / principal resolve — never clamps to the first 50). Over-cap
  refusal there is logged and swallowed (dual-write independence) so
  `createMailboxPersist` still returns upstream success; hosts that need larger
  fan-out must chunk across calls.

## Writing into a mailbox

```ts
const delivered = await deliverInboxItems(db, items, { bus });
// each result is { messageKey, id }; `id === null` means already delivered
```

`deliverInboxItems` is the ingress-adapter seam, deduping on
`mailboxKey.inbox(source, externalId)` — a versioned length-prefixed encoding
(`inbox2:<source.length>:<source>:<externalId>`) so pairs that contain `:` cannot
collide (NUL-join is injective too, but Postgres text rejects U+0000). The
`inbox2:` prefix keeps the space disjoint from pre-upgrade
`inbox:<source>:<externalId>` keys: length-prefix under `inbox:` alone would
false-collide when a historical source was pure decimal. Pre-upgrade rows will
not dedupe against the new encoding and cannot false-collide with it; no
migration is performed.

After blank-scope prevalidation, **the entire batch commits in one transaction**
(or none): a mid-batch FK / driver failure rolls back every new row from that
call. Deduped keys (`id: null`) are no-ops inside the transaction. Bus publish
and the optional host `enqueue` hook run only after commit, and only for newly
inserted ids. `enqueue` is best-effort — a throw is logged with the message id
and never rejects the delivery (same posture as bus publish). A host whose hook
permanently fails on the first try must triage independently; retries of the
same items will dedupe and skip enqueue.

`writeMailboxMessage` inserts a single row. Idempotency keys are namespaced
(`mailboxKey.inbox`/`.gate`/`.run`).

Every delivery writes the mail row **and its management row in one transaction** —
the management row is eager, so every mutation and the unread count are plain
operations on `mailbox`. `InboxItem` carries optional triage fields, so an adapter
that already knows an item's verdict stamps them at delivery instead of writing then
updating; a crash between two separate writes could otherwise strand a delivered
message behind the dedupe with no management row.

Only inbound rows are written, by design — the read path filters `direction = 'inbound'`,
and the sender's outbound record belongs to whatever transport actually sent the frame.

## Triage enriches the mail row

Mail is the single work surface: triage does not spawn a task object.

```ts
await enrichMailboxMessage(db, { tenantId, principalId, id }, {
  priority: "urgent",        // from YOUR vocabulary
  classification: "deal-risk",
  status: "needs-action",
});
```

Each field applies independently — an omitted key leaves the stored value alone, an
explicit `null` clears it, and an enrichment that sets nothing is refused. Read it back
with `listUserMailbox`'s `filter` (ANDed) and `sort=priority`, where untriaged mail
ranks last. `filter.priority`/`status` are checked against your vocabulary (unknown
value → `400`); `classification`/`assignee` are open strings.

Delegation is an `assignee` ref on the `mailbox` row, not a forwarded copy: the item
stays in the delegator's mailbox, so `?assignee=user-2` answers "what have I handed to
user-2". It does not put the item into user-2's inbox — write a second row for that.

Validate untrusted bodies with `MailboxEnrichmentSchema` / `MailboxAssignmentSchema`.

## Hard foreign keys — and what they buy you

Both tables reference the host's control plane: `tenant_id → public.tenant(id)` and
`principal_id → public.principal(id)`, both `ON DELETE CASCADE`. That is the same
posture as Interchange's own `session_mail.tenant_id REFERENCES tenant ON DELETE
CASCADE`, extended to the principal, and it does two jobs the database is better at
than application code:

**Writes to a scope the control plane does not know are refused by the database.** A
tenant or principal id that matches no control-plane row is a foreign-key violation,
not a stored orphan. Blank or whitespace-only ids are still refused earlier, with a
`RangeError` at the write boundary — the FK would catch them too, but only as a driver
error deep in the insert, long after the caller who typed `""` lost its stack.
Identifiers are never trimmed for you. `assertMailboxScope` and `MailboxScopeIdsSchema`
are exported for your own boundary.

**Offboarding is a cascade.** Deleting a tenant or principal row in your control plane
carries every one of its mailbox rows out with it — no window in which orphaned mail
exists. The explicit purges remain for hosts that soft-delete or archive control-plane
rows instead, where no cascade ever fires but the mail data must still go:

```ts
await purgeTenantMailbox(db, tenantId);                     // the whole tenant
await purgePrincipalMailbox(db, { tenantId, principalId }); // one person
```

Each purge is a **single `DELETE` on `principal_mail`** — the management rows follow
through the `mailbox.id → principal_mail.id` cascade, so it is atomic by construction.
Both return the message count and take the handle you pass, so a transaction runs the
purge inside your own offboarding unit of work. Both are irreversible; `raw` is the
only copy of the frame held here.

## Message schemas

`MailboxMessageSchema`, `MailboxMessageDetailSchema`, `MailboxListResponseSchema` and
`MailboxRefSchema` are real arktype schemas, so a consumer decoding this package's JSON
validates rather than casts.

- **`from` is always present** — on detail the header → cached column → default chain
  ends in `""`; on list only the cached column → default chain applies. Either way a
  client never branches on its absence. `subject` has no such default: an empty subject
  is distinct from no subject.
- **Body and snippet come from the frame on detail only, multipart included.** Detail
  walks MIME path `1` (or `1.1` when part 1 is itself multipart) via `@intx/mime`,
  rather than returning the MIME envelope verbatim. An unwalkable frame yields an empty
  body, never a 500. List omits `snippet` entirely and never loads `raw`.
- **Message-ID fallback is `hub.invalid`** (`MESSAGE_ID_FALLBACK_DOMAIN`) — RFC 2606
  reserved, guaranteed never to resolve, so a malformed sender cannot mint a routable-
  looking id. `generateMailboxMessageId` is exported.

## The transport dual-write seam

If your host already has a mail transport that persists frames, `createMailboxPersist`
wraps it so every addressed principal also gets a durable inbound row:

```ts
const persistMail = createMailboxPersist(db, {
  upstream: transport.persistMail,
  authorizeSender: async (senderAddress) => {
    const instance = await findActiveInstance(senderAddress);
    return instance ? { tenantId: instance.tenantId, domain: instance.domain } : null;
  },
  bus,
});
```

Sender authorization is the host's — whether an address belongs to a live agent
instance is the host's call, not a schema fact. The enforcement is ours: an
unauthorized sender gets no mailbox row while the frame is still delegated upstream,
and recipients outside the authorized `domain` are skipped, so cross-tenant delivery is
impossible by construction. Recipient local parts are sender-controlled, so addresses
that resolve to no known principal in the tenant are skipped with a warning rather than
minting a phantom mailbox row — and one typo'd address never costs the real recipients
on the same frame their durable copy.

Dual-write independence holds both ways: `upstream` throwing still attempts the mailbox
write then re-throws unchanged, and a mailbox-write failure is logged loudly but never
rejects a persist that already succeeded upstream.

Mailbox inserts are idempotent under transport retry: each row is stamped with a
package-owned `messageKey` (`transport:mid:<Message-ID>:<principalId>` when the
frame carries a Message-ID, otherwise `transport:raw:<sha256>:<principalId>`) and
inserted with `onConflictDoNothing` on the existing partial unique index. Management
rows and bus announcements only follow rows actually returned by `RETURNING`, so a
retried frame does not fail on unique-violation and does not re-announce duplicates.

## Development

```sh
bun run test          # unit + integration (needs Postgres)
bun run test:coverage
bun run build         # dist/ — JS + .d.ts, consumable from Node
```

The tarball ships `src/` alongside `dist/`, so the emitted `.js.map` and `.d.ts.map`
resolve: go-to-definition and debugger steps land on real TypeScript.

## License

LGPL-2.1-only. See [LICENSE](./LICENSE).
