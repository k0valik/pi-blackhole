// Best-effort build hook. Runs via `prepare` on install (dev clones, git deps)
// and on pack/publish. Designed to NEVER break a consumer install:
//
//   - tsup present  → build dist/ (real build errors still fail loudly —
//                     that's a dev/CI bug, not a consumer environment issue)
//   - tsup missing  → skip silently. Registry consumers never run this
//                     script at all; git consumers without devDependencies
//                     fall back to index.ts via pi-entry.js at load time.
//   - pi-entry.js is the committed entrypoint: it loads dist/index.js when
//                     present (fast) or falls back to index.ts (slow but robust).
//                     So `pi.extensions` can safely be a JS entry without
//                     breaking `git clone` before `prepare` runs. Pi runs
//                     `npm install --omit=dev` for git deps by default, so
//                     tsup is often missing — the fallback handles that.
//   - simple-git-hooks present → (re)install git hooks, best-effort (dev checkouts only)
//   - Also patches pre-push hook to require SKIP_PRE_PUSH_ALLOWED
//
// Zero runtime dependencies: plain node, no pnpm/npm/bun requirement.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const isWindows = process.platform === "win32";
const bin = (name) => join(root, "node_modules", ".bin", isWindows ? `${name}.cmd` : name);

// 1. Build dist when the toolchain is available.
// Installer-agnostic: works under pnpm, bun, npm. Pi never calls build after
// install — only `prepare` does. Windows needs shell:true for .cmd shims.
const tsup = bin("tsup");
if (existsSync(tsup)) {
  const r = spawnSync(tsup, [], { cwd: root, stdio: "inherit", shell: isWindows });
  if (r.status !== 0) {
    console.error("[prepare] tsup build failed");
    process.exit(r.status ?? 1);
  }
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
