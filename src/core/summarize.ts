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

const HEADER_NAMES = [
  "Session Goal",
  "Files And Changes",
  "Commits",
  "Outstanding Context",
  "User Preferences",
];

const SEPARATOR = "\n\n---\n\n";

/** Extract a named section from summary text */
const sectionOf = (text: string, header: string): string => {
  const tag = `[${header}]`;
  const start = text.indexOf(tag);
  if (start < 0) return "";
  const after = text.slice(start);
  // Find next section header (must start at line boundary to avoid matching in content)
  const nextSection = HEADER_NAMES.filter((h) => h !== header)
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
  const isClean = (l: string) =>
    l.startsWith("- ") && !l.includes("<skill") && !l.includes("</skill");
  const prevLines = prev.split("\n").filter(isClean);
  const freshLines = fresh.split("\n").filter(isClean);
  const combined = [...new Set([...prevLines, ...freshLines])];
  const CAP = header === "Session Goal" ? 8 : header === "Commits" ? 8 : 15;
  // Session Goal: keep first items so the original first message persists
  // Other sections: keep last items (fresh overrides stale)
  const capped =
    combined.length > CAP
      ? header === "Session Goal"
        ? combined.slice(0, CAP)
        : combined.slice(-CAP)
      : combined;
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
  const headers = HEADER_NAMES.map((header) => {
    const freshSec = sectionOf(fresh, header);
    const prevSec = sectionOf(prev, header);
    return mergeHeaderSection(header, prevSec, freshSec);
  }).filter(Boolean);

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

const compileFresh = (input: Pick<CompileInput, "messages" | "fileOps">): string => {
  const blocks = filterNoise(normalize(input.messages));
  const data = buildSections({ blocks });
  return formatSummary(data);
};

/** Build one fresh immutable VCC segment. It never reads an older summary. */
export const compileSegment = (input: Pick<CompileInput, "messages" | "fileOps">): string => {
  const fresh = compileFresh(input);
  return fresh ? wrapLongLines(fresh) : "";
};

export const compile = (input: CompileInput): string => {
  const fresh = compileFresh(input);

  // Strip OM content first (## Reflections / ## Observations + preamble),
  // then strip ALL recall notes from the previous summary using paragraph-level
  // matching. Order matters: OM sections appear before the recall note in the
  // stored summary, so we must remove them first to avoid leaving the recall
  // stripper with fragments.
  let prev = input.previousSummary ? stripOMContent(input.previousSummary) : undefined;
  prev = prev ? stripRecallNotes(prev) : undefined;
  const merged = prev ? mergePrevious(prev, fresh) : fresh;
  if (!merged) return "";
  // Defensive: remove any recall notes that survived the above (e.g. nested
  // inside the brief transcript after a prior merge).
  const cleaned = stripRecallNotes(merged);
  return wrapLongLines(cleaned + SEPARATOR + RECALL_NOTE);
};

/**
 * Strip ALL recall-note paragraphs from text using paragraph-level matching.
 *
 * The recall note is identified by the sentence:
 *   "The conversation before this point has been compacted"
 *
 * After wrapLongLines runs, the recall note may be split across multiple lines,
 * so exact string matching against RECALL_NOTE fails. Instead, split the text
 * into paragraphs (double-newline boundaries) and drop any paragraph that
 * contains the identifying sentence.
 */
const RECALL_NOTE_MARKER = "The conversation before this point has been compacted";

/** Return the one mutable recall-note paragraph from a complete summary. */
export const extractRecallNote = (text: string): string =>
  text
    .split(/\n\n+/)
    .find((paragraph) => paragraph.includes(RECALL_NOTE_MARKER))
    ?.trim() ?? "";

export const stripRecallNotes = (text: string): string => {
  const paragraphs = text.split(/\n\n+/);
  const kept = paragraphs.filter((p) => !p.includes(RECALL_NOTE_MARKER));
  return kept.join("\n\n");
};

export const stripOMContent = (text: string): string => {
  // Remove everything from "## Reflections" or "## Observations" onward,
  // plus the instructions preamble that precedes them.
  // The preamble starts with "These are condensed memories from earlier in this session."
  // Use line-start anchoring to avoid matching inside conversation content
  const reflMatch = text.match(/^## Reflections/m);
  const reflIdx = reflMatch ? reflMatch.index! : -1;
  const obsMatch = text.match(/^## Observations/m);
  const obsIdx = obsMatch ? obsMatch.index! : -1;

  // Also detect the basic recall-guidance footer (no observation preamble)
  const basicFooterIdx = text.indexOf(
    "Use `recall` with an id to retrieve original context, or `#N:path` drill-down",
  );

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
  } else if (basicFooterIdx >= 0) {
    // Strip the basic recall-guidance footer (no observations/reflections present)
    stripFrom = basicFooterIdx;
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
