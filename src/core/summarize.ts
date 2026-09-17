/**
 * Pi-vcc compile entry — orchestrates normalization → noise filtering → section building.
 *
 * Upstream: https://github.com/sting8k/pi-vcc (src/core/summarize.ts)
 * Modified by pi-blackhole:
 * - threads touchMessages/cwd into buildSections for file-touch attribution
 *   (src/extract/file-touch.ts); merge logic otherwise unchanged.
 */
import type { Message } from "@earendil-works/pi-ai";
import type { FileOps } from "../types";
import { normalize } from "./normalize";
import { filterNoise } from "./filter-noise";
import { buildSections } from "./build-sections";
import { formatFileList } from "../extract/files";
import { formatSummary, capBrief, RECALL_NOTE, wrapLongLines } from "./format";

export interface CompileInput {
  messages: Message[];
  previousSummary?: string;
  fileOps?: FileOps;
  /**
   * Raw (pre-convertToLlm) session messages for file-touch attribution.
   * Falls back to `messages` when omitted. bashExecution messages only exist
   * in the raw form, so passing these preserves bash mutation tracking.
   */
  touchMessages?: Message[];
  /** Working directory — merges relative/absolute file references. */
  cwd?: string;
  /** Git working-tree tags for fresh-window annotations (abs path → tag). */
  gitTags?: Map<string, string>;
  /**
   * Session-global `#N` index per message position (see
   * src/core/global-indices.ts). Parallel to `messages`; a missing entry
   * renders as no ref (fail-closed). Omitted entirely → legacy positional.
   */
  sourceIndices?: Array<number | undefined>;
}

const HEADER_NAMES = [
  "Session Goal",
  "Files And Changes",
  "Commits",
  "Outstanding Context",
  "User Preferences",
];

const SEPARATOR = "\n\n---\n\n";

/**
 * Join wrapped continuation lines back into their bullet item.
 *
 * formatSummary() wraps long lines at 120 chars with a space continuation
 * indent; both the fresh output and stored previous summaries reach the merge
 * below in that wrapped form. A wrapped "- Modified: a,\n  b,\n  c" bullet
 * spans several physical lines of which only the first starts with the
 * "- <Category>: " prefix — without rejoining, the merge silently keeps only
 * the entries on the first line and drops the rest.
 * Continuation lines start with spaces while bullets, headers and blank
 * separator lines never do, so joining "\n + non-space" with a single space
 * only ever rejoins wrapped content.
 */
const joinWrappedLines = (text: string): string => text.replace(/\n +(?=\S)/g, " ");

/** Extract a named section from summary text.
 *
 * The header must start at a line boundary — inline mentions such as
 * "`[Files And Changes]`" inside a hand-written pi-native summary must not
 * match, otherwise the "previous section" becomes a giant blob from the
 * mention to the end of the text and the merge drops almost everything.
 */
