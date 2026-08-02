# Changelog

All notable changes to `@corbits/mailbox` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until 1.0, a minor bump may contain a breaking change; breaking changes are
always called out under their own heading.

## [Unreleased]

### Added

- **Live events name the operation that fired.** `MailboxEvent` gains an
  optional `op` (`MailboxEventOp`: `create`, `mark_read`, `mark_unread`,
  `trash`, `archive`, `restore`, `enrich`, `assign`) alongside the existing
  `id` — a listener can react to a specific kind of change without
  re-fetching and diffing the whole message. `op` is additive on the wire:
  it is optional on `MailboxEventSchema`, so an existing listener reading
  only `id` is unaffected, and a historical event replayed from before this
  field existed still validates. `publishMailboxEvent` requires `op` — every
  call site in this package always knew the operation, and the parameter now
  enforces that a future call site can't silently regress to an op-less
  event. `MAILBOX_EVENT_OPS` and `MailboxEventOp` are now exported.
- **Delivery semantics are documented.** Events can be missed (best-effort
  publish, bounded SSE queue with overflow disconnect); duplicated, but only
  when there is no stable dedupe key to prevent it — an undeduped inbox
  redelivery, or a broker-backed bus a host supplies redelivering itself; or
  arrive out of order (no cross-replica ordering guarantee) — see the
  README's SSE client contract and `MailboxEventBus`'s doc comment.

### Security

