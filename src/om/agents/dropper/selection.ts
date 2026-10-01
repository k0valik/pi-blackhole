/**
 * Dropper selection math, factored out of agent.ts so the consolidation stage
 * can apply the deterministic ranker + global cap once over merged batch
 * proposals (src/om/consolidation.ts) without importing the agent loop.
 * Single source of truth: the agent imports these back for its own runs.
 */
import type { Observation, Reflection } from "../../ledger/index.js";
import {
  REFLECTION_COVERAGE_DROP_RANK,
  coverageTierForObservation,
  reflectionCoverageMap,
} from "./coverage.js";

export const DROP_SKIP_FULLNESS = 0.1;
export const DROP_LOW_URGENCY_FULLNESS = 0.3;
export const DROP_MEDIUM_URGENCY_FULLNESS = 0.6;
export const DROP_MAX_FULLNESS = 1.0;
export const DROP_MIN_RATIO = 0.1;
export const DROP_MAX_RATIO = 0.5;

export type DropUrgency = "low" | "medium" | "high";

const RELEVANCE_DROP_RANK: Record<Observation["relevance"], number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function observationPoolFullness(observationTokens: number, budgetTokens: number): number {
  if (!Number.isFinite(observationTokens) || observationTokens <= 0) return 0;
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) return 0;
  return observationTokens / budgetTokens;
}

export function dropUrgencyForFullness(fullness: number): DropUrgency {
  if (fullness < DROP_LOW_URGENCY_FULLNESS) return "low";
  if (fullness < DROP_MEDIUM_URGENCY_FULLNESS) return "medium";
  return "high";
}

export function maxDropCountForPool(
  observations: readonly Observation[],
  observationTokens: number,
  budgetTokens: number,
  skipFullness: number = DROP_SKIP_FULLNESS,
): number {
  const droppableCount = observations.filter(
    (observation) => observation.relevance !== "critical",
  ).length;
  if (droppableCount === 0) return 0;
  const fullness = observationPoolFullness(observationTokens, budgetTokens);
  if (fullness < skipFullness) return 0;

  const cappedFullness = Math.min(DROP_MAX_FULLNESS, Math.max(skipFullness, fullness));
  const dropRatio =
    DROP_MIN_RATIO +
    ((cappedFullness - skipFullness) / (DROP_MAX_FULLNESS - skipFullness)) *
      (DROP_MAX_RATIO - DROP_MIN_RATIO);
  return Math.max(1, Math.floor(droppableCount * dropRatio));
}

function timestampRank(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

export function selectDropCandidates(
  ids: readonly string[],
  observations: readonly Observation[],
  maxDrops: number,
  reflections: readonly Reflection[] = [],
): string[] {
  if (maxDrops <= 0 || ids.length === 0) return [];

  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const coverageById = reflectionCoverageMap(observations, reflections);
  const firstProposalIndex = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (!firstProposalIndex.has(id)) firstProposalIndex.set(id, i);
  }

  return Array.from(firstProposalIndex.entries())
    .map(([id, index]) => ({ id, index, observation: byId.get(id) }))
    .filter(
      (candidate): candidate is { id: string; index: number; observation: Observation } =>
        candidate.observation !== undefined,
    )
    .sort((a, b) => {
      const coverageDelta =
        REFLECTION_COVERAGE_DROP_RANK[coverageTierForObservation(a.observation, coverageById)] -
        REFLECTION_COVERAGE_DROP_RANK[coverageTierForObservation(b.observation, coverageById)];
      const relevanceDelta =
        RELEVANCE_DROP_RANK[a.observation.relevance] - RELEVANCE_DROP_RANK[b.observation.relevance];
      const aAge = timestampRank(a.observation.timestamp);
      const bAge = timestampRank(b.observation.timestamp);
      const ageDelta = aAge === bAge ? 0 : aAge - bAge;
      return coverageDelta || relevanceDelta || ageDelta || a.index - b.index;
    })
    .slice(0, maxDrops)
    .map((candidate) => candidate.id);
}
