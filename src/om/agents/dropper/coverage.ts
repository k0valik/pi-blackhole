import type { Observation, Reflection } from "../../ledger/index.js";

export const REFLECTION_COVERAGE_TIERS = ["none", "partial", "strong"] as const;
export type ReflectionCoverageTier = typeof REFLECTION_COVERAGE_TIERS[number];

type Relevance = Observation["relevance"];

type CoverageBucket = Record<ReflectionCoverageTier, { count: number; tokens: number }>;
export type CoverageSummaryByRelevance = Record<Relevance, CoverageBucket>;
export type CoverageTransitionSummaryByRelevance = Record<Relevance, Record<string, { count: number; tokens: number }>>;

export const REFLECTION_COVERAGE_DROP_RANK: Record<ReflectionCoverageTier, number> = {
	strong: 0,
	partial: 1,
	none: 2,
};

export function reflectionSupportCounts(reflections: readonly Reflection[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const reflection of reflections) {
		const uniqueIds = new Set(reflection.supportingObservationIds);
		for (const id of uniqueIds) counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	return counts;
}

export function reflectionCoverageTierForCount(count: number): ReflectionCoverageTier {
	if (count <= 0) return "none";
	if (count === 1) return "partial";
	return "strong";
}

export function reflectionCoverageMap(
	observations: readonly Observation[],
	reflections: readonly Reflection[],
): Map<string, ReflectionCoverageTier> {
	const counts = reflectionSupportCounts(reflections);
	return new Map(observations.map((observation) => [
		observation.id,
		reflectionCoverageTierForCount(counts.get(observation.id) ?? 0),
	]));
}

function emptyCoverageBucket(): CoverageBucket {
	return {
		none: { count: 0, tokens: 0 },
		partial: { count: 0, tokens: 0 },
		strong: { count: 0, tokens: 0 },
	};
}

export function emptyCoverageSummaryByRelevance(): CoverageSummaryByRelevance {
	return {
		low: emptyCoverageBucket(),
		medium: emptyCoverageBucket(),
		high: emptyCoverageBucket(),
		critical: emptyCoverageBucket(),
	};
}

export function summarizeCoverageByRelevance(
	observations: readonly Observation[],
	coverageById: ReadonlyMap<string, ReflectionCoverageTier>,
): CoverageSummaryByRelevance {
	const summary = emptyCoverageSummaryByRelevance();
	for (const observation of observations) {
		const tier = coverageById.get(observation.id) ?? "none";
		const bucket = summary[observation.relevance][tier];
		bucket.count++;
		bucket.tokens += observation.tokenCount;
	}
	return summary;
}

export function summarizeCoverageByRelevanceForIds(
	ids: readonly string[],
	observations: readonly Observation[],
	coverageById: ReadonlyMap<string, ReflectionCoverageTier>,
): CoverageSummaryByRelevance {
	const byId = new Map(observations.map((observation) => [observation.id, observation]));
	const selected = ids.flatMap((id) => {
		const observation = byId.get(id);
		return observation ? [observation] : [];
	});
	return summarizeCoverageByRelevance(selected, coverageById);
}

export function emptyCoverageTransitionSummaryByRelevance(): CoverageTransitionSummaryByRelevance {
	return {
		low: {},
		medium: {},
		high: {},
		critical: {},
	};
}

export function summarizeCoverageTransitionsByRelevance(
	observations: readonly Observation[],
	beforeCoverageById: ReadonlyMap<string, ReflectionCoverageTier>,
	afterCoverageById: ReadonlyMap<string, ReflectionCoverageTier>,
): CoverageTransitionSummaryByRelevance {
	const summary = emptyCoverageTransitionSummaryByRelevance();
	for (const observation of observations) {
		const before = beforeCoverageById.get(observation.id) ?? "none";
		const after = afterCoverageById.get(observation.id) ?? "none";
		if (before === after) continue;
		const key = `${before}->${after}`;
		const bucket = summary[observation.relevance][key] ?? { count: 0, tokens: 0 };
		bucket.count++;
		bucket.tokens += observation.tokenCount;
		summary[observation.relevance][key] = bucket;
	}
	return summary;
}

export function observationToDropperLine(
	observation: Observation,
	coverage: ReflectionCoverageTier,
): string {
	return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] [coverage: ${coverage}] ${observation.content}`;
}

export function coverageTierForObservation(
	observation: Observation,
	coverageById: ReadonlyMap<string, ReflectionCoverageTier>,
): ReflectionCoverageTier {
	return coverageById.get(observation.id) ?? "none";
}
