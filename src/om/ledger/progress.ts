import { estimateEntryTokens } from "../tokens.js";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	isObservationsRecordedData,
	isReflectionsRecordedData,
	type Entry,
	type Observation,
	type Reflection,
	type V3MemoryCustomType,
} from "./types.js";

const SOURCE_ENTRY_TYPES = new Set(["message", "custom_message", "branch_summary"]);

export function isSourceEntry(entry: Entry): boolean {
	return SOURCE_ENTRY_TYPES.has(entry.type);
}

export function entryIndexById(entries: Entry[]): Map<string, number> {
	const idToIndex = new Map<string, number>();
	for (let i = 0; i < entries.length; i++) idToIndex.set(entries[i].id, i);
	return idToIndex;
}

export function entryIndexForId(entries: Entry[], entryId: string | undefined): number {
	if (!entryId) return -1;
	const idx = entryIndexById(entries).get(entryId);
	return idx ?? -1;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyArray(value: unknown): value is unknown[] {
	return Array.isArray(value) && value.length > 0;
}

function isValidCoverageEntry(entry: Entry, customType: V3MemoryCustomType): entry is Entry & { data: { coversUpToId: string } } {
	if (entry.type !== "custom" || entry.customType !== customType) return false;
	if (!isObject(entry.data) || typeof entry.data.coversUpToId !== "string") return false;

	if (customType === OM_OBSERVATIONS_RECORDED) return isNonEmptyArray(entry.data.observations);
	if (customType === OM_REFLECTIONS_RECORDED) return isNonEmptyArray(entry.data.reflections);
	return isNonEmptyArray(entry.data.observationIds);
}

export function latestCoverageIndex(entries: Entry[], customType: V3MemoryCustomType): number {
	const idToIndex = entryIndexById(entries);
	let latest = -1;

	for (const entry of entries) {
		if (!isValidCoverageEntry(entry, customType)) continue;
		const coveredIndex = idToIndex.get(entry.data.coversUpToId);
		if (coveredIndex === undefined) continue;
		if (coveredIndex > latest) latest = coveredIndex;
	}

	return latest;
}

export function latestCoverageMarkerId(entries: Entry[], customType: V3MemoryCustomType): string | undefined {
	const idToIndex = entryIndexById(entries);
	let latestIndex = -1;
	let latestMarkerId: string | undefined;

	for (const entry of entries) {
		if (!isValidCoverageEntry(entry, customType)) continue;
		const coveredIndex = idToIndex.get(entry.data.coversUpToId);
		if (coveredIndex === undefined) continue;
		if (coveredIndex > latestIndex) {
			latestIndex = coveredIndex;
			latestMarkerId = entry.data.coversUpToId;
		}
	}

	return latestMarkerId;
}

export function earlierCoverageMarkerId(entries: Entry[], firstId: string | undefined, secondId: string | undefined): string | undefined {
	if (!firstId) return secondId;
	if (!secondId) return firstId;

	const idToIndex = entryIndexById(entries);
	const firstIndex = idToIndex.get(firstId);
	const secondIndex = idToIndex.get(secondId);
	if (firstIndex === undefined) return secondIndex === undefined ? undefined : secondId;
	if (secondIndex === undefined) return firstId;
	return firstIndex <= secondIndex ? firstId : secondId;
}

export function rawTokensAfterIndex(entries: Entry[], index: number): number {
	let total = 0;
	for (let i = Math.max(0, index + 1); i < entries.length; i++) {
		if (isSourceEntry(entries[i])) total += estimateEntryTokens(entries[i]);
	}
	return total;
}

export function rawTokensSinceCoverage(entries: Entry[], customType: V3MemoryCustomType): number {
	return rawTokensAfterIndex(entries, latestCoverageIndex(entries, customType));
}

export function rawTokensSinceObservationCoverage(entries: Entry[]): number {
	return rawTokensSinceCoverage(entries, OM_OBSERVATIONS_RECORDED);
}

export function rawTokensSinceReflectionCoverage(entries: Entry[]): number {
	return rawTokensSinceCoverage(entries, OM_REFLECTIONS_RECORDED);
}

export function rawTokensSinceDropCoverage(entries: Entry[]): number {
	return rawTokensSinceCoverage(entries, OM_OBSERVATIONS_DROPPED);
}

export function findLastCompactionIndex(entries: Entry[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") return i;
	}
	return -1;
}

export function rawTokensSinceLastCompaction(entries: Entry[]): number {
	const compactionIndex = findLastCompactionIndex(entries);
	if (compactionIndex === -1) return rawTokensAfterIndex(entries, -1);

	const firstKeptEntryId = entries[compactionIndex].firstKeptEntryId;
	const firstKeptIndex = entryIndexForId(entries, firstKeptEntryId);

	if (firstKeptIndex === -1) return rawTokensAfterIndex(entries, compactionIndex);
	return rawTokensAfterIndex(entries, firstKeptIndex - 1);
}

/**
 * Extract observations created since the given entry index.
 * Walks the branch and collects observations from OM_OBSERVATIONS_RECORDED
 * entries that were appended AFTER the given index.
 */
export function observationsCreatedAfterIndex(
	entries: Entry[],
	sinceIndex: number,
): Observation[] {
	const observations: Observation[] = [];
	const seen = new Set<string>();

	for (let i = sinceIndex + 1; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type !== "custom") continue;
		if (entry.customType !== OM_OBSERVATIONS_RECORDED) continue;
		if (!isObservationsRecordedData(entry.data)) continue;
		for (const obs of entry.data.observations) {
			if (!seen.has(obs.id)) {
				seen.add(obs.id);
				observations.push(obs);
			}
		}
	}
	return observations;
}

/**
 * Extract reflections created since the given entry index.
 */
export function reflectionsCreatedAfterIndex(
	entries: Entry[],
	sinceIndex: number,
): Reflection[] {
	const reflections: Reflection[] = [];
	const seen = new Set<string>();

	for (let i = sinceIndex + 1; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type !== "custom") continue;
		if (entry.customType !== OM_REFLECTIONS_RECORDED) continue;
		if (!isReflectionsRecordedData(entry.data)) continue;
		for (const ref of entry.data.reflections) {
			if (!seen.has(ref.id)) {
				seen.add(ref.id);
				reflections.push(ref);
			}
		}
	}
	return reflections;
}

/**
 * Build a compact one-line summary of existing observations for context.
 * Capped at maxTokens.
 */
export function buildExistingObservationsSummary(
	observations: Observation[],
	maxTokens: number,
): string {
	const lines: string[] = [];
	let tokens = 0;
	for (const obs of observations) {
		const line = `[${obs.id}] ${obs.timestamp} [${obs.relevance}] ${obs.content}`;
		const lineTokens = Math.ceil(line.length / 4);
		if (tokens + lineTokens > maxTokens && lines.length > 0) break;
		lines.push(line);
		tokens += lineTokens;
	}
	return lines.join("\n");
}

/**
 * Build a compact one-line summary of existing reflections for context.
 * Capped at maxTokens.
 */
export function buildExistingReflectionsSummary(
	reflections: Reflection[],
	maxTokens: number,
): string {
	const lines: string[] = [];
	let tokens = 0;
	for (const ref of reflections) {
		const line = `[${ref.id}] ${ref.content}`;
		const lineTokens = Math.ceil(line.length / 4);
		if (tokens + lineTokens > maxTokens && lines.length > 0) break;
		lines.push(line);
		tokens += lineTokens;
	}
	return lines.join("\n");
}
