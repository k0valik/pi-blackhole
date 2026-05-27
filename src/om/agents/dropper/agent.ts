/**
 * Dropper agent — uses agentLoop to propose prunable observations.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (src/agents/dropper/agent.ts)
 * Modified by pi-vcc-om: detects agent_end stopReason="error" in the stream
 * and throws if the API errored without collecting any drop candidates.
 */
import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { debugLog } from "../../debug-log.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { reflectionToSummaryLine, type Observation, type Reflection } from "../../ledger/index.js";
import { DROPPER_SYSTEM } from "./prompts.js";
import {
	REFLECTION_COVERAGE_DROP_RANK,
	coverageTierForObservation,
	observationToDropperLine,
	reflectionCoverageMap,
	summarizeCoverageByRelevance,
	summarizeCoverageByRelevanceForIds,
} from "./coverage.js";

interface RunDropperArgs {
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
	reflections: Reflection[];
	observations: Observation[];
	/** Compact summary of existing active observations for context. */
	existingObservationsSummary?: string;
	budgetTokens: number;
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	maxTurns?: number;
	thinkingLevel?: ModelThinkingLevel;
}

const DROP_SKIP_FULLNESS = 0.10;
const DROP_LOW_URGENCY_FULLNESS = 0.30;
const DROP_MEDIUM_URGENCY_FULLNESS = 0.60;
const DROP_MAX_FULLNESS = 1.00;
const DROP_MIN_RATIO = 0.10;
const DROP_MAX_RATIO = 0.50;

export type DropUrgency = "low" | "medium" | "high";

const RELEVANCE_DROP_RANK: Record<Observation["relevance"], number> = {
	low: 0,
	medium: 1,
	high: 2,
	critical: 3,
};

const DropObservationsSchema = Type.Object({
	ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	reason: Type.Optional(Type.String()),
});

type DropObservationsArgs = Static<typeof DropObservationsSchema>;

function joinOrEmpty(items: string[]): string {
	return items.length ? items.join("\n") : "(none yet)";
}

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

export function maxDropCountForPool(observations: readonly Observation[], observationTokens: number, budgetTokens: number): number {
	const droppableCount = observations.filter((observation) => observation.relevance !== "critical").length;
	if (droppableCount === 0) return 0;

	const fullness = observationPoolFullness(observationTokens, budgetTokens);
	if (fullness < DROP_SKIP_FULLNESS) return 0;

	const cappedFullness = Math.min(DROP_MAX_FULLNESS, Math.max(DROP_SKIP_FULLNESS, fullness));
	const dropRatio = DROP_MIN_RATIO
		+ ((cappedFullness - DROP_SKIP_FULLNESS) / (DROP_MAX_FULLNESS - DROP_SKIP_FULLNESS))
		* (DROP_MAX_RATIO - DROP_MIN_RATIO);
	return Math.max(1, Math.floor(droppableCount * dropRatio));
}

function relevanceCounts(observations: readonly Observation[]): Record<Observation["relevance"], number> {
	return observations.reduce<Record<Observation["relevance"], number>>((counts, observation) => {
		if (observation.relevance in counts) counts[observation.relevance]++;
		return counts;
	}, { low: 0, medium: 0, high: 0, critical: 0 });
}

export function normalizeDropObservationIds(
	ids: readonly string[] | undefined,
	observations: readonly Observation[],
): string[] | undefined {
	if (!ids || ids.length === 0) return undefined;
	const allowed = new Map(observations.map((observation) => [observation.id, observation]));
	const result: string[] = [];
	const seen = new Set<string>();
	for (const id of ids) {
		const observation = allowed.get(id);
		if (!observation) continue;
		if (seen.has(id)) continue;
		seen.add(id);
		result.push(id);
	}
	return result.length > 0 ? result : undefined;
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
		.filter((candidate): candidate is { id: string; index: number; observation: Observation } =>
			candidate.observation !== undefined
		)
		.sort((a, b) => {
			const coverageDelta = REFLECTION_COVERAGE_DROP_RANK[coverageTierForObservation(a.observation, coverageById)]
				- REFLECTION_COVERAGE_DROP_RANK[coverageTierForObservation(b.observation, coverageById)];
			const relevanceDelta = RELEVANCE_DROP_RANK[a.observation.relevance] - RELEVANCE_DROP_RANK[b.observation.relevance];
			const aAge = timestampRank(a.observation.timestamp);
			const bAge = timestampRank(b.observation.timestamp);
			const ageDelta = aAge === bAge ? 0 : aAge - bAge;
			return coverageDelta || relevanceDelta || ageDelta || a.index - b.index;
		})
		.slice(0, maxDrops)
		.map((candidate) => candidate.id);
}

