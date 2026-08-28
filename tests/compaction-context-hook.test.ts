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
    registerCompactionContextHook(
      {
        on: (name: string, callback: (event: any, ctx: any) => any) => {
          if (name === "context") handler = callback;
        },
      } as any,
      { config: { debugLog: false }, ensureConfig: () => {} } as any,
    );

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
    registerCompactionContextHook(
      {
        on: (_name: string, callback: (event: any, ctx: any) => any) => {
          handler = callback;
        },
      } as any,
      { config: { debugLog: false }, ensureConfig: () => {} } as any,
    );

    const result = handler!(
      { messages: [{ role: "compactionSummary", summary: "different" }] },
      { sessionManager: { getBranch: () => branch } },
    );
    expect(result).toBeUndefined();
  });

  it("keeps a successful append projection when omission replay throws", () => {
    let handler: ((event: any, ctx: any) => any) | undefined;
    registerCompactionContextHook(
      {
        on: (_name: string, callback: (event: any, ctx: any) => any) => {
          handler = callback;
        },
      } as any,
      {
        config: {
          debugLog: false,
          retainedToolOutputMaxTokens: 2,
        },
        ensureConfig: () => {},
      } as any,
    );

    const cyclic: any = {};
    cyclic.self = cyclic;
    const persistedDetails = structuredClone(details) as any;
    persistedDetails.retainedToolOutputProjection = {
      version: 1,
      retainedTokens: 0,
      omittedTokens: 1,
      pendingCount: 0,
      omissions: [{ entryId: "t1", marker: "omitted" }],
    };
    const persistedBranch = [
      {
        id: "t1",
        type: "message",
        message: { role: "toolResult", content: cyclic },
      },
      { ...branch[0], details: persistedDetails },
    ];

    const result = handler!(
      {
        messages: [
          { role: "compactionSummary", summary: "complete fallback" },
          { role: "toolResult", content: "clone" },
        ],
      },
      {
        sessionManager: {
          getBranch: () => persistedBranch,
        },
      },
    );

    expect(result.messages[0].summary).toBe(details.segment.summary);
    expect(result.messages[1]).toMatchObject({
      role: "custom",
      customType: "blackhole-compaction-tail",
    });
  });

  it("does not replay omissions when a V2 append projection fails closed", () => {
    let handler: ((event: any, ctx: any) => any) | undefined;
    registerCompactionContextHook(
      {
        on: (_name: string, callback: (event: any, ctx: any) => any) => {
          handler = callback;
        },
      } as any,
      { config: { debugLog: false }, ensureConfig: () => {} } as any,
    );

    const oldResult = {
      role: "toolResult",
      toolCallId: "call-1",
      content: "full raw output",
    };
    const persistedDetails = structuredClone(details) as any;
    persistedDetails.retainedToolOutputProjection = {
      version: 1,
      retainedTokens: 0,
      omittedTokens: 4,
      pendingCount: 0,
      omissions: [{ entryId: "t1", marker: "omitted" }],
    };
    const persistedBranch = [
      { id: "t1", type: "message", message: oldResult },
      { ...branch[0], details: persistedDetails },
    ];
    const result = handler!(
      {
        messages: [
          { role: "compactionSummary", summary: "unmatched fallback" },
          structuredClone(oldResult),
        ],
      },
      { sessionManager: { getBranch: () => persistedBranch } },
    );

    expect(result).toBeUndefined();
  });

  it("does not move the tool-output cutoff during ordinary context calls", () => {
    let handler: ((event: any, ctx: any) => any) | undefined;
    registerCompactionContextHook(
      {
        on: (_name: string, callback: (event: any, ctx: any) => any) => {
          handler = callback;
        },
      } as any,
      {
        config: {
          debugLog: false,
          retainedToolOutputMaxTokens: 2,
        },
        ensureConfig: () => {},
      } as any,
    );

    const oldOutput = {
      role: "toolResult",
      toolCallId: "old-call",
      toolName: "read",
      content: "12345678",
    };
    const firstMessages = [
      oldOutput,
      { role: "assistant", content: "used old" },
    ];
    expect(
      handler!(
        { messages: firstMessages },
        {
          sessionManager: {
            getBranch: () => [],
            getEntries: () => [],
          },
        },
      ),
    ).toBeUndefined();

    const result = handler!(
      {
        messages: [
          ...firstMessages,
          {
            role: "toolResult",
            toolCallId: "new-call",
            toolName: "read",
            content: "abcdefgh",
          },
          { role: "assistant", content: "used new" },
        ],
      },
      {
        sessionManager: {
          getBranch: () => [],
          getEntries: () => [],
        },
      },
    );

    expect(result).toBeUndefined();
  });

  it("replays a persisted tool-output projection byte-for-byte across calls", () => {
    let handler: ((event: any, ctx: any) => any) | undefined;
    registerCompactionContextHook(
      {
        on: (_name: string, callback: (event: any, ctx: any) => any) => {
          handler = callback;
        },
      } as any,
      {
        config: {
          debugLog: false,
          retainedToolOutputMaxTokens: 1_000_000,
        },
        ensureConfig: () => {},
      } as any,
    );
    const oldResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: "full raw output",
    };
    const marker = "[Tool output text omitted from active context; recall #1.]";
    const persistedDetails = structuredClone(details) as any;
    persistedDetails.retainedToolOutputProjection = {
      version: 1,
      retainedTokens: 0,
      omittedTokens: 4,
      pendingCount: 0,
      omissions: [{ entryId: "t1", marker }],
    };
    const persistedBranch = [
      {
        id: "u1",
        type: "message",
        message: { role: "user", content: "question" },
      },
      { id: "t1", type: "message", message: oldResult },
      {
        ...branch[0],
        details: persistedDetails,
        firstKeptEntryId: "u1",
      },
    ];
    const context = {
      sessionManager: {
        getBranch: () => persistedBranch,
        getEntries: () => persistedBranch,
      },
    };
    const first = handler!(
      {
        messages: [
          { role: "compactionSummary", summary: "complete fallback" },
          { role: "user", content: "question" },
          structuredClone(oldResult),
        ],
      },
      context,
    ).messages;
    const second = handler!(
      {
        messages: [
          { role: "compactionSummary", summary: "complete fallback" },
          { role: "user", content: "question" },
          structuredClone(oldResult),
          { role: "user", content: "new turn" },
        ],
      },
      context,
    ).messages;

    const firstToolIndex = first.findIndex(
      (message: any) => message.toolCallId === "call-1",
    );
    const secondToolIndex = second.findIndex(
      (message: any) => message.toolCallId === "call-1",
    );
    expect(first[firstToolIndex].content).toBe(marker);
    expect(second[secondToolIndex].content).toBe(marker);
    expect(JSON.stringify(second.slice(0, secondToolIndex + 1))).toBe(
      JSON.stringify(first.slice(0, firstToolIndex + 1)),
    );
  });

  it("keeps an old omission when a later result reuses its toolCallId", () => {
    let handler: ((event: any, ctx: any) => any) | undefined;
    registerCompactionContextHook(
      {
        on: (_name: string, callback: (event: any, ctx: any) => any) => {
          handler = callback;
        },
      } as any,
      { config: { debugLog: false }, ensureConfig: () => {} } as any,
    );
    const oldResult = {
      role: "toolResult",
      toolCallId: "reused-call",
      toolName: "read",
      content: "historical output",
    };
    const laterResult = {
      role: "toolResult",
      toolCallId: "reused-call",
      toolName: "read",
      content: "later output",
    };
    const marker = "[Tool output text omitted from active context; recall #1.]";
    const persistedDetails = structuredClone(details) as any;
    persistedDetails.retainedToolOutputProjection = {
      version: 1,
      retainedTokens: 0,
      omittedTokens: 4,
      pendingCount: 0,
      omissions: [{ entryId: "t1", marker }],
    };
    const persistedBranch = [
      { id: "t1", type: "message", message: oldResult },
      { ...branch[0], details: persistedDetails },
    ];

    const result = handler!(
      {
        messages: [
          { role: "compactionSummary", summary: "complete fallback" },
          structuredClone(oldResult),
          { role: "assistant", content: "used old" },
          laterResult,
        ],
      },
      { sessionManager: { getBranch: () => persistedBranch } },
    ).messages;

    expect(result.find((message: any) => message.content === marker)).toEqual({
      ...oldResult,
      content: marker,
    });
    expect(result).toContainEqual(laterResult);
  });
});
