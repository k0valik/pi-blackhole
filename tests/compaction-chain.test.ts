import { describe, expect, it } from "vitest";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import {
  buildAppendOnlyDetails,
  collectActiveSegments,
  coverageForMessages,
  decideChainRebase,
  type ChainProjection,
  projectAppendOnlyContext,
} from "../src/core/compaction-chain.js";
import { isPiVccCompactionDetailsV2 } from "../src/details.js";

const compactionEntry = (id: string, summary: string, details: unknown, timestamp: number) => ({
  id,
  type: "compaction",
  summary,
  details,
  tokensBefore: 1000,
  firstKeptEntryId: "tail",
  timestamp,
});

const coverage = (first: string, last: string, firstKeptEntryId: string, count: number) => ({
  firstCoveredEntryId: first,
  lastCoveredEntryId: last,
  firstKeptEntryId,
  sourceMessageCount: count,
});

const build = (overrides: Record<string, unknown> = {}) =>
  buildAppendOnlyDetails({
    branchEntries: [],
    manualRebase: false,
    freshSummary: "[Goal]\nnew segment",
    aggregateSummary: "[Goal]\ncomplete state",
    trailingSummary: "recall\n\ncurrent OM",
    currentCoverage: coverage("m1", "m2", "m3", 2),
    tokensBefore: 1000,
    sections: ["Goal"],
    previousSummaryUsed: false,
    ...overrides,
  }).details;

