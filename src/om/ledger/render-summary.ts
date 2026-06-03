/**
 * Summary rendering — formats observations/reflections for compaction output.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (src/session-ledger/render-summary.ts)
 * Unmodified.
 */
import type { Observation, Reflection } from "./types.js";

const CONTEXT_USAGE_INSTRUCTIONS = `These are condensed memories from earlier in this session.

- Reflections: stable, long-lived facts about the user, project, decisions, and constraints. New reflection lines may include ids in brackets.
- Observations: timestamped events from the conversation history, in chronological order. Observation lines include ids in brackets.

Treat these as past records. When entries conflict, the most recent observation reflects the latest known state. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.

When exact source context is needed for precision or traceability, use the \`recall\` tool with the relevant observation or reflection id. This is especially useful when a reflection materially affects a decision or is too compressed to continue confidently. Do not use \`recall\` as broad search or inject raw source unless it is needed.`;

export const OM_FOOTER = `----\n${CONTEXT_USAGE_INSTRUCTIONS}\n----`;

export function observationToSummaryLine(observation: Observation): string {
	return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`;
}

/** Score an observation for cap/trim selection.
 *  Relevance tier dominates: medium (5+) always outranks low (max 2).
 *  Recency is based on position in the flat-mapped array (0 = oldest, N-1 = newest),
 *  avoiding wall-clock dependency that punishes sessions spanning days or weeks. */
export function scoreObservation(obs: Observation, index: number, total: number): number {
	const base = obs.relevance === "high" || obs.relevance === "critical" ? 10
		: obs.relevance === "medium" ? 5 : 1;
	const recency = total > 1 ? index / (total - 1) : 1;
	return base + recency;
}

/** Select observations up to a token budget, keeping all high-relevance items
 *  unconditionally and filling the remaining budget with the best-scoring
 *  medium and low observations (relevance-tiered + recency).
 *
 *  Reflections are never trimmed — they are inherently rare and always stay.
 *  Observations stay in the branch either way; this only caps what is rendered
 *  in the compaction summary output. */
export function selectPriorObservations(observations: Observation[], maxTokens: number): Observation[] {
	// Track original indices so we can restore chronological order after scoring
	const indexed = observations.map((obs, i) => ({ obs, originalIndex: i }));
	const high = indexed.filter(item => item.obs.relevance === "high" || item.obs.relevance === "critical");
	const rest = indexed.filter(item => item.obs.relevance !== "high" && item.obs.relevance !== "critical");

	// High always kept — consume budget first
	let budget = maxTokens;
	const selected = new Set<{ obs: Observation; originalIndex: number }>();
	for (const item of high) {
		const lineTokens = Math.ceil(observationToSummaryLine(item.obs).length / 4);
		selected.add(item);
		budget -= lineTokens;
	}

	// Score medium + low and select best within remaining budget
	if (rest.length > 0 && budget > 0) {
		const scored = rest.map((item, i) => ({ item, score: scoreObservation(item.obs, i, rest.length) }));
		scored.sort((a, b) => b.score - a.score); // highest score first
		for (const { item } of scored) {
			const lineTokens = Math.ceil(observationToSummaryLine(item.obs).length / 4);
			if (budget - lineTokens < 0) break;
			selected.add(item);
			budget -= lineTokens;
		}
	}

	// Restore original chronological order before returning
	return Array.from(selected)
		.sort((a, b) => a.originalIndex - b.originalIndex)
		.map(item => item.obs);
}

export function reflectionToSummaryLine(reflection: Reflection): string {
	return `[${reflection.id}] ${reflection.content}`;
}

export function renderSummary(reflections: Reflection[], observations: Observation[]): string {
	if (reflections.length === 0 && observations.length === 0) return "";

	const parts: string[] = [];
	if (reflections.length > 0) {
		parts.push(`## Reflections\n${reflections.map(reflectionToSummaryLine).join("\n")}`);
	}
	if (observations.length > 0) {
		parts.push(`## Observations\n${observations.map(observationToSummaryLine).join("\n")}`);
	}
	parts.push(OM_FOOTER);
	return parts.join("\n\n");
}
