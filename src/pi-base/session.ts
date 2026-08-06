// Session file tree-walking utilities.

import type {
  FileEntry,
  SessionEntry,
  SessionEntryBase,
} from "@earendil-works/pi-coding-agent";

/**
 * Resolve the active branch path using PI's append-only tree semantics.
 *
 * The active branch is the path from the **last entry** (current leaf)
 * back to the root via `parentId`. This follows PI's tree structure where
 * entries are append-only and the last entry in the file is always the
 * current leaf of the active branch.
 */
export function getActiveBranchEntries(entries: FileEntry[]): SessionEntry[] {
  const sessionEntries = entries.filter(
    (e): e is SessionEntry => e.type !== "session",
  );
  const byId = new Map(sessionEntries.map((entry) => [entry.id, entry]));
  const leaf = sessionEntries.at(-1);
  if (!leaf) return [];

  const path: SessionEntry[] = [];
  const visited = new Set<string>();
  let current: SessionEntry | undefined = leaf;
  while (current) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

/**
 * Build a lookup Map from entry id to parent id, filtering out the
 * session header (which has no id/parentId).
 */
export function buildParentIdMap(
  entries: FileEntry[],
): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const entry of entries) {
    if (entry.type === "session") continue;
    const base = entry as SessionEntryBase;
    map.set(base.id, base.parentId ?? null);
  }
  return map;
}

/**
 * Walk from `leafId` up through `parentId` to the root, returning the
 * ancestor chain. Stops at root (parentId null) or if a cycle is detected.
 *
 * Returns the chain from leaf to root (leaf first, root last).
 * Returns empty array if `leafId` is not found in `entries`.
 *
 * Accepts `FileEntry[]` — the raw session entries including the header.
 * The header (which lacks id/parentId) is ignored automatically.
 */
export function getAncestorChain(
  entries: FileEntry[],
  leafId: string,
): string[] {
  const byId = new Map<string, { id: string; parentId: string | null }>();
  for (const entry of entries) {
    // Skip session header — it has no id/parentId
    if (entry.type === "session") continue;
    // All non-header entries share id/parentId via SessionEntryBase;
    // construct the shape explicitly instead of casting the union.
    byId.set(entry.id, { id: entry.id, parentId: entry.parentId ?? null });
  }

  const chain: string[] = [];
  let current = byId.get(leafId);
  const visited = new Set<string>();

  while (current) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    chain.push(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return chain;
}
