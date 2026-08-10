// Mail is the single work surface, so triage *enriches* an existing mail row
// rather than spawning a task. Without an enrichment path,
// priority/classification/status could only be set at the initial insert and
// triage would have no way to stamp anything.
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { type } from "arktype";
import { eq } from "drizzle-orm";
import {
  enrichMailboxMessage,
  MailboxEnrichmentSchema,
} from "./mutations.js";
import { mountMailbox } from "./mount.js";
import { createInMemoryMailboxEventBus } from "./bus.js";
import { deliverInboxItems, writeMailboxMessage } from "./write.js";
import { mailbox, principalMail } from "./schema.js";
import { getMailboxMessage } from "./read.js";
import { withTestDb, seedScope, TEST_VOCABULARY } from "./test-helpers.js";
import type { MailboxDb } from "./db.js";

let db: MailboxDb;
const SCOPE = { tenantId: "acme", principalId: "user-1" };

beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, "acme", "user-1", "user-2");
  await seedScope(db, "other", "user-1");
});

async function seed(
  over: Partial<Parameters<typeof writeMailboxMessage>[1]> = {},
): Promise<string> {
  const written = await writeMailboxMessage(db, {
    ...SCOPE,
    address: "user-1@acme.example",
    fromAddress: "bot@acme.example",
    subject: "Untriaged",
    body: "Body",
    messageKey: crypto.randomUUID(),
    ...over,
  });
  return written!.id;
}

/**
 * The message's triage state as the read path sees it: through the LEFT JOIN,
 * so the assertions below observe exactly what a reader would.
 */
async function storedRow(id: string) {
  const [row] = await db
    .select({
      priority: mailbox.priority,
      classification: mailbox.classification,
      status: mailbox.status,
    })
    .from(principalMail)
    .leftJoin(mailbox, eq(mailbox.id, principalMail.id))
    .where(eq(principalMail.id, id));
  return row!;
}

/** Whether a `mailbox` row exists at all — eager creation, observed directly. */
async function hasMailboxRow(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: mailbox.id })
    .from(mailbox)
    .where(eq(mailbox.id, id));
  return rows.length > 0;
}

describe("enrichMailboxMessage", () => {
  test("updates the management row delivery created eagerly", async () => {
    const id = await seed();
    expect(await hasMailboxRow(id)).toBe(true);
    expect(
      await enrichMailboxMessage(db, { ...SCOPE, id }, { status: "done" }),
    ).toBe(true);
    expect((await storedRow(id)).status).toBe("done");
  });

  test("stamps all three fields onto an untriaged row", async () => {
    const id = await seed();
    expect(
      await enrichMailboxMessage(
        db,
        { ...SCOPE, id },
        { priority: "urgent", classification: "deal-risk", status: "done" },
      ),
    ).toBe(true);

    const row = await storedRow(id);
    expect(row.priority).toBe("urgent");
    expect(row.classification).toBe("deal-risk");
    expect(row.status).toBe("done");
  });

  test("an omitted field is left alone, not wiped", async () => {
    const id = await seed({
      priority: "high",
      classification: "deal-risk",
      status: "needs-action",
    });
    await enrichMailboxMessage(db, { ...SCOPE, id }, { status: "done" });

    const row = await storedRow(id);
    expect(row.status).toBe("done");
    // The point of the whole partial-update design: re-triaging one facet must
    // not silently discard the other two.
    expect(row.priority).toBe("high");
    expect(row.classification).toBe("deal-risk");
  });

  test("an explicit null clears the field", async () => {
    const id = await seed({ priority: "high", classification: "deal-risk" });
    await enrichMailboxMessage(db, { ...SCOPE, id }, { priority: null });

    const row = await storedRow(id);
    expect(row.priority).toBeNull();
    expect(row.classification).toBe("deal-risk");
  });

  test("refuses an enrichment that sets nothing", async () => {
    const id = await seed();
    expect(enrichMailboxMessage(db, { ...SCOPE, id }, {})).rejects.toThrow(
      RangeError,
    );
  });

  test("is scoped to the principalId: another principalId's row is untouched", async () => {
    const id = await seed();
    expect(
      await enrichMailboxMessage(
        db,
        { tenantId: "acme", principalId: "user-2", id },
        { priority: "urgent" },
      ),
    ).toBe(false);
    expect((await storedRow(id)).priority).toBeNull();
  });

  test("is scoped to the tenantId: another tenantId's row is untouched", async () => {
    const id = await seed();
    expect(
      await enrichMailboxMessage(
        db,
        { tenantId: "other", principalId: "user-1", id },
        { priority: "urgent" },
      ),
    ).toBe(false);
    expect((await storedRow(id)).priority).toBeNull();
  });

  test("returns false for an id that does not exist", async () => {
    expect(
      await enrichMailboxMessage(
        db,
        { ...SCOPE, id: crypto.randomUUID() },
        { status: "done" },
      ),
    ).toBe(false);
  });

  test("the stamped values are projected on read", async () => {
    const id = await seed();
    await enrichMailboxMessage(
      db,
      { ...SCOPE, id },
      { priority: "low", classification: "fyi", status: "needs-action" },
    );
    const detail = await getMailboxMessage(db, { ...SCOPE, id });
    expect(detail?.priority).toBe("low");
    expect(detail?.classification).toBe("fyi");
    expect(detail?.status).toBe("needs-action");
  });
});

