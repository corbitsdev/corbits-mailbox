// Explicit offboarding tools. The control-plane FKs (`tenant_id → tenant`,
// `principal_id → principal`, both ON DELETE CASCADE) already make "delete the
// tenant/principal row" carry the mailbox rows out with it — that is the
// normal path. These exports exist for hosts that soft-delete or archive
// control-plane rows instead of deleting them, where no cascade ever fires but
// the mail data must still go.
//
// Each purge is ONE delete on `principal_mail`; the management rows go with it
// through `mailbox.id → principal_mail.id ON DELETE CASCADE`, so a purge is a
// single atomic statement with no transaction to manage. Both functions take
// the `db` handle they are given, so passing a transaction runs the purge
// inside the host's own offboarding unit of work.

import { and, eq } from "drizzle-orm";
import { principalMail } from "./schema.js";
import type { MailboxDb } from "./db.js";
import { assertMailboxScope, assertMailboxTenantId } from "./write.js";

// postgres-js resolves a DELETE with no RETURNING to a `RowList`, whose `count`
// is the affected-row count. Read through a narrow shape rather than a driver
// type, and default to 0, so a driver that ever stops reporting it degrades to
// an unknown count instead of a crash — the rows are gone either way.
function affectedRows(result: unknown): number {
  const count = (result as { count?: unknown }).count;
  return typeof count === "number" ? count : 0;
}

/**
 * Delete EVERY mailbox row for one tenant. Irreversible: `raw` is the only
 * copy of the frame this package holds, so there is nothing to restore from
 * afterwards.
 *
 * Returns the number of MESSAGES deleted. Deliberately not scoped by direction
 * or by view: an offboarded tenant's trash is as much their data as their
 * inbox.
 */
export async function purgeTenantMailbox(
  db: MailboxDb,
  tenantId: string,
): Promise<number> {
  // A blank tenantId here would match nothing real; refuse it where the
  // caller still has a stack (see `assertMailboxTenantId`).
  assertMailboxTenantId(tenantId);
  const result = await db
    .delete(principalMail)
    .where(eq(principalMail.tenantId, tenantId));
  return affectedRows(result);
}

/**
 * The narrower cascade: every mailbox row for one principal within one tenant —
 * what a host runs when a person leaves and the tenant stays.
 *
 * Tenant-scoped on purpose. A principal identifier is only unique within its
 * tenant, so deleting by principal alone would reach into other tenants' data
 * on any host whose identifiers collide.
 */
export async function purgePrincipalMailbox(
  db: MailboxDb,
  scope: { tenantId: string; principalId: string },
): Promise<number> {
  assertMailboxScope(scope);
  const result = await db
    .delete(principalMail)
    .where(
      and(
        eq(principalMail.tenantId, scope.tenantId),
        eq(principalMail.principalId, scope.principalId),
      ),
    );
  return affectedRows(result);
}
