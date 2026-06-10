/**
 * Search entries — BM25 + regex search over session history.
 *
 * Upstream: https://github.com/sting8k/pi-vcc (src/core/search-entries.ts)
 * Unmodified.
 */
import type { Message } from "@earendil-works/pi-ai";
import type { RenderedEntry } from "./render-entries";
import { textOf, toolCallArgsText, isContentBearing } from "./content";
import type { RecallMode } from "./recall-scope";

// Mirrors @earendil-works/pi-coding-agent's BashExecutionMessage (not re-exported from index)
interface LocalBashExec {
  role: "bashExecution";
  command: string;
  output: string;
}

export interface FileMatch {
  /** Name of the tool (write, edit, hex_edit) */
  toolName: string;
  /** File path from the tool call arguments */
  path: string;
  /** Number of lines in the content that matched the query */
  lineCount: number;
  /** First matching line snippet (only populated for top matches) */
  snippet?: string;
}

/** A file touched in one entry — used by mode:touched aggregation. */
export interface FileTouch {
  index: number;
  toolName: string;
}

/** Aggregated view of a file touched across multiple entries. */
export interface TouchedFile {
  path: string;
  entries: FileTouch[];
}

export interface SearchHit extends RenderedEntry {
  /** Context snippet around the first matched term (only when query provided) */
  snippet?: string;
  /** Number of query terms matched (for ranking) */
  matchCount?: number;
  /** Per-file match indicators from content-bearing tool calls */
  fileMatches?: FileMatch[];
}

const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Try to compile as regex; fall back to escaped literal. */
const safeRegex = (pattern: string): RegExp => {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(escapeRegex(pattern), "i");
  }
};

/** Detect if the query looks like a single regex pattern (contains regex metacharacters). */
const looksLikeRegex = (query: string): boolean =>
  /[|*+?{}()[\]\\^$.]/.test(query);

/** Build a regex for snippet highlighting — matches first available term. */
const snippetRegex = (terms: string[]): RegExp => {
  const alts = terms.map((t) => {
    try {
      // Validate that it's a valid regex
      new RegExp(t, "i");
      return t;
    } catch {
      return escapeRegex(t);
    }
  });
  return new RegExp(alts.join("|"), "i");
};

// ── Stopwords for natural language queries ──
const STOPWORDS = new Set([
  // English
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "of", "in", "to", "for",
  "with", "on", "at", "from", "by", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "out", "off", "over",
  "under", "again", "further", "then", "once", "here", "there", "when",
  "where", "why", "how", "all", "both", "each", "few", "more", "most",
  "other", "some", "such", "no", "nor", "not", "only", "own", "same",
  "so", "than", "too", "very", "just", "about", "it", "its", "that",
  "this", "what", "which", "who", "whom", "these", "those",
]);

/** Remove stopwords, keep meaningful terms. */
const filterStopwords = (terms: string[]): string[] => {
  const meaningful = terms.filter((t) => !STOPWORDS.has(t.toLowerCase()) && t.length > 1);
  // If all terms were stopwords, return original (don't lose everything)
  return meaningful.length > 0 ? meaningful : terms;
};

/** Count how many distinct terms match the haystack. */
const countMatches = (hay: string, terms: string[]): number => {
  let count = 0;
  for (const t of terms) {
    if (safeRegex(t).test(hay)) count++;
  }
  return count;
};

// ── BM25-lite scoring ──
const BM25_K = 1.2;
const BM25_B = 0.75;

/** Count occurrences of a regex pattern in text. */
const termFreq = (text: string, pattern: RegExp): number => {
  const matches = text.match(new RegExp(pattern.source, "gi"));
  return matches ? matches.length : 0;
};

interface BM25Context {
  n: number;         // total docs
  avgDl: number;     // average doc length (words)
  df: Map<string, number>; // term -> number of docs containing it
}

