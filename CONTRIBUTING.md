# Contributing

A small, deliberately boring codebase: strict TypeScript, arktype at the boundaries,
drizzle for data access, no magic.

## Setup

```bash
git clone https://github.com/corbitsdev/corbits-mailbox.git
cd corbits-mailbox
bun install
docker run -d --name mailbox-pg -p 5433:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=mailbox_core postgres:16

bun run typecheck
bun run test
bun run test:e2e
bun run build
```

Some end-to-end suites in `e2e/` create and drop a database each, so the test role
needs `CREATEDB`.

## How it works

Writes go through a native `MailboxStore` (uid and modseq always set). Search and
threads are `@intx/mailbox` run over that store. `POST /me/inbox/send` builds the
RFC 5322 message, files a copy in `Sent`, then calls the host's `deliver` exactly once.
See [ARCHITECTURE.md](./ARCHITECTURE.md).

## Code

`bun run typecheck` must be clean — it is its own CI step, and `any` is not a way past it. The
few escapes in the tree each carry a comment explaining why the type system leaves no
alternative; new ones need the same.

## Most of the suite needs a real Postgres

Nothing is mocked at the database boundary. Migrations, indexes, cursors and
concurrency are asserted against a live server, because that is the only place they are
true. Database-touching tests clean up after themselves and must not assume they are
alone — concurrency behavior is part of the contract here.

The suite connects to `MAILBOX_TEST_DATABASE_URL`, which defaults to
`postgres://postgres:postgres@localhost:5433/mailbox_core` (the CI service's port).

## Acceptance scenarios live in corbitsdev/examples

The end-to-end acceptance scenarios that mount this package on a real
`@intx/hub-api` app against a live Postgres live in the `corbitsdev/examples`
repository, not here. If you change the mount seam, the write path, or anything
about how a host wires this up, show that change working there.

## Dependencies

Everything this package needs from a host arrives through a declared seam, never
through an import. Wanting to import a host-side package is the signal to add a
port instead.

## Tests

- **Unit tests are for load-bearing logic only** — the frame parser, the recipient
  parser, the scope and size guards, and migration idempotency and backfills. They live
  next to the code as `src/<module>.test.ts` and never ship.
- **Everything else is end-to-end** in `e2e/`, against a real Postgres and the mounted
  routes; shared harness code lives in `e2e/helpers.ts`.
- **Red first.** A bug fix starts with a test that fails for the reason you believe, and
  you should watch it fail. A test that was green before the fix proved nothing.
- Assert **behavior a consumer can observe** — a status code, a returned shape, a row in
  the database — over internal call shapes.

## Migrations

Every file in `migrations/` replays on each run, so each must be idempotent: DDL is
`IF NOT EXISTS`, and a backfill runs in a `DO` block only in the replay that adds its
column or table. Add a new file for a schema change; `e2e/upgrade-from-0.1.0.test.ts`
proves a 0.1.0 database upgrades with no row changed and replays as a no-op.

`schema.ts` and `migrations/*.sql` must agree statement for statement — the runtime
queries read through the drizzle table object, and `e2e/migrations.test.ts`
diffs the two against a live database. Change one, change the other, in the same commit.

## Agent-originated mail

`createMailboxPersist` wraps the host's own persist function. `authorizeSender` is the
host's check that a sender address is one it recognizes right now: a hub answers by
looking up the tenant a mailbox-routable address (a person, or a live agent run)
currently resolves to, and refuses anything else. `upstream` is the host's existing
mail-persist path. The wrapper calls it unconditionally and layers the durable inbox
write on top, so a transport failure never costs a recipient the copy that makes the
message readable later. The host calls the wrapped function wherever it delegates an
outbound frame; it does both writes.

## Pull requests

- Keep commits focused, and keep the diff to the change you are describing.
- Explain _why_ in the commit message; the code already says what.
- CI must be green: typecheck, unit, e2e, build,
  and a Node consumer smoke test that installs the packed tarball.
- Contributions are accepted under the repository's LGPL-2.1-only licence.

## Commit messages

Commit subjects and PR titles follow [Conventional Commits](https://www.conventionalcommits.org): `feat`, `fix`, `refactor`, `test`, `docs`, `build`, `ci`, `perf`, and `chore(release): x.y.z` for releases.
Add `!` only for public API breaks: removed or renamed exports, changed signatures, newly required params. Peer and dependency range changes are `build(deps):` with no `!`.
Keep subjects imperative, lowercase after the colon, 72 characters or less, and free of ticket IDs.
Every PR links its issue with a `Closes <issue id>` line in the PR body.
