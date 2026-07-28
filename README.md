# corbits-mailbox

Home of **[`@corbits/mailbox`](./packages/mailbox)** — a universal,
principal-keyed inbox, mountable onto a Hono host backed by an Interchange-shaped
Postgres. Its tables live in a dedicated `mailbox` schema in the host's database,
foreign-keyed to the host's `tenant` and `principal` tables. Backend only; this
package ships no UI.

See the [package README](./packages/mailbox/README.md) for install, the mount
snippet and the seams, and [ARCHITECTURE.md](./ARCHITECTURE.md) for the data model.

## Layout

| | |
| --- | --- |
| `packages/mailbox` | The published package. Owns `principal_mail` (the message, immutable) and `mailbox` (the management layer, created eagerly with each message). |
| `examples/reference-host` | Mounts it on a real `@intx/hub-api` app against a live Postgres and asserts the acceptance scenarios end to end. |

## Working on it

```sh
bun install
docker run -d --name mailbox-pg -p 5433:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=mailbox_core postgres:16

bun run --cwd packages/mailbox test    # unit + integration
bun run --cwd packages/mailbox build   # dist/ (JS + .d.ts)
bun test --cwd examples/reference-host      # acceptance scenarios
```

Tests and the example expect `postgres://postgres:postgres@localhost:5433/mailbox_core`;
override with `MAILBOX_TEST_DATABASE_URL` / `MAILBOX_DATABASE_URL`.

## Conventions

Strict TypeScript, arktype at boundaries, drizzle for data access. Dependencies come
from public `@intx/*` on npm only.

## License

LGPL-2.1-only. See [LICENSE](./LICENSE).
