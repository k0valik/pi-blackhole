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
import { createScriptedStream } from "./fixtures/scripted-stream.js";

const obsA = observation("aaaaaaaaaaaa");
const obsB = observation("bbbbbbbbbbbb");

const baseArgs = {
  model: {} as any,
  apiKey: "test",
  reflections: [],
  observations: [obsA, obsB],
};

const scripted = createScriptedStream("record_reflections");

function reflectionTurn(content: string, complete?: boolean) {
  return scripted.toolCallTurn({
    reflections: [{ content, supportingObservationIds: ["aaaaaaaaaaaa"] }],
    ...(complete === undefined ? {} : { complete }),
  });
}

describe("real agent loop honors record_reflections terminate", () => {
  it("stops the run after a complete batch without another provider turn", async () => {
    const { streamFn, calls } = scripted.stream([reflectionTurn("Integrated reflection", true)]);

    const result = await runReflector({ ...baseArgs, streamFn });

    // A host that ignores terminate asks for a second turn; the counter counts
    // every request, so this assertion is what makes the regression visible.
    expect(calls()).toBe(1);
    expect(result?.map((item) => item.content)).toEqual(["Integrated reflection"]);
  });

  it("requests another turn after an incomplete batch", async () => {
    const { streamFn, calls } = scripted.stream([
      reflectionTurn("Partial reflection", false),
      scripted.textTurn(),
    ]);

    const result = await runReflector({ ...baseArgs, streamFn });

    expect(calls()).toBe(2);
    expect(result).toHaveLength(1);
  });

  it("requests another turn after a refused complete batch", async () => {
    const { streamFn, calls } = scripted.stream([
      scripted.toolCallTurn({
        reflections: [{ content: "Bad support", supportingObservationIds: ["missing"] }],
        complete: true,
      }),
      scripted.textTurn(),
    ]);

    const result = await runReflector({ ...baseArgs, streamFn });

    expect(calls()).toBe(2);
    expect(result).toBeUndefined();
  });

  it("records a batch whose arguments omit complete instead of failing validation", async () => {
    const { streamFn, calls } = scripted.stream([
      reflectionTurn("No flag reflection"),
      scripted.textTurn(),
    ]);

    const result = await runReflector({ ...baseArgs, streamFn });

    expect(calls()).toBe(2);
    expect(result?.map((item) => item.content)).toEqual(["No flag reflection"]);
  });

  it("ends the run with an exhaustion error instead of looping", async () => {
    const { streamFn } = scripted.stream([]);

    await expect(runReflector({ ...baseArgs, streamFn })).rejects.toThrow(
      /scripted stream exhausted: the agent loop requested turn 1/,
    );
  });

  it("requests only the first turn when the script is empty", async () => {
    const { streamFn, calls } = scripted.stream([]);

    await runReflector({ ...baseArgs, streamFn }).catch(() => undefined);

    expect(calls()).toBe(1);
  });
});
