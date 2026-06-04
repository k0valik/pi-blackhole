import { readFileSync, statSync } from "fs";
import type { Message } from "@earendil-works/pi-ai";
import { renderMessage, type RenderedEntry } from "./render-entries";

export interface LoadedMessages {
  rendered: RenderedEntry[];
  rawMessages: Message[];
  entryIds: string[];
}

// ── Session-file cache (LRU, invalidated by mtime) ─────────────────────────

interface CacheEntry {
  result: LoadedMessages;
  mtimeMs: number;
  timestamp: number;
}

const MAX_CACHE_SIZE = 3;
const CACHE_TTL_MS = 2_000;
const cache = new Map<string, CacheEntry>();

function cacheKey(sessionFile: string, full: boolean, allowedEntryIds: Set<string> | undefined): string {
  let hash = `${sessionFile}::${full}`;
  if (allowedEntryIds && allowedEntryIds.size > 0) {
    // Include the full set as sorted JSON for collision-free caching
    hash += `::${JSON.stringify([...allowedEntryIds].sort())}`;
  }
  return hash;
}

function getCached(sessionFile: string, full: boolean, allowedEntryIds?: Set<string>): LoadedMessages | undefined {
  const key = cacheKey(sessionFile, full, allowedEntryIds);
  const entry = cache.get(key);
  if (!entry) return undefined;

  // Check TTL (mtime-based invalidation)
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }

  // Verify file mtime hasn't changed
  try {
    const mtimeMs = statSync(sessionFile).mtimeMs;
    if (mtimeMs !== entry.mtimeMs) {
      cache.delete(key);
      return undefined;
    }
  } catch {
    cache.delete(key);
    return undefined;
  }

  return entry.result;
}

function setCache(sessionFile: string, full: boolean, allowedEntryIds: Set<string> | undefined, result: LoadedMessages): void {
  // Evict oldest if at capacity
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = cache.entries().next();
    if (!oldest.done) cache.delete(oldest.value[0]);
  }

  try {
    const mtimeMs = statSync(sessionFile).mtimeMs;
    const key = cacheKey(sessionFile, full, allowedEntryIds);
    cache.set(key, { result, mtimeMs, timestamp: Date.now() });
  } catch {
    // Can't stat the file — don't cache
  }
}

export const loadAllMessages = (
  sessionFile: string,
  full: boolean,
  allowedEntryIds?: Set<string>,
): LoadedMessages => {
  // Check cache first (same sessionFile + full flag + lineage size — approximate)
  const cached = getCached(sessionFile, full, allowedEntryIds);
  if (cached) return cached;

  const content = readFileSync(sessionFile, "utf-8");
  const entries: any[] = [];
  let parseErrors = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { parseErrors++; }
  }
  if (parseErrors > 0) {
    console.warn(`blackhole: ${parseErrors} malformed JSONL line(s) in ${sessionFile}`);
  }
  const rendered: RenderedEntry[] = [];
  const rawMessages: Message[] = [];
  const entryIds: string[] = [];

  let messageIndex = 0;
  for (const e of entries) {
    const isMessage = e.type === "message" && e.message;
    if (!isMessage) continue;

    const allowed = !allowedEntryIds || allowedEntryIds.has(e.id);
    if (allowed) {
      const entryId = e.id != null ? String(e.id) : "";
      rendered.push(renderMessage(e.message, messageIndex, entryId, full));
      rawMessages.push(e.message);
      entryIds.push(entryId);
    }
    messageIndex++;
  }

  const result: LoadedMessages = { rendered, rawMessages, entryIds };
  setCache(sessionFile, full, allowedEntryIds, result);
  return result;
};
