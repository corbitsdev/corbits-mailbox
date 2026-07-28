import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mountMailbox, MAX_MAILBOX_PAGE_LIMIT } from "./mount.js";
import { createInMemoryMailboxEventBus } from "./bus.js";
import { writeMailboxMessage } from "./write.js";
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

describe("bulk validation", () => {
  test("rejects a non-UUID id with 400", async () => {
    const app = buildApp(() => ({ tenantId: "t1", principalId: "p1" }));
    const res = await app.request("/me/inbox/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "mark_read", ids: ["not-a-uuid"] }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects more than 50 ids with 400", async () => {
    const app = buildApp(() => ({ tenantId: "t1", principalId: "p1" }));
    const ids = Array.from({ length: 51 }, () => crypto.randomUUID());
    const res = await app.request("/me/inbox/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "mark_read", ids }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects invalid JSON body with 400", async () => {
    const app = buildApp(() => ({ tenantId: "t1", principalId: "p1" }));
    const res = await app.request("/me/inbox/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("cursor cross-view rejection over HTTP", () => {
  test("a cursor minted for one view used against another returns 400", async () => {
    const app = buildApp(() => ({ tenantId: "t1", principalId: "p1" }));
    for (let i = 0; i < 2; i++) {
      await writeMailboxMessage(db, {
        tenantId: "t1",
        principalId: "p1",
        address: "p1@t1.example",
        fromAddress: "a@t1.example",
        subject: `Msg ${i}`,
        body: "Body",
        messageKey: `cursor-${i}`,
      });
    }
    const listRes = await app.request("/me/inbox?limit=1");
    const listBody = (await listRes.json()) as { nextCursor?: string };
    expect(listBody.nextCursor).toBeDefined();

    const crossViewRes = await app.request(
      `/me/inbox?view=unread&cursor=${listBody.nextCursor}`,
    );
    expect(crossViewRes.status).toBe(400);
  });

  test("a malformed cursor returns 400", async () => {
    const app = buildApp(() => ({ tenantId: "t1", principalId: "p1" }));
    const res = await app.request("/me/inbox?cursor=not-a-real-cursor");
    expect(res.status).toBe(400);
  });

  test("a crafted cursor with a bogus createdAt is a 400, never a 500", async () => {
    // Well-formed base64url and JSON, so it survives decoding — the strict
    // createdAt format check is the only thing standing between this and a
    // SQL cast error mid-query.
    const app = buildApp(() => ({ tenantId: "t1", principalId: "p1" }));
    const crafted = Buffer.from(
      JSON.stringify({
        createdAt: "0",
        id: crypto.randomUUID(),
        view: "all",
        sort: "date",
        filter: "",
      }),
    ).toString("base64url");
    const res = await app.request(`/me/inbox?cursor=${crafted}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "malformed cursor" });
  });

  test("a crafted cursor whose rank is Infinity is a 400, never a 500", async () => {
    // `1e400` is valid JSON that JSON.parse reads as Infinity — a number, so
    // only the safe-integer check on rank refuses it.
    const app = buildApp(() => ({ tenantId: "t1", principalId: "p1" }));
    const crafted = Buffer.from(
      `{"createdAt":"2026-01-01T00:00:00.000000Z","id":"${crypto.randomUUID()}",` +
        `"view":"all","sort":"priority","filter":"",` +
        `"priorities":"urgent,high,normal,low","rank":1e400}`,
    ).toString("base64url");
    const res = await app.request(`/me/inbox?sort=priority&cursor=${crafted}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "malformed cursor" });
  });
});

describe("end-to-end write -> list -> read -> mutate", () => {
  test("full happy path over HTTP", async () => {
    const app = buildApp(() => ({ tenantId: "t1", principalId: "p1" }));
    const written = await writeMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "a@t1.example",
      subject: "Hi",
      body: "Body",
      messageKey: "e2e-1",
    });
    const listRes = await app.request("/me/inbox");
    const listBody = (await listRes.json()) as { messages: { id: string }[] };
    expect(listBody.messages.map((m) => m.id)).toContain(written!.id);

    const detailRes = await app.request(`/me/inbox/${written!.id}`);
    expect(detailRes.status).toBe(200);

    const readRes = await app.request(`/me/inbox/${written!.id}/read`, {
      method: "POST",
    });
    expect(readRes.status).toBe(200);
  });
});

describe("single-message mutation routes", () => {
  test("unread/archive/trash/restore all respond 200 for an in-scope id", async () => {
    const app = buildApp(() => ({ tenantId: "t1", principalId: "p1" }));
    const written = await writeMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "a@t1.example",
      subject: "Hi",
      body: "Body",
      messageKey: "mutations-e2e",
    });
    for (const action of ["unread", "archive", "trash", "restore"]) {
      const res = await app.request(`/me/inbox/${written!.id}/${action}`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
    }
  });

  test("mutation on an unknown id returns 404", async () => {
    const app = buildApp(() => ({ tenantId: "t1", principalId: "p1" }));
    const res = await app.request(`/me/inbox/${crypto.randomUUID()}/read`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  test("non-UUID id returns 400", async () => {
    const app = buildApp(() => ({ tenantId: "t1", principalId: "p1" }));
    const res = await app.request("/me/inbox/not-a-uuid/read", {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });
});

describe("bulk endpoint success path", () => {
  test("applies action and publishes signals for updated ids", async () => {
    const app = buildApp(() => ({ tenantId: "t1", principalId: "p1" }));
    const written = await writeMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "a@t1.example",
      subject: "Hi",
      body: "Body",
      messageKey: "bulk-e2e",
    });
    const res = await app.request("/me/inbox/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "mark_read", ids: [written!.id] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: number };
    expect(body.updated).toBe(1);
  });
});

describe("unread-count and limit validation", () => {
  test("unread-count reflects unread active rows", async () => {
    const app = buildApp(() => ({ tenantId: "t1", principalId: "p1" }));
    await writeMailboxMessage(db, {
      tenantId: "t1",
      principalId: "p1",
      address: "p1@t1.example",
      fromAddress: "a@t1.example",
      subject: "Hi",
      body: "Body",
      messageKey: "unread-count-http",
    });
    const res = await app.request("/me/inbox/unread-count");
    expect(await res.json()).toEqual({ unread: 1 });
  });

  test("invalid limit returns 400", async () => {
    const app = buildApp(() => ({ tenantId: "t1", principalId: "p1" }));
    const res = await app.request("/me/inbox?limit=-1");
    expect(res.status).toBe(400);
  });

  // A limit past the ceiling is REFUSED, not clamped. Silently serving 200 rows
  // to a caller that asked for 201 leaves it paging as though it had 201 — it
  // advances its own offset by what it requested and skips the difference. The
  // boundary is asserted on both sides so a clamp cannot reappear looking green.
  test("limit at the documented maximum is accepted", async () => {
    const app = buildApp(() => ({ tenantId: "t1", principalId: "p1" }));
    const res = await app.request(`/me/inbox?limit=${MAX_MAILBOX_PAGE_LIMIT}`);
    expect(res.status).toBe(200);
  });

  test("limit one past the maximum returns 400, not a clamped page", async () => {
    const app = buildApp(() => ({ tenantId: "t1", principalId: "p1" }));
    const res = await app.request(
      `/me/inbox?limit=${MAX_MAILBOX_PAGE_LIMIT + 1}`,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "limit must be at most 200" });
  });

  test("a far-too-large limit returns 400 rather than the maximum page", async () => {
    const app = buildApp(() => ({ tenantId: "t1", principalId: "p1" }));
    const res = await app.request("/me/inbox?limit=5000");
    expect(res.status).toBe(400);
    // Nothing resembling a page comes back — the refusal is the whole response.
    expect(await res.json()).not.toHaveProperty("messages");
  });

  test("invalid view returns 400", async () => {
    const app = buildApp(() => ({ tenantId: "t1", principalId: "p1" }));
    const res = await app.request("/me/inbox?view=bogus");
    expect(res.status).toBe(400);
  });

  test("message not found returns 404 on detail", async () => {
    const app = buildApp(() => ({ tenantId: "t1", principalId: "p1" }));
    const res = await app.request(`/me/inbox/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
  });
});
