// Build the bundled entry on install; git installs include tsup as a dependency.
// Git hook installation remains best-effort for development checkouts.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const isWindows = process.platform === "win32";
const bin = (name) => join(root, "node_modules", ".bin", isWindows ? `${name}.cmd` : name);

// 1. Build dist using the local toolchain.
// Installer-agnostic: works under pnpm, bun, npm. Pi never calls build after
// install — only `prepare` does. Windows needs shell:true for .cmd shims.
const tsup = bin("tsup");
if (existsSync(tsup)) {
  const r = spawnSync(tsup, [], { cwd: root, stdio: "inherit", shell: isWindows });
  if (r.status !== 0) {
    console.error("[prepare] tsup build failed");
    process.exit(r.status ?? 1);
  }
} else {
  console.error("[prepare] tsup not found; cannot build dist/index.js");
  process.exit(1);
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
