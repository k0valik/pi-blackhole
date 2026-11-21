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

// ── #208: support-relevance tiering in the bounded reflection pool ─────────

function poolLineTokens(
  mod: typeof import("../src/om/ledger/render-summary.js"),
  tokens: typeof import("../src/om/tokens.js"),
  reflections: Reflection[],
): number {
  return tokens.estimateStringTokens(reflections.map(mod.reflectionToSummaryLine).join("\n"));
}

describe("selectReflectionPool — support-relevance tiering", () => {
  const criticalObs = "dddddddddddd";
  const highObs = "eeeeeeeeeeee";
  const medObs = "cccccccccccc";

  /** Ordinary reflection: cites only the medium-relevance observation. */
  function ord(id: string, content: string): Reflection {
    return makeReflection(id, { content, supportingObservationIds: [medObs] });
  }
  /** Priority reflection: cites a critical- or high-relevance observation. */
  function prio(id: string, content: string, support: string = criticalObs): Reflection {
    return makeReflection(id, { content, supportingObservationIds: [support] });
  }

  it("keeps an old critical-supported reflection when newer ordinary reflections overflow the pool", async () => {
    const mod = await import("../src/om/ledger/render-summary.js");
    const tokens = await import("../src/om/tokens.js");
    const restriction = prio("res000000001", "User restriction: never publish the test draft");
    const ordinary = ["ord00000000a", "ord00000000b", "ord00000000c", "ord00000000d"].map((id, i) =>
      ord(id, `ordinary note ${i}`),
    );
    const support = new Map([[criticalObs, "critical" as const]]);
    // Pool fits the restriction twice (so it passes the half-pool reserve)
    // plus one ordinary line: three of four ordinary lines still fit.
    const budget = poolLineTokens(mod, tokens, [restriction, restriction, ordinary[0]!]);
    const result = mod.selectReflectionPool([restriction, ...ordinary], budget, support);
    expect(result.selected.map((r) => r.id)).toContain("res000000001");
    expect(result.selected.map((r) => r.id)).not.toContain("ord00000000a");
    expect(result.selected).toHaveLength(4);
    expect(result.overflow).toEqual([]);
  });

  it("bounds the priority allocation to half the pool so ordinary reflections keep room", async () => {
    const mod = await import("../src/om/ledger/render-summary.js");
    const tokens = await import("../src/om/tokens.js");
    // Pool fits five ordinary lines (36 tokens); the reserve (18) fits two
    // priority lines, the third would need 22.
    const ordinary = Array.from({ length: 10 }, (_, i) => ord(`ord00000000${i}`, "ordinary note"));
    const priority = Array.from({ length: 10 }, (_, i) => prio(`prio0000000${i}`, "priority note"));
    const budget = poolLineTokens(mod, tokens, ordinary.slice(0, 5));
    const support = new Map([[criticalObs, "critical" as const]]);
    const result = mod.selectReflectionPool([...priority, ...ordinary], budget, support);
    const selectedIds = result.selected.map((r) => r.id);
    expect(selectedIds.filter((id) => id.startsWith("prio"))).toHaveLength(2);
    expect(selectedIds.filter((id) => id.startsWith("ord"))).toHaveLength(3);
    expect(result.overflow).toHaveLength(8);
  });

  it("spills leftover budget back to priority reflections when ordinary does not fill it", async () => {
    const mod = await import("../src/om/ledger/render-summary.js");
    const tokens = await import("../src/om/tokens.js");
    const ordinary = [ord("ord00000000a", "ordinary note")];
    const priority = Array.from({ length: 10 }, (_, i) => prio(`prio0000000${i}`, "priority note"));
    // Pool fits one ordinary plus three priority lines; the reserve fits
    // only one, so two priority reflections must come from the spill pass.
    const budget =
      poolLineTokens(mod, tokens, ordinary) + poolLineTokens(mod, tokens, priority.slice(0, 3));
    const support = new Map([[criticalObs, "critical" as const]]);
    const result = mod.selectReflectionPool([...priority, ...ordinary], budget, support);
    const selectedIds = result.selected.map((r) => r.id);
    expect(selectedIds.filter((id) => id.startsWith("prio"))).toHaveLength(3);
    expect(selectedIds).toContain("ord00000000a");
    expect(result.overflow).toHaveLength(7);
  });

  it("ranks critical support before high support within the priority allocation", async () => {
    const mod = await import("../src/om/ledger/render-summary.js");
    const tokens = await import("../src/om/tokens.js");
    const criticalRef = prio("cri000000001", "critical-supported note", criticalObs);
    const highRef = prio("hig000000001", "high-supported note", highObs);
    const support = new Map([
      [criticalObs, "critical" as const],
      [highObs, "high" as const],
    ]);
    // Pool fits the critical line plus two ordinary lines; the reserve
    // (half) fits only the critical line, so the high line must lose.
    const ordinary = Array.from({ length: 4 }, (_, i) => ord(`ord00000000${i}`, "ordinary note"));
    const budget = poolLineTokens(mod, tokens, [criticalRef, ordinary[0]!, ordinary[1]!]);
    const result = mod.selectReflectionPool([criticalRef, highRef, ...ordinary], budget, support);
    const selectedIds = result.selected.map((r) => r.id);
    expect(selectedIds).toContain("cri000000001");
    expect(selectedIds).not.toContain("hig000000001");
    expect(result.overflow.map((r) => r.id)).toContain("hig000000001");
  });

  it("keeps multiple same-tier priority reflections and restores source order", async () => {
    const mod = await import("../src/om/ledger/render-summary.js");
    const tokens = await import("../src/om/tokens.js");
    const restriction = prio("res000000001", "User restriction: never publish the test draft");
    const between = ord("ord00000000a", "ordinary note");
    const second = prio("res000000002", "User restriction: never publish the test draft either");
    const support = new Map([[criticalObs, "critical" as const]]);
    const budget = poolLineTokens(mod, tokens, [restriction, between, second]);
    const result = mod.selectReflectionPool([restriction, between, second], budget, support);
    expect(result.selected.map((r) => r.id)).toEqual([
      "res000000001",
      "ord00000000a",
      "res000000002",
    ]);
    expect(result.overflow).toEqual([]);
  });

  it("treats a reflection with no live support as ordinary", async () => {
    const mod = await import("../src/om/ledger/render-summary.js");
    const tokens = await import("../src/om/tokens.js");
    // The supporting observation is absent from the lookup (superseded,
    // dropped, or out of boundary). A buggy promotion would place the stale
    // reflection into the reserve ahead of ordinary reflections; correct
    // behavior evicts it under the same pressure that evicts old ordinary
    // reflections, and never reports it as overflow.
    const stale = prio("sta000000001", "stale restriction note", "fff000000001");
    const ordinary = Array.from({ length: 4 }, (_, i) => ord(`ord00000000${i}`, "ordinary note"));
    const budget = poolLineTokens(mod, tokens, [stale, stale, ordinary[0]!]);
    const result = mod.selectReflectionPool([stale, ...ordinary], budget, new Map());
    expect(result.selected.map((r) => r.id)).not.toContain("sta000000001");
    expect(result.overflow).toEqual([]);
  });

  it("reports never-fitting priority reflections as overflow, keeping records whole", async () => {
    const mod = await import("../src/om/ledger/render-summary.js");
    const tokens = await import("../src/om/tokens.js");
    const fat = prio("fat000000001", `fat priority note ${"x".repeat(400)}`);
    const ordinary = ord("ord00000000a", "ordinary note");
    const support = new Map([[criticalObs, "critical" as const]]);
    // The whole pool is smaller than the fat line alone.
    const budget = poolLineTokens(mod, tokens, [ordinary]);
    const result = mod.selectReflectionPool([fat, ordinary], budget, support);
    expect(result.selected.map((r) => r.id)).toEqual(["ord00000000a"]);
    expect(result.overflow.map((r) => r.id)).toEqual(["fat000000001"]);
    expect(result.overflow[0]!.content).toContain("x".repeat(400));
  });

  it("matches selectPriorReflections when no reflection has live support", async () => {
    const mod = await import("../src/om/ledger/render-summary.js");
    const tokens = await import("../src/om/tokens.js");
    const refs = ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd"].map((id, i) =>
      makeReflection(id, { content: `note ${i}`, tokenCount: 0 }),
    );
    const budget = poolLineTokens(mod, tokens, refs.slice(1, 3));
    const legacy = mod.selectPriorReflections(refs, budget);
    const tiered = mod.selectReflectionPool(refs, budget, new Map());
    expect(tiered.selected).toEqual(legacy);
    expect(tiered.overflow).toEqual([]);
  });
});

