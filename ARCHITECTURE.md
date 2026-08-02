# Architecture

How `@corbits/mailbox` is put together, and what it does and does not ask of
the host that mounts it. For install, the mount snippet, the route table and the
response contracts, see the [package README](./packages/mailbox/README.md) —
this document is about structure and reasoning, and does not repeat them.

## The shape of the thing

A **library, not a service**. It creates no HTTP server, opens no connection
pool by default, owns no configuration, and starts no background work. A host
calls two functions:

- `runMailboxMigrations(db)` — once at boot, before serving.
- `mountMailbox(app, opts)` — registers routes under `/me/inbox*` on a Hono app
  the host already built, and returns the same app.

## Where the routes are served

The core registers root-relative paths and takes no base path, so the *mount
point* is the host's decision. The convention every `@corbits/*-core` package
documents is **`/api`** — the prefix Interchange serves its own routes under.
No `/v1` segment, no vendor prefix.

```ts
const api = new Hono<AppEnv>();
mountMailbox(api, { db, bus, resolvePrincipal, vocabulary });
app.route("/api", api);
```

which serves `/api/me/inbox`, `/api/me/inbox/unread-count`,
`/api/me/inbox/events`, `/api/me/inbox/:id`, and the `POST` mutations beneath
them. Nesting rather than teaching the core a base path keeps the frozen
`mountX<E extends Env>(app, opts) => Hono<E>` seam untouched, and lands the
mailbox behind whatever the host already declared for `/api/me/*` — on an
Interchange host, `requireAuth`.

## The mount seam

`mountMailbox<E extends Env>(app: Hono<E>, opts): Hono<E>` is generic over the
host's Hono `Env` and returns the app unchanged in type. Everything the package
cannot know on its own arrives through `opts`; nothing is reached for.

| Option | Required | What it is |
| --- | --- | --- |
| `db` | yes | A drizzle `postgres-js` handle. The schema generic is `any` on purpose, so the host passes the handle it already has instead of opening a second pool. |
| `bus` | yes | `MailboxEventBus` — per-mailbox fan-out backing the SSE route, keyed by the `(tenantId, principalId)` pair (`MailboxEventScope`). `createInMemoryMailboxEventBus()` ships as the zero-config default. |
| `resolvePrincipal(ctx)` | yes | `{ tenantId, principalId } \| null`. `ctx` is typed `unknown`, so no Hono context typing leaks into the seam. |
| `vocabulary` | yes | `{ priorities, statuses }` — the host's triage taxonomy; there is no default. |
| `resolveSenderDisplays` | no | Batched `(tenantId, fromHeaders) => Map<address, label>`. Omitted, messages carry only the raw `From:` header. |
| `heartbeatIntervalMs` | no | SSE keep-alive period, default 25s (under the 30s idle timeout most proxies default to). Exists so a test can observe a heartbeat without waiting. |

What it does **not** require: no auth middleware, no session library, no logger
configuration, no UI. What it *does* require of the database is an
Interchange-shaped control plane: `public.tenant` and `public.principal` in the
same database, in place before `runMailboxMigrations` runs, because the mailbox
tables foreign-key to both. Nothing changed in Interchange to make that work —
the coupling lives entirely on this side.

One further seam lives outside `mountMailbox`, on the write side:
`createMailboxPersist(db, { upstream, authorizeSender, bus?, onRow? })` wraps a
host's own mail-persist function so every addressed principal also gets a
durable row. `authorizeSender(address) => { tenantId, domain } | null` is the
host's decision — whether a sender address belongs to a *live* agent instance
is not a schema fact. Returning `null` skips the mailbox write entirely while
the frame still goes upstream. On the recipient side the package does consult
the control plane: an address whose local part matches no known principal in
the authorized tenant is skipped with a warning rather than minting a phantom
mailbox row, and never costs the frame's real recipients their durable copy.

The wrapper's contract is **dual-write independence in both directions**: an
`upstream` throw still attempts the mailbox write and then re-throws the
original error, and a mailbox-write failure is logged and never rejects a
persist that upstream already completed. Under retry, the mailbox side is
idempotent: package-owned transport `messageKey`s plus `onConflictDoNothing`
collapse duplicate frames without failing the call or re-announcing.

