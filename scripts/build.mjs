#!/usr/bin/env node
/**
 * Builds `dist/`: plain `tsc` JS emit + declarations, module-for-module,
 * matching the source layout. `@intx/mailbox`/`@intx/mime`/`@intx/types`
 * are real npm dependencies (see package.json) — this build does not
 * bundle them; a consumer's own install resolves the bare `@intx/*`
 * specifiers this package's `src/` imports.
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });

execFileSync("bun", ["x", "tsc", "-p", "tsconfig.build.json"], {
  cwd: root,
  stdio: "inherit",
});
