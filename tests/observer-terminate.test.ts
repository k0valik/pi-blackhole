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
import { createScriptedStream } from "./fixtures/scripted-stream.js";

const baseArgs = {
  model: {} as any,
  apiKey: "test",
  priorReflections: [],
  priorObservations: [],
  chunk: "[Source entry id: entry-a]\nUser asked for a memory update.",
  allowedSourceEntryIds: ["entry-a"],
  sourceEntryTimestamps: { "entry-a": "2026-05-02 10:30" },
};

const scripted = createScriptedStream("record_observations");

function observationTurn(content: string, complete?: boolean) {
  return scripted.toolCallTurn({
    observations: [{ content, relevance: "high", sourceEntryIds: ["entry-a"] }],
    ...(complete === undefined ? {} : { complete }),
  });
}

describe("real agent loop honors record_observations terminate", () => {
  it("stops the run after a complete batch without another provider turn", async () => {
    const { streamFn, calls } = scripted.stream([observationTurn("Integrated observation", true)]);

    const result = await runObserver({ ...baseArgs, streamFn });

    // A host that ignores terminate asks for a second turn; the counter counts
    // every request, so this assertion is what makes the regression visible.
    expect(calls()).toBe(1);
    expect(result.observations?.map((observation) => observation.content)).toEqual([
      "Integrated observation",
    ]);
  });

  it("requests another turn after an incomplete batch", async () => {
    const { streamFn, calls } = scripted.stream([
      observationTurn("Partial observation", false),
      scripted.textTurn(),
    ]);

    const result = await runObserver({ ...baseArgs, streamFn });

    expect(calls()).toBe(2);
    expect(result.observations).toHaveLength(1);
  });

  it("requests another turn after a refused complete batch", async () => {
    const { streamFn, calls } = scripted.stream([
      scripted.toolCallTurn({
        observations: [{ content: "Bad source", relevance: "medium", sourceEntryIds: ["missing"] }],
        complete: true,
      }),
      scripted.textTurn(),
    ]);

    const result = await runObserver({ ...baseArgs, streamFn });

    expect(calls()).toBe(2);
    expect(result.observations).toBeUndefined();
  });

  it("records a batch whose arguments omit complete instead of failing validation", async () => {
    const { streamFn, calls } = scripted.stream([
      observationTurn("No flag observation"),
      scripted.textTurn(),
    ]);

    const result = await runObserver({ ...baseArgs, streamFn });

    expect(calls()).toBe(2);
    expect(result.observations?.map((observation) => observation.content)).toEqual([
      "No flag observation",
    ]);
  });

  it("throws when a recorded batch is followed by a stream error", async () => {
    const { streamFn, calls } = scripted.stream([observationTurn("Partial observation", false)]);

    await expect(runObserver({ ...baseArgs, streamFn })).rejects.toMatchObject({
      message: expect.stringMatching(
        /^Observer API error: scripted stream exhausted: the agent loop requested turn 2/,
      ),
      discardedObservations: 1,
    });
    expect(calls()).toBe(2);
  });

  it("throws when a refused complete batch is followed by a stream error", async () => {
    const { streamFn } = scripted.stream([
      scripted.toolCallTurn({
        observations: [
          { content: "Good source", relevance: "high", sourceEntryIds: ["entry-a"] },
          { content: "Bad source", relevance: "medium", sourceEntryIds: ["missing"] },
        ],
        complete: true,
      }),
    ]);

    await expect(runObserver({ ...baseArgs, streamFn })).rejects.toMatchObject({
      message: expect.stringMatching(/^Observer API error: scripted stream exhausted/),
      discardedObservations: 1,
    });
  });

  it("ends the run with an exhaustion error instead of looping", async () => {
    const { streamFn } = scripted.stream([]);

    await expect(runObserver({ ...baseArgs, streamFn })).rejects.toThrow(
      /scripted stream exhausted: the agent loop requested turn 1/,
    );
  });

  it("requests only the first turn when the script is empty", async () => {
    const { streamFn, calls } = scripted.stream([]);

    await runObserver({ ...baseArgs, streamFn }).catch(() => undefined);

    expect(calls()).toBe(1);
  });
});
