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
    const obs = makeObservation("bbbbbbbbbbbb", {
      relevance: "critical" as const,
    });
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

describe("selectPriorObservations", () => {
  const bigHigh = (id: string): Observation =>
    makeObservation(id, {
      content: "x".repeat(8000),
      relevance: "high" as const,
    });

  it("keeps all high observations and fills the rest when high fits the budget", async () => {
    const { selectPriorObservations } = await import("../src/om/ledger/render-summary.js");
    const obs = [bigHigh("high00000001"), bigHigh("high00000002")];
    const selected = selectPriorObservations(obs, 20_000);
    expect(selected.map((o) => o.id)).toEqual(["high00000001", "high00000002"]);
  });

  it("trims high observations newest-first when they alone exceed the budget (#69)", async () => {
    const { selectPriorObservations } = await import("../src/om/ledger/render-summary.js");
    const obs = [bigHigh("high00000001"), bigHigh("high00000002"), bigHigh("high00000003")];
    // Each line renders to ~2010 tokens; budget 5000 fits the newest two.
    const selected = selectPriorObservations(obs, 5_000);
    expect(selected.map((o) => o.id)).toEqual(["high00000002", "high00000003"]);
  });

  it("never renders more than the budget when every observation is critical (#69)", async () => {
    const { selectPriorObservations, observationToSummaryLine } =
      await import("../src/om/ledger/render-summary.js");
    const obs = [bigHigh("high00000001"), bigHigh("high00000002"), bigHigh("high00000003")];
    const selected = selectPriorObservations(obs, 5_000);
    const rendered = selected.reduce(
      (total, o) => total + Math.ceil(observationToSummaryLine(o).length / 4),
      0,
    );
    expect(rendered).toBeLessThanOrEqual(5_000);
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
    const ref1 = makeReflection("ref1111111111", {
      content: "First reflection",
    });
    const ref2 = makeReflection("ref2222222222", {
      content: "Second reflection",
    });
    const obs1 = makeObservation("obs1111111111", {
      content: "First observation",
    });
    const obs2 = makeObservation("obs2222222222", {
      content: "Second observation",
    });
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

describe("reflection output budget", () => {
  it("keeps newest whole records that fit, skipping oversized records", async () => {
    const { selectPriorReflections, reflectionToSummaryLine } =
      await import("../src/om/ledger/render-summary.js");
    const { estimateStringTokens } = await import("../src/om/tokens.js");
    const refs = ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd"].map((id) =>
      makeReflection(id, { content: "x", tokenCount: 0 }),
    );
    refs[3].content = "x".repeat(1000);
    const budget = estimateStringTokens(refs.slice(1, 3).map(reflectionToSummaryLine).join("\n"));
    const selected = selectPriorReflections(refs, budget);
    expect(selected).toEqual(refs.slice(1, 3));
    expect(
      estimateStringTokens(selected.map(reflectionToSummaryLine).join("\n")),
    ).toBeLessThanOrEqual(budget);
    expect(refs).toHaveLength(4);
  });
});

describe("reflection annotations", () => {
  it.each([
    [
      true,
      true,
      "2026-10-03 14:20",
      "[bbbbbbbbbbbb] 2026-10-03 14:20 tests pass (supersedes aaaaaaaaaaaa)",
    ],
    [true, false, "2026-10-03 14:20", "[bbbbbbbbbbbb] 2026-10-03 14:20 tests pass"],
    [false, true, "2026-10-03 14:20", "[bbbbbbbbbbbb] tests pass (supersedes aaaaaaaaaaaa)"],
    [false, false, "2026-10-03 14:20", "[bbbbbbbbbbbb] tests pass"],
    [true, false, undefined, "[bbbbbbbbbbbb] tests pass"],
    [true, false, "2026-02-29 12:00", "[bbbbbbbbbbbb] tests pass"],
  ])(
    "renders timestamps=%s supersedes=%s time=%s",
    async (timestamps, supersedes, timestamp, expected) => {
      const { makeReflectionRenderer } = await import("../src/om/ledger/index.js");
      expect(
        makeReflectionRenderer({ timestamps, supersedes })(
          makeReflection("bbbbbbbbbbbb", {
            content: "tests pass",
            timestamp,
            supersedes: ["aaaaaaaaaaaa"],
          }),
        ),
      ).toBe(expected);
    },
  );
  it.each([true, false])("footer annotations enabled=%s", async (enabled) => {
    const { renderSummary } = await import("../src/om/ledger/index.js");
    const text = renderSummary([makeReflection("aaaaaaaaaaaa")], [], {
      timestamps: enabled,
      supersedes: enabled,
    });
    expect({
      timestamp: text.includes(
        "When entries conflict, the entry with the latest timestamp reflects the latest known state.",
      ),
      supersedes: text.includes(
        "Supersedes notes identify earlier reflections replaced by this entry; replaced reflections are retired from this summary.",
      ),
      legacy: text.includes(
        "When entries conflict, the most recent observation reflects the latest known state.",
      ),
    }).toEqual({ timestamp: enabled, supersedes: enabled, legacy: !enabled });
  });
  it("strips both-on OM without changing markers", async () => {
    const { renderSummary } = await import("../src/om/ledger/index.js");
    const { stripOMContent } = await import("../src/core/summarize.js");
    const text = renderSummary(
      [
        makeReflection("aaaaaaaaaaaa", {
          content: "C",
          timestamp: "2026-10-03 14:05",
          supersedes: ["bbbbbbbbbbbb"],
        }),
      ],
      [],
      { timestamps: true, supersedes: true },
    );
    const stripped = stripOMContent(`before\n\n${text}`);
    expect(stripped).toBe("before");
  });
  it("charges CJK reflection lines with the CJK-aware estimator", async () => {
    const { selectExistingReflections } = await import("../src/om/ledger/index.js");
    const first = makeReflection("aaaaaaaaaaaa", { content: "C" });
    const second = makeReflection("bbbbbbbbbbbb", { content: "漢".repeat(40) });
    // Flat chars/4 would price the second line near 14 tokens and keep it;
    // estimateStringTokens prices each CJK char near one token, so the line
    // exceeds the remaining budget and is cut.
    expect(selectExistingReflections([first, second], 20)).toEqual([first]);
  });
});
