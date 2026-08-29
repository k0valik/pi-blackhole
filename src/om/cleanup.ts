/**
 * Cleanup utility — scans pending JSON files and cross-references against
 * session JSONL files to find orphaned entries safe to delete.
 *
 * Per-session pending files under ~/.pi/agent/pi-blackhole/ accumulate when:
 * - compaction is set to "manual" — OM outputs are
 *   buffered rather than appended to the session
 * - sessions are forked, abandoned, or deleted — the pending files remain
 * - stale backup files (-pending.stale.json) persist after write-safe renames
 *
 * Safety invariant: a pending file is ONLY orphaned if its sessionId does NOT
 * appear in ANY session JSONL file across all known session directories.
 */
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ── Types ───────────────────────────────────────────────────────────────────

export interface PendingFile {
  sessionId: string;
  filename: string;
  path: string;
  /** True for -pending.stale.json (backup of previous write). */
  isStale: boolean;
  sizeBytes: number;
  /** Last modified timestamp (epoch ms). */
  mtimeMs: number;
}

export interface CleanupReport {
  /** All pending files found (both pending and stale). */
  all: PendingFile[];
  /** Files whose sessionId does not appear in any session JSONL. */
  orphaned: PendingFile[];
  /** Files whose sessionId was matched to an active session. */
  active: PendingFile[];
}

// ── Constants ───────────────────────────────────────────────────────────────

const PENDING_DIR = "pi-blackhole";
const PENDING_SUFFIX = "-pending.json";
const STALE_SUFFIX = "-pending.stale.json";

// ── Helper: extract session ID from filename ────────────────────────────────

function extractSessionId(filename: string): string | null {
  if (filename.endsWith(STALE_SUFFIX)) {
    return filename.slice(0, -STALE_SUFFIX.length) || null;
  }
  if (filename.endsWith(PENDING_SUFFIX)) {
    return filename.slice(0, -PENDING_SUFFIX.length) || null;
  }
  return null;
}

// ── Scan pending files ──────────────────────────────────────────────────────

/**
 * Scan the pi-blackhole directory for all *-pending.json and *-pending.stale.json
 * files. Returns file metadata sorted by mtime (newest first).
 */
function scanPendingFiles(agentDir: string = getAgentDir()): PendingFile[] {
  const dir = join(agentDir, PENDING_DIR);
  if (!existsSync(dir)) return [];

  const results: PendingFile[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  for (const filename of entries) {
    const sessionId = extractSessionId(filename);
    if (!sessionId) continue;

    const filePath = join(dir, filename);
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      continue; // file disappeared between readdir and stat
    }

    results.push({
      sessionId,
      filename,
      path: filePath,
      isStale: filename.endsWith(STALE_SUFFIX),
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }

  // Sort: newest first
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}

// ── Scan session IDs from JSONL files ───────────────────────────────────────

/**
 * Recursively scan a directory for .jsonl files and extract session IDs from
 * their header line (first line: {"type":"session","id":"<uuid>",...}).
 */
function scanSessionDir(dir: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(dir)) return ids;

  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      continue;
    }

    for (const name of names) {
      const fullPath = join(current, name);
      let st;
      try {
        st = statSync(fullPath);
      } catch {
        continue;
      }

      if (st.isDirectory()) {
        stack.push(fullPath);
      } else if (st.isFile() && name.endsWith(".jsonl")) {
        try {
          const fd = readFileSync(fullPath, "utf-8");
          const newlineIdx = fd.indexOf("\n");
          const firstLine = newlineIdx >= 0 ? fd.slice(0, newlineIdx) : fd;
          const header = JSON.parse(firstLine) as Record<string, unknown>;
          if (header.type === "session" && typeof header.id === "string" && header.id.length > 0) {
            ids.add(header.id);
          }
        } catch {
          // Corrupt or unreadable file — skip
        }
      }
    }
  }

  return ids;
}

/**
 * Read sessionDir override from settings.json, if any.
 * Returns the resolved absolute path, or undefined if not set or unreadable.
 */
function readSettingsSessionDir(): string | undefined {
  try {
    const settingsPath = join(getAgentDir(), "settings.json");
    if (!existsSync(settingsPath)) return undefined;
    const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    const dir = raw.sessionDir;
    if (typeof dir === "string" && dir.trim().length > 0) {
      // Expand ~ if present
      const expanded = dir.startsWith("~") ? join(process.env.HOME ?? "/home", dir.slice(2)) : dir;
      return resolve(expanded);
    }
  } catch {
    // Unreadable settings — use default
  }
  return undefined;
}

/**
 * Find all known session directories.
 * Always includes the default sessions dir; also includes custom sessionDir
 * from settings.json if present and different from the default.
 */
/** Get the default sessions directory. */
function getDefaultSessionsDir(): string {
  return join(getAgentDir(), "sessions");
}

function findSessionDirs(): string[] {
  const dirs: string[] = [];
  const default_ = getDefaultSessionsDir();
  dirs.push(default_);

  const custom = readSettingsSessionDir();
  if (custom && custom !== default_ && existsSync(custom)) {
    dirs.push(custom);
  }

  return dirs;
}

