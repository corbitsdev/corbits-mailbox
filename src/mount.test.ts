import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mountMailbox } from "./mount.js";
import { createInMemoryMailboxEventBus } from "./bus.js";
import { withTestDb, seedScope, TEST_VOCABULARY } from "./test-helpers.js";
import type { MailboxDb } from "./db.js";

let db: MailboxDb;

beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, "t1", "p1");
});

function buildApp(
  resolvePrincipal: () => { tenantId: string; principalId: string } | null,
) {
  const app = new Hono();
  mountMailbox(app, {
    db,
    bus: createInMemoryMailboxEventBus(),
    resolvePrincipal,
    vocabulary: TEST_VOCABULARY,
  });
  return app;
}

describe("no-member asymmetry", () => {
  test("list returns empty 200 when resolvePrincipal yields null", async () => {
    const app = buildApp(() => null);
    const res = await app.request("/me/inbox");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
  });

  test("unread-count returns 0 with 200 when resolvePrincipal yields null", async () => {
    const app = buildApp(() => null);
    const res = await app.request("/me/inbox/unread-count");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unread: 0 });
  });

  test("events returns 403 when resolvePrincipal yields null", async () => {
    const app = buildApp(() => null);
    const res = await app.request("/me/inbox/events");
    expect(res.status).toBe(403);
  });

  test("detail returns 403 when resolvePrincipal yields null", async () => {
    const app = buildApp(() => null);
    const res = await app.request(
      "/me/inbox/00000000-0000-0000-0000-000000000000",
    );
    expect(res.status).toBe(403);
  });

  // Every single-message verb funnels through the same `singleMutation`
  // helper, but the table below is what proves each registered route actually
  // reaches it — a verb wired straight to its handler would slip past a
  // one-verb test.
  for (const verb of ["read", "unread", "trash", "archive", "restore"]) {
    test(`${verb} mutation returns 403 when resolvePrincipal yields null`, async () => {
      const app = buildApp(() => null);
      const res = await app.request(
        `/me/inbox/00000000-0000-0000-0000-000000000000/${verb}`,
        { method: "POST" },
      );
      expect(res.status).toBe(403);
    });
  }

  test("bulk returns 403 when resolvePrincipal yields null", async () => {
    const app = buildApp(() => null);
    const res = await app.request("/me/inbox/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "mark_read",
        ids: ["00000000-0000-0000-0000-000000000000"],
      }),
    });
    expect(res.status).toBe(403);
  });
});
