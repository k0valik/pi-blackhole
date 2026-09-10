/**
 * Observer agent tests — ported from upstream pi-observational-memory.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (tests/observer.test.ts)
 * Ported with import paths adjusted for om/ layout.
 */

import { describe, expect, it } from "vitest";

import {
  normalizeSourceEntryIds,
  OBSERVATION_TIMESTAMP_PATTERN,
  runObserver,
} from "../src/om/agents/observer/agent.js";
import { estimateStringTokens } from "../src/om/tokens.js";

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

  it("keeps core observer prompt rules", async () => {
    let systemPrompt = "";
    const loop = fakeAgentLoop((_prompts, context) => {
      systemPrompt = context.systemPrompt;
    });

    await runObserver({ ...baseArgs, agentLoop: loop });

    expect(systemPrompt).toContain("Preserve user assertions exactly");
    expect(systemPrompt).toContain("Detail preservation");
    expect(systemPrompt).toContain("Frame state changes as supersession");
    expect(systemPrompt).toContain("sourceEntryIds");
    expect(systemPrompt).toContain("zero observations");
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
    const loop = fakeAgentLoop(async (_prompts, context) => {
      await context.tools[0].execute("tool-1", {
        observations: [
          {
            content: "Bad source",
            relevance: "medium",
            sourceEntryIds: ["missing"],
          },
        ],
      });
    });

    const result = await runObserver({ ...baseArgs, agentLoop: loop });
    expect(result.observations).toBeUndefined();
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

  it("uses maxTurns as an observer turn cap", async () => {
    let shouldStopAfterTurn: any;
    const loop = fakeAgentLoop((_prompts, _context, config) => {
      shouldStopAfterTurn = config.shouldStopAfterTurn;
    });

    await runObserver({ ...baseArgs, agentLoop: loop, maxTurns: 2 });

    expect(shouldStopAfterTurn).toBeTypeOf("function");
    expect(shouldStopAfterTurn({})).toBe(false);
    expect(shouldStopAfterTurn({})).toBe(true);
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
