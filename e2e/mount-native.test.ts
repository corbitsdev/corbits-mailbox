// The thin route layer over the native store: list (search + keyset),
// read/unread flags, and archive/trash/restore moves.
import { beforeEach, describe, expect, test } from "bun:test";
import { createMailboxRoutes } from "../src/mount.js";
import { createInMemoryMailboxEventBus } from "../src/bus.js";
import { writeMailboxMessage } from "../src/write.js";
import { allowAllGrants, mountAs, withTestDb, seedScope } from "./helpers.js";
import type { MailboxDb } from "../src/db.js";

let db: MailboxDb;
const SCOPE = { tenantId: "t1", principalId: "p1" };

beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, SCOPE.tenantId, SCOPE.principalId);
});

function buildApp() {
  const app = mountAs(
    SCOPE,
    createMailboxRoutes({
      db,
      requireGrant: allowAllGrants,
      bus: createInMemoryMailboxEventBus(),
      senderAddressFor: () => "p1@t1.example",
      deliver: () => {},
    }),
  );
  return app;
}

async function seedMessage(subject: string) {
  const written = await writeMailboxMessage(db, {
    ...SCOPE,
    address: "p1@t1.example",
    fromAddress: "a@t1.example",
    subject,
    body: "Body",
  });
  return written!.uid;
}

describe("GET /me/inbox", () => {
  test("lists newest first with envelope and raw", async () => {
    await seedMessage("First");
    await seedMessage("Second");
    const app = buildApp();
    const res = await app.request("/me/inbox");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: { uid: number; envelope: { subject: string }; raw: string }[];
    };
    expect(body.messages.map((m) => m.envelope.subject)).toEqual([
      "Second",
      "First",
    ]);
    expect(body.messages[0]!.raw.length).toBeGreaterThan(0);
  });

  test("keyset-paginates by uid", async () => {
    for (let i = 0; i < 3; i++) await seedMessage(`Msg ${i}`);
    const app = buildApp();
    const page1 = await app.request("/me/inbox?limit=2");
    const body1 = (await page1.json()) as {
      messages: { uid: number }[];
      nextCursor?: string;
    };
    expect(body1.messages).toHaveLength(2);
    expect(body1.nextCursor).toBeDefined();

    const page2 = await app.request(`/me/inbox?limit=2&cursor=${body1.nextCursor}`);
    const body2 = (await page2.json()) as { messages: { uid: number }[] };
    expect(body2.messages).toHaveLength(1);
    expect(body2.messages[0]!.uid).toBeLessThan(body1.messages[1]!.uid);
  });

  test("invalid folder is a 400", async () => {
    const app = buildApp();
    const res = await app.request("/me/inbox?folder=bogus");
    expect(res.status).toBe(400);
  });
});

describe("read/unread", () => {
  test("read sets \\Seen, unread clears it", async () => {
    const uid = await seedMessage("Hi");
    const app = buildApp();
    const readRes = await app.request(`/me/inbox/${uid}/read`, { method: "POST" });
    expect(readRes.status).toBe(200);

    const list = await (await app.request("/me/inbox")).json() as {
      messages: { uid: number; flags: string[] }[];
    };
    expect(list.messages[0]!.flags).toContain("\\Seen");

    const unreadRes = await app.request(`/me/inbox/${uid}/unread`, {
      method: "POST",
    });
    expect(unreadRes.status).toBe(200);
    const list2 = await (await app.request("/me/inbox")).json() as {
      messages: { uid: number; flags: string[] }[];
    };
    expect(list2.messages[0]!.flags).not.toContain("\\Seen");
  });

  test("unknown uid is a 404", async () => {
    const app = buildApp();
    const res = await app.request("/me/inbox/999/read", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("GET /me/inbox/threads", () => {
  test("groups a reply under its parent via References", async () => {
    const rootId = "<root-1@t1.example>";
    const root = await writeMailboxMessage(db, {
      ...SCOPE,
      address: "p1@t1.example",
      fromAddress: "a@t1.example",
      subject: "Kickoff",
      body: "Body",
      messageId: rootId,
    });
    await writeMailboxMessage(db, {
      ...SCOPE,
      address: "p1@t1.example",
      fromAddress: "b@t1.example",
      subject: "Re: Kickoff",
      body: "Reply",
      inReplyTo: rootId,
      references: [rootId],
    });

    const app = buildApp();
    const res = await app.request("/me/inbox/threads");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      threads: {
        uid: number;
        envelope: { subject: string };
        children: { uid: number; envelope: { subject: string } }[];
      }[];
    };
    expect(body.threads).toHaveLength(1);
    const [thread] = body.threads;
    expect(thread!.uid).toBe(root!.uid);
    expect(thread!.envelope.subject).toBe("Kickoff");
    expect(thread!.children).toHaveLength(1);
    expect(thread!.children[0]!.envelope.subject).toBe("Re: Kickoff");
  });

  test("invalid folder is a 400", async () => {
    const app = buildApp();
    const res = await app.request("/me/inbox/threads?folder=bogus");
    expect(res.status).toBe(400);
  });
});

describe("GET /me/inbox/threads/:rootUid", () => {
  test("returns the single thread rooted at that uid", async () => {
    const uid = await seedMessage("Solo");
    const app = buildApp();
    const res = await app.request(`/me/inbox/threads/${uid}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      thread: { uid: number; envelope: { subject: string }; children: unknown[] };
    };
    expect(body.thread.uid).toBe(uid);
    expect(body.thread.envelope.subject).toBe("Solo");
    expect(body.thread.children).toHaveLength(0);
  });

  test("unknown rootUid is a 404", async () => {
    const app = buildApp();
    const res = await app.request("/me/inbox/threads/999");
    expect(res.status).toBe(404);
  });
});

describe("archive/trash/restore", () => {
  test("archive moves the message out of INBOX and into Archive", async () => {
    const uid = await seedMessage("To archive");
    const app = buildApp();
    const res = await app.request(`/me/inbox/${uid}/archive`, {
      method: "POST",
    });
    expect(res.status).toBe(200);

    const inbox = await (await app.request("/me/inbox")).json() as {
      messages: unknown[];
    };
    expect(inbox.messages).toHaveLength(0);
    const archive = await (
      await app.request("/me/inbox?folder=Archive")
    ).json() as { messages: unknown[] };
    expect(archive.messages).toHaveLength(1);
  });

  test("restore moves a message back into INBOX from Archive", async () => {
    const uid = await seedMessage("Round trip");
    const app = buildApp();
    await app.request(`/me/inbox/${uid}/archive`, { method: "POST" });
    const archived = await (
      await app.request("/me/inbox?folder=Archive")
    ).json() as { messages: { uid: number }[] };
    const archivedUid = archived.messages[0]!.uid;

    const restoreRes = await app.request(
      `/me/inbox/${archivedUid}/restore?folder=Archive`,
      { method: "POST" },
    );
    expect(restoreRes.status).toBe(200);
    const inbox = await (await app.request("/me/inbox")).json() as {
      messages: unknown[];
    };
    expect(inbox.messages).toHaveLength(1);
  });

  test("trash on an unknown uid is a 404", async () => {
    const app = buildApp();
    const res = await app.request("/me/inbox/999/trash", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
