/**
 * Export ranking + markdown rendering — the distilled project-memory artifact.
 *
 * Primary structure: tier-based sections (Reflections → Critical → High →
 * Medium → Low) with cross-cutting topic badges on each observation bullet.
 * Topic groups are derived from Sørensen-Dice similarity graph clustering
 * with TF-IDF topic labeling.
 *
 * Ranking discipline (§19 receipts): relevance tier is the primary rank
 * input, tier-dependent recency decay `1/(1+days)^exp` (critical 0.25 →
 * low 0.34, D4 base 0.3) modulates within tiers, recurrence is damped to
 * log(1 + distinctSessions) with burst penalty for high
 * occurrences/session, coverage (reflection validation) boosts by
 * log(1+coverage), consensus (max Sørensen-Dice to a sibling cluster)
 * adds a small weight, and information density (token count) mildly
 * rewards substantive observations.
 */
import type {
  CorpusObservation,
  CorpusReflection,
  ProjectCorpus,
} from "./corpus.js";
import {
  clusterObservations,
  clusterReflections,
  tokenizeContent,
  sorensenDiceSets,
  type MemoryCluster,
} from "./dedup.js";
import type { Relevance } from "../om/ledger/types.js";

const TIER_WEIGHT: Record<Relevance, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};
const TIER_ORDER: Relevance[] = ["critical", "high", "medium", "low"];
const TIER_RANK = TIER_WEIGHT; // alias for clarity in reflection tier inference
/** D4 recency decay exponent (base for medium tier). */
const RECENCY_DECAY_EXP = 0.3;
/** Tier-dependent decay exponents: critical fades slower than low. */
const TIER_DECAY_EXP: Record<Relevance, number> = {
  critical: 0.25,
  high: 0.28,
  medium: 0.31,
  low: 0.34,
};
/** Coverage multiplier weight (observations validated by reflections). */
const COVERAGE_WEIGHT = 0.3;
/** Consensus rerank weight (max Sørensen-Dice to a sibling cluster). */
const CONSENSUS_WEIGHT = 0.2;
/** Burst penalty weight: down-ranks clusters with high occurrences/session ratio. */
const BURST_PENALTY_WEIGHT = 0.15;
/** Information-density weight: rewards token-rich observations. */
const LENGTH_WEIGHT = 0.08;
/**
 * Sørensen-Dice threshold for the level-1 topic similarity graph edge.
 * Two clusters share an edge when their stop-word-stripped token sets
 * score ≥ this.
 */
const TOPIC_SIMILARITY_THRESHOLD = 0.25;
/** Threshold step between hierarchical re-clustering levels. */
const TOPIC_SPLIT_STEP = 0.1;
/** Max clusters in one topic before it is re-clustered at a stricter level. */
const MAX_COMPONENT_SIZE = 30;
/** Max split depth (threshold climbs 0.25 → 0.85 over 6 steps). */
const MAX_SPLIT_DEPTH = 6;
/** Minimum clusters in a connected component to form a topic group. */
const MIN_TOPIC_SIZE = 5;

