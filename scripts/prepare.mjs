// Build the bundled entry on install; git installs include tsup as a dependency.
// Git hook installation remains best-effort for development checkouts.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const root = join(import.meta.dirname, "..");
const isWindows = process.platform === "win32";
const bin = (name) => join(root, "node_modules", ".bin", isWindows ? `${name}.cmd` : name);

// Published packages already include their compiled bundle. Git checkouts must
// build it, including when Pi removes ignored files during an update.
if (!existsSync(join(root, ".git")) && existsSync(join(root, "dist", "index.js"))) {
  process.exit(0);
}
const require = createRequire(import.meta.url);
let tsup;
try {
  const manifest = require.resolve("tsup/package.json");
  const { bin: commands } = JSON.parse(readFileSync(manifest, "utf8"));
  tsup = join(dirname(manifest), commands.tsup);
} catch (error) {
  console.error(`[prepare] cannot resolve tsup: ${error.message}`);
  process.exit(1);
}
const result = spawnSync(process.execPath, [tsup], { cwd: root, stdio: "inherit" });
if (result.error || result.status !== 0) {
  console.error(`[prepare] tsup build failed${result.error ? `: ${result.error.message}` : ""}`);
  process.exit(result.status ?? 1);
}

// 2. Git hooks, best-effort (only meaningful in a dev checkout).
const sgh = bin("simple-git-hooks");
if (existsSync(sgh)) {
  let r = spawnSync(sgh, [], { cwd: root, stdio: "inherit", shell: isWindows });
  if (r.status !== 0) {
    console.warn(`[prepare] simple-git-hooks skipped (non-fatal): exit ${r.status}`);
  } else {
    // Patch pre-push hook
    const patch = join(root, "scripts", "patch-pre-push-hook.mjs");
    if (existsSync(patch)) {
      r = spawnSync("node", [patch], { cwd: root, stdio: "inherit", shell: isWindows });
      if (r.status !== 0) console.warn(`[prepare] patch-pre-push-hook skipped: exit ${r.status}`);
    }
  }
}
