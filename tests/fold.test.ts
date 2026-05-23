/**
 * Ledger folding tests.
 *
 * Covers: foldLedger, observation/reflection dedup, dropped observations,
 * upToEntryId boundary, invalid data filtering.
 *
 * IDs must be exactly 12 hex chars [a-f0-9]{12} (validated by isMemoryId).
 */

import { describe, it, expect } from "vitest";
import type { Entry, Observation, Reflection } from "../src/om/ledger/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeEntry(id: string, type: string = "message", overrides: Record<string, unknown> = {}): Entry {
	return { id, type, ...overrides } as Entry;
}

/** Observation IDs must be exactly 12 hex chars [a-f0-9]{12}. */
function makeObservation(id: string, overrides: Partial<Observation> = {}): Observation {
	return {
		id,
		content: `Observation ${id}`,
		timestamp: "2026-01-01 12:00",
		relevance: "medium" as const,
		sourceEntryIds: ["src00000000aa"],
		tokenCount: 100,
		...overrides,
	};
}

function makeReflection(id: string, overrides: Partial<Reflection> = {}): Reflection {
	return {
		id,
		content: `Reflection ${id}`,
		supportingObservationIds: ["obs00000000aa"],
		tokenCount: 200,
		...overrides,
	};
}

function recordEntry(id: string, observations: Observation[], coversUpToId: string = "src00000000aa"): Entry {
	return makeEntry(id, "custom", {
		customType: "om.observations.recorded",
		data: { observations, coversUpToId },
	});
}

function reflectEntry(id: string, reflections: Reflection[], coversUpToId: string = "src00000000bb"): Entry {
	return makeEntry(id, "custom", {
		customType: "om.reflections.recorded",
		data: { reflections, coversUpToId },
	});
}

function dropEntry(id: string, observationIds: string[], coversUpToId: string = "src00000000cc"): Entry {
	return makeEntry(id, "custom", {
		customType: "om.observations.dropped",
		data: { observationIds, coversUpToId },
	});
}

/** Generate a unique 12-hex-char ID from a label. */
function hexId(label: string): string {
	const raw = Array.from(label).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
	return Math.abs(raw).toString(16).padStart(12, "0").slice(0, 12);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("foldLedger", () => {
	it("returns empty state when no memory entries exist", async () => {
		const { foldLedger } = await import("../src/om/ledger/fold.js");
		const result = foldLedger([]);
		expect(result.observations).toEqual([]);
		expect(result.activeObservations).toEqual([]);
		expect(result.droppedObservationIds).toEqual(new Set());
		expect(result.reflections).toEqual([]);
	});

	it("collects observations from recorded entries", async () => {
		const { foldLedger } = await import("../src/om/ledger/fold.js");
		const obs1 = makeObservation(hexId("obs-one"));
		const obs2 = makeObservation(hexId("obs-two"));
		const entries: Entry[] = [
			makeEntry("src0000000001", "message"),
			makeEntry("src0000000002", "message"),
			recordEntry("entry-record-1", [obs1, obs2]),
		];
		const result = foldLedger(entries);
		expect(result.observations).toHaveLength(2);
		expect(result.activeObservations).toHaveLength(2);
	});

	it("deduplicates observations by id (first wins)", async () => {
		const { foldLedger } = await import("../src/om/ledger/fold.js");
		const sameId = hexId("dedup");
		const obs1 = makeObservation(sameId);
		const obs2 = makeObservation(sameId, { content: "Different content" });
		const entries: Entry[] = [
			recordEntry("entry-one", [obs1]),
			recordEntry("entry-two", [obs2]),
		];
		const result = foldLedger(entries);
		expect(result.observations).toHaveLength(1);
		expect(result.observations[0].content).toBe(`Observation ${sameId}`); // first wins
	});

	it("tombstones dropped observations", async () => {
		const { foldLedger } = await import("../src/om/ledger/fold.js");
		const dropId = hexId("drop-me");
		const keepId = hexId("keep-me");
		const obs1 = makeObservation(dropId);
		const obs2 = makeObservation(keepId);
		const entries: Entry[] = [
			recordEntry("entry-record-1", [obs1, obs2]),
			dropEntry("entry-drop-1", [dropId]),
		];
		const result = foldLedger(entries);
		expect(result.observations).toHaveLength(2); // all recorded
		expect(result.activeObservations).toHaveLength(1);
		expect(result.activeObservations[0].id).toBe(keepId);
		expect(result.droppedObservationIds.has(dropId)).toBe(true);
	});

	it("collects reflections from recorded entries", async () => {
		const { foldLedger } = await import("../src/om/ledger/fold.js");
		const ref1 = makeReflection(hexId("ref-one"));
		const ref2 = makeReflection(hexId("ref-two"));
		const entries: Entry[] = [
			reflectEntry("entry-reflect-1", [ref1, ref2]),
		];
		const result = foldLedger(entries);
		expect(result.reflections).toHaveLength(2);
	});

	it("filters out invalid observation data", async () => {
		const { foldLedger } = await import("../src/om/ledger/fold.js");
		const valid = makeObservation(hexId("valid"));
		const entries: Entry[] = [
			makeEntry("bad-entry", "custom", {
				customType: "om.observations.recorded",
				data: { coversUpToId: "src0000000001" }, // missing observations array
			}),
			recordEntry("good-entry", [valid]),
		];
		const result = foldLedger(entries);
		expect(result.observations).toHaveLength(1);
		expect(result.observations[0].id).toBe(valid.id);
	});

	it("filters out invalid reflection data", async () => {
		const { foldLedger } = await import("../src/om/ledger/fold.js");
		const valid = makeReflection(hexId("valid"));
		const entries: Entry[] = [
			makeEntry("bad-entry", "custom", {
				customType: "om.reflections.recorded",
				data: { coversUpToId: "src0000000001" }, // missing reflections array
			}),
			reflectEntry("good-entry", [valid]),
		];
		const result = foldLedger(entries);
		expect(result.reflections).toHaveLength(1);
		expect(result.reflections[0].id).toBe(valid.id);
	});

	it("stops folding at upToEntryId boundary", async () => {
		const { foldLedger } = await import("../src/om/ledger/fold.js");
		const obs1 = makeObservation(hexId("before"));
		const obs2 = makeObservation(hexId("after"));
		const entries: Entry[] = [
			recordEntry("entry-before", [obs1]),
			makeEntry("boundary-entry", "message"), // folding stops here
			recordEntry("entry-after", [obs2]),
		];
		const result = foldLedger(entries, { upToEntryId: "boundary-entry" });
		expect(result.observations).toHaveLength(1);
		expect(result.observations[0].id).toBe(obs1.id);
	});
});