- Require `drizzle-orm` `>= 0.45.2` (peer and dev pins, plus a root
  override) past [GHSA-gpj5-g38j-94v9](https://github.com/advisories/GHSA-gpj5-g38j-94v9)
  — identifier SQL injection in `drizzle-orm` `<= 0.45.1`. Nested
  `@intx/*` deps that still declare `^0.45.1` resolve to `0.45.2` via the
  override.

### Changed

- **Inbox list no longer loads or decodes full MIME frames.** List selects every
  `principal_mail` column except `raw`, and projects `subject` / `from` from the
  denormalized caches only — no list `snippet`, and list `date` / `messageId` /
  `to` come from row fields rather than the frame. Message detail still loads
  `raw` and remains frame-authoritative for body, snippet, and header-derived
  fields. Clients that need a stable identity across list and detail should key
  on message `id`.
- **Bus publish isolates per-listener failures.** One throwing listener no longer
  prevents other listeners (or SSE clients) from receiving the event. SSE drain
  serializes writes and closes the stream on overflow or write failure.
- **Transport dual-write inserts are idempotent under retry.** Package-owned
  `messageKey` values (`transport:mid:…` / `transport:raw:…`) use
  `onConflictDoNothing`; management rows and bus announce only for rows returned
  by `RETURNING`.
- **Inbox idempotency keys are injective and versioned.**
  `mailboxKey.inbox(source, externalId)` encodes as
  `inbox2:<source.length>:<source>:<externalId>`, disjoint from pre-upgrade
  `inbox:` keys so a historical pure-decimal source cannot false-dedupe. No
  migration; redelivery after upgrade may insert a second row.
- **`deliverInboxItems` is one atomic batch transaction.** Mid-batch failure
  rolls back every new row from that call. Bus publish and optional host
  `enqueue` run only after commit for newly inserted ids; enqueue throws are
  logged and swallowed (same posture as bus publish).

### Breaking

- **Hard caps on frame size and transport recipient fan-out.** Frames above
  `MAX_MAILBOX_FRAME_BYTES` (1 MiB) and transport recipient lists longer than
  `MAX_MAILBOX_RECIPIENTS` (50) are refused with `RangeError` before durable
  insert. Direct write and `createMailboxPersist` both enforce the frame-byte
  cap; the recipient cap applies on the transport path only (raw address-list
  length, not post-resolve principal count — hosts must chunk larger fan-out).
  Inputs that previously inserted now throw on the direct-write path; on the
  transport dual-write path the same refusal is logged and swallowed so
  upstream success is unchanged.

## [0.1.0] — 2026-07-27

Initial public release. Nothing has been published before this, so everything is
new; the list below is what the surface consists of rather than what changed.

- `mountMailbox(app, opts)` — mounts a principal-keyed inbox under `/me/inbox*`
  on a host's existing Hono app: list with keyset paging and view/sort/filter,
  unread count, an SSE event stream, message detail, the read/unread, archive,
  trash and restore mutations, bulk actions, triage enrichment, and delegation
  via an `assignee` ref.
- `runMailboxMigrations(db)` — idempotent, advisory-locked, checksum-guarded,
  with its own ledger table. Safe to call on every boot of every replica. All
  DDL is schema-qualified into a dedicated `mailbox` Postgres schema in the
  host's database, and the host's control plane (`public.tenant`,
  `public.principal`) must exist before the first run — the foreign keys below
  reference it.
- Two tables in the `mailbox` schema, with **hard control-plane foreign keys**:
  `tenant_id -> public.tenant(id)` and `principal_id -> public.principal(id)`,
  both `ON DELETE CASCADE`, so a row can only belong to a scope the host knows
  and offboarding a tenant or principal carries its mailbox rows out with it.
  `principal_mail` is the message as delivered and is immutable — it reads 1-1
  with Interchange's `session_mail` for every column the two share. `mailbox`
  is the mutable management layer keyed by mail id
  (`read_at`/`archived_at`/`trashed_at` plus the triage columns), created
  **eagerly with its message in one transaction**: an all-NULL row means
  delivered-and-untouched, every mutation is a plain scoped `UPDATE`, and the
  unread count is an index-only scan of the partial
  `mailbox_tenant_id_principal_id_unread_idx`. The one package-internal foreign
  key is `mailbox.id -> principal_mail.id ON DELETE CASCADE`. The raw MIME
  frame is stored on the mail row and remains authoritative; `subject` and
  `from_address` are caches.

  Interchange's `session_mail` has no read/archive/trash layer at all, because
  agents don't triage their inbox. That layer is genuinely ours to own — it just
  does not belong on the mail row.
- **No closed vocabulary anywhere in the package.** `mountMailbox` requires
  `vocabulary: { priorities, statuses }` from the host, with no default:
  `priorities` is ordered most-urgent-first and the `sort=priority` ranking
  `CASE`, the query-string validation and the OpenAPI enums are all generated
  from it. `priority` and `status` are plain `text` columns with no `CHECK` and
  no drizzle enum. A value the host does not list — including the `NULL` of an
  untriaged message — ranks last. `classification` and `assignee` were already
  open host-defined strings. There are no `mailboxPriorities`/`mailboxStatuses`
  exports and no `MailboxPriority`/`MailboxStatus` types.
- **Priority cursors carry an ordering fingerprint.** The leading component of a
  priority keyset is an integer rank read out of the host's list, so a host that
  reorders its vocabulary would silently redefine what every in-flight cursor
  means. Such a cursor is now refused with a `400`, on the same mechanism and
  for the same reason `canonicalMailboxFilter` already refuses a cross-filter
  cursor. Date-sorted cursors carry no ranking and are unaffected.
- **Malformed list cursors are always a `400`, never a `500`.** The decoded
  `createdAt` is pinned to exactly the microsecond `to_char` shape this package
  mints — not merely something JS `new Date()` tolerates — and the priority
  rank must be a safe integer, so a crafted cursor never reaches Postgres.
- Index names follow Interchange's convention, `<table>_<column>_..._idx`.
- The scope columns are `tenant_id` and `principal_id`, and the corresponding
  TypeScript/wire fields are `tenantId` and `principalId` — matching
  Interchange's own `session_mail` (`tenant_id`, `direction`, `raw`,
  `created_at`) and the sibling `@corbits/*-core` packages, so the two models
  read 1-1. Not a breaking change: nothing has been published, and the single
  `0001_principal_mailbox` migration was edited in place — for the scope rename
  and again for the table split — rather than followed by rename or split
  migrations that no deployed database would ever have needed.
