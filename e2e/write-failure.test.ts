// A write that Postgres refuses must fail the caller, not report a uid for a
// row that never landed. The refusal here is a real trigger on the mail plane.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import {
  createMailboxRoutes,
  type OutgoingMailboxMessage,
} from "../src/mount.js";
import {
  createInMemoryMailboxEventBus,
  type MailboxEvent,
} from "../src/bus.js";
import { openNativeMailboxStore } from "../src/native-store.js";
import { createMailboxPersist } from "../src/persist.js";
import { buildMailFrame } from "../src/frame.js";
import { writeMailboxMessage } from "../src/write.js";
import { allowAllGrants, mountAs, seedScope, withTestDb } from "./helpers.js";
import type { MailboxDb } from "../src/db.js";

const SCOPE = { tenantId: "t1", principalId: "p1" };
let db: MailboxDb;

beforeAll(async () => {
  db = await withTestDb();
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION "mailbox"."test_refuse_boom"() RETURNS trigger AS $$
    BEGIN
      IF NEW."subject" = 'boom' THEN RAISE EXCEPTION 'refused'; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `);
  await db.execute(sql`
    CREATE TRIGGER "test_refuse_boom" BEFORE INSERT ON "mailbox"."principal_mail"
    FOR EACH ROW EXECUTE FUNCTION "mailbox"."test_refuse_boom"()
  `);
});

afterAll(async () => {
  await db.execute(
    sql`DROP TRIGGER IF EXISTS "test_refuse_boom" ON "mailbox"."principal_mail"`,
  );
  await db.execute(sql`DROP FUNCTION IF EXISTS "mailbox"."test_refuse_boom"()`);
});

beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, SCOPE.tenantId, SCOPE.principalId);
});

async function mailRows(folder: string) {
  return db.execute<{ uid: string; subject: string | null }>(
    sql`SELECT "uid", "subject" FROM "mailbox"."principal_mail"
        WHERE "folder" = ${folder} ORDER BY "uid"`,
  );
}

function sendApp(deliveries: OutgoingMailboxMessage[]) {
  return mountAs(
    SCOPE,
    createMailboxRoutes({
      db,
      requireGrant: allowAllGrants,
      bus: createInMemoryMailboxEventBus(),
      senderAddressFor: () => "p1@t1.example",
      deliver: (message) => {
        deliveries.push(message);
      },
    }),
  );
}

function send(app: ReturnType<typeof sendApp>, subject: string) {
  return app.request("/me/inbox/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: ["bob@example.com"], subject, body: "b" }),
  });
}

describe("a refused append", () => {
  test("appendMessage rejects and rolls the store's counters back", async () => {
    const store = await openNativeMailboxStore(db, {
      ...SCOPE,
      folder: "INBOX",
    });
    const envelope = {
      messageId: "<m1@t1.example>",
      from: "a@t1.example",
      to: ["p1@t1.example"],
      subject: "boom",
      date: new Date(),
      inReplyTo: undefined,
      references: [],
      interchangeType: undefined,
      interchangeCorrelationId: undefined,
    };
    await expect(
      store.appendMessage(new Uint8Array([1]), envelope, [], envelope.from),
    ).rejects.toThrow();
    expect(store.uidNext).toBe(1);
    expect(store.highestModSeq).toBe(0);
    expect(store.messages).toHaveLength(0);
  });

  test("send fails and never reaches deliver", async () => {
    const deliveries: OutgoingMailboxMessage[] = [];
    const app = sendApp(deliveries);
    expect((await send(app, "boom")).status).toBe(500);
    expect(deliveries).toHaveLength(0);
    expect(await mailRows("Sent")).toHaveLength(0);

    const ok = await send(app, "fine");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { uid: number }).uid).toBe(1);
  });

  test("writeMailboxMessage rejects and publishes nothing", async () => {
    const bus = createInMemoryMailboxEventBus();
    const events: MailboxEvent[] = [];
    bus.subscribe(SCOPE, (event) => events.push(event));
    await expect(
      writeMailboxMessage(
        db,
        {
          ...SCOPE,
          address: "p1@t1.example",
          fromAddress: "a@t1.example",
          subject: "boom",
          body: "b",
        },
        bus,
      ),
    ).rejects.toThrow();
    expect(events).toHaveLength(0);
    expect(await mailRows("INBOX")).toHaveLength(0);
  });

  test("persist announces no row it did not write", async () => {
    const announced: string[] = [];
    const persist = createMailboxPersist(db, {
      upstream: async () => undefined,
      authorizeSender: () => ({ tenantId: "t1", domain: "t1.example" }),
      onRow: (row) => announced.push(row.id),
    });
    await persist({
      senderAddress: "a@t1.example",
      recipients: ["p1@t1.example"],
      raw: buildMailFrame({
        from: "a@t1.example",
        to: "p1@t1.example",
        subject: "boom",
        body: "b",
        messageId: "<m1@t1.example>",
      }),
    });
    expect(announced).toHaveLength(0);
    expect(await mailRows("INBOX")).toHaveLength(0);
  });
});

describe("NUL in header and envelope fields", () => {
  test("send stores the message with NUL dropped from the subject", async () => {
    const app = sendApp([]);
    const res = await app.request("/me/inbox/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: ["bob@example.com"],
        subject: "hi\u0000",
        body: "b",
      }),
    });
    expect(res.status).toBe(200);
    const store = await openNativeMailboxStore(db, {
      ...SCOPE,
      folder: "Sent",
    });
    expect(store.messages[0]?.envelope.subject).toBe("hi");
  });

  test("writeMailboxMessage stores a NUL subject without it", async () => {
    const written = await writeMailboxMessage(db, {
      ...SCOPE,
      address: "p1@t1.example",
      fromAddress: "a@t1.example",
      subject: "x\u0000y",
      body: "b",
    });
    expect(written?.uid).toBe(1);
    expect((await mailRows("INBOX"))[0]?.subject).toBe("xy");
  });

  test("persist stores a frame whose Subject carries NUL", async () => {
    const persist = createMailboxPersist(db, {
      upstream: async () => undefined,
      authorizeSender: () => ({ tenantId: "t1", domain: "t1.example" }),
    });
    await persist({
      senderAddress: "a@t1.example",
      recipients: ["p1@t1.example"],
      raw: new TextEncoder().encode(
        "From: a@t1.example\r\nSubject: bad\u0000\r\nMessage-ID: <n1@t1.example>\r\n\r\nhi\r\n",
      ),
    });
    expect((await mailRows("INBOX"))[0]?.subject).toBe("bad");
  });
});
