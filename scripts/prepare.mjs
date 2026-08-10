/**
 * `prepare` hook — builds `dist/` when the package is installed from git.
 *
 * The package publishes `dist/` (and `src`) via `files`, and the `exports` map
 * points at `dist/`. A registry tarball arrives already built, via `prepack`.
 * A git install does not: it gets the repository, so something has to build on
 * the way in, and `prepare` is the one lifecycle hook package managers run at
 * that moment. Without it every `@corbits/mailbox` import in the consumer
 * resolves to a file that was never generated, and the failure lands in the
 * consumer's tree, where they cannot fix it.
 *
 * Three things make this more than a one-line script:
 *
 * 1. `prepare` also runs for the *root* project on a plain `bun install` here
 *    in the repository. Building then would be wasted work at best, and
 *    recursive at worst (see 2). Being installed as a dependency is what
 *    distinguishes the two cases, and the honest signal for it is that the
 *    package directory sits inside a `node_modules` tree.
 * 2. bun does not install a git dependency's devDependencies, and the whole
 *    toolchain (tsc) is a devDependency — as it should be, a consumer must not
 *    inherit it as a runtime dep. So the git-install path installs them itself,
 *    immediately before the build that needs them.
 * 3. That build cannot run inside the consumer's `node_modules`. Declaration
 *    emit has to name the host's types, and installing the toolchain in place
 *    puts them under paths TypeScript refuses to write into a `.d.ts`
 *    (TS2742, "cannot be named without a reference to ..."). Building in a
 *    scratch directory outside any `node_modules` tree keeps those paths
 *    nameable; it is the same layout the build already runs in during
 *    development and on CI.
 *
 * Deliberately a no-op when `dist/` is already present: repeat installs of the
 * same commit should not pay for a rebuild.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

if (existsSync(join(packageDir, "dist", "index.js"))) {
  process.exit(0);
}

const installedAsDependency = packageDir.split(sep).includes("node_modules");
if (!installedAsDependency) {
  // Developing the repository itself. `bun run build` is a documented step of
  // getting set up (README.md) and stays an explicit one — a `prepare` that
  // silently ran the whole gate on every `bun install` would be a surprise,
  // and the recursive `bun install` below would be a worse one.
  process.exit(0);
}

// The toolchain install below is itself a `bun install`. It no longer runs in
// this directory, but the scratch copy carries this same script, and bun runs
// `prepare` for the root project too — so without a marker the copy would
// start the whole dance again. This breaks that cycle.
const RECURSION_GUARD = "CORBITS_MAILBOX_PREPARE";
if (process.env[RECURSION_GUARD] === "1") {
  process.exit(0);
}

function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, [RECURSION_GUARD]: "1" },
  });
}

console.log("@corbits/mailbox: git install — building dist/");

const buildDir = mkdtempSync(join(tmpdir(), "corbits-mailbox-"));
try {
  cpSync(packageDir, buildDir, {
    recursive: true,
    // `node_modules` is what carries the unnameable layout, so copying it
    // would defeat the point; `dist` is the thing being built.
    filter: (source) => {
      if (source === packageDir) return true;
      const [top] = source.slice(packageDir.length + 1).split(sep);
      return top !== "node_modules" && top !== "dist";
    },
  });

  run("bun", ["install"], buildDir);
  run("bun", ["run", "build"], buildDir);

  cpSync(join(buildDir, "dist"), join(packageDir, "dist"), { recursive: true });
} finally {
  rmSync(buildDir, { recursive: true, force: true });
}
