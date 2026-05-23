/**
 * Memory recall tests.
 *
 * Covers: recallMemorySources, source entry resolution, missing entries,
 * reflections that reference observations, collision detection.
 */

import { describe, it, expect } from "vitest";
import type { Entry, Observation, Reflection } from "../src/om/ledger/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function hexId(label: string): string {
	const raw = Array.from(label).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
	return Math.abs(raw).toString(16).padStart(12, "0").slice(0, 12);
}

function makeEntry(id: string, type: string = "message", overrides: Record<string, unknown> = {}): Entry {
	return { id, type, ...overrides } as Entry;
}

function makeObservation(id: string, sourceEntryIds: string[] = ["src0000000001"], overrides: Partial<Observation> = {}): Observation {
	return {
		id,
		content: `Content ${id}`,
		timestamp: "2026-01-01 12:00",
		relevance: "medium" as const,
		sourceEntryIds,
		tokenCount: 100,
		...overrides,
	};
}

function makeReflection(id: string, supportingObservationIds: string[] = ["aaaaaaaaaaaa"], overrides: Partial<Reflection> = {}): Reflection {
	return {
		id,
		content: `Reflection ${id}`,
		supportingObservationIds,
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe("recallMemorySources", () => {
	it("returns not_found when no match", async () => {
		const { recallMemorySources } = await import("../src/om/ledger/recall.js");
		const result = recallMemorySources([], "aaaaaaaaaaaa");
		expect(result.status).toBe("not_found");
	});

	it("finds observation by id", async () => {
		const { recallMemorySources } = await import("../src/om/ledger/recall.js");
		const obsId = hexId("target-obs");
		const obs = makeObservation(obsId, ["src0000000001"]);
		const srcEntry = makeEntry("src0000000001", "message", {
			message: { role: "user", content: "Hello" },
		});
		const entries: Entry[] = [
			srcEntry,
			recordEntry("e1", [obs]),
		];
		const result = recallMemorySources(entries, obsId);
		expect(result.status).toBe("found");
		if (result.status === "found") {
			expect(result.observations).toHaveLength(1);
			expect(result.observations[0].observation.id).toBe(obsId);
			expect(result.observations[0].status).toBe("active");
			expect(result.sourceEntries).toHaveLength(1);
			expect(result.sourceEntries[0].id).toBe("src0000000001");
		}
	});

	it("finds reflection by id and resolves supporting observations", async () => {
		const { recallMemorySources } = await import("../src/om/ledger/recall.js");
		const obsId = hexId("support-obs");
		const refId = hexId("target-ref");
		const obs = makeObservation(obsId, ["src0000000001"]);
		const ref = makeReflection(refId, [obsId]);
		const entries: Entry[] = [
			makeEntry("src0000000001", "message", {
				message: { role: "user", content: "Hello" },
			}),
			recordEntry("e1", [obs]),
			reflectEntry("e2", [ref]),
		];
		const result = recallMemorySources(entries, refId);
		expect(result.status).toBe("found");
		if (result.status === "found") {
			expect(result.kind).toBe("reflection");
			expect(result.reflections).toHaveLength(1);
			expect(result.reflections[0].reflection.id).toBe(refId);
			// Should have resolved the supporting observation
			expect(result.observations).toHaveLength(1);
			expect(result.observations[0].observation.id).toBe(obsId);
		}
	});

	it("marks observation as dropped when tombstoned", async () => {
		const { recallMemorySources } = await import("../src/om/ledger/recall.js");
		const obsId = hexId("dropped-obs");
		const obs = makeObservation(obsId);
		const entries: Entry[] = [
			recordEntry("e1", [obs]),
			dropEntry("e2", [obsId]),
		];
		const result = recallMemorySources(entries, obsId);
		expect(result.status).toBe("found");
		if (result.status === "found") {
			expect(result.observations[0].status).toBe("dropped");
		}
	});

	it("detects missing source entries", async () => {
		const { recallMemorySources } = await import("../src/om/ledger/recall.js");
		const obsId = hexId("missing-src");
		const obs = makeObservation(obsId, ["nonexistent-src"]);
		const entries: Entry[] = [
			recordEntry("e1", [obs]),
		];
		const result = recallMemorySources(entries, obsId);
		expect(result.status).toBe("found");
		if (result.status === "found") {
			expect(result.missingSourceEntryIds).toContain("nonexistent-src");
			expect(result.partial).toBe(true);
		}
	});

	it("detects collisions when multiple entries match the same id", async () => {
		const { recallMemorySources } = await import("../src/om/ledger/recall.js");
		const sameObsId = hexId("collision");
		const obs1 = makeObservation(sameObsId, ["src0000000001"]);
		const obs2 = makeObservation(sameObsId, ["src0000000002"]); // same id, diff sources
		const entries: Entry[] = [
			recordEntry("e1", [obs1]),
			recordEntry("e2", [obs2]),
		];
		const result = recallMemorySources(entries, sameObsId);
		expect(result.status).toBe("found");
		if (result.status === "found") {
			expect(result.collision).toBe(true);
		}
	});
});
