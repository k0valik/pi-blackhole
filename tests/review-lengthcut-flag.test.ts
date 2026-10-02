/**
 * Review follow-up M6 (agent half): cut-off failures carry a length-cut flag.
 *
 * Real agents with a scripted loop (mirrors tests/worker-completion.test.ts):
 * a `length` terminal after a partial batch must throw a WorkerStreamError
 * with lengthCut === true so the stage can break the session retry loop;
 * the turn-cap throw keeps lengthCut falsy so the two guards stay distinct.
 */
import { describe, expect, it } from "vitest";

import { runDropper } from "../src/om/agents/dropper/agent.js";
import { runObserver } from "../src/om/agents/observer/agent.js";
import { runReflector } from "../src/om/agents/reflector/agent.js";
import { WorkerStreamError } from "../src/om/retryable-error.js";
import { observation, reflection } from "./fixtures/session.js";

function assistantStop(stopReason: string, extra: Record<string, unknown> = {}) {
  return { role: "assistant", content: [], stopReason, ...extra };
}

function scriptedLoop(
  batches: ReadonlyArray<Record<string, unknown>>,
  options: {
    capEndsRun?: boolean;
    agentEnd?: ReadonlyArray<Record<string, unknown>>;
  } = {},
) {
  return ((_prompts: any[], context: any, config: any) => ({
    async *[Symbol.asyncIterator]() {
      for (const [index, batch] of batches.entries()) {
        await context.tools[0].execute(`call-${index}`, batch);
      }
      if (options.capEndsRun) {
        config.finishTurn?.({ message: { stopReason: "toolUse" } });
      }
      if (options.agentEnd !== undefined) {
        yield { type: "agent_end", messages: options.agentEnd };
      }
    },
    result: async () => ({}),
  })) as any;
}

const observerArgs = {
  model: {} as any,
  apiKey: "test",
  priorReflections: [],
  priorObservations: [],
  chunk: "[Source entry id: entry-a]\nUser asked for a memory update.",
  allowedSourceEntryIds: ["entry-a"],
  sourceEntryTimestamps: { "entry-a": "2026-05-02 10:30" },
};

const reflectorArgs = {
  model: {} as any,
  apiKey: "test",
  reflections: [],
  observations: [observation("aaaaaaaaaaaa"), observation("bbbbbbbbbbbb")],
};

const dropperArgs = {
  model: {} as any,
  apiKey: "test",
  reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
  observations: [
    observation("aaaaaaaaaaaa", { relevance: "medium" }),
    observation("bbbbbbbbbbbb", { relevance: "low" }),
  ],
  budgetTokens: 20,
};

