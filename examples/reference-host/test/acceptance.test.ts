// Acceptance: every scenario runs against a real @intx/hub-api app with
// @corbits/mailbox mounted on it and a real Postgres behind it. Nothing is
// stubbed except the hub's session lookup.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  deliverInboxItems,
  writeMailboxMessage,
  mailboxKey,
  principalMail,
} from "@corbits/mailbox";
import {
  createReferenceHost,
  DATABASE_URL,
  type ReferenceHost,
} from "../src/index.js";

let host: ReferenceHost;
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

// Resetting state for re-runnable scenarios is THIS harness's job, not the
// host's: a real host never truncates on boot. The mailbox FKs point at the
// host's `tenant`/`principal` tables, so the control plane is stood up (and
// every scope the scenarios use is registered) before the host boots and runs
// the mailbox migrations.
const setupClient = postgres(DATABASE_URL, { onnotice: () => {} });

beforeAll(async () => {
  const setup = drizzle(setupClient);
  await setup.execute(sql`
    CREATE TABLE IF NOT EXISTS "tenant" ("id" text PRIMARY KEY)
  `);
  await setup.execute(sql`
    CREATE TABLE IF NOT EXISTS "principal" (
      "id" text PRIMARY KEY,
      "tenant_id" text NOT NULL REFERENCES "tenant" ("id") ON DELETE CASCADE
    )
  `);

  host = await createReferenceHost();

  // Empty mailbox and a fresh control plane, whatever an earlier run left.
  await host.db.execute(
    sql`TRUNCATE TABLE "mailbox"."principal_mail", "mailbox"."mailbox"`,
  );
  await host.db.execute(sql`TRUNCATE TABLE "tenant", "principal" CASCADE`);
  await host.db.execute(
    sql`INSERT INTO "tenant" ("id") VALUES ('acme') ON CONFLICT DO NOTHING`,
  );
  for (const principalId of ["user-1", "user-2"]) {
    await host.db.execute(
      sql`INSERT INTO "principal" ("id", "tenant_id")
          VALUES (${principalId}, 'acme') ON CONFLICT DO NOTHING`,
    );
  }
});

afterAll(async () => {
  await setupClient.end();
});

const inboundItem = (over: Record<string, string>) => ({
  tenantId: "acme",
  principalId: "user-1",
  address: "user-1@acme.example",
  fromAddress: "sales@partner.example",
  subject: "Welcome aboard",
  body: "Thanks for signing up!",
  source: "gmail",
  externalId: "msg-100",
  ...over,
});

