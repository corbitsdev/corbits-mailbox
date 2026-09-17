// Acceptance: every scenario runs against a real @intx/hub-api app with
// @corbits/mailbox mounted on it and a real Postgres behind it. Nothing is
// stubbed except the hub's session lookup.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { deliverInboxItems, writeMailboxMessage } from "@corbits/mailbox";
import {
  createReferenceHost,
  DATABASE_URL,
  type ReferenceHost,
} from "../src/index.js";

let host: ReferenceHost;
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

type MailboxListItem = {
  uid: number;
  flags: string[];
  envelope: { subject: string; from: string };
  raw: string;
};

const decodeRaw = (item: MailboxListItem): string =>
  Buffer.from(item.raw, "base64").toString("utf8");

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
    sql`TRUNCATE TABLE "mailbox"."principal_mail", "mailbox"."mailbox_state"`,
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

  test("deliver -> list -> read back the raw frame", async () => {
    const [delivered] = await deliverInboxItems(host.db, [inboundItem({})]);
    expect(delivered?.id).not.toBeNull();

    const list = await json<{ messages: MailboxListItem[] }>(
      await host.request("/api/me/inbox"),
    );
    const item = list.messages.find(
      (m) => m.envelope.subject === "Welcome aboard",
    );
    expect(item).toBeDefined();
    expect(decodeRaw(item!)).toContain("Thanks for signing up");
    expect(item!.envelope.from).toBe("sales@partner.example");
  });

  test("re-delivering the same external item is deduped", async () => {
    const [redelivered] = await deliverInboxItems(host.db, [inboundItem({})]);
    expect(redelivered?.id).toBeNull();

    const list = await json<{ messages: MailboxListItem[] }>(
      await host.request("/api/me/inbox"),
    );
    expect(
      list.messages.filter((m) => m.envelope.subject === "Welcome aboard"),
    ).toHaveLength(1);
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
    const user2 = await json<{ messages: MailboxListItem[] }>(
      await host.request("/api/me/inbox"),
    );
    expect(
      user2.messages.some((m) => m.envelope.subject === "For user 2 only"),
    ).toBe(true);

    host.setSession({ tenantId: "acme", principalId: "user-1" });
    const user1 = await json<{ messages: MailboxListItem[] }>(
      await host.request("/api/me/inbox"),
    );
    expect(
      user1.messages.some((m) => m.envelope.subject === "For user 2 only"),
    ).toBe(false);
  });

  test("cursors keyset-paginate and reject a malformed cursor", async () => {
    for (let i = 0; i < 3; i++) {
      await writeMailboxMessage(host.db, {
        tenantId: "acme",
        principalId: "user-1",
        address: "user-1@acme.example",
        fromAddress: "ops@acme.example",
        subject: `Page seed ${i}`,
        body: "Body",
      });
    }
    const page1 = await json<{ messages: MailboxListItem[]; nextCursor?: string }>(
      await host.request("/api/me/inbox?limit=1"),
    );
    expect(page1.nextCursor).toBeDefined();

    const page2 = await json<{ messages: MailboxListItem[] }>(
      await host.request(`/api/me/inbox?limit=1&cursor=${page1.nextCursor}`),
    );
    expect(page2.messages[0]?.uid).toBeLessThan(page1.messages[0]!.uid);

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

  test("mark-read over the mounted host flips the \\Seen flag", async () => {
    const written = await writeMailboxMessage(host.db, {
      tenantId: "acme",
      principalId: "user-1",
      address: "user-1@acme.example",
      fromAddress: "ops@acme.example",
      subject: "To be read",
      body: "Body",
    });

    const marked = await host.request(`/api/me/inbox/${written!.uid}/read`, {
      method: "POST",
    });
    expect(marked.status).toBe(200);
    expect(await json<unknown>(marked)).toEqual({ uid: written!.uid, ok: true });

    const list = await json<{ messages: MailboxListItem[] }>(
      await host.request("/api/me/inbox"),
    );
    const item = list.messages.find((m) => m.uid === written!.uid);
    expect(item?.flags).toContain("\\Seen");

    // Idempotent: re-marking is still a 200.
    expect(
      (
        await host.request(`/api/me/inbox/${written!.uid}/read`, {
          method: "POST",
        })
      ).status,
    ).toBe(200);
  });

  test("archive moves a message out of INBOX; a second move 404s", async () => {
    const written = await writeMailboxMessage(host.db, {
      tenantId: "acme",
      principalId: "user-1",
      address: "user-1@acme.example",
      fromAddress: "ops@acme.example",
      subject: "To archive",
      body: "Body",
    });

    const archived = await host.request(
      `/api/me/inbox/${written!.uid}/archive`,
      { method: "POST" },
    );
    expect(archived.status).toBe(200);

    const inboxView = await json<{ messages: MailboxListItem[] }>(
      await host.request("/api/me/inbox"),
    );
    expect(inboxView.messages.some((m) => m.uid === written!.uid)).toBe(
      false,
    );
    const archiveView = await json<{ messages: MailboxListItem[] }>(
      await host.request("/api/me/inbox?folder=Archive"),
    );
    expect(
      archiveView.messages.some((m) => m.envelope.subject === "To archive"),
    ).toBe(true);

    // The original uid no longer names anything in INBOX: archive/trash only
    // ever move a message OUT of INBOX, so a second move 404s.
    const reArchive = await host.request(
      `/api/me/inbox/${written!.uid}/archive`,
      { method: "POST" },
    );
    expect(reArchive.status).toBe(404);
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
    // `op` names the operation that produced it — a new message is a `create`.
    expect(text).toContain(
      JSON.stringify({ type: "mailbox", id: written!.id, op: "create" }),
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
