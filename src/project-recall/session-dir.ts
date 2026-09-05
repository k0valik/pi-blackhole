/**
 * Project session-dir helpers — git-root anchored project identity.
 * plan-07 §13 risk 1 mitigation: attribution via session header cwd against
 * the git root (or bare cwd outside a repo), not scope-dir name encoding,
 * so moved/renamed project roots keep their history attributable.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface FindGitRootResult {
  root: string | null;
  warning?: string;
}

/** Absolute path of the enclosing git worktree top-level, or null. */
export async function findGitRoot(cwd: string): Promise<FindGitRootResult> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      timeout: 5000,
    });
    const root = stdout.trim();
    return { root: root || null };
  } catch (error) {
    const errnoError = error as NodeJS.ErrnoException;
    if (errnoError.code === "ENOENT" || errnoError.code === "EAGAIN") {
      const message = errnoError.message ?? String(error);
      return {
        root: null,
        warning: `[pi-blackhole] git lookup failed for ${cwd}: ${message}; falling back to cwd-only scoping`,
      };
    }
    return { root: null };
  }
}
