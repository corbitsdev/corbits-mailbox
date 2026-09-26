import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/**
 * The db handle this package expects a host to hand in — the drizzle instance
 * the host already has (typically `createDB`'s), never a second pool. It must
 * point at the HOST's database: the mailbox tables live in their own
 * `mailbox` schema there, held to the control plane by the tenant/principal
 * FKs.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle's schema
// generic is invariant, so naming a concrete schema here would reject a host
// handle bound to its own (e.g. `createDB`'s). Nothing here reads `db.query`.
export type MailboxDb = PostgresJsDatabase<any>;

