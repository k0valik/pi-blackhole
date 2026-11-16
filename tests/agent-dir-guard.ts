import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";

/**
 * Test-only guard for agent directories that tests write to and delete.
 *
 * Pi exports PI_CODING_AGENT_DIR (normally ~/.pi/agent) to every child
 * process, so a test run started by a Pi agent inherits the user's real agent
 * dir. Several suites `rmSync(testDir, { recursive: true })` after each test,
 * so a dir is only acceptable when it is strictly inside the OS temp dir.
 */
export function isSafeTestAgentDir(dir: string | undefined, tmpRoot = tmpdir()): boolean {
  if (!dir) return false;
  const roots = new Set([resolve(tmpRoot)]);
  if (existsSync(tmpRoot)) roots.add(realpathSync(tmpRoot));
  // An existing path is judged by where it really points, so a symlink inside
  // the temp dir cannot redirect a recursive delete somewhere else.
  const candidate = existsSync(dir) ? realpathSync(dir) : resolve(dir);
  for (const root of roots) {
    if (candidate.startsWith(root + sep)) return true;
  }
  return false;
}

/** Throw before a suite can write to or delete a directory outside the temp dir. */
export function assertSafeTestAgentDir(dir: string | undefined): string {
  if (!dir || !isSafeTestAgentDir(dir)) {
    throw new Error(
      `refusing to use test agent dir outside ${tmpdir()}: ${dir ?? "(unset)"}. ` +
        "Tests delete this directory; run them without an inherited PI_CODING_AGENT_DIR.",
    );
  }
  return dir;
}
