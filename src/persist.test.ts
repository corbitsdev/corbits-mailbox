// The two edge cases that live on the transport dual-write seam: sender
// authorization, and dual-write independence (an upstream throw still attempts
// the mailbox write).
import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import {
  createMailboxPersist,
  MAX_MAILBOX_RECIPIENTS,
  type MailboxPersistArgs,
  type SenderAuthorization,
  type PersistedMailboxRow,
  type ResolveMailboxRefs,
} from "./persist.js";
import { createInMemoryMailboxEventBus } from "./bus.js";
import { buildMailFrame } from "./frame.js";
import { principalMail } from "./schema.js";
import { withTestDb, seedScope } from "./test-helpers.js";
import type { MailboxDb } from "./db.js";
import {
  MAX_MAILBOX_FRAME_BYTES,
  MAX_MAILBOX_REFS,
  assertMailboxFrameBytes,
} from "./write.js";
import { getMailboxMessage, type MailboxRef } from "./read.js";

let db: MailboxDb;

const SENDER = "ins_dep-heartbeat@acme.example";
const ACTIVE: SenderAuthorization = {
  tenantId: "acme",
  domain: "acme.example",
};

beforeEach(async () => {
  db = await withTestDb();
  await seedScope(db, "acme", "user-1", "user-2");
});

function frame(subject = "Run finished"): Uint8Array {
  return buildMailFrame({
    from: SENDER,
    to: "usr_user-1@acme.example",
    subject,
    body: "Body",
    messageId: "<fixed@acme.example>",
  });
}

function args(over: Partial<MailboxPersistArgs> = {}): MailboxPersistArgs {
  return {
    senderAddress: SENDER,
    recipients: ["usr_user-1@acme.example"],
    raw: frame(),
    ...over,
  };
}

/** An upstream that records what it saw and returns a recognizable result. */
function recordingUpstream() {
  const calls: MailboxPersistArgs[] = [];
  const result = [{ delivered: true }];
  return {
    calls,
    result,
    upstream: async (a: MailboxPersistArgs) => {
      calls.push(a);
      return result;
    },
  };
}

function rowsFor(tenantId: string, principalId: string) {
  return db
    .select()
    .from(principalMail)
    .where(
      and(
        eq(principalMail.tenantId, tenantId),
        eq(principalMail.principalId, principalId),
      ),
    );
}

