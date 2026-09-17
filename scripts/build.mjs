#!/usr/bin/env node
/**
 * Builds `dist/`.
 *
 * `@intx/mailbox` (and its `@intx/mime`/`@intx/types` compile-time
 * dependencies at this pin) are vendored under `vendor/` — see
 * VENDORED.md — because `@intx/mailbox` has never been published. A
 * published `@corbits/mailbox` therefore cannot depend on them: there is
 * nothing on npm for a consumer to install. Instead this build BUNDLES the
 * three vendored packages into `dist/index.js`, so a plain `npm install` of
 * the tarball is self-contained. Every other dependency (the real npm
 * packages in `dependencies`/`peerDependencies`) stays external — the
 * consumer installs those themselves.
 *
 * Type declarations follow the same split: `dist/*.d.ts` is emitted from
 * `src/` as before, but it still contains bare `@intx/mailbox` /
 * `@intx/mime` / `@intx/types` import specifiers (tsc does not rewrite
 * import text just because `paths` resolved it — that mapping is
 * compile-time only). A consumer's own `tsc` would fail to resolve those
 * the same way Node failed to resolve the bare runtime import. So this
 * script also compiles the three vendored packages' own declarations into
 * `dist/vendor/<name>/`, then rewrites every bare `@intx/*` specifier in
 * `dist/**\/*.d.ts` to a relative path into `dist/vendor/`.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
}

rmSync(dist, { recursive: true, force: true });

// 1. Declarations for our own src/, unchanged in shape from before.
run("bun", ["x", "tsc", "-p", "tsconfig.build.json"]);

// 2. Declarations for the three vendored packages, compiled standalone so
//    they can be relocated under dist/vendor/ and referenced by relative
//    path instead of by bare package name.
run("bun", ["x", "tsc", "-p", "tsconfig.vendor-types.json"]);

const VENDOR_PACKAGES = {
  "intx-mailbox": "@intx/mailbox",
  "intx-mime": "@intx/mime",
  "intx-types": "@intx/types",
};

const rawVendorRoot = join(dist, ".vendor-types-raw", "vendor");
for (const dir of Object.keys(VENDOR_PACKAGES)) {
  const from = join(rawVendorRoot, dir, "src");
  const to = join(dist, "vendor", dir);
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
}
rmSync(join(dist, ".vendor-types-raw"), { recursive: true, force: true });

// 3. Bundle the runtime JS. @intx/mailbox, @intx/mime, and @intx/types get
//    inlined (they're intentionally left off the `--external` list);
//    everything else — the package's real npm dependencies/peerDependencies
//    — is left for the consumer to install.
const EXTERNAL = [
  "@hono/standard-validator",
  "@standard-community/standard-json",
  "@standard-community/standard-openapi",
  "arktype",
  "hono-openapi",
  "@intx/crypto",
  "@intx/log",
  "drizzle-orm",
  "hono",
  "postgres",
];
run("bun", [
  "build",
  "src/index.ts",
  "--outdir",
  dist,
  "--target",
  "node",
  "--format",
  "esm",
  ...EXTERNAL.flatMap((pkg) => ["--external", pkg]),
]);

// 4. Rewrite bare `@intx/*` specifiers in every emitted .d.ts (ours and the
//    vendored packages' own, which cross-reference each other) into
//    relative paths under dist/vendor/.
function listDtsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listDtsFiles(full));
    } else if (entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function rewriteImports(file) {
  let text = readFileSync(file, "utf8");
  const fileDir = dirname(file);
  text = text.replace(
    /from\s+"(@intx\/(?:mailbox|mime|types)(?:\/[a-zA-Z0-9-]+)?)"/g,
    (match, spec) => {
      const [pkgName, ...subpathParts] = spec.split("/").slice(1);
      const vendorDir = { mailbox: "intx-mailbox", mime: "intx-mime", types: "intx-types" }[
        pkgName
      ];
      if (!vendorDir) return match;
      const targetBase = subpathParts.length > 0 ? subpathParts.join("/") : "index";
      const targetFile = join(dist, "vendor", vendorDir, `${targetBase}.js`);
      let rel = relative(fileDir, targetFile).split("\\").join("/");
      if (!rel.startsWith(".")) rel = `./${rel}`;
      return `from "${rel}"`;
    },
  );
  writeFileSync(file, text);
}

for (const file of listDtsFiles(dist)) {
  rewriteImports(file);
}