export function relativeTime(
  timestamp: string | null,
  nowMs: number,
): string | null {
  if (!timestamp) return null;
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return null;
  const diffMs = Math.max(0, nowMs - t);
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (days < 60) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function recencyDecay(
  timestamp: string | null,
  nowMs: number,
  tier?: Relevance,
): number {
  if (!timestamp) return 0.5;
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return 0.5;
  const days = Math.max(0, (nowMs - t) / 86400000);
  const exp = tier
    ? (TIER_DECAY_EXP[tier] ?? RECENCY_DECAY_EXP)
    : RECENCY_DECAY_EXP;
  return 1 / Math.pow(1 + days, exp);
}

interface Scoreable {
  timestamp: string | null;
  content: string;
}

function burstPenalty(cluster: MemoryCluster<Scoreable>): number {
  if (cluster.distinctSessions === 0) return 1;
  const ratio = cluster.occurrences / cluster.distinctSessions;
  if (ratio <= 1.5) return 1;
  return 1 / (1 + BURST_PENALTY_WEIGHT * Math.log2(ratio));
}

/**
 * Technical entity density factor: rewards observations containing concrete
 * technical artifacts across multi-language, web framework, systems, devops,
 * database, and protocol ecosystems over generic conversational prose.
 */
export function technicalDensityFactor(content: string): number {
  let entityCount = 0;

  // 1. File paths, extensions & configuration manifests (all major languages & web/devops formats)
  const fileExts =
    "ts|tsx|js|jsx|mjs|cjs|vue|svelte|astro|html|css|scss|sass|less|wasm|" +
    "rs|go|c|cpp|cc|cxx|h|hpp|zig|nim|java|kt|kts|scala|cs|fs|swift|" +
    "py|rb|php|lua|pl|sh|bash|zsh|fish|" +
    "json|json5|jsonc|yaml|yml|toml|xml|ini|env|sql|prisma|graphql|gql|proto|tf|hcl";
  const fileMatches = content.match(
    new RegExp(
      `\\b[\\w.-]+[\\\\/][\\w.-]+(?:\\.(?:${fileExts}))?\\b|` +
        `\\b[\\w.-]+\\.(?:${fileExts})\\b|` +
        `\\b(?:Dockerfile|Containerfile|Makefile|Vagrantfile|Procfile|package\\.json|Cargo\\.toml|go\\.mod|requirements\\.txt|pyproject\\.toml|pom\\.xml|build\\.gradle|\\.gitignore|\\.dockerignore|\\.env(?:\\.[\\w-]+)?)\\b`,
      "gi",
    ),
  );
  if (fileMatches) entityCount += fileMatches.length * 1.5;

  // 2. Code symbols, function/method calls, types, generics, annotations & scoped identifiers
  const symbolMatches = content.match(
    /\b[a-zA-Z_]\w*\(\)|\b[a-zA-Z_]\w*(?:::|->|\.)[a-zA-Z_]\w*|\b[a-z]+[A-Z]\w*\b|\b[A-Z][a-z]+[A-Z]\w*\b|\b(?:Array|Option|Result|Map|Set|Promise|Vec|List|HashMap)<[\w\s,<>]+>|@\w+(?:\([^)]*\))?|#\[\w+(?:\([^)]*\))?\]/g,
  );
  if (symbolMatches) entityCount += symbolMatches.length;

  // 3. Web, HTTP methods, REST routes, status codes & API protocols
  const apiMatches = content.match(
    /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/[/\w:.-]*|\b[1-5]\d{2}\s+(?:OK|Created|Accepted|No Content|Bad Request|Unauthorized|Forbidden|Not Found|Conflict|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable)\b|\/(?:api|v[0-9]+|auth|users|healthz|metrics|ws|graphql)[/\w:.-]*/gi,
  );
  if (apiMatches) entityCount += apiMatches.length * 1.5;

  // 4. Config keys, environment variables, CLI commands & flags
  const configMatches = content.match(
    /\b(?:REACT_APP_|NEXT_PUBLIC_|VITE_|DATABASE_|NODE_|AWS_|DOCKER_|KUBE_|PI_|PI_BLACKHOLE_)[A-Z0-9_]+\b|\b[A-Z][A-Z0-9_]{3,}\b|\b(?:--[a-z0-9_-]+(?:=[^\s]+)?|-[a-zA-Z]{1,3})\b|\b(?:npm|pnpm|yarn|bun|cargo|go|rustc|docker|kubectl|git|make|pytest|pip|uv)\s+[a-z0-9_-]+/g,
  );
  if (configMatches) entityCount += configMatches.length * 1.5;

  // 5. Error classes, exceptions, signals, commit SHAs & SemVer versions
  const systemMatches = content.match(
    /\b[A-Z]\w*(?:Exception|Error|Fault|Failure|Panic|SIGSEGV|SIGTERM|ECONNREFUSED|ETIMEDOUT|ENOTFOUND)\b|\b[a-f0-9]{7,40}\b|\bv?\d+\.\d+\.\d+(?:-[a-zA-Z0-9_.-]+)?\b/gi,
  );
  if (systemMatches) entityCount += systemMatches.length;

  // Sublinear scaling: 1.0 (baseline) up to ~1.45 for rich technical observations
  return 1 + 0.12 * Math.log2(1 + entityCount);
}

function lengthAndDensityFactor(content: string): number {
  const tokens = tokenizeContent(content).length;
  const lenFactor = 1 + LENGTH_WEIGHT * Math.log2(1 + tokens / 8);
  const techFactor = technicalDensityFactor(content);
  return lenFactor * techFactor;
}

function clusterScore<T extends Scoreable>(
  cluster: MemoryCluster<T>,
  tier: Relevance,
  nowMs: number,
  coverage = 0,
): number {
  return (
    TIER_WEIGHT[tier] *
    recencyDecay(cluster.rep.timestamp, nowMs, tier) *
    (1 + Math.log2(1 + cluster.distinctSessions)) *
    (1 + COVERAGE_WEIGHT * Math.log2(1 + coverage)) *
    (1 + CONSENSUS_WEIGHT * cluster.maxRelatedSimilarity) *
    burstPenalty(cluster as MemoryCluster<Scoreable>) *
    lengthAndDensityFactor(cluster.rep.content)
  );
}

function buildObsTierMap(
  observations: CorpusObservation[],
): Map<string, Relevance> {
  const map = new Map<string, Relevance>();
  for (const o of observations) {
    if (o.id) map.set(o.id, o.relevance);
  }
  return map;
}

/**
 * Infer a reflection's relevance tier from the highest-tier observation it
 * cites. Falls back to "medium" when the reflection has no supporting
 * observations or none of them can be resolved in the corpus.
 */