describe("sender auth", () => {
  test("an authorized sender gets a durable inbound row per recipient", async () => {
    const { upstream } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ACTIVE,
    });

    await persist(
      args({
        recipients: ["usr_user-1@acme.example", "usr_user-2@acme.example"],
      }),
    );

    expect(await rowsFor("acme", "user-1")).toHaveLength(1);
    expect(await rowsFor("acme", "user-2")).toHaveLength(1);
  });

  test("the inbound frame's threading headers are cached on the row", async () => {
    // The persist path receives a frame it did not build, so the caches come
    // off the decode — the list projection reads them without loading `raw`.
    const { upstream } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ACTIVE,
    });

    await persist(
      args({
        raw: buildMailFrame({
          from: SENDER,
          to: "usr_user-1@acme.example",
          subject: "Re: run",
          body: "Body",
          messageId: "<child@acme.example>",
          inReplyTo: "<parent@acme.example>",
          references: ["<root@acme.example>", "<parent@acme.example>"],
        }),
      }),
    );

    const [row] = await rowsFor("acme", "user-1");
    expect(row?.messageId).toBe("<child@acme.example>");
    expect(row?.inReplyTo).toBe("<parent@acme.example>");
  });

  test("a frame with no threading headers leaves both caches NULL", async () => {
    const { upstream } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ACTIVE,
    });

    await persist(args());

    const [row] = await rowsFor("acme", "user-1");
    expect(row?.messageId).toBe("<fixed@acme.example>");
    expect(row?.inReplyTo).toBeNull();
  });

  test("caches only the first bracketed msg-id from a non-bracketed or multi-id In-Reply-To", async () => {
    // The persist path decodes a frame it never built, so `In-Reply-To` is
    // NOT re-validated against `assertMsgId` (an external MTA's headers are
    // not this package's frame to reject) — it can be a bare id, several
    // ids, or otherwise malformed. The cached column must still agree with
    // what migration `0002_mail_threading_headers`'s backfill produces for
    // the same header text: the FIRST bracketed msg-id if present, else
    // NULL — never the raw header value.
    const { upstream } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ACTIVE,
    });
    const enc = new TextEncoder();

    await persist(
      args({
        raw: enc.encode(
          `From: ${SENDER}\r\nTo: usr_user-1@acme.example\r\n` +
            "Message-ID: <bare@acme.example>\r\nIn-Reply-To: foo@bar\r\n\r\nBody\r\n",
        ),
      }),
    );
    const [bare] = await rowsFor("acme", "user-1");
    expect(bare?.messageId).toBe("<bare@acme.example>");
    expect(bare?.inReplyTo).toBeNull();

    await db.execute(sql`DELETE FROM "mailbox"."principal_mail"`);
    await persist(
      args({
        raw: enc.encode(
          `From: ${SENDER}\r\nTo: usr_user-1@acme.example\r\n` +
            "Message-ID: <multi@acme.example>\r\nIn-Reply-To: <a@x> <b@x>\r\n\r\nBody\r\n",
        ),
      }),
    );
    const [multi] = await rowsFor("acme", "user-1");
    expect(multi?.messageId).toBe("<multi@acme.example>");
    expect(multi?.inReplyTo).toBe("<a@x>");
  });

  test("an unauthorized sender writes NO mailbox row but is still delegated upstream", async () => {
    // The reference predicate is "active instance only": a sender the host
    // cannot resolve to a live instance is refused here.
    const { upstream, calls, result } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => null,
    });

    expect(
      await persist(args({ senderAddress: "usr_mallory@acme.example" })),
    ).toBe(result);
    expect(calls).toHaveLength(1);
    expect(await rowsFor("acme", "user-1")).toHaveLength(0);
  });

  test("the sender's authorized tenantId owns the row, not anything in the frame", async () => {
    // The recipient principal really belongs to the authorizer's tenant here —
    // otherwise the unknown-principal filter would skip the delivery outright.
    await db.execute(sql`DELETE FROM "principal" WHERE "id" = 'user-1'`);
    await seedScope(db, "other-tenantId", "user-1");
    const { upstream } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ({
        tenantId: "other-tenantId",
        domain: "acme.example",
      }),
    });

    await persist(args());
    expect(await rowsFor("acme", "user-1")).toHaveLength(0);
    expect(await rowsFor("other-tenantId", "user-1")).toHaveLength(1);
  });

  test("recipients outside the authorized domain are skipped", async () => {
    const { upstream } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ACTIVE,
    });

    await persist(
      args({
        recipients: ["usr_user-1@acme.example", "usr_spy@evil.example"],
      }),
    );

    expect(await rowsFor("acme", "user-1")).toHaveLength(1);
    expect(await rowsFor("acme", "spy")).toHaveLength(0);
  });

  test("an unknown principal is skipped without costing the known one its copy", async () => {
    // Recipient local parts are sender-controlled: a typo'd address must not
    // mint a phantom mailbox, and must not take the real recipient down with it.
    const { upstream } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ACTIVE,
    });

    await persist(
      args({
        recipients: ["usr_user-1@acme.example", "usr_nobody@acme.example"],
      }),
    );

    expect(await rowsFor("acme", "user-1")).toHaveLength(1);
    expect(await rowsFor("acme", "nobody")).toHaveLength(0);
  });

  test("instance addresses are not mailboxes and produce no row", async () => {
    const { upstream } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ACTIVE,
    });

    await persist(args({ recipients: ["ins_dep-other@acme.example"] }));
    const all = await db.select().from(principalMail);
    expect(all).toHaveLength(0);
  });
});

