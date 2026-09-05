/**
 * Rebase string-surgery proofs.
 *
 * /blackhole rebase is not a second summarizer pass — the raw turns are gone.
 * It folds the accumulated summary strings into one clean segment:
 *   compile(previousSummary) → stripOMContent → stripRecallNotes → R1
 * These tests pin down each cut of that surgery with real pipeline output.
 */
import { describe, expect, it } from "vitest";
import {
  compile,
  compileSegment,
  stripOMContent,
  stripRecallNotes,
} from "../src/core/summarize.js";
import { buildAppendOnlyDetails } from "../src/core/compaction-chain.js";
import { isPiVccCompactionDetailsV2 } from "../src/details.js";

const fileOps = { readFiles: [], modifiedFiles: [] };
const RECALL = "The conversation before this point has been compacted";

const countOccurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

describe("append rebase surgery", () => {
  it("mergePrevious collapses duplicate lines, caps section growth, and keeps exactly one recall note", () => {
    // A messy accumulated summary: duplicated bullets, an over-cap goal
    // section, a stale OM block after the recall note — exactly what long
    // accumulated chains produce.
    const goalLines = Array.from(
      { length: 10 },
      (_, i) => `- goal line ${String(i + 1).padStart(2, "0")}`,
    );
    const messyPrev = [
      "[Session Goal]",
      "- ship the parser fix",
      "- ship the parser fix", // exact duplicate
      ...goalLines, // pushes past the Session Goal cap of 8
      "",
      "[Commits]",
      "- abc1234 fix parser",
      "- abc1234 fix parser", // duplicate across cycles
      "",
      RECALL + ".",
      "",
      "## Observations",
      "[3f9c2a1b8d4e] 2026 stale observation content",
    ].join("\n");

    const complete = compile({
      messages: [
        { role: "user", content: "Refactor the parser pipeline." },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "bash",
              arguments: { command: 'git commit -m "fix parser"' },
            },
          ],
        } as any,
        {
          role: "toolResult",
          toolName: "bash",
          content: "[main abc1234] fix parser",
        } as any,
      ],
      previousSummary: messyPrev,
      fileOps,
    });

    // Duplicates collapse to one line each.
    expect(countOccurrences(complete, "ship the parser fix")).toBe(1);
    expect(countOccurrences(complete, "abc1234 fix parser")).toBe(1);
    // Cap: only the first 8 Session Goal lines survive; later ones dropped.
    expect(countOccurrences(complete, "goal line 09")).toBe(0);
    expect(countOccurrences(complete, "goal line 10")).toBe(0);
    expect(complete).toContain("goal line 01");
    // Stale OM block never leaks into the merged summary.
    expect(complete).not.toContain("## Observations");
    expect(complete).not.toContain("stale observation content");
    // Exactly one mutable recall note, still attached for the fallback role.
    expect(countOccurrences(complete, RECALL)).toBe(1);
  });

  it("/blackhole rebase folds S1+S2+S3 into one clean chain-start segment with the mutable suffix stripped", () => {
    const coverage = () => ({
      firstCoveredEntryId: "m1",
      lastCoveredEntryId: "m2",
      firstKeptEntryId: "m3",
      sourceMessageCount: 2,
    });
    const freshSummary = (text: string) =>
      compileSegment({
        messages: [
          { role: "user", content: text },
          { role: "assistant", content: `${text} — done` },
        ] as any[],
        fileOps,
      });

    // Grow a valid three-segment automatic chain.
    let branchEntries: any[] = [];
    const checkpoint = (text: string) => {
      const details = buildAppendOnlyDetails({
        branchEntries,
        manualRebase: false,
        freshSummary: freshSummary(text),
        aggregateSummary: text,
        trailingSummary: "recall note + current memory",
        currentCoverage: coverage(),
        tokensBefore: 1000,
        sections: [],
        previousSummaryUsed: true,
      });
      branchEntries = [
        ...branchEntries,
        {
          id: `c${branchEntries.length + 1}`,
          type: "compaction",
          timestamp: branchEntries.length * 10 + 10,
          summary: `[x] ${text}\n\n${RECALL}.`,
          details,
        },
      ];
      return details;
    };
    checkpoint("S1 parser timeout bug hunt");
    checkpoint("S2 parser timeout regression follow-up");
    const s3 = checkpoint("S3 parser timeout final cleanup");

    // Accumulate the same way live compactions do: each cycle merges the
    // previous complete fallback, then the mutable suffix is peeled off.
    let accumulated = compile({
      messages: [
        { role: "user", content: "S1 parser timeout bug hunt" },
        { role: "assistant", content: "S1 parser timeout bug hunt — done" },
      ] as any[],
      fileOps,
    });
    for (const text of [
      "S2 parser timeout regression follow-up",
      "S3 parser timeout final cleanup",
    ]) {
      accumulated = compile({
        messages: [
          { role: "user", content: text },
          { role: "assistant", content: `${text} — done` },
        ] as any[],
        previousSummary: `${accumulated}\n\n${RECALL}.\n\n## Observations\n[3f9c2a1b8d4e] 2026 current memory`,
        fileOps,
      });
    }
    const aggregate = stripRecallNotes(stripOMContent(accumulated)).trim();

    const rebase = buildAppendOnlyDetails({
      branchEntries,
      manualRebase: true,
      freshSummary: "",
      aggregateSummary: aggregate,
      trailingSummary: "current recall note + current memory",
      currentCoverage: coverage(),
      tokensBefore: 5000,
      sections: [],
      previousSummaryUsed: true,
    });

    // One new chain start replaces the active S1|S2|S3 projection.
    expect(isPiVccCompactionDetailsV2(rebase)).toBe(true);
    expect(rebase.chainStart).toBe(true);
    expect(rebase.segment.sequence).toBe(1);
    const r1 = rebase.segment.summary;
    expect(r1.startsWith("[Blackhole Append Segment 1]")).toBe(true);
    // Surgery stripped both mutable suffix parts from the frozen segment.
    expect(r1.includes(RECALL)).toBe(false);
    expect(r1.includes("## Observations")).toBe(false);
    // The folded segment carries the merged VCC material from all three cycles.
    expect(r1).toContain("parser timeout");
    // Old segments stay byte-identical in storage; collection just stops at R1.
    expect(branchEntries[0].details.segment.summary).toContain("[Blackhole Append Segment 1]");
    expect(s3.segment.summary).toContain("[Blackhole Append Segment 3]");
  });
});