describe("append compaction chain", () => {
  it("maps selected entry ids to real session entry ids without object identity", () => {
    const m1 = { role: "user", content: "a" };
    const m2 = { role: "assistant", content: "b" };
    const branch = [
      { id: "m1", type: "message", message: structuredClone(m1) },
      { id: "m2", type: "message", message: structuredClone(m2) },
      { id: "m3", type: "message", message: { role: "user", content: "tail" } },
    ];

    expect(coverageForMessages(branch, ["m1", "m2"], "m3")).toEqual({
      firstCoveredEntryId: "m1",
      lastCoveredEntryId: "m2",
      firstKeptEntryId: "m3",
      sourceMessageCount: 2,
    });
  });

  it("rejects coverage when a selected id is missing from the branch", () => {
    const branch = [
      { id: "m1", type: "message", message: { role: "user", content: "a" } },
      { id: "m3", type: "message", message: { role: "user", content: "tail" } },
    ];
    expect(coverageForMessages(branch, ["m1", "missing"], "m3")).toBeUndefined();
    expect(coverageForMessages(branch, [], "m3")).toBeUndefined();
  });

  it("rejects coverage when selected ids contain duplicates", () => {
    const branch = [
      { id: "m1", type: "message", message: { role: "user", content: "a" } },
      { id: "m2", type: "message", message: { role: "user", content: "b" } },
      { id: "m3", type: "message", message: { role: "user", content: "tail" } },
    ];
    expect(coverageForMessages(branch, ["m1", "m1"], "m3")).toBeUndefined();
  });

  it("creates a chain start for the first append compaction", () => {
    const details = build();
    expect(details.chainStart).toBe(true);
    expect(details.segment.sequence).toBe(1);
    expect(details.segment.summary).toContain("Append Segment 1");
    expect(details.segment.summary).toContain("[Goal]\ncomplete state");
    expect(details.trailingSummary).toBe("recall\n\ncurrent OM");
    expect(isPiVccCompactionDetailsV2(details)).toBe(true);
  });

  it("appends without changing the earlier provider-visible segment", () => {
    const first = build();
    const c1 = compactionEntry("c1", "fallback 1", first, 10);
    const oldBytes = first.segment.summary;

    const second = build({
      branchEntries: [c1],
      freshSummary: "[Goal]\nsecond delta",
      aggregateSummary: "[Goal]\ncomplete second state",
      currentCoverage: coverage("m3", "m4", "m5", 2),
      previousSummaryUsed: true,
    });
    const c2 = compactionEntry("c2", "fallback 2", second, 20);
    const chain = collectActiveSegments([c1, c2]);

    expect(second.chainStart).toBe(false);
    expect(second.segment.sequence).toBe(2);
    expect(chain.ok).toBe(true);
    if (!chain.ok) return;
    expect(chain.segments.map((item) => item.segment.summary)).toEqual([
      oldBytes,
      second.segment.summary,
    ]);
  });

  it("projects immutable messages in oldest-to-newest order", () => {
    const first = build();
    const c1 = compactionEntry("c1", "fallback 1", first, 10);
    const second = build({
      branchEntries: [c1],
      freshSummary: "[Goal]\nsecond delta",
      aggregateSummary: "[Goal]\ncomplete second state",
      trailingSummary: "recall 2\n\nOM 2",
      currentCoverage: coverage("m3", "m4", "tail", 2),
      previousSummaryUsed: true,
    });
    const c2 = compactionEntry("c2", "fallback 2", second, 20);
    const rawTail = { role: "user", content: "tail", timestamp: 30 };
    const input = [
      {
        role: "compactionSummary",
        summary: "fallback 2",
        tokensBefore: 2000,
        timestamp: 20,
      },
      rawTail,
    ];

    const output = projectAppendOnlyContext(input, [c1, c2]);
    expect(output).not.toBe(input);
    expect(output.slice(0, 2).map((m: any) => [m.role, m.summary])).toEqual([
      ["compactionSummary", first.segment.summary],
      ["compactionSummary", second.segment.summary],
    ]);
    expect((output[2] as any).role).toBe("custom");
    expect((output[2] as any).content).toBe("recall 2\n\nOM 2");
    expect(output[3]).toBe(rawTail);
  });

  it("keeps the exact provider request prefix stable across three compactions", () => {
    const stableSystem = { type: "system", content: "stable system prompt" };
    const stableTools = {
      type: "tools",
      tools: [{ name: "read", description: "Read one file" }],
    };
    const frame = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    const providerPrefix = (messages: unknown[], segmentCount: number): Buffer =>
      Buffer.concat([
        frame(stableSystem),
        frame(stableTools),
        ...messages.slice(0, segmentCount).map(frame),
      ]);
    const providerRequest = (messages: unknown[]): Buffer =>
      Buffer.concat([frame(stableSystem), frame(stableTools), ...messages.map(frame)]);

    const first = build({
      freshSummary: "[Goal]\nCOMPACTED WORDS S1",
      aggregateSummary: "[Goal]\nCOMPACTED WORDS S1",
      trailingSummary: "changing tail 1",
    });
    const c1 = compactionEntry("c1", "fallback 1", first, 10);
    const firstProviderMessages = convertToLlm(
      projectAppendOnlyContext(
        [
          {
            role: "compactionSummary",
            summary: "fallback 1",
            tokensBefore: 1000,
            timestamp: 10,
          },
        ],
        [c1],
      ) as any,
    );
    const prefixAfterFirst = providerPrefix(firstProviderMessages, 1);

    const second = build({
      branchEntries: [c1],
      freshSummary: "[Goal]\nCOMPACTED WORDS S2",
      aggregateSummary: "[Goal]\ncomplete second state",
      trailingSummary: "changing tail 2",
      currentCoverage: coverage("m3", "m4", "tail", 2),
      previousSummaryUsed: true,
    });
    const c2 = compactionEntry("c2", "fallback 2", second, 20);
    const secondProviderMessages = convertToLlm(
      projectAppendOnlyContext(
        [
          {
            role: "compactionSummary",
            summary: "fallback 2",
            tokensBefore: 2000,
            timestamp: 20,
          },
        ],
        [c1, c2],
      ) as any,
    );
    const prefixAfterSecondThroughS1 = providerPrefix(secondProviderMessages, 1);
    const prefixAfterSecondThroughS2 = providerPrefix(secondProviderMessages, 2);
    const secondRequest = providerRequest(secondProviderMessages);

    const third = build({
      branchEntries: [c1, c2],
      freshSummary: "[Goal]\nCOMPACTED WORDS S3",
      aggregateSummary: "[Goal]\ncomplete third state",
      trailingSummary: "changing tail 3",
      currentCoverage: coverage("m5", "m6", "tail", 2),
      previousSummaryUsed: true,
    });
    const c3 = compactionEntry("c3", "fallback 3", third, 30);
    const thirdProviderMessages = convertToLlm(
      projectAppendOnlyContext(
        [
          {
            role: "compactionSummary",
            summary: "fallback 3",
            tokensBefore: 3000,
            timestamp: 30,
          },
        ],
        [c1, c2, c3],
      ) as any,
    );
    const prefixAfterThirdThroughS2 = providerPrefix(thirdProviderMessages, 2);
    const thirdRequest = providerRequest(thirdProviderMessages);

    expect(prefixAfterSecondThroughS1).toEqual(prefixAfterFirst);
    expect(secondRequest.subarray(0, prefixAfterFirst.length)).toEqual(prefixAfterFirst);
    expect(prefixAfterThirdThroughS2).toEqual(prefixAfterSecondThroughS2);
    expect(thirdRequest.subarray(0, prefixAfterSecondThroughS2.length)).toEqual(
      prefixAfterSecondThroughS2,
    );
    expect(secondRequest.subarray(prefixAfterFirst.length).toString("utf8")).toContain(
      "COMPACTED WORDS S2",
    );
    expect(thirdRequest.subarray(prefixAfterSecondThroughS2.length).toString("utf8")).toContain(
      "COMPACTED WORDS S3",
    );
  });

  it("manual rebase starts a new one-segment chain", () => {
    const first = build();
    const c1 = compactionEntry("c1", "fallback 1", first, 10);
    const second = build({
      branchEntries: [c1],
      freshSummary: "[Goal]\nsecond delta",
      aggregateSummary: "[Goal]\ncomplete second state",
      currentCoverage: coverage("m3", "m4", "tail", 2),
      previousSummaryUsed: true,
    });
    const c2 = compactionEntry("c2", "fallback 2", second, 20);

    const rebased = build({
      branchEntries: [c1, c2],
      manualRebase: true,
      aggregateSummary: "[Goal]\nclean rebased state",
      currentCoverage: coverage("m5", "m6", "", 2),
      previousSummaryUsed: true,
    });
    const c3 = compactionEntry("c3", "fallback 3", rebased, 30);
    const chain = collectActiveSegments([c1, c2, c3]);

    expect(rebased.chainStart).toBe(true);
    expect(rebased.segment.sequence).toBe(1);
    expect(rebased.segment.summary).toContain("clean rebased state");
    expect(rebased.segment.coverage.sourceMessageCount).toBe(6);
    expect(chain.ok).toBe(true);
    if (!chain.ok) return;
    expect(chain.segments).toHaveLength(1);
    expect(chain.segments[0].entry.id).toBe("c3");
  });

  it("rebases a legacy summary once and marks the unknown earlier coverage", () => {
    const legacy = compactionEntry(
      "legacy",
      "legacy fallback",
      {
        compactor: "blackhole",
        version: 1,
        sections: ["Goal"],
        sourceMessageCount: 2,
        previousSummaryUsed: false,
      },
      5,
    );
    const details = build({
      branchEntries: [legacy],
      previousSummaryUsed: true,
    });

    expect(details.chainStart).toBe(true);
    expect(details.segment.coverage.includesLegacySummary).toBe(true);
    expect(details.segment.coverage.rebasedFromCompactionId).toBe("legacy");
    expect(details.segment.summary).toContain("rebasedFrom=legacy");
  });

  it("fails closed when the stored chain is malformed", () => {
    const first = build();
    const c1 = compactionEntry("c1", "fallback 1", first, 10);
    const bad = structuredClone(first) as any;
    bad.chainStart = false;
    bad.segment.sequence = 3;
    const c2 = compactionEntry("c2", "fallback 2", bad, 20);
    const input = [
      {
        role: "compactionSummary",
        summary: "fallback 2",
        tokensBefore: 1,
        timestamp: 20,
      },
    ];

    expect(collectActiveSegments([c1, c2]).ok).toBe(false);
    expect(projectAppendOnlyContext(input, [c1, c2])).toBe(input);
  });

  it("requires an exact match for Pi's active fallback message", () => {
    const first = build();
    const c1 = compactionEntry("c1", "fallback 1", first, 10);
    const input = [
      {
        role: "compactionSummary",
        summary: "different",
        tokensBefore: 1,
        timestamp: 10,
      },
    ];
    expect(projectAppendOnlyContext(input, [c1])).toBe(input);
  });

  it("does not project segments from another branch", () => {
    const first = build();
    const c1 = compactionEntry("c1", "fallback 1", first, 10);
    const branchA = build({
      branchEntries: [c1],
      freshSummary: "[Goal]\nbranch A",
      aggregateSummary: "[Goal]\nstate A",
      currentCoverage: coverage("a1", "a2", "tailA", 2),
      previousSummaryUsed: true,
    });
    const branchB = build({
      branchEntries: [c1],
      freshSummary: "[Goal]\nbranch B",
      aggregateSummary: "[Goal]\nstate B",
      currentCoverage: coverage("b1", "b2", "tailB", 2),
      previousSummaryUsed: true,
    });
    const cA = compactionEntry("cA", "fallback A", branchA, 20);
    const cB = compactionEntry("cB", "fallback B", branchB, 21);
    const input = [
      {
        role: "compactionSummary",
        summary: "fallback A",
        tokensBefore: 1,
        timestamp: 20,
      },
    ];
    const output = projectAppendOnlyContext(input, [c1, cA]);
    const summaries = output
      .filter((m: any) => m.role === "compactionSummary")
      .map((m: any) => m.summary);

    expect(summaries).toContain(branchA.segment.summary);
    expect(summaries).not.toContain(branchB.segment.summary);
    expect(cB.id).toBe("cB");
  });

  it("rejects incomplete version 2 details", () => {
    const invalid = build() as any;
    delete invalid.segment.coverage.lastCoveredEntryId;
    expect(isPiVccCompactionDetailsV2(invalid)).toBe(false);
  });

  it("fails closed when more than one fallback message matches", () => {
    const first = build();
    const branch = [compactionEntry("c1", "fallback 1", first, 10)];
    const input = [
      { role: "compactionSummary", summary: "fallback 1" },
      { role: "compactionSummary", summary: "fallback 1" },
    ];

    expect(projectAppendOnlyContext(input, branch)).toBe(input);
  });

  it("refuses to self-heal a malformed version-2 chain", () => {
    const first = build();
    const bad = structuredClone(first) as any;
    bad.chainStart = false;
    bad.segment.sequence = 3;
    const branch = [
      compactionEntry("c1", "fallback 1", first, 10),
      compactionEntry("c2", "fallback 2", bad, 20),
    ];

    expect(() =>
      build({
        branchEntries: branch,
        previousSummaryUsed: true,
      }),
    ).toThrow(/append chain is invalid/);
  });

  it("rejects inconsistent chainStart and sequence values", () => {
    const invalid = build() as any;
    invalid.chainStart = false;
    expect(isPiVccCompactionDetailsV2(invalid)).toBe(false);
  });

  it("refuses a version-2 checkpoint when a prior fallback is unavailable", () => {
    const first = build();
    const branch = [compactionEntry("c1", "fallback 1", first, 10)];

    expect(() =>
      build({
        branchEntries: branch,
        previousSummaryUsed: false,
      }),
    ).toThrow(/previous complete fallback summary/);
  });

  const legacyDetails = () => ({
    compactor: "blackhole" as const,
    version: 1 as const,
    sections: ["Goal"],
    sourceMessageCount: 2,
    previousSummaryUsed: false,
  });

  it("marks one rebase after several legacy compactions with the immediate latest id", () => {
    const branch = [
      compactionEntry("legacy-1", "fallback 1", legacyDetails(), 5),
      compactionEntry("legacy-2", "fallback 2", legacyDetails(), 10),
    ];
    const details = build({ branchEntries: branch, previousSummaryUsed: true });

    expect(details.chainStart).toBe(true);
    expect(details.segment.sequence).toBe(1);
    expect(details.segment.coverage.includesLegacySummary).toBe(true);
    expect(details.segment.coverage.rebasedFromCompactionId).toBe("legacy-2");
  });

  it("keeps legacy provenance when a marked chain is manually rebased", () => {
    const legacy = compactionEntry("legacy", "fallback", legacyDetails(), 5);
    const s1 = build({ branchEntries: [legacy], previousSummaryUsed: true });
    const cs1 = compactionEntry("cs1", "fallback s1", s1, 10);
    const s2 = build({
      branchEntries: [cs1],
      freshSummary: "[Goal]\nsecond delta",
      aggregateSummary: "[Goal]\nstate two",
      currentCoverage: coverage("m3", "m4", "tail", 2),
      previousSummaryUsed: true,
    });
    const cs2 = compactionEntry("cs2", "fallback s2", s2, 20);

    const rebased = build({
      branchEntries: [cs1, cs2],
      manualRebase: true,
      aggregateSummary: "[Goal]\nclean state",
      currentCoverage: coverage("m5", "m6", "", 2),
      previousSummaryUsed: true,
    });

    expect(rebased.chainStart).toBe(true);
    expect(rebased.segment.coverage.includesLegacySummary).toBe(true);
    expect(rebased.segment.coverage.rebasedFromCompactionId).toBe("legacy");
    expect(rebased.segment.coverage.sourceMessageCount).toBe(6);
  });

  it("does not mark a manual rebase of a pure append chain as legacy", () => {
    const s1 = build();
    const cs1 = compactionEntry("cs1", "fallback s1", s1, 10);
    const s2 = build({
      branchEntries: [cs1],
      freshSummary: "[Goal]\nsecond delta",
      aggregateSummary: "[Goal]\nstate two",
      currentCoverage: coverage("m3", "m4", "tail", 2),
      previousSummaryUsed: true,
    });
    const cs2 = compactionEntry("cs2", "fallback s2", s2, 20);

    const rebased = build({
      branchEntries: [cs1, cs2],
      manualRebase: true,
      aggregateSummary: "[Goal]\nclean state",
      currentCoverage: coverage("m5", "m6", "", 2),
      previousSummaryUsed: true,
    });

    expect(rebuilt(rebased).includesLegacySummary).toBeUndefined();
    expect(rebuilt(rebased).rebasedFromCompactionId).toBeUndefined();
  });

  it("ignores an orphaned append chain below a later legacy compaction", () => {
    const orphan = build();
    const cOrphan = compactionEntry("orphan", "fallback o", orphan, 10);
    const legacy = compactionEntry("legacy-late", "fallback late", legacyDetails(), 20);

    const details = build({
      branchEntries: [cOrphan, legacy],
      previousSummaryUsed: true,
    });

    expect(details.chainStart).toBe(true);
    expect(details.segment.coverage.rebasedFromCompactionId).toBe("legacy-late");
    expect(details.segment.coverage.sourceMessageCount).toBe(2);
  });

  it("marks an inherited off-chain summary as legacy when the branch has no compaction", () => {
    const details = build({ previousSummaryUsed: true });

    expect(details.chainStart).toBe(true);
    expect(details.segment.coverage.includesLegacySummary).toBe(true);
    expect(details.segment.coverage.rebasedFromCompactionId).toBeUndefined();
    expect(details.segment.summary).toContain("legacySummary=true");
  });
});