describe("dual-write independence", () => {
  test("an upstream throw still writes the mailbox row, then propagates", async () => {
    const persist = createMailboxPersist(db, {
      upstream: async () => {
        throw new Error("no session for that address");
      },
      authorizeSender: () => ACTIVE,
    });

    await expect(persist(args())).rejects.toThrow(
      "no session for that address",
    );

    // Exactly one row, from that one rejected call: the durable copy is what
    // makes the message readable later, and a transport that could not reach a
    // live session must not also cost the recipient that copy.
    const rows = await rowsFor("acme", "user-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.direction).toBe("inbound");
    expect(rows[0]?.subject).toBe("Run finished");
  });

  test("the upstream error is re-thrown unchanged, not wrapped", async () => {
    const boom = new Error("no session for that address");
    const persist = createMailboxPersist(db, {
      upstream: async () => {
        throw boom;
      },
      authorizeSender: () => ACTIVE,
    });

    const caught = await persist(args()).catch((err: unknown) => err);
    expect(caught).toBe(boom);
  });

  test("a mailbox-write failure never rejects a persist upstream completed", async () => {
    const { upstream, result } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => {
        throw new Error("directory unavailable");
      },
    });

    // Reporting failure for a delivery that did happen invites a retry that
    // double-delivers it, so this resolves with the upstream result.
    expect(await persist(args())).toBe(result);
    expect(await rowsFor("acme", "user-1")).toHaveLength(0);
  });

  test("upstream is called for every frame, authorized or not", async () => {
    const { upstream, calls } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: (address) => (address === SENDER ? ACTIVE : null),
    });

    await persist(args());
    await persist(args({ senderAddress: "usr_mallory@acme.example" }));
    expect(calls.map((c) => c.senderAddress)).toEqual([
      SENDER,
      "usr_mallory@acme.example",
    ]);
  });
});

describe("announcements", () => {
  test("each inserted row is published to its own principalId, as a `create`", async () => {
    const bus = createInMemoryMailboxEventBus();
    const forUser1: string[] = [];
    const forUser2: string[] = [];
    const opsUser1: Array<string | undefined> = [];
    bus.subscribe({ tenantId: "acme", principalId: "user-1" }, (e) => {
      forUser1.push(e.id);
      opsUser1.push(e.op);
    });
    bus.subscribe({ tenantId: "acme", principalId: "user-2" }, (e) =>
      forUser2.push(e.id),
    );

    const { upstream } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ACTIVE,
      bus,
    });
    await persist(
      args({
        recipients: ["usr_user-1@acme.example", "usr_user-2@acme.example"],
      }),
    );

    expect(forUser1).toHaveLength(1);
    expect(forUser2).toHaveLength(1);
    expect(forUser1[0]).not.toBe(forUser2[0]);
    // Dual-write inserts are always new mail, never a mutation of an
    // existing row, so the op is unconditionally `create`.
    expect(opsUser1).toEqual(["create"]);
  });

  test("onRow reports the row id, principalId and sender", async () => {
    const seen: PersistedMailboxRow[] = [];
    const { upstream } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ACTIVE,
      onRow: (row) => seen.push(row),
    });

    await persist(args());
    const [row] = await rowsFor("acme", "user-1");
    expect(seen).toEqual([
      {
        id: row!.id,
        tenantId: "acme",
        principalId: "user-1",
        recipientAddress: "usr_user-1@acme.example",
        senderAddress: SENDER,
      },
    ]);
  });

  test("a throwing onRow does not fail the persist or lose the row", async () => {
    const { upstream, result } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ACTIVE,
      onRow: () => {
        throw new Error("hook exploded");
      },
    });

    expect(await persist(args())).toBe(result);
    expect(await rowsFor("acme", "user-1")).toHaveLength(1);
  });

  test("a throwing bus does not fail the persist or lose the row", async () => {
    const { upstream, result } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ACTIVE,
      bus: {
        publish: () => {
          throw new Error("broker down");
        },
        subscribe: () => () => undefined,
      },
    });

    expect(await persist(args())).toBe(result);
    expect(await rowsFor("acme", "user-1")).toHaveLength(1);
  });
});