describe("length-cut flag on cut-off failures", () => {
  it("observer marks a length cut after a partial batch", async () => {
    const error = await runObserver({
      ...observerArgs,
      agentLoop: scriptedLoop(
        [
          {
            observations: [
              {
                content: "Partial observation",
                relevance: "high",
                sourceEntryIds: ["entry-a"],
              },
            ],
            complete: false,
          },
        ],
        { agentEnd: [assistantStop("length")] },
      ),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect((error as WorkerStreamError).lengthCut).toBe(true);
    expect((error as WorkerStreamError).turnCapExhausted).toBe(false);
  });

  it("reflector marks a length cut after a partial batch", async () => {
    const error = await runReflector({
      ...reflectorArgs,
      agentLoop: scriptedLoop(
        [
          {
            reflections: [
              {
                content: "Partial reflection",
                supportingObservationIds: ["aaaaaaaaaaaa"],
              },
            ],
            complete: false,
          },
        ],
        { agentEnd: [assistantStop("length")] },
      ),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect((error as WorkerStreamError).lengthCut).toBe(true);
    expect((error as WorkerStreamError).turnCapExhausted).toBe(false);
  });

  it("dropper marks a length cut after recording candidates", async () => {
    const error = await runDropper({
      ...dropperArgs,
      agentLoop: scriptedLoop([{ ids: ["aaaaaaaaaaaa"] }], {
        agentEnd: [assistantStop("length")],
      }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect((error as WorkerStreamError).lengthCut).toBe(true);
    expect((error as WorkerStreamError).turnCapExhausted).toBe(false);
  });

  it("observer turn-cap throw keeps the length-cut flag falsy", async () => {
    const error = await runObserver({
      ...observerArgs,
      maxTurns: 1,
      agentLoop: scriptedLoop(
        [
          {
            observations: [
              {
                content: "Partial observation",
                relevance: "high",
                sourceEntryIds: ["entry-a"],
              },
            ],
            complete: false,
          },
        ],
        { capEndsRun: true, agentEnd: [assistantStop("toolUse")] },
      ),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect((error as WorkerStreamError).turnCapExhausted).toBe(true);
    expect((error as WorkerStreamError).lengthCut).toBe(false);
  });
});

describe("maxOutputTokens boundary validation", () => {
  function capturingLoop(seen: { maxTokens?: unknown }) {
    return ((_prompts: any[], _context: any, config: any) => {
      seen.maxTokens = config.maxTokens;
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "agent_end",
            messages: [{ role: "assistant", content: [], stopReason: "stop" }],
          };
        },
        result: async () => ({}),
      };
    }) as any;
  }

  it("observer falls back to the legacy bound on a zero allowance", async () => {
    const seen: { maxTokens?: unknown } = {};
    await runObserver({ ...observerArgs, maxOutputTokens: 0, agentLoop: capturingLoop(seen) });
    expect(seen.maxTokens).toBe(32_000);
  });

  it("reflector falls back to the legacy bound on a zero allowance", async () => {
    const seen: { maxTokens?: unknown } = {};
    await runReflector({ ...reflectorArgs, maxOutputTokens: 0, agentLoop: capturingLoop(seen) });
    expect(seen.maxTokens).toBe(32_000);
  });

  it("dropper falls back to the legacy bound on a zero allowance", async () => {
    const seen: { maxTokens?: unknown } = {};
    await runDropper({ ...dropperArgs, maxOutputTokens: 0, agentLoop: capturingLoop(seen) });
    expect(seen.maxTokens).toBe(32_000);
  });

  it("observer falls back to the legacy bound on NaN", async () => {
    const seen: { maxTokens?: unknown } = {};
    await runObserver({ ...observerArgs, maxOutputTokens: NaN, agentLoop: capturingLoop(seen) });
    expect(seen.maxTokens).toBe(32_000);
  });

  it("observer passes a positive allowance through intact", async () => {
    const seen: { maxTokens?: unknown } = {};
    await runObserver({ ...observerArgs, maxOutputTokens: 1234, agentLoop: capturingLoop(seen) });
    expect(seen.maxTokens).toBe(1234);
  });

  it("observer clamps a fractional allowance to 1, not 0", async () => {
    // Math.floor(0.5) is 0 — the empty-cap case the guard prevents.
    const seen: { maxTokens?: unknown } = {};
    await runObserver({ ...observerArgs, maxOutputTokens: 0.5, agentLoop: capturingLoop(seen) });
    expect(seen.maxTokens).toBe(1);
  });

  it("reflector clamps a fractional allowance to 1, not 0", async () => {
    const seen: { maxTokens?: unknown } = {};
    await runReflector({ ...reflectorArgs, maxOutputTokens: 0.5, agentLoop: capturingLoop(seen) });
    expect(seen.maxTokens).toBe(1);
  });

  it("dropper clamps a fractional allowance to 1, not 0", async () => {
    const seen: { maxTokens?: unknown } = {};
    await runDropper({ ...dropperArgs, maxOutputTokens: 0.5, agentLoop: capturingLoop(seen) });
    expect(seen.maxTokens).toBe(1);
  });
});