`resolvePrincipal`'s signature is identical across the Corbits cores, so a host
mounting more than one passes the same function to each.

## Modules

| File | Role |
| --- | --- |
| `mount.ts` | HTTP surface. Parsing, validation, status codes, SSE. No SQL. |
| `read.ts` | List (cached columns, no `raw`) and detail (frame-decoded) projection, keyset paging, snippets on detail. |
| `mutations.ts` | Read/unread, archive, trash, restore, bulk, enrich, assign. |
| `write.ts` | `writeMailboxMessage` / `deliverInboxItems` — the host-facing write API. |
| `persist.ts` | The transport dual-write wrapper and the `authorizeSender` seam. |
| `frame.ts` | Building and decoding RFC 5322 frames, multipart included. |
| `cursor.ts` | Cursor encoding plus the view/sort/filter vocabulary and its fingerprints. |
| `recipients.ts` | Address-list parsing and domain-scoped recipient resolution. |
| `sender-display.ts` | The pure half of display names, plus the resolver seam. |
| `vocabulary.ts` | The host's triage vocabulary: validation, the generated rank, the ordering fingerprint. |
| `schema.ts` / `migrations.ts` | The two tables, and the DDL that creates them. |
| `bus.ts` / `db.ts` / `refs.ts` | The event-bus port, the db handle type, the ref schema. |

## Data model

Two physical tables, plus this package's own migration ledger — all living in a
dedicated `mailbox` Postgres schema in the HOST's database
(`"mailbox"."principal_mail"`, `"mailbox"."mailbox"`), never in `public` and
never in a database of their own. Every row in either belongs to exactly one
`(tenant_id, principal_id)` mailbox.

```
principal_mail   the message as delivered. IMMUTABLE.
                 id, tenant_id, principal_id, address, direction, raw,
                 subject, from_address, message_key, refs, created_at

mailbox          the management layer, keyed by mail id. Mutable.
                 read_at, archived_at, trashed_at           (universal)
                 priority, classification, status, assignee (triage)
```

**Why the split.** Interchange's `session_mail` is the message as delivered and
nothing more — no `read_at`, no archive, no triage — because agents don't
triage their inbox. The moment mail is served to a *human* all of that becomes
necessary, so the management layer is genuinely ours to own; it just does not
belong on the mail row, which has to keep reading 1-1 with Interchange's.
`principal_mail` matches `session_mail` for every column the two share, and
everything a human does to a message afterwards lives one join away. One name
deliberately does *not* line up: `session_mail.status` is *delivery* state
while `mailbox.status` is *triage* state — same word, different meaning, and at
least on different tables.

**The management row is created eagerly, with its message, in one
transaction** — both on the `writeMailboxMessage` path and on the
`createMailboxPersist` path. An all-NULL row means delivered-and-untouched.
Guaranteed presence is what makes the rest of the design simple:

- Every mutation is a **plain scoped `UPDATE`** on `mailbox` — no upsert, no
  first-touch race. A message outside the caller's scope matches no row, which
  the routes read as 404.
- The unread count is an **index-only scan** of the partial index
  `mailbox_tenant_id_principal_id_unread_idx` (`WHERE read_at IS NULL AND
  archived_at IS NULL AND trashed_at IS NULL`) — possible only because every
  message carries a row.
- The single transaction is load-bearing: split, a crash between the two writes
  would commit the mail row alone, and a retry would hit the `messageKey`
  dedupe and return null, leaving a message no mutation can reach.

**One foreign key of our own.** `mailbox.id REFERENCES principal_mail(id)
ON DELETE CASCADE` makes a message and its management state one lifecycle.
Each purge (`purgeTenantMailbox`, `purgePrincipalMailbox`) is therefore a
**single `DELETE` on `principal_mail`** — the management rows follow through
the cascade, so a purge is atomic by construction, with no transaction to
manage. Both take the caller's `db` handle, so a host can run them inside its
own offboarding transaction; neither is scoped by view, because an offboarded
tenant's trash is as much their data as their inbox.

