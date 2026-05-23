/**
 * Ledger projection tests.
 *
 * Covers: fullProjection, visibleProjection, buildCompactionProjection,
 * diffProjection, latestFullFoldBoundaryId.
 *
 * Observations/Reflections need 12-char hex IDs.
 * coversUpToId must reference an actual entry ID in the entries array.
 */

import { describe, it, expect } from "vitest";
import type { Entry, Observation, Reflection } from "../src/om/ledger/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeEntry(id: string, type: string = "message", overrides: Record<string, unknown> = {}): Entry {
	return { id, type, ...overrides } as Entry;
}

function hexId(label: string): string {
	const raw = Array.from(label).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
	return Math.abs(raw).toString(16).padStart(12, "0").slice(0, 12);
}

function makeObservation(id: string, overrides: Partial<Observation> = {}): Observation {
	return {
		id,
		content: `Content ${id}`,
		timestamp: "2026-01-01 12:00",
		relevance: "medium" as const,
		sourceEntryIds: ["aaaaaaaaaaaa"],
		tokenCount: 100,
		...overrides,
	};
}

function makeReflection(id: string, overrides: Partial<Reflection> = {}): Reflection {
	return {
		id,
		content: `Reflection ${id}`,
		supportingObservationIds: ["aaaaaaaaaaaa"],
		tokenCount: 200,
		...overrides,
	};
}

function recordEntry(id: string, observations: Observation[], coversUpToId: string): Entry {
	return makeEntry(id, "custom", {
		customType: "om.observations.recorded",
		data: { observations, coversUpToId },
	});
}

function reflectEntry(id: string, reflections: Reflection[], coversUpToId: string): Entry {
	return makeEntry(id, "custom", {
		customType: "om.reflections.recorded",
		data: { reflections, coversUpToId },
	});
}

function compactionEntry(id: string, firstKeptEntryId: string, details?: unknown): Entry {
	return makeEntry(id, "compaction", { firstKeptEntryId, details });
}

