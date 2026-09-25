/**
 * Observer agent tests — ported from upstream pi-observational-memory.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (tests/observer.test.ts)
 * Ported with import paths adjusted for om/ layout.
 */

import { describe, expect, it } from "vitest";
import { validateToolArguments } from "@earendil-works/pi-ai";

import {
  normalizeSourceEntryIds,
  OBSERVATION_TIMESTAMP_PATTERN,
  runObserver,
} from "../src/om/agents/observer/agent.js";
import { estimateStringTokens } from "../src/om/tokens.js";
import { leadingSystemPrompt } from "./fixtures/agent-context.js";

function fakeAgentLoop(
  handler: (prompts: any[], context: any, config: any) => Promise<void> | void,
): any {
  return ((prompts: any[], context: any, config: any) => ({
    async *[Symbol.asyncIterator]() {
      // No streaming events needed for these tests.
    },
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

describe("OBSERVATION_TIMESTAMP_PATTERN", () => {
  it("matches local minute timestamps without regex shorthand escapes", () => {
    expect(OBSERVATION_TIMESTAMP_PATTERN).not.toContain("\\d");
    const pattern = new RegExp(OBSERVATION_TIMESTAMP_PATTERN);
    expect(pattern.test("2026-05-02 10:30")).toBe(true);
    expect(pattern.test("2026-5-02 10:30")).toBe(false);
    expect(pattern.test("2026-05-02T10:30")).toBe(false);
    expect(pattern.test("2026-05-02 10:30:00")).toBe(false);
  });
});

describe("runObserver", () => {
  const baseArgs = {
    model: {} as any,
    apiKey: "test",
    priorReflections: [],
    priorObservations: [],
    chunk: "[Source entry id: entry-a]\nUser asked for a memory update.",
    allowedSourceEntryIds: ["entry-a"],
    sourceEntryTimestamps: { "entry-a": "2026-05-02 10:30" },
  };

  it("passes the isolated provider fetch through agent-loop config", async () => {
    let providerFetch: unknown;
    const loop = fakeAgentLoop((_prompts, _context, config) => {
      providerFetch = config.fetch;
    });

    await runObserver({
      ...baseArgs,
      agentLoop: loop,
      providerIdleTimeoutMs: 120_000,
    });

    expect(providerFetch).toBeTypeOf("function");
  });

  it("forwards sessionId to the agent loop config", async () => {
    let seenSessionId: unknown = "unset";
    const loop = fakeAgentLoop((_prompts, _context, config) => {
      seenSessionId = config.sessionId;
    });

    await runObserver({ ...baseArgs, agentLoop: loop, sessionId: "session-abc" });

    expect(seenSessionId).toBe("session-abc");
  });

  it("forwards cacheRetention to the agent loop config", async () => {
    let seenCacheRetention: unknown;
    const loop = fakeAgentLoop((_prompts, _context, config) => {
      seenCacheRetention = config.cacheRetention;
    });

    await runObserver({ ...baseArgs, agentLoop: loop, cacheRetention: "long" });

    expect(seenCacheRetention).toBe("long");
  });

  it("omits cacheRetention from the agent loop config when unset", async () => {
    let seenCacheRetention: unknown = "sentinel";
    const loop = fakeAgentLoop((_prompts, _context, config) => {
      seenCacheRetention = config.cacheRetention;
    });

    await runObserver({ ...baseArgs, agentLoop: loop });

    expect(seenCacheRetention).toBeUndefined();
  });

  it("keeps core observer prompt rules", async () => {
    let systemPrompt = "";
    const loop = fakeAgentLoop((_prompts, context) => {
      systemPrompt = leadingSystemPrompt(context);
    });

    await runObserver({ ...baseArgs, agentLoop: loop });

    expect(systemPrompt).toContain("Preserve user assertions exactly");
    expect(systemPrompt).toContain("Detail preservation");
    expect(systemPrompt).toContain("Frame state changes as supersession");
    expect(systemPrompt).toContain("sourceEntryIds");
    expect(systemPrompt).toContain("zero observations");
    expect(systemPrompt).toContain("final valid record_observations call with complete=true");
    expect(systemPrompt).toContain("without a separate plain-text confirmation");
    expect(systemPrompt).toContain("Use complete=false for partial batches or corrections");
    expect(systemPrompt).not.toContain(
      "STOP calling the tool and reply with a brief plain-text confirmation",
    );
    expect(systemPrompt).toContain("The dropper will drop these first");
    expect(systemPrompt).toContain("highest-resistance, load-bearing observations");
    expect(systemPrompt).toContain("Grounding rules");
    expect(systemPrompt).toContain("What NOT to emit");
    expect(systemPrompt).toContain("Dedup rule");
    // Timestamps are derived in code; the prompt must not ask the model to type them.
    expect(systemPrompt).not.toContain('YYYY-MM-DD HH:MM" (local time');
    expect(systemPrompt).not.toContain("current local time");
    expect(systemPrompt).not.toContain("will NEVER be dropped");
    expect(systemPrompt).not.toContain("pruner");
  });

  it("omits the current-time line from the user prompt", async () => {
    let prompts: any[] = [];
    const loop = fakeAgentLoop((seen, _context) => {
      prompts = seen;
    });

    await runObserver({ ...baseArgs, agentLoop: loop });

    const userText = prompts[0]?.content?.[0]?.text ?? "";
    expect(userText).not.toContain("Current local time:");
    expect(userText).toContain("CURRENT REFLECTIONS:");
  });

  it("instructs complete=false for partial batches and complete=true only on the final batch", async () => {
    let userText = "";
    const loop = fakeAgentLoop((prompts) => {
      userText = prompts[0].content[0].text;
    });

    await runObserver({ ...baseArgs, agentLoop: loop });

    expect(userText).toContain(
      "Use complete=false for partial batches or corrections, and use complete=true only on the final valid batch after the chunk is fully covered.",
    );
    expect(userText).toContain(
      "If no observations are warranted, do not call the tool and reply with a short plain-text confirmation.",
    );
    expect(userText).not.toContain(
      "reply with a short plain-text confirmation once the chunk is fully covered",
    );
  });

  it("describes the complete flag on the record_observations tool", async () => {
    let description = "";
    const loop = fakeAgentLoop((_prompts, context) => {
      description = context.tools[0].description;
    });

    await runObserver({ ...baseArgs, agentLoop: loop });

    expect(description).toContain("complete=true ends fully valid chunk coverage");
    expect(description).toContain("Incomplete or rejected work stays open.");
  });

  it("derives timestamps programmatically from cited source entries, not tool args", async () => {
    const content = "User asked for a memory update.";
    const loop = fakeAgentLoop(async (_prompts, context) => {
      await context.tools[0].execute("tool-1", {
        observations: [
          {
            content,
            relevance: "high",
            sourceEntryIds: ["entry-a"],
            // LLM-reported timestamps must be ignored entirely
            timestamp: "1999-01-01 00:00",
          },
        ],
        complete: true,
      });
    });

    const result = await runObserver({ ...baseArgs, agentLoop: loop });
    const observations = result.observations;

    expect(observations).toHaveLength(1);
    expect(observations?.[0]).toMatchObject({
      content,
      timestamp: "2026-05-02 10:30",
      relevance: "high",
      sourceEntryIds: ["entry-a"],
      tokenCount: estimateStringTokens(content),
    });
    expect(observations?.[0].id).toMatch(/^[a-f0-9]{12}$/);
  });

  it("uses the latest supporting source entry as the observation timestamp", async () => {
    const loop = fakeAgentLoop(async (_prompts, context) => {
      await context.tools[0].execute("tool-1", {
        observations: [
          {
            content: "Fact spanning two entries",
            relevance: "medium",
            sourceEntryIds: ["entry-a", "entry-b"],
          },
        ],
        complete: true,
      });
    });

    const result = await runObserver({
      ...baseArgs,
      agentLoop: loop,
      allowedSourceEntryIds: ["entry-a", "entry-b"],
      sourceEntryTimestamps: { "entry-a": "2026-05-02 10:30", "entry-b": "2026-05-02 10:45" },
    });

    expect(result.observations?.[0]?.timestamp).toBe("2026-05-02 10:45");
  });

  it("falls back to current local time when cited entries carry no usable timestamps", async () => {
    const loop = fakeAgentLoop(async (_prompts, context) => {
      await context.tools[0].execute("tool-1", {
        observations: [
          {
            content: "Fact with unknown-time evidence",
            relevance: "low",
            sourceEntryIds: ["entry-a"],
          },
        ],
        complete: true,
      });
    });

    const before = new Date();
    const result = await runObserver({
      ...baseArgs,
      agentLoop: loop,
      sourceEntryTimestamps: { "entry-a": "????-??-?? ??:??" },
    });
    const after = new Date();

    const ts = result.observations?.[0]?.timestamp;
    expect(ts).toMatch(new RegExp(OBSERVATION_TIMESTAMP_PATTERN));
    const parsed = new Date(ts!);
    expect(parsed.getTime()).not.toBeNaN();
    expect(parsed.getTime()).toBeGreaterThanOrEqual(
      new Date(
        before.getFullYear(),
        before.getMonth(),
        before.getDate(),
        before.getHours(),
        before.getMinutes(),
      ).getTime() - 60_000,
    );
    expect(parsed.getTime()).toBeLessThanOrEqual(after.getTime() + 60_000);
  });

  it("rejects invented source ids and returns no observations", async () => {
    let toolResult: CapturedToolResult | undefined;
    const loop = fakeAgentLoop(async (_prompts, context) => {
      toolResult = await context.tools[0].execute("tool-1", {
        observations: [
          {
            content: "Bad source",
            relevance: "medium",
            sourceEntryIds: ["missing"],
          },
        ],
        complete: true,
      });
    });

    const result = await runObserver({ ...baseArgs, agentLoop: loop });
    expect(result.observations).toBeUndefined();
    // A fully rejected batch must not close the run: the model still owes a valid one.
    expect(toolResult?.terminate).toBe(false);
    expect(toolResult?.details).toMatchObject({ added: 0, rejected: 1 });
  });

  it("terminates after a complete valid observation batch", async () => {
    let toolResult: CapturedToolResult | undefined;
    const loop = fakeAgentLoop(async (_prompts, context) => {
      toolResult = await context.tools[0].execute("tool-1", {
        observations: [
          {
            content: "Complete observation",
            relevance: "high",
            sourceEntryIds: ["entry-a"],
          },
        ],
        complete: true,
      });
    });

    const result = await runObserver({ ...baseArgs, agentLoop: loop });

    expect(result.observations).toHaveLength(1);
    expect(toolResult?.terminate).toBe(true);
  });

  it("keeps an incomplete valid observation batch open", async () => {
    let toolResult: CapturedToolResult | undefined;
    const loop = fakeAgentLoop(async (_prompts, context) => {
      toolResult = await context.tools[0].execute("tool-1", {
        observations: [
          {
            content: "Partial observation",
            relevance: "medium",
            sourceEntryIds: ["entry-a"],
          },
        ],
        complete: false,
      });
    });

    const result = await runObserver({ ...baseArgs, agentLoop: loop });

    expect(result.observations?.map((observation) => observation.content)).toEqual([
      "Partial observation",
    ]);
    expect(toolResult?.terminate).toBe(false);
  });

  it("terminates only on the final complete batch of a multi-batch run", async () => {
    const toolResults: CapturedToolResult[] = [];
    const loop = fakeAgentLoop(async (_prompts, context) => {
      toolResults.push(
        await context.tools[0].execute("tool-1", {
          observations: [
            {
              content: "First observation",
              relevance: "medium",
              sourceEntryIds: ["entry-a"],
            },
          ],
          complete: false,
        }),
      );
      toolResults.push(
        await context.tools[0].execute("tool-2", {
          observations: [
            {
              content: "Second observation",
              relevance: "high",
              sourceEntryIds: ["entry-a"],
            },
          ],
          complete: true,
        }),
      );
    });

    const result = await runObserver({ ...baseArgs, agentLoop: loop });

    expect(result.observations?.map((observation) => observation.content)).toEqual([
      "First observation",
      "Second observation",
    ]);
    expect(toolResults.map((entry) => entry.terminate)).toEqual([false, true]);
  });

  it("records the batch and keeps the run open when the model omits complete", async () => {
    let toolResult: CapturedToolResult | undefined;
    const loop = fakeAgentLoop(async (_prompts, context) => {
      toolResult = await context.tools[0].execute("tool-1", {
        observations: [
          {
            content: "No flag observation",
            relevance: "medium",
            sourceEntryIds: ["entry-a"],
          },
        ],
      });
    });

    const result = await runObserver({ ...baseArgs, agentLoop: loop });

    expect(result.observations?.map((observation) => observation.content)).toEqual([
      "No flag observation",
    ]);
    expect(toolResult?.terminate).toBe(false);
  });

  it("accepts a tool call whose arguments omit complete", async () => {
    let tool: any;
    const loop = fakeAgentLoop((_prompts, context) => {
      tool = context.tools[0];
    });

    await runObserver({ ...baseArgs, agentLoop: loop });

    expect(() =>
      validateToolArguments(tool, {
        id: "call-1",
        name: "record_observations",
        arguments: {
          observations: [
            {
              content: "Omitted flag",
              relevance: "low",
              sourceEntryIds: ["entry-a"],
            },
          ],
        },
      }),
    ).not.toThrow();
  });

  it("tells the model when its complete=true batch was refused", async () => {
    let toolResult: CapturedToolResult | undefined;
    const loop = fakeAgentLoop(async (_prompts, context) => {
      toolResult = await context.tools[0].execute("tool-1", {
        observations: [
          {
            content: "Bad source",
            relevance: "medium",
            sourceEntryIds: ["missing"],
          },
        ],
        complete: true,
      });
    });

    await runObserver({ ...baseArgs, agentLoop: loop });

    expect(toolResult?.terminate).toBe(false);
    expect(toolResult?.content?.[0]?.text).toContain("complete=true was not honored");
    expect(toolResult?.content?.[0]?.text).toContain("discarded and will not be recorded");
  });

  it("keeps earlier rejections visible in later batch receipts", async () => {
    const results: CapturedToolResult[] = [];
    const loop = fakeAgentLoop(async (_prompts, context) => {
      results.push(
        await context.tools[0].execute("tool-1", {
          observations: [
            { content: "Bad source", relevance: "medium", sourceEntryIds: ["missing"] },
          ],
          complete: false,
        }),
      );
      results.push(
        await context.tools[0].execute("tool-2", {
          observations: [
            { content: "Good observation", relevance: "high", sourceEntryIds: ["entry-a"] },
          ],
          complete: true,
        }),
      );
    });

    await runObserver({ ...baseArgs, agentLoop: loop });

    expect(results).toHaveLength(2);
    expect(results[1].content?.[0]?.text).toContain(
      "Run totals: 1 recorded, 0 duplicates skipped, 1 rejected cumulatively",
    );
  });

  it("labels the cumulative rejection count as history, not outstanding work", async () => {
    const results: CapturedToolResult[] = [];
    const loop = fakeAgentLoop(async (_prompts, context) => {
      results.push(
        await context.tools[0].execute("tool-1", {
          observations: [
            { content: "Bad source", relevance: "medium", sourceEntryIds: ["missing"] },
          ],
          complete: false,
        }),
      );
      results.push(
        await context.tools[0].execute("tool-2", {
          observations: [
            { content: "Good observation", relevance: "high", sourceEntryIds: ["entry-a"] },
          ],
          complete: true,
        }),
      );
    });

    await runObserver({ ...baseArgs, agentLoop: loop });

    expect(results).toHaveLength(2);
    // The corrected run still terminates: a historical count must not read as a
    // pending obligation on the turn that closes the run.
    expect(results[1].terminate).toBe(true);
    expect(results[1].content?.[0]?.text).toContain("includes entries the model corrected");
  });

  it("omits the continue-the-run guidance on a batch that terminates", async () => {
    const results: CapturedToolResult[] = [];
    const loop = fakeAgentLoop(async (_prompts, context) => {
      results.push(
        await context.tools[0].execute("tool-1", {
          observations: [
            { content: "Good observation", relevance: "high", sourceEntryIds: ["entry-a"] },
          ],
          complete: true,
        }),
      );
    });

    await runObserver({ ...baseArgs, agentLoop: loop });

    expect(results[0].content?.[0]?.text).not.toContain("Continue with complete=false");
  });

  it("closes only after a clean complete batch follows a rejected one", async () => {
    const toolResults: CapturedToolResult[] = [];
    const loop = fakeAgentLoop(async (_prompts, context) => {
      toolResults.push(
        await context.tools[0].execute("tool-1", {
          observations: [
            {
              content: "Bad source",
              relevance: "medium",
              sourceEntryIds: ["missing"],
            },
          ],
          complete: true,
        }),
      );
      toolResults.push(
        await context.tools[0].execute("tool-2", {
          observations: [
            {
              content: "Recovered observation",
              relevance: "high",
              sourceEntryIds: ["entry-a"],
            },
          ],
          complete: true,
        }),
      );
    });

    const result = await runObserver({ ...baseArgs, agentLoop: loop });

    expect(result.observations?.map((observation) => observation.content)).toEqual([
      "Recovered observation",
    ]);
    expect(toolResults.map((entry) => entry.terminate)).toEqual([false, true]);
  });

  it("dedupes deterministic ids", async () => {
    const loop = fakeAgentLoop(async (_prompts, context) => {
      await context.tools[0].execute("tool-1", {
        observations: [
          {
            content: "Same content",
            relevance: "medium",
            sourceEntryIds: ["entry-a"],
          },
          {
            content: "Same content",
            relevance: "high",
            sourceEntryIds: ["entry-a"],
          },
        ],
        complete: true,
      });
    });

    const result = await runObserver({ ...baseArgs, agentLoop: loop });
    const observations = result.observations;

    expect(observations).toHaveLength(1);
    expect(observations?.[0].content).toBe("Same content");
  });

  it("returns undefined when no tool call records observations", async () => {
    const loop = fakeAgentLoop(() => {});
    const result = await runObserver({ ...baseArgs, agentLoop: loop });
    expect(result.observations).toBeUndefined();
  });

  it("caps observer turns through the 0.86 shouldStopAfterTurn hook", async () => {
    let shouldStopAfterTurn: any;
    const loop = fakeAgentLoop((_prompts, _context, config) => {
      shouldStopAfterTurn = config.shouldStopAfterTurn;
    });

    await runObserver({ ...baseArgs, agentLoop: loop, maxTurns: 2 });

    expect(shouldStopAfterTurn({ message: { stopReason: "toolUse" } })).toBe(false);
    expect(shouldStopAfterTurn({ message: { stopReason: "toolUse" } })).toBe(true);
  });

  it("caps observer turns through the 0.87 finishTurn hook", async () => {
    let finishTurn: any;
    const loop = fakeAgentLoop((_prompts, _context, config) => {
      finishTurn = config.finishTurn;
    });

    await runObserver({ ...baseArgs, agentLoop: loop, maxTurns: 2 });

    expect(finishTurn).toBeTypeOf("function");
    expect(finishTurn({ message: { stopReason: "toolUse" } })).toBeUndefined();
    expect(finishTurn({ message: { stopReason: "toolUse" } })).toEqual({ action: "end" });
  });

  it("uses configured observer thinking level for reasoning models", async () => {
    let seenReasoning: unknown;
    const loop = fakeAgentLoop((_prompts, _context, config) => {
      seenReasoning = config.reasoning;
    });

    await runObserver({
      ...baseArgs,
      model: { reasoning: true } as any,
      agentLoop: loop,
      thinkingLevel: "minimal",
    });

    expect(seenReasoning).toBe("minimal");
  });

  it("omits observer reasoning when thinkingLevel is off", async () => {
    let seenReasoning: unknown = "unset";
    const loop = fakeAgentLoop((_prompts, _context, config) => {
      seenReasoning = config.reasoning;
    });

    await runObserver({
      ...baseArgs,
      model: { reasoning: true } as any,
      agentLoop: loop,
      thinkingLevel: "off",
    });

    expect(seenReasoning).toBeUndefined();
  });
});

describe("normalizeSourceEntryIds", () => {
  const allowed = ["entry-a", "entry-b", "entry-c"];

  it("accepts source ids from the allowed chunk and orders them by branch order", () => {
    expect(normalizeSourceEntryIds(["entry-c", "entry-a"], allowed)).toEqual([
      "entry-a",
      "entry-c",
    ]);
  });

  it("dedupes repeated source ids", () => {
    expect(normalizeSourceEntryIds(["entry-b", "entry-b", "entry-a"], allowed)).toEqual([
      "entry-a",
      "entry-b",
    ]);
  });

  it("filters missing, empty, or hallucinated source ids (no longer rejects whole batch)", () => {
    expect(normalizeSourceEntryIds(undefined, allowed)).toBeUndefined();
    expect(normalizeSourceEntryIds([], allowed)).toBeUndefined();
    // Hallucinated IDs are filtered out; valid IDs are kept
    expect(normalizeSourceEntryIds(["entry-a", "not-in-the-chunk"], allowed)).toEqual(["entry-a"]);
    expect(normalizeSourceEntryIds(["entry-a"], [])).toBeUndefined();
  });

  it("partially accepts mixed valid and hallucinated source ids", () => {
    // When some IDs are valid and some are hallucinated, only valid ones survive
    expect(
      normalizeSourceEntryIds(
        ["entry-a", "hallucinated-1", "entry-b", "hallucinated-2", "entry-c"],
        allowed,
      ),
    ).toEqual(["entry-a", "entry-b", "entry-c"]);
  });
});
