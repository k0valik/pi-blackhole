/**
 * Session-global message indices — the single definition of the `#N` index space.
 *
 * Recall (`src/core/load-messages.ts`) numbers every `type == "message"` entry
 * in session-file order, counting across compaction windows and abandoned
 * branches. Compaction summaries must emit the same numbers, but `normalize`
 * historically numbered the selected window from zero. This module owns the
 * counting rule so both sides agree by construction.
 *
 * Created for the summary/recall index-space fix; not ported from upstream.
 */
import { readFileSync } from "fs";

/** Entries counted by the global `#N` index: persisted message entries. */
export const isCountedMessageEntry = (entry: any): boolean =>
  entry?.type === "message" && entry.message != null;

/**
 * Map session entry ids to their global message index (position among counted
 * message entries in array order, which matches session-file order).
 *
 * Entries without a usable id are still counted (they occupy an index) but
 * produce no map entry. Duplicate ids are ambiguous — dropped fail-closed so
 * callers emit no ref instead of a wrong one (mirrors tool-output-budget).
 */
export const buildGlobalIndexById = (entries: readonly any[]): Map<string, number> => {
  const byId = new Map<string, number>();
  const ambiguous = new Set<string>();
  let messageIndex = 0;
  for (const entry of entries) {
    if (!isCountedMessageEntry(entry)) continue;
    const id = entry?.id;
    if (typeof id === "string" && id.length > 0) {
      if (byId.has(id) || ambiguous.has(id)) {
        byId.delete(id);
        ambiguous.add(id);
      } else {
        byId.set(id, messageIndex);
      }
    }
    messageIndex++;
  }
  return byId;
};

/**
 * Build the same map by parsing a session JSONL file. Malformed lines are
 * skipped silently (load-messages already warns). Returns undefined when the
 * file cannot be read.
 */
export const loadGlobalIndexById = (sessionFile: string): Map<string, number> | undefined => {
  let content: string;
  try {
    content = readFileSync(sessionFile, "utf-8");
  } catch {
    return undefined;
  }
  const entries: any[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Corrupt lines are silently dropped by pi too.
    }
  }
  return buildGlobalIndexById(entries);
};
