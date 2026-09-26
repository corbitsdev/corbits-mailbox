# Contributing

## Development

```sh
bun install
bun run check
```

`bun run check` runs typecheck, lint, format check and unit tests. `bun run format` rewrites the tree.

Contributors sign the [CLA](CLA.md) on their first PR; the CLA bot explains how.

Most suites need a real Postgres: the unit tests for migrations and the write path, and everything in `e2e/`. They connect to `MAILBOX_TEST_DATABASE_URL`, which defaults to `postgres://postgres:postgres@localhost:5432/mailbox_core`. Start one with `docker run -d --name mailbox-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=mailbox_core postgres:16`, then run `bun run test:e2e`. Some suites create and drop a database each, so the role needs `CREATEDB`.

## Migrations

Every file in `migrations/` replays on each run, so each must be idempotent: DDL is `IF NOT EXISTS`, and a backfill runs in a `DO` block only in the replay that adds its column or table. Add a new file for a schema change; `e2e/upgrade-from-0.1.0.test.ts` proves a 0.1.0 database upgrades with no row changed and replays as a no-op. `schema.ts` and `migrations/*.sql` must agree statement for statement; `e2e/migrations.test.ts` diffs the two against a live database.

## Commit messages

Commit subjects and PR titles follow [Conventional Commits](https://www.conventionalcommits.org): `feat`, `fix`, `refactor`, `test`, `docs`, `build`, `ci`, `perf`, and `chore(release): x.y.z` for releases.
Add `!` only for public API breaks: removed or renamed exports, changed signatures, newly required params. Peer and dependency range changes are `build(deps):` with no `!`.
Keep subjects imperative, lowercase after the colon, 72 characters or less, and free of ticket IDs.
Every PR links its issue with a `Closes <issue id>` line in the PR body.

## Releasing

Releases are manual. On a clean, up-to-date `main`:

```sh
npm version <patch|minor> -m "chore(release): %s"
git push --follow-tags
gh release create "v$(node -p 'require("./package.json").version')" --generate-notes
npm publish
```

Bump minor only for breaking API changes; everything else is a patch. `prepack` builds `dist/` from the tagged commit.
