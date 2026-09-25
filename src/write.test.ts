import { describe, expect, test } from "bun:test";
import {
  assertMailboxScope,
  assertMailboxTenantId,
  assertMailboxFrameBytes,
  MAX_MAILBOX_FRAME_BYTES,
} from "./write.js";

describe("assertMailboxScope / assertMailboxTenantId", () => {
  test("accepts a non-blank scope", () => {
    expect(() => assertMailboxScope({ tenantId: "t1", principalId: "p1" })).not.toThrow();
  });

  test("rejects a blank tenantId or principalId", () => {
    for (const scope of [
      { tenantId: "", principalId: "p1" },
      { tenantId: "  ", principalId: "p1" },
      { tenantId: "t1", principalId: "" },
    ]) {
      expect(() => assertMailboxScope(scope)).toThrow(RangeError);
    }
  });

  test("assertMailboxTenantId rejects a blank tenantId alone", () => {
    expect(() => assertMailboxTenantId("")).toThrow(RangeError);
    expect(() => assertMailboxTenantId("t1")).not.toThrow();
  });
});

describe("assertMailboxFrameBytes", () => {
  test("accepts at-cap, refuses one byte over", () => {
    expect(() =>
      assertMailboxFrameBytes(new Uint8Array(MAX_MAILBOX_FRAME_BYTES)),
    ).not.toThrow();
    expect(() =>
      assertMailboxFrameBytes(new Uint8Array(MAX_MAILBOX_FRAME_BYTES + 1)),
    ).toThrow(RangeError);
  });
});