function inferReflectionTier(
  cluster: MemoryCluster<CorpusReflection>,
  obsTier: Map<string, Relevance>,
): Relevance {
  if (cluster.rep.supportingObservationIds.length === 0) return "medium";
  let best: Relevance = "medium";
  let bestRank = 0;
  for (const id of cluster.rep.supportingObservationIds) {
    const rel = obsTier.get(id);
    if (!rel) continue;
    const rank = TIER_RANK[rel];
    if (rank > bestRank) {
      bestRank = rank;
      best = rel;
    }
  }
  return best;
}

/**
 * Reflections are reflector-curated: a second LLM pass reviewed, dropped, and
 * promoted observations before distilling them, so they carry verified value
 * and rank with a tier-aware weight (inferred from supporting observations)
 * plus an evidence-mass multiplier from their supporting observations (§17.3).
 */
function reflectionScore(
  cluster: MemoryCluster<CorpusReflection>,
  nowMs: number,
  obsTier: Map<string, Relevance>,
): number {
  const tier = inferReflectionTier(cluster, obsTier);
  const weight = TIER_WEIGHT[tier];
  return (
    weight *
    recencyDecay(cluster.rep.timestamp, nowMs, tier) *
    (1 + Math.log2(1 + cluster.distinctSessions)) *
    (1 + Math.log2(1 + cluster.rep.supportingObservationIds.length)) *
    burstPenalty(cluster as MemoryCluster<Scoreable>) *
    lengthAndDensityFactor(cluster.rep.content)
  );
}

function flatten(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

export interface ExportStats {
  sessionsConsidered: number;
  filesWithMarkers: number;
  observationsTotal: number;
  observationsClustered: number;
  observationsRendered: number;
  observationsFiltered: number;
  duplicatesCollapsed: number;
  reflectionsTotal: number;
  droppedExcluded: number;
  orphanedObservations: number;
  orphanedReflections: number;
  orphanedSessions: number;
  topicGroups: number;
}

// ── Coverage index ──────────────────────────────────────────────

/** Map: observation memory id → count of reflections that cite it. */
function buildCoverageIndex(
  reflections: CorpusReflection[],
): Map<string, number> {
  const index = new Map<string, number>();
  for (const r of reflections) {
    for (const id of r.supportingObservationIds) {
      index.set(id, (index.get(id) ?? 0) + 1);
    }
  }
  return index;
}

/** Reflection coverage for one cluster: total citations of any member id. */
function clusterCoverage(
  cluster: MemoryCluster<CorpusObservation>,
  coverageIndex: Map<string, number>,
): number {
  let total = 0;
  const seen = new Set<string>();
  const absorb = (id: string | null) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const n = coverageIndex.get(id);
    if (n) total += n;
  };
  absorb(cluster.rep.id);
  for (const extra of cluster.extras) absorb(extra.id);
  return total;
}

// ── Viability gate ─────────────────────────────────────────────

/**
 * Viability gate: keep clusters with recurrence, reflection coverage,
 * or high tier. Low/medium single-session unsupported clusters are noise.
 */
function passesViability(
  cluster: MemoryCluster<CorpusObservation>,
  coverage: number,
): boolean {
  if (cluster.distinctSessions >= 2) return true;
  if (coverage > 0) return true;
  if (cluster.bestRelevance === "low") return false;
  if (cluster.bestRelevance === "medium") {
    // Keep longer medium observations even without support
    return flatten(cluster.rep.content).length >= 50;
  }
  // high / critical always pass
  return true;
}

// ── Topic assignment via similarity graph ──────────────────────

