/**
 * Dispatched generation cap follows the preflight allowance.
 *
 * `workerInputBudget` reserves at most a quarter of the window for output,
 * so the workers must dispatch that same allowance as their `maxTokens` —
 * not the unclamped `boundedMaxTokens(model, 32k)` — or prompts that pass
 * the fit check still 400 on generation overflow. Each worker takes an
 * optional `maxOutputTokens` (wired by the consolidation stage from the
 * effective window) and falls back to the legacy bound when absent.
 */
import { describe, expect, it } from "vitest";

import { runDropper } from "../src/om/agents/dropper/agent.js";
import { runObserver } from "../src/om/agents/observer/agent.js";
import { runReflector } from "../src/om/agents/reflector/agent.js";
import { observation, reflection } from "./fixtures/session.js";

function capturingLoop(
  seen: { maxTokens?: unknown },
  batches: ReadonlyArray<Record<string, unknown>> = [],
) {
  return ((_prompts: any[], context: any, _config: any) => {
    seen.maxTokens = _config.maxTokens;
    return {
      async *[Symbol.asyncIterator]() {
        for (const [index, batch] of batches.entries()) {
          await context.tools[0].execute(`call-${index}`, batch);
        }
        yield {
          type: "agent_end",
          messages: [{ role: "assistant", content: [], stopReason: "stop" }],
        };
      },
      result: async () => ({}),
    };
  }) as any;
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

describe("worker dispatched output cap", () => {
  it("observer dispatches the stage-provided allowance", async () => {
    const seen: { maxTokens?: unknown } = {};
    await runObserver({ ...observerArgs, maxOutputTokens: 2000, agentLoop: capturingLoop(seen) });
    expect(seen.maxTokens).toBe(2000);
  });

  it("observer falls back to the legacy bound without an allowance", async () => {
    const seen: { maxTokens?: unknown } = {};
    await runObserver({ ...observerArgs, agentLoop: capturingLoop(seen) });
    expect(seen.maxTokens).toBe(32_000);
  });

  it("reflector dispatches the stage-provided allowance", async () => {
    const seen: { maxTokens?: unknown } = {};
    await runReflector({
      model: {} as any,
      apiKey: "test",
      reflections: [],
      observations: [observation("aaaaaaaaaaaa"), observation("bbbbbbbbbbbb")],
      maxOutputTokens: 2000,
      agentLoop: capturingLoop(seen),
    });
    expect(seen.maxTokens).toBe(2000);
  });

  it("reflector falls back to the legacy bound without an allowance", async () => {
    const seen: { maxTokens?: unknown } = {};
    await runReflector({
      model: {} as any,
      apiKey: "test",
      reflections: [],
      observations: [observation("aaaaaaaaaaaa"), observation("bbbbbbbbbbbb")],
      agentLoop: capturingLoop(seen),
    });
    expect(seen.maxTokens).toBe(32_000);
  });

  it("dropper dispatches the stage-provided allowance", async () => {
    const seen: { maxTokens?: unknown } = {};
    await runDropper({
      model: {} as any,
      apiKey: "test",
      reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
      observations: [
        observation("aaaaaaaaaaaa", { relevance: "medium" }),
        observation("bbbbbbbbbbbb", { relevance: "low" }),
        observation("cccccccccccc", { relevance: "critical" }),
      ],
      budgetTokens: 20,
      maxOutputTokens: 2000,
      agentLoop: capturingLoop(seen),
    });
    expect(seen.maxTokens).toBe(2000);
  });

  it("dropper falls back to the legacy bound without an allowance", async () => {
    const seen: { maxTokens?: unknown } = {};
    await runDropper({
      model: {} as any,
      apiKey: "test",
      reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
      observations: [
        observation("aaaaaaaaaaaa", { relevance: "medium" }),
        observation("bbbbbbbbbbbb", { relevance: "low" }),
        observation("cccccccccccc", { relevance: "critical" }),
      ],
      budgetTokens: 20,
      agentLoop: capturingLoop(seen),
    });
    expect(seen.maxTokens).toBe(32_000);
  });
});
