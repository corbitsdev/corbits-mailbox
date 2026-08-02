import { describe, test, expect } from "bun:test";
import { type } from "arktype";
import {
  MailboxEventSchema,
  publishMailboxEvent,
  type MailboxEvent,
} from "./bus.js";

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

describe("publishMailboxEvent", () => {
  test("omitting op publishes the original two-field shape", () => {
    const seen: MailboxEvent[] = [];
    const bus = {
      publish: (_scope: typeof SCOPE, event: MailboxEvent) => {
        seen.push(event);
      },
      subscribe: () => () => {},
    };
    publishMailboxEvent(bus, SCOPE, "row-1", noopLogger);
    expect(seen).toEqual([{ type: "mailbox", id: "row-1" }]);
    expect("op" in seen[0]!).toBe(false);
  });

  test("passing op includes it on the published event", () => {
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