- Blank scopes are refused at the write boundary. `writeMailboxMessage`,
  `deliverInboxItems`, `enrichMailboxMessage`, `assignMailboxMessage` and the
  `createMailboxPersist` seam throw `RangeError` on an empty or whitespace-only
  `tenantId`/`principalId`; `deliverInboxItems` validates the whole batch before
  writing any of it. The control-plane foreign keys would refuse such a row too,
  but only as a driver error deep in the insert — the boundary check fires where
  the caller who typed `""` still has a stack to blame. Any other unknown scope
  is refused by the database itself. `assertMailboxScope` and
  `MailboxScopeIdsSchema` are exported.
- Inbound external mail addressed to a local part that is not a known principal
  in the authorized tenant is skipped with a warning rather than minting a
  phantom mailbox row — and one typo'd address never costs the frame's real
  recipients their durable copy.
- Every write path — `writeMailboxMessage` and the `createMailboxPersist`
  wrapper alike — writes the mail row and its management row in **one
  transaction**, so a crash between the two can never commit the mail row alone
  and strand a delivered message behind the `messageKey` dedupe with no
  management row.
- `purgeTenantMailbox(db, tenantId)` and `purgePrincipalMailbox(db, scope)` —
  explicit offboarding for hosts that soft-delete or archive control-plane rows,
  where the `ON DELETE CASCADE` never fires but the mail data must still go.
  Each is a **single `DELETE` on `principal_mail`** — the management rows follow
  through the id cascade, so a purge is atomic by construction — and both
  return the number of **messages** deleted. Both accept a transaction, so a
  host can offboard a tenant atomically with its own work.
- The SSE stream bounds its per-connection queue at `MAX_PENDING_SSE_EVENTS`
  (100); on overflow the server closes the stream. Events are non-durable
  nudges — the client contract (reconnect and refetch on any disconnect) is in
  the package README.
- Host seams: `resolvePrincipal`, a `MailboxEventBus` keyed by the
  `(tenantId, principalId)` pair (`MailboxEventScope`) — a principal id is only
  unique within its tenant, so a principal-only bus would fan one tenant's
  events out to another tenant's same-named principal — with an in-memory
  single-process default, an optional batched sender-display resolver, and
  `authorizeSender` on the transport dual-write wrapper.
- Write API: `writeMailboxMessage`, `deliverInboxItems`, and
  `createMailboxPersist` for wrapping a host's own mail-persist path.
- Requires `@intx/*` 0.2.2 or newer, Node 22+ or Bun 1.1+, Postgres 13+, and an
  Interchange-shaped control plane (`public.tenant`, `public.principal`) in the
  same database, created before `runMailboxMigrations` runs.

### Known cost of the split

Measured with `EXPLAIN (ANALYZE, BUFFERS)` on 60 000 messages in one mailbox
(including a 20 000-row `created_at` tie group) plus 30 000 belonging to others.
The `created_at` keyset path does **not** regress in kind — still a
single-table index scan with an index condition and no sort (0.08 ms ->
0.36 ms, the extra buffers being one primary-key probe per candidate row). The
unread count does not regress at all: eager management rows keep it an
index-only scan of a partial index that matches its predicate exactly. (An
earlier lazy-row design cost it ~26x; anti-join and covering-index alternatives
were measured under that design and rejected before eager rows resolved it.)
What remains: `sort=priority`, 28 ms -> 106 ms — it was already a sequential
scan plus a top-N sort, the rank was never index-servable, and is now that plus
a join over the management layer.

[Unreleased]: https://github.com/corbitsdev/corbits-mailbox/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/corbitsdev/corbits-mailbox/releases/tag/v0.1.0
