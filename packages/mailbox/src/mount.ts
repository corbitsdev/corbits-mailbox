import { type } from "arktype";
import type { Context, Env, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { describeRoute } from "hono-openapi";
import { getLogger } from "@intx/log";
import type { MailboxDb } from "./db.js";
import {
  publishMailboxEvent,
  type MailboxEvent,
  type MailboxEventBus,
  type MailboxEventOp,
} from "./bus.js";
import {
  countUnreadActiveMailbox,
  markMailboxMessageUnread,
  archiveMailboxMessage,
  trashMailboxMessage,
  restoreMailboxMessage,
  applyMailboxBulkAction,
  assignMailboxMessage,
  MailboxAssignmentSchema,
  markMailboxMessageRead,
  enrichMailboxMessage,
  MailboxEnrichmentSchema,
  MAILBOX_BULK_ACTIONS,
} from "./mutations.js";
import {
  canonicalMailboxFilter,
  decodeMailboxListCursor,
  getMailboxMessage,
  listUserMailbox,
  MAILBOX_SORTS,
  MAILBOX_VIEWS,
  MailboxInboxViewSchema,
  MailboxSortSchema,
  type MailboxFilter,
  type MailboxInboxView,
  type MailboxMessage,
  type MailboxScope,
  type MailboxSort,
  type SenderDisplayResolver,
} from "./read.js";
import {
  assertMailboxVocabulary,
  canonicalMailboxPriorities,
  type MailboxVocabulary,
} from "./vocabulary.js";

const logger = getLogger(["corbits-mailbox", "mount"]);

export type ResolvedPrincipal = { tenantId: string; principalId: string };

export type MountMailboxOpts = {
  db: MailboxDb;
  bus: MailboxEventBus;
  resolvePrincipal: (
    ctx: unknown,
  ) => Promise<ResolvedPrincipal | null> | ResolvedPrincipal | null;
  /**
   * Optional host seam that turns sender addresses into human labels; see
   * `SenderDisplayResolver`. Omit it and messages carry only the raw `From:`
   * header, which is what this package can know on its own.
   */
  resolveSenderDisplays?: SenderDisplayResolver;
  /**
   * The host's triage vocabulary — REQUIRED, and with no default anywhere in
   * the package.
   *
   * `priorities` is ordered, most urgent first: that order *is* the ranking
   * `sort=priority` uses, and it is what the OpenAPI `?priority=` enum
   * advertises. `statuses` is an unordered set, used only for validation and
   * the `?status=` enum. `classification` and `assignee` stay open host-defined
   * strings with no list at all.
   *
   * Reordering `priorities` between deploys invalidates in-flight
   * `sort=priority` cursors, which then 400 rather than paging against a
   * ranking that no longer means what it meant when they were minted.
   */
  vocabulary: MailboxVocabulary;
  /**
   * SSE keep-alive period. Defaults to 25s — under the 30s idle timeout most
   * proxies default to. Overridable so a test can observe a heartbeat without
   * waiting 25 seconds for one; there is no other reason to change it.
   * Non-finite or `<= 0` values throw `RangeError` at mount (same posture as a
   * bad vocabulary), not on the first request.
   */
  heartbeatIntervalMs?: number;
};

const DEFAULT_LIMIT = 50;
/** Documented ceiling on `?limit=`. Exceeding it is a 400, never a silent clamp. */
export const MAX_MAILBOX_PAGE_LIMIT = 200;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * Ceiling on SSE events queued for one connection whose client has stopped
 * reading. An event is a NUDGE — an id to refetch — never the data itself;
 * Postgres holds the data. So a consumer that falls this far behind is
 * disconnected rather than buffered for: on reconnect it resyncs from the
 * database and loses nothing durable, whereas buffering would grow one
 * stalled connection's memory without bound for a stream that is best-effort
 * by contract.
 */
export const MAX_PENDING_SSE_EVENTS = 100;

const UuidSchema = type("string.uuid");
const BulkRequestSchema = type({
  action: type.enumerated(...MAILBOX_BULK_ACTIONS),
  ids: "string[]",
});

/**
 * `?limit=` — REJECTING anything out of range rather than clamping it.
 *
 * A caller asking for 500 and silently receiving 200 has no way to know its
 * page was truncated, so it pages as if it had 500 rows and skips 300 messages.
 * Refusing is also the only answer consistent with this same parameter's
 * behavior on the low side — a non-integer or non-positive limit is a 400, and
 * "too large" is no less a bad request than "not a number".
 */
const LimitSchema = type("undefined")
  .pipe(() => DEFAULT_LIMIT)
  .or(
    type("string.integer.parse")
      .configure({ message: () => "limit must be a positive integer" })
      .to(
        type("number >= 1")
          .configure({ message: () => "limit must be a positive integer" })
          .and(
            type(`number <= ${MAX_MAILBOX_PAGE_LIMIT}`).configure({
              message: () => `limit must be at most ${MAX_MAILBOX_PAGE_LIMIT}`,
            }),
          ),
      ),
  );

function isUuid(value: string): boolean {
  return !(UuidSchema(value) instanceof type.errors);
}

/**
 * Vocabulary schemas, built once at mount from the HOST's lists. An unknown
 * `priority`/`status` is a 400 rather than a silently empty page — a client
 * that typos `priorty=high` should hear about it, not conclude its inbox is
 * empty. One owner for both refusal sites: the query-string filters and the
 * enrichment body. `classification` and `assignee` are open host-defined
 * strings and are taken as given.
 */
function createVocabularySchemas(vocabulary: MailboxVocabulary) {
  const priority = type
    .enumerated(...vocabulary.priorities)
    .configure({ message: () => "unknown priority" });
  const status = type
    .enumerated(...vocabulary.statuses)
    .configure({ message: () => "unknown status" });
  const filterQuery = type({
    "priority?": priority,
    "status?": status,
    "classification?": "string",
    "assignee?": "string",
  });

  return {
    /** Read the enrichment/delegation filters off the query string. */
    parseFilter(
      query: (key: string) => string | undefined,
    ): { filter: MailboxFilter } | { error: string } {
      const raw: Record<string, string> = {};
      for (const key of [
        "priority",
        "status",
        "classification",
        "assignee",
      ] as const) {
        const value = query(key);
        if (value !== undefined) raw[key] = value;
      }
      const filter = filterQuery(raw);
      if (filter instanceof type.errors) return { error: filter[0]!.message };
      return { filter };
    },
    /**
     * The enrichment body's `priority`/`status` carry the same vocabulary the
     * query string does, and are refused the same way. `null` is not a
     * vocabulary member: it is the clear-this-field instruction, and always
     * legal.
     */
    checkEnrichment(enrichment: {
      priority?: string | null;
      status?: string | null;
    }): string | null {
      for (const [schema, value] of [
        [priority, enrichment.priority],
        [status, enrichment.status],
      ] as const) {
        if (typeof value !== "string") continue;
        const result = schema(value);
        if (result instanceof type.errors) return result[0]!.message;
      }
      return null;
    },
  };
}

const TAGS = ["mailbox"];
const ID_PARAM = {
  name: "id",
  in: "path" as const,
  required: true,
  schema: { type: "string" as const, format: "uuid" },
};

// The five single-message mutations differ only in verb and handler, so they
// are registered from one table instead of five near-identical blocks. `op`
// is the event op published on success — same identifiers `applyMailboxBulkAction`
// takes as its `action`, so a listener sees the same op for "read one" and
// "read fifty".
const SINGLE_MUTATIONS = [
  {
    verb: "read",
    summary: "Mark a message read",
    run: markMailboxMessageRead,
    op: "mark_read",
  },
  {
    verb: "unread",
    summary: "Mark an active message unread",
    run: markMailboxMessageUnread,
    op: "mark_unread",
  },
  {
    verb: "trash",
    summary: "Trash a message",
    run: trashMailboxMessage,
    op: "trash",
  },
  {
    verb: "archive",
    summary: "Archive a message (refused once trashed)",
    run: archiveMailboxMessage,
    op: "archive",
  },
  {
    verb: "restore",
    summary: "Restore a message out of archive or trash",
    run: restoreMailboxMessage,
    op: "restore",
  },
] as const;

/**
 * Mount the mailbox routes onto a host Hono app under `/me/inbox*`.
 *
 * "No-member asymmetry" is intentional, spec'd behavior: when
 * `resolvePrincipal` yields no principal, list/unread-count return EMPTY
 * results (200) — a caller with no mailbox identity simply sees an empty
 * inbox — while events/detail/mutations return 403, since those operate on
 * (or stream) a specific identity that does not exist.
 */
export function mountMailbox<E extends Env>(
  app: Hono<E>,
  opts: MountMailboxOpts,
): Hono<E> {
  const { db, bus, resolvePrincipal, vocabulary } = opts;
  // Refused at mount, not on the first request: a host that hands over an empty
  // or duplicated list has a startup bug, and finding out at boot is cheaper
  // than finding out from one user's 500.
  assertMailboxVocabulary(vocabulary);
  const canonicalPriorities = canonicalMailboxPriorities(vocabulary.priorities);
  const vocabularySchemas = createVocabularySchemas(vocabulary);
  const heartbeatIntervalMs =
    opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  // Zero/negative spins a tight sleep/write loop per open connection; NaN
  // and Infinity are the same class of host misconfiguration. Refuse at
  // mount, not on the first request — same posture as a bad vocabulary.
  if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
    throw new RangeError(
      "mailbox heartbeatIntervalMs must be a finite positive number",
    );
  }

  function publish(
    scope: ResolvedPrincipal,
    id: string,
    op: MailboxEventOp,
  ): void {
    publishMailboxEvent(bus, scope, id, logger, op);
  }

  app.get(
    "/me/inbox",
    describeRoute({
      tags: TAGS,
      summary: "List the caller's inbox",
      description:
        "Newest first, keyset-paginated. With no resolvable principalId this returns an empty list, not a 403.",
      parameters: [
        {
          name: "view",
          in: "query",
          schema: { type: "string", enum: [...MAILBOX_VIEWS] },
        },
        {
          name: "limit",
          in: "query",
          schema: {
            type: "integer",
            minimum: 1,
            maximum: MAX_MAILBOX_PAGE_LIMIT,
            default: DEFAULT_LIMIT,
          },
        },
        { name: "cursor", in: "query", schema: { type: "string" } },
        {
          name: "sort",
          in: "query",
          description:
            "`date` (newest first, the default) or `priority` (most urgent first, newest first within a band).",
          schema: { type: "string", enum: [...MAILBOX_SORTS] },
        },
        // Enums generated from the host's vocabulary — the document describes
        // the host's taxonomy because the package has none.
        {
          name: "priority",
          in: "query",
          description: "Host vocabulary, most urgent first.",
          schema: { type: "string", enum: [...vocabulary.priorities] },
        },
        {
          name: "status",
          in: "query",
          schema: { type: "string", enum: [...vocabulary.statuses] },
        },
        { name: "classification", in: "query", schema: { type: "string" } },
        {
          name: "assignee",
          in: "query",
          description:
            "Items this principalId delegated to the named assignee.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: { description: "A page of messages plus an optional nextCursor" },
        400: {
          description: `Bad view, sort, priority or status; a cursor minted for a different view, sort or filter; or a limit that is not an integer in 1..${MAX_MAILBOX_PAGE_LIMIT}`,
        },
      },
    }),
    async (c) => {
      const limit = LimitSchema(c.req.query("limit"));
      if (limit instanceof type.errors) {
        return c.json({ error: limit[0]!.message }, 400);
      }
      const rawView = c.req.query("view");
      const view: MailboxInboxView =
        rawView === undefined ? "all" : (rawView as MailboxInboxView);
      if (MailboxInboxViewSchema(view) instanceof type.errors) {
        return c.json({ error: "invalid inbox view" }, 400);
      }
      const rawSort = c.req.query("sort");
      const sort: MailboxSort =
        rawSort === undefined ? "date" : (rawSort as MailboxSort);
      if (MailboxSortSchema(sort) instanceof type.errors) {
        return c.json({ error: "invalid inbox sort" }, 400);
      }
      const parsedFilter = vocabularySchemas.parseFilter((key) =>
        c.req.query(key),
      );
      if ("error" in parsedFilter) {
        return c.json({ error: parsedFilter.error }, 400);
      }
      const canonicalFilter = canonicalMailboxFilter(parsedFilter.filter);
      const rawCursor = c.req.query("cursor");
      let cursor;
      if (rawCursor !== undefined) {
        const decoded = decodeMailboxListCursor(rawCursor);
        if (decoded === null) {
          return c.json({ error: "malformed cursor" }, 400);
        }
        if (decoded.view !== view) {
          return c.json({ error: "cursor does not match inbox view" }, 400);
        }
        if (decoded.sort !== sort) {
          return c.json({ error: "cursor does not match inbox sort" }, 400);
        }
        if (decoded.filter !== canonicalFilter) {
          return c.json({ error: "cursor does not match inbox filter" }, 400);
        }
        // The leading component of a priority keyset is an integer rank read
        // out of the host's ordering. Reorder that list and the same integer
        // names a different band, so a cursor minted under the old order would
        // page over messages it should have shown. Refuse it, exactly as a
        // cross-view or cross-filter cursor is refused.
        if (sort === "priority" && decoded.priorities !== canonicalPriorities) {
          return c.json(
            { error: "cursor does not match inbox priority ordering" },
            400,
          );
        }
        cursor = decoded;
      }
      const resolved = await resolvePrincipal(c);
      if (!resolved) {
        return c.json({ messages: [] });
      }
      const scope: MailboxScope = {
        tenantId: resolved.tenantId,
        principalId: resolved.principalId,
        limit,
        view,
        sort,
        filter: parsedFilter.filter,
        priorities: vocabulary.priorities,
      };
      if (cursor !== undefined) scope.cursor = cursor;
      if (opts.resolveSenderDisplays !== undefined) {
        scope.resolveSenderDisplays = opts.resolveSenderDisplays;
      }
      const page = await listUserMailbox(db, scope);
      const body: { messages: MailboxMessage[]; nextCursor?: string } = {
        messages: page.items,
      };
      if (page.nextCursor !== undefined) body.nextCursor = page.nextCursor;
      return c.json(body);
    },
  );

  app.get(
    "/me/inbox/unread-count",
    describeRoute({
      tags: TAGS,
      summary: "Count unread, non-archived, non-trashed messages",
      responses: {
        200: {
          description: "The unread count; 0 with no resolvable principalId",
        },
      },
    }),
    async (c) => {
      const resolved = await resolvePrincipal(c);
      if (!resolved) {
        return c.json({ unread: 0 });
      }
      const unread = await countUnreadActiveMailbox(db, resolved);
      return c.json({ unread });
    },
  );

  app.get(
    "/me/inbox/events",
    describeRoute({
      tags: TAGS,
      summary: "Server-sent stream of mailbox events for the caller",
      description:
        "Emits a `mailbox` event per affected message id, plus a heartbeat comment every 25s. " +
        "Each event also carries `op` (create/mark_read/mark_unread/trash/archive/restore/enrich/assign) " +
        "when the publisher knows it — optional and additive, so a listener reading only `id` still works.",
      responses: {
        200: { description: "text/event-stream" },
        403: { description: "No resolvable principalId" },
      },
    }),
    async (c) => {
      const resolved = await resolvePrincipal(c);
      if (!resolved) {
        return c.json({ error: "No resolvable principalId" }, 403);
      }
      return streamSSE(c, async (stream) => {
        // Writes are serialized through a bounded queue rather than fired
        // and forgotten: `stream.writeSSE` parks a pending promise per call
        // once the client stops draining the socket, and firing them
        // unawaited made that parking unbounded. Overflow closes the
        // connection — see MAX_PENDING_SSE_EVENTS.
        const pending: MailboxEvent[] = [];
        let draining = false;
        let closed = false;
        const closeStream = () => {
          closed = true;
          pending.length = 0;
          void stream.close().catch(() => {
            // Already closed or aborted — nothing left to do.
          });
        };
        const drain = async () => {
          if (draining) return;
          draining = true;
          try {
            while (pending.length > 0 && !stream.aborted && !closed) {
              await stream.writeSSE({
                event: "mailbox",
                data: JSON.stringify(pending.shift()!),
              });
            }
          } catch {
            // Defensive: absorb writeSSE rejection so a void-launched drain
            // never becomes an unhandled rejection. Hono's StreamingApi.write
            // currently swallows writer errors (real disconnect is
            // stream.aborted / onAbort); this catch still matters if writeSSE
            // rejects for any other reason or Hono starts propagating.
            // Mark closed so the heartbeat loop exits and no further events queue.
            closeStream();
          } finally {
            draining = false;
          }
        };
        const unsubscribe = bus.subscribe(resolved, (event) => {
          if (closed) return;
          if (pending.length >= MAX_PENDING_SSE_EVENTS) {
            closeStream();
            return;
          }
          pending.push(event);
          void drain();
        });
        stream.onAbort(() => unsubscribe());
        try {
          while (!stream.aborted && !closed) {
            await stream.sleep(heartbeatIntervalMs);
            if (stream.aborted || closed) break;
            try {
              await stream.write(": heartbeat\n\n");
            } catch {
              closeStream();
              break;
            }
          }
        } finally {
          unsubscribe();
        }
      });
    },
  );

  app.get(
    "/me/inbox/:id",
    describeRoute({
      tags: TAGS,
      summary: "Read one message with its full body",
      description:
        "A stored frame the MIME parser rejects degrades to an empty body rather than a 500.",
      responses: {
        200: { description: "The message and its text body" },
        400: { description: "Message id is not a UUID" },
        403: { description: "No resolvable principalId" },
        404: { description: "No such message for this principalId" },
      },
    }),
    async (c) => {
      const id = c.req.param("id");
      if (!isUuid(id)) {
        return c.json({ error: "Message id must be a UUID" }, 400);
      }
      const resolved = await resolvePrincipal(c);
      if (!resolved) {
        return c.json({ error: "No resolvable principalId" }, 403);
      }
      const detailArgs: Parameters<typeof getMailboxMessage>[1] = {
        ...resolved,
        id,
      };
      if (opts.resolveSenderDisplays !== undefined) {
        detailArgs.resolveSenderDisplays = opts.resolveSenderDisplays;
      }
      const message = await getMailboxMessage(db, detailArgs);
      if (!message) return c.json({ error: "Message not found" }, 404);
      return c.json(message);
    },
  );

  async function singleMutation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    c: Context<any, any, any>,
    id: string,
    run: (scope: {
      tenantId: string;
      principalId: string;
      id: string;
    }) => Promise<boolean>,
    op: MailboxEventOp,
  ) {
    if (!isUuid(id)) {
      return c.json({ error: "Message id must be a UUID" }, 400);
    }
    const resolved = await resolvePrincipal(c);
    if (!resolved) {
      return c.json({ error: "No resolvable principalId" }, 403);
    }
    const ok = await run({ ...resolved, id });
    if (!ok) return c.json({ error: "Message not found" }, 404);
    publish(resolved, id, op);
    return c.json({ id, ok: true as const });
  }

  for (const { verb, summary, run, op } of SINGLE_MUTATIONS) {
    app.post(
      `/me/inbox/:id/${verb}`,
      describeRoute({
        tags: TAGS,
        summary,
        parameters: [ID_PARAM],
        responses: {
          200: { description: "The mutation was applied" },
          400: { description: "Message id is not a UUID" },
          403: { description: "No resolvable principalId" },
          404: { description: "No message in scope for this action" },
        },
      }),
      (c) =>
        singleMutation(c, c.req.param("id"), (scope) => run(db, scope), op),
    );
  }

  app.post(
    "/me/inbox/:id/enrich",
    describeRoute({
      tags: TAGS,
      summary: "Stamp triage metadata onto a message",
      description:
        "Triage enriches the message's mailbox row rather than spawning a task. Each of " +
        "priority/classification/status is applied independently — an omitted key " +
        "leaves the stored value alone, an explicit null clears it. " +
        `priority is one of ${vocabulary.priorities.join(", ")}; ` +
        `status is one of ${vocabulary.statuses.join(", ")}.`,
      parameters: [ID_PARAM],
      responses: {
        200: { description: "The enrichment was applied" },
        400: {
          description:
            "Non-UUID id, bad JSON, an unknown priority/status, or an enrichment that sets nothing",
        },
        403: { description: "No resolvable principalId" },
        404: { description: "No such message for this principalId" },
      },
    }),
    async (c) => {
      const id = c.req.param("id");
      if (!isUuid(id)) {
        return c.json({ error: "Message id must be a UUID" }, 400);
      }
      const raw = await c.req.json().catch(() => null);
      if (raw === null) return c.json({ error: "invalid JSON body" }, 400);
      const enrichment = MailboxEnrichmentSchema(raw);
      if (enrichment instanceof type.errors) {
        return c.json({ error: "invalid mailbox enrichment" }, 400);
      }
      const badVocabulary = vocabularySchemas.checkEnrichment(enrichment);
      if (badVocabulary !== null) {
        return c.json({ error: badVocabulary }, 400);
      }
      const resolved = await resolvePrincipal(c);
      if (!resolved) {
        return c.json({ error: "No resolvable principalId" }, 403);
      }
      // "sets nothing" has one owner — `enrichMailboxMessage`. The route
      // renders that refusal as a 400 rather than re-stating the rule.
      let ok: boolean;
      try {
        ok = await enrichMailboxMessage(db, { ...resolved, id }, enrichment);
      } catch (err) {
        if (err instanceof RangeError)
          return c.json({ error: err.message }, 400);
        throw err;
      }
      if (!ok) return c.json({ error: "Message not found" }, 404);
      publish(resolved, id, "enrich");
      return c.json({ id, ok: true as const });
    },
  );

  app.post(
    "/me/inbox/:id/assign",
    describeRoute({
      tags: TAGS,
      summary: "Delegate a message to another principalId",
      description:
        "Delegation as an optional assignee ref rather than a forwarded copy: the item stays " +
        "in this mailbox and carries the assignee's principalId. `null` un-assigns. " +
        "List with `?assignee=` to see what has been delegated to whom.",
      parameters: [ID_PARAM],
      responses: {
        200: { description: "The assignment was applied" },
        400: {
          description: "Non-UUID id, bad JSON, or a missing assignee key",
        },
        403: { description: "No resolvable principalId" },
        404: { description: "No such message for this principalId" },
      },
    }),
    async (c) => {
      const id = c.req.param("id");
      if (!isUuid(id)) {
        return c.json({ error: "Message id must be a UUID" }, 400);
      }
      const raw = await c.req.json().catch(() => null);
      if (raw === null) return c.json({ error: "invalid JSON body" }, 400);
      const body = MailboxAssignmentSchema(raw);
      if (body instanceof type.errors) {
        return c.json({ error: "invalid mailbox assignment" }, 400);
      }
      const resolved = await resolvePrincipal(c);
      if (!resolved) {
        return c.json({ error: "No resolvable principalId" }, 403);
      }
      const ok = await assignMailboxMessage(
        db,
        { ...resolved, id },
        body.assignee,
      );
      if (!ok) return c.json({ error: "Message not found" }, 404);
      publish(resolved, id, "assign");
      return c.json({ id, ok: true as const });
    },
  );

  app.post(
    "/me/inbox/bulk",
    describeRoute({
      tags: TAGS,
      summary: "Apply one action to up to 50 messages",
      description:
        "Partial success: every requested id comes back with its own ok flag.",
      responses: {
        200: { description: "Per-id results plus the number updated" },
        400: {
          description:
            "Bad JSON, unknown action, non-UUID id, or more than 50 ids",
        },
        403: { description: "No resolvable principalId" },
      },
    }),
    async (c) => {
      const raw = await c.req.json().catch(() => null);
      if (raw === null) return c.json({ error: "invalid JSON body" }, 400);
      const body = BulkRequestSchema(raw);
      if (body instanceof type.errors) {
        return c.json({ error: "invalid bulk inbox request" }, 400);
      }
      if (!body.ids.every((id) => isUuid(id))) {
        return c.json({ error: "each id must be a UUID" }, 400);
      }
      const resolved = await resolvePrincipal(c);
      if (!resolved) {
        return c.json({ error: "No resolvable principalId" }, 403);
      }
      // The ≤50 cap has one owner — `applyMailboxBulkAction`. The route just
      // renders that refusal as a 400 rather than re-stating the limit.
      let results;
      try {
        results = await applyMailboxBulkAction(
          db,
          resolved,
          body.action,
          body.ids,
        );
      } catch (err) {
        if (err instanceof RangeError)
          return c.json({ error: err.message }, 400);
        throw err;
      }
      for (const r of results) {
        if (r.ok) publish(resolved, r.id, body.action);
      }
      return c.json({
        updated: results.filter((r) => r.ok).length,
        results,
      });
    },
  );

  return app;
}
