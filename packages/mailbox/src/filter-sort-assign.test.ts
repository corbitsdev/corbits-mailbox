// The read side of enrichment: selectively querying back the enrichment
// columns, and the delegation ref. Also pins the empty-`ids` bulk contract, which shipped
// with no test either way.
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mountMailbox } from "./mount.js";
import { createInMemoryMailboxEventBus } from "./bus.js";
import { writeMailboxMessage } from "./write.js";
import { listUserMailbox } from "./read.js";
import {
  applyMailboxBulkAction,
  assignMailboxMessage,
  enrichMailboxMessage,
} from "./mutations.js";
import { decodeMailboxListCursor } from "./read.js";
import { withTestDb, seedScope, TEST_VOCABULARY } from "./test-helpers.js";
import type { MailboxDb } from "./db.js";

let db: MailboxDb;
const SCOPE = { tenantId: "acme", principalId: "user-1" };

beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, "acme", "user-1", "user-9");
});

function buildApp() {
  const app = new Hono();
  mountMailbox(app, {
    vocabulary: TEST_VOCABULARY,
    db,
    bus: createInMemoryMailboxEventBus(),
    resolvePrincipal: () => SCOPE,
  });
  return app;
}

async function write(subject: string): Promise<string> {
  const written = await writeMailboxMessage(db, {
    ...SCOPE,
    address: "user-1@acme.example",
    fromAddress: "bot@acme.example",
    subject,
    body: `body of ${subject}`,
    messageKey: crypto.randomUUID(),
  });
  return written!.id;
}

/** Three messages, each stamped with a different priority + classification. */
async function seedEnriched(): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const [subject, priority, classification] of [
    ["low one", "low", "newsletter"],
    ["high one", "high", "customer"],
    ["urgent one", "urgent", "customer"],
  ] as const) {
    const id = await write(subject);
    await enrichMailboxMessage(
      db,
      { ...SCOPE, id },
      {
        priority,
        classification,
        status: "needs-action",
      },
    );
    ids[subject] = id;
  }
  return ids;
}

describe("list filtering by enrichment", () => {
  test("priority narrows the page to matching messages", async () => {
    await seedEnriched();
    const page = await listUserMailbox(db, {
      priorities: TEST_VOCABULARY.priorities,
      ...SCOPE,
      limit: 10,
      view: "all",
      filter: { priority: "high" },
    });
    expect(page.items.map((m) => m.subject)).toEqual(["high one"]);
  });

  test("classification and status combine as an AND", async () => {
    const ids = await seedEnriched();
    await enrichMailboxMessage(
      db,
      { ...SCOPE, id: ids["high one"]! },
      {
        status: "done",
      },
    );
    const page = await listUserMailbox(db, {
      priorities: TEST_VOCABULARY.priorities,
      ...SCOPE,
      limit: 10,
      view: "all",
      filter: { classification: "customer", status: "needs-action" },
    });
    expect(page.items.map((m) => m.subject)).toEqual(["urgent one"]);
  });

  test("the route exposes the same filter over the query string", async () => {
    await seedEnriched();
    const res = await buildApp().request("/me/inbox?priority=urgent");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: { subject: string }[] };
    expect(body.messages.map((m) => m.subject)).toEqual(["urgent one"]);
  });

  test("an unknown priority or status is a 400, not a silently empty page", async () => {
    const app = buildApp();
    expect((await app.request("/me/inbox?priority=critical")).status).toBe(400);
    expect((await app.request("/me/inbox?status=maybe")).status).toBe(400);
  });
});

describe("list sorting by priority", () => {
  test("sort=priority orders urgent first and un-triaged mail last", async () => {
    await seedEnriched();
    await write("untriaged");
    const page = await listUserMailbox(db, {
      priorities: TEST_VOCABULARY.priorities,
      ...SCOPE,
      limit: 10,
      view: "all",
      sort: "priority",
    });
    expect(page.items.map((m) => m.subject)).toEqual([
      "urgent one",
      "high one",
      "low one",
      "untriaged",
    ]);
  });

  test("the default sort is still newest-first by date", async () => {
    await seedEnriched();
    // Written last and never triaged, so it leads by date and trails by
    // priority — which is what tells the two orderings apart.
    await write("untriaged");
    const expected = ["untriaged", "urgent one", "high one", "low one"];
    const page = await listUserMailbox(db, {
      ...SCOPE,
      limit: 10,
      view: "all",
      priorities: TEST_VOCABULARY.priorities,
    });
    expect(page.items.map((m) => m.subject)).toEqual(expected);
    const byDate = await buildApp().request("/me/inbox");
    const body = (await byDate.json()) as { messages: { subject: string }[] };
    expect(body.messages.map((m) => m.subject)).toEqual(expected);
  });

  test("a priority-sorted page seeks past its cursor without repeating a row", async () => {
    await seedEnriched();
    await write("untriaged");
    const first = await listUserMailbox(db, {
      priorities: TEST_VOCABULARY.priorities,
      ...SCOPE,
      limit: 2,
      view: "all",
      sort: "priority",
    });
    expect(first.items.map((m) => m.subject)).toEqual([
      "urgent one",
      "high one",
    ]);
    const cursor = decodeMailboxListCursor(first.nextCursor!);
    expect(cursor?.sort).toBe("priority");
    expect(cursor?.rank).toBe(1);
    const second = await listUserMailbox(db, {
      priorities: TEST_VOCABULARY.priorities,
      ...SCOPE,
      limit: 2,
      view: "all",
      sort: "priority",
      cursor: cursor!,
    });
    expect(second.items.map((m) => m.subject)).toEqual([
      "low one",
      "untriaged",
    ]);
    expect(second.nextCursor).toBeUndefined();
  });

  test("an invalid sort is a 400", async () => {
    expect((await buildApp().request("/me/inbox?sort=random")).status).toBe(
      400,
    );
  });
});