/** A "source" entry (message) that serves as a coverage boundary */
function src(id: string): Entry {
	return makeEntry(id, "message", { message: { role: "user", content: "test" } });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("fullProjection", () => {
	it("returns empty projection when no memory entries", async () => {
		const { fullProjection } = await import("../src/om/ledger/projection.js");
		const result = fullProjection([]);
		expect(result.observations).toEqual([]);
		expect(result.reflections).toEqual([]);
	});

	it("returns all observations and reflections up to tip", async () => {
		const { fullProjection } = await import("../src/om/ledger/projection.js");
		const obs1 = makeObservation(hexId("obs-a"));
		const obs2 = makeObservation(hexId("obs-b"));
		const ref1 = makeReflection(hexId("ref-a"));
		const entries: Entry[] = [
			src("boundary-001"),
			recordEntry("e1", [obs1, obs2], "boundary-001"),
			src("boundary-002"),
			reflectEntry("e2", [ref1], "boundary-002"),
		];
		const result = fullProjection(entries);
		expect(result.observations).toHaveLength(2);
		expect(result.reflections).toHaveLength(1);
	});

	it("respects upToEntryId boundary", async () => {
		const { fullProjection } = await import("../src/om/ledger/projection.js");
		const obs1 = makeObservation(hexId("obs-before"));
		const obs2 = makeObservation(hexId("obs-after"));
		const entries: Entry[] = [
			src("boundary-before"),
			recordEntry("e1", [obs1], "boundary-before"),
			src("boundary-mid"), // folding stops here
			src("boundary-after"),
			recordEntry("e2", [obs2], "boundary-after"),
		];
		const result = fullProjection(entries, "boundary-mid");
		expect(result.observations).toHaveLength(1);
		expect(result.observations[0].id).toBe(obs1.id);
	});
});

describe("visibleProjection", () => {
	it("returns empty when no compaction details", async () => {
		const { visibleProjection } = await import("../src/om/ledger/projection.js");
		const result = visibleProjection([]);
		expect(result.observations).toEqual([]);
		expect(result.reflections).toEqual([]);
	});

	it("returns from latest compaction details", async () => {
		const { visibleProjection } = await import("../src/om/ledger/projection.js");
		const obs1 = makeObservation(hexId("obs-a"));
		const ref1 = makeReflection(hexId("ref-a"));
		const entries: Entry[] = [
			src("boundary-001"),
			recordEntry("e1", [obs1], "boundary-001"),
			src("boundary-002"),
			reflectEntry("e2", [ref1], "boundary-002"),
			compactionEntry("c1", "boundary-001", {
				type: "om.folded",
				version: 1,
				fullFold: false,
				observations: [obs1],
				reflections: [ref1],
			}),
		];
		const result = visibleProjection(entries);
		expect(result.observations).toHaveLength(1);
		expect(result.reflections).toHaveLength(1);
	});
});

describe("buildCompactionProjection", () => {
	it("builds projection for compaction (coversUpToId at firstKeptEntryId)", async () => {
		const { buildCompactionProjection } = await import("../src/om/ledger/projection.js");
		const obs1 = makeObservation(hexId("obs-a"));
		const obs2 = makeObservation(hexId("obs-b"));
		const ref1 = makeReflection(hexId("ref-a"));
		// In buildCompactionProjection, observations are those whose coversUpToId
		// is AT or BEFORE firstKeptEntryId. So coversUpToId must reference an entry
		// whose index <= index of firstKeptEntryId.
		const entries: Entry[] = [
			src("kept-entry"),                    // index 0 = firstKeptEntryId
			recordEntry("e1", [obs1, obs2], "kept-entry"), // coversUpToId at index 0 ✓
			src("after-entry"),
			reflectEntry("e2", [ref1], "after-entry"),
		];
		const result = buildCompactionProjection(entries, "kept-entry", { observationsPoolMaxTokens: 20_000 });
		expect(result.observations).toHaveLength(2);
		expect(result.observations[0].id).toBe(obs1.id);
		expect(result.observations[1].id).toBe(obs2.id);
		// Reflections are excluded from normal projection (only in full fold)
		expect(result.reflections).toHaveLength(0);
		expect(result.fullFold).toBe(false);
	});

	it("triggers full fold when observations pool exceeds threshold", async () => {
		const { buildCompactionProjection } = await import("../src/om/ledger/projection.js");
		const obs = makeObservation(hexId("big-obs"), { tokenCount: 25_000 });
		const entries: Entry[] = [
			src("kept-entry"),
			recordEntry("e1", [obs], "kept-entry"),
		];
		const result = buildCompactionProjection(entries, "kept-entry", { observationsPoolMaxTokens: 20_000 });
		expect(result.fullFold).toBe(true);
	});

	it("includes details object with fold metadata", async () => {
		const { buildCompactionProjection } = await import("../src/om/ledger/projection.js");
		const obs = makeObservation(hexId("obs-details"));
		const ref = makeReflection(hexId("ref-details"));
		const entries: Entry[] = [
			src("kept-entry"),
			src("boundary-001"),
			recordEntry("e1", [obs], "boundary-001"),
			src("boundary-002"),
			reflectEntry("e2", [ref], "boundary-002"),
		];
		const result = buildCompactionProjection(entries, "kept-entry", { observationsPoolMaxTokens: 20_000 });
		expect(result.details).toBeDefined();
		expect(result.details.type).toBe("om.folded");
		expect(result.details.version).toBe(1);
		expect(result.details.observations).toEqual(result.observations);
		expect(result.details.reflections).toEqual(result.reflections);
	});
});

describe("diffProjection", () => {
	it("diffs two projections", async () => {
		const { diffProjection } = await import("../src/om/ledger/projection.js");
		const visible = {
			observations: [makeObservation("aaaaaaaaaaaa")],
			reflections: [makeReflection("bbbbbbbbbbbb")],
		};
		const full = {
			observations: [
				makeObservation("aaaaaaaaaaaa"),
				makeObservation("cccccccccccc"), // only in full
			],
			reflections: [makeReflection("bbbbbbbbbbbb")],
		};
		const result = diffProjection(visible, full);
		expect(result.observationsOnlyInFull).toHaveLength(1);
		expect(result.observationsOnlyInFull[0].id).toBe("cccccccccccc");
		expect(result.reflectionsOnlyInFull).toHaveLength(0);
	});
});

describe("latestFullFoldBoundaryId", () => {
	it("returns firstKeptEntryId of latest full-fold compaction", async () => {
		const { latestFullFoldBoundaryId } = await import("../src/om/ledger/projection.js");
		const entries: Entry[] = [
			src("src0000000001"),
			compactionEntry("c1", "src0000000001", {
				type: "om.folded",
				version: 1,
				fullFold: true,
				observations: [],
				reflections: [],
			}),
			src("src0000000002"),
		];
		const result = latestFullFoldBoundaryId(entries);
		expect(result).toBe("src0000000001");
	});

	it("returns undefined when no full-fold compaction", async () => {
		const { latestFullFoldBoundaryId } = await import("../src/om/ledger/projection.js");
		const entries: Entry[] = [
			compactionEntry("c1", "src0000000001"),
		];
		const result = latestFullFoldBoundaryId(entries);
		expect(result).toBeUndefined();
	});
});