const rebuilt = (details: ReturnType<typeof buildAppendOnlyDetails>["details"]) =>
  details.segment.coverage;

const projection = (
  appendChain: number,
  saving: number,
  appendTotal?: number,
): ChainProjection => ({
  appendChain,
  rebaseChain: appendChain - saving,
  saving,
  trailingTokens: 0,
  appendTotal,
  rebaseTotal: appendTotal === undefined ? undefined : appendTotal - saving,
  method: appendTotal === undefined ? "chain-only" : "usage-residual",
});

describe("useful-saving policy", () => {
  it.each([
    [34000, 24000, 136000, false],
    [34001, 24000, 136000, true],
    [34000, 24000, 136001, true],
    [38000, 23999, 119000, false],
    [38000, 24000, 119000, true],
    [40000, 4000, 119000, false],
    [40000, 0, 150000, false],
    [40000, -100, 150000, false],
  ])("chain=%i saving=%i total=%i rebase=%s", (chain, saving, total, rebase) => {
    const result = decideChainRebase(projection(chain, saving, total), {
      manualRebase: false,
      contextWindowTokens: 272000,
    });
    expect(result.rebase).toBe(rebase);
    expect(result.minimumSaving).toBe(24000);
  });

  it("scales down, caps saving for large windows, and labels missing window chain-only", () => {
    expect(
      decideChainRebase(projection(17001, 12000), {
        manualRebase: false,
        contextWindowTokens: 136000,
      }),
    ).toMatchObject({
      rebase: true,
      chainThreshold: 17000,
      minimumSaving: 12000,
    });
    expect(
      decideChainRebase(projection(100000, 24000), {
        manualRebase: false,
        contextWindowTokens: 544000,
      }).minimumSaving,
    ).toBe(24000);
    expect(
      decideChainRebase(projection(1, 1), {
        manualRebase: false,
        contextWindowTokens: 1,
      }).minimumSaving,
    ).toBe(1);
    for (const window of [undefined, NaN, Infinity, 0, -1]) {
      expect(
        decideChainRebase(projection(38000, 24000), {
          manualRebase: false,
          contextWindowTokens: window,
        }),
      ).toMatchObject({
        rebase: true,
        contextThreshold: undefined,
        chainThreshold: 34000,
        method: "chain-only",
        appendTotal: undefined,
      });
    }
  });

  it("manual overrides saving; recovery chooses smaller, not minimum saving", () => {
    expect(decideChainRebase(projection(40000, -1), { manualRebase: true }).rebase).toBe(true);
    for (const saving of [4000, 0, -1]) {
      expect(
        decideChainRebase(projection(40000, saving), {
          manualRebase: false,
          overflow: true,
        }).rebase,
      ).toBe(saving > 0);
      expect(
        decideChainRebase(projection(40000, saving, 270001), {
          manualRebase: false,
          contextWindowTokens: 272000,
          reserveTokens: 2000,
        }).rebase,
      ).toBe(saving > 0);
    }
    expect(
      decideChainRebase(projection(40000, 4000, 270000), {
        manualRebase: false,
        contextWindowTokens: 272000,
        reserveTokens: 2000,
      }).rebase,
    ).toBe(false);
    expect(
      decideChainRebase(projection(40000, 4000, 280000), {
        manualRebase: false,
        contextWindowTokens: 272000,
        reserveTokens: 2000,
      }),
    ).toMatchObject({ rebase: true, insufficientRecovery: true });
  });
});