describe("priorityOverflowNote", () => {
  it("returns undefined when nothing overflowed", async () => {
    const { priorityOverflowNote } = await import("../src/om/ledger/render-summary.js");
    expect(priorityOverflowNote([])).toBeUndefined();
  });

  it("lists bracketed ids and count when priority reflections did not fit", async () => {
    const { priorityOverflowNote } = await import("../src/om/ledger/render-summary.js");
    const overflow = [makeReflection("aaa000000001"), makeReflection("bbb000000002")];
    const note = priorityOverflowNote(overflow);
    expect(note).toBeDefined();
    expect(note).toContain("2");
    expect(note).toContain("[aaa000000001]");
    expect(note).toContain("[bbb000000002]");
  });
});

describe("selectReflectionPool — reflection relevance marker (#208)", () => {
  const medObs = "cccccccccccc";

  function ord(id: string, content: string): Reflection {
    return makeReflection(id, { content, supportingObservationIds: [medObs] });
  }

  it("promotes a marker-critical reflection whose supporting observation is no longer live", async () => {
    const mod = await import("../src/om/ledger/render-summary.js");
    const tokens = await import("../src/om/tokens.js");
    // The dropper prunes observations whose meaning a reflection preserves, so
    // the marker must stand on its own once support has left the active pool.
    const marked = makeReflection("mrk000000001", {
      content: "User restriction: never publish the test draft",
      relevance: "critical" as const,
      supportingObservationIds: ["fff000000001"],
    });
    const ordinary = Array.from({ length: 4 }, (_, i) => ord(`ord00000000${i}`, "ordinary note"));
    const budget = poolLineTokens(mod, tokens, [marked, marked, ordinary[0]!]);
    const result = mod.selectReflectionPool([marked, ...ordinary], budget, new Map());
    expect(result.selected.map((r) => r.id)).toContain("mrk000000001");
    expect(result.selected.map((r) => r.id)).not.toContain("ord00000000a");
    expect(result.selected).toHaveLength(4);
    expect(result.overflow).toEqual([]);
  });

  it("treats a marker-downgraded reflection as ordinary even with live critical support", async () => {
    const mod = await import("../src/om/ledger/render-summary.js");
    const tokens = await import("../src/om/tokens.js");
    // The marker is authoritative: a model that downgraded the reflection
    // must not be overridden by the supporting observation's relevance.
    const downgraded = makeReflection("dwn000000001", {
      content: "marker-downgraded note",
      relevance: "low" as const,
      supportingObservationIds: ["dddddddddddd"],
    });
    const ordinary = Array.from({ length: 4 }, (_, i) => ord(`ord00000000${i}`, "ordinary note"));
    const support = new Map([["dddddddddddd", "critical" as const]]);
    const budget = poolLineTokens(mod, tokens, [downgraded, downgraded, ordinary[0]!]);
    const result = mod.selectReflectionPool([downgraded, ...ordinary], budget, support);
    expect(result.selected.map((r) => r.id)).not.toContain("dwn000000001");
    expect(result.overflow).toEqual([]);
  });

  it("ranks marker-critical above marker-high", async () => {
    const mod = await import("../src/om/ledger/render-summary.js");
    const tokens = await import("../src/om/tokens.js");
    const criticalRef = makeReflection("cri000000001", {
      content: "critical-marked note",
      relevance: "critical" as const,
      supportingObservationIds: ["cccccccccccc"],
    });
    const highRef = makeReflection("hig000000001", {
      content: "high-marked note",
      relevance: "high" as const,
      supportingObservationIds: ["cccccccccccc"],
    });
    const ordinary = Array.from({ length: 4 }, (_, i) => ord(`ord00000000${i}`, "ordinary note"));
    // Pool fits the critical line plus two ordinary lines; the reserve
    // (half) fits only the critical line, so the high line must lose.
    const budget = poolLineTokens(mod, tokens, [criticalRef, ordinary[0]!, ordinary[1]!]);
    const result = mod.selectReflectionPool([criticalRef, highRef, ...ordinary], budget, new Map());
    const selectedIds = result.selected.map((r) => r.id);
    expect(selectedIds).toContain("cri000000001");
    expect(selectedIds).not.toContain("hig000000001");
    expect(result.overflow.map((r) => r.id)).toContain("hig000000001");
  });
});
