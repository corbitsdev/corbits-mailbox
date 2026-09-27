import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { describeRoute } from "hono-openapi";
import { type } from "arktype";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
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
import { assertMsgId, buildMailFrame, generateMailboxMessageId, headerValue } from "./frame.js";

const logger = getLogger(["corbits-mailbox", "mount"]);

export type ResolvedPrincipal = { tenantId: string; principalId: string };

/** A message this package has assembled and appended to the caller's Sent folder. */
export type OutgoingMailboxMessage = {
  raw: Uint8Array;
  from: string;
  to: string[];
  messageId: string;
};

export type CreateMailboxRoutesDeps = {
  db: MailboxDb;
  bus: MailboxEventBus;
  /** `mailbox:*` `read` for reads, `create` for send, `manage` for flag/move. */
  requireGrant: RequireGrant;
  /**
   * SSE keep-alive period. Defaults to 25s — under the 30s idle timeout most
   * proxies default to.
   */
  heartbeatIntervalMs?: number;
  /**
   * The caller's own address, as the host resolves it — the `From:` of every
   * message `POST /me/inbox/send` builds.
   */
  senderAddressFor: (
    principal: ResolvedPrincipal,
  ) => Promise<string> | string;
  /**
   * The host's actual transport. This package only builds the RFC 5322
   * message and appends a copy to the caller's `Sent` folder — it never puts
   * a byte on a wire itself. `POST /me/inbox/send` calls this, once, after
   * that append settles; the host owns getting `message.raw` to
   * `message.to`.
   */
  deliver: (message: OutgoingMailboxMessage) => Promise<void> | void;
};

const SendMailboxMessageSchema = type({
  to: "string[] > 0",
  "subject?": "string",
  body: "string > 0",
  "inReplyTo?": "string",
});

const DEFAULT_LIMIT = 50;
/** Documented ceiling on `?limit=`. Exceeding it is a 400, never a silent clamp. */
export const MAX_MAILBOX_PAGE_LIMIT = 200;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * Ceiling on SSE events queued for one connection whose client has stopped
 * reading. An event is a nudge, never the data, so a stalled consumer is
 * disconnected rather than buffered for.
 */
export const MAX_PENDING_SSE_EVENTS = 100;

const DEFAULT_FOLDER = "INBOX";
/** Folders `?folder=` may name for `GET /me/inbox`. */
const LIST_FOLDERS = ["INBOX", "Sent", "Archive", "Trash"] as const;
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
function uidParam(name: string) {
  return {
    name,
    in: "path" as const,
    required: true,
    schema: { type: "integer" as const },
  };
}

const ID_PARAM = uidParam("uid");

/**
 * One item of `GET /me/inbox`: `@intx/mailbox`'s `executeSearch`'s ref, plus the
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

/**
 * One node of `GET /me/inbox/threads(/:rootUid)`: `@intx/mailbox`'s
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
  if (!message) {
    throw new Error(`thread node uid ${node.ref.uid} is not in the store`);
  }
  return {
    uid: node.ref.uid,
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
 * Whose mailbox this request reads: the `tenant` and `principal` the host's
 * tenant middleware set, the same principal `requireGrant` authorizes.
 */
function resolvePrincipal(c: Context<TenantEnv>): ResolvedPrincipal | null {
  const tenantId = c.get("tenant")?.id;
  const principalId = c.get("principal")?.id;
  return tenantId && principalId ? { tenantId, principalId } : null;
}

function inFolder(
  scope: ResolvedPrincipal,
  folder: string,
): ResolvedPrincipal & { folder: string } {
  return { tenantId: scope.tenantId, principalId: scope.principalId, folder };
}

/**
 * The mailbox routes under `/me/inbox*`, as a sub-app the host mounts with
 * `app.route`.
 *
 * This library exists ONLY to give human principals a native Interchange
 * mailbox — list, read/unread, archive/trash/restore, and a live SSE stream.
 * Every route is a thin wrapper over `NativeMailboxStore` and
 * `@intx/mailbox`'s `executeSearch`.
 *
 * Every route returns 403 when the context carries no principal.
 */
