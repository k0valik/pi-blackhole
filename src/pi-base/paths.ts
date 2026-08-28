import { getAgentDir } from "@earendil-works/pi-coding-agent";

let lastEnvVal: string | undefined = undefined;
let cachedPiAgentDir: string | null = null;

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

/**
 * Shorten a working directory path by replacing the user's home directory
 * prefix with `~`. Returns the path unchanged if not under $HOME.
 *
 * @param cwd  The current working directory to shorten
 * @param home Optional home directory override (defaults to `$HOME`)
 */
