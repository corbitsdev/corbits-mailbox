// The sender-display helper, plus the seam that carries its output into the
// read path. Without it the read path emits the raw `From:` header and nothing
// else, so `ins_dep-heartbeat@acme.example` was
// what a user saw.
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  attachFromDisplay,
  extractSenderMailboxAddress,
  type SenderDisplayResolver,
} from "./read.js";
import { getMailboxMessage, listUserMailbox } from "./read.js";
import { mountMailbox } from "./mount.js";
import { createInMemoryMailboxEventBus } from "./bus.js";
import { writeMailboxMessage } from "./write.js";
import { withTestDb, seedScope, TEST_VOCABULARY } from "./test-helpers.js";
import type { MailboxDb } from "./db.js";

let db: MailboxDb;
const SCOPE = { tenantId: "acme", principalId: "user-1" };
const SENDER = "ins_dep-heartbeat@acme.example";

beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, "acme", "user-1");
});

describe("extractSenderMailboxAddress", () => {
  test("returns a bare address unchanged", () => {
    expect(extractSenderMailboxAddress(SENDER)).toBe(SENDER);
  });

  test("strips a quoted display name and the angle brackets", () => {
    expect(extractSenderMailboxAddress(`"Heartbeat" <${SENDER}>`)).toBe(SENDER);
  });

  test("trims surrounding whitespace on both forms", () => {
    expect(extractSenderMailboxAddress(`  ${SENDER}  `)).toBe(SENDER);
    expect(extractSenderMailboxAddress(`Bot < ${SENDER} >`)).toBe(SENDER);
  });

  test("uses the LAST '>' so a display name containing one cannot truncate it", () => {
    expect(extractSenderMailboxAddress(`"a > b" <${SENDER}>`)).toBe(SENDER);
  });
});

describe("attachFromDisplay", () => {
  test("returns the label when the resolver knows a distinct one", () => {
    expect(attachFromDisplay(SENDER, new Map([[SENDER, "Heartbeat"]]))).toBe(
      "Heartbeat",
    );
  });

  test("keys off the extracted address, not the whole header", () => {
    expect(
      attachFromDisplay(`"Bot" <${SENDER}>`, new Map([[SENDER, "Heartbeat"]])),
    ).toBe("Heartbeat");
  });

  test("returns undefined for an address the resolver did not resolve", () => {
    expect(
      attachFromDisplay("stranger@acme.example", new Map([[SENDER, "X"]])),
    ).toBeUndefined();
  });

  test("returns undefined when the label just echoes the address", () => {
    // Emitting this would make a client render the same string twice.
    expect(
      attachFromDisplay(SENDER, new Map([[SENDER, SENDER]])),
    ).toBeUndefined();
  });

  test("returns undefined when the label just echoes the whole header", () => {
    const header = `"Bot" <${SENDER}>`;
    expect(
      attachFromDisplay(header, new Map([[SENDER, header]])),
    ).toBeUndefined();
  });
});

describe("the read path's sender-display seam", () => {
  async function seed(from: string): Promise<string> {
    const written = await writeMailboxMessage(db, {
      ...SCOPE,
      address: "user-1@acme.example",
      fromAddress: from,
      subject: "Run finished",
      body: "Body",
      messageKey: crypto.randomUUID(),
    });
    return written!.id;
  }

  const resolver: SenderDisplayResolver = (_tenant, headers) =>
    new Map(
      headers
        .map(extractSenderMailboxAddress)
        .filter((address) => address === SENDER)
        .map((address) => [address, "Heartbeat"]),
    );

  test("no resolver means no fromDisplay, and `from` is still the raw header", async () => {
    await seed(SENDER);
    const page = await listUserMailbox(db, {
      ...SCOPE,
      limit: 10,
      view: "all",
      priorities: TEST_VOCABULARY.priorities,
    });
    expect(page.items[0]?.from).toBe(SENDER);
    expect(page.items[0]?.fromDisplay).toBeUndefined();
  });

  test("a resolver stamps fromDisplay without replacing `from`", async () => {
    await seed(SENDER);
    const page = await listUserMailbox(db, {
      priorities: TEST_VOCABULARY.priorities,
      ...SCOPE,
      limit: 10,
      view: "all",
      resolveSenderDisplays: resolver,
    });
    expect(page.items[0]?.fromDisplay).toBe("Heartbeat");
    expect(page.items[0]?.from).toBe(SENDER);
  });

  test("unresolved senders on the same page keep no fromDisplay", async () => {
    await seed(SENDER);
    await seed("stranger@acme.example");
    const page = await listUserMailbox(db, {
      priorities: TEST_VOCABULARY.priorities,
      ...SCOPE,
      limit: 10,
      view: "all",
      resolveSenderDisplays: resolver,
    });
    const byFrom = new Map(page.items.map((m) => [m.from, m.fromDisplay]));
    expect(byFrom.get(SENDER)).toBe("Heartbeat");
    expect(byFrom.get("stranger@acme.example")).toBeUndefined();
  });

  test("the whole page is resolved in ONE call, not one call per message", async () => {
    await seed(SENDER);
    await seed("stranger@acme.example");
    const calls: string[][] = [];
    await listUserMailbox(db, {
      priorities: TEST_VOCABULARY.priorities,
      ...SCOPE,
      limit: 10,
      view: "all",
      resolveSenderDisplays: (_tenant, headers) => {
        calls.push(headers);
        return new Map();
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sort()).toEqual([SENDER, "stranger@acme.example"].sort());
  });

  test("the resolver is handed the tenantId being read", async () => {
    await seed(SENDER);
    const tenants: string[] = [];
    await listUserMailbox(db, {
      priorities: TEST_VOCABULARY.priorities,
      ...SCOPE,
      limit: 10,
      view: "all",
      resolveSenderDisplays: (tenantId) => {
        tenants.push(tenantId);
        return new Map();
      },
    });
    expect(tenants).toEqual(["acme"]);
  });

  test("a resolver that throws costs the labels, not the page", async () => {
    await seed(SENDER);
    const page = await listUserMailbox(db, {
      priorities: TEST_VOCABULARY.priorities,
      ...SCOPE,
      limit: 10,
      view: "all",
      resolveSenderDisplays: () => {
        throw new Error("directory unavailable");
      },
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.from).toBe(SENDER);
    expect(page.items[0]?.fromDisplay).toBeUndefined();
  });

  test("the detail read applies the resolver too", async () => {
    const id = await seed(SENDER);
    const detail = await getMailboxMessage(db, {
      ...SCOPE,
      id,
      resolveSenderDisplays: resolver,
    });
    expect(detail?.fromDisplay).toBe("Heartbeat");
  });

  test("mountMailbox threads its resolveSenderDisplays into list and detail", async () => {
    const id = await seed(SENDER);
    const app = new Hono();
    mountMailbox(app, {
      vocabulary: TEST_VOCABULARY,
      db,
      bus: createInMemoryMailboxEventBus(),
      resolvePrincipal: () => SCOPE,
      resolveSenderDisplays: resolver,
    });

    const list = (await (await app.request("/me/inbox")).json()) as {
      messages: { fromDisplay?: string }[];
    };
    expect(list.messages[0]?.fromDisplay).toBe("Heartbeat");

    const detail = (await (await app.request(`/me/inbox/${id}`)).json()) as {
      fromDisplay?: string;
    };
    expect(detail.fromDisplay).toBe("Heartbeat");
  });
});
