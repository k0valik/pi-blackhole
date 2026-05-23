/**
 * Memory recall — resolves source evidence for observations and reflections.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (src/session-ledger/recall.ts)
 * Unmodified.
 */
import {
	isObservationsDroppedEntry,
	isObservationsRecordedEntry,
	isReflectionsRecordedEntry,
	type Entry,
	type Observation,
	type Reflection,
} from "./types.js";

const SOURCE_TYPES = new Set(["message", "custom_message", "branch_summary"]);

export type { Entry, Observation, Reflection };

type ObservationLedgerLocation = {
	entryId: string;
	entryIndex: number;
	recordIndex: number;
};

type ReflectionLedgerLocation = {
	entryId: string;
	entryIndex: number;
	recordIndex: number;
};

export type RecalledObservation = {
	observation: Observation;
	observationEntryId: string;
	observationRecordIndex: number;
	status: "active" | "dropped";
	sourceEntryIds: string[];
	sourceEntries: Entry[];
	missingSourceEntryIds: string[];
	nonSourceEntryIds: string[];
};

export type RecalledReflection = {
	reflection: Reflection;
	reflectionEntryId: string;
	reflectionRecordIndex: number;
};

export type RecallResult =
	| {
			status: "not_found";
			memoryId: string;
			kind: undefined;
			reflections: [];
			observations: [];
			sourceEntries: [];
			missingSourceEntryIds: [];
			nonSourceEntryIds: [];
			missingSupportingObservationIds: [];
			collision: false;
			partial: false;
	  }
	| {
			status: "found";
			memoryId: string;
			kind: "observation" | "reflection" | "mixed";
			reflections: RecalledReflection[];
			observations: RecalledObservation[];
			sourceEntries: Entry[];
			missingSourceEntryIds: string[];
			nonSourceEntryIds: string[];
			missingSupportingObservationIds: string[];
			collision: boolean;
			partial: boolean;
	  };

type IndexedObservation = ObservationLedgerLocation & { observation: Observation };
type IndexedReflection = ReflectionLedgerLocation & { reflection: Reflection };

function isSourceEntry(entry: Entry): boolean {
	return SOURCE_TYPES.has(entry.type);
}

function uniqueById(entries: Entry[]): Entry[] {
	const seen = new Set<string>();
	const result: Entry[] = [];
	for (const entry of entries) {
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		result.push(entry);
	}
	return result;
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values));
}

function indexLedger(entries: Entry[]): {
	observations: IndexedObservation[];
	reflections: IndexedReflection[];
	droppedIds: Set<string>;
} {
	const observations: IndexedObservation[] = [];
	const reflections: IndexedReflection[] = [];
	const droppedIds = new Set<string>();

	for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
		const entry = entries[entryIndex];
		if (isObservationsRecordedEntry(entry)) {
			entry.data.observations.forEach((observation, recordIndex) => {
				observations.push({ observation, entryId: entry.id, entryIndex, recordIndex });
			});
			continue;
		}
		if (isReflectionsRecordedEntry(entry)) {
			entry.data.reflections.forEach((reflection, recordIndex) => {
				reflections.push({ reflection, entryId: entry.id, entryIndex, recordIndex });
			});
			continue;
		}
		if (isObservationsDroppedEntry(entry)) {
			entry.data.observationIds.forEach((id) => droppedIds.add(id));
		}
	}

	return { observations, reflections, droppedIds };
}

