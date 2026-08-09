import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { generateSpecs } from "hono-openapi";
import { mountMailbox, MAX_MAILBOX_PAGE_LIMIT } from "./mount.js";
import { createInMemoryMailboxEventBus } from "./bus.js";
import type { MailboxDb } from "./db.js";
import { TEST_VOCABULARY } from "./test-helpers.js";

// Route descriptions must survive mounting: a host that serves an OpenAPI
// document gets the mailbox surface documented for free, so this asserts the
// generated spec, not just that `describeRoute` was called.
const mounted = () =>
  mountMailbox(new Hono(), {
    vocabulary: TEST_VOCABULARY,
    db: {} as MailboxDb,
    bus: createInMemoryMailboxEventBus(),
    resolvePrincipal: () => null,
  });

describe("OpenAPI", () => {
  test("every mounted route appears in the generated spec", async () => {
    const spec = await generateSpecs(mounted());
    expect(Object.keys(spec.paths ?? {}).sort()).toEqual([
      "/me/inbox",
      "/me/inbox/bulk",
      "/me/inbox/events",
      "/me/inbox/unread-count",
      "/me/inbox/{id}",
      "/me/inbox/{id}/archive",
      "/me/inbox/{id}/assign",
      "/me/inbox/{id}/enrich",
      "/me/inbox/{id}/read",
      "/me/inbox/{id}/restore",
      "/me/inbox/{id}/trash",
      "/me/inbox/{id}/unread",
    ]);
  });

  test("every operation carries a summary, a mailbox tag, and responses", async () => {
    const spec = await generateSpecs(mounted());
    const operations = Object.values(spec.paths ?? {}).flatMap((path) =>
      Object.values(path ?? {}),
    ) as { summary?: string; tags?: string[]; responses?: object }[];
    expect(operations.length).toBe(12);
    for (const op of operations) {
      expect(op.summary).toBeString();
      expect(op.tags).toEqual(["mailbox"]);
      expect(Object.keys(op.responses ?? {}).length).toBeGreaterThan(0);
    }
  });

  test("the list route documents its view, limit, cursor, sort and filter query params", async () => {
    const spec = await generateSpecs(mounted());
    const params = (spec.paths?.["/me/inbox"]?.get?.parameters ?? []) as {
      name: string;
    }[];
    expect(params.map((p) => p.name).sort()).toEqual([
      "assignee",
      "classification",
      "cursor",
      "limit",
      "priority",
      "sort",
      "status",
      "view",
    ]);
  });

  test("the priority and status enums are generated from the host's vocabulary", async () => {
    // The package ships no vocabulary, so the document can only describe the
    // host's. A spec that advertised a taxonomy the host never chose would
    // generate clients that 400 on every triage filter.
    const app = mountMailbox(new Hono(), {
      db: {} as MailboxDb,
      bus: createInMemoryMailboxEventBus(),
      resolvePrincipal: () => null,
      vocabulary: {
        priorities: ["p0", "p1", "p2"],
        statuses: ["open", "shipped"],
      },
    });
    const spec = await generateSpecs(app);
    const params = (spec.paths?.["/me/inbox"]?.get?.parameters ?? []) as {
      name: string;
      schema?: { enum?: string[] };
    }[];
    expect(params.find((p) => p.name === "priority")?.schema?.enum).toEqual([
      "p0",
      "p1",
      "p2",
    ]);
    expect(params.find((p) => p.name === "status")?.schema?.enum).toEqual([
      "open",
      "shipped",
    ]);
  });

  test("the documented priority enum keeps the host's order, which is the ranking", async () => {
    const spec = await generateSpecs(mounted());
    const params = (spec.paths?.["/me/inbox"]?.get?.parameters ?? []) as {
      name: string;
      schema?: { enum?: string[] };
    }[];
    expect(params.find((p) => p.name === "priority")?.schema?.enum).toEqual([
      ...TEST_VOCABULARY.priorities,
    ]);
  });

  test("the documented limit ceiling is the one the handler enforces", async () => {
    // A documented maximum the handler disagrees with is worse than none: a
    // client generated from this spec would send exactly the value that 400s.
    const spec = await generateSpecs(mounted());
    const params = (spec.paths?.["/me/inbox"]?.get?.parameters ?? []) as {
      name: string;
      schema?: { maximum?: number; minimum?: number; default?: number };
    }[];
    const limit = params.find((p) => p.name === "limit");
    expect(limit?.schema?.maximum).toBe(MAX_MAILBOX_PAGE_LIMIT);
    expect(limit?.schema?.minimum).toBe(1);
    expect(limit?.schema?.default).toBe(50);

    // And the handler actually refuses one past that advertised maximum.
    const app = mountMailbox(new Hono(), {
      vocabulary: TEST_VOCABULARY,
      db: {} as MailboxDb,
      bus: createInMemoryMailboxEventBus(),
      resolvePrincipal: () => ({ tenantId: "t1", principalId: "p1" }),
    });
    const res = await app.request(
      `/me/inbox?limit=${(limit!.schema!.maximum as number) + 1}`,
    );
    expect(res.status).toBe(400);
  });
});
