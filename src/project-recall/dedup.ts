/**
 * Near-duplicate clustering for the observational-memory corpus.
 *
 * Receipts: plan-07 §19.4 —
 *  - exact normalized-content grouping first (halves real corpora; kills
 *    fork/move inflation and pipeline record bursts),
 *  - levenshtein clustering as a *refinement* over group representatives,
 *  - recurrence signal is damped: log(1 + distinctSessions), never raw counts.
 */
import type { CorpusObservation, CorpusReflection } from "./corpus.js";
import type { Relevance } from "../om/ledger/types.js";

const NORM_CAP = 400;
const FUZZY_THRESHOLD = 0.92;

export function normalizeContent(content: string): string {
  return content
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
 * of group representatives. `maxVariants` bounds how many near-identical
 * members may appear alongside the representative in rendered output.
 */
export function clusterObservations(
  items: CorpusObservation[],
  opts?: { fuzzy?: boolean; maxVariants?: number },
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
    });
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
    });
  }
  return clusters;
}