describe("cursors are bound to the result set they were minted from", () => {
  test("a cursor from a different sort is refused", async () => {
    await seedEnriched();
    const app = buildApp();
    const res = await app.request("/me/inbox?sort=priority&limit=1");
    const { nextCursor } = (await res.json()) as { nextCursor: string };
    const reused = await app.request(
      `/me/inbox?limit=1&cursor=${encodeURIComponent(nextCursor)}`,
    );
    expect(reused.status).toBe(400);
    expect(await reused.json()).toEqual({
      error: "cursor does not match inbox sort",
    });
  });

  test("a cursor from a different filter is refused", async () => {
    await seedEnriched();
    const app = buildApp();
    const res = await app.request("/me/inbox?classification=customer&limit=1");
    const { nextCursor } = (await res.json()) as { nextCursor: string };
    const reused = await app.request(
      `/me/inbox?limit=1&cursor=${encodeURIComponent(nextCursor)}`,
    );
    expect(reused.status).toBe(400);
    expect(await reused.json()).toEqual({
      error: "cursor does not match inbox filter",
    });
  });

  test("the same filter and sort page through fine", async () => {
    await seedEnriched();
    const app = buildApp();
    const res = await app.request("/me/inbox?classification=customer&limit=1");
    const { nextCursor } = (await res.json()) as { nextCursor: string };
    const next = await app.request(
      `/me/inbox?classification=customer&limit=1&cursor=${encodeURIComponent(nextCursor)}`,
    );
    expect(next.status).toBe(200);
    const body = (await next.json()) as { messages: { subject: string }[] };
    expect(body.messages.map((m) => m.subject)).toEqual(["high one"]);
  });
});

describe("delegation via the assignee ref", () => {
  test("assign stamps the assignee onto the row and the projection", async () => {
    const id = await write("delegate me");
    const res = await buildApp().request(`/me/inbox/${id}/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignee: "user-2" }),
    });
    expect(res.status).toBe(200);
    const detail = await buildApp().request(`/me/inbox/${id}`);
    expect((await detail.json()).assignee).toBe("user-2");
  });

  test("listing by assignee shows what this principalId delegated to whom", async () => {
    const delegated = await write("delegated");
    await write("kept");
    await assignMailboxMessage(db, { ...SCOPE, id: delegated }, "user-2");
    const page = await listUserMailbox(db, {
      priorities: TEST_VOCABULARY.priorities,
      ...SCOPE,
      limit: 10,
      view: "all",
      filter: { assignee: "user-2" },
    });
    expect(page.items.map((m) => m.subject)).toEqual(["delegated"]);
  });

  test("assigning null un-delegates and drops the field from the projection", async () => {
    const id = await write("delegate me");
    await assignMailboxMessage(db, { ...SCOPE, id }, "user-2");
    const res = await buildApp().request(`/me/inbox/${id}/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignee: null }),
    });
    expect(res.status).toBe(200);
    const detail = await buildApp().request(`/me/inbox/${id}`);
    expect(await detail.json()).not.toHaveProperty("assignee");
  });

  test("assigning a message in another principalId's mailbox is a 404", async () => {
    const foreign = await writeMailboxMessage(db, {
      tenantId: "acme",
      principalId: "user-9",
      address: "user-9@acme.example",
      fromAddress: "bot@acme.example",
      subject: "not yours",
      body: "b",
      messageKey: crypto.randomUUID(),
    });
    const res = await buildApp().request(`/me/inbox/${foreign!.id}/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignee: "user-2" }),
    });
    expect(res.status).toBe(404);
  });

  test("a body without an assignee key is a 400", async () => {
    const id = await write("delegate me");
    const res = await buildApp().request(`/me/inbox/${id}/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("bulk with an empty id list", () => {
  // Deliberately NOT an error. `ids: []` is the partial-success contract
  // applied to zero ids — the honest answer to "apply this action to nothing"
  // is that nothing was updated. A client that clears its selection and fires
  // anyway should get a no-op, not a 400 it has to special-case. Pinned here
  // because it had no test in either direction.
  test("the library returns no results and touches nothing", async () => {
    const id = await write("untouched");
    expect(await applyMailboxBulkAction(db, SCOPE, "trash", [])).toEqual([]);
    const page = await listUserMailbox(db, {
      ...SCOPE,
      limit: 10,
      view: "all",
      priorities: TEST_VOCABULARY.priorities,
    });
    expect(page.items.map((m) => m.id)).toEqual([id]);
  });

  test("the route answers 200 with updated: 0", async () => {
    const res = await buildApp().request("/me/inbox/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "trash", ids: [] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 0, results: [] });
  });
});
