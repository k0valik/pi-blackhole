#!/usr/bin/env node

/**
 * Patches the simple-git-hooks generated .git/hooks/pre-push to prevent
 * casual skipping via SKIP_SIMPLE_GIT_HOOKS=1.
 * Mirrors pi-utils/scripts/patch-pre-push-hook.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const hookPath = join(import.meta.dirname, "..", ".git", "hooks", "pre-push");

let content;
try {
  content = readFileSync(hookPath, "utf-8");
} catch {
  process.exit(0);
}

const patched = content.replace(
  'if [ "$SKIP_SIMPLE_GIT_HOOKS" = "1" ]; then',
  `if [ "$SKIP_SIMPLE_GIT_HOOKS" = "1" ] && [ "$SKIP_PRE_PUSH_ALLOWED" != "1" ]; then
    echo "❌ SKIP_SIMPLE_GIT_HOOKS=1 is NOT enough to skip pre-push."
    echo "   The pre-push hook runs typecheck + test."
    echo "   To skip it deliberately, use: SKIP_SIMPLE_GIT_HOOKS=1 SKIP_PRE_PUSH_ALLOWED=1 git push"
    exit 1
  elif [ "$SKIP_SIMPLE_GIT_HOOKS" = "1" ] && [ "$SKIP_PRE_PUSH_ALLOWED" = "1" ]; then`,
);

if (content !== patched) {
  writeFileSync(hookPath, patched);
  console.log("[patch-pre-push-hook] Patched pre-push hook to require SKIP_PRE_PUSH_ALLOWED=1");
}
