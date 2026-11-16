import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * Resolve the physical path of `dir` even when `dir` (or several trailing
 * segments) does not exist yet, by canonicalizing the nearest existing ancestor
 * and re-attaching the unresolved suffix. Returns `undefined` if no existing
 * ancestor can be established.
 */
function resolvePhysicalPath(dir: string): string | undefined {
  const abs = resolve(dir);
  let cur = abs;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
  const realBase = realpathSync(cur);
  const suffix = relative(cur, abs);
  return suffix ? join(realBase, suffix) : realBase;
}

/**
 * Test-only guard for agent directories that tests write to and delete.
 *
 * Pi exports PI_CODING_AGENT_DIR (normally ~/.pi/agent) to every child
 * process, so a test run started by a Pi agent inherits the user's real agent
 * dir. Several suites `rmSync(testDir, { recursive: true })` after each test,
 * so a dir is only acceptable when it is strictly inside the OS temp dir and
 * not shaped like a real agent dir (see below).
 */
export function isSafeTestAgentDir(dir: string | undefined, tmpRoot = tmpdir()): boolean {
  if (!dir) return false;
  const roots = new Set([resolve(tmpRoot)]);
  if (existsSync(tmpRoot)) roots.add(realpathSync(tmpRoot));
  // Judge by physical containment so a symlink inside the temp dir cannot
  // redirect a recursive delete—even for a not-yet-created child beneath it.
  const candidate = resolvePhysicalPath(dir);
  if (!candidate) return false;
  // Even under the temp root, anything inside a `.pi` tree is never
  // acceptable: a runner could point TMPDIR at ~/.pi (or deeper), or a future
  // test could rebuild the real layout under tmp. The worst-case blast radius
  // must be a `pi-blackhole` subfolder, never anything that looks like Pi
  // state.
  for (const segment of candidate.split(sep)) {
    if (segment === ".pi") return false;
  }
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