const sectionOf = (text: string, header: string): string => {
  // Escape the header name for regex safety
  const openEscaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const open = text.match(new RegExp(`(?:^|\\n)\\[${openEscaped}\\]`));
  if (!open || open.index === undefined) return "";
  const start = open.index + (open[0].startsWith("\n") ? 1 : 0);
  const after = joinWrappedLines(text.slice(start));
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

/** Extract a header section WITHOUT rejoining continuation lines — preserves
 *  multi-line list format for Files And Changes merge. */
export const extractSection = (text: string, header: string): string => {
  const openEscaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const open = text.match(new RegExp(`(?:^|\\n)\\[${openEscaped}\\]`));
  if (!open || open.index === undefined) return "";
  // Start after the header line (skip "[Header]\n")
  // open.index points to the start of the match (either 0 or at a \n).
  // The header line ends at the first \n after the closing ].
  const headerStart = open.index + (open[0].startsWith("\n") ? 1 : 0); // position of [
  const headerEnd = text.indexOf("\n", headerStart); // \n after ]
  const start = headerEnd >= 0 ? headerEnd + 1 : text.length;
  const after = text.slice(start); // NO joinWrappedLines
  const nextSection = HEADER_NAMES.filter((h) => h !== header)
    .map((h) => {
      const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(?:^|\\n)\\[${escaped}\\]`);
      const m = after.match(re);
      if (!m) return -1;
      return m.index! + (m[0].startsWith("\n") ? 1 : 0);
    })
    .filter((n) => n >= 0);
  const nextSep = after.indexOf(SEPARATOR);
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
    return mergeFileLines(extractSection(prev, header), extractSection(fresh, header));
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

/** Merge Files And Changes by category, dedup paths across compactions. */

/**
 * Git word-tag suffix appended by the fresh compile ("src/a.ts (staged)").
 * Tags from the previous summary are stripped (stale point-in-time state);
 * fresh-window tags survive.
 */
const GIT_TAG_SUFFIX_RE =
  /\s+\((?:staged|unstaged|new|renamed|deleted|conflicted|staged,unstaged)\)\s*$/;

/**
 * Add one header-rest or continuation line to the merged map, splitting on
 * top-level commas — a git word tag can contain one ("a.ts
 * (staged,unstaged)"); splitting inside the parens yields partial keys
 * ("a.ts (staged", "unstaged)") that defeat the prev/fresh dedup and
 * duplicate the file on re-touch. New-shape list lines hold a single
 * (comma-terminated) path, so the split is a no-op for them — including
 * after sectionOf rejoins the list into one line during merge.
 */
const addEntries = (
  merged: Record<string, Map<string, string>>,
  cat: string,
  isFresh: boolean,
  rest: string,
): void => {
  const text = rest.replace(/\s*\(\+\d+ more\)\s*$/, "");
  if (!text.trim()) return;
  const parts = text.split(/,(?![^()]*\))/);
  for (const p of parts) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    const key = trimmed.replace(GIT_TAG_SUFFIX_RE, "");
    const map = merged[cat];
    if (!map.has(key)) {
      // Fresh entries keep their tags; prev-only entries store the
      // stripped key — prev tags are stale point-in-time state.
      map.set(key, isFresh ? trimmed : key);
    }
  }
};

export const mergeFileLines = (prev: string, fresh: string): string => {
  const categories = ["Modified", "Created", "Read"] as const;
  // stripped path → display string; prev inserted first, fresh display wins
  const merged: Record<string, Map<string, string>> = {};
  for (const cat of categories) merged[cat] = new Map();

  // Parse both shapes:
  // - new: "- Modified (12):" header, one path per continuation line
  //   (entries carry trailing commas, so they also split correctly after
  //   sectionOf rejoins the lines during merge)
  // - legacy: "- Modified: a, b (staged), c (+N more)" comma-joined
  // Fresh entries are recency-ordered (most recent first) and prev entries
  // follow in stored order, so the keep-first cap below retains the most
  // recent files instead of letting stale prev entries crowd out fresh
  // touches. Fresh display (with current git tags) wins ties by insertion
  // order — prev never overwrites an already-seen key.
  const headerRe = /^- (Modified|Created|Read)( \(\d+\))?:(.*)$/;
  const moreRe = /^\(\+\d+ more\)$/;
  for (const text of [fresh, prev]) {
    const isFresh = text === fresh;
    let current: string | null = null;
    for (const line of text.split("\n")) {
      const header = line.match(headerRe);
      if (header) {
        current = header[1];
        addEntries(merged, current, isFresh, header[3]);
        continue;
      }
      if (current === null) continue;
      if (!line.startsWith(" ") && !line.startsWith("\t")) {
        current = null;
        continue;
      }
      const entry = line.trim();
      if (!entry || moreRe.test(entry)) continue;
      addEntries(merged, current, isFresh, entry);
    }
  }

  // Dedup: if already in Modified, drop from Created (file existed before)
  for (const key of merged.Modified.keys()) merged.Created.delete(key);
  // Also remove Read entries that also appear in Modified (same file read+edited)
  for (const key of merged.Modified.keys()) merged.Read.delete(key);

  const lines: string[] = [];
  if (merged.Modified.size > 0)
    lines.push(`- ${formatFileList("Modified", [...merged.Modified.values()], 20)}`);
  if (merged.Created.size > 0)
    lines.push(`- ${formatFileList("Created", [...merged.Created.values()], 20)}`);
  if (merged.Read.size > 0) {
    const arr = [...merged.Read.values()];
    lines.push(
      `- Read: ${arr.slice(0, 10).join(", ")}${arr.length > 10 ? ` (+${arr.length - 10} more)` : ""}`,
    );
  }
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
    // Files And Changes must NOT use sectionOf — it rejoins continuation lines
    // and destroys the multi-line list format needed for correct merge parsing.
    // Pass full summaries; mergeFileLines extracts the section itself.
    if (header === "Files And Changes") {
      return mergeHeaderSection(header, prev, fresh);
    }
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

const compileFresh = (
  input: Pick<
    CompileInput,
    "messages" | "fileOps" | "sourceIndices" | "touchMessages" | "cwd" | "gitTags"
  >,
): string => {
  const blocks = filterNoise(normalize(input.messages, input.sourceIndices));
  const data = buildSections({
    blocks,
    messages: input.touchMessages ?? input.messages,
    fileOps: input.fileOps,
    cwd: input.cwd,
    gitTags: input.gitTags,
  });
  return formatSummary(data);
};

/** Build one fresh immutable VCC segment. It never reads an older summary. */
export const compileSegment = (
  input: Pick<
    CompileInput,
    "messages" | "fileOps" | "sourceIndices" | "touchMessages" | "cwd" | "gitTags"
  >,
): string => {
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
