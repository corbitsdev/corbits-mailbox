import type { Context, Env, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { describeRoute } from "hono-openapi";
import { getLogger } from "@intx/log";
import { executeSearch, executeThread } from "@intx/mailbox";
import type { Thread } from "@intx/types/runtime";
import type { MailboxDb } from "./db.js";
import type { NativeMailboxStore } from "./native-store.js";
import {
  publishMailboxEvent,
  type MailboxEvent,
  type MailboxEventBus,
  type MailboxEventOp,
} from "./bus.js";
import { openNativeMailboxStore, moveNativeMailboxMessage } from "./native-store.js";

const logger = getLogger(["corbits-mailbox", "mount"]);

export type ResolvedPrincipal = { tenantId: string; principalId: string };

export type MountMailboxOpts = {
  db: MailboxDb;
  bus: MailboxEventBus;
  resolvePrincipal: (
    ctx: unknown,
  ) => Promise<ResolvedPrincipal | null> | ResolvedPrincipal | null;
  /**
   * SSE keep-alive period. Defaults to 25s — under the 30s idle timeout most
   * proxies default to.
   */
  heartbeatIntervalMs?: number;
};

const DEFAULT_LIMIT = 50;
/** Documented ceiling on `?limit=`. Exceeding it is a 400, never a silent clamp. */
export const MAX_MAILBOX_PAGE_LIMIT = 200;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * Ceiling on SSE events queued for one connection whose client has stopped
 * reading — see the identical rationale this carried before the native-store
 * cutover: an event is a nudge, never the data, so a stalled consumer is
 * disconnected rather than buffered for.
 */
export const MAX_PENDING_SSE_EVENTS = 100;

const DEFAULT_FOLDER = "INBOX";
/** Folders `?folder=` may name for `GET /me/inbox`. */
const LIST_FOLDERS = ["INBOX", "Archive", "Trash"] as const;
type ListFolder = (typeof LIST_FOLDERS)[number];

function isListFolder(value: string): value is ListFolder {
  return (LIST_FOLDERS as readonly string[]).includes(value);
}

function parseLimit(raw: string | undefined): { limit: number } | { error: string } {
  if (raw === undefined) return { limit: DEFAULT_LIMIT };
  if (!/^\d+$/.test(raw)) return { error: "limit must be a positive integer" };
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    return { error: "limit must be a positive integer" };
  }
  if (limit > MAX_MAILBOX_PAGE_LIMIT) {
    return { error: `limit must be at most ${MAX_MAILBOX_PAGE_LIMIT}` };
  }
  return { limit };
}

/** `?cursor=` is the uid of the last item on the previous page. */
function parseCursor(raw: string | undefined): { cursor?: number } | { error: string } {
  if (raw === undefined) return {};
  if (!/^\d+$/.test(raw)) return { error: "malformed cursor" };
  const cursor = Number(raw);
  if (!Number.isSafeInteger(cursor)) return { error: "malformed cursor" };
  return { cursor };
}

function parseUid(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const uid = Number(raw);
  return Number.isSafeInteger(uid) && uid > 0 ? uid : null;
}

const TAGS = ["mailbox"];
const ID_PARAM = {
  name: "uid",
  in: "path" as const,
  required: true,
  schema: { type: "integer" as const },
};

/**
 * One item of `GET /me/inbox`: the vendored `executeSearch`'s ref, plus the
 * envelope and raw bytes read for it.
 */
type MailboxListItem = {
  uid: number;
  flags: string[];
  envelope: {
    messageId: string;
    from: string;
    to: string[];
    subject: string;
    date: string;
    inReplyTo: string | undefined;
    references: string[];
  };
  raw: string;
};

// The five single-message mutations that move or flag a message. `op` is the
// event op published on success.
/**
 * One node of `GET /me/inbox/threads(/:rootUid)`: the vendored
 * `executeThread`'s ref (recursively, as `children`) plus the same envelope
 * fields `GET /me/inbox` returns for that ref, so a client can render a
 * thread without an extra fetch per message.
 */
type MailboxThreadNode = {
  uid: number;
  flags: string[];
  envelope: MailboxListItem["envelope"];
  children: MailboxThreadNode[];
};

function enrichThread(store: NativeMailboxStore, node: Thread): MailboxThreadNode {
  const message = store.find(node.ref.uid);
  return {
    uid: node.ref.uid,
    flags: message ? [...message.flags] : [],
    envelope: {
      messageId: message?.envelope.messageId ?? "",
      from: message?.envelope.from ?? "",
      to: message?.envelope.to ?? [],
      subject: message?.envelope.subject ?? "",
      date: new Date(message?.envelope.date ?? 0).toISOString(),
      inReplyTo: message?.envelope.inReplyTo,
      references: message?.envelope.references ?? [],
    },
    children: node.children.map((child) => enrichThread(store, child)),
  };
}