class UnionFindTopic {
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

interface TopicInfo {
  label: string;
  indices: number[];
}

type TopicAssignment = Map<MemoryCluster<CorpusObservation>, string>;

/**
 * Tokens commonly appearing in compaction/pipeline artifact headers that
 * should be stripped from topic token sets (but not from dedup, where they
 * help merge similar compaction artifacts). Also strips agent meta-utterances
 * and event verbs that carry no topical signal.
 */
const TOPIC_STOP_WORDS = new Set([
  // compaction section headers
  "changes",
  "compaction",
  "files",
  "goal",
  "original",
  "session",
  "summary",
  // agent meta-utterances / filler speech
  "let",
  "reading",
  "examining",
  "looking",
  "need",
  "going",
  "want",
  "instructs",
  "instructed",
  "stated",
  "decided",
  "completed",
  "implemented",
  "updated",
  "created",
  "rewrote",
  "fixed",
  "added",
  "removed",
  "identified",
  "confirmed",
  "verified",
  "proposed",
  "diagnosed",
  "began",
  "begun",
  // generic git/project scaffolding that produces opaque labels
  "branch",
  "branches",
  "main",
  "feat",
  "fix",
  "chore",
  "commit",
  "commits",
  "insertion",
  "insertions",
  "deletion",
  "deletions",
  "diff",
  "pr",
  "file",
  "code",
  "docs",
  "document",
]);

/**
 * Connected components of the subset graph where an edge exists between two
 * clusters when their Sørensen-Dice ≥ threshold. Operates on *original*
 * cluster indices (subset members are passed through unchanged).
 */
function connectedComponents(
  subset: number[],
  tokenSets: Set<string>[],
  threshold: number,
): number[][] {
  const n = subset.length;
  if (n === 0) return [];
  const uf = new UnionFindTopic(n);
  // When |A| = k|B| (k≥1), S ≤ 2/(k+1), so S < τ whenever
  // k > 2/τ − 1. Prunes most O(n²) pairs without any intersection.
  const maxSizeRatio = 2 / threshold - 1;
  const sizes = tokenSets.map((s) => s.size);
  for (let i = 0; i < n; i++) {
    const ai = subset[i];
    const sa = sizes[ai];
    if (sa === 0) continue;
    for (let j = i + 1; j < n; j++) {
      const bj = subset[j];
      const sb = sizes[bj];
      if (sb === 0) continue;
      const ratio = sa > sb ? sa / sb : sb / sa;
      if (ratio > maxSizeRatio) continue;
      if (sorensenDiceSets(tokenSets[ai], tokenSets[bj]) >= threshold) {
        uf.union(i, j);
      }
    }
  }
  const comps = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    const arr = comps.get(root);
    if (arr) arr.push(subset[i]);
    else comps.set(root, [subset[i]]);
  }
  return [...comps.values()];
}

/**
 * Assign observation clusters to topics via hierarchical Sørensen-Dice
 * similarity-graph clustering.
 *
 * Level 1: connected components at TOPIC_SIMILARITY_THRESHOLD. Components
 * larger than MAX_COMPONENT_SIZE are recursively re-clustered at a stricter
 * threshold (+TOPIC_SPLIT_STEP per level) until they fragment into coherent
 * sub-topics or cannot split further.
 *
 * Returns a Map of cluster → topic label (only for assigned clusters).
 * Unassigned clusters (singletons, pairs) render without a badge.
 */