describe("MailboxEnrichmentSchema", () => {
  test("accepts any string priority or status, carrying no vocabulary itself", () => {
    for (const priority of ["urgent", "p0", "catastrophic", "whatever"]) {
      expect(MailboxEnrichmentSchema({ priority }) instanceof type.errors).toBe(
        false,
      );
    }
    for (const status of ["needs-action", "in-progress", "wontfix"]) {
      expect(MailboxEnrichmentSchema({ status }) instanceof type.errors).toBe(
        false,
      );
    }
  });

  test("still rejects a non-string, non-null priority or status", () => {
    expect(
      MailboxEnrichmentSchema({ priority: 3 }) instanceof type.errors,
    ).toBe(true);
    expect(
      MailboxEnrichmentSchema({ status: ["done"] }) instanceof type.errors,
    ).toBe(true);
  });

  test("accepts an explicit null, which is how a field is cleared", () => {
    expect(
      MailboxEnrichmentSchema({ priority: null, status: null }) instanceof
        type.errors,
    ).toBe(false);
  });
});

describe("deliverInboxItems stamping", () => {
  test("an adapter's triage verdict is stored at delivery", async () => {
    const [delivered] = await deliverInboxItems(db, [
      {
        ...SCOPE,
        address: "user-1@acme.example",
        fromAddress: "sales@partner.example",
        subject: "Renewal at risk",
        body: "Body",
        source: "gmail",
        externalId: "msg-1",
        priority: "urgent",
        classification: "deal-risk",
        status: "needs-action",
      },
    ]);

    const row = await storedRow(delivered!.id!);
    expect(row.priority).toBe("urgent");
    expect(row.classification).toBe("deal-risk");
    expect(row.status).toBe("needs-action");
  });

  test("an item with no verdict delivers unstamped", async () => {
    const [delivered] = await deliverInboxItems(db, [
      {
        ...SCOPE,
        address: "user-1@acme.example",
        fromAddress: "sales@partner.example",
        subject: "Just mail",
        body: "Body",
        source: "gmail",
        externalId: "msg-2",
      },
    ]);

    const row = await storedRow(delivered!.id!);
    expect(row.priority).toBeNull();
    expect(row.classification).toBeNull();
    expect(row.status).toBeNull();
    // The management row is created with the message either way; unstamped
    // means all-NULL triage columns, not an absent row.
    expect(await hasMailboxRow(delivered!.id!)).toBe(true);
  });
});

describe("POST /me/inbox/:id/enrich", () => {
  function app(resolvePrincipal: () => typeof SCOPE | null = () => SCOPE) {
    const hono = new Hono();
    mountMailbox(hono, {
      vocabulary: TEST_VOCABULARY,
      db,
      bus: createInMemoryMailboxEventBus(),
      resolvePrincipal,
    });
    return hono;
  }

  const post = (hono: Hono, id: string, body: unknown) =>
    hono.request(`/me/inbox/${id}/enrich`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("applies the enrichment and reports the id", async () => {
    const id = await seed();
    const res = await post(app(), id, { priority: "high", status: "done" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, ok: true });

    const row = await storedRow(id);
    expect(row.priority).toBe("high");
    expect(row.status).toBe("done");
  });

  test("publishes a mailbox event for the enriched row", async () => {
    const id = await seed();
    const bus = createInMemoryMailboxEventBus();
    const seen: string[] = [];
    bus.subscribe(SCOPE, (event) => seen.push(event.id));

    const hono = new Hono();
    mountMailbox(hono, {
      db,
      bus,
      resolvePrincipal: () => SCOPE,
      vocabulary: TEST_VOCABULARY,
    });
    await post(hono, id, { status: "done" });

    expect(seen).toEqual([id]);
  });

  test("403 with no resolvable principalId, and nothing is written", async () => {
    const id = await seed();
    const res = await post(
      app(() => null),
      id,
      { priority: "high" },
    );
    expect(res.status).toBe(403);
    expect((await storedRow(id)).priority).toBeNull();
  });

  test("404 when the message belongs to another principalId", async () => {
    const id = await seed();
    const other = app(() => ({ tenantId: "acme", principalId: "user-2" }));
    expect((await post(other, id, { priority: "high" })).status).toBe(404);
  });

  test("400 on a non-UUID id", async () => {
    expect((await post(app(), "not-a-uuid", { status: "done" })).status).toBe(
      400,
    );
  });

  test("400 on a priority outside the host's vocabulary", async () => {
    const id = await seed();
    const res = await post(app(), id, { priority: "catastrophic" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown priority" });
    // Refused before anything was written: the management row from delivery
    // stays untriaged.
    expect((await storedRow(id)).priority).toBeNull();
  });

  test("400 on a status outside the host's vocabulary", async () => {
    const id = await seed();
    const res = await post(app(), id, { status: "in-progress" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown status" });
    expect((await storedRow(id)).status).toBeNull();
  });

  test("accepts a value only this host's vocabulary contains", async () => {
    const id = await seed();
    const hono = new Hono();
    mountMailbox(hono, {
      db,
      bus: createInMemoryMailboxEventBus(),
      resolvePrincipal: () => SCOPE,
      vocabulary: { priorities: ["p0", "p1"], statuses: ["open", "shipped"] },
    });
    const res = await post(hono, id, { priority: "p0", status: "shipped" });
    expect(res.status).toBe(200);
    const row = await storedRow(id);
    expect(row.priority).toBe("p0");
    expect(row.status).toBe("shipped");
    // And the vocabulary this suite mounts everywhere else is now the one
    // refused, which is the whole point of the taxonomy being the host's.
    expect((await post(hono, id, { priority: "urgent" })).status).toBe(400);
  });

  test("400 on an enrichment that sets nothing", async () => {
    const id = await seed();
    expect((await post(app(), id, {})).status).toBe(400);
  });

  test("400 on a body that is not JSON", async () => {
    const id = await seed();
    const res = await app().request(`/me/inbox/${id}/enrich`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});
