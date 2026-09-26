# Contributing

A small, deliberately boring codebase: strict TypeScript, arktype at the boundaries,
drizzle for data access, no magic.

Setup and the commands are in the [README](./README.md#working-on-it). `bun run
typecheck` must be clean — it is its own CI step, and `any` is not a way past it. The
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

- **Tests live next to the code**: `src/<module>.test.ts` beside `src/<module>.ts`,
  by design. Only end-to-end tests live elsewhere — the acceptance scenarios in
  `corbitsdev/examples` are the one exception, because they test the
  mounted whole, not a module.
- **Red first.** A bug fix starts with a test that fails for the reason you believe, and
  you should watch it fail. A test that was green before the fix proved nothing.
- **Coverage floor is 80% of lines and functions**, set by `coverageThreshold` in the
  package's `bunfig.toml` and applied by Bun **per file** — one badly covered new file
  fails the run even when the average looks fine. It is a floor, not a target.
- Assert **behavior a consumer can observe** — a status code, a returned shape, a row in
  the database — over internal call shapes.

## Migrations

Shipped migrations are immutable. Each ledger row carries a checksum of the migration's
statements, so editing one that has already been applied fails loudly on the next boot
rather than letting fresh and existing databases diverge. Add a new migration instead.

`schema.ts` and `migrations.ts` must agree statement for statement — the runtime
queries read through the drizzle table object, and `src/migrations.test.ts`
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
- Explain *why* in the commit message; the code already says what.
- CI must be green: typecheck, unit + integration, build,
  and a Node consumer smoke test that installs the packed tarball.
- Contributions are accepted under the repository's LGPL-2.1-only licence.
