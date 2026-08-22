import { describe, expect, it } from "vitest";
import { buildAppendOnlyDetails } from "../src/core/compaction-chain.js";
import { registerCompactionContextHook } from "../src/hooks/compaction-context.js";

const details = buildAppendOnlyDetails({
  branchEntries: [],
  manualRebase: false,
  freshSummary: "[Goal]\nfirst",
  aggregateSummary: "[Goal]\nfirst",
  trailingSummary: "current tail",
  currentCoverage: {
    firstCoveredEntryId: "m1",
    lastCoveredEntryId: "m2",
    firstKeptEntryId: "m3",
    sourceMessageCount: 2,
  },
  tokensBefore: 1000,
  sections: ["Goal"],
  previousSummaryUsed: false,
});

const branch = [
  {
    id: "c1",
    type: "compaction",
    timestamp: 10,
    summary: "complete fallback",
    details,
  },
];

describe("append context hook", () => {
  it("replaces the exact fallback with the active immutable chain", () => {
    let handler: ((event: any, ctx: any) => any) | undefined;
    registerCompactionContextHook({
      on: (name: string, callback: (event: any, ctx: any) => any) => {
        if (name === "context") handler = callback;
      },
    } as any);

    const result = handler!(
      {
        messages: [
          {
            role: "compactionSummary",
            summary: "complete fallback",
            tokensBefore: 1000,
            timestamp: 10,
          },
          { role: "user", content: "raw tail", timestamp: 20 },
        ],
      },
      { sessionManager: { getBranch: () => branch } },
    );

    expect(result.messages[0].summary).toBe(details.segment.summary);
    expect(result.messages[1]).toMatchObject({
      role: "custom",
      content: "current tail",
      display: false,
    });
    expect(result.messages[2].content).toBe("raw tail");
  });

  it("returns no override when projection cannot be proved safe", () => {
    let handler: ((event: any, ctx: any) => any) | undefined;
    registerCompactionContextHook({
      on: (_name: string, callback: (event: any, ctx: any) => any) => {
        handler = callback;
      },
    } as any);

    const result = handler!(
      { messages: [{ role: "compactionSummary", summary: "different" }] },
      { sessionManager: { getBranch: () => branch } },
    );
    expect(result).toBeUndefined();
  });
});