/** Precompute IDF and avgDl across all docs. */
const buildBM25Context = (docs: string[], terms: string[]): BM25Context => {
  const n = docs.length;
  const df = new Map<string, number>();
  let totalLen = 0;

  for (const doc of docs) {
    totalLen += doc.split(/\s+/).length;
    for (const t of terms) {
      if (safeRegex(t).test(doc)) {
        df.set(t, (df.get(t) ?? 0) + 1);
      }
    }
  }

  return { n, avgDl: totalLen / Math.max(n, 1), df };
};

/** BM25 score for a single doc against query terms. */
const bm25Score = (doc: string, terms: string[], ctx: BM25Context): number => {
  const dl = doc.split(/\s+/).length;
  let score = 0;

  for (const t of terms) {
    const tf = termFreq(doc, safeRegex(t));
    if (tf === 0) continue;

    const docFreq = ctx.df.get(t) ?? 0;
    // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
    const idf = Math.log((ctx.n - docFreq + 0.5) / (docFreq + 0.5) + 1);
    // TF saturation with length normalization
    const tfNorm = (tf * (BM25_K + 1)) / (tf + BM25_K * (1 - BM25_B + BM25_B * dl / ctx.avgDl));
    score += idf * tfNorm;
  }

  return score;
};

/** Line-based snippet: ±contextLines around first regex match. */
const lineSnippet = (text: string, regex: RegExp, contextLines = 2): string | undefined => {
  const lines = text.split("\n");
  let matchIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      matchIdx = i;
      break;
    }
  }
  if (matchIdx === -1) return undefined;

  const start = Math.max(0, matchIdx - contextLines);
  const end = Math.min(lines.length, matchIdx + contextLines + 1);
  const slice = lines.slice(start, end);

  const parts: string[] = [];
  if (start > 0) parts.push(`...(${start} lines above)`);
  parts.push(...slice);
  if (end < lines.length) parts.push(`...(${lines.length - end} lines below)`);
  return parts.join("\n");
};

/** Build full searchable text for a message, optionally filtered by mode. */
const fullText = (msg: Message, mode?: RecallMode): string => {
  if ((msg as any).role === "bashExecution") {
    if (mode === "file") return ""; // bash is not file content
    const bashMsg = msg as unknown as LocalBashExec;
    return `${bashMsg.command ?? ""} ${bashMsg.output ?? ""}`;
  }
  if (mode === "file") {
    return toolCallArgsText(msg.content);
  }
  // hybrid (default): both transcript text + tool call args
  const text = textOf(msg.content);
  const toolArgs = toolCallArgsText(msg.content);
  return toolArgs ? `${text}\n${toolArgs}` : text;
};

/**
 * Extract searchable text from tool call arguments (content, edits, oldText, newText).
 */
function extractToolCallText(args: Record<string, unknown>): string {
  let text = "";
  if (typeof args.content === "string") text += args.content + "\n";
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (edit && typeof edit === "object") {
        if (typeof edit.oldText === "string") text += edit.oldText + "\n";
        if (typeof edit.newText === "string") text += edit.newText + "\n";
      }
    }
  }
  if (typeof args.oldText === "string" && !Array.isArray(args.edits)) text += args.oldText + "\n";
  if (typeof args.newText === "string" && !Array.isArray(args.edits)) text += args.newText + "\n";
  return text;
}

/**
 * Compute file indicators from a message (no query — counts total lines per file).
 */
export function getFileIndicators(msg: Message): FileMatch[] {
  if (!msg?.content || typeof msg.content === "string") return [];
  const fileMatches: FileMatch[] = [];
  for (const part of msg.content) {
    if (!part || typeof part !== "object" || part.type !== "toolCall") continue;
    const args = part.arguments as Record<string, unknown>;
    if (!isContentBearing(args)) continue;

    const path = ["path", "filePath", "file_path", "file"]
      .map((k) => args[k])
      .find((v): v is string => typeof v === "string")!;

    const totalText = extractToolCallText(args);
    const nonEmpty = totalText.split("\n").filter((l) => l.trim().length > 0);
    fileMatches.push({
      toolName: part.name || "",
      path,
      lineCount: nonEmpty.length,
    });
  }
  return fileMatches;
}

