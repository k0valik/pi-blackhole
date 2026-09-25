/**
 * Integration: pi's real agent loop honors the terminate flag returned by
 * record_observations.
 *
 * The observer unit tests drive a fake loop and only inspect the flag we
 * return; these tests run the actual agentLoop with a scripted stream so a
 * host that stops honoring terminate — or a tool schema the host rejects —
 * fails here instead of shipping green.
 */

import { describe, expect, it } from "vitest";

import { runObserver } from "../src/om/agents/observer/agent.js";

const baseArgs = {
  model: {} as any,
  apiKey: "test",
  priorReflections: [],
  priorObservations: [],
  chunk: "[Source entry id: entry-a]\nUser asked for a memory update.",
  allowedSourceEntryIds: ["entry-a"],
  sourceEntryTimestamps: { "entry-a": "2026-05-02 10:30" },
};

function toolCallTurn(args: Record<string, unknown>) {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "openai",
    model: "scripted",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    timestamp: Date.now(),
    content: [{ type: "toolCall", id: "call-1", name: "record_observations", arguments: args }],
    stopReason: "toolUse",
  };
}

const textTurn = {
  role: "assistant",
  api: "openai-completions",
  provider: "openai",
  model: "scripted",
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  timestamp: Date.now(),
  content: [{ type: "text", text: "chunk covered" }],
  stopReason: "stop",
};

function observationTurn(content: string, complete?: boolean) {
  return toolCallTurn({
    observations: [{ content, relevance: "high", sourceEntryIds: ["entry-a"] }],
    ...(complete === undefined ? {} : { complete }),
  });
}

function scriptedStream(script: ReadonlyArray<unknown>) {
  let calls = 0;
  const streamFn = async () => {
    const turn = script[Math.min(calls, script.length - 1)];
    calls += 1;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "done" };
      },
      async result() {
        return turn;
      },
    };
  };
  return { streamFn, calls: () => calls };
}

describe("real agent loop honors record_observations terminate", () => {
  it("stops the run after a complete batch without another provider turn", async () => {
    const { streamFn, calls } = scriptedStream([observationTurn("Integrated observation", true)]);

    const result = await runObserver({ ...baseArgs, streamFn });

    expect(calls()).toBe(1);
    expect(result.observations?.map((observation) => observation.content)).toEqual([
      "Integrated observation",
    ]);
  });

  it("requests another turn after an incomplete batch", async () => {
    const { streamFn, calls } = scriptedStream([
      observationTurn("Partial observation", false),
      textTurn,
    ]);

    const result = await runObserver({ ...baseArgs, streamFn });

    expect(calls()).toBe(2);
    expect(result.observations).toHaveLength(1);
  });

  it("records a batch whose arguments omit complete instead of failing validation", async () => {
    const { streamFn, calls } = scriptedStream([observationTurn("No flag observation"), textTurn]);

    const result = await runObserver({ ...baseArgs, streamFn });

    expect(calls()).toBe(2);
    expect(result.observations?.map((observation) => observation.content)).toEqual([
      "No flag observation",
    ]);
  });
});