const READ_VERBS = [
  { verb: "read", op: "mark_read" as const, flags: ["\\Seen"], add: true },
  { verb: "unread", op: "mark_unread" as const, flags: ["\\Seen"], add: false },
] as const;

const MOVE_VERBS = [
  { verb: "archive", op: "archive" as const, from: "INBOX", to: "Archive" },
  { verb: "trash", op: "trash" as const, from: "INBOX", to: "Trash" },
  { verb: "restore", op: "restore" as const, from: undefined, to: "INBOX" },
] as const;

/**
 * Mount the mailbox routes onto a host Hono app under `/me/inbox*`.
 *
 * This library exists ONLY to give human principals a native Interchange
 * mailbox — list, read/unread, archive/trash/restore, and a live SSE stream.
 * Every route is a thin wrapper over `NativeMailboxStore` and the vendored
 * `@intx/mailbox` `executeSearch`.
 *
 * "No-member asymmetry" is intentional, spec'd behavior: when
 * `resolvePrincipal` yields no principal, list returns an EMPTY result (200)
 * — a caller with no mailbox identity simply sees an empty inbox — while
 * events and mutations return 403, since those operate on (or stream) a
 * specific identity that does not exist.
 */
export function mountMailbox<E extends Env>(
  app: Hono<E>,
  opts: MountMailboxOpts,
): Hono<E> {
  const { db, bus, resolvePrincipal } = opts;
  const heartbeatIntervalMs =
    opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
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
        "Newest first, keyset-paginated over the native mailbox store's uid " +
        "counter. With no resolvable principalId this returns an empty list, " +
        "not a 403.",
      parameters: [
        {
          name: "folder",
          in: "query",
          description: "INBOX (default), Archive, or Trash.",
          schema: { type: "string", enum: [...LIST_FOLDERS] },
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
      ],
      responses: {
        200: { description: "A page of messages plus an optional nextCursor" },
        400: { description: "Bad folder, cursor, or an out-of-range limit" },
      },
    }),
    async (c) => {
      const rawFolder = c.req.query("folder");
      const folder = rawFolder === undefined ? DEFAULT_FOLDER : rawFolder;
      if (!isListFolder(folder)) {
        return c.json({ error: "invalid folder" }, 400);
      }
      const parsedLimit = parseLimit(c.req.query("limit"));
      if ("error" in parsedLimit) return c.json({ error: parsedLimit.error }, 400);
      const parsedCursor = parseCursor(c.req.query("cursor"));
      if ("error" in parsedCursor) return c.json({ error: parsedCursor.error }, 400);

      const resolved = await resolvePrincipal(c);
      if (!resolved) return c.json({ messages: [] });

      const store = await openNativeMailboxStore(db, { ...resolved, folder });
      // No query predicate: `executeSearch` returns every ref, in store order
      // (uid ascending, since `append` only ever grows uid). Reversed for
      // newest-first, then paged with a plain uid keyset.
      const refs = (await executeSearch(folder, store, {})).reverse();
      const page = refs.filter(
        (ref) => parsedCursor.cursor === undefined || ref.uid < parsedCursor.cursor,
      );
      const items = page.slice(0, parsedLimit.limit);
      const messages: MailboxListItem[] = [];
      for (const ref of items) {
        const message = store.find(ref.uid);
        if (!message) continue;
        const raw = await store.readRaw(ref.uid);
        messages.push({
          uid: ref.uid,
          flags: [...message.flags],
          envelope: {
            messageId: message.envelope.messageId,
            from: message.envelope.from,
            to: message.envelope.to,
            subject: message.envelope.subject,
            date: new Date(message.envelope.date).toISOString(),
            inReplyTo: message.envelope.inReplyTo,
            references: message.envelope.references,
          },
          raw: Buffer.from(raw).toString("base64"),
        });
      }
      const body: { messages: MailboxListItem[]; nextCursor?: string } = {
        messages,
      };
      if (page.length > items.length) {
        body.nextCursor = String(items[items.length - 1]!.uid);
      }
      return c.json(body);
    },
  );

  app.get(
    "/me/inbox/threads",
    describeRoute({
      tags: TAGS,
      summary: "The caller's inbox as threads",
      description:
        "The vendored `executeThread` (REFERENCES algorithm) run over the " +
        "folder's native store — roots plus children, each ref carrying the " +
        "same envelope fields `GET /me/inbox` returns. With no resolvable " +
        "principalId this returns an empty list, not a 403.",
      parameters: [
        {
          name: "folder",
          in: "query",
          description: "INBOX (default), Archive, or Trash.",
          schema: { type: "string", enum: [...LIST_FOLDERS] },
        },
      ],
      responses: {
        200: { description: "The folder's threads" },
        400: { description: "Bad folder" },
      },
    }),
    async (c) => {
      const rawFolder = c.req.query("folder");
      const folder = rawFolder === undefined ? DEFAULT_FOLDER : rawFolder;
      if (!isListFolder(folder)) {
        return c.json({ error: "invalid folder" }, 400);
      }
      const resolved = await resolvePrincipal(c);
      if (!resolved) return c.json({ threads: [] });

      const store = await openNativeMailboxStore(db, { ...resolved, folder });
      const threads = await executeThread(folder, store, "references");
      return c.json({
        threads: threads.map((thread) => enrichThread(store, thread)),
      });
    },
  );

  app.get(
    "/me/inbox/threads/:rootUid",
    describeRoute({
      tags: TAGS,
      summary: "One thread, rooted at the given uid",
      parameters: [
        { ...ID_PARAM, name: "rootUid" },
        {
          name: "folder",
          in: "query",
          description: "INBOX (default), Archive, or Trash.",
          schema: { type: "string", enum: [...LIST_FOLDERS] },
        },
      ],
      responses: {
        200: { description: "The thread rooted at rootUid" },
        400: { description: "Bad rootUid or folder" },
        403: { description: "No resolvable principalId" },
        404: { description: "No thread rooted at that uid in this mailbox" },
      },
    }),
    async (c) => {
      const rootUid = parseUid(c.req.param("rootUid") ?? "");
      if (rootUid === null) {
        return c.json({ error: "rootUid must be a positive integer" }, 400);
      }
      const rawFolder = c.req.query("folder");
      const folder = rawFolder === undefined ? DEFAULT_FOLDER : rawFolder;
      if (!isListFolder(folder)) {
        return c.json({ error: "invalid folder" }, 400);
      }
      const resolved = await resolvePrincipal(c);
      if (!resolved) return c.json({ error: "No resolvable principalId" }, 403);

      const store = await openNativeMailboxStore(db, { ...resolved, folder });
      const threads = await executeThread(folder, store, "references");
      const root = threads.find((thread) => thread.ref.uid === rootUid);
      if (!root) return c.json({ error: "Thread not found" }, 404);
      return c.json({ thread: enrichThread(store, root) });
    },
  );

  app.get(
    "/me/inbox/events",
    describeRoute({
      tags: TAGS,
      summary: "Server-sent stream of mailbox events for the caller",
      description:
        "Emits a `mailbox` event per affected message, plus a heartbeat " +
        "comment every 25s. Each event carries `op` " +
        "(create/mark_read/mark_unread/archive/trash/restore) when the " +
        "publisher knows it.",
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

  for (const { verb, op, flags, add } of READ_VERBS) {
    app.post(
      `/me/inbox/:uid/${verb}`,
      describeRoute({
        tags: TAGS,
        summary: verb === "read" ? "Mark a message read" : "Mark a message unread",
        parameters: [ID_PARAM],
        responses: {
          200: { description: "The flag was applied" },
          400: { description: "uid is not a positive integer" },
          403: { description: "No resolvable principalId" },
          404: { description: "No message with that uid in this mailbox" },
        },
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (c: Context<any, any, any>) => {
        const uid = parseUid(c.req.param("uid") ?? "");
        if (uid === null) return c.json({ error: "uid must be a positive integer" }, 400);
        const resolved = await resolvePrincipal(c);
        if (!resolved) return c.json({ error: "No resolvable principalId" }, 403);
        const folder = c.req.query("folder") ?? DEFAULT_FOLDER;
        const store = await openNativeMailboxStore(db, { ...resolved, folder });
        if (!store.find(uid)) return c.json({ error: "Message not found" }, 404);
        if (add) store.addFlags(uid, [...flags]);
        else store.removeFlags(uid, [...flags]);
        await store.settled;
        publish(resolved, `${folder}:${uid}`, op);
        return c.json({ uid, ok: true as const });
      },
    );
  }

  for (const { verb, op, from, to } of MOVE_VERBS) {
    app.post(
      `/me/inbox/:uid/${verb}`,
      describeRoute({
        tags: TAGS,
        summary: `Move a message to ${to}`,
        parameters: [ID_PARAM],
        responses: {
          200: { description: "The message was moved" },
          400: { description: "uid is not a positive integer" },
          403: { description: "No resolvable principalId" },
          404: { description: "No message with that uid in the source folder" },
        },
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (c: Context<any, any, any>) => {
        const uid = parseUid(c.req.param("uid") ?? "");
        if (uid === null) return c.json({ error: "uid must be a positive integer" }, 400);
        const resolved = await resolvePrincipal(c);
        if (!resolved) return c.json({ error: "No resolvable principalId" }, 403);
        // `restore` has no fixed source: a message can be restored out of
        // either Archive or Trash, named by `?folder=`.
        const fromFolder = from ?? c.req.query("folder") ?? "Archive";
        let newUid: number;
        try {
          newUid = await moveNativeMailboxMessage(
            db,
            resolved,
            fromFolder,
            uid,
            to,
          );
        } catch {
          return c.json({ error: "Message not found" }, 404);
        }
        publish(resolved, `${to}:${newUid}`, op);
        return c.json({ uid: newUid, ok: true as const });
      },
    );
  }

  return app;
}