const linked = (entries: any[]) =>
  entries.map((entry, i) => ({
    ...entry,
    parentId: entries[i - 1]?.id ?? null,
  }));
const user = (id: string, content: string) => ({
  id,
  type: "message",
  timestamp: 1,
  message: { role: "user", content, timestamp: 1 },
});
const assistantUsage = (total: number) => ({
  id: "usage",
  type: "message",
  timestamp: 2,
  message: {
    role: "assistant",
    content: [{ type: "text", text: "baseline output" }],
    provider: "test",
    model: "test",
    stopReason: "stop",
    usage: { totalTokens: total },
    timestamp: 2,
  },
});

// Root-first branch with an old kept tail BEFORE its compaction, and new entries AFTER usage.
const accountingInput = () => {
  const first = build({
    aggregateSummary: "x".repeat(148000),
    trailingSummary: "old memory",
    currentCoverage: coverage("m1", "m2", "old-tail", 2),
  });
  const branchEntries = linked([
    user("m1", "already covered"),
    user("m2", "already covered too"),
    user("old-tail", "o".repeat(4000)),
    {
      ...compactionEntry("c1", "complete fallback", first, 10),
      firstKeptEntryId: "old-tail",
    },
    assistantUsage(100000),
    user("new", "new since baseline"),
    user("kept", "current kept tail"),
  ]);
  return {
    branchEntries,
    manualRebase: false,
    freshSummary: "y".repeat(4000),
    aggregateSummary: "z".repeat(40000),
    trailingSummary: "current memory",
    currentCoverage: coverage("old-tail", "new", "kept", 3),
    tokensBefore: 168000,
    sections: [],
    previousSummaryUsed: true,
    model: { provider: "test", id: "test" },
    contextWindowTokens: 272000,
  };
};

