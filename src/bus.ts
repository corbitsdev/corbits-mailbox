import { type } from "arktype";

/**
 * The operation that produced an event, when the publisher knows it. Mirrors
 * `MailboxBulkAction` in mutations.ts (`mark_read`, `mark_unread`, `trash`,
 * `archive`, `restore`) plus the three operations mutations.ts does not own:
 * `create` (a new message landed, from `writeMailboxMessage`,
 * `deliverInboxItems`, or `createMailboxPersist`), `enrich` (triage stamp),
 * `assign` (delegation). Duplicated here rather than imported from
 * mutations.ts to avoid a bus.ts -> mutations.ts -> write.ts -> bus.ts import
 * cycle; mount.ts's route table keeps the two lists in sync, and
 * `bus.test.ts` asserts every `MailboxBulkAction` value is a member of this
 * list.
 *
 * This is a deliberately different name from its two siblings, not an
 * accident: mount.ts's HTTP route table calls the same five shared values a
 * "verb" (the path segment), mutations.ts calls them an "action", and this
 * is an "op". The three names share five values because a single-message
 * mutation and its bulk equivalent report the same op, but `MailboxEventOp`
 * is a strict superset — `create`, `enrich`, `assign` are not bulk actions
 * and never will be — so this stays its own vocabulary rather than
 * importing/aliasing `MailboxBulkAction`, which would claim an equivalence
 * the two sets don't have.
 */
export const MAILBOX_EVENT_OPS = [
  "create",
  "mark_read",
  "mark_unread",
  "trash",
  "archive",
  "restore",
  "enrich",
  "assign",
] as const;
export type MailboxEventOp = (typeof MAILBOX_EVENT_OPS)[number];

/**
 * `op` is optional and additive on the wire: a listener that only reads `id`
 * (the original shape) keeps working unchanged. A listener that wants to
 * react to a specific kind of change without re-fetching and diffing can
 * switch on `op` when present, and still fall back to a refetch when it is
 * absent.
 *
 * It stays optional here — not because a caller *inside this package* might
 * reasonably omit it (every call site names one) — but because two things
 * outside this package's control cannot: a caller outside this package that
 * predates `op` and has no reason to know about it, and a historical event
 * replayed from before this field existed. `publishMailboxEvent` below makes
 * `op` a required parameter precisely so no future call site here can
 * silently produce one of the events this schema still has to tolerate.
 */
export const MailboxEventSchema = type({
  type: "'mailbox'",
  id: "string",
  "op?": type.enumerated(...MAILBOX_EVENT_OPS),
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
 *
 * Delivery semantics — the same for every bus, in-memory or host-supplied:
 *
 * - **Events can be missed.** Publish is best-effort after commit (a
 *   publish failure is logged and swallowed, never retried), and the SSE
 *   route disconnects a consumer whose queue exceeds `MAX_PENDING_SSE_EVENTS`
 *   rather than buffering for it. A listener must treat `id`/`op` as a hint
 *   to refetch, not as a complete change log.
 * - **Events can be duplicated, but only when there is no stable dedupe key
 *   to prevent it.** Redelivery is deduped by default — an inbox item with a
 *   stable external identifier inserts once, on conflict-do-nothing. Only a
 *   redelivered item that carries no such identifier inserts a second row
 *   and publishes a second `create`; a broker-backed bus a host supplies may
 *   also redeliver on its own. Handling a repeat of an already-applied `op`
 *   for the same `id` must be a no-op, not an error.
 * - **Events can arrive out of order.** The in-memory default preserves
 *   publish order within one process for one mailbox (a (tenant, principal)
 *   pair — same scope as the fan-out guarantee above); a broker-backed bus,
 *   or multiple replicas publishing concurrently, offers no such guarantee.
 *   A listener must not infer "later event = later state" — refetch the
 *   specific message (or the list) rather than trusting event arrival order.
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
 *
 * `op` is required here even though it is optional on `MailboxEventSchema`:
 * every call site in this package knows what it just did, and requiring it
 * is what keeps a future call site from silently regressing to an
 * op-less event. The schema field stays optional for the callers this
 * function's signature cannot reach — see the comment above it.
 */
export function publishMailboxEvent(
  bus: MailboxEventBus,
  scope: MailboxEventScope,
  id: string,
  logger: { error: (message: string, data?: Record<string, unknown>) => void },
  op: MailboxEventOp,
): void {
  try {
    bus.publish(scope, { type: "mailbox", id, op });
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
