/**
 * Export ranking + markdown rendering — the distilled project-memory artifact
 * (plan-07 Appendix A).
 *
 * Ranking discipline (§19 receipts): relevance tier is the primary rank input,
 * recency decay `1/(1+days)^0.3` (D4) modulates within tiers, recurrence is
 * damped to log(1 + distinctSessions) so pipeline artifacts and single-episode
 * bursts cannot masquerade as importance. Dropper-pruned observation ids are
 * excluded from the body and only reported in the Notes section.
 */
import type {
  CorpusObservation,
  CorpusReflection,
  ProjectCorpus,
} from "./corpus.js";
import {
  clusterObservations,
  clusterReflections,
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
): number {
  return (
    TIER_WEIGHT[tier] *
    recencyDecay(cluster.rep.timestamp, nowMs) *
    (1 + Math.log2(1 + cluster.distinctSessions))
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
    (1 + Math.log2(1 + cluster.rep.supportingCount))
  );
}

function flatten(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

export interface ExportStats {
  sessionsConsidered: number;
  filesWithMarkers: number;
  observationsTotal: number;
  observationsUnique: number;
  duplicatesCollapsed: number;
  reflectionsTotal: number;
  droppedExcluded: number;
  orphanedObservations: number;
  orphanedReflections: number;
  orphanedSessions: number;
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

  const obsClusters = clusterObservations(branchAndPendingObs, { fuzzy: true });
  const reflClusters = clusterReflections(branchAndPendingRefl);
  const orphanObsClusters = clusterObservations(orphanObs);

  const renderClusterItems = <
    T extends { content: string; timestamp: string | null; sessionId: string },
  >(
    clusters: Array<MemoryCluster<T>>,
    tier: Relevance,
  ): string[] => {
    const scored = clusters.map((cluster) => ({
      cluster,
      score: clusterScore(cluster, tier, now),
    }));
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        flatten(b.cluster.rep.content).localeCompare(
          flatten(a.cluster.rep.content),
        ),
    );
    const lines: string[] = [];
    for (const { cluster } of scored) {
      const parts: string[] = [];
      const age = relativeTime(cluster.rep.timestamp, now);
      if (age) parts.push(age);
      if (cluster.distinctSessions > 1)
        parts.push(`seen across ${cluster.distinctSessions} sessions`);
      const meta = parts.length > 0 ? ` *(${parts.join(" · ")})*` : "";
      lines.push(`- ${flatten(cluster.rep.content)}${meta}`);
      for (const extra of cluster.extras) {
        lines.push(`- ${flatten(extra.content)}`);
      }
    }
    return lines;
  };

  const sections: string[] = [];

  if (reflClusters.length > 0) {
    const reflScored = reflClusters
      .map((cluster) => ({ cluster, score: reflectionScore(cluster, now) }))
      .sort((a, b) => b.score - a.score);
    const lines = reflScored.map(({ cluster }) => {
      const age = relativeTime(cluster.rep.timestamp, now);
      return `- ${flatten(cluster.rep.content)}${age ? ` *(${age})*` : ""}`;
    });
    sections.push(["## Reflections", "", ...lines, ""].join("\n"));
  }

  for (const tier of TIER_ORDER) {
    const tierClusters = obsClusters.filter((c) => c.bestRelevance === tier);
    if (tierClusters.length === 0) continue;
    const label = tier.charAt(0).toUpperCase() + tier.slice(1);
    const lines = renderClusterItems(tierClusters, tier);
    sections.push([`## ${label}`, "", ...lines, ""].join("\n"));
  }

  if (corpus.droppedIds.size > 0) {
    sections.push(
      [
        "## Notes",
        "",
        `- ${corpus.droppedIds.size} observation ids were pruned by the dropper pipeline; entries carrying those ids are excluded from this export.`,
        "",
      ].join("\n"),
    );
  }

  if (orphanObs.length > 0 || orphanRefl.length > 0) {
    const body: string[] = [
      "_These entries come from pending buffers whose sessions no longer exist on disk; project attribution was impossible._",
      "",
    ];
    if (orphanObs.length > 0) {
      body.push(`**${orphanObs.length} observations:**`, "");
      body.push(...renderClusterItems(orphanObsClusters, "medium"));
      body.push("");
    }
    if (orphanRefl.length > 0) {
      body.push(`**${orphanRefl.length} reflections:**`, "");
      for (const r of orphanRefl) body.push(`- ${flatten(r.content)}`);
      body.push("");
    }
    sections.push(["## Unattributed pending memory", "", ...body].join("\n"));
  }

  const stats: ExportStats = {
    sessionsConsidered: corpus.sessionsConsidered,
    filesWithMarkers: corpus.filesWithMarkers,
    observationsTotal: corpus.observations.length,
    observationsUnique: obsClusters.length,
    duplicatesCollapsed: branchAndPendingObs.length - obsClusters.length,
    reflectionsTotal: corpus.reflections.length,
    droppedExcluded: corpus.droppedIds.size,
    orphanedObservations: orphanObs.length,
    orphanedReflections: orphanRefl.length,
    orphanedSessions: corpus.orphanedSessions,
  };

  const header = [
    `# Project memory export — ${title}`,
    "",
    `_Generated ${new Date(now).toISOString().slice(0, 16).replace("T", " ")} UTC · ` +
      `${corpus.sessionsConsidered} sessions scanned · ` +
      `${branchAndPendingObs.length + orphanObs.length} observations (${obsClusters.length} unique after dedup) · ` +
      `${corpus.reflections.length} reflections_`,
    "",
  ].join("\n");

  return { markdown: header + sections.join("\n"), stats };
}
