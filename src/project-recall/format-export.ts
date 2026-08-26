/**
 * Export ranking + markdown rendering — the distilled project-memory artifact
 * (plan-07 Appendix A).
 *
 * Ranking discipline (§19 receipts): relevance tier is the primary rank input,
 * recency decay `1/(1+days)^0.3` (D4) modulates within tiers, recurrence is
 * damped to log(1 + distinctSessions) so pipeline artifacts and single-episode
 * bursts cannot masquerade as importance. Dropper-pruned observation ids are
 * excluded from the body and only reported in the Notes section.
 *
 * Distillation additions:
 *  - coverage: observations referenced by ≥1 reflection are validated by the
 *    reflector pass and score higher (log-scaled boost),
 *  - consensus: max Sørensen-Dice to a sibling cluster nudges recurring
 *    themes up (small weight),
 *  - viability gate: low/medium clusters without recurrence or reflection
 *    coverage are dropped from the body (noise floor),
 *  - topics: surviving observation clusters group under themed section
 *    headers derived from shared content keywords, replacing the flat
 *    tier dump; reflections still lead the document as the distilled layer.
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
/** D4 recency decay exponent. */
const RECENCY_DECAY_EXP = 0.3;
/** Coverage multiplier weight (observations validated by reflections). */
const COVERAGE_WEIGHT = 0.3;
/** Consensus rerank weight (max Sørensen-Dice to a sibling cluster). */
const CONSENSUS_WEIGHT = 0.2;
/**
 * A keyword shared by > this fraction of clusters is too generic to connect
 * into a topic.
 */
const GENERIC_KEYWORD_RATIO = 0.3;

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

function recencyDecay(timestamp: string | null, nowMs: number): number {
  if (!timestamp) return 0.5;
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return 0.5;
  const days = Math.max(0, (nowMs - t) / 86400000);
  return 1 / Math.pow(1 + days, RECENCY_DECAY_EXP);
}

interface Scoreable {
  timestamp: string | null;
}

function clusterScore<T extends Scoreable>(
  cluster: MemoryCluster<T>,
  tier: Relevance,
  nowMs: number,
  coverage = 0,
): number {
  return (
    TIER_WEIGHT[tier] *
    recencyDecay(cluster.rep.timestamp, nowMs) *
    (1 + Math.log2(1 + cluster.distinctSessions)) *
    (1 + COVERAGE_WEIGHT * Math.log2(1 + coverage)) *
    (1 + CONSENSUS_WEIGHT * cluster.maxRelatedSimilarity)
  );
}

/**
 * Reflections are reflector-curated: a second LLM pass reviewed, dropped, and
 * promoted observations before distilling them, so they carry verified value
 * and rank with at least high-tier weight plus an evidence-mass multiplier
 * from their supporting observations (§17.3).
 */
