/**
 * Pi-vcc compile entry — orchestrates normalization → noise filtering → section building.
 *
 * Upstream: https://github.com/sting8k/pi-vcc (src/core/summarize.ts)
 * Unmodified.
 */
import type { Message } from "@earendil-works/pi-ai";
import type { FileOps } from "../types";
import { normalize } from "./normalize";
import { filterNoise } from "./filter-noise";
import { buildSections } from "./build-sections";
import { formatSummary, capBrief, RECALL_NOTE, wrapLongLines } from "./format";

export interface CompileInput {
  messages: Message[];
  previousSummary?: string;
  fileOps?: FileOps;
}

const HEADER_NAMES = ["Session Goal", "Files And Changes", "Commits", "Outstanding Context", "User Preferences"];

const SEPARATOR = "\n\n---\n\n";

/** Extract a named section from summary text */
const sectionOf = (text: string, header: string): string => {
  const tag = `[${header}]`;
  const start = text.indexOf(tag);
  if (start < 0) return "";
  const after = text.slice(start);
  // Find next section header (must start at line boundary to avoid matching in content)
  const nextSection = HEADER_NAMES
    .filter((h) => h !== header)
    .map((h) => {
      // Escape the header name for regex safety
      const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(?:^|\\n)\\[${escaped}\\]`);
      const m = after.match(re);
      if (!m) return -1;
      // m.index points to \n (or 0); advance past it to the [
      return m.index! + (m[0].startsWith("\n") ? 1 : 0);
    })
    .filter((n) => n >= 0);
  const nextSep = after.indexOf("\n\n---\n\n");
  const candidates = [...nextSection, ...(nextSep > 0 ? [nextSep] : [])].sort((a, b) => a - b);
  const end = candidates[0];
  return (end ? after.slice(0, end) : after).trim();
};

/** Extract the brief transcript part (everything after ---) */
const briefOf = (text: string): string => {
  const idx = text.indexOf(SEPARATOR);
  if (idx < 0) return "";
  return text.slice(idx + SEPARATOR.length).trim();
};

/** Merge a header section */
const mergeHeaderSection = (header: string, prev: string, fresh: string): string => {
  // Outstanding Context is volatile -- always use fresh only
  if (header === "Outstanding Context") return fresh;
  if (!prev) return fresh;
  if (!fresh) return prev;

  // Files And Changes: merge by category (Modified/Created/Read), dedup paths
  if (header === "Files And Changes") {
    return mergeFileLines(prev, fresh);
  }

  // Session Goal, User Preferences: line-level dedup, cap
  const isClean = (l: string) => l.startsWith("- ") && !l.includes("<skill") && !l.includes("</skill");
  const prevLines = prev.split("\n").filter(isClean);
  const freshLines = fresh.split("\n").filter(isClean);
  const combined = [...new Set([...prevLines, ...freshLines])];
  const CAP = header === "Session Goal" ? 8 : header === "Commits" ? 8 : 15;
  const capped = combined.length > CAP ? combined.slice(-CAP) : combined;
  if (capped.length === 0) return "";
  return `[${header}]\n${capped.join("\n")}`;
};

/** Merge Files And Changes by category, dedup paths across compactions */
const mergeFileLines = (prev: string, fresh: string): string => {
  const categories = ["Modified", "Created", "Read"] as const;
  const merged: Record<string, Set<string>> = {};
  for (const cat of categories) merged[cat] = new Set();

  // Parse "- Modified: a, b, c (+N more)" lines from both prev and fresh
  for (const text of [prev, fresh]) {
    for (const line of text.split("\n")) {
      for (const cat of categories) {
        const prefix = `- ${cat}: `;
        if (!line.startsWith(prefix)) continue;
        let rest = line.slice(prefix.length);
        // Strip "(+N more)" suffix
        rest = rest.replace(/\s*\(\+\d+ more\)\s*$/, "");
        for (const p of rest.split(",")) {
          const trimmed = p.trim();
          if (trimmed) merged[cat].add(trimmed);
        }
      }
    }
  }

  // Dedup: if already in Modified, drop from Created (file existed before)
  for (const p of merged.Modified) merged.Created.delete(p);
  // Also remove Read entries that also appear in Modified (same file read+edited)
  for (const p of merged.Modified) merged.Read.delete(p);

  const cap = (set: Set<string>, limit: number) => {
    const arr = [...set];
    if (arr.length <= limit) return arr.join(", ");
    return arr.slice(0, limit).join(", ") + ` (+${arr.length - limit} more)`;
  };

  const lines: string[] = [];
  if (merged.Modified.size > 0) lines.push(`- Modified: ${cap(merged.Modified, 10)}`);
  if (merged.Created.size > 0) lines.push(`- Created: ${cap(merged.Created, 10)}`);
  if (merged.Read.size > 0) lines.push(`- Read: ${cap(merged.Read, 10)}`);
  if (lines.length === 0) return "";
  return `[Files And Changes]\n${lines.join("\n")}`;
};

const mergeBriefTranscript = (prev: string, fresh: string): string => {
  if (!prev) return fresh;
  if (!fresh) return prev;
  return prev + "\n\n" + fresh;
};

const mergePrevious = (prev: string, fresh: string): string => {
  // Merge header sections
  const headers = HEADER_NAMES
    .map((header) => {
      const freshSec = sectionOf(fresh, header);
      const prevSec = sectionOf(prev, header);
      return mergeHeaderSection(header, prevSec, freshSec);
    })
    .filter(Boolean);

  // Merge brief transcript
  const prevBrief = briefOf(prev);
  const freshBrief = briefOf(fresh);
  const mergedBrief = mergeBriefTranscript(prevBrief, freshBrief);

  const parts: string[] = [];
  if (headers.length > 0) {
    parts.push(headers.join("\n\n"));
  }
  if (mergedBrief) {
    parts.push(capBrief(mergedBrief));
  }

  return parts.join(SEPARATOR);
};

export const compile = (input: CompileInput): string => {
  const blocks = filterNoise(normalize(input.messages));
  const data = buildSections({ blocks });
  const fresh = formatSummary(data);
  // Strip any legacy RECALL_NOTE baked into prev summary (pre-fix format)
  // so merge doesn't re-stack it inside the brief.
  // Also strip OM content (## Reflections / ## Observations) from previous
  // compactions — these are re-rendered fresh by the before-compact hook.
  let prev = input.previousSummary
    ? stripRecallNote(input.previousSummary)
    : undefined;
  prev = prev ? stripOMContent(prev) : undefined;
  const merged = prev ? mergePrevious(prev, fresh) : fresh;
  if (!merged) return "";
  return wrapLongLines(merged + SEPARATOR + RECALL_NOTE);
};

const stripRecallNote = (text: string): string => {
  // Remove trailing RECALL_NOTE (and any separators surrounding it) if present.
  // Handles both current format (---\n\nNOTE) and bare trailing NOTE.
  const idx = text.lastIndexOf(RECALL_NOTE);
  if (idx < 0) return text;
  return text.slice(0, idx).replace(/\s*(?:\n\n---\n\n)?\s*$/, "").trimEnd();
};

/**
 * Strip OM content (## Reflections, ## Observations, and the
 * CONTEXT_USAGE_INSTRUCTIONS preamble) from a previous compaction summary.
 *
 * OM content is appended after compile() by the before-compact hook, so it
 * must be stripped from the previous summary to prevent compounding across
 * compactions. The fresh OM projection is re-rendered each time.
 */
const stripOMContent = (text: string): string => {
  // Remove everything from "## Reflections" or "## Observations" onward,
  // plus the instructions preamble that precedes them.
  // The preamble starts with "These are condensed memories from earlier in this session."
  // Use line-start anchoring to avoid matching inside conversation content
  const reflMatch = text.match(/^## Reflections/m);
  const reflIdx = reflMatch ? reflMatch.index! : -1;
  const obsMatch = text.match(/^## Observations/m);
  const obsIdx = obsMatch ? obsMatch.index! : -1;

  // Find the start of OM content: either the instructions preamble or the first section header
  let stripFrom = -1;
  if (reflIdx >= 0 || obsIdx >= 0) {
    const preambleIdx = text.indexOf("These are condensed memories from earlier in this session.");
    const minSectionIdx = Math.min(
      reflIdx >= 0 ? reflIdx : Infinity,
      obsIdx >= 0 ? obsIdx : Infinity,
    );
    // Old format: preamble before sections -> strip from preamble.
    // New format: preamble after sections -> strip from first section header.
    if (preambleIdx >= 0 && preambleIdx < minSectionIdx) {
      stripFrom = preambleIdx;
    } else if (minSectionIdx < Infinity) {
      stripFrom = minSectionIdx;
    }
  }

  if (stripFrom < 0) return text;

  // Also strip any trailing separators before the OM content
  let end = stripFrom;
  while (end > 0 && /\s/.test(text[end - 1])) end--;
  // Strip trailing "---" separator if present
  const beforeEnd = text.slice(0, end).trimEnd();
  if (beforeEnd.endsWith("---")) {
    return beforeEnd.slice(0, beforeEnd.length - 3).trimEnd();
  }
  return beforeEnd;
};
