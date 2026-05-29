import type { Message } from "@earendil-works/pi-ai";

export const clip = (text: string, max = 200): string => {
  if (text.length <= max) return text;
  // Try to cut at a word boundary
  const cut = text.lastIndexOf(" ", max);
  let end = cut > max * 0.6 ? cut : max;
  // Avoid splitting a surrogate pair
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
  }
  return text.slice(0, end);
};

/**
 * Clip text to last sentence boundary at or before `max` chars.
 * Falls back to word boundary (clip()) if no sentence end is found in the
 * acceptable range. Trailing whitespace stripped.
 */
export const clipSentence = (text: string, max = 200): string => {
  if (text.length <= max) return text;
  // Look for sentence terminators followed by space/newline within [max*0.5, max]
  const window = text.slice(0, max);
  const matches = [...window.matchAll(/[.!?](?:\s|$)/g)];
  if (matches.length > 0) {
    const last = matches[matches.length - 1];
    const end = (last.index ?? 0) + 1; // include the punctuation
    if (end >= max * 0.5) return text.slice(0, end);
  }
  return clip(text, max);
};

export const nonEmptyLines = (text: string): string[] =>
  text.split("\n").map((line) => line.trim()).filter(Boolean);

export const firstLine = (text: string, max = 200): string =>
  clip(text.split("\n")[0] ?? "", max);

export const textParts = (content: Message["content"]): string[] => {
  if (!content) return [];
  if (typeof content === "string") return [content];
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text);
};

export const textOf = (content: Message["content"]): string =>
  textParts(content).join("\n");

/**
 * Check if tool call arguments contain content-bearing data.
 *
 * A call is content-bearing if it has a path argument AND at least one
 * large string/array field (content, edits, oldText, newText).
 * This is a generic heuristic — not dependent on tool names.
 */
export const isContentBearing = (args: Record<string, unknown>): boolean => {
  if (!args || typeof args !== "object") return false;
  // Must have a path in one of the known keys
  const hasPath = ["path", "filePath", "file_path", "file"].some((k) => typeof args[k] === "string");
  if (!hasPath) return false;
  // Must have at least one content-bearing field
  if (typeof args.content === "string" && args.content.length > 0) return true;
  if (Array.isArray(args.edits) && args.edits.length > 0) return true;
  if (typeof args.oldText === "string" && args.oldText.length > 0 && !Array.isArray(args.edits)) return true;
  if (typeof args.newText === "string" && args.newText.length > 0 && !Array.isArray(args.edits)) return true;
  return false;
};

/**
 * Extract textual content from tool call arguments (write, edit, hex_edit).
 *
 * Looks for content-bearing tool calls (those with a `path` argument and
 * at least one large string/array field like `content`, `edits`, `oldText`, `newText`).
 * Each call is capped at `maxBytesPerCall` to avoid inflating the search index.
 */
export const toolCallArgsText = (
  content: Message["content"],
  maxBytesPerCall = 10_240,
): string => {
  if (!content || typeof content === "string") return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part.type !== "toolCall") continue;
    const args = part.arguments as Record<string, unknown>;
    if (!isContentBearing(args)) continue;

    let extracted = "";
    if (typeof args.content === "string") {
      extracted += args.content.slice(0, maxBytesPerCall) + "\n";
    }
    if (Array.isArray(args.edits)) {
      for (const edit of args.edits) {
        if (typeof edit.oldText === "string") {
          extracted += edit.oldText.slice(0, Math.floor(maxBytesPerCall / 2)) + "\n";
        }
        if (typeof edit.newText === "string") {
          extracted += edit.newText.slice(0, Math.floor(maxBytesPerCall / 2)) + "\n";
        }
      }
    }
    if (typeof args.oldText === "string" && !Array.isArray(args.edits)) {
      extracted += args.oldText.slice(0, maxBytesPerCall) + "\n";
    }
    if (typeof args.newText === "string" && !Array.isArray(args.edits)) {
      extracted += args.newText.slice(0, maxBytesPerCall) + "\n";
    }

    if (extracted) {
      parts.push(extracted.slice(0, maxBytesPerCall));
    }
  }
  return parts.join("\n");
};

/** Extract a snippet of ~`radius` chars around the first match of `term` in `text`. */
export const snippet = (text: string, term: string, radius = 60): string | null => {
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + term.length + radius);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
};