describe("comparable provider contexts", () => {
  it("rebases ~38k below half-window when saving is useful; wrapper and residual arithmetic match rendered context", async () => {
    const { buildSessionContext, estimateTokens } = await import("@earendil-works/pi-coding-agent");
    const input = accountingInput();
    const original = structuredClone(input.branchEntries);
    const result = buildAppendOnlyDetails(input);
    const decision = result.decision;
    expect(decision).toMatchObject({
      method: "usage-residual",
      rebase: true,
      reason: "pressure-useful-saving",
    });
    expect(decision.appendChain).toBeGreaterThan(38000);
    expect(decision.appendTotal).toBeLessThan(136000);
    expect(decision.saving).toBeGreaterThan(24000);
    expect(decision.appendTotal! - decision.rebaseTotal!).toBe(decision.saving);
    const tokens = (branch: any[]) =>
      convertToLlm(projectAppendOnlyContext(buildSessionContext(branch).messages, branch)).reduce(
        (sum, message) => sum + estimateTokens(message),
        0,
      );
    const baseline = input.branchEntries.slice(0, 5);
    const candidate = linked([
      ...input.branchEntries,
      {
        ...compactionEntry("c2", "fallback 2", result.details, 20),
        firstKeptEntryId: "kept",
      },
    ]);
    expect(decision.rebaseTotal).toBe(100000 - tokens(baseline) + tokens(candidate));
    const provider = JSON.stringify(
      convertToLlm(projectAppendOnlyContext(buildSessionContext(candidate).messages, candidate)),
    );
    expect(provider).not.toContain("o".repeat(4000));
    expect(provider).not.toContain("old memory");
    expect(provider.split("current memory")).toHaveLength(2);
    expect(decision.rebaseChain).toBeGreaterThan(
      Math.ceil(result.details.segment.summary.length / 4),
    );
    expect(input.branchEntries).toEqual(original);
  });

  it("common memory, kept tail, and fixed residual move totals equally; no extra charge for covered new entries", () => {
    const input = accountingInput();
    const base = buildAppendOnlyDetails(input).decision;
    const changedMemory = buildAppendOnlyDetails({
      ...input,
      trailingSummary: input.trailingSummary + "x".repeat(4000),
    }).decision;
    const tail = structuredClone(input);
    tail.branchEntries.at(-1)!.message.content += "x".repeat(4000);
    const changedTail = buildAppendOnlyDetails(tail).decision;
    const fixed = structuredClone(input);
    fixed.branchEntries[4].message.usage.totalTokens += 1000;
    const changedFixed = buildAppendOnlyDetails(fixed).decision;
    for (const changed of [changedMemory, changedTail, changedFixed]) {
      expect(changed.appendTotal! - base.appendTotal!).toBe(1000);
      expect(changed.rebaseTotal! - base.rebaseTotal!).toBe(1000);
      expect(changed.saving).toBe(base.saving);
    }
    const covered = structuredClone(input);
    covered.branchEntries[5].message.content += "x".repeat(4000);
    expect(buildAppendOnlyDetails(covered).decision).toEqual(base);
    const oldTail = structuredClone(input);
    oldTail.branchEntries[2].message.content += "x".repeat(4000);
    oldTail.branchEntries[4].message.usage.totalTokens += 1000;
    expect(buildAppendOnlyDetails(oldTail).decision).toEqual(base);
    expect(buildAppendOnlyDetails(structuredClone(input)).decision).toEqual(base);
  });

  it.each([
    "error",
    "aborted",
    "zero",
    "nonfinite",
    "stale",
    "model",
    "branch",
    "boundary",
    "coverage",
    "residual",
  ])("unknown totals for %s evidence", (kind) => {
    const input = accountingInput();
    if (kind === "error" || kind === "aborted") input.branchEntries[4].message.stopReason = kind;
    if (kind === "zero") input.branchEntries[4].message.usage.totalTokens = 0;
    if (kind === "nonfinite") input.branchEntries[4].message.usage.totalTokens = Infinity;
    if (kind === "stale") {
      input.branchEntries.splice(2, 0, input.branchEntries.splice(4, 1)[0]);
      input.branchEntries = linked(input.branchEntries);
    }
    if (kind === "model") input.model.id = "other";
    if (kind === "branch") input.branchEntries[4].parentId = "other-branch";
    if (kind === "boundary") input.branchEntries[3].firstKeptEntryId = "missing";
    if (kind === "coverage") input.currentCoverage.firstCoveredEntryId = "missing";
    if (kind === "residual") input.branchEntries[4].message.usage.totalTokens = 1;
    const result = buildAppendOnlyDetails(input).decision;
    expect(result.method).toBe("chain-only");
    expect(result.estimateReason).toBeTruthy();
    expect(result.appendTotal).toBeUndefined();
    expect(result.rebaseTotal).toBeUndefined();
    expect(result.saving).toBeGreaterThan(24000);
  });
});

