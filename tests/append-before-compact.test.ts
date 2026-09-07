import { buildSessionContext, convertToLlm, estimateTokens } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  PI_VCC_COMPACT_INSTRUCTION,
  registerBeforeCompactHook,
} from "../src/hooks/before-compact.js";
import { projectAppendOnlyContext } from "../src/core/compaction-chain.js";
import { isPiVccCompactionDetailsV2 } from "../src/details.js";

const decisions = vi.hoisted<any[]>(() => []);
vi.mock("../src/om/debug-log.js", () => ({
  debugLog: (event: string, data: any) => {
    if (event === "before_compact.append_decision") decisions.push(data);
  },
}));

const msg = (id: string, role: "user" | "assistant" | "toolResult", content: string) => ({
  id,
  type: "message",
  timestamp: Date.now(),
  message: { role, content },
});

const createHarness = (
  configOverrides: Record<string, unknown> = {},
  modelOverrides: Record<string, unknown> = {},
) => {
  let handler: ((event: any, ctx: any) => any) | undefined;
  const config = {
    compaction: "auto",
    compactionEngine: "blackhole",
    compactionSummaryMode: "append",
    tailBehavior: "minimal",
    midRunCompaction: "off",
    skipForProviders: [],
    memory: false,
    debug: false,
    debugLog: false,
    observationsPoolMaxTokens: 20_000,
    retainedToolOutputMaxTokens: 20_000,
    reflectionsPoolMaxTokens: 8_000,
    fullFoldAlways: true,
    ...configOverrides,
  };
  const runtime = {
    ensureConfig: vi.fn(),
    config,
    compactWasPiVcc: false,
    compactionStats: null,
    appendFallbackNotified: false,
  };
  const pi = {
    on: (event: string, callback: (event: any, ctx: any) => any) => {
      if (event === "session_before_compact") handler = callback;
    },
  } as any;
  registerBeforeCompactHook(pi, runtime as any);
  const ui = { notify: vi.fn() };
  return {
    invoke: (event: any) =>
      handler!(event, {
        cwd: process.cwd(),
        model: {
          provider: "anthropic",
          api: "messages",
          id: "test",
          ...modelOverrides,
        },
        sessionManager: { getEntries: () => event.branchEntries },
        ui,
      }),
    ui,
  };
};

const event = (branchEntries: any[], previousSummary?: string, customInstructions?: string) => ({
  type: "session_before_compact",
  reason: "threshold",
  customInstructions,
  branchEntries,
  preparation: {
    previousSummary,
    fileOps: { read: [], written: [], edited: [] },
    tokensBefore: 1000,
    settings: { reserveTokens: 2000 },
  },
  signal: new AbortController().signal,
});

