import { describe, test, expect } from "bun:test";
import { createInMemoryMailboxEventBus } from "./bus.js";

const P1 = { tenantId: "t1", principalId: "p1" };

describe("in-memory bus unsubscribe", () => {
  test("a double-called unsubscribe must not evict a later subscriber", () => {
    const bus = createInMemoryMailboxEventBus();
    const a: string[] = [];
    const offA = bus.subscribe(P1, (e) => a.push(e.id));
    offA(); // tab A closes -> set for p1 becomes empty and is deleted
    const b: string[] = [];
    bus.subscribe(P1, (e) => b.push(e.id)); // tab B opens (new Set)
    offA(); // mount.ts calls unsubscribe twice (onAbort + finally)
    bus.publish(P1, { type: "mailbox", id: "evt" });
    expect(b).toEqual(["evt"]); // B is still subscribed
  });
});

describe("in-memory bus tenant isolation", () => {
  test("the same principalId under two tenants is two mailboxes, not one", () => {
    // A principal identifier is only unique within its tenant; a bus keyed on
    // it alone would fan tenantB's events into tenantA's same-named principal.
    const bus = createInMemoryMailboxEventBus();
    const forA: string[] = [];
    const forB: string[] = [];
    bus.subscribe({ tenantId: "tenantA", principalId: "alice" }, (e) =>
      forA.push(e.id),
    );
    bus.subscribe({ tenantId: "tenantB", principalId: "alice" }, (e) =>
      forB.push(e.id),
    );
    bus.publish(
      { tenantId: "tenantB", principalId: "alice" },
      { type: "mailbox", id: "evt-b" },
    );
    expect(forA).toEqual([]);
    expect(forB).toEqual(["evt-b"]);
  });
});