describe("retained output accounting after upstream integration", () => {
  it("persists the same output projection in append and rebase candidates", () => {
    const input = accountingInput();
    const retainedToolOutputProjection = {
      version: 1 as const,
      retainedTokens: 0,
      omittedTokens: 1000,
      pendingCount: 0,
      omissions: [{ entryId: "kept", marker: "recall #7" }],
    };
    for (const manualRebase of [false, true]) {
      const result = buildAppendOnlyDetails({
        ...input,
        aggregateSummary: "z".repeat(160000),
        manualRebase,
        retainedToolOutputProjection,
      });
      expect(result.details.chainStart).toBe(manualRebase);
      expect(result.details.retainedToolOutputProjection).toEqual(retainedToolOutputProjection);
    }
  });

  it("charges actual persisted output omissions in baseline and both candidates", async () => {
    const { buildSessionContext, estimateTokens } = await import("@earendil-works/pi-coding-agent");
    const { applyRetainedToolOutputProjection } = await import("../src/core/tool-output-budget.js");
    const input = accountingInput();
    const output = (text: string) => ({
      role: "bashExecution",
      command: "cat result",
      output: text,
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 1,
    });
    const oldProjection = {
      version: 1 as const,
      retainedTokens: 0,
      omittedTokens: 1000,
      pendingCount: 0,
      omissions: [{ entryId: "old-tail", marker: "OLD OUTPUT OMITTED" }],
    };
    const newProjection = {
      version: 1 as const,
      retainedTokens: 0,
      omittedTokens: 2000,
      pendingCount: 0,
      omissions: [{ entryId: "kept", marker: "NEW OUTPUT OMITTED" }],
    };
    const branchEntries = input.branchEntries.map((entry) => {
      if (entry.id === "old-tail") return { ...entry, message: output("o".repeat(4000)) };
      if (entry.id === "kept") return { ...entry, message: output("k".repeat(8000)) };
      if (entry.id === "c1")
        return {
          ...entry,
          details: { ...entry.details, retainedToolOutputProjection: oldProjection },
        };
      return entry;
    });
    const original = structuredClone(branchEntries);
    const result = buildAppendOnlyDetails({
      ...input,
      branchEntries,
      retainedToolOutputProjection: newProjection,
    });
    const baseline = branchEntries.slice(0, 5);
    const candidate = linked([
      ...branchEntries,
      {
        ...compactionEntry("c2", "fallback 2", result.details, 20),
        firstKeptEntryId: "kept",
      },
    ]);
    const tokens = (branch: typeof branchEntries, projection: typeof oldProjection) => {
      const messages = projectAppendOnlyContext(buildSessionContext(branch).messages, branch);
      return convertToLlm(applyRetainedToolOutputProjection(messages, branch, projection)).reduce(
        (total, message) => total + estimateTokens(message),
        0,
      );
    };
    expect(result.decision.method).toBe("usage-residual");
    expect(result.decision.rebaseTotal).toBe(
      100000 - tokens(baseline, oldProjection) + tokens(candidate, newProjection),
    );
    expect(result.decision.appendTotal - result.decision.rebaseTotal).toBe(result.decision.saving);
    expect(branchEntries).toEqual(original);
  });
});
