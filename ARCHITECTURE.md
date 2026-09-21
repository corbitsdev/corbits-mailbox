# @corbits/mailbox — Architecture

How the native mailbox is structured. Install, mount snippets, and the
public function list live in the [README](./README.md). Concrete libraries,
wire formats, and migration ids live in
[IMPLEMENTATION.md](./IMPLEMENTATION.md).

## Shape

A **library, not a service**. It creates no HTTP server, opens no
connection pool by default, owns no configuration, and starts no
background work. A host calls:

- `runMailboxMigrations(db)` — once at boot, before serving.
- `mountMailbox(app, opts)` — registers `/me/inbox*` on a Hono app the
  host already built, and returns the same app.

Every durable write (HTTP send, `writeMailboxMessage`,
`deliverInboxItems`, `createMailboxPersist`) lands through
`NativeMailboxStore.append`. Search and threading are the vendored
`@intx/mailbox` `executeSearch` / `executeThread` over that store.

```
host Hono app
    │
    ▼
mountMailbox  ──▶  openNativeMailboxStore(folder)
                       │
         ┌─────────────┼──────────────┐
         ▼             ▼              ▼
   executeSearch   executeThread   append / flags / MOVE
         │             │              │
         └─────────────┴──────────────┘
                       │
                       ▼
         mailbox.principal_mail
         mailbox.mailbox_state
```

## Where the routes are served

The core registers **root-relative** `/me/inbox*` paths and takes no base
path. Nesting the host's Hono app under `/api` (Interchange's own prefix)
is the host's decision, not a parameter on `mountMailbox`.

```ts
const api = new Hono<AppEnv>();
mountMailbox(api, { db, bus, resolvePrincipal, senderAddressFor, deliver });
app.route("/api", api);
```

Auth is whatever the host already declared for `/me/*`. This package does
not install middleware.

## Mount seam

`mountMailbox<E extends Env>(app, opts): Hono<E>` is generic over the
host's Hono `Env` and returns the same app.

| Option | Required | Role |
| --- | --- | --- |
| `db` | yes | The host's drizzle postgres-js handle. Schema generic is `any` so the host does not open a second pool. |
| `bus` | yes | `MailboxEventBus` — per-mailbox fan-out for SSE, keyed by `(tenantId, principalId)`. |
| `resolvePrincipal(ctx)` | yes | `{ tenantId, principalId } \| null`. `ctx` is `unknown` so Hono env typing does not leak into the seam. |
| `senderAddressFor(principal)` | yes | The caller's `From:` for `POST /me/inbox/send`. |
| `deliver(message)` | yes | Host transport. Called **after** the Sent copy appends. This package never puts a byte on a wire. |
| `heartbeatIntervalMs` | no | SSE keep-alive; default 25s (under the usual 30s proxy idle timeout). |

What it does **not** require: auth library, logger configuration, UI,
triage vocabulary, sender-display resolver. What the **database** must
already have: Interchange-shaped `public.tenant` and `public.principal` in
the same database, in place before `runMailboxMigrations`, because mailbox
tables foreign-key both with `ON DELETE CASCADE`.

### No-member asymmetry

When `resolvePrincipal` yields no principal:

- `GET /me/inbox` and `GET /me/inbox/threads` return an **empty** 200
  (a caller with no mailbox identity sees an empty inbox).
- Events, send, single-thread lookup, and mutations return **403**.

That split is intentional.

## Native store

`NativeMailboxStore` is a `@intx/mailbox` `MailboxStore` scoped to one
`(tenantId, principalId, folder)` mailbox — the same scope
`executeSearch` / `executeThread` already assume.

The vendored mutating methods (`append`, `addFlags`, `removeFlags`,
`remove`) are **synchronous**. An in-memory backing can satisfy that; a
Postgres backing cannot make a write durable before return. This store
therefore:

1. Materializes the folder into memory on `openNativeMailboxStore`.
2. Answers every sync method from that mirror immediately.
3. Queues the matching Postgres statement onto `store.settled` — a
   promise every write chains onto, in order, so two writes for the same
   mailbox never race at the database.

Call `await store.settled` before trusting a write has landed. The
settled chain **always resolves** (a failed write does not wedge later
ones). To observe a failure, await the promise the enqueue itself was
given, not `store.settled`.