/**
 * Collect all session IDs from all known session directories.
 * Returns a Set of session UUIDs found in JSONL headers.
 */
function collectAllSessionIds(sessionDirs?: string[]): Set<string> {
  const dirs = sessionDirs ?? findSessionDirs();
  const allIds = new Set<string>();
  for (const dir of dirs) {
    const ids = scanSessionDir(dir);
    for (const id of ids) allIds.add(id);
  }
  return allIds;
}

// ── Cross-reference: find orphaned files ────────────────────────────────────

/**
 * Determine which pending files are orphaned (no matching session JSONL).
 *
 * A pending file is orphaned when no session JSONL in any known session
 * directory declares the same session ID in its header.
 *
 * Returns the full report with all files classified.
 */
function crossReference(pending: PendingFile[], sessionIds: Set<string>): CleanupReport {
  const orphaned: PendingFile[] = [];
  const active: PendingFile[] = [];

  for (const pf of pending) {
    if (sessionIds.has(pf.sessionId)) {
      active.push(pf);
    } else {
      orphaned.push(pf);
    }
  }

  return { all: pending, orphaned, active };
}

/**
 * Full pipeline: scan pending files, collect session IDs, cross-reference.
 * Returns the cleanup report.
 */
export function analyzeOrphaned(agentDir?: string, sessionDirs?: string[]): CleanupReport {
  const pending = scanPendingFiles(agentDir);
  if (pending.length === 0) {
    return { all: [], orphaned: [], active: [] };
  }
  const sessionIds = collectAllSessionIds(sessionDirs);
  return crossReference(pending, sessionIds);
}

// ── Deletion ────────────────────────────────────────────────────────────────

/** Session IDs are UUIDs or similar alphanumeric+hyphen strings. */
const SAFE_SESSION_ID_RE = /^[a-zA-Z0-9][-a-zA-Z0-9]*$/;

/**
 * Validate that resolving and joining with `sessionId` cannot escape the
 * pi-blackhole directory.  Must be called before any unlink.
 */
function validateDeletionPaths(
  sessionId: string,
  pendingDir: string,
): { ok: true; pendingPath: string; stalePath: string } | { ok: false } {
  // sessionId must be non-empty and contain only safe filesystem characters
  if (!sessionId || typeof sessionId !== "string") return { ok: false };
  if (!SAFE_SESSION_ID_RE.test(sessionId)) return { ok: false };

  const resolvedDir = resolve(pendingDir);
  const pendingPath = join(resolvedDir, `${sessionId}${PENDING_SUFFIX}`);
  const stalePath = join(resolvedDir, `${sessionId}${STALE_SUFFIX}`);

  // Resolve to absolute and verify containment within pi-blackhole/
  const resolvedPending = resolve(pendingPath);
  const resolvedStale = resolve(stalePath);

  if (!resolvedPending.startsWith(resolvedDir + sep)) return { ok: false };
  if (!resolvedStale.startsWith(resolvedDir + sep)) return { ok: false };

  return { ok: true, pendingPath: resolvedPending, stalePath: resolvedStale };
}

/**
 * Delete all pending files (pending + stale) for a given sessionId.
 *
 * Safety: validates that both resolved paths live under the pi-blackhole/
 * directory before unlinking.  Returns false if validation fails.
 *
 * Returns true if at least one file was deleted, false if no files existed
 * or if the paths failed containment validation.
 */
export function deletePendingFiles(sessionId: string, agentDir?: string): boolean {
  const dir = join(agentDir ?? getAgentDir(), PENDING_DIR);
  const valid = validateDeletionPaths(sessionId, dir);
  if (!valid.ok) return false;

  const { pendingPath, stalePath } = valid;

  let deleted = false;

  try {
    if (existsSync(pendingPath)) {
      unlinkSync(pendingPath);
      deleted = true;
    }
  } catch {
    // Best-effort — file may be locked or already gone
  }

  try {
    if (existsSync(stalePath)) {
      unlinkSync(stalePath);
      deleted = true;
    }
  } catch {
    // Best-effort
  }

  return deleted;
}

/**
 * Delete multiple pending files by sessionId.
 * Returns the count of successfully deleted file sets.
 */
export function deleteOrphanedBatch(orphaned: PendingFile[], agentDir?: string): number {
  let count = 0;
  for (const pf of orphaned) {
    if (deletePendingFiles(pf.sessionId, agentDir)) {
      count++;
    }
  }
  return count;
}

// ── Formatting helpers ──────────────────────────────────────────────────────

/** Human-readable file size. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Human-readable age from epoch ms. */
function formatAge(mtimeMs: number, nowMs: number = Date.now()): string {
  const diffMs = nowMs - mtimeMs;
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

/** Summary line for a pending file. */
export function describeFile(pf: PendingFile, nowMs?: number): string {
  const label = pf.isStale ? "stale" : "pending";
  return `${pf.sessionId.slice(0, 8)}… ${label}  ${formatSize(pf.sizeBytes)}  ${formatAge(pf.mtimeMs, nowMs)}`;
}
