/**
 * Token estimation for serialized entries.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (src/tokens.ts)
 * Amended: estimateStringTokens is CJK-script aware (#106) — upstream and the
 * original copy here used `ceil(chars/4)`, which under-counts CJK text ~3x
 * (CJK ideographs/kana/hangul are ~1 token/char in BPE vocabularies).
 *
 * Amended: usage-aware helpers (hasUsageData, getUsageTokens) — real-usage
 * measurement core (approach: tavasti@360f24a, pi-vcc upstream PR #40).
 */
import {
  calculateContextTokens,
  estimateTokens as estimateMessageTokens,
} from "@earendil-works/pi-coding-agent";
import { cjkScriptStats } from "../core/segment.js";

export function estimateStringTokens(text: string): number {
  const { count, units } = cjkScriptStats(text);
  return Math.ceil(count + (text.length - units) / 4);
}

export function hasUsageData(msg: unknown): boolean {
  return getUsageTokens(msg) !== undefined;
}

/**
 * Extract real usage token count from an assistant message.
 *
 * Only trusted when the message is a real assistant response:
 * - role must be "assistant" (never toolResult — ToolResultMessage.usage
 *   reflects tool execution, not LLM context accounting)
 * - stopReason must not be "error" or "aborted" (failed turns carry
 *   misleading usage)
 *
 * Never throws; returns undefined when usage is missing, zero, or not finite.
 */
export function getUsageTokens(msg: unknown): number | undefined {
  if (typeof msg !== "object" || msg === null) return undefined;
  const record = msg as Record<string, unknown>;
  if (record.role !== "assistant") return undefined;
  if (record.stopReason === "error" || record.stopReason === "aborted") return undefined;
  if (record.usage === undefined) return undefined;
  try {
    const tokens = calculateContextTokens(
      record.usage as Parameters<typeof calculateContextTokens>[0],
    );
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return undefined;
    return tokens;
  } catch {
    return undefined;
  }
}

export function estimateEntryTokens(entry: {
  type: string;
  message?: unknown;
  content?: unknown;
  summary?: unknown;
}): number {
  if (entry.type === "message" && entry.message) {
    return estimateMessageTokens(entry.message as Parameters<typeof estimateMessageTokens>[0]);
  }
  if (entry.type === "custom_message" && entry.content) {
    const content = entry.content;
    if (typeof content === "string") return estimateStringTokens(content);
    if (Array.isArray(content)) {
      let total = 0;
      for (const block of content) {
        if (block.type === "text" && block.text) total += estimateStringTokens(block.text);
      }
      return total;
    }
  }
  if (entry.type === "branch_summary" && typeof entry.summary === "string") {
    return estimateStringTokens(entry.summary);
  }
  return 0;
}
