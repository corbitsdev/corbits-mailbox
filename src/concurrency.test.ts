// Two properties that had only sequential/adjacent coverage: COALESCE idempotency under genuinely CONCURRENT writers, and
// multi-tab SSE fan-out (the existing suite covers unsubscribe isolation,
// which is a different property).
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { mountMailbox } from "./mount.js";
import { createInMemoryMailboxEventBus } from "./bus.js";
import { writeMailboxMessage } from "./write.js";
import {
  markMailboxMessageRead,
  trashMailboxMessage,
  archiveMailboxMessage,
} from "./mutations.js";
import { withTestDb, seedScope, TEST_VOCABULARY } from "./test-helpers.js";
import type { MailboxDb } from "./db.js";

const SCOPE = { tenantId: "t1", principalId: "p1" };

async function seed(db: MailboxDb, messageKey: string): Promise<string> {
  await seedScope(db, SCOPE.tenantId, SCOPE.principalId);
  const written = await writeMailboxMessage(db, {
    ...SCOPE,
    address: "p1@t1.example",
    fromAddress: "a@t1.example",
    subject: "s",
    body: "b",
    messageKey,
  });
  return written!.id;
}

async function timestamps(
  db: MailboxDb,
  id: string,
): Promise<{
  read: string | null;
  trashed: string | null;
  archived: string | null;
}> {
  const [row] = await db.execute<{
    read_at: string | null;
    trashed_at: string | null;
    archived_at: string | null;
  }>(
    sql`SELECT read_at, trashed_at, archived_at FROM "mailbox"."mailbox" WHERE id = ${id}`,
  );
  return {
    read: row!.read_at,
    trashed: row!.trashed_at,
    archived: row!.archived_at,
  };
}

describe("COALESCE idempotency under concurrent writers", () => {
  test("eight concurrent read-marks settle on ONE readAt", async () => {
    const db = await withTestDb();
    const id = await seed(db, "concurrent-read");

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        markMailboxMessageRead(db, { ...SCOPE, id }),
      ),
    );
    // Every writer matched the row — the guard is scope, not prior state.
    expect(results).toEqual(Array.from({ length: 8 }, () => true));

    const first = await timestamps(db, id);
    expect(first.read).not.toBeNull();

    // A later wave must not move the timestamp the first wave established.
    await Promise.all(
      Array.from({ length: 8 }, () =>
        markMailboxMessageRead(db, { ...SCOPE, id }),
      ),
    );
    expect((await timestamps(db, id)).read).toBe(first.read!);
  });

  test("concurrent trash-marks settle on one trashedAt with archived cleared", async () => {
    const db = await withTestDb();
    const id = await seed(db, "concurrent-trash");
    await archiveMailboxMessage(db, { ...SCOPE, id });

    await Promise.all(
      Array.from({ length: 6 }, () =>
        trashMailboxMessage(db, { ...SCOPE, id }),
      ),
    );
    const after = await timestamps(db, id);
    expect(after.trashed).not.toBeNull();
    // Trash wins: archived is cleared, and stays cleared.
    expect(after.archived).toBeNull();

    await Promise.all(
      Array.from({ length: 6 }, () =>
        trashMailboxMessage(db, { ...SCOPE, id }),
      ),
    );
    expect((await timestamps(db, id)).trashed).toBe(after.trashed!);
  });

  test("archive is refused for an already-trashed row, concurrently too", async () => {
    const db = await withTestDb();
    const id = await seed(db, "concurrent-archive");
    await trashMailboxMessage(db, { ...SCOPE, id });

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        archiveMailboxMessage(db, { ...SCOPE, id }),
      ),
    );
    expect(results.some((ok) => ok)).toBe(false);
    expect((await timestamps(db, id)).archived).toBeNull();
  });
});

describe("SSE multi-tab fan-out", () => {
  test("three open streams for one principalId each receive every event", async () => {
    const db = await withTestDb();
    await seedScope(db, SCOPE.tenantId, SCOPE.principalId);
    const bus = createInMemoryMailboxEventBus();
    const app = mountMailbox(new Hono(), {
      vocabulary: TEST_VOCABULARY,
      db,
      bus,
      resolvePrincipal: () => SCOPE,
    });

    // Three tabs, i.e. three independent HTTP requests for the same principal.
    const responses = await Promise.all([
      app.request("/me/inbox/events"),
      app.request("/me/inbox/events"),
      app.request("/me/inbox/events"),
    ]);
    for (const res of responses) expect(res.status).toBe(200);
    const readers = responses.map((res) => res.body!.getReader());
    // Let every handler register its subscription before publishing.
    await new Promise((r) => setTimeout(r, 100));

    const written = await writeMailboxMessage(
      db,
      {
        ...SCOPE,
        address: "p1@t1.example",
        fromAddress: "a@t1.example",
        subject: "multi",
        body: "body",
        messageKey: "multi-tab",
      },
      bus,
    );

    const chunks = await Promise.all(
      readers.map((reader) =>
        Promise.race([
          reader.read().then((r) => new TextDecoder().decode(r.value)),
          new Promise<string>((r) => setTimeout(() => r("__TIMEOUT__"), 3000)),
        ]),
      ),
    );
    await Promise.all(readers.map((reader) => reader.cancel()));

    for (const chunk of chunks) {
      expect(chunk).not.toBe("__TIMEOUT__");
      expect(chunk).toContain("event: mailbox");
      expect(chunk).toContain(written!.id);
    }
  });

  test("closing one tab leaves the other tabs streaming", async () => {
    const db = await withTestDb();
    await seedScope(db, SCOPE.tenantId, SCOPE.principalId);
    const bus = createInMemoryMailboxEventBus();
    const app = mountMailbox(new Hono(), {
      vocabulary: TEST_VOCABULARY,
      db,
      bus,
      resolvePrincipal: () => SCOPE,
    });

    const closing = await app.request("/me/inbox/events");
    const surviving = await app.request("/me/inbox/events");
    const closingReader = closing.body!.getReader();
    const survivingReader = surviving.body!.getReader();
    await new Promise((r) => setTimeout(r, 100));
    await closingReader.cancel();
    await new Promise((r) => setTimeout(r, 100));

    const written = await writeMailboxMessage(
      db,
      {
        ...SCOPE,
        address: "p1@t1.example",
        fromAddress: "a@t1.example",
        subject: "still here",
        body: "body",
        messageKey: "survivor",
      },
      bus,
    );
    const chunk = await Promise.race([
      survivingReader.read().then((r) => new TextDecoder().decode(r.value)),
      new Promise<string>((r) => setTimeout(() => r("__TIMEOUT__"), 3000)),
    ]);
    await survivingReader.cancel();
    expect(chunk).toContain(written!.id);
  });
});
