import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import { createMailboxRoutes, type ResolvedPrincipal } from "../src/mount.js";
import { createInMemoryMailboxEventBus } from "../src/bus.js";
import { allowAllGrants, mountAs, withTestDb, seedScope } from "./helpers.js";
import type { MailboxDb } from "../src/db.js";

let db: MailboxDb;

beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, "t1", "p1");
});

function buildApp(
  scope: ResolvedPrincipal | null,
) {
  const app = mountAs(
    scope,
    createMailboxRoutes({
      db,
      requireGrant: allowAllGrants,
      bus: createInMemoryMailboxEventBus(),
      senderAddressFor: () => "sender@t1.example",
      deliver: () => {},
    }),
  );
  return app;
}

describe("no principal", () => {
  test("list returns 403 when the context carries no principal", async () => {
    const app = buildApp(null);
    const res = await app.request("/me/inbox");
    expect(res.status).toBe(403);
  });

  test("events returns 403 when the context carries no principal", async () => {
    const app = buildApp(null);
    const res = await app.request("/me/inbox/events");
    expect(res.status).toBe(403);
  });

  // Every single-message verb funnels through its own store lookup, but the
  // table below is what proves each registered route actually reaches it — a
  // verb wired straight to its handler would slip past a one-verb test.
  for (const verb of ["read", "unread", "trash", "archive", "restore"]) {
    test(`${verb} mutation returns 403 when the context carries no principal`, async () => {
      const app = buildApp(null);
      const res = await app.request(`/me/inbox/1/${verb}`, { method: "POST" });
      expect(res.status).toBe(403);
    });
  }
});

describe("grant gating", () => {
  function buildGatedApp(checked: string[]) {
    const requireGrant: RequireGrant = (resource, action) => async (c) => {
      checked.push(`${String(resource)} ${action}`);
      return c.json({ error: "forbidden" }, 403);
    };
    return mountAs(
      { tenantId: "t1", principalId: "p1" },
      createMailboxRoutes({
        db,
        requireGrant,
        bus: createInMemoryMailboxEventBus(),
        senderAddressFor: () => "sender@t1.example",
        deliver: () => {},
      }),
    );
  }

  test("send requires mailbox:* create", async () => {
    const checked: string[] = [];
    const res = await buildGatedApp(checked).request("/me/inbox/send", {
      method: "POST",
    });
    expect(res.status).toBe(403);
    expect(checked).toEqual(["mailbox:* create"]);
  });

  for (const verb of ["read", "unread", "trash", "archive", "restore"]) {
    test(`${verb} requires mailbox:* manage`, async () => {
      const checked: string[] = [];
      const res = await buildGatedApp(checked).request(`/me/inbox/1/${verb}`, {
        method: "POST",
      });
      expect(res.status).toBe(403);
      expect(checked).toEqual(["mailbox:* manage"]);
    });
  }

  for (const path of ["/me/inbox", "/me/inbox/threads", "/me/inbox/threads/1", "/me/inbox/events"]) {
    test(`${path} requires mailbox:* read`, async () => {
      const checked: string[] = [];
      const res = await buildGatedApp(checked).request(path);
      expect(res.status).toBe(403);
      expect(checked).toEqual(["mailbox:* read"]);
    });
  }
});

describe("principal from the tenant middleware", () => {
  test("reads the tenant and principal the host middleware set", async () => {
    const now = new Date();
    const host = new Hono<TenantEnv>();
    host.use(async (c, next) => {
      c.set("tenant", {
        id: "t1",
        name: "t1",
        slug: "t1",
        domain: "t1.example",
        parentId: null,
        config: null,
        createdAt: now,
        updatedAt: now,
      });
      c.set("principal", {
        id: "p1",
        tenantId: "t1",
        kind: "user",
        refId: "p1",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await next();
    });
    host.route(
      "/mailbox",
      createMailboxRoutes({
        db,
        requireGrant: allowAllGrants,
        bus: createInMemoryMailboxEventBus(),
        senderAddressFor: () => "p1@t1.example",
        deliver: () => {},
      }),
    );

    const send = await host.request("/mailbox/me/inbox/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: ["x@t1.example"], body: "hi" }),
    });
    expect(send.status).toBe(200);
    const list = await host.request("/mailbox/me/inbox?folder=Sent");
    const { messages } = (await list.json()) as { messages: unknown[] };
    expect(messages).toHaveLength(1);
  });
});
