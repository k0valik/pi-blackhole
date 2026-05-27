/**
 * Dropper agent tests — ported from upstream pi-observational-memory.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (tests/dropper.test.ts)
 * Ported with adaptations for pi-blackhole:
 *   - budgetTokens instead of targetTokens
 *   - Import paths adjusted for om/ layout
 *   - Assertion strings adapted to our display format (still has DropUrgency)
 */

import { describe, expect, it } from "vitest";

import {
	maxDropCountForPool,
	normalizeDropObservationIds,
	observationPoolFullness,
	runDropper,
	selectDropCandidates,
} from "../src/om/agents/dropper/agent.js";
import { observation, reflection } from "./fixtures/session.js";

function fakeAgentLoop(handler: (prompts: any[], context: any, config: any) => Promise<void> | void): any {
	return ((prompts: any[], context: any, config: any) => ({
		async *[Symbol.asyncIterator]() {},
		result: async () => {
			await handler(prompts, context, config);
			return {};
		},
	})) as any;
}

describe("V3 dropper agent", () => {
	const obsA = observation("aaaaaaaaaaaa", { relevance: "medium" });
	const obsB = observation("bbbbbbbbbbbb", { relevance: "low" });
	const critical = observation("cccccccccccc", { relevance: "critical" });
	const baseArgs = {
		model: {} as any,
		apiKey: "test",
		reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
		observations: [obsA, obsB, critical],
		budgetTokens: 20,
	};

	it("computes observation pool fullness defensively", () => {
		expect(observationPoolFullness(0, 100)).toBe(0);
		expect(observationPoolFullness(-1, 100)).toBe(0);
		expect(observationPoolFullness(10, 0)).toBe(0);
		expect(observationPoolFullness(10, Number.NaN)).toBe(0);
		expect(observationPoolFullness(25, 100)).toBe(0.25);
	});

	it("computes max drops from token excess above budget", () => {
		const observations = Array.from({ length: 10 }, (_, index) =>
			observation(`${index}`.padStart(12, "a"), { relevance: "low", tokenCount: 10 }),
		);

		expect(maxDropCountForPool(observations, 100, 100)).toBe(0);
		expect(maxDropCountForPool(observations, 100, 90)).toBe(1);
		expect(maxDropCountForPool(observations, 100, 50)).toBe(5);
		expect(maxDropCountForPool(observations, 100, 0)).toBe(10);
	});

	it("uses active observation count for budget-return max drops while critical ids remain eligible later", () => {
		const observations = [
			observation("aaaaaaaaaaaa", { relevance: "low", tokenCount: 10 }),
			observation("bbbbbbbbbbbb", { relevance: "medium", tokenCount: 10 }),
			observation("cccccccccccc", { relevance: "critical", tokenCount: 10 }),
			observation("dddddddddddd", { relevance: "critical", tokenCount: 10 }),
		];

		expect(maxDropCountForPool(observations, 40, 20)).toBe(2);
	});

	it("keeps core dropper safety guidance in V3 terms", async () => {
		let systemPrompt = "";
		const loop = fakeAgentLoop((_prompts, context) => {
			systemPrompt = context.systemPrompt;
		});

		await runDropper({ ...baseArgs, agentLoop: loop });

		expect(systemPrompt).toContain("Active-memory framing");
		expect(systemPrompt).toContain("Age-gradient rule");
		expect(systemPrompt).toContain("critical");
		expect(systemPrompt).toContain("highest importance and strongest resistance");
		expect(systemPrompt).toContain("Relevance is importance/resistance, not an absolute keep/drop lock");
		expect(systemPrompt).toContain("Coverage is evidence, not an automatic decision");
		expect(systemPrompt).toContain("age alone is not enough");
		expect(systemPrompt).not.toContain("NEVER drop");
		expect(systemPrompt).toContain("Preservation floor");
		expect(systemPrompt).toContain("Do not force drops");
		expect(systemPrompt).toContain("You cannot merge observations");
		expect(systemPrompt).toContain("Default action is KEEP");
		expect(systemPrompt).toContain("When uncertain, keep");
		expect(systemPrompt).toContain("active observation pool target");
		expect(systemPrompt).not.toContain("drop freely");
		expect(systemPrompt).not.toContain("pruner");
		expect(systemPrompt).not.toContain("drop-priority");
		expect(systemPrompt).not.toContain("drop-resistance");
		expect(systemPrompt).not.toContain("Pass strategy");
		expect(systemPrompt).not.toContain("Urgency guidance");
	});

	it("passes budget-return max drops as a hard upper bound", async () => {
		let userText = "";
		const loop = fakeAgentLoop((prompts) => {
			userText = prompts[0].content[0].text;
		});

		await runDropper({ ...baseArgs, agentLoop: loop });

		// pi-blackhole display format: "fullness: ~X%" (no "against target")
		expect(userText).toContain("[coverage: partial]");
		expect(userText).toContain("[coverage: none]");
		expect(userText).toContain("Maximum drops allowed this run:");
		expect(userText).toContain("hard upper bound, not a target");
		expect(userText).toContain("Drop fewer or none");
		// pi-blackhole still uses DropUrgency
		expect(userText).toContain("Drop urgency");
		// pi-blackhole doesn't display "over target by ~X tokens" or "sized to move..."
		expect(userText).not.toContain("drop-priority");
		expect(userText).not.toContain("drop-resistance");
	});

	it("normalizes active drop ids, filters invalid ids, dedupes, and accepts critical observations", () => {
		expect(normalizeDropObservationIds(["bbbbbbbbbbbb", "missing", "bbbbbbbbbbbb", "cccccccccccc", "aaaaaaaaaaaa"], [obsA, obsB, critical])).toEqual(["bbbbbbbbbbbb", "cccccccccccc", "aaaaaaaaaaaa"]);
		expect(normalizeDropObservationIds(["missing", "cccccccccccc"], [obsA, obsB, critical])).toEqual(["cccccccccccc"]);
		expect(normalizeDropObservationIds(["missing"], [obsA, obsB, critical])).toBeUndefined();
	});

	it("selects final candidates by coverage, lower relevance, age, then stable ordering", () => {
		const highA = observation("aaaaaaaaaaaa", { relevance: "high" });
		const lowA = observation("bbbbbbbbbbbb", { relevance: "low" });
		const medium = observation("dddddddddddd", { relevance: "medium" });
		const lowB = observation("eeeeeeeeeeee", { relevance: "low" });
		const highB = observation("ffffffffffff", { relevance: "high" });
		const critical = observation("111111111111", { relevance: "critical" });
		const observations = [highA, lowA, medium, lowB, highB, critical];

		expect(selectDropCandidates([
			"aaaaaaaaaaaa",
			"missing",
			"111111111111",
			"bbbbbbbbbbbb",
			"dddddddddddd",
			"bbbbbbbbbbbb",
			"eeeeeeeeeeee",
			"ffffffffffff",
		], observations, 3)).toEqual(["bbbbbbbbbbbb", "eeeeeeeeeeee", "dddddddddddd"]);

		const oldHigh = observation("999999999999", { relevance: "high", timestamp: "2026-01-01T00:00:00.000Z" });
		const newHigh = observation("888888888888", { relevance: "high", timestamp: "2026-02-01T00:00:00.000Z" });
		expect(selectDropCandidates(["888888888888", "999999999999"], [oldHigh, newHigh], 1)).toEqual(["999999999999"]);
	});

	it("prefers stronger reflection coverage before relevance when over cap", () => {
		const strongCritical = observation("aaaaaaaaaaaa", { relevance: "critical", timestamp: "2026-01-01T00:00:00.000Z" });
		const partialLow = observation("bbbbbbbbbbbb", { relevance: "low", timestamp: "2026-01-01T00:00:00.000Z" });
		const noneLow = observation("cccccccccccc", { relevance: "low", timestamp: "2026-01-01T00:00:00.000Z" });
		const observations = [strongCritical, partialLow, noneLow];
		const reflections = [
			reflection("rrrrrrrrrrr1", ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]),
			reflection("rrrrrrrrrrr2", ["aaaaaaaaaaaa"]),
		];

		expect(selectDropCandidates(["cccccccccccc", "bbbbbbbbbbbb", "aaaaaaaaaaaa"], observations, 2, reflections)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
	});

	it("keeps critical lower priority than lower relevance when coverage is equal", () => {
		const critical = observation("aaaaaaaaaaaa", { relevance: "critical", timestamp: "2026-01-01T00:00:00.000Z" });
		const high = observation("bbbbbbbbbbbb", { relevance: "high", timestamp: "2026-01-01T00:00:00.000Z" });
		const low = observation("cccccccccccc", { relevance: "low", timestamp: "2026-01-01T00:00:00.000Z" });
		const observations = [critical, high, low];
		const reflections = [reflection("rrrrrrrrrrr1", ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"]), reflection("rrrrrrrrrrr2", ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"])];

		expect(selectDropCandidates(["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"], observations, 2, reflections)).toEqual(["cccccccccccc", "bbbbbbbbbbbb"]);
	});

	it("returns capped coverage-preferred proposed observation ids", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", { ids: ["aaaaaaaaaaaa", "missing", "bbbbbbbbbbbb"] });
		});

		await expect(runDropper({ ...baseArgs, agentLoop: loop })).resolves.toEqual(["aaaaaaaaaaaa"]);
	});

	it("returns critical proposed ids when they are the selected valid candidates", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", { ids: ["missing", "cccccccccccc"] });
		});

		await expect(runDropper({ ...baseArgs, agentLoop: loop })).resolves.toEqual(["cccccccccccc"]);
	});

	it("returns undefined when only invalid ids are proposed", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", { ids: ["missing"] });
		});

		await expect(runDropper({ ...baseArgs, agentLoop: loop })).resolves.toBeUndefined();
	});

	it("dedupes repeated tool calls and enforces one run-level cap", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", { ids: ["aaaaaaaaaaaa"] });
			await context.tools[0].execute("tool-2", { ids: ["bbbbbbbbbbbb", "aaaaaaaaaaaa"] });
		});

		await expect(runDropper({ ...baseArgs, agentLoop: loop })).resolves.toEqual(["aaaaaaaaaaaa"]);
	});

	it("returns undefined when no tool call drops observations", async () => {
		const loop = fakeAgentLoop(() => {});
		await expect(runDropper({ ...baseArgs, agentLoop: loop })).resolves.toBeUndefined();
	});

	it("skips the model at or below the budget", async () => {
		let called = false;
		const loop = fakeAgentLoop(() => {
			called = true;
		});

		await expect(runDropper({
			...baseArgs,
			observations: [observation("aaaaaaaaaaaa", { relevance: "low", tokenCount: 10 })],
			budgetTokens: 10,
			agentLoop: loop,
		})).resolves.toBeUndefined();
		expect(called).toBe(false);
	});
});