function resolveObservationSources(entries: Entry[], observation: Observation, location: ObservationLedgerLocation): RecalledObservation {
	const sourceEntryIds = uniqueStrings(observation.sourceEntryIds);
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const sourceEntries: Entry[] = [];
	const missingSourceEntryIds: string[] = [];
	const nonSourceEntryIds: string[] = [];

	for (const sourceEntryId of sourceEntryIds) {
		const sourceEntry = byId.get(sourceEntryId);
		if (!sourceEntry) {
			missingSourceEntryIds.push(sourceEntryId);
			continue;
		}
		if (!isSourceEntry(sourceEntry)) {
			nonSourceEntryIds.push(sourceEntryId);
			continue;
		}
		sourceEntries.push(sourceEntry);
	}

	return {
		observation,
		observationEntryId: location.entryId,
		observationRecordIndex: location.recordIndex,
		status: "active",
		sourceEntryIds,
		sourceEntries,
		missingSourceEntryIds,
		nonSourceEntryIds,
	};
}

function notFound(memoryId: string): RecallResult {
	return {
		status: "not_found",
		memoryId,
		kind: undefined,
		reflections: [],
		observations: [],
		sourceEntries: [],
		missingSourceEntryIds: [],
		nonSourceEntryIds: [],
		missingSupportingObservationIds: [],
		collision: false,
		partial: false,
	};
}

export function recallMemorySources(entries: Entry[], memoryId: string): RecallResult {
	const { observations: indexedObservations, reflections: indexedReflections, droppedIds } = indexLedger(entries);
	const directObservationMatches = indexedObservations.filter(({ observation }) => observation.id === memoryId);
	const reflectionMatches = indexedReflections.filter(({ reflection }) => reflection.id === memoryId);

	if (directObservationMatches.length === 0 && reflectionMatches.length === 0) return notFound(memoryId);

	const observationsById = new Map<string, IndexedObservation>();
	for (const indexed of indexedObservations) {
		if (!observationsById.has(indexed.observation.id)) observationsById.set(indexed.observation.id, indexed);
	}

	const recalledByKey = new Map<string, RecalledObservation>();
	const missingSupportingObservationIds: string[] = [];

	function addObservation(indexed: IndexedObservation): void {
		const key = `${indexed.entryId}:${indexed.recordIndex}`;
		if (recalledByKey.has(key)) return;
		const recalled = resolveObservationSources(entries, indexed.observation, indexed);
		recalled.status = droppedIds.has(indexed.observation.id) ? "dropped" : "active";
		recalledByKey.set(key, recalled);
	}

	for (const match of directObservationMatches) addObservation(match);

	for (const { reflection } of reflectionMatches) {
		for (const observationId of uniqueStrings(reflection.supportingObservationIds)) {
			const indexed = observationsById.get(observationId);
			if (!indexed) {
				missingSupportingObservationIds.push(observationId);
				continue;
			}
			addObservation(indexed);
		}
	}

	const recalledObservations = Array.from(recalledByKey.values());
	const recalledReflections: RecalledReflection[] = reflectionMatches.map(({ reflection, entryId, recordIndex }) => ({
		reflection,
		reflectionEntryId: entryId,
		reflectionRecordIndex: recordIndex,
	}));
	const sourceEntries = uniqueById(recalledObservations.flatMap((match) => match.sourceEntries));
	const missingSourceEntryIds = uniqueStrings(recalledObservations.flatMap((match) => match.missingSourceEntryIds));
	const nonSourceEntryIds = uniqueStrings(recalledObservations.flatMap((match) => match.nonSourceEntryIds));
	const uniqueMissingSupportingObservationIds = uniqueStrings(missingSupportingObservationIds);
	const matchCount = directObservationMatches.length + reflectionMatches.length;

	return {
		status: "found",
		memoryId,
		kind: directObservationMatches.length > 0 && reflectionMatches.length > 0
			? "mixed"
			: reflectionMatches.length > 0
				? "reflection"
				: "observation",
		reflections: recalledReflections,
		observations: recalledObservations,
		sourceEntries,
		missingSourceEntryIds,
		nonSourceEntryIds,
		missingSupportingObservationIds: uniqueMissingSupportingObservationIds,
		collision: matchCount > 1,
		partial: missingSourceEntryIds.length > 0 || nonSourceEntryIds.length > 0 || uniqueMissingSupportingObservationIds.length > 0,
	};
}