describe("append before-compact integration", () => {
  it("freezes the newest-first retained tool-output budget in compaction details", () => {
    const image = { type: "image", data: "encoded", mimeType: "image/png" };
    const oldOutput = {
      role: "toolResult",
      toolCallId: "old-call",
      toolName: "read",
      content: [{ type: "text", text: "o".repeat(12) }, image],
    };
    const newestOutput = {
      role: "toolResult",
      toolCallId: "new-call",
      toolName: "read",
      content: "n".repeat(8),
    };
    const pendingOutput = {
      role: "toolResult",
      toolCallId: "pending-call",
      toolName: "read",
      content: "p".repeat(40),
    };
    const branchEntries = [
      msg("m1", "user", "summarize this"),
      msg("m2", "assistant", "summarized work"),
      msg("m3", "user", "retained turn"),
      msg("m4", "assistant", "calling old tool"),
      { id: "t-old", type: "message", message: oldOutput },
      msg("m5", "assistant", "used old output"),
      { id: "t-new", type: "message", message: newestOutput },
      msg("m6", "assistant", "used newest output"),
      { id: "t-pending", type: "message", message: pendingOutput },
    ];
    const { invoke } = createHarness({
      compactionSummaryMode: "default",
      tailBehavior: "pi-default",
      retainedToolOutputMaxTokens: 2,
    });
    const input = event(branchEntries);
    input.preparation.firstKeptEntryId = "m3";

    const result = invoke(input);
    const projection = result.compaction.details.retainedToolOutputProjection;

    expect(projection).toMatchObject({
      version: 1,
      retainedTokens: 2,
      omittedTokens: 3,
      omissions: [
        {
          entryId: "t-old",
          marker: "[Tool output text omitted from active context; recall #4.]",
        },
      ],
    });
    expect(projection.omissions).not.toContainEqual(
      expect.objectContaining({ entryId: "t-pending" }),
    );
    expect(oldOutput.content).toEqual([{ type: "text", text: "o".repeat(12) }, image]);
    expect(pendingOutput.content).toBe("p".repeat(40));
  });

  it("allows the retained representation to change only at the next compaction", () => {
    const oldOutput = {
      id: "t-old",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "old-call",
        toolName: "read",
        content: "o".repeat(8),
      },
    };
    const firstBranch = [
      msg("m1", "user", "summarize first"),
      msg("m2", "assistant", "first answer"),
      msg("m3", "user", "retained turn"),
      msg("m4", "assistant", "calling old tool"),
      oldOutput,
      msg("m5", "assistant", "used old output"),
    ];
    const { invoke } = createHarness({
      compactionSummaryMode: "default",
      tailBehavior: "pi-default",
      retainedToolOutputMaxTokens: 2,
    });
    const firstEvent = event(firstBranch);
    firstEvent.preparation.firstKeptEntryId = "m3";
    const first = invoke(firstEvent);
    expect(first.compaction.details.retainedToolOutputProjection.omissions).toEqual([]);

    const c1 = {
      id: "c1",
      type: "compaction",
      ...first.compaction,
    };
    const secondBranch = [
      ...firstBranch,
      c1,
      msg("m6", "assistant", "calling new tool"),
      {
        id: "t-new",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "new-call",
          toolName: "read",
          content: "n".repeat(8),
        },
      },
      msg("m7", "assistant", "used new output"),
    ];
    const secondEvent = event(secondBranch, first.compaction.summary);
    secondEvent.preparation.firstKeptEntryId = "m4";
    const second = invoke(secondEvent);

    expect(second.compaction.details.retainedToolOutputProjection.omissions).toEqual([
      {
        entryId: "t-old",
        marker: "[Tool output text omitted from active context; recall #4.]",
      },
    ]);
    expect(oldOutput.message.content).toBe("o".repeat(8));
  });

  it("warns once when append mode falls back to the rewrite summary", () => {
    const { invoke, ui } = createHarness();
    const firstBranch = [
      msg("m1", "user", "first goal"),
      msg("m2", "assistant", "first result"),
      msg("m3", "user", "keep one"),
      msg("m4", "assistant", "tail reply"),
    ];
    const first = invoke(event(firstBranch));
    expect(isPiVccCompactionDetailsV2(first.compaction.details)).toBe(true);
    expect(ui.notify).not.toHaveBeenCalled();

    // Missing preparation.previousSummary with a prior compaction on the
    // branch → "missing-previous-summary" fallback path.
    const c1 = {
      id: "c1",
      type: "compaction",
      timestamp: 10,
      ...first.compaction,
    };
    const secondBranch = [
      c1,
      msg("m3", "user", "keep one"),
      msg("m4", "assistant", "tail reply"),
      msg("m5", "user", "keep two"),
      msg("m6", "assistant", "tail two"),
    ];
    const second = invoke(event(secondBranch));
    expect(isPiVccCompactionDetailsV2(second.compaction.details)).toBe(false);
    expect(ui.notify).toHaveBeenCalledTimes(1);
    expect(ui.notify.mock.calls[0][0]).toContain("append");
    expect(ui.notify.mock.calls[0][1]).toBe("warning");

    // A further fallback stays silent — one signal per session.
    const third = invoke(event(secondBranch));
    expect(isPiVccCompactionDetailsV2(third.compaction.details)).toBe(false);
    expect(ui.notify).toHaveBeenCalledTimes(1);
  });

  it("appends automatically and rebases explicit /blackhole", () => {
    const { invoke } = createHarness();
    const firstBranch = [
      msg("m1", "user", "first goal"),
      msg("m2", "assistant", "first result"),
      msg("m3", "user", "keep one"),
      msg("m4", "assistant", "tail reply"),
    ];
    const first = invoke(event(firstBranch));
    expect(isPiVccCompactionDetailsV2(first.compaction.details)).toBe(true);
    expect(first.compaction.details.chainStart).toBe(true);
    const firstSegment = first.compaction.details.segment.summary;

    const c1 = {
      id: "c1",
      type: "compaction",
      timestamp: 10,
      ...first.compaction,
    };
    const secondBranch = [
      c1,
      msg("m3", "user", "keep one"),
      msg("m4", "assistant", "tail reply"),
      msg("m5", "user", "keep two"),
      msg("m6", "assistant", "tail two"),
    ];
    const second = invoke(event(secondBranch, first.compaction.summary));
    expect(second.compaction.details.chainStart).toBe(false);
    expect(second.compaction.details.segment.sequence).toBe(2);
    expect(c1.details.segment.summary).toBe(firstSegment);

    const c2 = {
      id: "c2",
      type: "compaction",
      timestamp: 20,
      ...second.compaction,
    };
    const rebaseBranch = [
      c1,
      c2,
      msg("m5", "user", "keep two"),
      msg("m6", "assistant", "tail two"),
      msg("m7", "user", "clean now"),
      msg("m8", "assistant", "ready"),
    ];
    const rebased = invoke(
      event(rebaseBranch, second.compaction.summary, PI_VCC_COMPACT_INSTRUCTION),
    );
    expect(rebased.compaction.details.chainStart).toBe(true);
    expect(rebased.compaction.details.segment.sequence).toBe(1);
    expect(rebased.compaction.summary).toContain(
      "The conversation before this point has been compacted",
    );
  });

  it("keeps the exact provider prefix after three hook compactions", () => {
    const { invoke } = createHarness();
    const stableSystem = { type: "system", content: "stable system prompt" };
    const stableTools = {
      type: "tools",
      tools: [{ name: "read", description: "Read one file" }],
    };
    const frame = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    const prefix = (messages: unknown[], segmentCount: number): Buffer =>
      Buffer.concat([
        frame(stableSystem),
        frame(stableTools),
        ...messages.slice(0, segmentCount).map(frame),
      ]);
    const providerMessages = (fallback: string, branch: any[]) =>
      convertToLlm(
        projectAppendOnlyContext(
          [
            {
              role: "compactionSummary",
              summary: fallback,
              tokensBefore: 1000,
              timestamp: 100,
            },
          ],
          branch,
        ) as any,
      );

    const first = invoke(
      event([
        msg("m1", "user", "COMPACTED WORDS S1 user"),
        msg("m2", "assistant", "COMPACTED WORDS S1 assistant"),
        msg("m3", "user", "keep after S1"),
        msg("m4", "assistant", "tail after S1"),
      ]),
    );
    const c1 = {
      id: "c1",
      type: "compaction",
      timestamp: 10,
      ...first.compaction,
    };
    const firstSegment = first.compaction.details.segment.summary;
    const firstMessages = providerMessages(first.compaction.summary, [c1]);
    const prefixThroughS1 = prefix(firstMessages, 1);

    const second = invoke(
      event(
        [
          c1,
          msg("m3", "user", "COMPACTED WORDS S2 user"),
          msg("m4", "assistant", "COMPACTED WORDS S2 assistant"),
          msg("m5", "user", "keep after S2"),
          msg("m6", "assistant", "tail after S2"),
        ],
        first.compaction.summary,
      ),
    );
    const c2 = {
      id: "c2",
      type: "compaction",
      timestamp: 20,
      ...second.compaction,
    };
    const secondSegment = second.compaction.details.segment.summary;
    const secondMessages = providerMessages(second.compaction.summary, [c1, c2]);
    const secondPrefixThroughS1 = prefix(secondMessages, 1);
    const prefixThroughS2 = prefix(secondMessages, 2);

    const third = invoke(
      event(
        [
          c1,
          c2,
          msg("m5", "user", "COMPACTED WORDS S3 user"),
          msg("m6", "assistant", "COMPACTED WORDS S3 assistant"),
          msg("m7", "user", "keep after S3"),
          msg("m8", "assistant", "tail after S3"),
        ],
        second.compaction.summary,
      ),
    );
    const c3 = {
      id: "c3",
      type: "compaction",
      timestamp: 30,
      ...third.compaction,
    };
    const thirdMessages = providerMessages(third.compaction.summary, [c1, c2, c3]);
    const thirdPrefixThroughS2 = prefix(thirdMessages, 2);

    expect(second.compaction.details.segment.sequence).toBe(2);
    expect(third.compaction.details.segment.sequence).toBe(3);
    expect(c1.details.segment.summary).toBe(firstSegment);
    expect(c2.details.segment.summary).toBe(secondSegment);
    expect(secondPrefixThroughS1).toEqual(prefixThroughS1);
    expect(thirdPrefixThroughS2).toEqual(prefixThroughS2);
    expect(first.compaction.details.segment.coverage).toMatchObject({
      firstCoveredEntryId: "m1",
      lastCoveredEntryId: "m2",
    });
    expect(second.compaction.details.segment.coverage).toMatchObject({
      firstCoveredEntryId: "m3",
      lastCoveredEntryId: "m4",
    });
    expect(third.compaction.details.segment.coverage).toMatchObject({
      firstCoveredEntryId: "m5",
      lastCoveredEntryId: "m6",
    });
  });

  it("fails closed to version 1 when the active version 2 chain is malformed", () => {
    const { invoke } = createHarness();
    const firstBranch = [
      msg("m1", "user", "first goal"),
      msg("m2", "assistant", "first result"),
      msg("m3", "user", "keep one"),
      msg("m4", "assistant", "tail reply"),
    ];
    const first = invoke(event(firstBranch));
    expect(isPiVccCompactionDetailsV2(first.compaction.details)).toBe(true);

    const malformedDetails = structuredClone(first.compaction.details) as any;
    malformedDetails.chainStart = false;
    malformedDetails.segment.sequence = 3;
    const malformedEntry = {
      id: "c-bad",
      type: "compaction",
      timestamp: 10,
      ...first.compaction,
      details: malformedDetails,
    };
    const branch = [
      malformedEntry,
      msg("m3", "user", "keep one"),
      msg("m4", "assistant", "tail reply"),
      msg("m5", "user", "keep two"),
      msg("m6", "assistant", "tail two"),
    ];

    const result = invoke(event(branch, first.compaction.summary));

    expect((result.compaction.details as any).version).toBe(1);
    expect(result.compaction.summary).toContain(
      "The conversation before this point has been compacted",
    );
  });

  it("keeps version 1 details when a prior compaction has no previous summary", () => {
    const previousEntry = {
      id: "c0",
      type: "compaction",
      timestamp: 1,
      summary: "fallback 0",
      details: {
        compactor: "blackhole",
        version: 1,
        sections: [],
        sourceMessageCount: 1,
        previousSummaryUsed: false,
      },
    };
    const branch = [
      previousEntry,
      msg("m1", "user", "first"),
      msg("m2", "assistant", "done"),
      msg("m3", "user", "keep"),
      msg("m4", "assistant", "tail"),
    ];
    const { invoke } = createHarness();
    const result = invoke(event(branch, undefined));

    expect((result.compaction.details as any).version).toBe(1);
  });

  it("mid-run resume compaction appends S2 — the next model call sees S1 | S2 | current suffix | raw tail", () => {
    const { invoke } = createHarness();
    const first = invoke(
      event([
        msg("m1", "user", "start building feature"),
        msg("m2", "assistant", "early progress"),
        msg("m3", "user", "keep working"),
        msg("m4", "assistant", "more progress"),
      ]),
    );
    const c1 = {
      id: "c1",
      type: "compaction",
      timestamp: 10,
      ...first.compaction,
    };
    expect(first.compaction.details.chainStart).toBe(true);

    // Model call between the two compactions: only S1 is visible so far.
    const fallbackMessage = (summary: string) => ({
      role: "compactionSummary",
      summary,
      tokensBefore: 1000,
      timestamp: 100,
    });
    const rawTail = msg("raw-tail", "user", "live message after resume");
    const midCall = projectAppendOnlyContext(
      [fallbackMessage(first.compaction.summary), rawTail],
      [c1],
    ) as any[];
    expect(midCall[0].summary).toContain("[Blackhole Append Segment 1]");
    expect(midCall.at(-1)).toBe(rawTail); // retained raw tail keeps its position

    // Mid-run resume path: ctx.compact() without customInstructions — same
    // auto-append route, never a rebase.
    const second = invoke(
      event(
        [
          c1,
          msg("m5", "user", "post-resume work one"),
          msg("m6", "assistant", "post-resume result one"),
          msg("m7", "user", "keep going"),
          msg("m8", "assistant", "tail reply"),
        ],
        first.compaction.summary,
        undefined,
      ),
    );
    expect(second.compaction.details.chainStart).toBe(false);
    expect(second.compaction.details.segment.sequence).toBe(2);

    const c2 = {
      id: "c2",
      type: "compaction",
      timestamp: 20,
      ...second.compaction,
    };
    const nextCall = projectAppendOnlyContext(
      [fallbackMessage(second.compaction.summary), rawTail],
      [c1, c2],
    ) as any[];
    const segmentSummaries = nextCall
      .filter((m) => m.role === "compactionSummary")
      .map((m) => m.summary);
    expect(segmentSummaries).toHaveLength(2);
    expect(segmentSummaries[0]).toContain("[Blackhole Append Segment 1]");
    expect(segmentSummaries[1]).toContain("[Blackhole Append Segment 2]");
    expect(nextCall.at(-1)).toBe(rawTail);
  });

  it("observational memory and the recall note stay in the trailing suffix — never frozen into a segment, rendered exactly once", () => {
    const observation = {
      id: "3f9c2a1b8d4e",
      timestamp: "2026-08-22T00:00:00.000Z",
      relevance: "high",
      content: "TERSE OUTPUT PREFERENCE noted by observer",
      sourceEntryIds: ["m1"],
      tokenCount: 10,
    };
    const omBranchEntry = {
      id: "om1",
      type: "custom",
      customType: "om.observations.recorded",
      data: { observations: [observation], coversUpToId: "m1" },
    };
    const { invoke } = createHarness({ memory: true });
    const first = invoke(
      event([
        omBranchEntry,
        msg("m1", "user", "ask something"),
        msg("m2", "assistant", "answer one"),
        msg("m3", "user", "keep tail"),
        msg("m4", "assistant", "tail answer"),
      ]),
    );

    expect(isPiVccCompactionDetailsV2(first.compaction.details)).toBe(true);
    const segmentSummary = first.compaction.details.segment.summary;
    // The immutable segment carries VCC content only.
    expect(segmentSummary).not.toContain("## Observations");
    expect(segmentSummary).not.toContain("TERSE OUTPUT PREFERENCE");
    expect(segmentSummary).not.toContain("The conversation before this point has been compacted");
    // The stored fallback stays complete: recall note + OM inside.
    expect(first.compaction.summary).toContain("TERSE OUTPUT PREFERENCE");
    expect(first.compaction.summary).toContain(
      "The conversation before this point has been compacted",
    );

    const c1 = {
      id: "c1",
      type: "compaction",
      timestamp: 10,
      ...first.compaction,
    };
    const providerJson = JSON.stringify(
      convertToLlm(
        projectAppendOnlyContext(
          [
            {
              role: "compactionSummary",
              summary: first.compaction.summary,
              tokensBefore: 1000,
              timestamp: 100,
            },
          ],
          [c1],
        ) as any[],
      ),
    );
    // Exactly once each in provider-ready context — via the trailing suffix.
    expect(providerJson.split("TERSE OUTPUT PREFERENCE").length - 1).toBe(1);
    expect(
      providerJson.split("The conversation before this point has been compacted").length - 1,
    ).toBe(1);
  });

  it("switching back to default stops segment projection and stores a plain v1 summary", () => {
    const appendOnly = createHarness();
    const first = appendOnly.invoke(
      event([
        msg("m1", "user", "first goal"),
        msg("m2", "assistant", "first result"),
        msg("m3", "user", "keep one"),
        msg("m4", "assistant", "tail reply"),
      ]),
    );
    const c1 = {
      id: "c1",
      type: "compaction",
      timestamp: 10,
      ...first.compaction,
    };
    expect(isPiVccCompactionDetailsV2(c1.details)).toBe(true);

    const plain = createHarness({ compactionSummaryMode: "default" });
    const second = plain.invoke(
      event(
        [
          c1,
          msg("m5", "user", "next goal"),
          msg("m6", "assistant", "next result"),
          msg("m7", "user", "keep two"),
          msg("m8", "assistant", "tail two"),
        ],
        first.compaction.summary,
      ),
    );
    expect((second.compaction.details as any).version).toBe(1);

    // Latest checkpoint is v1 → projection must leave messages untouched.
    const messages = [
      {
        role: "compactionSummary",
        summary: second.compaction.summary,
        tokensBefore: 1000,
        timestamp: 100,
      },
    ];
    expect(
      projectAppendOnlyContext(messages, [
        c1,
        { id: "c2", type: "compaction", timestamp: 20, ...second.compaction },
      ]),
    ).toBe(messages);
  });

  it("compact-all keeps the chain appendable through the empty firstKeptEntryId sentinel", () => {
    const { invoke } = createHarness();
    // Single user prompt → buildOwnCut compacts everything (firstKept = "").
    const first = invoke(
      event([
        msg("m1", "user", "only goal so far"),
        msg("m2", "assistant", "work one"),
        msg("m3", "assistant", "work two"),
      ]),
    );
    expect(isPiVccCompactionDetailsV2(first.compaction.details)).toBe(true);
    expect(first.compaction.details.segment.coverage.firstKeptEntryId).toBe("");
    expect(first.compaction.details.segment.summary).toContain("<compact-all>");

    // Next compaction still appends — orphan recovery resumes after c1.
    const c1 = {
      id: "c1",
      type: "compaction",
      timestamp: 10,
      ...first.compaction,
    };
    const second = invoke(
      event(
        [
          c1,
          msg("m4", "user", "fresh goal"),
          msg("m5", "assistant", "fresh work"),
          msg("m6", "user", "keep this"),
          msg("m7", "assistant", "tail"),
        ],
        first.compaction.summary,
      ),
    );
    expect(second.compaction.details.chainStart).toBe(false);
    expect(second.compaction.details.segment.sequence).toBe(2);
    const projected = projectAppendOnlyContext(
      [
        {
          role: "compactionSummary",
          summary: second.compaction.summary,
          tokensBefore: 1000,
          timestamp: 100,
        },
      ],
      [c1, { id: "c2", type: "compaction", timestamp: 20, ...second.compaction }],
    ) as any[];
    expect(projected.filter((m) => m.role === "compactionSummary")).toHaveLength(2);
  });
});

