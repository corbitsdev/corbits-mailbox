import { describe, test, expect } from "bun:test";
import { type } from "arktype";
import {
  MAILBOX_EVENT_OPS,
  MailboxEventSchema,
  publishMailboxEvent,
  type MailboxEvent,
} from "./bus.js";
import { MAILBOX_BULK_ACTIONS } from "./mutations.js";

const SCOPE = { tenantId: "t1", principalId: "p1" };
const noopLogger = { error: () => {} };

describe("MailboxEventSchema", () => {
  test("accepts the pre-existing shape: type and id, no op", () => {
    // The additive contract: a listener (or a stored/replayed event) built
    // before `op` existed must still validate.
    const result = MailboxEventSchema({ type: "mailbox", id: "row-1" });
    expect(result instanceof type.errors).toBe(false);
  });

  test("accepts a known op", () => {
    const result = MailboxEventSchema({
      type: "mailbox",
      id: "row-1",
      op: "mark_read",
    });
    expect(result instanceof type.errors).toBe(false);
  });

  test("rejects an op outside the known vocabulary", () => {
    const result = MailboxEventSchema({
      type: "mailbox",
      id: "row-1",
      op: "delete_everything",
    });
    expect(result instanceof type.errors).toBe(true);
  });
});

describe("MAILBOX_EVENT_OPS vs MAILBOX_BULK_ACTIONS", () => {
  // MAILBOX_EVENT_OPS is duplicated from MAILBOX_BULK_ACTIONS rather than
  // importing it (to avoid a bus.ts -> mutations.ts -> write.ts -> bus.ts
  // cycle), and nothing at runtime enforces that the copy stays in sync.
  // This is that enforcement: a bulk action added to mutations.ts without a
  // matching entry here fails this test instead of silently losing its op.
  test("every bulk action has a matching event op", () => {
    for (const action of MAILBOX_BULK_ACTIONS) {
      expect(MAILBOX_EVENT_OPS).toContain(action);
    }
  });
});

describe("publishMailboxEvent", () => {
  test("publishes op on the event", () => {
    const seen: MailboxEvent[] = [];
    const bus = {
      publish: (_scope: typeof SCOPE, event: MailboxEvent) => {
        seen.push(event);
      },
      subscribe: () => () => {},
    };
    publishMailboxEvent(bus, SCOPE, "row-1", noopLogger, "archive");
    expect(seen).toEqual([{ type: "mailbox", id: "row-1", op: "archive" }]);
  });
});
