/**
 * Never-throw stream guard — F2b of work_docs/plan-observer-coverage-completion.md.
 *
 * pi's agentLoop is fired as `void runAgentLoop(...)` with no `.catch`
 * (agent-loop.js:13) and reads the provider response with
 * `const response = await streamFunction(...)` (agent-loop.js:271): a stream
 * function that throws — synchronously, or as a rejected promise — rejects that
 * promise into the void AND leaves the loop's event stream open, so the
 * worker's `for await` / `stream.result()` never settles and the run hangs
 * (see the note at the top of tests/fixtures/scripted-stream.ts). The guard
 * converts the failure into pi's own terminal error stream instead, and the
 * run's completion check turns that into the WorkerStreamError the stage
 * already classifies.
 *
 * Both branches matter: `streamSimple` throws synchronously on missing auth
 * (pi-ai types), while a wrapped async provider can reject.
 */

import { describe, expect, it } from "vitest";

import { runObserver } from "../src/om/agents/observer/agent.js";
import { runReflector } from "../src/om/agents/reflector/agent.js";
import { neverThrow } from "../src/om/provider-stream.js";
import { WorkerStreamError } from "../src/om/retryable-error.js";
import { observation } from "./fixtures/session.js";

// Real agent loop (no agentLoop override): the failure mode under test lives
// inside pi's own stream handling, so a fake loop could not reproduce it.
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
  observations: [observation("aaaaaaaaaaaa")],
};

describe("neverThrow wrapper", () => {
  const refusalModel = { api: "openai-completions", provider: "openai", id: "test-model" } as any;
  const loopArgs = [refusalModel, {}, {}] as [any, any, any];

  it("converts a synchronous throw into a terminal error stream", async () => {
    const guarded = neverThrow((() => {
      throw new Error("boom");
    }) as any);

    const stream = guarded(...loopArgs) as any;
    const message = await stream.result();

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe("boom");
    expect(message.model).toBe("test-model");
  });

  it("converts a rejected async streamFn into a terminal error stream", async () => {
    const guarded = neverThrow((async () => {
      throw new Error("async boom");
    }) as any);

    const stream = (await guarded(...loopArgs)) as any;
    const message = await stream.result();

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe("async boom");
  });

  it("passes a healthy stream through as the very same object", async () => {
    const healthy = {
      async *[Symbol.asyncIterator]() {
        yield { type: "done" };
      },
      async result() {
        return { stopReason: "stop" };
      },
    };
    const guarded = neverThrow((() => healthy) as any);

    expect(guarded(...loopArgs)).toBe(healthy);
  });
});

describe("streamFn failures never escape the worker as a throw or a hang", () => {
  it("turns a synchronous streamFn throw into a classified worker failure", async () => {
    const error = await runObserver({
      ...observerArgs,
      streamFn: () => {
        throw new Error("network forbidden");
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: "Observer API error: network forbidden",
      discardedCount: 0,
    });
  });

  it("turns an async streamFn rejection into a classified worker failure", async () => {
    const error = await runReflector({
      ...reflectorArgs,
      streamFn: async () => {
        throw new Error("upstream connect reset");
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: "Reflector API error: upstream connect reset",
      discardedCount: 0,
    });
  });
});
