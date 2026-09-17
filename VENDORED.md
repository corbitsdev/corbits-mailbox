# Vendored code

`@corbits/mailbox` consumes Interchange as published packages wherever a
publish covers the needed capability. `@intx/mailbox` has never been
published, so it is hand-copied here as a sanctioned escape hatch — never a
submodule, never touched upstream. Its two compile-time dependencies that
are published only at an older API surface (`@intx/mime`, `@intx/types`)
are vendored alongside it at the same commit so the tree never mixes pins;
`@intx/crypto`, byte-identical between npm `0.3.0` and this commit, is
consumed as an ordinary npm dependency instead.

## Rules

- Vendoring is hand-copied files only — never a git submodule.
- Every vendored path has exactly one row below, with a kill date and a
  dated test that fails after it.
- The upstream repository is never modified, committed to, or pushed to.
- Retiring a vendored copy closes the entry: delete the row and the files
  together.

## Ledger

| Path | Contents | Upstream | Local delta | Kill condition |
| --- | --- | --- | --- | --- |
| `vendor/intx-mailbox` | `@intx/mailbox` source (`src/`, `package.json`, `LICENSE`) | [faremeter/interchange](https://github.com/faremeter/interchange) @ `692c3106` (origin/main, 2026-09-03), copied from Workbench's own `vendor/intx/mailbox` pin | Package-manager pins only: `catalog:` ranges resolved to this repo's fixed versions (`arktype` 2.1.29, `typescript` 5.7.2, `@types/bun` 1.1.14); dependency versions repointed to `workspace:*` for `@intx/mime`/`@intx/types`. No source delta. | First npm publish of `@intx/mailbox` |
| `vendor/intx-mime` | `@intx/mime` source at the `@intx/mailbox` pin | same commit as above | Same pin/catalog cleanup as above. No source delta. Needed because npm `0.3.0` predates `buildMessageHeaders` and other exports `@intx/mailbox` at this pin imports. | Retired when `@intx/mailbox` publishes against a released `@intx/mime` that carries these exports |
| `vendor/intx-types` | `@intx/types` source at the `@intx/mailbox` pin | same commit as above | Same pin/catalog cleanup as above. No source delta. Needed because npm `0.3.0` predates the runtime types (`InterchangeType`, `Thread`, `SearchQuery`, `base64Decode`) `@intx/mailbox`/`@intx/mime` at this pin import. | Retired when `@intx/mailbox` publishes against a released `@intx/types` that carries these exports |

## Upstream ask

Publishing `@intx/mailbox` (and refreshing the `@intx/mime`/`@intx/types`
npm releases to the pin it needs) retires all three rows in one move.

## Published artifact

None of the three vendored packages appear in the published manifest's
`dependencies`/`peerDependencies` — there is nothing on npm for a consumer
to install against. Instead `scripts/build.mjs` (invoked by `bun run
build`) bundles `vendor/intx-mailbox`, `vendor/intx-mime`, and
`vendor/intx-types` straight into `dist/index.js`, and compiles their
declarations separately into `dist/vendor/<name>/`, rewriting the bare
`@intx/mailbox`/`@intx/mime`/`@intx/types` specifiers in every emitted
`.d.ts` to relative paths into that directory. This keeps the tarball
self-contained for both `node --experimental-...`-free runtime use and a
consumer's own `tsc`. It is a build-time workaround, not a vendoring
delta: once `@intx/mailbox` (and the `@intx/mime`/`@intx/types` pins it
needs) are published, the three packages move back to ordinary
`dependencies`/`peerDependencies`, `scripts/build.mjs` goes back to a
plain `tsc` invocation, and this section is deleted.