describe("reference host", () => {
  test("is a live @intx/hub-api app", async () => {
    expect((await host.request("/status")).status).toBe(200);
  });

  let messageId: string;

  test("deliver -> list -> read back", async () => {
    const [delivered] = await deliverInboxItems(host.db, [inboundItem({})]);
    expect(delivered?.id).not.toBeNull();
    messageId = delivered!.id!;

    const list = await json<{ messages: { id: string; subject?: string }[] }>(
      await host.request("/api/me/inbox"),
    );
    expect(list.messages).toContainEqual(
      expect.objectContaining({ id: messageId, subject: "Welcome aboard" }),
    );

    const detailRes = await host.request(`/api/me/inbox/${messageId}`);
    expect(detailRes.status).toBe(200);
    const detail = await json<{ body: string; to: string[] }>(detailRes);
    expect(detail.body).toContain("Thanks for signing up");
    expect(detail.to).toEqual(["user-1@acme.example"]);
  });

  test("re-delivering the same external item is deduped", async () => {
    const [redelivered] = await deliverInboxItems(host.db, [inboundItem({})]);
    expect(redelivered?.id).toBeNull();
    expect(redelivered?.messageKey).toBe(mailboxKey.inbox("gmail", "msg-100"));

    const list = await json<{ messages: unknown[] }>(
      await host.request("/api/me/inbox"),
    );
    expect(list.messages).toHaveLength(1);
  });

  let enrichedId: string;

  test("enrichment columns are stored and projected on read", async () => {
    const written = await writeMailboxMessage(host.db, {
      tenantId: "acme",
      principalId: "user-1",
      address: "user-1@acme.example",
      fromAddress: "triage@acme.example",
      subject: "Needs your attention",
      body: "Please review this deal.",
      messageKey: mailboxKey.run("deal-1"),
      priority: "high",
      classification: "deal-risk",
      status: "needs-action",
    });
    enrichedId = written!.id;

    const list = await json<{ messages: { id: string }[] }>(
      await host.request("/api/me/inbox"),
    );
    expect(list.messages).toContainEqual(
      expect.objectContaining({
        id: enrichedId,
        priority: "high",
        classification: "deal-risk",
        status: "needs-action",
      }),
    );
  });

  test("gate: and run: keys for the same id are distinct messages", async () => {
    const gate = await writeMailboxMessage(host.db, {
      tenantId: "acme",
      principalId: "user-1",
      address: "user-1@acme.example",
      fromAddress: "triage@acme.example",
      subject: "Approval needed",
      body: "Approve?",
      messageKey: mailboxKey.gate("deal-1"),
    });
    // `run:deal-1` was already written above; the gate namespace does not
    // collide with it.
    expect(gate?.id).toBeDefined();
    expect(gate!.id).not.toBe(enrichedId);
  });

  test("cross-principalId isolation", async () => {
    await deliverInboxItems(host.db, [
      inboundItem({
        principalId: "user-2",
        address: "user-2@acme.example",
        subject: "For user 2 only",
        externalId: "msg-200",
      }),
    ]);

    host.setSession({ tenantId: "acme", principalId: "user-2" });
    const user2 = await json<{ messages: { subject?: string }[] }>(
      await host.request("/api/me/inbox"),
    );
    expect(user2.messages).toHaveLength(1);
    expect(user2.messages[0]?.subject).toBe("For user 2 only");

    host.setSession({ tenantId: "acme", principalId: "user-1" });
    const user1 = await json<{ messages: { subject?: string }[] }>(
      await host.request("/api/me/inbox"),
    );
    expect(user1.messages.map((m) => m.subject)).not.toContain(
      "For user 2 only",
    );
  });

  test("cursors are view-scoped and validated", async () => {
    const page1 = await json<{ nextCursor?: string }>(
      await host.request("/api/me/inbox?limit=1"),
    );
    expect(page1.nextCursor).toBeDefined();

    const crossView = await host.request(
      `/api/me/inbox?view=unread&cursor=${page1.nextCursor}`,
    );
    expect(crossView.status).toBe(400);

    const malformed = await host.request(
      "/api/me/inbox?cursor=not-a-real-cursor",
    );
    expect(malformed.status).toBe(400);
  });

  test("multi-recipient fan-out writes one row per recipient", async () => {
    const base = {
      address: "broadcast@acme.example",
      fromAddress: "ops@acme.example",
      subject: "All-hands broadcast",
      body: "Body",
      source: "broadcast",
      externalId: "bcast-1",
    };
    const fanOut = await deliverInboxItems(host.db, [
      { ...base, tenantId: "acme", principalId: "user-1" },
      { ...base, tenantId: "acme", principalId: "user-2" },
    ]);
    expect(fanOut.every((r) => r.id !== null)).toBe(true);
    expect(fanOut[0]!.id).not.toBe(fanOut[1]!.id);
  });

  test("trash wins over archive", async () => {
    await host.request(`/api/me/inbox/${enrichedId}/archive`, {
      method: "POST",
    });
    const trashed = await host.request(`/api/me/inbox/${enrichedId}/trash`, {
      method: "POST",
    });
    expect(trashed.status).toBe(200);

    const archivedView = await json<{ messages: { id: string }[] }>(
      await host.request("/api/me/inbox?view=archived"),
    );
    expect(archivedView.messages.map((m) => m.id)).not.toContain(enrichedId);

    const reArchive = await host.request(
      `/api/me/inbox/${enrichedId}/archive`,
      {
        method: "POST",
      },
    );
    expect(reArchive.status).toBe(404);
  });

  // The scenario chain is write -> list -> read -> mark-read -> SSE. The first
  // three legs are covered above; these two cover the rest.
  test("mark-read over the mounted host flips read and the unread count", async () => {
    const before = await json<{ unread: number }>(
      await host.request("/api/me/inbox/unread-count"),
    );
    expect(before.unread).toBeGreaterThan(0);

    const marked = await host.request(`/api/me/inbox/${messageId}/read`, {
      method: "POST",
    });
    expect(marked.status).toBe(200);
    expect(await json<unknown>(marked)).toEqual({ id: messageId, ok: true });

    const detail = await json<{ read: boolean }>(
      await host.request(`/api/me/inbox/${messageId}`),
    );
    expect(detail.read).toBe(true);

    const after = await json<{ unread: number }>(
      await host.request("/api/me/inbox/unread-count"),
    );
    expect(after.unread).toBe(before.unread - 1);

    // Idempotent: re-marking is still a 200 and does not double-count.
    expect(
      (
        await host.request(`/api/me/inbox/${messageId}/read`, {
          method: "POST",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await json<{ unread: number }>(
          await host.request("/api/me/inbox/unread-count"),
        )
      ).unread,
    ).toBe(after.unread);
  });

  test("a bulk action applies over the mounted host, with per-id results", async () => {
    const [first] = await deliverInboxItems(host.db, [
      inboundItem({ externalId: "bulk-1", subject: "Bulk one" }),
    ]);
    const [second] = await deliverInboxItems(host.db, [
      inboundItem({ externalId: "bulk-2", subject: "Bulk two" }),
    ]);
    const stranger = crypto.randomUUID();

    const res = await host.request("/api/me/inbox/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "mark_read",
        ids: [first!.id, second!.id, stranger],
      }),
    });
    expect(res.status).toBe(200);
    // Partial success: the two real ids apply, the unknown one reports false
    // rather than failing the batch.
    expect(await json<unknown>(res)).toEqual({
      updated: 2,
      results: [
        { id: first!.id, ok: true },
        { id: second!.id, ok: true },
        { id: stranger, ok: false },
      ],
    });

    const detail = await json<{ read: boolean }>(
      await host.request(`/api/me/inbox/${first!.id}`),
    );
    expect(detail.read).toBe(true);
  });

  test("an SSE event arrives over the mounted host for a new message", async () => {
    const res = await host.request("/api/me/inbox/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    // Let the handler register its subscription before anything publishes.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const written = await writeMailboxMessage(
      host.db,
      {
        tenantId: "acme",
        principalId: "user-1",
        address: "user-1@acme.example",
        fromAddress: "ops@acme.example",
        subject: "Live",
        body: "Body",
        messageKey: "sse-1",
      },
      host.bus,
    );

    let text = "";
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !text.includes("event: mailbox")) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined }>((resolve) =>
          setTimeout(() => resolve({ value: undefined }), 250),
        ),
      ]);
      if (chunk.value !== undefined) text += decoder.decode(chunk.value);
    }
    await reader.cancel();

    expect(text).toContain("event: mailbox");
    // The id in the frame is the row that was just written, not merely "some"
    // event — a stream echoing the wrong id would pass a substring check.
    expect(text).toContain(
      JSON.stringify({ type: "mailbox", id: written!.id }),
    );
  });

  test("SSE is scoped: another principalId's message never reaches this stream", async () => {
    const res = await host.request("/api/me/inbox/events");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    await new Promise((resolve) => setTimeout(resolve, 50));

    await writeMailboxMessage(
      host.db,
      {
        tenantId: "acme",
        principalId: "user-2",
        address: "user-2@acme.example",
        fromAddress: "ops@acme.example",
        subject: "Not for user-1",
        body: "Body",
        messageKey: "sse-2",
      },
      host.bus,
    );

    let text = "";
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined }>((resolve) =>
          setTimeout(() => resolve({ value: undefined }), 250),
        ),
      ]);
      if (chunk.value !== undefined) text += decoder.decode(chunk.value);
    }
    await reader.cancel();

    expect(text).not.toContain("event: mailbox");
  });

  test("triage enriches a delivered item over the mounted host", async () => {
    const [delivered] = await deliverInboxItems(host.db, [
      inboundItem({ externalId: "triage-1", subject: "Needs triage" }),
    ]);

    const res = await host.request(`/api/me/inbox/${delivered!.id}/enrich`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        priority: "urgent",
        classification: "deal-risk",
        status: "needs-action",
      }),
    });
    expect(res.status).toBe(200);

    const detail = await json<{
      priority?: string;
      classification?: string;
      status?: string;
    }>(await host.request(`/api/me/inbox/${delivered!.id}`));
    expect(detail).toMatchObject({
      priority: "urgent",
      classification: "deal-risk",
      status: "needs-action",
    });
  });

  test("bulk beyond the 50-id cap is a 400", async () => {
    const ids = Array.from({ length: 51 }, () => crypto.randomUUID());
    const res = await host.request("/api/me/inbox/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "mark_read", ids }),
    });
    expect(res.status).toBe(400);
  });

  test("a malformed stored frame degrades to 200, not 500", async () => {
    const written = await writeMailboxMessage(host.db, {
      tenantId: "acme",
      principalId: "user-1",
      address: "user-1@acme.example",
      fromAddress: "a@acme.example",
      subject: "will be corrupted",
      body: "Body",
      messageKey: "corrupt-1",
    });
    await host.db.execute(
      sql`UPDATE "mailbox"."principal_mail" SET "raw" = '\\xdeadbeef'::bytea WHERE "id" = ${written!.id}`,
    );
    const res = await host.request(`/api/me/inbox/${written!.id}`);
    expect(res.status).toBe(200);
  });

  test("a multipart/alternative frame reads back as its text, not MIME soup", async () => {
    // What externally delivered mail actually looks like. Detail body and
    // snippet must both be the readable text/plain part (list never decodes).
    const written = await writeMailboxMessage(host.db, {
      tenantId: "acme",
      principalId: "user-1",
      address: "user-1@acme.example",
      fromAddress: "a@acme.example",
      subject: "multipart",
      body: "placeholder",
      messageKey: "multipart-1",
    });
    const raw = Buffer.from(
      [
        "From: a@acme.example",
        "To: user-1@acme.example",
        "Subject: multipart",
        'Content-Type: multipart/alternative; boundary="BOUND"',
        "",
        "--BOUND",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Hello human, this is the readable text.",
        "--BOUND",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>Hello human</p>",
        "--BOUND--",
        "",
      ].join("\r\n"),
    );
    await host.db
      .update(principalMail)
      .set({ raw })
      .where(eq(principalMail.id, written!.id));

    const detail = await json<{ body: string; snippet?: string }>(
      await host.request(`/api/me/inbox/${written!.id}`),
    );
    expect(detail.body).toBe("Hello human, this is the readable text.");
    expect(detail.snippet).toBe("Hello human, this is the readable text.");
    expect(detail.body).not.toContain("--BOUND");
    expect(detail.body).not.toContain("<p>");
  });

  test("triage enrichment is queryable: filter by priority, sort by priority", async () => {
    const [urgent] = await deliverInboxItems(host.db, [
      inboundItem({ externalId: "triage-urgent", subject: "urgent thing" }),
    ]);
    const [low] = await deliverInboxItems(host.db, [
      inboundItem({ externalId: "triage-low", subject: "low thing" }),
    ]);
    for (const [id, priority] of [
      [urgent!.id!, "urgent"],
      [low!.id!, "low"],
    ] as const) {
      const res = await host.request(`/api/me/inbox/${id}/enrich`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ priority, classification: "triaged" }),
      });
      expect(res.status).toBe(200);
    }

    const filtered = await json<{ messages: { id: string }[] }>(
      await host.request(
        "/api/me/inbox?priority=urgent&classification=triaged",
      ),
    );
    expect(filtered.messages.map((m) => m.id)).toEqual([urgent!.id!]);

    const sorted = await json<{ messages: { id: string }[] }>(
      await host.request("/api/me/inbox?classification=triaged&sort=priority"),
    );
    expect(sorted.messages.map((m) => m.id)).toEqual([urgent!.id!, low!.id!]);
  });

  test("delegation: assign stamps an assignee the list can filter on", async () => {
    const [item] = await deliverInboxItems(host.db, [
      inboundItem({ externalId: "delegate-1", subject: "delegate me" }),
    ]);
    const assigned = await host.request(`/api/me/inbox/${item!.id!}/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignee: "user-2" }),
    });
    expect(assigned.status).toBe(200);

    const listed = await json<{
      messages: { id: string; assignee?: string }[];
    }>(await host.request("/api/me/inbox?assignee=user-2"));
    expect(listed.messages.map((m) => m.id)).toEqual([item!.id!]);
    expect(listed.messages[0]?.assignee).toBe("user-2");
  });

  test("signed out: the host's own /api/me/* auth gate answers first", async () => {
    // Mounting under `/api` puts the mailbox behind Interchange's
    // `app.use("/api/me/*", requireAuth)`. An unauthenticated request never
    // reaches the core, so the host answers 401 rather than the core answering
    // "no principal" (empty list on reads, 403 on the SSE stream). That
    // core-level asymmetry is covered by the core's own suite; what this host
    // proves is that the hub gate composes in front of it.
    host.setSession(null);
    expect((await host.request("/api/me/inbox")).status).toBe(401);
    expect((await host.request("/api/me/inbox/events")).status).toBe(401);
    host.setSession({ tenantId: "acme", principalId: "user-1" });
  });
});
