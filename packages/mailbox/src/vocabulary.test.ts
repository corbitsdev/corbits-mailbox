// The package ships mechanism, the host ships opinion. These cases hold that
// line from both ends: what the package refuses to accept as a vocabulary, and
// what changes when a host changes its own.
//
// The cursor fingerprint is the sharp edge. A priority keyset's leading
// component is an INTEGER RANK read out of the host's ordering, so reordering
// that list silently redefines every rank an in-flight cursor carries. The
// filter fingerprint already established the precedent; this is the same
// mechanism applied to the same class of bug.
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mountMailbox } from "./mount.js";
import { createInMemoryMailboxEventBus } from "./bus.js";
import { writeMailboxMessage } from "./write.js";
import { enrichMailboxMessage } from "./mutations.js";
import { decodeMailboxListCursor } from "./read.js";
import {
  assertMailboxVocabulary,
  canonicalMailboxPriorities,
} from "./vocabulary.js";
import { withTestDb, seedScope } from "./test-helpers.js";
import type { MailboxDb } from "./db.js";

let db: MailboxDb;
const SCOPE = { tenantId: "acme", principalId: "user-1" };

beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, "acme", "user-1");
});

const ORDER = ["urgent", "high", "normal", "low"];
const REORDERED = ["high", "urgent", "normal", "low"];

function appWith(priorities: readonly string[]) {
  const app = new Hono();
  mountMailbox(app, {
    db,
    bus: createInMemoryMailboxEventBus(),
    resolvePrincipal: () => SCOPE,
    vocabulary: { priorities, statuses: ["needs-action", "done"] },
  });
  return app;
}

async function seed(priority: string): Promise<string> {
  const written = await writeMailboxMessage(db, {
    ...SCOPE,
    address: "user-1@acme.example",
    fromAddress: "bot@acme.example",
    subject: `p-${priority}-${crypto.randomUUID()}`,
    body: "body",
    messageKey: crypto.randomUUID(),
  });
  await enrichMailboxMessage(db, { ...SCOPE, id: written!.id }, { priority });
  return written!.id;
}

describe("assertMailboxVocabulary", () => {
  test("refuses an empty priority or status list", () => {
    expect(() =>
      assertMailboxVocabulary({ priorities: [], statuses: ["done"] }),
    ).toThrow(RangeError);
    expect(() =>
      assertMailboxVocabulary({ priorities: ["high"], statuses: [] }),
    ).toThrow(RangeError);
  });

  test("refuses duplicates rather than silently keeping the first rank", () => {
    expect(() =>
      assertMailboxVocabulary({
        priorities: ["high", "low", "high"],
        statuses: ["done"],
      }),
    ).toThrow(/duplicates/);
  });

  test("refuses a blank value, which no request could ever name", () => {
    expect(() =>
      assertMailboxVocabulary({ priorities: ["high", ""], statuses: ["done"] }),
    ).toThrow(/blank/);
  });

  test("mountMailbox refuses a bad vocabulary at mount, not on first request", () => {
    expect(() =>
      mountMailbox(new Hono(), {
        db,
        bus: createInMemoryMailboxEventBus(),
        resolvePrincipal: () => SCOPE,
        vocabulary: { priorities: [], statuses: ["done"] },
      }),
    ).toThrow(RangeError);
  });

  test("accepts an ordinary host vocabulary", () => {
    expect(() =>
      assertMailboxVocabulary({ priorities: ORDER, statuses: ["done"] }),
    ).not.toThrow();
  });
});

describe("canonicalMailboxPriorities", () => {
  test("changes when the order changes, so a reorder is detectable", () => {
    expect(canonicalMailboxPriorities(ORDER)).not.toBe(
      canonicalMailboxPriorities(REORDERED),
    );
  });

  test("is stable for the same list, so an unchanged host keeps paging", () => {
    expect(canonicalMailboxPriorities(ORDER)).toBe(
      canonicalMailboxPriorities([...ORDER]),
    );
  });

  test("escapes its values, so two lists cannot collide through the separator", () => {
    expect(canonicalMailboxPriorities(["a,b", "c"])).not.toBe(
      canonicalMailboxPriorities(["a", "b,c"]),
    );
  });
});

describe("a priority cursor is bound to the ordering it was minted under", () => {
  async function mintCursor(priorities: readonly string[]): Promise<string> {
    for (const priority of ORDER) await seed(priority);
    const res = await appWith(priorities).request(
      "/me/inbox?sort=priority&limit=2",
    );
    const body = (await res.json()) as { nextCursor?: string };
    return body.nextCursor!;
  }

  test("the minted cursor carries the ordering, not just the rank", async () => {
    const cursor = await mintCursor(ORDER);
    const decoded = decodeMailboxListCursor(cursor)!;
    expect(decoded.priorities).toBe(canonicalMailboxPriorities(ORDER));
    expect(decoded.rank).toBeNumber();
  });

  test("a host that reorders its vocabulary gets a 400, not a wrong page", async () => {
    const cursor = await mintCursor(ORDER);
    const res = await appWith(REORDERED).request(
      `/me/inbox?sort=priority&limit=2&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "cursor does not match inbox priority ordering",
    });
  });

  test("the unchanged ordering pages through fine", async () => {
    const cursor = await mintCursor(ORDER);
    const res = await appWith(ORDER).request(
      `/me/inbox?sort=priority&limit=2&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: { id: string }[] };
    expect(body.messages.length).toBeGreaterThan(0);
  });

  test("a date-sorted cursor is unaffected by a reorder, carrying no ranking", async () => {
    for (const priority of ORDER) await seed(priority);
    const first = await appWith(ORDER).request("/me/inbox?limit=2");
    const { nextCursor } = (await first.json()) as { nextCursor?: string };
    expect(decodeMailboxListCursor(nextCursor!)!.priorities).toBeUndefined();
    const res = await appWith(REORDERED).request(
      `/me/inbox?limit=2&cursor=${encodeURIComponent(nextCursor!)}`,
    );
    expect(res.status).toBe(200);
  });
});

describe("the ranking itself is the host's list", () => {
  test("sort=priority follows the host's order, not any order this package holds", async () => {
    for (const priority of ORDER) await seed(priority);

    const read = async (priorities: readonly string[]) => {
      const res = await appWith(priorities).request(
        "/me/inbox?sort=priority&limit=50",
      );
      const body = (await res.json()) as { messages: { priority?: string }[] };
      return body.messages.map((m) => m.priority);
    };

    expect(await read(ORDER)).toEqual(ORDER);
    // Same rows, same request — only the host's ordering moved.
    expect(await read(REORDERED)).toEqual(REORDERED);
  });

  test("a priority the host no longer lists ranks last, not first", async () => {
    await seed("urgent");
    await seed("low");
    // "urgent" is dropped from the vocabulary; its stored rows must fall to the
    // bottom rather than sorting ahead of everything as rank 0.
    const res = await appWith(["low", "normal"]).request(
      "/me/inbox?sort=priority&limit=50",
    );
    const body = (await res.json()) as { messages: { priority?: string }[] };
    expect(body.messages.map((m) => m.priority)).toEqual(["low", "urgent"]);
  });
});