export function createMailboxRoutes(
  deps: CreateMailboxRoutesDeps,
): Hono<TenantEnv> {
  const { db, bus, requireGrant, senderAddressFor, deliver } = deps;
  const heartbeatIntervalMs =
    deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
    throw new RangeError(
      "mailbox heartbeatIntervalMs must be a finite positive number",
    );
  }

  const app = new Hono<TenantEnv>();

  function publish(
    scope: ResolvedPrincipal,
    id: string,
    op: MailboxEventOp,
  ): void {
    publishMailboxEvent(bus, scope, id, logger, op);
  }

  app.get(
    "/me/inbox",
    requireGrant("mailbox:*", "read"),
    describeRoute({
      tags: TAGS,
      summary: "List the caller's inbox",
      description:
        "Newest first, keyset-paginated over the native mailbox store's uid " +
        "counter.",
      parameters: [
        {
          name: "folder",
          in: "query",
          description: "INBOX (default), Sent, Archive, or Trash.",
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

      const resolved = resolvePrincipal(c);
      if (!resolved) return c.json({ error: "No resolvable principalId" }, 403);

      const store = await openNativeMailboxStore(db, inFolder(resolved, folder));
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
    requireGrant("mailbox:*", "read"),
    describeRoute({
      tags: TAGS,
      summary: "The caller's inbox as threads",
      description:
        "`@intx/mailbox`'s `executeThread` (REFERENCES algorithm) run over the " +
        "folder's native store — roots plus children, each ref carrying the " +
        "same envelope fields `GET /me/inbox` returns.",
      parameters: [
        {
          name: "folder",
          in: "query",
          description: "INBOX (default), Sent, Archive, or Trash.",
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
      const resolved = resolvePrincipal(c);
      if (!resolved) return c.json({ error: "No resolvable principalId" }, 403);

      const store = await openNativeMailboxStore(db, inFolder(resolved, folder));
      const threads = await executeThread(folder, store, "references");
      return c.json({
        threads: threads.map((thread) => enrichThread(store, thread)),
      });
    },
  );

  app.get(
    "/me/inbox/threads/:rootUid",
    requireGrant("mailbox:*", "read"),
    describeRoute({
      tags: TAGS,
      summary: "One thread, rooted at the given uid",
      parameters: [
        uidParam("rootUid"),
        {
          name: "folder",
          in: "query",
          description: "INBOX (default), Sent, Archive, or Trash.",
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
      const resolved = resolvePrincipal(c);
      if (!resolved) return c.json({ error: "No resolvable principalId" }, 403);

      const store = await openNativeMailboxStore(db, inFolder(resolved, folder));
      const threads = await executeThread(folder, store, "references");
      const root = threads.find((thread) => thread.ref.uid === rootUid);
      if (!root) return c.json({ error: "Thread not found" }, 404);
      return c.json({ thread: enrichThread(store, root) });
    },
  );

  app.post(
    "/me/inbox/send",
    requireGrant("mailbox:*", "create"),
    describeRoute({
      tags: TAGS,
      summary: "Send a message from the caller's mailbox",
      description:
        "Builds an RFC 5322 message, appends a copy to the caller's Sent " +
        "folder via the native store, then hands it to the host's own " +
        "`deliver` — this package owns no transport.",
      responses: {
        200: { description: "The Sent copy's messageId and uid" },
        400: { description: "Malformed body" },
        403: { description: "No resolvable principalId" },
      },
    }),
    async (c) => {
      const resolved = resolvePrincipal(c);
      if (!resolved) return c.json({ error: "No resolvable principalId" }, 403);

      let json: unknown;
      try {
        json = await c.req.json();
      } catch {
        return c.json({ error: "Malformed JSON body" }, 400);
      }
      const parsed = SendMailboxMessageSchema(json);
      if (parsed instanceof type.errors) {
        return c.json({ error: parsed.summary }, 400);
      }

      const fromAddress = headerValue(await senderAddressFor(resolved));
      const messageId = generateMailboxMessageId(fromAddress);
      const subject = parsed.subject ?? "";

      let inReplyTo: string | undefined;
      let references: string[] | undefined;
      if (parsed.inReplyTo !== undefined) {
        inReplyTo = headerValue(parsed.inReplyTo);
        try {
          assertMsgId(inReplyTo, "inReplyTo");
        } catch (err) {
          return c.json({ error: (err as Error).message }, 400);
        }
        // Best-effort ancestry lookup: the parent's own References chain,
        // followed by the parent itself. A parent this store cannot find
        // (a different mailbox, a purged message) still threads on
        // `inReplyTo` alone — the chain just starts here instead of further
        // back.
        let parentReferences: string[] = [];
        for (const folder of LIST_FOLDERS) {
          const folderStore = await openNativeMailboxStore(db, inFolder(resolved, folder));
          const parent = folderStore.messages.find(
            (m) => m.envelope.messageId === inReplyTo,
          );
          if (parent) {
            parentReferences = [...parent.envelope.references];
            break;
          }
        }
        references = [...parentReferences, inReplyTo];
      }

      const frameArgs: Parameters<typeof buildMailFrame>[0] = {
        from: fromAddress,
        to: parsed.to.join(", "),
        subject,
        body: parsed.body,
        messageId,
      };
      if (inReplyTo !== undefined) frameArgs.inReplyTo = inReplyTo;
      if (references !== undefined) frameArgs.references = references;
      const raw = buildMailFrame(frameArgs);

      const sentStore = await openNativeMailboxStore(db, inFolder(resolved, "Sent"));
      const uid = sentStore.append(
        raw,
        {
          messageId,
          from: fromAddress,
          to: parsed.to,
          subject,
          date: new Date(),
          inReplyTo,
          references: references ?? [],
          interchangeType: undefined,
          interchangeCorrelationId: undefined,
        },
        [],
      );
      await sentStore.settled;
      publish(resolved, `Sent:${uid}`, "create");

      await deliver({ raw, from: fromAddress, to: parsed.to, messageId });

      return c.json({ messageId, uid });
    },
  );

  app.get(
    "/me/inbox/events",
    requireGrant("mailbox:*", "read"),
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
      const resolved = resolvePrincipal(c);
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
      requireGrant("mailbox:*", "manage"),
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
      async (c) => {
        const uid = parseUid(c.req.param("uid") ?? "");
        if (uid === null) return c.json({ error: "uid must be a positive integer" }, 400);
        const resolved = resolvePrincipal(c);
        if (!resolved) return c.json({ error: "No resolvable principalId" }, 403);
        const folder = c.req.query("folder") ?? DEFAULT_FOLDER;
        const store = await openNativeMailboxStore(db, inFolder(resolved, folder));
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
      requireGrant("mailbox:*", "manage"),
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
      async (c) => {
        const uid = parseUid(c.req.param("uid") ?? "");
        if (uid === null) return c.json({ error: "uid must be a positive integer" }, 400);
        const resolved = resolvePrincipal(c);
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