describe("cached columns", () => {
  test("subject and from are cached off the frame's headers", async () => {
    const { upstream } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ACTIVE,
    });

    await persist(args({ raw: frame("Quarterly review") }));
    const [row] = await rowsFor("acme", "user-1");
    expect(row?.subject).toBe("Quarterly review");
    expect(row?.fromAddress).toBe(SENDER);
  });

  test("a frame the parser rejects still persists, with null cached columns", async () => {
    const { upstream } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ACTIVE,
    });

    await persist(args({ raw: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) }));
    const [row] = await rowsFor("acme", "user-1");
    // `raw` stays authoritative; losing the cached columns must not lose the
    // message.
    expect(row).toBeDefined();
    expect(row?.subject).toBeNull();
    expect(row?.fromAddress).toBeNull();
  });
});

describe("transport insert idempotency", () => {
  test("upstream fails then retry of the same frame leaves one row per recipient", async () => {
    // The dual-write path still lands the durable copy when upstream throws, and
    // a transport retry of that same frame must not mint a second inbound row.
    const persist = createMailboxPersist(db, {
      upstream: async () => {
        throw new Error("no session for that address");
      },
      authorizeSender: () => ACTIVE,
    });
    const a = args({
      recipients: ["usr_user-1@acme.example", "usr_user-2@acme.example"],
    });

    await expect(persist(a)).rejects.toThrow("no session for that address");
    await expect(persist(a)).rejects.toThrow("no session for that address");

    expect(await rowsFor("acme", "user-1")).toHaveLength(1);
    expect(await rowsFor("acme", "user-2")).toHaveLength(1);
  });

  test("concurrent identical persists leave one row", async () => {
    const { upstream } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ACTIVE,
    });
    const a = args();

    await Promise.all([persist(a), persist(a), persist(a), persist(a)]);

    expect(await rowsFor("acme", "user-1")).toHaveLength(1);
  });

  test("distinct frames still create distinct rows", async () => {
    const { upstream } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ACTIVE,
    });

    await persist(
      args({
        raw: buildMailFrame({
          from: SENDER,
          to: "usr_user-1@acme.example",
          subject: "First",
          body: "Body",
          messageId: "<first@acme.example>",
        }),
      }),
    );
    await persist(
      args({
        raw: buildMailFrame({
          from: SENDER,
          to: "usr_user-1@acme.example",
          subject: "Second",
          body: "Body",
          messageId: "<second@acme.example>",
        }),
      }),
    );
    // Frames with no Message-ID fall back to a content hash; different raw
    // bytes must still land as separate rows.
    await persist(args({ raw: new Uint8Array([0x01, 0x02]) }));
    await persist(args({ raw: new Uint8Array([0x03, 0x04]) }));

    expect(await rowsFor("acme", "user-1")).toHaveLength(4);
  });
});

