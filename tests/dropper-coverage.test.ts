/**
 * Dropper coverage tests — ported from upstream pi-observational-memory.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (tests/dropper-coverage.test.ts)
 * Ported with import paths adjusted: coverage functions are in coverage.ts, not agent.ts.
 */

import { describe, expect, it } from "vitest";

import {
	observationToDropperLine,
	reflectionCoverageMap,
	reflectionCoverageTierForCount,
	summarizeCoverageByRelevance,
	summarizeCoverageTransitionsByRelevance,
} from "../src/om/agents/dropper/coverage.js";
import { observation, reflection } from "./fixtures/session.js";

describe("V3 dropper reflection coverage helpers", () => {
	it("maps support counts to deterministic coverage tiers", () => {
		expect(reflectionCoverageTierForCount(0)).toBe("none");
		expect(reflectionCoverageTierForCount(1)).toBe("partial");
		expect(reflectionCoverageTierForCount(2)).toBe("strong");
		expect(reflectionCoverageTierForCount(10)).toBe("strong");
	});

	it("computes none, partial, and strong coverage from reflection support ids", () => {
		const none = observation("aaaaaaaaaaaa");
		const partial = observation("bbbbbbbbbbbb");
		const strong = observation("cccccccccccc");
		const coverage = reflectionCoverageMap([none, partial, strong], [
			reflection("rrrrrrrrrrr1", ["bbbbbbbbbbbb", "cccccccccccc"]),
			reflection("rrrrrrrrrrr2", ["cccccccccccc", "cccccccccccc"]),
		]);

		expect(coverage.get("aaaaaaaaaaaa")).toBe("none");
		expect(coverage.get("bbbbbbbbbbbb")).toBe("partial");
		expect(coverage.get("cccccccccccc")).toBe("strong");
	});

	it("summarizes coverage counts and token totals by relevance", () => {
		const observations = [
			observation("aaaaaaaaaaaa", { relevance: "low", tokenCount: 3 }),
			observation("bbbbbbbbbbbb", { relevance: "critical", tokenCount: 5 }),
			observation("cccccccccccc", { relevance: "critical", tokenCount: 7 }),
		];
		const coverage = reflectionCoverageMap(observations, [
			reflection("rrrrrrrrrrr1", ["bbbbbbbbbbbb", "cccccccccccc"]),
			reflection("rrrrrrrrrrr2", ["cccccccccccc"]),
		]);

		expect(summarizeCoverageByRelevance(observations, coverage)).toMatchObject({
			low: { none: { count: 1, tokens: 3 } },
			critical: {
				partial: { count: 1, tokens: 5 },
				strong: { count: 1, tokens: 7 },
			},
		});
	});

	it("summarizes coverage transitions by relevance without exposing ids", () => {
		const observations = [
			observation("aaaaaaaaaaaa", { relevance: "high", tokenCount: 3 }),
			observation("bbbbbbbbbbbb", { relevance: "critical", tokenCount: 5 }),
			observation("cccccccccccc", { relevance: "critical", tokenCount: 7 }),
		];
		const before = reflectionCoverageMap(observations, [
			reflection("rrrrrrrrrrr1", ["bbbbbbbbbbbb"]),
		]);
		const after = reflectionCoverageMap(observations, [
			reflection("rrrrrrrrrrr1", ["bbbbbbbbbbbb"]),
			reflection("rrrrrrrrrrr2", ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"]),
			reflection("rrrrrrrrrrr3", ["cccccccccccc"]),
		]);

		expect(summarizeCoverageTransitionsByRelevance(observations, before, after)).toEqual({
			low: {},
			medium: {},
			high: { "none->partial": { count: 1, tokens: 3 } },
			critical: {
				"partial->strong": { count: 1, tokens: 5 },
				"none->strong": { count: 1, tokens: 7 },
			},
		});
	});

	it("renders model-facing observation lines with coverage evidence only", () => {
		const line = observationToDropperLine(
			observation("aaaaaaaaaaaa", { relevance: "critical", content: "Important fact" }),
			"strong",
		);

		expect(line).toContain("[aaaaaaaaaaaa]");
		expect(line).toContain("[critical]");
		expect(line).toContain("[coverage: strong]");
		expect(line).toContain("Important fact");
		expect(line).not.toContain("drop-priority");
		expect(line).not.toContain("drop-resistance");
	});
});