**Hard control-plane foreign keys.** `tenant_id` and `principal_id` on both
tables reference the host's `public.tenant` and `public.principal`, both
`ON DELETE CASCADE` — the same posture as Interchange's own
`session_mail.tenant_id`, extended to the principal. Consequences, stated
rather than hidden: the control plane and the mail plane must share one
database, the control-plane tables must exist before `runMailboxMigrations`
runs, and there is no separate-database mode. Deleting a tenant or principal
row carries every one of its mailbox rows out; the explicit purges exist for
hosts that soft-delete control-plane rows, where no cascade ever fires.
(`assignee` and `address` remain plain `text` held by value — an assignment
must survive the assignee's principal being offboarded.)

The **migration DDL is the single owner of the constraints**: the FKs are
declared there and deliberately not restated as drizzle `.references()` thunks
in `schema.ts`, which declares only the columns. The one host table `schema.ts`
still stubs is `principal` (`hostPrincipal`), read by the delivery-time
recipient existence check — never created or migrated here.

Two layers sit deliberately in front of the FKs:

- *The write boundary* (`src/scope.ts`). Every write path refuses a blank or
  whitespace-only `tenantId`/`principalId` with a `RangeError` at the boundary,
  where the caller still has a stack — the FK would refuse it too, but as a
  driver error deep in the insert. `deliverInboxItems` checks the whole batch
  before writing any of it, so the refusal is all-or-nothing. Identifiers are
  never trimmed on the caller's behalf.
- *The delivery filter* (`src/persist.ts`). Recipient local parts are
  sender-controlled; unknown locals are resolved against `public.principal`
  first and skipped with a warning, so one typo'd address never costs the real
  recipients on the same frame their durable copy, and external mail cannot
  mint a phantom mailbox row.

**Column types are Interchange's.** Ids are `text` defaulting to
`gen_random_uuid()::text`, not `uuid` — every Interchange table is
`text("id").primaryKey()`, and an id should not change type at the seam.
Timestamps are `timestamp without time zone` holding UTC, and the rule that
follows is one the read path must keep: **the column is never cast**.
`timestamp → timestamptz` is `STABLE`, not `IMMUTABLE`, so a cast on the column
side drops the keyset page out of `Index Cond` into `Filter`. The *cursor* is
cast instead, and to `::timestamp` — a `timestamptz` literal resolves through
the session's TimeZone, so on a non-UTC host the same cursor silently seeks to
a different row. `src/read-non-utc-session.test.ts` pins a non-UTC session for
exactly that reason.

**The raw frame is the authority on detail.** `raw bytea` holds the complete
MIME frame; `subject` and `from_address` are caches parsed once at write time.
List reads those caches only (no `raw`, no decode, no snippet). A frame the MIME
parser rejects still persists — detail reads degrade to an empty body rather
than a 500 — and improving the parser improves *existing* rows, because nothing
was thrown away at write time.

**Dedupe is partial on purpose.** The unique index on
`(tenant_id, principal_id, message_key)` is `WHERE message_key IS NOT NULL`.
Mail arriving without a stable key — most external mail — is left
unconstrained rather than collapsed onto a single NULL-keyed row per mailbox.
Keys are namespaced by path:

- **Inbox ingress** (`mailboxKey.inbox`) uses a versioned length-prefixed
  encoding `inbox2:<source.length>:<source>:<externalId>` so pairs that contain
  `:` cannot collide, and so the space is disjoint from pre-upgrade
  `inbox:<source>:<externalId>` keys (length-prefix under `inbox:` alone would
  false-collide when a historical source was pure decimal). No migration is
  performed; redelivery after upgrade may insert a second row.
- **Transport dual-write** stamps `transport:mid:<Message-ID>:<principalId>` or
  `transport:raw:<sha256>:<principalId>` and inserts with `onConflictDoNothing`,
  so a retried frame does not fail on unique-violation. Management rows and bus
  announce only for rows returned by `RETURNING`.
- **Gate / run** keys remain under their own namespaces via `mailboxKey`.

**Batch delivery is one transaction.** `deliverInboxItems` prevalidates blank
scopes, then commits every new row in the call in a single transaction (or
none). Deduped keys are no-ops inside the transaction. Bus publish and the
optional host `enqueue` hook run only after commit, and only for newly inserted
ids. Both side effects are best-effort: a throw is logged with the message id
and never rejects the delivery.

**Bus publish isolates listeners.** `publishMailboxEvent` invokes each
subscriber independently; one throwing listener does not stop the others. SSE
connections serialize writes, bound the pending queue, and close on overflow or
write failure rather than buffering forever.

**The event names the operation that fired.** `publishMailboxEvent` takes an
optional `op` (`MailboxEventOp`: `create`, `mark_read`, `mark_unread`, `trash`,
`archive`, `restore`, `enrich`, `assign`) and, when given one, includes it on
the published event. Every call site in this package passes one — the two
delivery paths (`writeMailboxMessage`, `deliverInboxItems`) and the transport
dual-write (`createMailboxPersist`) publish `create`; `mountMailbox`'s route
table passes the mutation's own identifier, reusing `MailboxBulkAction`'s
vocabulary for the single-message verbs so "read one" and "read fifty" report
the same op. `op` is optional on `MailboxEventSchema` — additive, not a
reshape: a listener built against the original `{ type, id }` shape still
validates and still works.

**Triage enriches the message, not a task.** `priority`, `classification`,
`status` and `assignee` are columns on the message's management row, not a
spawned work item. Delegation is the `assignee` ref: the item stays in the
delegator's mailbox. The vocabulary is the host's — `priorities` is ordered,
most urgent first, and that order *is* the ranking `sort=priority` uses;
`priority` and `status` are plain `text` with no `CHECK`, because a constraint
here would freeze one product's taxonomy into every adopter's database. A value
the host no longer lists — including `NULL` — ranks last.

**Cursors are bound to the result set that minted them.** A priority cursor
carries a canonical rendering of the host's ordering, and a mismatch is a
`400` — a reordered vocabulary must not silently redefine what an in-flight
rank means. A malformed cursor is always a `400`, never a `500`: the decoded
`createdAt` is pinned to exactly the microsecond `to_char` shape this package
mints, and the priority rank must be a safe integer, so a crafted cursor never
reaches Postgres.

**Indexes are query-shaped**, named the way Interchange names them, and every
one leads with `(tenant_id, principal_id)` because every query is scoped to one
mailbox. The keyset — `(tenant_id, principal_id, created_at DESC, id DESC)` —
stays on `principal_mail`, matching the list's `ORDER BY` and its row-value
cursor seek exactly, so the default (highest-traffic) page remains a
single-table index scan that stops at `limit + 1` rows. The triage indexes and
the three partial view indexes (`unread`, `archived_at`, `trashed_at`) live on
`mailbox`.

### What the split costs, measured

`EXPLAIN (ANALYZE, BUFFERS)` on one principal with 60 000 inbound messages
(including a 20 000-row `created_at` tie group) plus 30 000 belonging to
others:

| Query | Before (one table) | After (split) |
| --- | --- | --- |
| default `created_at` keyset page, deep cursor | 0.08 ms, 9 buffers | 0.36 ms, 172 buffers — same plan shape, no sort |
| `sort=priority` page, deep cursor | 28 ms, 10 332 | **106 ms, 8 031** |
| unread count | index-only scan | index-only scan on `mailbox` |

The keyset path does not regress in kind — the extra buffers are the
primary-key probes into `mailbox`, one per candidate row. The unread count,
which regressed badly under an earlier lazy-row design, is resolved by eager
row creation: it is once again a single index-only scan of a partial index
that matches its predicate exactly. What remains, honestly: **`sort=priority`
pays a join** over the management layer on top of a rank that was never
index-servable, ~3.8x its pre-split cost.

`schema.ts` and `migrations.ts` must agree statement for statement: the drizzle
table object is a public export, so a host pointing `drizzle-kit` at it would
otherwise recreate indexes the migrations do not have.
`src/schema-ddl-parity.test.ts` diffs the two against a live database.

## Migrations

`runMailboxMigrations(db)` is idempotent and safe to call unconditionally on
every boot of every replica.

- The whole run is one transaction whose first statements are
  `SET LOCAL client_min_messages = warning` and a **transaction-scoped**
  advisory lock. A transaction pins one pooled connection, so the lock, the
  ledger read and the DDL are the same session, and the lock releases on commit
  or rollback with no unlock call to lose. `CREATE TABLE IF NOT EXISTS` is not
  itself race-safe, so the lock — not the `IF NOT EXISTS` — is what makes
  concurrent cold starts safe.
- Lowering `client_min_messages` is why a re-run prints nothing: every
  statement is `IF NOT EXISTS`, and postgres.js would otherwise dump each
  NOTICE object to the console on every replica start.
- The ledger is this package's own table,
  `"mailbox"."corbits_mailbox_migrations"`, never shared with the host's
  migration bookkeeping. Each row records a **checksum of the migration's
  rendered statements**, `NOT NULL`, so editing a shipped migration fails with
  a named `MigrationChecksumError` on the next boot instead of leaving deployed
  databases silently behind fresh ones. Ship a new migration instead. The
  checksum normalization is character-for-character the sibling cores'.
- Each migration applies inside a **savepoint** together with its ledger row,
  so it can never be recorded as applied with only some statements run.
- **Last, on the same transaction, `assertExpectedColumnTypes` runs**
  (`src/schema-check.ts`). `CREATE TABLE IF NOT EXISTS` compares the table name
  and nothing else, so against a host that already owns a `mailbox` or
  `principal_mail` it would silently no-op and every read would decode the
  host's columns through our codec. The expectation is derived from the drizzle
  table objects, so it cannot drift; a rejected boot rolls the ledger row back
  with it.

**Everything lands in the `mailbox` schema, fully qualified.** Nothing resolves
through `search_path`, so the host's own setting cannot redirect or shadow
where the mailbox tables live. The one ordering constraint mounting imposes is
the control plane's: the DDL's foreign keys reference `public.tenant` and
`public.principal`, so those tables must exist before the first run.

## Boundaries

Owned by this package: the `mailbox` Postgres schema, its two tables, their
indexes and migrations; the `/me/inbox*` HTTP surface, its validation and
status codes; MIME frame construction and decoding; the durable write path and
its idempotency; and the triage *mechanism* — the ranking, the filters, the
delegation ref.

Supplied by the host: the Hono app and the database handle (pointed at the
database where `tenant` and `principal` live); the triage **vocabulary**; who
the caller is (`resolvePrincipal`); whether a sender may deliver
(`authorizeSender`) and to which tenant; display names
(`resolveSenderDisplays`); an event bus, if one process is not enough; and the
actual mail transport — this package neither sends nor receives SMTP.

## Known limits

- **The default bus is single-process.** `createInMemoryMailboxEventBus()` fans
  out within one process only. A host running multiple replicas must supply a
  broker-backed `MailboxEventBus`, or SSE clients will only see events raised
  by the replica they are connected to.
- **SSE events are non-durable nudges.** Publication is best-effort after
  commit, each connection's queue is bounded at `MAX_PENDING_SSE_EVENTS` (100),
  and a consumer that stops reading is disconnected rather than buffered for.
  Events can be missed (dropped publish, overflow disconnect), duplicated (an
  undeduped redelivery, or a broker-backed bus redelivering), or arrive out of
  order (no cross-replica ordering guarantee). The client contract — reconnect
  and refetch the list and unread count on any disconnect, and never trust
  event arrival order over a refetch — is documented in the package README.
- **`sort=priority` pays a cross-table join** on top of a rank that was never
  index-servable; see the measurements above.
- **List routes read inbound rows.** The `direction` column admits outbound
  rows and the write path can create them, but the inbox views are
  inbound-only; there is no "sent" view and no send route.
- **No search.** Filtering is by view, priority, classification, status and
  assignee. There is no full-text index over subjects or bodies.
- **Reordering the host's `priorities` invalidates in-flight priority
  cursors** — they 400 rather than paging against a ranking that changed
  underneath them. Appending a new band has the same effect, because it changes
  what the trailing "unknown" rank means.
- **`?limit=` is refused, not clamped,** above 200. A caller that asked for 500
  and silently received 200 would page as though it had 500 rows.
- **Bulk actions cap at 50 ids** and report per-id results; partial success is
  the normal outcome, not an error.
- **Frame size is hard-capped at `MAX_MAILBOX_FRAME_BYTES` (1 MiB)** on both
  direct write (after `buildMailFrame`) and the transport dual-write path
  (raw bytes). **Transport recipient lists hard-cap at
  `MAX_MAILBOX_RECIPIENTS` (50)** before resolve / multi-row insert. Both refuse
  with `RangeError` rather than clamping; the transport path still preserves
  dual-write independence (mailbox refusal does not reject upstream success).

