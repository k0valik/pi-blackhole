import { describe, expect, it } from "vitest";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import {
  buildAppendOnlyDetails,
  collectActiveSegments,
  coverageForMessages,
  estimateChainTokens,
  MAX_CHAIN_WINDOW_RATIO,
  projectAppendOnlyContext,
} from "../src/core/compaction-chain.js";
import { isPiVccCompactionDetailsV2 } from "../src/details.js";

const compactionEntry = (
  id: string,
  summary: string,
  details: unknown,
  timestamp: number,
) => ({
  id,
  type: "compaction",
  summary,
  details,
  tokensBefore: 1000,
  firstKeptEntryId: "tail",
  timestamp,
});

const coverage = (
  first: string,
  last: string,
  firstKeptEntryId: string,
  count: number,
) => ({
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
  });

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
    expect(
      coverageForMessages(branch, ["m1", "missing"], "m3"),
    ).toBeUndefined();
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
    const frame = (value: unknown): Buffer =>
      Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    const providerPrefix = (
      messages: unknown[],
      segmentCount: number,
    ): Buffer =>
      Buffer.concat([
        frame(stableSystem),
        frame(stableTools),
        ...messages.slice(0, segmentCount).map(frame),
      ]);
    const providerRequest = (messages: unknown[]): Buffer =>
      Buffer.concat([
        frame(stableSystem),
        frame(stableTools),
        ...messages.map(frame),
      ]);

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
    const prefixAfterSecondThroughS1 = providerPrefix(
      secondProviderMessages,
      1,
    );
    const prefixAfterSecondThroughS2 = providerPrefix(
      secondProviderMessages,
      2,
    );
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
    expect(secondRequest.subarray(0, prefixAfterFirst.length)).toEqual(
      prefixAfterFirst,
    );
    expect(prefixAfterThirdThroughS2).toEqual(prefixAfterSecondThroughS2);
    expect(thirdRequest.subarray(0, prefixAfterSecondThroughS2.length)).toEqual(
      prefixAfterSecondThroughS2,
    );
    expect(
      secondRequest.subarray(prefixAfterFirst.length).toString("utf8"),
    ).toContain("COMPACTED WORDS S2");
    expect(
      thirdRequest.subarray(prefixAfterSecondThroughS2.length).toString("utf8"),
    ).toContain("COMPACTED WORDS S3");
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
    const legacy = compactionEntry(
      "legacy-late",
      "fallback late",
      legacyDetails(),
      20,
    );

    const details = build({
      branchEntries: [cOrphan, legacy],
      previousSummaryUsed: true,
    });

    expect(details.chainStart).toBe(true);
    expect(details.segment.coverage.rebasedFromCompactionId).toBe(
      "legacy-late",
    );
    expect(details.segment.coverage.sourceMessageCount).toBe(2);
  });

  it("marks an inherited off-chain summary as legacy when the branch has no compaction", () => {
    const details = build({ previousSummaryUsed: true });

    expect(details.chainStart).toBe(true);
    expect(details.segment.coverage.includesLegacySummary).toBe(true);
    expect(details.segment.coverage.rebasedFromCompactionId).toBeUndefined();
    expect(details.segment.summary).toContain("legacySummary=true");
  });

  it("estimates chain size from segment summaries plus incoming content", () => {
    const s1 = build({ aggregateSummary: "x".repeat(400) });
    const cs1 = compactionEntry("cs1", "fallback s1", s1, 10);
    const chain = collectActiveSegments([cs1]);
    expect(chain.ok).toBe(true);
    if (!chain.ok) return;

    const tokens = estimateChainTokens(
      chain.segments,
      "y".repeat(200),
      "z".repeat(80),
    );
    const expectedChars =
      chain.segments.reduce((total, item) => {
        return total + item.segment.summary.length;
      }, 0) +
      200 +
      80;
    expect(tokens).toBe(Math.ceil(expectedChars / 4));
  });

  it("auto-rebases instead of appending when the projected chain exceeds half the window", () => {
    const s1 = build({ aggregateSummary: "x".repeat(600) });
    const cs1 = compactionEntry("cs1", "fallback s1", s1, 10);
    const chain = collectActiveSegments([cs1]);
    expect(chain.ok).toBe(true);
    if (!chain.ok) return;
    const fresh = "[Goal]\nnext delta";
    const trailing = "recall\n\ncurrent OM";
    const projected = estimateChainTokens(chain.segments, fresh, trailing);
    // Window where the projection sits exactly at half → appending is allowed.
    const tightWindow = Math.ceil(projected / MAX_CHAIN_WINDOW_RATIO);

    // One token below → the projection passes half the window → fold instead.
    const rebased = build({
      branchEntries: [cs1],
      freshSummary: fresh,
      aggregateSummary: "[Goal]\nfolded state",
      trailingSummary: trailing,
      currentCoverage: coverage("m3", "m4", "tail", 2),
      previousSummaryUsed: true,
      contextWindowTokens: tightWindow - 1,
    });

    expect(rebased.chainStart).toBe(true);
    expect(rebased.segment.sequence).toBe(1);
    expect(rebased.segment.summary).toContain("folded state");

    // Exactly at the boundary → still appends.
    const appended = build({
      branchEntries: [cs1],
      freshSummary: fresh,
      aggregateSummary: "[Goal]\nfolded state",
      trailingSummary: trailing,
      currentCoverage: coverage("m3", "m4", "tail", 2),
      previousSummaryUsed: true,
      contextWindowTokens: tightWindow,
    });
    expect(appended.chainStart).toBe(false);
    expect(appended.segment.sequence).toBe(2);
  });

  it("anchors the growth governor on real provider usage newer than the chain", () => {
    const s1 = build({ aggregateSummary: "x".repeat(600) });
    const cs1 = compactionEntry("cs1", "fallback s1", s1, 10);
    const chain = collectActiveSegments([cs1]);
    expect(chain.ok).toBe(true);
    if (!chain.ok) return;
    const fresh = "[Goal]\nnext delta";
    const trailing = "recall\n\ncurrent OM";
    // A window where the chars/4 estimate stays under half the window.
    const estimateWindow =
      Math.ceil(
        estimateChainTokens(chain.segments, fresh, trailing) /
          MAX_CHAIN_WINDOW_RATIO,
      ) + 50;

    const usageEntry = {
      id: "u1",
      type: "message",
      timestamp: 20,
      message: {
        role: "assistant",
        content: [],
        stopReason: "stop",
        usage: { totalTokens: 5_000 },
      },
    };
    const coveredTail = [
      {
        id: "m3",
        type: "message",
        timestamp: 30,
        message: { role: "user", content: "abcd" },
      },
      {
        id: "m4",
        type: "message",
        timestamp: 40,
        message: { role: "user", content: "efgh" },
      },
    ];

    // No trusted usage → chars/4 estimate → appends.
    const appended = build({
      branchEntries: [cs1, ...coveredTail],
      freshSummary: fresh,
      aggregateSummary: "[Goal]\nfolded state",
      trailingSummary: trailing,
      currentCoverage: coverage("m3", "m4", "tail", 2),
      previousSummaryUsed: true,
      contextWindowTokens: estimateWindow,
    });
    expect(appended.chainStart).toBe(false);
    expect(appended.segment.sequence).toBe(2);

    // Real usage far above the estimate → the projection crosses half → fold.
    const rebased = build({
      branchEntries: [cs1, usageEntry, ...coveredTail],
      freshSummary: fresh,
      aggregateSummary: "[Goal]\nfolded state",
      trailingSummary: trailing,
      currentCoverage: coverage("m3", "m4", "tail", 2),
      previousSummaryUsed: true,
      contextWindowTokens: estimateWindow,
    });
    expect(rebased.chainStart).toBe(true);
    expect(rebased.segment.sequence).toBe(1);
  });

  it("falls back to the estimate when the usage-anchored projection is inconsistent", () => {
    const s1 = build({ aggregateSummary: "x".repeat(600) });
    const cs1 = compactionEntry("cs1", "fallback s1", s1, 10);
    const chain = collectActiveSegments([cs1]);
    expect(chain.ok).toBe(true);
    if (!chain.ok) return;
    const fresh = "[Goal]\nnext delta";
    const trailing = "recall\n\ncurrent OM";
    const estimateWindow =
      Math.ceil(
        estimateChainTokens(chain.segments, fresh, trailing) /
          MAX_CHAIN_WINDOW_RATIO,
      ) + 50;

    const tinyUsage = {
      id: "u1",
      type: "message",
      timestamp: 20,
      message: {
        role: "assistant",
        content: [],
        stopReason: "stop",
        usage: { totalTokens: 5 },
      },
    };
    const heavyTail = [
      {
        id: "m3",
        type: "message",
        timestamp: 30,
        message: { role: "user", content: "y".repeat(4000) },
      },
      {
        id: "m4",
        type: "message",
        timestamp: 40,
        message: { role: "user", content: "z".repeat(4000) },
      },
    ];

    // usage(5) − covered(~2000) is negative → fall back to the chars/4 path.
    const appended = build({
      branchEntries: [cs1, tinyUsage, ...heavyTail],
      freshSummary: fresh,
      aggregateSummary: "[Goal]\nfolded state",
      trailingSummary: trailing,
      currentCoverage: coverage("m3", "m4", "tail", 2),
      previousSummaryUsed: true,
      contextWindowTokens: estimateWindow,
    });
    expect(appended.chainStart).toBe(false);
    expect(appended.segment.sequence).toBe(2);
  });
});

const rebuilt = (details: ReturnType<typeof buildAppendOnlyDetails>) =>
  details.segment.coverage;