The store does not poll or subscribe. To see writes from another
instance, open a fresh one after that instance's `settled` has resolved.

`createPrincipalMailboxStore(db, scope)` is the factory: `open(folder)`
and `move(from, uid, to)`.

### Folders, uid, modseq

List folders: `INBOX` (default), `Sent`, `Archive`, `Trash`.

Each `(tenant, principal, folder)` has a `mailbox_state` row:
`uid_validity`, `uid_next`, `highest_modseq`. `append` assigns the next
uid and bumps modseq. IMAP MOVE is **not** on the vendored interface —
`moveNativeMailboxMessage` reassigns a fresh uid in the destination
folder and bumps **its** counters, then bumps the source folder's
modseq. Any already-open store for either folder must be reopened to see
the result.

Read/unread is `\Seen` via `addFlags` / `removeFlags`. Archive / trash /
restore are MOVE (restore's source is `?folder=`, default Archive).

### Search and threading

`GET /me/inbox` runs `executeSearch` with no predicate, reverses for
newest-first, and pages with a uid keyset (`?cursor=` is the last uid of
the previous page). `?limit=` defaults to 50, ceiling 200 — exceeding it
is 400, never a silent clamp.

`GET /me/inbox/threads` and `GET /me/inbox/threads/:rootUid` run
`executeThread` with the REFERENCES algorithm. Each node carries the same
envelope fields the list returns, so a client can render a thread without
an extra fetch per message.

This package does not reimplement search or threading.

## Write paths

All of these append through the native store:

| Path | Folder | Dedupe |
| --- | --- | --- |
| `writeMailboxMessage` | `args.folder` or INBOX | `messageId` within that mailbox |
| `deliverInboxItems` | INBOX | minted `<inbox-{source}-{externalId}@mailbox.invalid>` when the item carries no `messageId` |
| `createMailboxPersist` | each recipient's INBOX | decoded `Message-ID` within that mailbox |
| `POST /me/inbox/send` | caller's Sent, then `deliver` | new minted id each send |

Blank `tenantId` / `principalId` is a `RangeError` at the arktype
boundary (not an FK violation deep in the insert). A built frame over
`MAX_MAILBOX_FRAME_BYTES` is the same. Scope strings are **not** trimmed
— rewriting an identifier would make the row unreachable by the string
the caller believes it wrote.

`raw` is the frozen MIME frame. Cached envelope columns exist so list
and thread do not have to parse `raw` for subject / from / to /
message-id / threading headers. `raw` stays authoritative.

## Transport persist

`createMailboxPersist(db, { upstream, authorizeSender, bus?, onRow? })`
wraps the host's own persist function.

- `authorizeSender(address) => { tenantId, domain } | null` is the host's
  decision (live agent instance, etc.). `null` skips the mailbox write;
  the frame still goes upstream.
- Recipients outside `domain` are skipped — cross-tenant delivery is
  impossible by construction.
- Recipient local parts are sender-controlled. A local that matches no
  `principal.id` or `principal.refId` in that tenant is skipped with a
  warning; it never costs the frame's real recipients their copy.
- Recipient list over `MAX_MAILBOX_RECIPIENTS` is a hard `RangeError`,
  never a clamp.

**Dual-write independence:**

- `upstream` throwing still attempts the mailbox write, then re-throws
  the original error. A transport that cannot reach a live session must
  not also cost the recipient the durable copy.
- A mailbox-write failure is logged and **never** rejects a persist
  upstream already completed. Reporting failure for a delivery that
  happened invites a retry that double-delivers it.

A frame the MIME parser rejects still delivers — envelope degrades to
what little can be inferred; `raw` is stored as given.

## HTTP surface (behavior)

| Route | Behavior |
| --- | --- |
| `GET /me/inbox` | List folder, newest-first uid keyset. Empty page if no principal. |
| `GET /me/inbox/threads` | REFERENCES threads for the folder. Empty if no principal. |
| `GET /me/inbox/threads/:rootUid` | One thread. 403 / 404 as appropriate. |
| `POST /me/inbox/send` | Build frame, append Sent, then `deliver`. |
| `GET /me/inbox/events` | SSE `mailbox` events + heartbeat comments. |
| `POST /me/inbox/:uid/read` | Add `\Seen`. |
| `POST /me/inbox/:uid/unread` | Remove `\Seen`. |
| `POST /me/inbox/:uid/archive` | MOVE INBOX → Archive. |
| `POST /me/inbox/:uid/trash` | MOVE INBOX → Trash. |
| `POST /me/inbox/:uid/restore` | MOVE `?folder=` (default Archive) → INBOX. |

Send with `inReplyTo` looks up that msg-id across the four folders and
builds `References` as parent chain + parent. A missing parent still
threads on `inReplyTo` alone.

List items include envelope plus `raw` as base64. Events are a nudge:
`{ type: "mailbox", id, op? }` — refetch; do not treat the stream as a
change log.

## Events

The bus keys on the **pair** `(tenantId, principalId)`, never principal
alone (ids are unique only within a tenant).

Ops this package publishes: `create`, `mark_read`, `mark_unread`,
`archive`, `trash`, `restore`. `op` is required at the publish helper
and optional on the wire (historical / out-of-package events).

Delivery semantics, in-memory or host-supplied broker:

- **Missable.** Publish is best-effort after settle; a stalled SSE
  consumer whose queue exceeds the pending cap is disconnected, not
  buffered.
- **Duplicable** when there is no stable dedupe key, or when a host bus
  redelivers. Handling a repeat `op` for the same `id` must be a no-op.
- **Reorderable** across replicas. Do not infer "later event = later
  state."

`createInMemoryMailboxEventBus` is the zero-config default (one
process). Multi-replica hosts supply a broker-backed bus. One throwing
subscriber must not starve the others for that mailbox.

## Data model

Everything this package owns lives in schema `mailbox` in the **host's**
database — never `public`, never a database of its own. The FKs are why
there is no separate-database mode.

```
principal_mail     one row per message in one folder. IMMUTABLE except
                   flags / folder / uid / modseq on filing.
                   raw is the frozen RFC 5322 frame.

mailbox_state      per (tenant, principal, folder) IMAP counters.
```

`0005_drop_pre_native_columns` dropped `"mailbox"."mailbox"` (the
read_at / archived_at / trashed_at / priority / classification / status
/ assignee management layer). Filing is folder + flags on the mail row.

Control-plane FKs (`tenant_id`, `principal_id`) cascade. PKs are
`gen_random_uuid()::text` — Interchange uses `text` ids; this package
does not mint lookalike prefixed ids.

Timestamps are `timestamp without time zone` holding UTC, matching
Interchange. Queries must not cast the column (that drops the index);
cast the cursor instead if comparing.

Drizzle table objects in `schema.ts` describe the columns the old
read/write codec and `schema-ddl-parity` assert. The native store reads
folder / uid / modseq / flags via tagged SQL on purpose, so those
objects are not widened into a second source of truth for the native
slice.

## Host seams (outside mount)

| Seam | Role |
| --- | --- |
| `db` | Host drizzle handle over Interchange tables plus `mailbox.*`. |
| `authorizeSender` | Persist-path sender authorization. |
| `upstream` persist | Host's own record of the frame. |
| `onRow` / `enqueue` | Best-effort hooks after a mailbox append settles. |
| `purgeTenantMailbox` / `purgePrincipalMailbox` | Soft-delete offboarding. One DELETE on `principal_mail`; irreversible (`raw` is the only copy this package holds). |

Never import a host package. Wanting to is the signal to add a port.

## Migrations

Own ledger `mailbox.corbits_mailbox_migrations`, advisory-locked so
concurrent hub replicas cannot race DDL. Shipped statements are
immutable; an edit after apply fails boot with `MigrationChecksumError`.
`CREATE TABLE IF NOT EXISTS` matches on **name** only — after DDL,
`assertExpectedColumnTypes` refuses a pre-existing table of the same
name with the wrong column types (`SchemaTypeMismatchError`).

## Vendored `@intx/mailbox`

`@intx/mailbox` has never been published. Search, thread, MIME helpers,
and the `MailboxStore` interface are hand-copied under `vendor/` (no
submodule, no upstream commits). The published tarball bundles them into
`dist/` so consumers do not need those packages on npm. Kill condition:
first npm publish of `@intx/mailbox` at a pin this tree can depend on.
Ledger and rules: [VENDORED.md](./VENDORED.md).
