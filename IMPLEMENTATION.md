# @corbits/mailbox — Implementation

## Package

- Name: `@corbits/mailbox` `1.0.0`
- License: LGPL-2.1-only
- Public export: `./dist/index.js` + `./dist/index.d.ts` (built JS).
  `package.json` `files` also ships `src/` (tests excluded), `LICENSE`,
  and `README.md`. These design docs are repository-root only; they are
  not in the npm tarball.
- `engines.node`: `>=24`. Node consumes `dist/`. Bun is the development
  runtime (`bun test`, `bun run typecheck`).
- `corbits.minimumIntxVersion`: `0.2.2`.

## Runtime dependencies

Peers (must resolve to the host's copies):

- `@intx/log` `^0.2.2`
- `drizzle-orm` `^0.45.2` (override pins `0.45.2` past
  [GHSA-gpj5-g38j-94v9](https://github.com/advisories/GHSA-gpj5-g38j-94v9))
- `hono` `^4.12.0`
- `postgres` `^3.4.0` (dev pin `3.4.9`)

Direct:

- `arktype` at trust boundaries
- `hono-openapi` + `@hono/standard-validator` + standard-community JSON /
  OpenAPI helpers for `describeRoute`
- `@intx/crypto` `0.3.0` (published; byte-identical to the vendor pin)

Workspace / vendored (build-time, not in the published
`dependencies` / `peerDependencies`): `@intx/mailbox`, `@intx/mime`,
`@intx/types`. `scripts/build.mjs` bundles them into `dist/index.js` and
rewrites `.d.ts` specifiers to `dist/vendor/<name>/`. See
[VENDORED.md](./VENDORED.md).

## Install

```sh
npm add @corbits/mailbox
pnpm add @corbits/mailbox
yarn add @corbits/mailbox
bun add @corbits/mailbox
```

## Public surface

From `@corbits/mailbox`:

**Mount and migrations**

- `mountMailbox(app, opts)` — `/me/inbox*`
- `runMailboxMigrations(db)`
- `MigrationChecksumError`, `assertExpectedColumnTypes`,
  `expectedColumnTypes`, `SchemaTypeMismatchError`
- `createMailboxDb(connectionString)` → `{ db, close }`
- `MAX_MAILBOX_PAGE_LIMIT` (200), `MAX_PENDING_SSE_EVENTS` (100)

**Native store**

- `openNativeMailboxStore`, `createPrincipalMailboxStore`,
  `moveNativeMailboxMessage`
- Type `NativeMailboxStore`

**Writes**

- `writeMailboxMessage(db, args, bus?)` → `{ id, uid } | null`
- `deliverInboxItems(db, items, opts?)` → `{ id: string | null }[]`
- `createMailboxPersist(db, opts)` — dual-write wrapper
- `MAX_MAILBOX_FRAME_BYTES` (1_048_576), `MAX_MAILBOX_RECIPIENTS` (50)
- `assertMailboxScope`, `assertMailboxTenantId`,
  `assertMailboxFrameBytes`, `MailboxScopeIdSchema`,
  `MailboxScopeIdsSchema`
- `purgeTenantMailbox`, `purgePrincipalMailbox`

**Frames, bus, schema**

- `buildMailFrame`, `generateMailboxMessageId`,
  `MESSAGE_ID_FALLBACK_DOMAIN` (`hub.invalid`)
- `createInMemoryMailboxEventBus`, `MailboxEventSchema`,
  `MAILBOX_EVENT_OPS`
- `principalMail`, `mailboxPgSchema`
- `parseAddressList`, `resolveMailboxRecipients`

`writeMailboxMessages` and `resolveRefs` on persist are **not** on this
export surface.

## Mount

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

`MountMailboxOpts.deliver` receives `{ raw, from, to, messageId }` after
the Sent append settles.

## Routes

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/me/inbox` | `folder`, `limit`, `cursor` (uid). 200 `{ messages, nextCursor? }`. No principal → `{ messages: [] }`. |
| GET | `/me/inbox/threads` | `folder`. 200 `{ threads }`. No principal → `{ threads: [] }`. |
| GET | `/me/inbox/threads/:rootUid` | 403 / 404. |
| POST | `/me/inbox/send` | Body `{ to: string[] > 0, subject?, body: string > 0, inReplyTo? }`. 200 `{ messageId, uid }`. |
| GET | `/me/inbox/events` | `text/event-stream`; event name `mailbox`; heartbeat `: heartbeat`. |
| POST | `/me/inbox/:uid/read` | `\Seen` on. `?folder=` (default INBOX). |
| POST | `/me/inbox/:uid/unread` | `\Seen` off. |
| POST | `/me/inbox/:uid/archive` | MOVE INBOX → Archive. 200 `{ uid, ok }` with the **new** uid. |
| POST | `/me/inbox/:uid/trash` | MOVE INBOX → Trash. |
| POST | `/me/inbox/:uid/restore` | MOVE `?folder=` (default Archive) → INBOX. |

OpenAPI tags: `mailbox` (`hono-openapi` `describeRoute`).

List item: `{ uid, flags, envelope, raw }` with `raw` base64 and
`envelope.date` as ISO string.

## Protocols and formats

- **RFC 5322 / MIME** frames via vendored `@intx/mime`
  (`buildMailFrame` / `decodeMailFrame`). Header values are newline-
  flattened so a subject cannot smuggle headers.
- **Message-ID** shape: bracketed `<local@domain>` (`assertMsgId`).
  Quoted-string local parts allowed (`obs-id-left`). Minted ids are
  `<uuid@sender-domain>` or `@hub.invalid` (RFC 2606 reserved TLD).
- **Threading:** `In-Reply-To` (one parent) + folded `References:`
  (oldest first). `executeThread(..., "references")`.
- **IMAP-shaped** uid / modseq / `\Seen` / folders. Not an IMAP server.
- **SSE:** `event: mailbox` + JSON `{ type: "mailbox", id, op? }`.
  Heartbeat is a comment line, default 25s.
- **arktype** at HTTP and scope boundaries. `RangeError` from this
  package is a caller bug (mount maps it to 400 where it handles it).

Ingress minted ids:

```
<inbox-{source}-{externalId}@mailbox.invalid>
```

Event `id` strings:

- writes / persist: `{tenantId}:{principalId}:{folder}:{uid}`
- send: `Sent:{uid}`
- flag / move publish: `{folder}:{uid}` (destination folder after MOVE)

## Native store SQL

`openNativeMailboxStore` uses tagged `drizzle-orm` `sql`, not the
`schema.ts` table objects, for folder / uid / modseq / flags. Postgres
`text[]` flags bind through a quoted array literal (`pgTextArrayLiteral`)
because drizzle's `sql` tag would otherwise expand an array as a
comma-list.

`created_at` is naive UTC. Selects format with
`to_char(..., '...Z')` so `new Date` is UTC regardless of session TZ.
Never cast the column in `WHERE`.

`append` currently stores `direction = 'inbound'` even for Sent copies
(folder, not direction, is the filing axis on the native path).

## Schema and migrations

Postgres schema `mailbox`. Ledger table `corbits_mailbox_migrations`.
Advisory lock key `0x0a27_2c01`.

| Id | What |
| --- | --- |
| `0001_principal_mailbox` | schema, `principal_mail`, pre-native `"mailbox"."mailbox"` |
| `0002_mail_threading_headers` | `message_id`, `in_reply_to` + backfill from `raw` |
| `0003_mail_references` | `references` jsonb, indexes, typecheck before GIN |
| `0004_native_mailbox_store` | `folder`, `uid`, `modseq`, `flags`, `mailbox_state` + backfill from management rows |
| `0005_drop_pre_native_columns` | uid/modseq NOT NULL; drop `"mailbox"."mailbox"` |
| `0006_mail_to_addresses` | `to_addresses` jsonb |

FKs target `"public"."tenant"("id")` and `"public"."principal"("id")`,
`ON DELETE CASCADE`. Constraint names follow drizzle's convention.

Checksum: SHA-256 of rendered statements with whitespace collapsed
(same rule as sibling cores). Editing a shipped migration fails boot.

## Persist

```ts
const persist = createMailboxPersist(db, {
  upstream: hostMailTransport.persist,
  authorizeSender: (address) => resolveActiveInstance(address),
  bus,
});
```

`MailboxPersistArgs`: `{ senderAddress, recipients, raw }`. Recipient
resolution: parse address list, keep those whose domain matches the
authorizer, map local part to `principal.id` or lowercased `refId`.

## Development

```sh
git clone https://github.com/corbitsdev/corbits-mailbox.git
cd corbits-mailbox
bun install
docker run -d --name mailbox-pg -p 5433:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=mailbox_core postgres:16

bun run typecheck
bun run test             # bun test src
bun run build            # dist/ (JS + .d.ts)
bun run test:acceptance  # build, then examples/reference-host
```

Tests expect
`postgres://postgres:postgres@localhost:5433/mailbox_core`; override
with `MAILBOX_TEST_DATABASE_URL` / `MAILBOX_DATABASE_URL`. Database-
touching tests are live Postgres; coverage floor 80% of lines and
functions per file (`bunfig.toml`). The reference host asserts against
built `dist/`. See [CONTRIBUTING.md](./CONTRIBUTING.md).
