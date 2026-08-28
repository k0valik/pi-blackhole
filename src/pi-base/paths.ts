import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let lastEnvVal: string | undefined = undefined;
let cachedPiAgentDir: string | null = null;
let cachedVitestExtensionsDir: string | undefined;

/**
 * Per-process temp extensions dir for vitest.
 *
 * Uniquely created per process (not a fixed shared path) so concurrent
 * vitest projects and repeated test runs cannot read or overwrite each
 * other's state. Stable within the process for deterministic assertions.
 *
 * Best-effort cleanup: removed when the worker process exits normally.
 */
function vitestExtensionsDir(): string {
  const existing = cachedVitestExtensionsDir;
  if (existing) return existing;
  const dir = mkdtempSync(join(tmpdir(), "pi-agent-extensions-"));
  cachedVitestExtensionsDir = dir;
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Get the root directory for pi-agent data.
 * Optimized with in-memory memoization that detects environmental updates.
 */
export function getPiAgentDir(): string {
  const currentEnvVal = process.env.PI_CODING_AGENT_DIR;
  if (cachedPiAgentDir !== null && currentEnvVal === lastEnvVal) {
    return cachedPiAgentDir;
  }
  lastEnvVal = currentEnvVal;
  cachedPiAgentDir = currentEnvVal?.trim() || getAgentDir();
  return cachedPiAgentDir;
}

/** Reset the cached pi-agent directory. Exposed for testing. */
export function resetPiAgentDirCache(): void {
  cachedPiAgentDir = null;
  lastEnvVal = undefined;
}

/**
 * Canonical config directory: ~/.pi/agent/extensions/
 *
 * In vitest, when `PI_CODING_AGENT_DIR` is not explicitly set, this
 * resolves to a unique per-process temporary directory under `os.tmpdir()`
 * instead of the real user's home. This prevents tests from accidentally
 * reading or writing to `~/.pi/agent/extensions/` — and, because each
 * vitest worker process gets its own directory, test runs cannot pollute
 * each other's or later runs' state.
 */
export function getExtensionsDir(): string {
  if (process.env.VITEST === "true" && !process.env.PI_CODING_AGENT_DIR) {
    return vitestExtensionsDir();
  }
  return join(getPiAgentDir(), "extensions");
}

/**
 * Shorten a working directory path by replacing the user's home directory
 * prefix with `~`. Returns the path unchanged if not under $HOME.
 *
 * @param cwd  The current working directory to shorten
 * @param home Optional home directory override (defaults to `$HOME`)
 */
export function shortCwd(cwd: string, home?: string): string {
  const h = (home ?? process.env.HOME ?? process.env.USERPROFILE ?? "").replace(/[\\/]+$/, "");
  if (!h) return cwd;
  if (cwd === h) return "~";
  const sep = h.includes("\\") ? "\\" : "/";
  if (cwd.startsWith(h + sep)) {
    return `~${cwd.slice(h.length)}`;
  }
  return cwd;
}
