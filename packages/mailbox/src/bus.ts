import { type } from "arktype";

export const MailboxEventSchema = type({
  type: "'mailbox'",
  id: "string",
});
export type MailboxEvent = typeof MailboxEventSchema.infer;

type Listener = (event: MailboxEvent) => void;

/**
 * The (tenant, principal) pair a mailbox is addressed by. The bus keys on the
 * PAIR, never on the principal alone: a principal identifier is only unique
 * within its tenant, and a bus keyed on it alone would fan one tenant's
 * events out to another tenant's same-named principal.
 */
export type MailboxEventScope = { tenantId: string; principalId: string };

/**
 * SSE fan-out seam this package defines. A host may supply its own bus
 * (e.g. backed by a shared broker for multi-replica delivery) or use the
 * in-memory default below. Per-mailbox fan-out: every open subscription
 * for a (tenant, principal) pair receives every publish to that pair;
 * unsubscribing one connection never affects another connection for the
 * same or any other mailbox (isolation).
 *
 * Host buses should isolate listener failures the same way the in-memory
 * default does: one throwing subscriber must not prevent remaining
 * subscribers for that scope from receiving the event. Events are
 * best-effort nudges, so a per-listener failure is swallowable; starving
 * healthy connections is not.
 */
export interface MailboxEventBus {
  publish(scope: MailboxEventScope, event: MailboxEvent): void;
  subscribe(scope: MailboxEventScope, listener: Listener): () => void;
}

/**
 * Best-effort publish. Every caller sits past a committed write: a host bus
 * may be broker-backed and therefore may throw, and a publish failure must
 * never turn a committed write into a caller-visible error the client will
 * retry forever. The failure is logged and swallowed.
 */
export function publishMailboxEvent(
  bus: MailboxEventBus,
  scope: MailboxEventScope,
  id: string,
  logger: { error: (message: string, data?: Record<string, unknown>) => void },
): void {
  try {
    bus.publish(scope, { type: "mailbox", id });
  } catch (err) {
    logger.error("mailbox event publish failed for {rowId}", {
      rowId: id,
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
}

// NUL cannot appear in a Postgres text value, so no two distinct scopes can
// ever join to the same key the way `a:b` + `c` vs `a` + `b:c` could.
function scopeKey(scope: MailboxEventScope): string {
  return `${scope.tenantId}\u0000${scope.principalId}`;
}

/**
 * In-memory, single-process fan-out. Good enough as a host's zero-config
 * default; a host running multiple replicas should supply its own bus
 * backed by a shared broker instead.
 *
 * Publish isolates per listener: a throw from one subscriber is swallowed
 * so later subscribers for the same scope still receive the event. That
 * matches the best-effort nudge contract — a bad SSE handler must not
 * starve every other open tab for the mailbox.
 */
export function createInMemoryMailboxEventBus(): MailboxEventBus {
  const listeners = new Map<string, Set<Listener>>();

  return {
    publish(scope, event) {
      const set = listeners.get(scopeKey(scope));
      if (!set) return;
      for (const listener of set) {
        try {
          listener(event);
        } catch {
          // Best-effort fan-out: one bad listener must not skip the rest.
        }
      }
    },
    subscribe(scope, listener) {
      const key = scopeKey(scope);
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(listener);
      const subscribed = set;
      return () => {
        subscribed.delete(listener);
        // Only retire the mailbox if this is still the live set. `mount`
        // unsubscribes twice (stream abort, then finally), and by the second
        // call a new subscriber may have installed a fresh set — deleting the
        // key then would evict a connection that is still open.
        if (subscribed.size === 0 && listeners.get(key) === subscribed) {
          listeners.delete(key);
        }
      };
    },
  };
}
