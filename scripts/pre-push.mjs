#!/usr/bin/env node

/**
 * Pre-push hook — typecheck + test (the real gate).
 * Single-package version of pi-utils/scripts/pre-push.mjs.
 * Skips for docs-only pushes (like previous husky hook).
 */

import { execFileSync } from "node:child_process";

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

function runSilent(command, args) {
  try {
    return {
      status: 0,
      stdout: execFileSync(command, args, { stdio: "pipe", encoding: "utf8", timeout: 300_000 }),
    };
  } catch (err) {
    return {
      status: err.status ?? 1,
      stdout: (err.stdout || "").toString(),
      stderr: (err.stderr || "").toString(),
    };
  }
}

// Read stdin from git (lines of <local_ref> <local_sha> <remote_ref> <remote_sha>)
import { readFileSync } from "node:fs";

let input = "";
try {
  input = readFileSync(0, "utf-8");
} catch {}

const lines = input.trim().split("\n").filter(Boolean);
let changed = "";

for (const line of lines) {
  const [localRef, localSha, remoteRef, remoteSha] = line.split(" ");
  if (!localSha || localSha === "0000000000000000000000000000000000000000") continue; // deletions
  if (localRef && localRef.startsWith("refs/tags/")) {
    changed += " tags";
    continue;
  }
  let range = "";
  if (remoteSha && remoteSha !== "0000000000000000000000000000000000000000") {
    range = `${remoteSha}..${localSha}`;
  } else {
    // New branch: diff against merge-base with origin/HEAD or last commit
    try {
      const base = execFileSync("git", ["merge-base", localSha, "origin/HEAD"], {
        encoding: "utf8",
      }).trim();
      range = `${base}..${localSha}`;
    } catch {
      range = `${localSha}^..${localSha}`;
    }
  }
  try {
    const out = execFileSync("git", ["diff", "--name-only", range], { encoding: "utf8" });
    changed += " " + out;
  } catch {}
}

let nonDocs = false;
for (const f of changed.split(/\s+/).filter(Boolean)) {
  if (!f.endsWith(".md") || f === "tags") {
    nonDocs = true;
    break;
  }
}
if (!nonDocs && changed.trim().length > 0) {
  console.log("pre-push: docs-only change — skipping typecheck + tests");
  process.exit(0);
}
if (changed.trim().length === 0) {
  // No stdin (e.g., manual run) — run full gate
  nonDocs = true;
}

if (nonDocs) {
  console.log("→ pnpm typecheck");
  const tc = runSilent("pnpm", ["typecheck"]);
  if (tc.status !== 0) {
    console.error(tc.stdout + tc.stderr);
    process.exit(1);
  }
  console.log("→ pnpm test");
  const test = runSilent("pnpm", ["test"]);
  // Filter to summary on success
  const out = test.stdout + test.stderr;
  if (test.status !== 0) {
    console.error(out);
    process.exit(1);
  } else {
    // Show summary lines
    const lines = out.split("\n").filter((l) => /Test Files|Tests /.test(l));
    for (const l of lines) console.log(l);
  }
}