function assignTopics(
  clusters: Array<MemoryCluster<CorpusObservation>>,
): TopicAssignment {
  if (clusters.length < MIN_TOPIC_SIZE) return new Map();

  // Cache token sets for all clusters, filtering out compaction-artifact
  // words that would glue unrelated clusters (O(n) precomputation)
  const orderedTokens = clusters.map((c) => {
    const tokens = tokenizeContent(flatten(c.rep.content));
    return tokens.filter((t) => !TOPIC_STOP_WORDS.has(t));
  });
  const tokenSets = orderedTokens.map((arr) => new Set(arr));

  // Global document frequencies for TF-IDF labeling (computed once)
  const df = new Map<string, number>();
  for (const set of tokenSets) {
    const deduped = new Set(set);
    for (const t of deduped) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const totalClusters = clusters.length;

  // Level-1 components over all clusters
  const level1 = connectedComponents(
    Array.from({ length: clusters.length }, (_, i) => i),
    tokenSets,
    TOPIC_SIMILARITY_THRESHOLD,
  );

  const topics = splitComponents(
    level1,
    tokenSets,
    orderedTokens,
    df,
    totalClusters,
    TOPIC_SIMILARITY_THRESHOLD,
    0,
  );
  if (topics.length === 0) return new Map();

  topics.sort((a, b) => b.indices.length - a.indices.length);

  const assignment: TopicAssignment = new Map();
  for (const topic of topics)
    for (const idx of topic.indices) assignment.set(clusters[idx], topic.label);
  return assignment;
}

/**
 * Recursively split the level-1 components: any component larger than
 * MAX_COMPONENT_SIZE is re-clustered at threshold + TOPIC_SPLIT_STEP until
 * it fragments into coherent sub-topics or cannot split further (in which
 * case it is accepted as one large topic so nothing is dropped).
 */
function splitComponents(
  components: number[][],
  tokenSets: Set<string>[],
  orderedTokens: string[][],
  df: Map<string, number>,
  totalClusters: number,
  threshold: number,
  depth: number,
): TopicInfo[] {
  const topics: TopicInfo[] = [];
  for (const comp of components) {
    if (comp.length <= MAX_COMPONENT_SIZE) {
      if (comp.length >= MIN_TOPIC_SIZE) {
        topics.push({
          label: computeTopicLabel(
            comp,
            tokenSets,
            orderedTokens,
            df,
            totalClusters,
          ),
          indices: comp,
        });
      }
      continue;
    }
    // Large component — try to split at a stricter threshold
    const nextThreshold = threshold + TOPIC_SPLIT_STEP;
    if (nextThreshold >= 0.9 || depth >= MAX_SPLIT_DEPTH) {
      topics.push({
        label: computeTopicLabel(
          comp,
          tokenSets,
          orderedTokens,
          df,
          totalClusters,
        ),
        indices: comp,
      });
      continue;
    }
    const sub = connectedComponents(comp, tokenSets, nextThreshold);
    if (sub.length <= 1) {
      // Threshold raise did not fragment — accept as-is
      topics.push({
        label: computeTopicLabel(
          comp,
          tokenSets,
          orderedTokens,
          df,
          totalClusters,
        ),
        indices: comp,
      });
      continue;
    }
    topics.push(
      ...splitComponents(
        sub,
        tokenSets,
        orderedTokens,
        df,
        totalClusters,
        nextThreshold,
        depth + 1,
      ),
    );
  }
  return topics;
}

/**
 * Class-based TF-IDF topic label: prefers the most frequent ordered bigram in the topic
 * when it is dominant (appears in ≥30% of members and ≥3 times), otherwise
 * falls back to top-2 tokens scored by c-TF-IDF (Class-based TF-IDF with sublinear saturation).
 * c-IDF = log(1 + totalClusters / df) suppresses project-wide noise words.
 * Short 3-char tokens are penalized and prefix-duplicates are deduped.
 */
function computeTopicLabel(
  indices: number[],
  tokenSets: Set<string>[],
  orderedTokens: string[][],
  df: Map<string, number>,
  totalClusters: number,
): string {
  // Try bigram first: most frequent ordered adjacent pair in topic
  const bigramCounts = new Map<string, number>();
  for (const idx of indices) {
    const arr = orderedTokens[idx];
    for (let i = 0; i < arr.length - 1; i++) {
      const bg = `${arr[i]} ${arr[i + 1]}`;
      bigramCounts.set(bg, (bigramCounts.get(bg) ?? 0) + 1);
    }
  }
  if (bigramCounts.size > 0) {
    const sortedBigrams = [...bigramCounts.entries()].sort(
      (a, b) => b[1] - a[1],
    );
    const [topBigram, topCount] = sortedBigrams[0];
    const threshold = Math.max(3, Math.ceil(indices.length * 0.3));
    if (topCount >= threshold) {
      const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
      const label = topBigram.split(" ").map(capitalize).join(" ");
      if (label.length > 40) return label.slice(0, 40);
      return label;
    }
  }

  // Fallback: top-2 c-TF-IDF tokens
  const tf = new Map<string, number>();
  for (const idx of indices) {
    for (const t of tokenSets[idx]) tf.set(t, (tf.get(t) ?? 0) + 1);
  }

  const scored = [...tf.entries()]
    .map(([token, count]) => {
      // Sublinear term saturation prevents single observation bursts from dominating
      const tfSat = Math.log2(1 + count);
      const idf = Math.log(1 + totalClusters / (df.get(token) ?? 1));
      const lenWeight = token.length <= 3 ? 0.6 : 1;
      return {
        token,
        score: tfSat * idf * lenWeight,
      };
    })
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return "Observations";

  const picked: typeof scored = [];
  for (const cand of scored) {
    if (picked.length >= 2) break;
    const dup = picked.some(
      (p) =>
        p.token.startsWith(cand.token) ||
        cand.token.startsWith(p.token) ||
        (p.token.length >= 4 &&
          cand.token.length >= 4 &&
          p.token.slice(0, 4) === cand.token.slice(0, 4)),
    );
    if (dup) continue;
    picked.push(cand);
  }
  const final = picked.length > 0 ? picked : scored.slice(0, 2);

  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const label = final.map((s) => capitalize(s.token)).join(" ");
  return label.length > 40 ? label.slice(0, 40) : label;
}

/**
 * Reflection-first topic assignment: cluster reflections by Sørensen-Dice
 * similarity and label each component with TF-IDF on reflection text.
 * These labels become the primary topic vocabulary; observations inherit
 * them via supportingObservationIds.
 */
function assignReflectionTopics(
  reflClusters: Array<MemoryCluster<CorpusReflection>>,
): Map<MemoryCluster<CorpusReflection>, string> {
  if (reflClusters.length < MIN_TOPIC_SIZE) return new Map();

  const orderedTokens = reflClusters.map((c) => {
    const tokens = tokenizeContent(flatten(c.rep.content));
    return tokens.filter((t) => !TOPIC_STOP_WORDS.has(t));
  });
  const tokenSets = orderedTokens.map((arr) => new Set(arr));

  const df = new Map<string, number>();
  for (const set of tokenSets) {
    const deduped = new Set(set);
    for (const t of deduped) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const total = reflClusters.length;

  const level1 = connectedComponents(
    Array.from({ length: reflClusters.length }, (_, i) => i),
    tokenSets,
    TOPIC_SIMILARITY_THRESHOLD,
  );

  const topics = splitComponents(
    level1,
    tokenSets,
    orderedTokens,
    df,
    total,
    TOPIC_SIMILARITY_THRESHOLD,
    0,
  );
  if (topics.length === 0) return new Map();

  topics.sort((a, b) => b.indices.length - a.indices.length);

  const assignment = new Map<MemoryCluster<CorpusReflection>, string>();
  for (const topic of topics)
    for (const idx of topic.indices)
      assignment.set(reflClusters[idx], topic.label);
  return assignment;
}

/**
 * Map observation clusters to topic labels by walking supportingObservationIds
 * from reflection clusters. An observation inherits the topic of the
 * highest-tier reflection that cites it.
 */
function buildObservationTopicMap(
  reflTopicAssignments: Map<MemoryCluster<CorpusReflection>, string>,
  obsClusters: Array<MemoryCluster<CorpusObservation>>,
  observations: CorpusObservation[],
): Map<MemoryCluster<CorpusObservation>, string> {
  const obsIdToCluster = new Map<string, MemoryCluster<CorpusObservation>>();
  for (const cluster of obsClusters) {
    if (cluster.rep.id) obsIdToCluster.set(cluster.rep.id, cluster);
    for (const extra of cluster.extras) {
      if (extra.id) obsIdToCluster.set(extra.id, cluster);
    }
  }

  const obsTier = buildObsTierMap(observations);

  // Track best topic per observation cluster, keyed by reflection tier rank
  const best = new Map<
    MemoryCluster<CorpusObservation>,
    { label: string; tierRank: number }
  >();

  for (const [reflCluster, topic] of reflTopicAssignments) {
    const reflTier = inferReflectionTier(reflCluster, obsTier);
    const tierRank = TIER_RANK[reflTier];
    for (const obsId of reflCluster.rep.supportingObservationIds) {
      const obsCluster = obsIdToCluster.get(obsId);
      if (!obsCluster) continue;
      const existing = best.get(obsCluster);
      if (!existing || tierRank > existing.tierRank) {
        best.set(obsCluster, { label: topic, tierRank });
      }
    }
  }

  const result = new Map<MemoryCluster<CorpusObservation>, string>();
  for (const [cluster, { label }] of best) result.set(cluster, label);
  return result;
}

// ── Bullet rendering ──────────────────────────────────────────

/** Emit markdown bullet lines from a pre-scored cluster array. */
function emitBullets(
  scored: Array<{
    cluster: MemoryCluster<CorpusObservation>;
    score: number;
  }>,
  nowMs: number,
  topicAssignments: Map<MemoryCluster<CorpusObservation>, string>,
): string[] {
  const lines: string[] = [];
  for (const { cluster } of scored) {
    const parts: string[] = [];
    const age = relativeTime(cluster.rep.timestamp, nowMs);
    if (age) parts.push(age);
    if (cluster.distinctSessions > 1)
      parts.push(`across ${cluster.distinctSessions} sessions`);
    if (
      cluster.occurrences > 1 &&
      cluster.occurrences > cluster.distinctSessions
    )
      parts.push(`recorded ${cluster.occurrences}×`);
    const meta = parts.length > 0 ? ` *(${parts.join(" · ")})*` : "";

    const topic = topicAssignments.get(cluster);
    const badge = topic ? ` **[${topic}]**` : "";
    lines.push(`-${badge} ${flatten(cluster.rep.content)}${meta}`);
    for (const extra of cluster.extras) {
      lines.push(`  - ${flatten(extra.content)}`);
    }
  }
  return lines;
}

// ── Score-and-render helpers ──────────────────────────────────

/**
 * Score all clusters using their own bestRelevance, sort, render bullets.
 * Used for tier-filtered sections and orphan clusters.
 */
function renderScoredBullets(
  clusters: Array<MemoryCluster<CorpusObservation>>,
  coverageIndex: Map<string, number>,
  nowMs: number,
  topicAssignments: Map<MemoryCluster<CorpusObservation>, string>,
): string[] {
  const scored = clusters.map((cluster) => ({
    cluster,
    score: clusterScore(
      cluster,
      cluster.bestRelevance,
      nowMs,
      clusterCoverage(cluster, coverageIndex),
    ),
  }));
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      flatten(b.cluster.rep.content).localeCompare(
        flatten(a.cluster.rep.content),
      ),
  );
  return emitBullets(scored, nowMs, topicAssignments);
}

// ── Main export function ──────────────────────────────────────

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

export function buildExportMarkdown(
  corpus: ProjectCorpus,
  opts?: { now?: number; title?: string },
): { markdown: string; stats: ExportStats } {
  const now = opts?.now ?? Date.now();
  const title =
    opts?.title ??
    corpus.projectRoot.split("/").filter(Boolean).pop() ??
    corpus.projectRoot;

  // Dropper-pruned ids never render in the body (§17.3: dropped does not boost).
  const notDropped = (o: CorpusObservation) =>
    !o.id || !corpus.droppedIds.has(o.id);
  const branchAndPendingObs = corpus.observations.filter(
    (o) => o.source !== "orphan" && notDropped(o),
  );
  const orphanObs = corpus.observations.filter(
    (o) => o.source === "orphan" && notDropped(o),
  );
  const branchAndPendingRefl = corpus.reflections.filter(
    (r) => r.source !== "orphan",
  );
  const orphanRefl = corpus.reflections.filter((r) => r.source === "orphan");

  const obsClusters = clusterObservations(branchAndPendingObs, {
    fuzzy: true,
    sorensen: true,
  });
  const reflClusters = clusterReflections(branchAndPendingRefl);
  const orphanObsClusters = clusterObservations(orphanObs);

  const coverageIndex = buildCoverageIndex(branchAndPendingRefl);

  // Viability gate on branch/observation clusters
  const viable = obsClusters.filter((c) =>
    passesViability(c, clusterCoverage(c, coverageIndex)),
  );
  const observationsFiltered = obsClusters.length - viable.length;

  // Orphan gate: only clusters seen across ≥2 orphaned sessions
  const viableOrphans = orphanObsClusters.filter(
    (c) => c.distinctSessions >= 2,
  );

  // Reflection-first topic assignment: reflections label the topics,
  // observations inherit via supportingObservationIds; unseeded
  // observations fall back to observation-cluster TF-IDF labels.
  const reflTopicAssignments = assignReflectionTopics(reflClusters);
  const reflectionDerivedTopics = buildObservationTopicMap(
    reflTopicAssignments,
    viable,
    branchAndPendingObs,
  );

  // Fallback: observation-cluster topics for unassigned observations
  const unassignedObs = viable.filter((c) => !reflectionDerivedTopics.has(c));
  const fallbackTopicAssignments = assignTopics(unassignedObs);

  // Merge: reflection-derived topics take precedence
  const topicAssignments = new Map(reflectionDerivedTopics);
  for (const [cluster, label] of fallbackTopicAssignments) {
    if (!topicAssignments.has(cluster)) {
      topicAssignments.set(cluster, label);
    }
  }
  const uniqueTopicLabels = new Set(topicAssignments.values());
  const topicGroups = uniqueTopicLabels.size;

  const sections: string[] = [];

  // ── 1. Methodology note (reader-facing) ──────────────────
  const pctFiltered =
    observationsFiltered > 0 && obsClusters.length > 0
      ? `~${Math.round((observationsFiltered / obsClusters.length) * 100)}% of unique clusters removed`
      : "";
  const topicNote =
    topicGroups > 0
      ? ` **Topic badges** like **[${[...uniqueTopicLabels][0]}]** group related items.`
      : "";

  const introParagraphs = [
    `_This file is a distilled artifact of pi-blackhole's observational memory for this project._`,
    ``,
    `_Observations carry an LLM-assigned **relevance tier** ([critical] > [high] > [medium] > [low]) and are organized by tier into sections below. The **Reflections** section at the top contains curator-verified insights from a second LLM pass — these are the most authoritative entries._${topicNote} _The **viability gate** filters single-session unsupported low/medium observations as likely transient noise (${pctFiltered})._`,
    "",
  ];

  const topicCounts = new Map<string, number>();
  for (const label of topicAssignments.values()) {
    topicCounts.set(label, (topicCounts.get(label) ?? 0) + 1);
  }
  const sortedTopics = [...topicCounts.entries()].sort((a, b) => b[1] - a[1]);
  if (sortedTopics.length >= 2) {
    introParagraphs.push(
      `### Key Topics`,
      "",
      ...sortedTopics
        .slice(0, 12)
        .map(
          ([lbl, cnt]) => `- **[${lbl}]** (${cnt} item${cnt > 1 ? "s" : ""})`,
        ),
      "",
    );
  }

  sections.push(introParagraphs.join("\n"));

  // ── 2. Reflections (standalone top section, tier subheaders) ─
  if (reflClusters.length > 0 || orphanRefl.length > 0) {
    sections.push(["## Reflections", ""].join("\n"));

    const renderReflectionTier = (
      tier: Relevance,
      clusters: Array<MemoryCluster<CorpusReflection>>,
      obsPool: CorpusObservation[],
    ) => {
      const obsTier = buildObsTierMap(obsPool);
      const tierClusters = clusters.filter(
        (c) => inferReflectionTier(c, obsTier) === tier,
      );
      if (tierClusters.length === 0) return;
      const label =
        tier.charAt(0).toUpperCase() + tier.slice(1) + " reflections";
      const scored = tierClusters
        .map((cluster) => ({
          cluster,
          score: reflectionScore(cluster, now, obsTier),
        }))
        .sort((a, b) => b.score - a.score);
      const lines = scored.map(({ cluster }) => {
        const age = relativeTime(cluster.rep.timestamp, now);
        return `- ${flatten(cluster.rep.content)}${age ? ` *(${age})*` : ""}`;
      });
      sections.push([`### ${label}`, "", ...lines, ""].join("\n"));
    };

    for (const tier of TIER_ORDER)
      renderReflectionTier(tier, reflClusters, branchAndPendingObs);

    if (orphanRefl.length > 0) {
      const lines = orphanRefl.map((r) => `- ${flatten(r.content)}`);
      sections.push(
        ["### Unattributed reflections", "", ...lines, ""].join("\n"),
      );
    }
  }

  // ── 3. Tier sections with topic badges ────────────────────
  for (const tier of TIER_ORDER) {
    const tierClusters = viable.filter((c) => c.bestRelevance === tier);
    if (tierClusters.length === 0) continue;
    const label = tier.charAt(0).toUpperCase() + tier.slice(1);
    sections.push(
      [
        `## ${label}`,
        "",
        ...renderScoredBullets(
          tierClusters,
          coverageIndex,
          now,
          topicAssignments,
        ),
        "",
      ].join("\n"),
    );
  }

  // ── 4. Notes ──────────────────────────────────────────────
  const notes: string[] = [];
  if (corpus.droppedIds.size > 0) {
    notes.push(
      `- ${corpus.droppedIds.size} observation ids were pruned by the dropper pipeline; entries carrying those ids are excluded from this export.`,
    );
  }
  if (observationsFiltered > 0) {
    notes.push(
      `- ${observationsFiltered} clusters failed the viability gate (single-session, unsupported, low/medium relevance) and are excluded from the body.`,
    );
  }
  if (notes.length > 0) {
    sections.push(["## Notes", "", ...notes, ""].join("\n"));
  }

  // ── 5. Unattributed pending memory ─────────────────────────
  if (viableOrphans.length > 0 || orphanRefl.length > 0) {
    const body: string[] = [
      "_These entries come from pending buffers whose sessions no longer exist on disk; project attribution was impossible._",
      "",
    ];
    if (viableOrphans.length > 0) {
      const orphanTopicAssignments = assignTopics(viableOrphans);
      body.push(
        `**${viableOrphans.length} observations** (${orphanObs.length} raw, only cross-session survivors shown):`,
        "",
      );
      body.push(
        ...renderScoredBullets(
          viableOrphans,
          coverageIndex,
          now,
          orphanTopicAssignments,
        ),
      );
      body.push("");
    }
    if (orphanRefl.length > 0) {
      body.push(`**${orphanRefl.length} reflections:**`, "");
      for (const r of orphanRefl) body.push(`- ${flatten(r.content)}`);
      body.push("");
    }
    sections.push(["## Unattributed pending memory", "", ...body].join("\n"));
  }

  // ── Stats ─────────────────────────────────────────────────
  const stats: ExportStats = {
    sessionsConsidered: corpus.sessionsConsidered,
    filesWithMarkers: corpus.filesWithMarkers,
    observationsTotal: branchAndPendingObs.length + orphanObs.length,
    observationsClustered: obsClusters.length,
    observationsRendered: viable.length,
    observationsFiltered,
    duplicatesCollapsed: branchAndPendingObs.length - obsClusters.length,
    reflectionsTotal: corpus.reflections.length,
    droppedExcluded: corpus.droppedIds.size,
    orphanedObservations: orphanObs.length,
    orphanedReflections: orphanRefl.length,
    orphanedSessions: corpus.orphanedSessions,
    topicGroups,
  };

  const header = [
    `# Project memory export — ${title}`,
    "",
    `_Generated ${new Date(now).toISOString().slice(0, 16).replace("T", " ")} UTC · ` +
      `${corpus.sessionsConsidered} sessions scanned · ` +
      `${branchAndPendingObs.length + orphanObs.length} observations (${obsClusters.length} unique after dedup, ${viable.length} rendered${observationsFiltered > 0 ? `, ${observationsFiltered} filtered by viability gate` : ""}) · ` +
      `${corpus.reflections.length} reflections_`,
    "",
  ].join("\n");

  return { markdown: header + sections.join("\n"), stats };
}

export async function buildExportMarkdownAsync(
  corpus: ProjectCorpus,
  opts?: { now?: number; title?: string },
): Promise<{ markdown: string; stats: ExportStats }> {
  // Yield between heavy phases so the TUI can paint.
  await yieldToEventLoop();
  // Delegate to the sync implementation but slice yields around the hot sections.
  // The sync call itself is CPU-heavy; we at least yield before/after.
  // For finer granularity, the sync function's hot loops (clustering / topic
  // assignment) would need internal yielding — acceptable to yield at phase
  // boundaries for now: corpus scanning is the dominant block (35s–2min).
  const result = buildExportMarkdown(corpus, opts);
  await yieldToEventLoop();
  return result;
}