describe("resolveRefs", () => {
  test("refs are visible to a bus subscriber on the create event", async () => {
    const bus = createInMemoryMailboxEventBus();
    const seenIds: string[] = [];
    bus.subscribe({ tenantId: "acme", principalId: "user-1" }, (e) =>
      seenIds.push(e.id),
    );
    const refs: MailboxRef[] = [{ kind: "workbench", id: "thread-1" }];
    const { upstream } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ACTIVE,
      bus,
      resolveRefs: () => refs,
    });

    await persist(args());

    // By the time the bus fires, the insert has already committed — a
    // subscriber reading the row by the announced id sees refs already
    // stamped, not a later-arriving update.
    expect(seenIds).toHaveLength(1);
    const message = await getMailboxMessage(db, {
      tenantId: "acme",
      principalId: "user-1",
      id: seenIds[0]!,
    });
    expect(message?.refs).toEqual(refs);
  });

  test("resolveRefs is called once for three recipients, and every row gets its refs", async () => {
    await seedScope(db, "acme", "user-3");
    const refs: MailboxRef[] = [{ kind: "workbench", id: "thread-1" }];
    const calls: unknown[] = [];
    const resolveRefs: ResolveMailboxRefs = (a) => {
      calls.push(a);
      return refs;
    };
    const { upstream } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ACTIVE,
      resolveRefs,
    });

    await persist(
      args({
        recipients: [
          "usr_user-1@acme.example",
          "usr_user-2@acme.example",
          "usr_user-3@acme.example",
        ],
      }),
    );

    expect(calls).toHaveLength(1);
    for (const principalId of ["user-1", "user-2", "user-3"]) {
      const [row] = await rowsFor("acme", principalId);
      const message = await getMailboxMessage(db, {
        tenantId: "acme",
        principalId,
        id: row!.id,
      });
      expect(message?.refs).toEqual(refs);
    }
  });

  test("a throwing resolveRefs writes zero rows; upstream still completes", async () => {
    const { upstream, result } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ACTIVE,
      resolveRefs: () => {
        throw new Error("resolver exploded");
      },
    });

    expect(await persist(args())).toBe(result);
    expect(await rowsFor("acme", "user-1")).toHaveLength(0);
  });

  test("over-cap refs from resolveRefs are truncated to MAX_MAILBOX_REFS", async () => {
    const refs: MailboxRef[] = Array.from({ length: MAX_MAILBOX_REFS + 5 }, (_, i) => ({
      kind: "workbench",
      id: `thread-${i}`,
    }));
    const { upstream } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ACTIVE,
      resolveRefs: () => refs,
    });

    await persist(args());

    const [row] = await rowsFor("acme", "user-1");
    const message = await getMailboxMessage(db, {
      tenantId: "acme",
      principalId: "user-1",
      id: row!.id,
    });
    expect(message?.refs?.length).toBe(MAX_MAILBOX_REFS);
  });

  test("retried frame with a different resolver result keeps the FIRST refs", async () => {
    let call = 0;
    const { upstream } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ACTIVE,
      resolveRefs: () => [{ kind: "workbench", id: `attempt-${++call}` }],
    });

    await persist(args());
    await persist(args());

    const all = await rowsFor("acme", "user-1");
    expect(all).toHaveLength(1);
    expect(call).toBe(2);
    const message = await getMailboxMessage(db, {
      tenantId: "acme",
      principalId: "user-1",
      id: all[0]!.id,
    });
    expect(message?.refs).toEqual([{ kind: "workbench", id: "attempt-1" }]);
  });

  test("resolver returning undefined stores SQL NULL, not []", async () => {
    const { upstream } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ACTIVE,
      resolveRefs: () => undefined,
    });

    await persist(args());

    const [row] = await rowsFor("acme", "user-1");
    expect(row!.refs).toBeNull();
  });

  test("resolver returning [] stores SQL NULL, not []", async () => {
    const { upstream } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ACTIVE,
      resolveRefs: () => [],
    });

    await persist(args());

    const [row] = await rowsFor("acme", "user-1");
    expect(row!.refs).toBeNull();
  });

  test("schema-invalid resolver output writes zero rows; upstream result still returned", async () => {
    const { upstream, result } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ACTIVE,
      resolveRefs: () => [{ kind: 42, id: "x" }] as unknown as MailboxRef[],
    });

    expect(await persist(args())).toBe(result);
    expect(await rowsFor("acme", "user-1")).toHaveLength(0);
  });

  test("resolver runs after upstream resolves (serial), adding its latency to the call", async () => {
    const order: string[] = [];
    const persist = createMailboxPersist(db, {
      upstream: async () => {
        await Bun.sleep(150);
        order.push("upstream");
        return [{ delivered: true }];
      },
      authorizeSender: () => ACTIVE,
      resolveRefs: async () => {
        order.push("resolver-start");
        await Bun.sleep(150);
        order.push("resolver-end");
        return undefined;
      },
    });

    const t0 = performance.now();
    await persist(args());
    const elapsed = performance.now() - t0;

    expect(order).toEqual(["upstream", "resolver-start", "resolver-end"]);
    expect(elapsed).toBeGreaterThanOrEqual(290);
  });

  test("the 21st ref (a workbench ref appended last) is silently dropped", async () => {
    const refs: MailboxRef[] = Array.from({ length: MAX_MAILBOX_REFS }, (_, i) => ({
      kind: "thread",
      id: `t-${i}`,
    }));
    refs.push({ kind: "workbench", id: "must-be-present" });
    const { upstream } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ACTIVE,
      resolveRefs: () => refs,
    });

    await persist(args());

    const [row] = await rowsFor("acme", "user-1");
    const message = await getMailboxMessage(db, {
      tenantId: "acme",
      principalId: "user-1",
      id: row!.id,
    });
    expect(message?.refs?.some((r) => r.kind === "workbench")).toBe(false);
  });
});

