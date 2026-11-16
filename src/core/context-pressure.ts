import { isToolSafeCut } from "./tool-safe-cut.js";
import type { Entry } from "../om/ledger/types.js";
import { estimateEntryTokens } from "../om/tokens.js";

export type PressureTailResult =
  | { ok: true; firstKeptEntryId: string; bridgedIds: string[] }
  | { ok: false; reason: "unknown_capacity" | "invalid_anchor" | "no_safe_fit" };

/** Policy-independent fallback: the caller owns summary rendering and supplies
 * its cost at each candidate. Never treats a VCC bridge as observed coverage.
 * Whole user turns bound tool interactions conservatively; if the newest turn
 * is too large, defer rather than silently stripping messages or tool results.
 */
export function selectPressureTail(input: {
  entries: Entry[];
  firstKeptEntryId: string;
  contextWindow?: number;
  reserveTokens: number;
  keepRecentTokens: number;
  summaryTokens: (firstKeptEntryId: string) => number;
}): PressureTailResult {
  const { entries, contextWindow, reserveTokens, keepRecentTokens } = input;
  if (
    !contextWindow ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0 ||
    !Number.isFinite(reserveTokens) ||
    reserveTokens < 0 ||
    !Number.isFinite(keepRecentTokens) ||
    keepRecentTokens < 0
  ) {
    return { ok: false, reason: "unknown_capacity" };
  }
  const capacity = contextWindow - reserveTokens;
  const start =
    input.firstKeptEntryId === ""
      ? entries.length
      : entries.findIndex((entry) => entry.id === input.firstKeptEntryId);
  if (start < 0) return { ok: false, reason: "invalid_anchor" };
  const tailTokens = (index: number) =>
    entries.slice(index).reduce((sum, entry) => sum + estimateEntryTokens(entry), 0);
  const preferred = tailTokens(start) + input.summaryTokens(input.firstKeptEntryId);
  if (preferred <= capacity)
    return { ok: true, firstKeptEntryId: input.firstKeptEntryId, bridgedIds: [] };
  for (let index = start + 1; index < entries.length; index++) {
    const entry = entries[index];
    if (
      entry.type !== "message" ||
      !entry.message ||
      typeof entry.message !== "object" ||
      !("role" in entry.message) ||
      entry.message.role !== "user"
    )
      continue;
    if (!isToolSafeCut(entries, index)) continue;
    const rawTokens = tailTokens(index);
    if (rawTokens > keepRecentTokens || rawTokens + input.summaryTokens(entry.id) > capacity)
      continue;
    // Branch summaries are blackhole-authored compaction context that does not
    // pass through VCC's message interface — do not silently bridge one.
    // custom_message entries are main-model-facing extension injections; normal
    // compaction already drops them (they never survive into the summarized
    // branch), so they no longer block a bridge either.
    if (entries.slice(start, index).some((source) => source.type === "branch_summary")) continue;
    return {
      ok: true,
      firstKeptEntryId: entry.id,
      bridgedIds: entries
        .slice(start, index)
        .filter((source) => source.type === "message")
        .map((source) => source.id),
    };
  }
  return { ok: false, reason: "no_safe_fit" };
}
