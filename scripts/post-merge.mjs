#!/usr/bin/env node

/**
 * post-merge / post-checkout hook — reinstall dependencies if needed.
 * Mirrors pi-utils/scripts/post-merge.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

function run(command, args, env = {}) {
  execFileSync(command, args, { stdio: "inherit", env: { ...process.env, ...env } });
}

if (
  existsSync(".git/MERGE_HEAD") ||
  existsSync(".git/REBASE_HEAD") ||
  existsSync(".git/CHERRY_PICK_HEAD")
) {
  process.exit(0);
}

let lockfileChanged = false;
try {
  const diff = execFileSync(
    "git",
    ["diff", "--name-only", "ORIG_HEAD", "HEAD", "--", "pnpm-lock.yaml"],
    { encoding: "utf-8" },
  ).trim();
  lockfileChanged = diff.length > 0;
} catch {}

if (lockfileChanged) {
  console.log("→ post-merge: pnpm install (lockfile changed)");
  run("pnpm", ["install"], { BUILD_QUIET: "1" });
}
