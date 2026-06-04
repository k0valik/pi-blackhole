/**
 * Render-summary tests.
 *
 * Covers: renderSummary, observationToSummaryLine, reflectionToSummaryLine,
 * empty input handling.
 */

import { describe, it, expect } from "vitest";
import type { Observation, Reflection } from "../src/om/ledger/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeObservation(id: string, overrides: Partial<Observation> = {}): Observation {
	return {
		id,
		content: `User mentioned they prefer TypeScript over JavaScript`,
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
		content: "User prefers TypeScript with strict mode enabled",
		supportingObservationIds: ["aaaaaaaaaaaa"],
		tokenCount: 200,
		...overrides,
	};
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("observationToSummaryLine", () => {
	it("formats an observation line", async () => {
		const { observationToSummaryLine } = await import("../src/om/ledger/render-summary.js");
		const obs = makeObservation("aaaaaaaaaaaa", { relevance: "high" as const });
		const line = observationToSummaryLine(obs);
		expect(line).toContain("[aaaaaaaaaaaa]");
		expect(line).toContain("2026-01-01 12:00");
		expect(line).toContain("[high]");
		expect(line).toContain("TypeScript over JavaScript");
	});

	it("handles critical relevance", async () => {
		const { observationToSummaryLine } = await import("../src/om/ledger/render-summary.js");
		const obs = makeObservation("bbbbbbbbbbbb", { relevance: "critical" as const });
		const line = observationToSummaryLine(obs);
		expect(line).toContain("[critical]");
	});
});

describe("reflectionToSummaryLine", () => {
	it("formats a reflection line with id", async () => {
		const { reflectionToSummaryLine } = await import("../src/om/ledger/render-summary.js");
		const ref = makeReflection("ref00000000aa");
		const line = reflectionToSummaryLine(ref);
		expect(line).toContain("[ref00000000aa]");
		expect(line).toContain("strict mode");
	});
});

describe("renderSummary", () => {
	it("returns basic recall footer when both lists are empty", async () => {
		const { renderSummary } = await import("../src/om/ledger/render-summary.js");
		const result = renderSummary([], []);
		expect(result).toContain("Use `recall` with an id");
		expect(result).toContain("most recent entry");
		expect(result).not.toContain("## Reflections");
		expect(result).not.toContain("## Observations");
	});

	it("includes reflections section when reflections present", async () => {
		const { renderSummary } = await import("../src/om/ledger/render-summary.js");
		const ref = makeReflection("ref00000000aa");
		const result = renderSummary([ref], []);
		expect(result).toContain("## Reflections");
		expect(result).toContain("[ref00000000aa]");
		expect(result).not.toContain("## Observations");
	});

	it("includes observations section when observations present", async () => {
		const { renderSummary } = await import("../src/om/ledger/render-summary.js");
		const obs = makeObservation("obs00000000aa");
		const result = renderSummary([], [obs]);
		expect(result).toContain("## Observations");
		expect(result).toContain("[obs00000000aa]");
		expect(result).not.toContain("## Reflections");
	});

	it("includes both sections when both present", async () => {
		const { renderSummary } = await import("../src/om/ledger/render-summary.js");
		const ref = makeReflection("ref00000000aa");
		const obs = makeObservation("obs00000000aa");
		const result = renderSummary([ref], [obs]);
		expect(result).toContain("## Reflections");
		expect(result).toContain("## Observations");
		expect(result).toContain("Bracketed ids in reflections and observations");
	});

	it("includes full context instructions when observations/reflections present", async () => {
		const { renderSummary } = await import("../src/om/ledger/render-summary.js");
		const ref = makeReflection("ref00000000aa");
		const result = renderSummary([ref], []);
		expect(result).toContain("Bracketed ids in reflections and observations");
		expect(result).toContain("## Reflections");
		expect(result).toContain("most recent observation");
	});

	it("handles multiple reflections and observations in order", async () => {
		const { renderSummary } = await import("../src/om/ledger/render-summary.js");
		const ref1 = makeReflection("ref1111111111", { content: "First reflection" });
		const ref2 = makeReflection("ref2222222222", { content: "Second reflection" });
		const obs1 = makeObservation("obs1111111111", { content: "First observation" });
		const obs2 = makeObservation("obs2222222222", { content: "Second observation" });
		const result = renderSummary([ref1, ref2], [obs1, obs2]);

		const refSection = result.indexOf("## Reflections");
		const obsSection = result.indexOf("## Observations");
		expect(refSection).toBeGreaterThanOrEqual(0);
		expect(obsSection).toBeGreaterThan(refSection);

		expect(result.indexOf("First reflection")).toBeGreaterThan(refSection);
		expect(result.indexOf("Second reflection")).toBeGreaterThan(refSection);
		expect(result.indexOf("First observation")).toBeGreaterThan(obsSection);
		expect(result.indexOf("Second observation")).toBeGreaterThan(obsSection);
	});
});
