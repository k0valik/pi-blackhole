/**
 * Search entries — BM25 + regex search over session history.
 *
 * Upstream: https://github.com/sting8k/pi-vcc (src/core/search-entries.ts)
 * Unmodified.
 */
import type { Message } from "@earendil-works/pi-ai";
import type { RenderedEntry } from "./render-entries";
import { textOf } from "./content";

export interface SearchHit extends RenderedEntry {
  /** Context snippet around the first matched term (only when query provided) */
  snippet?: string;
  /** Number of query terms matched (for ranking) */
  matchCount?: number;
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

/** Build full searchable text for a message. */
const fullText = (msg: Message): string => {
  if ((msg as any).role === "bashExecution") {
    return `${(msg as any).command ?? ""} ${(msg as any).output ?? ""}`;
  }
  return textOf(msg.content);
};

export const searchEntries = (
  entries: RenderedEntry[],
  messages: Message[],
  query?: string,
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
      const text = msg ? fullText(msg) : e.summary;
      const filePart = e.files?.join(" ") ?? "";
      const hay = `${e.role} ${text} ${filePart}`;
      if (regex.test(hay)) {
        const snip = lineSnippet(text, regex);
        hits.push({ ...e, snippet: snip, matchCount: 1 });
      }
    }
    return hits;
  }

  // Natural language / multi-word query: BM25 scoring
  const rawTerms = rawQuery.split(/\s+/);
  const terms = filterStopwords(rawTerms);
  const snipRe = snippetRegex(terms);

  // Build all docs for BM25 context
  const docs: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const msg = messages[i];
    const text = msg ? fullText(msg) : e.summary;
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
    const text = messages[i] ? fullText(messages[i]) : e.summary;
    const snip = lineSnippet(text, snipRe);
    scored.push({
      hit: { ...e, snippet: snip, matchCount: mc },
      score,
    });
  }

  // Sort by BM25 score desc
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.hit);
};
