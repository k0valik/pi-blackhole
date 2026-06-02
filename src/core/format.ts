import type { SectionData } from "../sections";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

const section = (title: string, items: string[]): string => {
  if (items.length === 0) return "";
  const body = items.map((i) => `- ${i}`).join("\n");
  return `[${title}]\n${body}`;
};

const BRIEF_MAX_LINES = 120;
const TUI_SAFE_LINE_CHARS = 120;

/**
 * Wrap a single line of text, preserving list-item continuation indent.
 * Detects leading bullets (-, *, N.) and indents continuation lines
 * to match, so wrapped list items remain visually grouped.
 */
function wrapLineWithContinuation(line: string, maxChars: number): string[] {
  const indent = line.match(/^\s*(?:[-*]\s+|\d+\.\s+)?/)?.[0] ?? "";
  const continuationIndent = indent ? " ".repeat(Math.min(indent.length, 8)) : "";
  // Wrap at reduced width so prepending continuationIndent doesn't exceed maxChars
  const safeMaxChars = continuationIndent ? maxChars - continuationIndent.length : maxChars;
  const wrapped = wrapTextWithAnsi(line, safeMaxChars);
  if (wrapped.length <= 1 || !continuationIndent) return wrapped;
  return [wrapped[0], ...wrapped.slice(1).map((l) => continuationIndent + l)];
}

export const wrapLongLines = (text: string, maxChars = TUI_SAFE_LINE_CHARS): string =>
  text.split("\n").flatMap((line) => wrapLineWithContinuation(line, maxChars)).join("\n");

export const capBrief = (text: string): string => {
  const lines = text.split("\n");
  if (lines.length <= BRIEF_MAX_LINES) return text;
  const omitted = lines.length - BRIEF_MAX_LINES;
  const kept = lines.slice(-BRIEF_MAX_LINES);
  // Find first section header to avoid cutting mid-section
  let firstHeader = kept.findIndex((l) => /^\[.+\]/.test(l));
  if (firstHeader < 0) {
    // No header in the kept window — scan for any bracket-delimited anchor
    // (e.g., tool name, inline reference) to avoid starting mid-paragraph.
    const anyAnchor = kept.findIndex((l) => /^\[[^\]]+\]/.test(l));
    if (anyAnchor > 0) firstHeader = anyAnchor;
  }
  const clean = firstHeader > 0 ? kept.slice(firstHeader) : kept;
  return `...(${omitted} earlier lines omitted)\n\n${clean.join("\n")}`;
};

export const RECALL_NOTE =
  "Use `recall` to search for prior work, decisions, and context from before this summary. " +
  "Do not redo work already completed.";

export const formatSummary = (data: SectionData): string => {
  const headerParts = [
    section("Session Goal", data.sessionGoal),
    section("Files And Changes", data.filesAndChanges),
    section("Commits", data.commits),
    section("Outstanding Context", data.outstandingContext),
    section("User Preferences", data.userPreferences),
  ].filter(Boolean);

  const parts: string[] = [];
  if (headerParts.length > 0) {
    parts.push(headerParts.join("\n\n"));
  }
  if (data.briefTranscript) {
    parts.push(capBrief(data.briefTranscript));
  }

  if (parts.length === 0) return "";

  // NOTE: RECALL_NOTE is intentionally NOT appended here.
  // It is appended once by `compile()` at the very end, after merge-with-previous,
  // to avoid the note compounding inside the brief transcript across compactions.
  return wrapLongLines(parts.join("\n\n---\n\n"));
};
