/**
 * Drill-down: resolve #N:path syntax to tool call file content.
 *
 * Phase 3 of recall-progressive-discovery.
 * Supports: #42:auth.ts (preview), #42:auth.ts:full (full content), #42:file (auto-select).
 */
import { isContentBearing } from "./content.js";
import { loadAllMessages } from "./load-messages.js";

// ── Types ─────────────────────────────────────────────────────────────────

interface ContentBearingCall {
  name: string;
  path: string;
  content?: string;
  oldText?: string;
  newText?: string;
  edits?: Array<{ oldText?: string; newText?: string }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Extract the file path from tool call args, checking all known keys. */
function extractPathFromArgs(args: Record<string, unknown>): string | null {
  for (const key of ["path", "filePath", "file_path", "file"]) {
    if (typeof args[key] === "string") return args[key] as string;
  }
  return null;
}

/**
 * Find content-bearing tool calls that have a `path` argument and at least
 * one content field (content, edits, oldText, newText).
 * Uses the shared isContentBearing() heuristic from content.ts.
 */
function findContentBearingCalls(content: unknown[]): ContentBearingCall[] {
  if (!Array.isArray(content)) return [];
  const results: ContentBearingCall[] = [];
  for (const part of content) {
    if (!part || (part as any).type !== "toolCall") continue;
    const args = (part as any).arguments ?? {};
    if (!isContentBearing(args)) continue;
    const path = extractPathFromArgs(args);
    if (!path) continue;
    const entry: ContentBearingCall = { name: (part as any).name ?? "", path };
    if (typeof args.content === "string") entry.content = args.content;
    if (Array.isArray(args.edits)) entry.edits = args.edits;
    if (typeof args.oldText === "string" && !Array.isArray(args.edits)) entry.oldText = args.oldText;
    if (typeof args.newText === "string" && !Array.isArray(args.edits)) entry.newText = args.newText;
    results.push(entry);
  }
  return results;
}

/** Format the content of a tool call for display. */
function formatToolCallContent(
  tc: ContentBearingCall,
  entryIndex: number,
  full: boolean,
): string {
  let body: string;
  if (tc.content) {
    body = tc.content;
  } else if (tc.edits) {
    body = tc.edits
      .map((e, i) => `--- edit ${i + 1} ---\n${e.oldText ?? ""}\n--- becomes ---\n${e.newText ?? ""}`)
      .join("\n\n");
  } else if (tc.oldText && tc.newText) {
    body = `--- old ---\n${tc.oldText}\n--- new ---\n${tc.newText}`;
  } else {
    body = "(no file content found in tool call arguments)";
  }

  const previewLimit = 30; // lines
  if (!full) {
    const lines = body.split("\n");
    if (lines.length > previewLimit) {
      body = lines.slice(0, previewLimit).join("\n") +
        `\n...(${lines.length - previewLimit} more lines — use #${entryIndex}:${tc.path}:full for complete content)`;
    }
  }

  return `File: ${tc.path}
Tool: ${tc.name}

${body}`;
}

// ── Parse drill-down query ────────────────────────────────────────────────

/**
 * Pattern: #N:path or #N:path:full
 * Group 1: index number
 * Group 2: path (stops before optional :full)
 * Group 3: "full" if present, undefined otherwise
 */
const DRILLDOWN_PATTERN = /^#(\d+):(.+?)(?::(full))?$/;

/**
 * Parse a drill-down query like #42:auth.ts or #42:auth.ts:full.
 * Returns null if the query doesn't match the drill-down pattern.
 */
export function parseDrillDown(
  query: string,
): { index: number; pathPattern: string; full: boolean } | null {
  const match = query.match(DRILLDOWN_PATTERN);
  if (!match) return null;
  const index = parseInt(match[1], 10);
  const pathPattern = match[2];
  const full = match[3] === "full";
  return { index, pathPattern, full };
}

// ── Main export ───────────────────────────────────────────────────────────

/**
 * Expand a drill-down query (#N:path) to tool call content.
 *
 * @param sessionFile - Path to the JSONL session file
 * @param entryIndex - The message index (#N)
 * @param pathPattern - File path substring to match (or "file" keyword)
 * @param full - If true, return complete content without truncation
 * @returns Formatted content string
 */
export function expandEntryFile(
  sessionFile: string,
  entryIndex: number,
  pathPattern: string,
  full = false,
): string {
  const { rawMessages } = loadAllMessages(sessionFile, true);

  if (entryIndex < 0 || entryIndex >= rawMessages.length) {
    return `Entry #${entryIndex} not found in session history.`;
  }

  const msg = rawMessages[entryIndex];
  const content = msg.content as unknown[];
  const calls = findContentBearingCalls(content);

  // Special case: #42:file keyword
  if (pathPattern === "file") {
    if (calls.length === 0) {
      return `No file content found in entry #${entryIndex}.`;
    }
    if (calls.length === 1) {
      return formatToolCallContent(calls[0], entryIndex, full);
    }
    // Multiple content-bearing calls — list them
    const items = calls.map((tc) => `  [#${entryIndex}:${tc.path}] ${tc.name}(${tc.path})`);
    return `Entry #${entryIndex} has ${calls.length} file operations:\n${items.join("\n")}\n\nUse #${entryIndex}:path to drill into a specific file.`;
  }

  const matched = calls.filter((tc) => tc.path.includes(pathPattern));

  if (matched.length === 0) {
    return `No file content found in entry #${entryIndex} for "${pathPattern}".`;
  }

  return formatToolCallContent(matched[0], entryIndex, full);
}
