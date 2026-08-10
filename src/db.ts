import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

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

/**
 * Opens a standalone handle, for hosts and scripts that don't already have one.
 * `close` drains the pool — without it a migrate-only script keeps an open
 * socket and never exits.
 */
export function createMailboxDb(connectionString: string): {
  db: MailboxDb;
  close: () => Promise<void>;
} {
  const client = postgres(connectionString);
  return { db: drizzle(client), close: () => client.end() };
}
