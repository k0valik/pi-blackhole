/**
 * Near-duplicate clustering for the observational-memory corpus.
 *
 * Receipts: plan-07 §19.4 —
 *  - exact normalized-content grouping first (halves real corpora; kills
 *    fork/move inflation and pipeline record bursts),
 *  - levenshtein clustering as a *refinement* over group representatives,
 *  - Sørensen-Dice token-set similarity as a second refinement pass over the
 *    remaining reps (catches paraphrases that share vocabulary but reorder
 *    words — where edit distance alone falls short), combined with a floor
 *    on Levenshtein so pure keyword overlap cannot merge distinct facts,
 *  - recurrence signal is damped: log(1 + distinctSessions), never raw counts.
 */
import type { CorpusObservation, CorpusReflection } from "./corpus.js";
import type { Relevance } from "../om/ledger/types.js";

const NORM_CAP = 400;
const FUZZY_THRESHOLD = 0.92;
const SORENSEN_FUZZY_THRESHOLD = 0.75;
const SORENSEN_MIN_LEVENSHTEIN = 0.6;

/**
 * Tokens stripped before similarity scoring — "user"/"agent" appear in the
 * vast majority of observations and would dominate token-set overlap.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  "user",
  "agent",
  "assistant",
  // relevance labels are rank words, not topics
  "critical",
  "high",
  "medium",
  "low",
  // generic path components (scope dirs, cwd paths)
  "home",
  "projects",
  "github",
  "git",
  "the",
  "a",
  "an",
  "to",
  "of",
  "in",
  "for",
  "on",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "and",
  "but",
  "or",
  "with",
  "at",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "any",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "about",
  "also",
  "because",
  "until",
  "while",
  "which",
  "who",
  "whom",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "she",
  "they",
  "them",
  "their",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "can",
  "shall",
  "need",
  "used",
  "using",
  "one",
  "two",
  "new",
  "old",
  "via",
  "per",
  "etc",
]);

/** Normalized, stop-word-stripped token list for a piece of content. */
export function tokenizeContent(content: string): string[] {
  // Expand common contractions so "don't" and "do not" share tokens
  const expanded = content
    .replace(/\bdon't\b/gi, "do not")
    .replace(/\bcan't\b/gi, "cannot")
    .replace(/\bwon't\b/gi, "will not")
    .replace(/\bisn't\b/gi, "is not")
    .replace(/\baren't\b/gi, "are not")
    .replace(/\bwasn't\b/gi, "was not")
    .replace(/\bweren't\b/gi, "were not")
    .replace(/\bhasn't\b/gi, "has not")
    .replace(/\bhaven't\b/gi, "have not")
    .replace(/\bhadn't\b/gi, "had not")
    .replace(/\bdoesn't\b/gi, "does not")
    .replace(/\bdidn't\b/gi, "did not")
    .replace(/\bcouldn't\b/gi, "could not")
    .replace(/\bshouldn't\b/gi, "should not")
    .replace(/\bwouldn't\b/gi, "would not")
    .replace(/\bmustn't\b/gi, "must not")
    .replace(/\bneedn't\b/gi, "need not")
    .replace(/\bit's\b/gi, "it is")
    .replace(/\bthat's\b/gi, "that is")
    .replace(/\bwhat's\b/gi, "what is")
    .replace(/\bthere's\b/gi, "there is")
    .replace(/\bhere's\b/gi, "here is")
    .replace(/\bhow's\b/gi, "how is")
    .replace(/\bwho's\b/gi, "who is")
    .replace(/\bi'm\b/gi, "i am")
    .replace(/\byou're\b/gi, "you are")
    .replace(/\bwe're\b/gi, "we are")
    .replace(/\bthey're\b/gi, "they are");
  // Split camelCase and PascalCase before stripping non-alpha
  const splitCamel = expanded.replace(/([a-z])([A-Z])/g, "$1 $2");
  return splitCamel
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(
      (t) =>
        t.length >= 3 &&
        !STOP_WORDS.has(t) &&
        !/^\d+$/.test(t) &&
        // Filter commit-like hex sequences (a7a15b5a, 837530d7, etc.)
        !/^[a-f0-9]{7,}$/i.test(t) &&
        // Filter single letters attached to parens/hyphens
        !/^[a-z]$/.test(t),
    );
}

export function normalizeContent(content: string): string {
  // Expand common contractions so "don't" and "do not" normalize identically
  const expanded = content
    .replace(/\bdon't\b/gi, "do not")
    .replace(/\bcan't\b/gi, "cannot")
    .replace(/\bwon't\b/gi, "will not")
    .replace(/\bisn't\b/gi, "is not")
    .replace(/\baren't\b/gi, "are not")
    .replace(/\bwasn't\b/gi, "was not")
    .replace(/\bweren't\b/gi, "were not")
    .replace(/\bhasn't\b/gi, "has not")
    .replace(/\bhaven't\b/gi, "have not")
    .replace(/\bhadn't\b/gi, "had not")
    .replace(/\bdoesn't\b/gi, "does not")
    .replace(/\bdidn't\b/gi, "did not")
    .replace(/\bcouldn't\b/gi, "could not")
    .replace(/\bshouldn't\b/gi, "should not")
    .replace(/\bwouldn't\b/gi, "would not")
    .replace(/\bmustn't\b/gi, "must not")
    .replace(/\bneedn't\b/gi, "need not")
    .replace(/\bit's\b/gi, "it is")
    .replace(/\bthat's\b/gi, "that is")
    .replace(/\bwhat's\b/gi, "what is")
    .replace(/\bthere's\b/gi, "there is")
    .replace(/\bhere's\b/gi, "here is")
    .replace(/\bhow's\b/gi, "how is")
    .replace(/\bwho's\b/gi, "who is")
    .replace(/\bi'm\b/gi, "i am")
    .replace(/\byou're\b/gi, "you are")
    .replace(/\bwe're\b/gi, "we are")
    .replace(/\bthey're\b/gi, "they are");
  return expanded
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NORM_CAP);
}

function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1),
      );
    }
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

function bigramJaccard(
  a: string,
  b: string,
  cache: Map<string, Set<string>>,
): number {
  const bigrams = (s: string): Set<string> => {
    let set = cache.get(s);
    if (!set) {
      set = new Set<string>();
      for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
      cache.set(s, set);
    }
    return set;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Sørensen-Dice coefficient over stop-word-stripped token sets.
 * 2*|intersection|/(|A|+|B|). High when two observations share most
 * content-bearing vocabulary even with different word order.
 */
export function sorensenDiceTokenSimilarity(a: string, b: string): number {
  return sorensenDiceSets(
    new Set(tokenizeContent(a)),
    new Set(tokenizeContent(b)),
  );
}

/** Set-based Sørensen-Dice (avoids re-tokenizing inside O(n²) loops). */
export function sorensenDiceSets(A: Set<string>, B: Set<string>): number {
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}

const TIER_RANK: Record<Relevance, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export interface MemoryCluster<T> {
  /** Best member: highest relevance tier, newest timestamp wins ties. */
  rep: T;
  /** Additional members worth rendering (fuzzy variants), capped. */
  extras: T[];
  occurrences: number;
  distinctSessions: number;
  bestRelevance: Relevance;
  /**
   * Max Sørensen-Dice token-set similarity to any other cluster's rep.
   * Used as a consensus reranking signal (0–1 range, 0 when singleton).
   */
  maxRelatedSimilarity: number;
}

interface ClusterableItem {
  content: string;
  timestamp: string | null;
  sessionId: string;
}

function tsValue(ts: string | null): number {
  if (!ts) return 0;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? 0 : t;
}

function pickRep<T extends ClusterableItem>(members: T[]): T {
  return members.reduce((best, m) =>
    tsValue(m.timestamp) > tsValue(best.timestamp) ? m : best,
  );
}

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    this.parent[this.find(a)] = this.find(b);
  }
}

/**
 * Cluster observations: exact normalized grouping, then optional fuzzy merge
 * of group representatives (bigram-Jaccard prefilter → Levenshtein@0.92),
 * then optional Sørensen-Dice token-set merge over remaining reps
 * (Sørensen-Dice ≥ 0.75 + Levenshtein ≥ 0.60). `maxVariants` bounds how
 * many near-identical members may appear alongside the representative in
 * rendered output.
 */
export function clusterObservations(
  items: CorpusObservation[],
  opts?: { fuzzy?: boolean; sorensen?: boolean; maxVariants?: number },
): Array<MemoryCluster<CorpusObservation>> {
  const maxVariants = opts?.maxVariants ?? 2;

  const groups = new Map<string, CorpusObservation[]>();
  for (const item of items) {
    const key = normalizeContent(item.content);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }

  interface Group {
    key: string;
    members: CorpusObservation[];
  }
  let allGroups: Group[] = [...groups.entries()].map(([key, members]) => ({
    key,
    members,
  }));

  if (opts?.fuzzy && allGroups.length > 1) {
    const uf = new UnionFind(allGroups.length);
    const cache = new Map<string, Set<string>>();
    for (let i = 0; i < allGroups.length; i++) {
      for (let j = i + 1; j < allGroups.length; j++) {
        const a = allGroups[i].key;
        const b = allGroups[j].key;
        const la = a.length;
        const lb = b.length;
        if (Math.abs(la - lb) > (1 - FUZZY_THRESHOLD) * Math.max(la, lb, 1))
          continue;
        if (bigramJaccard(a, b, cache) < FUZZY_THRESHOLD - 0.15) continue;
        if (levenshteinSimilarity(a, b) >= FUZZY_THRESHOLD) uf.union(i, j);
      }
    }
    const merged = new Map<number, Group>();
    allGroups.forEach((g, i) => {
      const root = uf.find(i);
      const acc = merged.get(root);
      if (acc) {
        acc.members.push(...g.members);
      } else {
        merged.set(root, { key: g.key, members: [...g.members] });
      }
    });
    allGroups = [...merged.values()];
  }

  // Pass 3: Sørensen-Dice token-set similarity merges tightly related
  // clusters that the Levenshtein pass missed (paraphrases with word-order
  // changes). Requires a floor on Levenshtein to prevent pure keyword overlap
  // from merging distinct facts.
  if (opts?.sorensen && allGroups.length > 1) {
    const uf = new UnionFind(allGroups.length);
    // Precompute reps + token sets for O(n²) efficiency
    const groupReps = allGroups.map((g) =>
      normalizeContent(pickRep(g.members).content),
    );
    const repTokens = groupReps.map((s) => new Set(tokenizeContent(s)));
    for (let i = 0; i < allGroups.length; i++) {
      for (let j = i + 1; j < allGroups.length; j++) {
        const a = groupReps[i];
        const b = groupReps[j];
        const la = a.length;
        const lb = b.length;
        if (
          Math.abs(la - lb) >
          (1 - SORENSEN_FUZZY_THRESHOLD) * Math.max(la, lb, 1)
        )
          continue;
        if (levenshteinSimilarity(a, b) < SORENSEN_MIN_LEVENSHTEIN) continue;
        if (
          sorensenDiceSets(repTokens[i], repTokens[j]) >=
          SORENSEN_FUZZY_THRESHOLD
        )
          uf.union(i, j);
      }
    }
    const merged = new Map<number, Group>();
    allGroups.forEach((g, i) => {
      const root = uf.find(i);
      const acc = merged.get(root);
      if (acc) {
        acc.members.push(...g.members);
      } else {
        merged.set(root, { key: g.key, members: [...g.members] });
      }
    });
    allGroups = [...merged.values()];
  }

  const clusters: Array<MemoryCluster<CorpusObservation>> = [];
  for (const group of allGroups) {
    const { members } = group;
    const bestRelevance = members.reduce<Relevance>(
      (best, m) =>
        TIER_RANK[m.relevance] > TIER_RANK[best] ? m.relevance : best,
      "low",
    );
    const rep =
      members
        .filter((m) => m.relevance === bestRelevance)
        .reduce((best, m) =>
          tsValue(m.timestamp) > tsValue(best.timestamp) ? m : best,
        ) ?? pickRep(members);
    const repKey = normalizeContent(rep.content);
    const extras = members.filter(
      (m) => m !== rep && normalizeContent(m.content) !== repKey,
    );
    clusters.push({
      rep,
      extras: extras.slice(0, maxVariants),
      occurrences: members.length,
      distinctSessions: new Set(members.map((m) => m.sessionId)).size,
      bestRelevance,
      maxRelatedSimilarity: 0,
    });
  }

  // Consensus rerank signal: max Sørensen-Dice to any other cluster.
  if (clusters.length > 1) {
    const repTokenSets = clusters.map(
      (c) => new Set(tokenizeContent(c.rep.content)),
    );
    for (let i = 0; i < clusters.length; i++) {
      let maxSim = 0;
      for (let j = 0; j < clusters.length; j++) {
        if (i === j) continue;
        const sim = sorensenDiceSets(repTokenSets[i], repTokenSets[j]);
        if (sim > maxSim) maxSim = sim;
      }
      clusters[i].maxRelatedSimilarity = maxSim;
    }
  }
  return clusters;
}

/** Reflections cluster by exact content only — they are already syntheses. */
export function clusterReflections(
  items: CorpusReflection[],
): Array<MemoryCluster<CorpusReflection>> {
  const groups = new Map<string, CorpusReflection[]>();
  for (const item of items) {
    const key = normalizeContent(item.content);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const clusters: Array<MemoryCluster<CorpusReflection>> = [];
  for (const [, members] of groups) {
    const rep = pickRep(members);
    clusters.push({
      rep,
      extras: [],
      occurrences: members.length,
      distinctSessions: new Set(members.map((m) => m.sessionId)).size,
      bestRelevance: "medium",
      maxRelatedSimilarity: 0,
    });
  }
  return clusters;
}