function computeFileMatches(msg: Message | undefined, query: string): FileMatch[] {
  if (!msg?.content || typeof msg.content === "string") return [];
  const rawQuery = query.trim();
  const hasQuery = rawQuery.length > 0;
  if (!hasQuery) return getFileIndicators(msg as Message);
  const regex = looksLikeRegex(rawQuery) ? safeRegex(rawQuery) : snippetRegex(rawQuery.split(/\s+/));
  const fileMatches: FileMatch[] = [];

  for (const part of msg.content) {
    if (!part || typeof part !== "object" || part.type !== "toolCall") continue;
    const args = part.arguments as Record<string, unknown>;
    if (!isContentBearing(args)) continue;

    // Path is guaranteed by isContentBearing check
    const path = ["path", "filePath", "file_path", "file"]
      .map((k) => args[k])
      .find((v): v is string => typeof v === "string")!;

    const searchText = extractToolCallText(args);
    if (!searchText) continue;

    const lines = searchText.split("\n");
    const matchingLines = lines.filter((line) => regex.test(line));
    if (matchingLines.length > 0) {
      fileMatches.push({
        toolName: part.name || "",
        path,
        lineCount: matchingLines.length,
        snippet: matchingLines[0],
      });
    }
  }

  return fileMatches;
}

/** Aggregate file operations across all entries for mode:touched. */
export function getTouchedFiles(
  messages: Message[],
  rendered: RenderedEntry[],
): TouchedFile[] {
  const map = new Map<string, TouchedFile>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const indicators = getFileIndicators(msg);
    for (const fm of indicators) {
      const index = rendered[i]?.index ?? i;
      if (!map.has(fm.path)) {
        map.set(fm.path, { path: fm.path, entries: [] });
      }
      map.get(fm.path)!.entries.push({ index, toolName: fm.toolName });
    }
  }
  return Array.from(map.values());
}

export const searchEntries = (
  entries: RenderedEntry[],
  messages: Message[],
  query?: string,
  _page?: number,
  mode?: RecallMode,
): SearchHit[] => {
  if (!query?.trim()) return entries;

  const rawQuery = query.trim();

  // If query looks like a single regex pattern (contains metacharacters),
  // treat the whole thing as one pattern — don't split into terms
  if (looksLikeRegex(rawQuery)) {
    const regex = safeRegex(rawQuery);
    const hits: SearchHit[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const msg = messages[i];
      const text = msg ? fullText(msg, mode) : e.summary;
      const filePart = e.files?.join(" ") ?? "";
      const hay = `${e.role} ${text} ${filePart}`;
      if (regex.test(hay)) {
        const snip = lineSnippet(text, regex);
        const fileMatches = computeFileMatches(msg, rawQuery);
        const extra = fileMatches.length > 0 ? { fileMatches } : {};
        hits.push({ ...e, snippet: snip, matchCount: 1, ...extra });
      }
    }
    return hits;
  }

  // Natural language / multi-word query: BM25 scoring
  const rawTerms = rawQuery.split(/\s+/);
  const terms = filterStopwords(rawTerms);
  const snipRe = snippetRegex(terms);

  // Build all docs for BM25 context (cache fullText to avoid recomputing)
  const docs: string[] = [];
  const fullTextCache: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const msg = messages[i];
    const text = msg ? fullText(msg, mode) : e.summary;
    fullTextCache.push(text);
    const filePart = e.files?.join(" ") ?? "";
    docs.push(`${e.role} ${text} ${filePart}`);
  }

  const ctx = buildBM25Context(docs, terms);

  const scored: Array<{ hit: SearchHit; score: number }> = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const hay = docs[i];
    const mc = countMatches(hay, terms);
    if (mc === 0) continue;
    const score = bm25Score(hay, terms, ctx);
    const text = fullTextCache[i];
    const snip = lineSnippet(text, snipRe);
    const fileMatches = computeFileMatches(messages[i], rawQuery);
    const extra = fileMatches.length > 0 ? { fileMatches } : {};
    scored.push({
      hit: { ...e, snippet: snip, matchCount: mc, ...extra },
      score,
    });
  }

  // Sort by BM25 score desc
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.hit);
};
