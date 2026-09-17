#!/usr/bin/env node
/**
 * Builds `dist/`.
 *
 * `@intx/mailbox` (and its `@intx/mime`/`@intx/types` compile-time
 * dependencies at this pin) are vendored under `vendor/` — see
 * VENDORED.md — because `@intx/mailbox` has never been published. A
 * published `@corbits/mailbox` therefore cannot depend on them: there is
 * nothing on npm for a consumer to install. Instead this build emits the
 * three vendored packages' own JS (via `tsc`, no bundler) into
 * `dist/vendor/<name>/`, so a plain `npm install` of the tarball is
 * self-contained.
 *
 * There is no bundler anywhere in this build. `tsc` emits our own `src/`
 * as plain JS + `.d.ts` (module-for-module, matching the source layout),
 * and separately emits the three vendored packages the same way. Every
 * bare `@intx/mailbox` / `@intx/mime` / `@intx/types` import specifier
 * (tsc does not rewrite import text just because `paths` resolved it —
 * that mapping is compile-time only) is then rewritten, in BOTH the
 * emitted `.js` and the emitted `.d.ts`, to a relative path into
 * `dist/vendor/`. Every other dependency (the real npm packages in
 * `dependencies`/`peerDependencies`, plus `@intx/crypto`/`@intx/log`,
 * which are real npm packages too) is left alone for the consumer to
 * install.
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

// 1. Our own src/: plain tsc JS emit + declarations, module-for-module.
run("bun", ["x", "tsc", "-p", "tsconfig.build.json"]);

// 2. The three vendored packages: same plain tsc JS + declaration emit,
//    compiled standalone so they can be relocated under dist/vendor/ and
//    referenced by relative path instead of by bare package name.
run("bun", ["x", "tsc", "-p", "tsconfig.vendor-build.json"]);

const VENDOR_PACKAGES = {
  "intx-mailbox": "@intx/mailbox",
  "intx-mime": "@intx/mime",
  "intx-types": "@intx/types",
};

const rawVendorRoot = join(dist, ".vendor-build-raw", "vendor");
for (const dir of Object.keys(VENDOR_PACKAGES)) {
  const from = join(rawVendorRoot, dir, "src");
  const to = join(dist, "vendor", dir);
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
}
rmSync(join(dist, ".vendor-build-raw"), { recursive: true, force: true });

// 3. Rewrite bare `@intx/*` specifiers in every emitted file — `.js` (ours
//    and the vendored packages' own runtime code) and `.d.ts` (same,
//    cross-referencing each other) — into relative paths under
//    dist/vendor/. A package's own `exports` subpaths (e.g.
//    `@intx/types/runtime`) map 1:1 onto that package's own src/ file
//    names, which is exactly how they land under dist/vendor/<pkg>/.
function listEmittedFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listEmittedFiles(full));
    } else if (entry.endsWith(".js") || entry.endsWith(".d.ts")) {
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
  // The vendored packages' own source (unlike ours) writes extensionless
  // relative specifiers, resolved at dev time only via `moduleResolution:
  // "bundler"`. `tsc` emits import text verbatim — it does not add
  // extensions — so a plain `node` ESM resolver (no bundler, no
  // resolution-mode help) fails on them. Append `.js` to any relative
  // specifier that doesn't already end in a resolvable extension.
  text = text.replace(
    /from\s+"(\.\.?\/[^"]+)"/g,
    (match, spec) => {
      if (/\.(js|json|mjs|cjs)$/.test(spec)) return match;
      return `from "${spec}.js"`;
    },
  );
  writeFileSync(file, text);
}

for (const file of listEmittedFiles(dist)) {
  rewriteImports(file);
}
