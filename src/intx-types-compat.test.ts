import { describe, expect, test } from "bun:test";
import { resolveIsRunAddress } from "./intx-types-compat.js";

describe("resolveIsRunAddress", () => {
  test("uses isRunAddress on a post-rename module", () => {
    const isRunAddress = (address: string) => address.startsWith("run_");
    const resolved = resolveIsRunAddress({ isRunAddress });
    expect(resolved("run_abc@x.example")).toBe(true);
    expect(resolved("usr_abc@x.example")).toBe(false);
  });

  test("falls back to isAgentAddress on a pre-rename module", () => {
    const isAgentAddress = (address: string) => address.startsWith("ins_");
    const resolved = resolveIsRunAddress({ isAgentAddress });
    expect(resolved("ins_run42@x.example")).toBe(true);
    expect(resolved("usr_alice@x.example")).toBe(false);
  });

  test("prefers isRunAddress when a module exposes both", () => {
    const isRunAddress = () => true;
    const isAgentAddress = () => false;
    const resolved = resolveIsRunAddress({ isRunAddress, isAgentAddress });
    expect(resolved("anything@x.example")).toBe(true);
  });

  test("throws when a module exposes neither export", () => {
    expect(() => resolveIsRunAddress({})).toThrow(
      "@intx/types exports neither isRunAddress nor isAgentAddress",
    );
  });
});
