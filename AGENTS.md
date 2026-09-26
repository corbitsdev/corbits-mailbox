# AGENTS.md

## Purpose

`@corbits/mailbox` is a native `@intx/mailbox` `MailboxStore` over Postgres for
human principals, plus the routes a host's UI uses to list, read, file and
send. It owns the `mailbox` schema, its tables and migrations, the `/me/inbox*`
HTTP surface, MIME frame building and decoding, the durable write path and the
triage mechanism. The host supplies the Hono app, the database handle, the
caller's tenant and principal, the triage vocabulary, sender authorization,
display names, the event bus for multi-replica setups and the mail transport.
This package neither sends nor receives SMTP.

## Layout

- `src/mount.ts` — `createMailboxRoutes`, the `/me/inbox*` routes and SSE stream.
- `src/native-store.ts` — the native `MailboxStore` over Postgres (uid and modseq always set).
- `src/write.ts` — the write boundary every host-facing write path goes through.
- `src/persist.ts` — `createMailboxPersist`, the transport dual-write seam.
- `src/frame.ts` — RFC 5322 frame building and decoding.
- `src/recipients.ts` — address-list parsing and owned-mailbox resolution.
- `src/bus.ts` — the event bus contract and the in-memory default.
- `src/purge.ts` — explicit offboarding.
- `src/schema.ts`, `src/schema-check.ts` — drizzle tables and the live-schema check.
- `src/migrations.ts` — `runMailboxMigrations`, replays `migrations/*.sql`.
- `src/db.ts` — the `MailboxDb` handle type.
- `src/index.ts` — the only module consumers import from.
- `e2e/` — real-Postgres suites; shared harness in `e2e/helpers.ts`.

## Rules

- Everything from the host arrives through a declared seam, never an import. Wanting to import a host package means adding a port.
- `POST /me/inbox/send` builds the message, files a copy in `Sent`, then calls the host's `deliver` exactly once.
- `createMailboxPersist` calls the host's `upstream` unconditionally and layers the inbox write on top, so a transport failure never costs a recipient their copy, and a mailbox refusal never rejects upstream success.
- `schema.ts` and `migrations/*.sql` change together, in the same commit. Every migration is idempotent.
- Caps refuse rather than clamp: `?limit=` above 200, bulk actions above 50 ids, frames above `MAX_MAILBOX_FRAME_BYTES`, recipients above `MAX_MAILBOX_RECIPIENTS`.
- SSE events are best-effort nudges with a bounded queue (`MAX_PENDING_SSE_EVENTS`); clients refetch on reconnect. The in-memory bus is single-process.
- Nothing is mocked at the database boundary. Unit tests only for load-bearing logic (frame and recipient parsing, guards, migrations); everything else is e2e.
- Every `any` or cast carries a comment saying why the type system leaves no alternative.

## Local development

```sh
bun install && bun run check
```