describe("frame size and recipient hard caps", () => {
  test("assertMailboxFrameBytes accepts at-cap and throws RangeError one byte over", () => {
    // Dual-write swallows the RangeError inside attemptMailboxWrite; the pure
    // assert is the unit contract the transport path shares with direct write.
    const atCap = new Uint8Array(MAX_MAILBOX_FRAME_BYTES);
    expect(() => assertMailboxFrameBytes(atCap)).not.toThrow();
    const over = new Uint8Array(MAX_MAILBOX_FRAME_BYTES + 1);
    expect(() => assertMailboxFrameBytes(over)).toThrow(RangeError);
    expect(() => assertMailboxFrameBytes(over)).toThrow(/mailbox frame exceeds/);
  });

  test("raw at the frame byte cap inserts; one byte over refuses and leaves zero rows", async () => {
    const { upstream, calls, result } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ACTIVE,
    });

    const atCap = new Uint8Array(MAX_MAILBOX_FRAME_BYTES);
    atCap.fill(0x41);
    expect(
      await persist(args({ raw: atCap, recipients: ["usr_user-1@acme.example"] })),
    ).toBe(result);
    expect(await rowsFor("acme", "user-1")).toHaveLength(1);

    // Dual-write independence: over-cap is swallowed after log so upstream still
    // succeeds; no row is written for the over-cap recipient.
    const over = new Uint8Array(MAX_MAILBOX_FRAME_BYTES + 1);
    over.fill(0x42);
    expect(
      await persist(
        args({
          raw: over,
          recipients: ["usr_user-2@acme.example"],
        }),
      ),
    ).toBe(result);
    expect(await rowsFor("acme", "user-2")).toHaveLength(0);
    // Both frames were delegated upstream regardless of mailbox refusal.
    expect(calls).toHaveLength(2);
  });

  test("recipient list at the cap resolves; one over refuses mailbox insert", async () => {
    // Seed enough principals so the at-cap list can resolve after filter.
    const extraIds = Array.from({ length: MAX_MAILBOX_RECIPIENTS - 2 }, (_, i) =>
      `extra-${i}`,
    );
    await seedScope(db, "acme", ...extraIds);

    const atCapRecipients = [
      "usr_user-1@acme.example",
      "usr_user-2@acme.example",
      ...extraIds.map((id) => `usr_${id}@acme.example`),
    ];
    expect(atCapRecipients).toHaveLength(MAX_MAILBOX_RECIPIENTS);

    const { upstream, calls, result } = recordingUpstream();
    const persist = createMailboxPersist(db, {
      upstream,
      authorizeSender: () => ACTIVE,
    });

    expect(await persist(args({ recipients: atCapRecipients }))).toBe(result);
    expect(await rowsFor("acme", "user-1")).toHaveLength(1);
    expect(await rowsFor("acme", "user-2")).toHaveLength(1);

    const overRecipients = [
      ...atCapRecipients,
      "usr_one-too-many@acme.example",
    ];
    expect(
      await persist(
        args({
          recipients: overRecipients,
          // Distinct raw so transport idempotency does not collapse with above
          raw: frame("over-recipient-cap"),
        }),
      ),
    ).toBe(result);
    // Over-cap path never reaches insert; prior at-cap rows remain the only ones.
    const total = await db.select().from(principalMail);
    expect(total).toHaveLength(MAX_MAILBOX_RECIPIENTS);
    // Upstream still ran for both calls (dual-write independence).
    expect(calls).toHaveLength(2);
  });
});