function reflectionScore(
  cluster: MemoryCluster<CorpusReflection>,
  nowMs: number,
): number {
  return (
    TIER_WEIGHT.high *
    recencyDecay(cluster.rep.timestamp, nowMs) *
    (1 + Math.log2(1 + cluster.distinctSessions)) *
    (1 + Math.log2(1 + cluster.rep.supportingObservationIds.length))
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

// ── Topic grouping ────────────────────────────────────────────

interface TopicGroup {
  label: string;
  /** Set of all content-bearing keywords across member clusters (for matching). */
  keywords: Set<string>;
  clusters: Array<MemoryCluster<CorpusObservation>>;
}

/**
 * Top-K content keywords (stop words stripped) by within-content TF.
 */
function keywordSignature(content: string, k = 2): string[] {
  const counts = new Map<string, number>();
  for (const t of tokenizeContent(content)) {
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, k)
    .map(([t]) => t);
}

class MiniUnionFind {
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

interface TopicGrouping {
  topics: TopicGroup[];
  leftovers: Array<MemoryCluster<CorpusObservation>>;
}

/**
 * Group observation clusters into topics by shared content keywords.
 * Keywords connecting > GENERIC_KEYWORD_RATIO of clusters are skipped
 * (too generic). Returns empty topics[] when the corpus is too diverse.
 */
function groupObservationTopics(
  clusters: Array<MemoryCluster<CorpusObservation>>,
): TopicGrouping {
  const n = clusters.length;
  if (n < 2) return { topics: [], leftovers: clusters };

  const sigs = clusters.map((c) => ({
    cluster: c,
    keywords: new Set(keywordSignature(flatten(c.rep.content))),
  }));

  const kwIndex = new Map<string, number[]>();
  sigs.forEach((sig, i) => {
    for (const kw of sig.keywords) {
      const arr = kwIndex.get(kw);
      if (arr) arr.push(i);
      else kwIndex.set(kw, [i]);
    }
  });

  const uf = new MiniUnionFind(n);
  const genericThreshold = Math.ceil(GENERIC_KEYWORD_RATIO * n);
  for (const [, idxs] of kwIndex) {
    if (idxs.length > genericThreshold) continue; // too generic to connect
    for (let i = 1; i < idxs.length; i++) uf.union(idxs[0], idxs[i]);
  }

  const rawGroups = new Map<number, TopicGroup>();
  sigs.forEach((sig, i) => {
    const root = uf.find(i);
    let g = rawGroups.get(root);
    if (!g) {
      g = { label: "", keywords: new Set(), clusters: [] };
      rawGroups.set(root, g);
    }
    g.clusters.push(sig.cluster);
    for (const kw of sig.keywords) g.keywords.add(kw);
  });

  const topics = [...rawGroups.values()]
    .filter((g) => g.clusters.length >= 2)
    .sort((a, b) => b.clusters.length - a.clusters.length);

  if (topics.length < 2) return { topics: [], leftovers: clusters };

  const topicSet = new Set(topics.flatMap((t) => t.clusters));
  const leftovers = clusters.filter((c) => !topicSet.has(c));

  for (const t of topics) {
    t.label = topicLabel(t.clusters);
  }

  return { topics, leftovers };
}

/** Derive a topic heading label from its member clusters' keywords. */
function topicLabel(clusters: Array<MemoryCluster<CorpusObservation>>): string {
  const counts = new Map<string, number>();
  for (const c of clusters) {
    for (const kw of keywordSignature(flatten(c.rep.content))) {
      counts.set(kw, (counts.get(kw) ?? 0) + 1);
    }
  }
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const label = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 2)
    .map(([t]) => (t.length > 30 ? capitalize(t.slice(0, 30)) : capitalize(t)))
    .join(" & ");
  return label || "Observations";
}

/**
 * Map reflection clusters to topics whose keyword set has any overlap with
 * the reflection's content tokens. Each reflection goes to the best-matching
 * topic (max overlap count); reflections matching no topic stay unassigned
 * and appear in the top Reflections section.
 */
function matchReflectionsToTopics(
  reflectionClusters: Array<MemoryCluster<CorpusReflection>>,
  topics: TopicGroup[],
  nowMs: number,
): Map<TopicGroup, Array<MemoryCluster<CorpusReflection>>> {
  const assigned = new Map<
    TopicGroup,
    Array<MemoryCluster<CorpusReflection>>
  >();
  for (const rc of reflectionClusters) {
    const rtokens = new Set(tokenizeContent(flatten(rc.rep.content)));
    let best: TopicGroup | null = null;
    let bestOverlap = 0;
    for (const topic of topics) {
      let ov = 0;
      for (const t of rtokens) if (topic.keywords.has(t)) ov++;
      if (ov > bestOverlap) {
        bestOverlap = ov;
        best = topic;
      }
    }
    if (best && bestOverlap > 0) {
      const arr = assigned.get(best);
      if (arr) arr.push(rc);
      else assigned.set(best, [rc]);
    }
  }
  // Sort each topic's reflections by score descending
  for (const arr of assigned.values()) {
    arr.sort((a, b) => reflectionScore(b, nowMs) - reflectionScore(a, nowMs));
  }
  return assigned;
}

// ── Bullet rendering ──────────────────────────────────────────

/** Emit markdown bullet lines from a pre-scored cluster array. */
function emitBullets(
  scored: Array<{
    cluster: MemoryCluster<CorpusObservation>;
    score: number;
  }>,
  nowMs: number,
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
    lines.push(`- ${flatten(cluster.rep.content)}${meta}`);
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
  return emitBullets(scored, nowMs);
}

// ── Main export function ──────────────────────────────────────

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

  const sections: string[] = [];

  // ── 1. Topic grouping ──────────────────────────────────────
  const { topics, leftovers } = groupObservationTopics(viable);
  const useTopics = topics.length >= 2;

  // Match reflections to topics (so assigned ones don't duplicate in top section)
  let topicReflections = new Map<
    TopicGroup,
    Array<MemoryCluster<CorpusReflection>>
  >();
  const assignedRefl = new Set<MemoryCluster<CorpusReflection>>();
  if (useTopics) {
    topicReflections = matchReflectionsToTopics(reflClusters, topics, now);
    for (const arr of topicReflections.values()) {
      for (const r of arr) assignedRefl.add(r);
    }
  }

  // ── 2. Reflections (top section, unmatched only) ──────────
  const topRefls = useTopics
    ? reflClusters.filter((c) => !assignedRefl.has(c))
    : reflClusters;

  if (topRefls.length > 0) {
    const reflScored = topRefls
      .map((cluster) => ({ cluster, score: reflectionScore(cluster, now) }))
      .sort((a, b) => b.score - a.score);
    const lines = reflScored.map(({ cluster }) => {
      const age = relativeTime(cluster.rep.timestamp, now);
      return `- ${flatten(cluster.rep.content)}${age ? ` *(${age})*` : ""}`;
    });
    const note =
      useTopics && assignedRefl.size > 0
        ? `_${assignedRefl.size} reflection${assignedRefl.size !== 1 ? "s" : ""} distributed into topic sections below._\n`
        : "";
    sections.push(["## Reflections", "", note, ...lines, ""].join("\n"));
  }

  // ── 3. Topic sections (or tier fallback) ───────────────────
  if (useTopics) {
    for (const topic of topics) {
      const lines: string[] = [`## ${topic.label}`, ""];
      // Sort topic clusters by tier then score
      const scored = topic.clusters.map((cluster) => ({
        cluster,
        score: clusterScore(
          cluster,
          cluster.bestRelevance,
          now,
          clusterCoverage(cluster, coverageIndex),
        ),
      }));
      scored.sort(
        (a, b) =>
          TIER_WEIGHT[b.cluster.bestRelevance] -
            TIER_WEIGHT[a.cluster.bestRelevance] || b.score - a.score,
      );
      lines.push(...emitBullets(scored, now), "");

      const matched = topicReflections.get(topic);
      if (matched && matched.length > 0) {
        lines.push("**Related reflections:**", "");
        for (const rc of matched) {
          const age = relativeTime(rc.rep.timestamp, now);
          lines.push(`- ${flatten(rc.rep.content)}${age ? ` *(${age})*` : ""}`);
        }
        lines.push("");
      }
      sections.push(lines.join("\n"));
    }

    // Leftovers section
    if (leftovers.length > 0) {
      sections.push(
        [
          "## Other observations",
          "",
          ...renderScoredBullets(leftovers, coverageIndex, now),
          "",
        ].join("\n"),
      );
    }
  } else {
    // Fallback to tier-based sections
    for (const tier of TIER_ORDER) {
      const tierClusters = viable.filter((c) => c.bestRelevance === tier);
      if (tierClusters.length === 0) continue;
      const label = tier.charAt(0).toUpperCase() + tier.slice(1);
      sections.push(
        [
          `## ${label}`,
          "",
          ...renderScoredBullets(tierClusters, coverageIndex, now),
          "",
        ].join("\n"),
      );
    }
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
      body.push(
        `**${viableOrphans.length} observations** (${orphanObs.length} raw, only cross-session survivors shown):`,
        "",
      );
      body.push(...renderScoredBullets(viableOrphans, coverageIndex, now));
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
    observationsTotal: corpus.observations.length,
    observationsClustered: obsClusters.length,
    observationsRendered: viable.length,
    observationsFiltered,
    duplicatesCollapsed: branchAndPendingObs.length - obsClusters.length,
    reflectionsTotal: corpus.reflections.length,
    droppedExcluded: corpus.droppedIds.size,
    orphanedObservations: orphanObs.length,
    orphanedReflections: orphanRefl.length,
    orphanedSessions: corpus.orphanedSessions,
    topicGroups: useTopics ? topics.length : 0,
  };

  const header = [
    `# Project memory export — ${title}`,
    "",
    `_Generated ${new Date(now).toISOString().slice(0, 16).replace("T", " ")} UTC · ` +
      `${corpus.sessionsConsidered} sessions scanned · ` +
      `${branchAndPendingObs.length + orphanObs.length} observations (${obsClusters.length} unique after dedup, ${viable.length} rendered after viability gate) · ` +
      `${corpus.reflections.length} reflections_`,
    "",
  ].join("\n");

  return { markdown: header + sections.join("\n"), stats };
}
