/**
 * Git working-tree status for file grounding in [Files And Changes].
 *
 * Ported from k0valik/pi-files-touched (files-entries.ts) — porcelain v1
 * `-z` parsing including rename/copy entry pairs — reduced to what the
 * summary needs: one word tag per absolute path.
 *
 * Runs only at compaction time (via before-compact → buildSections), once,
 * synchronously with a bounded `execFileSync`; any failure (no git, not a
 * repo) yields an empty map and no annotations — fail-closed.
 */
import { execFileSync } from "node:child_process";

/** Normalize separators for stable map keys. */
const normalizeKey = (p: string): string => p.replace(/\\/g, "/");

/** Strip trailing read-slice suffixes so lookups survive "path:10-40" forms. */
const stripReadSliceSuffix = (p: string): string => p.replace(/:(\d+)-(\d+)$/, "");

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/**
 * Map a raw XY porcelain status to a display tag.
 * X = staged column, Y = unstaged column (see `git status --porcelain` docs).
 */
export const tagFromPorcelain = (xy: string): string | null => {
  const x = xy[0] ?? " ";
  const y = xy[1] ?? " ";

  if (xy === "??") return "new";
  if (x === "!" || y === "!") return null; // ignored files — never annotate
  if (CONFLICT_CODES.has(`${x}${y}`)) return "conflicted";
  if (x === "R" || x === "C") return "renamed";
  if (x === "D" || y === "D") return "deleted";

  const tags: string[] = [];
  if (x !== " ") tags.push("staged");
  if (y !== " ") tags.push("unstaged");
  return tags.length > 0 ? tags.join(",") : null;
};

const splitNullSeparated = (value: string): string[] => value.split("\0").filter(Boolean);

/**
 * Collect git working-tree status tags for `cwd`'s repo.
 * Keys are absolute normalized paths; values are display tags
 * ("staged", "unstaged", "staged,unstaged", "new", "renamed", "deleted",
 * "conflicted").
 */
export const loadGitFileTags = (cwd: string): Map<string, string> => {
  const tags = new Map<string, string>();

  let gitRoot: string;
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!root) return tags;
    gitRoot = root;
  } catch {
    return tags; // not a repo, no git binary, or git refused — no annotations
  }

  let stdout: string;
  try {
    stdout = execFileSync("git", ["status", "--porcelain=1", "-z"], {
      cwd: gitRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return tags;
  }
  if (!stdout) return tags;

  const entries = splitNullSeparated(stdout);
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    if (!status.trim()) continue;
    // Porcelain v1 -z rename/copy format: XY new_path \0 old_path \0 —
    // entry.slice(3) is already the new path; skip the old-path entry.
    let filePath = entry.slice(3);
    if ((status.startsWith("R") || status.startsWith("C")) && entries[i + 1]) {
      i += 1;
    }
    if (!filePath) continue;

    const absolute = `${gitRoot.replace(/\/$/, "")}/${filePath}`;
    const tag = tagFromPorcelain(status);
    if (tag) tags.set(normalizeKey(stripReadSliceSuffix(absolute)), tag);
  }

  return tags;
};
