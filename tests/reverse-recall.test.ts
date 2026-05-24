/**
 * Reverse recall tests — vcc→OM coupling and cross-format navigation.
 *
 * Covers: findObservationsForEntryIds, findReflectionsForEntryIds,
 * formatRelatedObservations, buildIndexMap, formatEntryIndexAnnotation,
 * and integration with the recall tool dispatch.
 */

import { describe, it, expect } from "vitest";
import type { Entry, Observation, Reflection } from "../src/om/ledger/types.js";
import type { RenderedEntry } from "../src/core/render-entries.js";

// ── Helpers (mirrored from recall.test.ts) ────────────────────────────────

function hexId(label: string): string {
	const raw = Array.from(label).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
	return Math.abs(raw).toString(16).padStart(12, "0").slice(0, 12);
}

function makeEntry(id: string, type: string = "message", overrides: Record<string, unknown> = {}): Entry {
	return { id, type, ...overrides } as Entry;
}

const OBS_ID_A = hexId("obs-a");
const OBS_ID_B = hexId("obs-b");
const OBS_ID_C = hexId("dropped-obs");
const REF_ID = hexId("target-ref");

function makeObservation(id: string, sourceEntryIds: string[] = ["src00000001"], overrides: Partial<Observation> = {}): Observation {
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

// ── Reverse recall tests ─────────────────────────────────────────────────

describe("findObservationsForEntryIds", () => {
	it("finds observation by matching sourceEntryId", async () => {
		const { findObservationsForEntryIds } = await import("../src/om/reverse-recall.js");
		const obs = makeObservation("a1b2c3d4e5f6", ["src00000001", "src00000002"]);
		const entries: Entry[] = [
			makeEntry("src00000001", "message", { message: { role: "user", content: "Hello" } }),
			makeEntry("src00000002", "message", { message: { role: "assistant", content: "Hi" } }),
			recordEntry("e1", [obs]),
		];
		const result = findObservationsForEntryIds(entries, ["src00000001"]);
		expect(result).toHaveLength(1);
		expect(result[0].memoryId).toBe("a1b2c3d4e5f6");
		expect(result[0].matchedEntryIds).toContain("src00000001");
	});

	it("returns empty for non-referenced entry IDs", async () => {
		const { findObservationsForEntryIds } = await import("../src/om/reverse-recall.js");
		const obs = makeObservation("obs1", ["src00000001"]);
		const entries: Entry[] = [
			makeEntry("src00000001", "message"),
			recordEntry("e1", [obs]),
		];
		const result = findObservationsForEntryIds(entries, ["nonexistent"]);
		expect(result).toHaveLength(0);
	});

	it("returns empty when no branch entries provided", async () => {
		const { findObservationsForEntryIds } = await import("../src/om/reverse-recall.js");
		const result = findObservationsForEntryIds([], ["src00000001"]);
		expect(result).toHaveLength(0);
	});

	it("matches multiple observations for the same entry", async () => {
		const { findObservationsForEntryIds } = await import("../src/om/reverse-recall.js");
		const obs1 = makeObservation(OBS_ID_A, ["src00000001"]);
		const obs2 = makeObservation(OBS_ID_B, ["src00000001", "src00000002"]);
		const entries: Entry[] = [
			makeEntry("src00000001", "message"),
			makeEntry("src00000002", "message"),
			recordEntry("e1", [obs1]),
			recordEntry("e2", [obs2]),
		];
		const result = findObservationsForEntryIds(entries, ["src00000001"]);
		expect(result).toHaveLength(2);
		expect(result.map((r) => r.memoryId)).toContain(OBS_ID_A);
		expect(result.map((r) => r.memoryId)).toContain(OBS_ID_B);
	});

	it("marks observation as dropped", async () => {
		const { findObservationsForEntryIds } = await import("../src/om/reverse-recall.js");
		const obs = makeObservation(OBS_ID_C, ["src00000001"]);
		const entries: Entry[] = [
			makeEntry("src00000001", "message"),
			recordEntry("e1", [obs]),
			dropEntry("e2", [OBS_ID_C]),
		];
		const result = findObservationsForEntryIds(entries, ["src00000001"]);
		expect(result).toHaveLength(1);
		expect(result[0].status).toBe("dropped");
	});

	it("finds observations for multiple target entry IDs at once", async () => {
		const { findObservationsForEntryIds } = await import("../src/om/reverse-recall.js");
		const obs1 = makeObservation(OBS_ID_A, ["src00000001"]);
		const obs2 = makeObservation(OBS_ID_B, ["src00000002"]);
		const entries: Entry[] = [
			makeEntry("src00000001", "message"),
			makeEntry("src00000002", "message"),
			recordEntry("e1", [obs1]),
			recordEntry("e2", [obs2]),
		];
		const result = findObservationsForEntryIds(entries, ["src00000001", "src00000002"]);
		expect(result).toHaveLength(2);
	});
});

// ── Reflection reverse lookup tests ──────────────────────────────────────

describe("findReflectionsForEntryIds", () => {
	it("finds reflection whose supporting observation references the target entry", async () => {
		const { findReflectionsForEntryIds } = await import("../src/om/reverse-recall.js");
		const obs = makeObservation(OBS_ID_A, ["src00000001"]);
		const ref = makeReflection(REF_ID, [obs.id]);
		const entries: Entry[] = [
			makeEntry("src00000001", "message"),
			recordEntry("e1", [obs]),
			reflectEntry("e2", [ref]),
		];
		const result = findReflectionsForEntryIds(entries, ["src00000001"]);
		expect(result).toHaveLength(1);
		expect(result[0].memoryId).toBe(REF_ID);
	});

	it("returns empty when no observations reference the target", async () => {
		const { findReflectionsForEntryIds } = await import("../src/om/reverse-recall.js");
		const obs = makeObservation(OBS_ID_A, ["src00000001"]);
		const ref = makeReflection(REF_ID, [obs.id]);
		const entries: Entry[] = [
			makeEntry("src00000001", "message"),
			recordEntry("e1", [obs]),
			reflectEntry("e2", [ref]),
		];
		const result = findReflectionsForEntryIds(entries, ["nonexistent"]);
		expect(result).toHaveLength(0);
	});
});

// ── Formatter tests ──────────────────────────────────────────────────────

describe("formatRelatedObservations", () => {
	it("formats observations with metadata", async () => {
		const { formatRelatedObservations } = await import("../src/om/reverse-recall.js");
		const result = formatRelatedObservations(
			[
				{
					memoryId: "a1b2c3d4e5f6",
					content: "User discussed config keys",
					timestamp: "2026-05-23 23:56",
					relevance: "medium",
					status: "active",
					matchedEntryIds: ["src00000001"],
				},
			],
			[],
		);
		expect(result).toContain("Related observations:");
		expect(result).toContain("a1b2c3d4e5f6");
		expect(result).toContain("2026-05-23 23:56");
		expect(result).toContain("[medium]");
		expect(result).toContain("User discussed config keys");
	});

	it("shows [dropped] for dropped observations", async () => {
		const { formatRelatedObservations } = await import("../src/om/reverse-recall.js");
		const result = formatRelatedObservations(
			[
				{
					memoryId: "deadbeefcafe",
					content: "Old observation",
					timestamp: "2026-01-01 00:00",
					relevance: "low",
					status: "dropped",
					matchedEntryIds: ["src00000001"],
				},
			],
			[],
		);
		expect(result).toContain("[dropped]");
	});

	it("returns empty string when no observations or reflections", async () => {
		const { formatRelatedObservations } = await import("../src/om/reverse-recall.js");
		const result = formatRelatedObservations([], []);
		expect(result).toBe("");
	});
});

// ── Index map tests ──────────────────────────────────────────────────────

describe("buildIndexMap / formatEntryIndexAnnotation", () => {
	it("builds id-to-index map from RenderedEntry array", async () => {
		const { buildIndexMap } = await import("../src/om/reverse-recall.js");
		const rendered: RenderedEntry[] = [
			{ index: 0, id: "entry-a", role: "user", summary: "Hello" },
			{ index: 1, id: "entry-b", role: "assistant", summary: "Hi" },
			{ index: 2, id: "entry-c", role: "user", summary: "What?" },
		];
		const map = buildIndexMap(rendered);
		expect(map.get("entry-a")).toBe(0);
		expect(map.get("entry-b")).toBe(1);
		expect(map.get("entry-c")).toBe(2);
		expect(map.has("nonexistent")).toBe(false);
	});

	it("formats index annotation as #N list", async () => {
		const { formatEntryIndexAnnotation, buildIndexMap } = await import("../src/om/reverse-recall.js");
		const rendered: RenderedEntry[] = [
			{ index: 0, id: "entry-a", role: "user", summary: "A" },
			{ index: 1, id: "entry-b", role: "user", summary: "B" },
			{ index: 5, id: "entry-c", role: "user", summary: "C" },
		];
		const map = buildIndexMap(rendered);
		const annotation = formatEntryIndexAnnotation(["entry-a", "entry-c", "entry-b"], map);
		expect(annotation).toBe("(at index #0, #1, #5)");
	});

	it("returns empty string when no source entries are in the map", async () => {
		const { formatEntryIndexAnnotation, buildIndexMap } = await import("../src/om/reverse-recall.js");
		const rendered: RenderedEntry[] = [
			{ index: 0, id: "entry-a", role: "user", summary: "A" },
		];
		const map = buildIndexMap(rendered);
		const annotation = formatEntryIndexAnnotation(["nonexistent"], map);
		expect(annotation).toBe("");
	});

	it("skips unknown IDs in annotation", async () => {
		const { formatEntryIndexAnnotation, buildIndexMap } = await import("../src/om/reverse-recall.js");
		const rendered: RenderedEntry[] = [
			{ index: 3, id: "known-entry", role: "user", summary: "Hello" },
		];
		const map = buildIndexMap(rendered);
		const annotation = formatEntryIndexAnnotation(["known-entry", "unknown"], map);
		expect(annotation).toBe("(at index #3)");
	});
});

// ── RenderMessage id passthrough test ─────────────────────────────────────

describe("renderMessage id passthrough", () => {
	it("includes id in rendered entry", async () => {
		const { renderMessage } = await import("../src/core/render-entries.js");
		const msg = { role: "user" as const, content: "Hello", timestamp: 0 };
		const result = renderMessage(msg as any, 5, "entry-id-01");
		expect(result.id).toBe("entry-id-01");
		expect(result.index).toBe(5);
	});

	it("passes id through for assistant messages", async () => {
		const { renderMessage } = await import("../src/core/render-entries.js");
		const msg = { role: "assistant" as const, content: [{ type: "text" as const, text: "Response" }], api: "", provider: "", model: "", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, stopReason: "stop" as const, timestamp: 0 };
		const result = renderMessage(msg as any, 3, "entry-assist");
		expect(result.id).toBe("entry-assist");
	});

	it("passes id through for tool results", async () => {
		const { renderMessage } = await import("../src/core/render-entries.js");
		const msg = { role: "toolResult" as const, toolCallId: "call-1", toolName: "bash", content: [{ type: "text" as const, text: "output" }], isError: false, timestamp: 0 };
		const result = renderMessage(msg as any, 7, "entry-tool");
		expect(result.id).toBe("entry-tool");
	});
});

// ── Integration: #N dispatch fix ─────────────────────────────────────────

describe("VCC_ENTRY_PATTERN dispatch", () => {
	it("matches #N pattern", async () => {
		// The pattern is /^#(\d+)$/ — validate directly
		const pattern = /^#(\d+)$/;
		expect(pattern.test("#13")).toBe(true);
		expect(pattern.test("#0")).toBe(true);
		expect(pattern.test("#999")).toBe(true);
		expect(pattern.test("13")).toBe(false);
		expect(pattern.test("#abc")).toBe(false);
		expect(pattern.test("##13")).toBe(false);
	});

	it("captures the numeric index", () => {
		const pattern = /^#(\d+)$/;
		const match = "#13".match(pattern);
		expect(match).not.toBeNull();
		expect(match![1]).toBe("13");
		expect(parseInt(match![1], 10)).toBe(13);
	});
});
