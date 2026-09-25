/**
 * Integration: pi's real agent loop honors the terminate flag returned by
 * record_reflections.
 *
 * Mirrors tests/observer-terminate.test.ts for the second worker that ships the
 * early-stop mechanism, so a reflector-specific schema or tool-result shape
 * cannot slip through on the observer's coverage alone.
 */

import { describe, expect, it } from "vitest";

import { runReflector } from "../src/om/agents/reflector/agent.js";
import { observation } from "./fixtures/session.js";

const obsA = observation("aaaaaaaaaaaa");
const obsB = observation("bbbbbbbbbbbb");

const baseArgs = {
  model: {} as any,
  apiKey: "test",
  reflections: [],
  observations: [obsA, obsB],
};

interface ScriptedTurn {
  role: "assistant";
  api: string;
  provider: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  timestamp: number;
  content: Array<Record<string, unknown>>;
  stopReason: string;
  errorMessage?: string;
}

function assistantTurn(
  content: Array<Record<string, unknown>>,
  stopReason: string,
  errorMessage?: string,
): ScriptedTurn {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "openai",
    model: "scripted",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    timestamp: Date.now(),
    content,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function toolCallTurn(args: Record<string, unknown>) {
  return assistantTurn(
    [{ type: "toolCall", id: "call-1", name: "record_reflections", arguments: args }],
    "toolUse",
  );
}

const textTurn = assistantTurn([{ type: "text", text: "review done" }], "stop");

function reflectionTurn(content: string, complete?: boolean) {
  return toolCallTurn({
    reflections: [{ content, supportingObservationIds: ["aaaaaaaaaaaa"] }],
    ...(complete === undefined ? {} : { complete }),
  });
}

/**
 * Scripted provider stream. An exhausted script returns a terminal error turn
 * instead of throwing: a throw inside streamFn rejects the agent loop's
 * fire-and-forget promise, leaving `stream.result()` pending (a hang), while an
 * error stopReason ends the loop cleanly so the call-count assertion fails with
 * a real diagnostic.
 */
function scriptedStream(script: ReadonlyArray<ScriptedTurn>) {
  let calls = 0;
  const streamFn = async () => {
    const turn =
      script[calls] ??
      assistantTurn(
        [],
        "error",
        `scripted stream exhausted: the agent loop requested turn ${calls + 1}`,
      );
    if (calls < script.length) calls += 1;
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

describe("real agent loop honors record_reflections terminate", () => {
  it("stops the run after a complete batch without another provider turn", async () => {
    const { streamFn, calls } = scriptedStream([reflectionTurn("Integrated reflection", true)]);

    const result = await runReflector({ ...baseArgs, streamFn });

    expect(calls()).toBe(1);
    expect(result?.map((item) => item.content)).toEqual(["Integrated reflection"]);
  });

  it("requests another turn after an incomplete batch", async () => {
    const { streamFn, calls } = scriptedStream([
      reflectionTurn("Partial reflection", false),
      textTurn,
    ]);

    const result = await runReflector({ ...baseArgs, streamFn });

    expect(calls()).toBe(2);
    expect(result).toHaveLength(1);
  });

  it("requests another turn after a refused complete batch", async () => {
    const { streamFn, calls } = scriptedStream([
      toolCallTurn({
        reflections: [{ content: "Bad support", supportingObservationIds: ["missing"] }],
        complete: true,
      }),
      textTurn,
    ]);

    const result = await runReflector({ ...baseArgs, streamFn });

    expect(calls()).toBe(2);
    expect(result).toBeUndefined();
  });

  it("records a batch whose arguments omit complete instead of failing validation", async () => {
    const { streamFn, calls } = scriptedStream([reflectionTurn("No flag reflection"), textTurn]);

    const result = await runReflector({ ...baseArgs, streamFn });

    expect(calls()).toBe(2);
    expect(result?.map((item) => item.content)).toEqual(["No flag reflection"]);
  });

  it("fails fast instead of looping when the script runs out", async () => {
    const { streamFn, calls } = scriptedStream([]);

    // The exhausted script ends the run with an error turn; without that the
    // loop would keep requesting provider turns until vitest times out.
    await expect(runReflector({ ...baseArgs, streamFn })).rejects.toThrow(
      /scripted stream exhausted/,
    );
    expect(calls()).toBe(0);
  });
});
