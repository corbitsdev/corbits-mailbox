// `@intx/types` renamed `isAgentAddress` to `isRunAddress` (INTR-358). This
// module bridges both shapes so the package keeps working against the
// pre-rename (^0.2.2) and post-rename builds without a version bump — import
// from here instead of naming either export directly.
import * as intxTypes from "@intx/types";

export type IntxTypesCompatModule = {
  isRunAddress?: (address: string) => boolean;
  isAgentAddress?: (address: string) => boolean;
};

export function resolveIsRunAddress(
  mod: IntxTypesCompatModule,
): (address: string) => boolean {
  const resolved = mod.isRunAddress ?? mod.isAgentAddress;
  if (!resolved) {
    throw new Error(
      "@intx/types exports neither isRunAddress nor isAgentAddress",
    );
  }
  return resolved;
}

export const isRunAddress: (address: string) => boolean =
  resolveIsRunAddress(intxTypes);