export async function runDropper(args: RunDropperArgs): Promise<string[] | undefined> {
	const { model, apiKey, headers, reflections, observations, budgetTokens, signal } = args;
	if (observations.length === 0) return undefined;

	const observationTokens = observations.reduce((sum, observation) => sum + observation.tokenCount, 0);
	const fullness = observationPoolFullness(observationTokens, budgetTokens);
	const urgency = dropUrgencyForFullness(fullness);
	const maxDropsAllowed = maxDropCountForPool(observations, observationTokens, budgetTokens);
	const coverageById = reflectionCoverageMap(observations, reflections);
	const coverageSummaryByRelevance = summarizeCoverageByRelevance(observations, coverageById);
	debugLog("dropper.agent_start", {
		activeObservationCount: observations.length,
		reflectionCount: reflections.length,
		observationTokens,
		budgetTokens,
		fullness,
		urgency,
		maxDropsAllowed,
		relevanceCounts: relevanceCounts(observations),
		coverageSummaryByRelevance,
	});
	if (maxDropsAllowed <= 0) {
		debugLog("dropper.result", {
			reason: "not_over_target",
			toolCallCount: 0,
			rawRequestedIdsCount: 0,
			acceptedCandidateCount: 0,
			selectedDropsCount: 0,
			selectedDropTokens: 0,
			selectedCoverageSummaryByRelevance: summarizeCoverageByRelevanceForIds([], observations, coverageById),
			maxDropsAllowed,
		});
		return undefined;
	}

	const proposedDropIds: string[] = [];
	const proposed = new Set<string>();
	const allowed = new Map(observations.map((observation) => [observation.id, observation]));
	let toolCallCount = 0;
	let rawRequestedIdsCount = 0;
	let missingIdsCount = 0;
	let criticalCandidateIdsCount = 0;
	let duplicateInRequestCount = 0;
	let duplicateInRunCount = 0;

	const dropObservations: AgentTool<typeof DropObservationsSchema> = {
		name: "drop_observations",
		label: "Drop observations",
		description: "Propose active observation ids that are safe to remove from compacted memory.",
		parameters: DropObservationsSchema,
		execute: async (_id, params: DropObservationsArgs) => {
			toolCallCount++;
			rawRequestedIdsCount += params.ids.length;
			const seenInRequest = new Set<string>();
			let added = 0;
			let requestMissingIds = 0;
			let requestCriticalCandidateIds = 0;
			let requestDuplicateIds = 0;
			let requestDuplicateInRunIds = 0;
			for (const id of params.ids) {
				const observation = allowed.get(id);
				if (!observation) {
					missingIdsCount++;
					requestMissingIds++;
					continue;
				}
				if (seenInRequest.has(id)) {
					duplicateInRequestCount++;
					requestDuplicateIds++;
					continue;
				}
				seenInRequest.add(id);
				if (proposed.has(id)) {
					duplicateInRunCount++;
					requestDuplicateInRunIds++;
					continue;
				}
				proposed.add(id);
				proposedDropIds.push(id);
				if (observation.relevance === "critical") {
					criticalCandidateIdsCount++;
					requestCriticalCandidateIds++;
				}
				added++;
			}
			debugLog("dropper.tool_call", {
				toolCallCount,
				rawRequestedIdsCount: params.ids.length,
				acceptedIdsCount: added,
				missingIdsCount: requestMissingIds,
				criticalCandidateIdsCount: requestCriticalCandidateIds,
				duplicateInRequestCount: requestDuplicateIds,
				duplicateInRunCount: requestDuplicateInRunIds,
				totalCandidates: proposedDropIds.length,
				maxDropsAllowed,
			});
			return {
				content: [{ type: "text", text: `Queued ${added} drop candidate${added === 1 ? "" : "s"}. Candidates this run: ${proposedDropIds.length}. Maximum drops allowed: ${maxDropsAllowed}.` }],
				details: { added, totalCandidates: proposedDropIds.length, maxDropsAllowed },
			};
		},
	};

	const fullnessPercent = Math.round(fullness * 100);
	const existingObservationsContext = args.existingObservationsSummary
		? `EXISTING ACTIVE OBSERVATIONS (for context only — these are NOT candidates for dropping):\n${args.existingObservationsSummary}\n\n`
		: '';

	const userText = `CURRENT REFLECTIONS:\n${joinOrEmpty(reflections.map(reflectionToSummaryLine))}\n\n${existingObservationsContext}NEW OBSERVATIONS TO EVALUATE FOR DROPPING:\n${joinOrEmpty(observations.map((observation) => observationToDropperLine(observation, coverageTierForObservation(observation, coverageById))))}\n\nObservation pool pressure: ~${observationTokens.toLocaleString()} tokens; target budget: ~${budgetTokens.toLocaleString()} tokens; fullness: ~${fullnessPercent.toLocaleString()}%.\nDrop urgency: ${urgency}.\nMaximum drops allowed this run: ${maxDropsAllowed.toLocaleString()} observation${maxDropsAllowed === 1 ? "" : "s"}.\nThis maximum is a hard upper bound, not a target. Drop fewer or none if fewer observations are clearly safe.`;
	const prompts: Message[] = [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }];
	const context: AgentContext = { systemPrompt: DROPPER_SYSTEM, messages: [], tools: [dropObservations as AgentTool<any>] };
	const reasoning = (model as { reasoning?: unknown }).reasoning;
	const thinkingLevel = args.thinkingLevel ?? "low";
	const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : undefined;
	let turnCount = 0;
	const config: AgentLoopConfig = {
		model,
		apiKey,
		headers,
		maxTokens: boundedMaxTokens(model, AGENT_LOOP_MAX_TOKENS),
		convertToLlm: (msgs) => msgs as Message[],
		toolExecution: "sequential",
		...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
		...(effectiveMaxTurns !== undefined ? { shouldStopAfterTurn: () => ++turnCount >= effectiveMaxTurns } : {}),
	};

	const loop = args.agentLoop ?? agentLoop;
	const stream = loop(prompts, context, config, signal);
	let agentError: string | undefined;
	for await (const event of stream) {
		// Tool execution collects candidate ids.
		if (event.type === "agent_end") {
			const msgs = ((event as any).messages || []) as Array<{ stopReason?: string; errorMessage?: string }>;
			const lastMsg = msgs[msgs.length - 1];
			if (lastMsg?.stopReason === "error") {
				agentError = lastMsg.errorMessage ?? "Unknown API error";
			}
		}
	}
	await stream.result();
	if (agentError && proposedDropIds.length === 0) throw new Error(`Dropper API error: ${agentError}`);
	const droppedIds = selectDropCandidates(proposedDropIds, observations, maxDropsAllowed, reflections);
	const reason = droppedIds.length > 0
		? "selected_nonempty"
		: toolCallCount === 0
			? "no_tool_call"
			: proposedDropIds.length === 0
				? "all_filtered"
				: "selected_empty";
	const selectedDropTokens = droppedIds.reduce((sum, id) => sum + (allowed.get(id)?.tokenCount ?? 0), 0);
	debugLog("dropper.result", {
		reason,
		toolCallCount,
		rawRequestedIdsCount,
		missingIdsCount,
		criticalCandidateIdsCount,
		duplicateInRequestCount,
		duplicateInRunCount,
		acceptedCandidateCount: proposedDropIds.length,
		selectedDropsCount: droppedIds.length,
		selectedDropTokens,
		selectedCoverageSummaryByRelevance: summarizeCoverageByRelevanceForIds(droppedIds, observations, coverageById),
		maxDropsAllowed,
	});
	return droppedIds.length > 0 ? droppedIds : undefined;
}