const withParents = (entries: any[]) =>
  entries.map((entry, i) => ({
    ...entry,
    parentId: entries[i - 1]?.id ?? null,
  }));
const accountingMessage = (id: string, role: "user" | "assistant", text: string) => ({
  ...msg(id, role, text),
  timestamp: 10,
  message:
    role === "user"
      ? { role, content: text, timestamp: 10 }
      : {
          role,
          content: [{ type: "text", text }],
          provider: "anthropic",
          model: "test",
          timestamp: 10,
          stopReason: "stop",
        },
});

describe("bounded memory and useful rebase provider simulation", () => {
  it("real hook cycles retain prefixes, rebase below half-window, cap compact-all, and recall omitted sources", async () => {
    const { recallMemorySources } = await import("../src/om/ledger/recall.js");
    const { observationToSummaryLine, reflectionToSummaryLine, renderSummary } =
      await import("../src/om/ledger/render-summary.js");
    const { estimateStringTokens } = await import("../src/om/tokens.js");
    const { registerCompactionContextHook } = await import("../src/hooks/compaction-context.js");
    const { writeFileSync } = await import("node:fs");
    const harness = createHarness({ memory: true }, { contextWindow: 272000 });
    const observations = Array.from({ length: 100 }, (_, i) => ({
      id: i.toString(16).padStart(12, "0"),
      content: `OBS ${i} ` + "x".repeat(1000),
      timestamp: "2026-09-07",
      relevance: "high",
      sourceEntryIds: ["source"],
      tokenCount: 100,
    }));
    const reflections = Array.from({ length: 20 }, (_, i) => ({
      id: (i + 1000).toString(16).padStart(12, "0"),
      content: `REF ${i} ` + "y".repeat(3000),
      supportingObservationIds: [observations[0].id],
      tokenCount: 10,
    }));
    let branch: any[] = withParents([
      accountingMessage("source", "user", "original source for recall"),
      {
        id: "observations",
        type: "custom",
        customType: "om.observations.recorded",
        data: { observations, coversUpToId: "source" },
      },
      {
        id: "reflections",
        type: "custom",
        customType: "om.reflections.recorded",
        data: { reflections, coversUpToId: "source" },
      },
      accountingMessage("answer", "assistant", "first answer"),
      accountingMessage("tail0", "user", "keep"),
      accountingMessage("reply0", "assistant", "reply"),
    ]);
    let context: any;
    registerCompactionContextHook(
      {
        on: (_: string, fn: any) => {
          context = fn;
        },
      } as any,
      { config: {}, ensureConfig: () => {} } as any,
    );
    let previous: string | undefined;
    let prefix: string[] = [];
    const starts: boolean[] = [];
    const evidence: any[] = [];
    let sawUsefulRebase = false;
    for (let cycle = 0; cycle < 60; cycle++) {
      // Long frozen deltas accumulate; compile() still uses its existing bounded aggregate.
      if (cycle) {
        branch.push(
          accountingMessage(
            `work${cycle}`,
            "assistant",
            Array.from(
              { length: 90 },
              (_, i) => `cycle ${cycle} line ${i} ` + "z".repeat(300),
            ).join("\n"),
          ),
        );
        const visible = convertToLlm(
          projectAppendOnlyContext(buildSessionContext(withParents(branch)).messages, branch),
        );
        const totalTokens =
          36000 + visible.reduce((sum, message) => sum + estimateTokens(message), 0);
        branch.push({
          ...accountingMessage(`usage${cycle}`, "assistant", "measured response"),
          message: {
            ...accountingMessage("unused", "assistant", "measured response").message,
            usage: {
              totalTokens: totalTokens + estimateStringTokens("measured response"),
            },
          },
        });
        // After usage, another user starts the kept tail. Last cycle below uses compact-all separately.
        branch.push(
          accountingMessage(`tail${cycle}`, "user", "new kept tail"),
          accountingMessage(`reply${cycle}`, "assistant", "reply"),
        );
      }
      branch = withParents(branch);
      const result = harness.invoke(event(branch, previous));
      expect(result.compaction.details.version).toBe(2);
      const details = result.compaction.details;
      const memory = details["om.folded"];
      const observationTokens = estimateStringTokens(
        memory.observations.map(observationToSummaryLine).join("\n"),
      );
      const reflectionTokens = estimateStringTokens(
        memory.reflections.map(reflectionToSummaryLine).join("\n"),
      );
      expect(observationTokens).toBeLessThanOrEqual(20000);
      expect(reflectionTokens).toBeLessThanOrEqual(8000);
      expect(memory.observations.length).toBeGreaterThan(0);
      expect(memory.reflections.length).toBeGreaterThan(0);
      expect(
        result.compaction.summary.endsWith(renderSummary(memory.reflections, memory.observations)),
      ).toBe(true);
      expect(
        details.trailingSummary.endsWith(renderSummary(memory.reflections, memory.observations)),
      ).toBe(true);
      branch = withParents([
        ...branch,
        {
          id: `c${cycle}`,
          type: "compaction",
          timestamp: 20 + cycle,
          ...result.compaction,
        },
      ]);
      const messages = context(
        { messages: buildSessionContext(branch).messages },
        { sessionManager: { getBranch: () => branch } },
      ).messages;
      const provider = convertToLlm(messages);
      const segmentCount = messages.filter(
        (message: any) => message.role === "compactionSummary",
      ).length;
      const currentPrefix = provider
        .slice(0, segmentCount)
        .map((message) => JSON.stringify(message));
      if (!details.chainStart) expect(currentPrefix.slice(0, prefix.length)).toEqual(prefix);
      if (cycle > 0 && details.chainStart) sawUsefulRebase = true;
      expect(
        messages.filter((message: any) => message.customType === "blackhole-compaction-tail"),
      ).toHaveLength(1);
      expect(JSON.stringify(provider).split(memory.reflections[0].id)).toHaveLength(2);
      starts.push(details.chainStart);
      evidence.push({
        decision: decisions.at(-1),
        cycle,
        chainStart: details.chainStart,
        segmentCount,
        observationTokens,
        reflectionTokens,
        visibleTokens: provider.reduce((sum, message) => sum + estimateTokens(message), 0),
      });
      prefix = currentPrefix;
      previous = result.compaction.summary;
      if (sawUsefulRebase) {
        expect(decisions.at(-1)).toMatchObject({
          method: "usage-residual",
          reason: "pressure-useful-saving",
        });
        expect(decisions.at(-1).appendTotal).toBeLessThan(136000);
        break;
      }
    }
    writeFileSync("/tmp/blackhole-floor-cycles.json", JSON.stringify(evidence, null, 2));
    expect(starts.slice(0, 2)).toEqual([true, false]);
    expect(sawUsefulRebase).toBe(true);
    const recall = recallMemorySources(branch, observations[0].id);
    expect(recall.status).toBe("found");
    expect(recall.sourceEntries.map((entry) => entry.id)).toContain("source");
    expect(branch.at(-1).details["om.folded"].observations.map((obs: any) => obs.id)).not.toContain(
      observations[0].id,
    );
    // Compact-all through real hook with same source records, no last user tail.
    const compactAllBranch = withParents(
      branch.slice(0, 4).concat(accountingMessage("more", "assistant", "more work")),
    );
    const all = harness.invoke(event(compactAllBranch));
    expect(all.compaction.firstKeptEntryId).toBe("");
    expect(all.compaction.details["om.folded"].observations.length).toBeGreaterThan(0);
    expect(all.compaction.details["om.folded"].reflections.length).toBeGreaterThan(0);
    writeFileSync("/tmp/blackhole-floor-cycles.json", JSON.stringify(evidence, null, 2));
  });

  it.each(["manual", "overflow", "blackhole"])(
    "%s respects explicit marker versus recovery",
    (reason) => {
      const harness = createHarness({}, { contextWindow: 272000 });
      const first = harness.invoke(
        event([
          msg("m1", "user", "goal"),
          msg("m2", "assistant", "work"),
          msg("m3", "user", "keep"),
          msg("m4", "assistant", "reply"),
        ]),
      );
      const branch = [
        { id: "c1", type: "compaction", timestamp: 10, ...first.compaction },
        msg("m3", "user", "keep"),
        msg("m4", "assistant", "reply"),
        msg("m5", "user", "next"),
        msg("m6", "assistant", "reply"),
      ];
      const request = event(
        branch,
        first.compaction.summary,
        reason === "blackhole" ? PI_VCC_COMPACT_INSTRUCTION : undefined,
      );
      request.reason = reason === "blackhole" ? "manual" : reason;
      const result = harness.invoke(request);
      expect(result.compaction.details.chainStart).toBe(reason !== "manual");
      expect(result.compaction.details["om.folded"]).toBeUndefined();
    },
  );

  it("default and invalid-chain fallback both use bounded compact-all memory", () => {
    const observations = [
      {
        id: "aaaaaaaaaaaa",
        content: "x".repeat(1000),
        timestamp: "today",
        relevance: "high",
        tokenCount: 0,
        sourceEntryIds: ["m1"],
      },
    ];
    const records = [
      {
        id: "om",
        type: "custom",
        customType: "om.observations.recorded",
        data: { observations, coversUpToId: "m1" },
      },
    ];
    for (const mode of ["default", "append"]) {
      const harness = createHarness({
        memory: true,
        observationsPoolMaxTokens: 100,
        compactionSummaryMode: mode,
      });
      const branch = [
        msg(
          "m1",
          "user",
          "Please fix the authentication bug in src/auth.ts and preserve existing behavior.",
        ),
        ...records,
        msg("m2", "assistant", "work"),
        msg("m3", "assistant", "work"),
      ];
      if (mode === "append")
        branch.unshift({
          id: "bad",
          type: "compaction",
          firstKeptEntryId: "",
          summary: "prior",
          details: { version: 2, summaryMode: "append" },
        } as any);
      const result = harness.invoke(event(branch, mode === "append" ? "prior" : undefined));
      expect(result.compaction.details.version).toBe(1);
      expect(result.compaction.details["om.folded"].observations).toEqual([]);
      expect(result.compaction.summary).not.toContain("x".repeat(1000));
    }
  });
});
