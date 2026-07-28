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

## The reference host is the acceptance suite, not a demo

`examples/reference-host` mounts the package on a real `@intx/hub-api` app against a
live Postgres and asserts the end-to-end scenarios against the built `dist/` — the same
artifact a consumer installs. Build before running it, or you are asserting against a
stale compile.

If you change the mount seam, the write path, or anything about how a host wires this
up, the reference host is where that change has to be shown working.

## Dependencies

Everything this package needs from a host arrives through a declared seam, never
through an import. Wanting to import a host-side package is the signal to add a
port instead.

## Tests

- **Tests live next to the code**: `src/<module>.test.ts` beside `src/<module>.ts`,
  by design. Only end-to-end tests live elsewhere — the acceptance suite in
  `examples/reference-host/test/` is the one exception, because it tests the
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

`schema.ts` and `migrations.ts` must agree statement for statement — the drizzle table
object is a public export, and `src/schema-ddl-parity.test.ts` diffs the two against a
live database. Change one, change the other, in the same commit.

## Pull requests

- Keep commits focused, and keep the diff to the change you are describing.
- Explain *why* in the commit message; the code already says what.
- CI must be green: typecheck, unit + integration, build, reference-host
  acceptance, and a Node consumer smoke test that installs the packed tarball.
- Contributions are accepted under the repository's LGPL-2.1-only licence.
