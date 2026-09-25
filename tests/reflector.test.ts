/**
 * Reflector agent tests — ported from upstream pi-observational-memory.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (tests/reflector.test.ts)
 * Ported with import paths adjusted for om/ layout.
 */

import { describe, expect, it } from "vitest";
import { validateToolArguments } from "@earendil-works/pi-ai";

import {
  normalizeSupportingObservationIds,
  observationToReflectorLine,
  runReflector,
  summarizeSupportIdCounts,
} from "../src/om/agents/reflector/agent.js";
import { hashId } from "../src/om/ids.js";
import { estimateStringTokens } from "../src/om/tokens.js";
import { observation, reflection } from "./fixtures/session.js";
import { leadingSystemPrompt } from "./fixtures/agent-context.js";

function fakeAgentLoop(
  handler: (prompts: any[], context: any, config: any) => Promise<void> | void,
): any {
  return ((prompts: any[], context: any, config: any) => ({
    async *[Symbol.asyncIterator]() {},
    result: async () => {
      await handler(prompts, context, config);
      return {};
    },
  })) as any;
}

interface CapturedToolResult {
  terminate?: boolean;
  details: Record<string, number>;
  content?: Array<{ type?: string; text?: string }>;
}

describe("V3 reflector agent", () => {
  const obsA = observation("aaaaaaaaaaaa");
  const obsB = observation("bbbbbbbbbbbb");
  const baseArgs = {
    model: {} as any,
    apiKey: "test",
    reflections: [],
    observations: [obsA, obsB],
  };

  it("forwards sessionId to the agent loop config", async () => {
    let seenSessionId: unknown = "unset";
    const loop = fakeAgentLoop((_prompts, _context, config) => {
      seenSessionId = config.sessionId;
    });

    await runReflector({ ...baseArgs, agentLoop: loop, sessionId: "session-abc" });

    expect(seenSessionId).toBe("session-abc");
  });

  it("forwards cacheRetention to the agent loop config", async () => {
    let seenCacheRetention: unknown;
    const loop = fakeAgentLoop((_prompts, _context, config) => {
      seenCacheRetention = config.cacheRetention;
    });

    await runReflector({ ...baseArgs, agentLoop: loop, cacheRetention: "long" });

    expect(seenCacheRetention).toBe("long");
  });

  it("omits cacheRetention from the agent loop config when unset", async () => {
    let seenCacheRetention: unknown = "sentinel";
    const loop = fakeAgentLoop((_prompts, _context, config) => {
      seenCacheRetention = config.cacheRetention;
    });

    await runReflector({ ...baseArgs, agentLoop: loop });

    expect(seenCacheRetention).toBeUndefined();
  });

  it("caps reflector turns through the 0.86 shouldStopAfterTurn hook", async () => {
    let shouldStopAfterTurn: any;
    const loop = fakeAgentLoop((_prompts, _context, config) => {
      shouldStopAfterTurn = config.shouldStopAfterTurn;
    });

    await runReflector({ ...baseArgs, agentLoop: loop, maxTurns: 2 });

    expect(shouldStopAfterTurn({ message: { stopReason: "toolUse" } })).toBe(false);
    expect(shouldStopAfterTurn({ message: { stopReason: "toolUse" } })).toBe(true);
  });

  it("caps reflector turns through the 0.87 finishTurn hook", async () => {
    let finishTurn: any;
    const loop = fakeAgentLoop((_prompts, _context, config) => {
      finishTurn = config.finishTurn;
    });

    await runReflector({ ...baseArgs, agentLoop: loop, maxTurns: 2 });

    expect(finishTurn).toBeTypeOf("function");
    expect(finishTurn({ message: { stopReason: "toolUse" } })).toBeUndefined();
    expect(finishTurn({ message: { stopReason: "toolUse" } })).toEqual({ action: "end" });
  });

  it("keeps core reflector prompt guidance in V3 terms", async () => {
    let systemPrompt = "";
    const loop = fakeAgentLoop((_prompts, context) => {
      systemPrompt = leadingSystemPrompt(context);
    });

    await runReflector({ ...baseArgs, agentLoop: loop });

    expect(systemPrompt).toContain("Your task is different from the observer");
    expect(systemPrompt).toContain("User assertions are authoritative");
    expect(systemPrompt).toContain("supportingObservationIds");
    expect(systemPrompt).toContain("coverage/provenance set");
    expect(systemPrompt).toContain("Do not lightly reword existing reflections");
    expect(systemPrompt).toContain("Reflections are scarce, expensive durable orientation anchors");
    expect(systemPrompt).toContain("not a second observation layer");
    expect(systemPrompt).toContain("Over-reflection is also memory distortion");
    expect(systemPrompt).toContain("makes transient details look durable");
    expect(systemPrompt).toContain("Decision procedure:");
    expect(systemPrompt).toContain(
      "First reject observations that are transient, low-level, partial, routine, or only useful as current working state",
    );
    expect(systemPrompt).toContain("future-agent utility test");
    expect(systemPrompt).toContain(
      "avoid a wrong decision, repeated work, or user-preference violation",
    );
    expect(systemPrompt).toContain(
      "If the candidate fails that future-agent utility test, leave it as an observation",
    );
    expect(systemPrompt).toContain("If unsure, emit no reflection");
    expect(systemPrompt).toContain(
      "Set complete=true only when the full active observation set has been reviewed and no further reflections remain. Set complete=false when another batch or correction is needed.",
    );
    expect(systemPrompt).toContain(
      "High and critical observations deserve careful review, not automatic reflection",
    );
    expect(systemPrompt).toContain("Do not turn each observation into a reflection");
    expect(systemPrompt).toContain(
      "Observations are evidence; reflections are compressed durable conclusions",
    );
    expect(systemPrompt).toContain("Single-observation reflections are allowed");
    expect(systemPrompt).toContain(
      "durable user preference, constraint, correction, decision, invariant, completed outcome, or long-lived blocker",
    );
    expect(systemPrompt).toContain("Do not copy or lightly paraphrase observation lines");
    expect(systemPrompt).toContain("Prefer fewer, higher-value reflections");
    expect(systemPrompt).toContain(
      "zero reflections than to create one reflection per observation",
    );
    expect(systemPrompt).toContain("Most transient task-log observations");
    expect(systemPrompt).toContain(
      "files inspected, commands run, failed attempts, partial implementation, and current working state",
    );
    expect(systemPrompt).toContain("[coverage: none|partial|strong]");
    expect(systemPrompt).toContain("Coverage tiers are review context");
    expect(systemPrompt).toContain(
      "Coverage is not a quota, target, priority score, or instruction to emit reflections",
    );
    expect(systemPrompt).toContain("Support ids and coverage stewardship");
    expect(systemPrompt).toContain(
      "First decide whether the reflection content passes the durable-value bar",
    );
    expect(systemPrompt).toContain(
      "include all current observation ids whose durable meaning is preserved",
    );
    expect(systemPrompt).toContain("supportingObservationIds are not a checklist");
    expect(systemPrompt).toContain("Do not add ids merely to improve coverage counts");
    expect(systemPrompt).toContain(
      "False or inflated support ids can cause unsafe downstream dropper pruning",
    );
    expect(systemPrompt).toContain(
      "emit zero reflections even when observations have coverage: none",
    );
    expect(systemPrompt).toContain("BAD: completed: edited src/hooks/reflect-drop-trigger.ts");
    expect(systemPrompt).toContain(
      "GOOD: completed: V3 reflect/drop coverage now uses raw progress watermarks",
    );
    expect(systemPrompt).toContain("BAD: npm test passed");
    expect(systemPrompt).toContain(
      "GOOD: completed: V3 package namespace migration passed full tests and typecheck",
    );
    expect(systemPrompt).toContain(
      "ZERO REFLECTIONS: The only new observations are files inspected, commands run, failed attempts, partial implementation, transient debugging, or current working state with no durable conclusion yet",
    );
    expect(systemPrompt).toContain("Focus on:");
    expect(systemPrompt).toContain("User identity, role, preferences, constraints");
    expect(systemPrompt).toContain("Project goals, architecture, technical decisions");
    expect(systemPrompt).toContain("Recurring user behavior or preferences");
    expect(systemPrompt).toContain("Completed outcomes future runs must not redo");
    expect(systemPrompt).toContain("Durable blockers, invariants, and open decisions");
    expect(systemPrompt).toContain("Reflection content rules");
    expect(systemPrompt).toContain("Lead with the fact or pattern");
    expect(systemPrompt).not.toContain("legacy/no-provenance");
    expect(systemPrompt).not.toContain("pruner");
    expect(systemPrompt).not.toContain("Pass strategy");
  });

  it("renders coverage tiers in every active observation line for the reflector", async () => {
    const none = observation("aaaaaaaaaaaa", {
      content: "Uncovered durable fact",
    });
    const partial = observation("bbbbbbbbbbbb", {
      content: "Partially covered fact",
    });
    const strong = observation("cccccccccccc", {
      content: "Strongly covered fact",
    });
    let userText = "";
    const loop = fakeAgentLoop((prompts) => {
      userText = prompts[0].content[0].text;
    });

    await runReflector({
      ...baseArgs,
      observations: [none, partial, strong],
      reflections: [
        reflection("rrrrrrrrrrr1", ["bbbbbbbbbbbb", "cccccccccccc"]),
        reflection("rrrrrrrrrrr2", ["cccccccccccc"]),
      ],
      agentLoop: loop,
    });

    expect(userText).toContain("[aaaaaaaaaaaa]");
    expect(userText).toContain("Uncovered durable fact");
    expect(userText).toContain("Partially covered fact");
    expect(userText).toContain("Strongly covered fact");
    // pi-blackhole reflector uses observationToSummaryLine without coverage display
    // Coverage in observation lines is tested in dropper-coverage.test.ts
    expect(userText).not.toContain("drop-priority");
    expect(userText).not.toContain("drop-resistance");
  });

  it("instructs complete=false for a partial batch and complete=true only on the final batch", async () => {
    let userText = "";
    const loop = fakeAgentLoop((prompts) => {
      userText = prompts[0].content[0].text;
    });

    await runReflector({ ...baseArgs, agentLoop: loop });

    expect(userText).toContain(
      "Use complete=false for a partial batch or a correction, and use complete=true only on the final valid batch once every active observation has been reviewed.",
    );
  });

  it("renders reflector observation lines with coverage evidence only", () => {
    const line = observationToReflectorLine(
      observation("aaaaaaaaaaaa", {
        relevance: "critical",
        content: "Important reflected fact",
      }),
      "partial",
    );

    expect(line).toContain("[aaaaaaaaaaaa]");
    expect(line).toContain("[critical]");
    expect(line).toContain("[coverage: partial]");
    expect(line).toContain("Important reflected fact");
    expect(line).not.toContain("drop-priority");
    expect(line).not.toContain("drop-resistance");
  });

  it("summarizes accepted reflection support-id counts without exposing ids", () => {
    expect(summarizeSupportIdCounts([])).toEqual({
      reflectionCount: 0,
      totalSupportIds: 0,
      minSupportIds: 0,
      maxSupportIds: 0,
      averageSupportIds: 0,
      histogram: {},
    });
    expect(
      summarizeSupportIdCounts([
        reflection("rrrrrrrrrrr1", ["aaaaaaaaaaaa"]),
        reflection("rrrrrrrrrrr2", ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"]),
      ]),
    ).toEqual({
      reflectionCount: 2,
      totalSupportIds: 4,
      minSupportIds: 1,
      maxSupportIds: 3,
      averageSupportIds: 2,
      histogram: { "1": 1, "3": 1 },
    });
  });

  it("normalizes supporting observation ids by active observation order", () => {
    expect(
      normalizeSupportingObservationIds(
        ["bbbbbbbbbbbb", "aaaaaaaaaaaa", "aaaaaaaaaaaa"],
        ["aaaaaaaaaaaa", "bbbbbbbbbbbb"],
      ),
    ).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
    expect(
      normalizeSupportingObservationIds(["aaaaaaaaaaaa", "missing"], ["aaaaaaaaaaaa"]),
    ).toBeUndefined();
    expect(normalizeSupportingObservationIds([], ["aaaaaaaaaaaa"])).toBeUndefined();
  });

  it("records one-line V3 reflections with code-computed ids and token counts", async () => {
    const content = "User prefers source-backed memory.";
    const loop = fakeAgentLoop(async (_prompts, context) => {
      await context.tools[0].execute("tool-1", {
        reflections: [
          {
            content,
            supportingObservationIds: ["bbbbbbbbbbbb", "aaaaaaaaaaaa"],
          },
        ],
        complete: true,
      });
    });

    const result = await runReflector({ ...baseArgs, agentLoop: loop });

    expect(result).toEqual([
      {
        id: hashId(content),
        content,
        supportingObservationIds: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"],
        tokenCount: estimateStringTokens(content),
      },
    ]);
  });

  it("rejects invented support ids and multiline content", async () => {
    let toolResult: CapturedToolResult | undefined;
    const loop = fakeAgentLoop(async (_prompts, context) => {
      toolResult = await context.tools[0].execute("tool-1", {
        reflections: [
          { content: "Bad support", supportingObservationIds: ["missing"] },
          { content: "Two\nlines", supportingObservationIds: ["aaaaaaaaaaaa"] },
        ],
        complete: true,
      });
    });

    await expect(runReflector({ ...baseArgs, agentLoop: loop })).resolves.toBeUndefined();
    // A fully rejected batch must not close the run: the model still owes a valid one.
    expect(toolResult?.terminate).toBe(false);
    expect(toolResult?.details).toMatchObject({ added: 0, rejected: 2 });
  });

  it("describes the complete flag on the record_reflections tool", async () => {
    let description = "";
    const loop = fakeAgentLoop((_prompts, context) => {
      description = context.tools[0].description;
    });

    await runReflector({ ...baseArgs, agentLoop: loop });

    expect(description).toContain("complete=true ends a fully valid reflection review");
    expect(description).toContain("Incomplete or rejected work stays open.");
  });

  it("terminates after a complete valid reflection batch", async () => {
    let toolResult: CapturedToolResult | undefined;
    const loop = fakeAgentLoop(async (_prompts, context) => {
      toolResult = await context.tools[0].execute("tool-1", {
        reflections: [
          {
            content: "User prefers source-backed memory.",
            supportingObservationIds: ["aaaaaaaaaaaa"],
          },
        ],
        complete: true,
      });
    });

    await runReflector({ ...baseArgs, agentLoop: loop });

    expect(toolResult?.terminate).toBe(true);
  });

  it("keeps an incomplete valid reflection batch open", async () => {
    let toolResult: CapturedToolResult | undefined;
    const loop = fakeAgentLoop(async (_prompts, context) => {
      toolResult = await context.tools[0].execute("tool-1", {
        reflections: [
          {
            content: "User prefers source-backed memory.",
            supportingObservationIds: ["aaaaaaaaaaaa"],
          },
        ],
        complete: false,
      });
    });

    await runReflector({ ...baseArgs, agentLoop: loop });

    expect(toolResult?.terminate).toBe(false);
  });

  it("records the batch and keeps the run open when the model omits complete", async () => {
    let toolResult: CapturedToolResult | undefined;
    const loop = fakeAgentLoop(async (_prompts, context) => {
      toolResult = await context.tools[0].execute("tool-1", {
        reflections: [
          {
            content: "No flag reflection.",
            supportingObservationIds: ["aaaaaaaaaaaa"],
          },
        ],
      });
    });

    const result = await runReflector({ ...baseArgs, agentLoop: loop });

    expect(result?.map((item) => item.content)).toEqual(["No flag reflection."]);
    expect(toolResult?.terminate).toBe(false);
  });

  it("accepts a tool call whose arguments omit complete", async () => {
    let tool: any;
    const loop = fakeAgentLoop((_prompts, context) => {
      tool = context.tools[0];
    });

    await runReflector({ ...baseArgs, agentLoop: loop });

    expect(() =>
      validateToolArguments(tool, {
        id: "call-1",
        name: "record_reflections",
        arguments: {
          reflections: [
            { content: "Omitted flag reflection.", supportingObservationIds: ["aaaaaaaaaaaa"] },
          ],
        },
      }),
    ).not.toThrow();
  });

  it("tells the model when its complete=true batch was refused", async () => {
    let toolResult: CapturedToolResult | undefined;
    const loop = fakeAgentLoop(async (_prompts, context) => {
      toolResult = await context.tools[0].execute("tool-1", {
        reflections: [{ content: "Bad support", supportingObservationIds: ["missing"] }],
        complete: true,
      });
    });

    await runReflector({ ...baseArgs, agentLoop: loop });

    expect(toolResult?.terminate).toBe(false);
    expect(toolResult?.content?.[0]?.text).toContain("complete=true was not honored");
    expect(toolResult?.content?.[0]?.text).toContain("discarded and will not be recorded");
  });

  it("keeps earlier rejections visible in later batch receipts", async () => {
    const results: CapturedToolResult[] = [];
    const loop = fakeAgentLoop(async (_prompts, context) => {
      results.push(
        await context.tools[0].execute("tool-1", {
          reflections: [{ content: "Bad support", supportingObservationIds: ["missing"] }],
          complete: false,
        }),
      );
      results.push(
        await context.tools[0].execute("tool-2", {
          reflections: [{ content: "Durable fact.", supportingObservationIds: ["aaaaaaaaaaaa"] }],
          complete: true,
        }),
      );
    });

    await runReflector({ ...baseArgs, agentLoop: loop });

    expect(results).toHaveLength(2);
    expect(results[1].content?.[0]?.text).toContain(
      "Run totals: 1 recorded, 0 duplicates skipped, 1 rejected cumulatively across this run",
    );
    // Explained as counter semantics on the receipt that creates the count.
    expect(results[0].content?.[0]?.text).toContain("does not mean corrections are still owed");
  });

  it("surfaces cumulative duplicates when a reflection is re-proposed", async () => {
    const results: CapturedToolResult[] = [];
    const loop = fakeAgentLoop(async (_prompts, context) => {
      results.push(
        await context.tools[0].execute("tool-1", {
          reflections: [{ content: "Durable fact.", supportingObservationIds: ["aaaaaaaaaaaa"] }],
          complete: false,
        }),
      );
      results.push(
        await context.tools[0].execute("tool-2", {
          reflections: [{ content: "Durable fact.", supportingObservationIds: ["aaaaaaaaaaaa"] }],
          complete: true,
        }),
      );
    });

    await runReflector({ ...baseArgs, agentLoop: loop });

    expect(results).toHaveLength(2);
    // The re-proposal is deduplicated; the cumulative duplicate count has to
    // survive into batch 2 or recorded + duplicates + rejected stops reconciling.
    expect(results[1].content?.[0]?.text).toContain(
      "Run totals: 1 recorded, 1 duplicate skipped, 0 rejected cumulatively across this run",
    );
  });

  it("never tells the model a refused complete batch ends the review", async () => {
    const results: CapturedToolResult[] = [];
    const loop = fakeAgentLoop(async (_prompts, context) => {
      results.push(
        await context.tools[0].execute("tool-1", {
          reflections: [{ content: "Bad support", supportingObservationIds: ["missing"] }],
          complete: true,
        }),
      );
    });

    await runReflector({ ...baseArgs, agentLoop: loop });

    expect(results).toHaveLength(1);
    expect(results[0].content?.[0]?.text).toContain("complete=true was not honored");
    expect(results[0].content?.[0]?.text).not.toContain("complete=true ends the review");
  });

  it("terminates on a clean complete batch after an earlier rejection", async () => {
    const results: CapturedToolResult[] = [];
    const loop = fakeAgentLoop(async (_prompts, context) => {
      results.push(
        await context.tools[0].execute("tool-1", {
          reflections: [{ content: "Bad support", supportingObservationIds: ["missing"] }],
          complete: false,
        }),
      );
      results.push(
        await context.tools[0].execute("tool-2", {
          reflections: [{ content: "Durable fact.", supportingObservationIds: ["aaaaaaaaaaaa"] }],
          complete: true,
        }),
      );
    });

    await runReflector({ ...baseArgs, agentLoop: loop });

    expect(results).toHaveLength(2);
    // The cumulative count is history, not a pending obligation, so the
    // corrected batch can still close the run.
    expect(results[1].terminate).toBe(true);
  });

  it("omits the continue-the-run guidance on a batch that terminates", async () => {
    const results: CapturedToolResult[] = [];
    const loop = fakeAgentLoop(async (_prompts, context) => {
      results.push(
        await context.tools[0].execute("tool-1", {
          reflections: [{ content: "Durable fact.", supportingObservationIds: ["aaaaaaaaaaaa"] }],
          complete: true,
        }),
      );
    });

    await runReflector({ ...baseArgs, agentLoop: loop });

    expect(results).toHaveLength(1);
    expect(results[0].content?.[0]?.text).not.toContain("complete=false asks for another batch");
  });

  it("dedupes proposals and skips existing reflection ids", async () => {
    const content = "User prefers terse updates.";
    const existing = reflection(hashId(content), ["aaaaaaaaaaaa"], { content });
    const loop = fakeAgentLoop(async (_prompts, context) => {
      await context.tools[0].execute("tool-1", {
        reflections: [
          { content, supportingObservationIds: ["aaaaaaaaaaaa"] },
          {
            content: "New durable fact.",
            supportingObservationIds: ["aaaaaaaaaaaa"],
          },
          {
            content: "New durable fact.",
            supportingObservationIds: ["bbbbbbbbbbbb"],
          },
        ],
        complete: true,
      });
    });

    const result = await runReflector({
      ...baseArgs,
      reflections: [existing],
      agentLoop: loop,
    });

    expect(result?.map((item) => item.content)).toEqual(["New durable fact."]);
  });

  it("returns undefined when no tool call records reflections", async () => {
    const loop = fakeAgentLoop(() => {});
    await expect(runReflector({ ...baseArgs, agentLoop: loop })).resolves.toBeUndefined();
  });
});
