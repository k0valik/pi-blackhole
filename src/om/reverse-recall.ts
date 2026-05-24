/**
 * Reverse recall — given session entry IDs, find related OM observations/reflections.
 *
 * This is the vcc→OM direction: when expanding session entries, look up
 * observations whose sourceEntryIds contain those entry IDs.
 */
import {
	indexLedger,
	type Entry,
} from "./ledger/recall.js";
import { type RenderedEntry } from "../core/render-entries.js";

// ── Types ─────────────────────────────────────────────────────────────────

export interface RelatedObservation {
	memoryId: string;
	content: string;
	timestamp: string;
	relevance: string;
	status: "active" | "dropped";
	matchedEntryIds: string[];
}

export interface RelatedReflection {
	memoryId: string;
	content: string;
}

// ── Lookup ────────────────────────────────────────────────────────────────

export function findObservationsForEntryIds(
	entries: Entry[],
	targetEntryIds: string[],
): RelatedObservation[] {
	if (targetEntryIds.length === 0) return [];
	const { observations, droppedIds } = indexLedger(entries);
	const targetSet = new Set(targetEntryIds);

	const result: RelatedObservation[] = [];
	for (const indexed of observations) {
		const matched = indexed.observation.sourceEntryIds.filter((id) => targetSet.has(id));
		if (matched.length > 0) {
			result.push({
				memoryId: indexed.observation.id,
				content: indexed.observation.content,
				timestamp: indexed.observation.timestamp,
				relevance: indexed.observation.relevance,
				status: droppedIds.has(indexed.observation.id) ? "dropped" : "active",
				matchedEntryIds: matched,
			});
		}
	}
	return result;
}

export function findReflectionsForEntryIds(
	entries: Entry[],
	targetEntryIds: string[],
): RelatedReflection[] {
	if (targetEntryIds.length === 0) return [];
	const { reflections } = indexLedger(entries);
	// Reflections don't directly reference entry IDs — they reference observation IDs.
	// So we only match indirectly: first find observations for these entry IDs,
	// then find reflections that support those observations.
	const { observations } = indexLedger(entries);
	const targetSet = new Set(targetEntryIds);
	const matchingObsIds = new Set<string>();
	for (const indexed of observations) {
		if (indexed.observation.sourceEntryIds.some((id) => targetSet.has(id))) {
			matchingObsIds.add(indexed.observation.id);
		}
	}
	if (matchingObsIds.size === 0) return [];
	return reflections
		.filter((r) => r.reflection.supportingObservationIds.some((id) => matchingObsIds.has(id)))
		.map((r) => ({
			memoryId: r.reflection.id,
			content: r.reflection.content,
		}));
}

// ── Formatters ────────────────────────────────────────────────────────────

export function formatRelatedObservations(
	observations: RelatedObservation[],
	_reflections: RelatedReflection[],
): string {
	const parts: string[] = [];

	if (observations.length > 0) {
		parts.push("Related observations:");
		for (const obs of observations) {
			const dropped = obs.status === "dropped" ? " [dropped]" : "";
			const entryRefs = obs.matchedEntryIds.length > 0
				? ` (${obs.matchedEntryIds.join(", ")})`
				: "";
			parts.push(`  [${obs.memoryId}]${dropped} ${obs.timestamp} [${obs.relevance}] ${obs.content}${entryRefs}`);
		}
	}

	return parts.join("\n");
}

/**
 * Build a session-entry-id → message-index map from RenderedEntry[].
 * Used to annotate source entries with their #N indices.
 */
export function buildIndexMap(rendered: RenderedEntry[]): Map<string, number> {
	const map = new Map<string, number>();
	for (const entry of rendered) {
		if (entry.id && !map.has(entry.id)) {
			map.set(entry.id, entry.index);
		}
	}
	return map;
}

export function formatEntryIndexAnnotation(
	sourceEntryIds: string[],
	idToIndex: Map<string, number>,
): string {
	const indices: number[] = [];
	for (const id of sourceEntryIds) {
		const idx = idToIndex.get(id);
		if (idx !== undefined) indices.push(idx);
	}
	if (indices.length === 0) return "";
	indices.sort((a, b) => a - b);
	return `(at index #${indices.join(", #")})`;
}
