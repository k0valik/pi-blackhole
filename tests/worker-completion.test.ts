/**
 * Completion strictness — F2 of work_docs/plan-observer-coverage-completion.md.
 *
 * The consolidation stages record whatever the worker returns and advance a
 * coverage cursor, so a run that ENDED without finishing its review must throw
 * instead of reporting success: the unreviewed tail would never be revisited.
 * `stopReason: "error"` was already a failure; these tests pin the residual gap
 * — `length` (output cap), `aborted`, a terminal `toolUse` without a complete
 * close, and an aborted signal are not completions either.
 *
 * The exempt cases matter as much as the failures: a `complete=true` close, a
 * turn-cap end on a tool-work turn, and a cap cutting an empty run are all
 * legitimate endings the existing guards already report, and must keep their
 * exact messages and flags (see tests/reflector-stream-error.test.ts and
 * tests/dropper-stream-error.test.ts for the untouched error/turn-cap cases).
 */

import { describe, expect, it } from "vitest";

import { runDropper } from "../src/om/agents/dropper/agent.js";
import { runObserver } from "../src/om/agents/observer/agent.js";
import { runReflector } from "../src/om/agents/reflector/agent.js";
import { WorkerStreamError } from "../src/om/retryable-error.js";
import { observation, reflection } from "./fixtures/session.js";

/** Terminal `agent_end` payload the host hands back when the run stops. */
function endMessages(...messages: Array<Record<string, unknown>>) {
  return messages;
}

function assistantStop(stopReason: string, extra: Record<string, unknown> = {}) {
  return { role: "assistant", content: [], stopReason, ...extra };
}

const toolResult = { role: "toolResult", content: [] };

/**
 * Drive the tools the way a real run does, then end the run with an explicit
 * `agent_end` so the completion check sees exactly what a host would deliver.
 */
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
    observation("cccccccccccc", { relevance: "critical" }),
  ],
  budgetTokens: 20,
};

const partialObserverBatch = {
  observations: [
    { content: "Partial observation", relevance: "high", sourceEntryIds: ["entry-a"] },
  ],
  complete: false,
};
const closedObserverBatch = {
  observations: [{ content: "Closed observation", relevance: "high", sourceEntryIds: ["entry-a"] }],
  complete: true,
};
const partialReflectionBatch = {
  reflections: [{ content: "Partial reflection", supportingObservationIds: ["aaaaaaaaaaaa"] }],
  complete: false,
};
const closedReflectionBatch = {
  reflections: [{ content: "Closed reflection", supportingObservationIds: ["aaaaaaaaaaaa"] }],
  complete: true,
};
const dropperBatch = { ids: ["aaaaaaaaaaaa"] };

describe("observer completion strictness", () => {
  it("throws when the run ends on an output-length cut after a partial batch", async () => {
    const error = await runObserver({
      ...observerArgs,
      agentLoop: scriptedLoop([partialObserverBatch], {
        agentEnd: endMessages(assistantStop("length")),
      }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: "Observer API error: Incomplete agent response (length); coverage not advanced.",
      discardedCount: 1,
    });
  });

  it("throws when the run ends on an aborted stop reason after a partial batch", async () => {
    const error = await runObserver({
      ...observerArgs,
      agentLoop: scriptedLoop([partialObserverBatch], {
        agentEnd: endMessages(assistantStop("aborted")),
      }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: "Observer API error: Incomplete agent response (aborted); coverage not advanced.",
      discardedCount: 1,
    });
  });

  it("throws when the run ends on a terminal toolUse with no close and no cap", async () => {
    const error = await runObserver({
      ...observerArgs,
      agentLoop: scriptedLoop([partialObserverBatch], {
        agentEnd: endMessages(assistantStop("toolUse"), toolResult),
      }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: "Observer API error: Incomplete agent response (toolUse); coverage not advanced.",
      discardedCount: 1,
    });
  });

  it("keeps a complete=true close when the loop then ends on the terminating toolUse", async () => {
    const result = await runObserver({
      ...observerArgs,
      agentLoop: scriptedLoop([closedObserverBatch], {
        agentEnd: endMessages(assistantStop("toolUse"), toolResult),
      }),
    });

    expect(result.observations?.map((item) => item.content)).toEqual(["Closed observation"]);
    expect(result.errorAfterClose).toBeUndefined();
  });

  it("reads an error stop reason that sits behind a trailing toolResult", async () => {
    const error = await runObserver({
      ...observerArgs,
      agentLoop: scriptedLoop([partialObserverBatch], {
        agentEnd: endMessages(assistantStop("error", { errorMessage: "boom" }), toolResult),
      }),
    }).catch((caught: unknown) => caught);

    // The decision lives on the last message that HAS a stopReason: a host that
    // ends after the tool receipt must not hide the provider failure behind it.
    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: "Observer API error: boom",
      discardedCount: 1,
    });
  });

  it("throws when the run ends on a deferred stop reason", async () => {
    const error = await runObserver({
      ...observerArgs,
      agentLoop: scriptedLoop([partialObserverBatch], {
        agentEnd: endMessages(assistantStop("deferred")),
      }),
    }).catch((caught: unknown) => caught);

    // Fail closed: only an explicit `stop` (or an exempt tool close) proves
    // the work finished. A deferred response lives behind a fetch handle —
    // the review may never have happened, so the cursor must not advance.
    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: "Observer API error: Incomplete agent response (deferred); coverage not advanced.",
      discardedCount: 1,
    });
  });

  it("throws when the run ends on a pending stop reason", async () => {
    const error = await runObserver({
      ...observerArgs,
      agentLoop: scriptedLoop([partialObserverBatch], {
        agentEnd: endMessages(assistantStop("pending")),
      }),
    }).catch((caught: unknown) => caught);

    // A stuck-at-sentinel stream is a contract violation, not a completion.
    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: "Observer API error: Incomplete agent response (pending); coverage not advanced.",
      discardedCount: 1,
    });
  });

  it("throws with a zero count when an output-length close recorded nothing", async () => {
    const error = await runObserver({
      ...observerArgs,
      agentLoop: scriptedLoop([], { agentEnd: endMessages(assistantStop("length")) }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: "Observer API error: Incomplete agent response (length); coverage not advanced.",
      discardedCount: 0,
    });
  });

  it("reports success when the signal aborts after the run already stopped", async () => {
    const controller = new AbortController();
    controller.abort();

    // A late abort (timeout fire during settle, generation cancel racing the
    // close) must not void completed work: the run stopped on its own, so
    // the completed review is kept with no error attached.
    const result = await runObserver({
      ...observerArgs,
      signal: controller.signal,
      agentLoop: scriptedLoop([partialObserverBatch], {
        agentEnd: endMessages(assistantStop("stop")),
      }),
    });

    expect(result.observations?.map((item) => item.content)).toEqual(["Partial observation"]);
    expect(result.errorAfterClose).toBeUndefined();
  });

  it("still reports the abort when the run never stopped on its own", async () => {
    const controller = new AbortController();
    controller.abort();

    const error = await runObserver({
      ...observerArgs,
      signal: controller.signal,
      agentLoop: scriptedLoop([partialObserverBatch], {
        agentEnd: endMessages(assistantStop("length")),
      }),
    }).catch((caught: unknown) => caught);

    // The stop check only exempts clean stops: a cut-off run on an aborted
    // signal still reports the abort rather than advancing.
    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: "Observer API error: aborted",
      discardedCount: 1,
    });
  });

  it("keeps the partial checkpoint when an output-length cut lands on a capped run", async () => {
    const result = await runObserver({
      ...observerArgs,
      agentLoop: scriptedLoop([partialObserverBatch], {
        capEndsRun: true,
        agentEnd: endMessages(assistantStop("length")),
      }),
      maxTurns: 1,
    });

    // The cap and a non-deterministic length cut are both input-size limits,
    // not provider failures: the recorded batch is kept as a partial checkpoint
    // at its highest cited source entry instead of being discarded.
    expect(result.observations).toHaveLength(1);
    expect(result.partialCoverageId).toBe("entry-a");
  });

  it("still throws the length failure when a capped run recorded nothing", async () => {
    const error = await runObserver({
      ...observerArgs,
      agentLoop: scriptedLoop([], {
        capEndsRun: true,
        agentEnd: endMessages(assistantStop("length")),
      }),
      maxTurns: 1,
    }).catch((caught: unknown) => caught);

    // No recordings: the turn-cap guard has nothing to report, so the length
    // cut stays visible instead of degrading into a silent empty success.
    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: "Observer API error: Incomplete agent response (length); coverage not advanced.",
      discardedCount: 0,
    });
  });
});

describe("reflector completion strictness", () => {
  it("throws when the run ends on an output-length cut after a partial batch", async () => {
    const error = await runReflector({
      ...reflectorArgs,
      agentLoop: scriptedLoop([partialReflectionBatch], {
        agentEnd: endMessages(assistantStop("length")),
      }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: "Reflector API error: Incomplete agent response (length); coverage not advanced.",
      discardedCount: 1,
    });
  });

  it("throws when the run ends on a terminal toolUse with no close and no cap", async () => {
    const error = await runReflector({
      ...reflectorArgs,
      agentLoop: scriptedLoop([partialReflectionBatch], {
        agentEnd: endMessages(assistantStop("toolUse"), toolResult),
      }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: "Reflector API error: Incomplete agent response (toolUse); coverage not advanced.",
      discardedCount: 1,
    });
  });

  it("keeps a complete=true close when the loop then ends on the terminating toolUse", async () => {
    const result = await runReflector({
      ...reflectorArgs,
      agentLoop: scriptedLoop([closedReflectionBatch], {
        agentEnd: endMessages(assistantStop("toolUse"), toolResult),
      }),
    });

    expect(result.reflections?.map((item) => item.content)).toEqual(["Closed reflection"]);
    expect(result.errorAfterClose).toBeUndefined();
  });

  it("surfaces an output-length cut after a close as errorAfterClose instead of dropping it", async () => {
    const result = await runReflector({
      ...reflectorArgs,
      agentLoop: scriptedLoop([closedReflectionBatch], {
        agentEnd: endMessages(assistantStop("length")),
      }),
    });

    expect(result.reflections?.map((item) => item.content)).toEqual(["Closed reflection"]);
    expect(result.errorAfterClose).toBe(
      "Incomplete agent response (length); coverage not advanced.",
    );
  });

  it("throws with a zero count when an output-length close recorded nothing", async () => {
    const error = await runReflector({
      ...reflectorArgs,
      agentLoop: scriptedLoop([], { agentEnd: endMessages(assistantStop("length")) }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: "Reflector API error: Incomplete agent response (length); coverage not advanced.",
      discardedCount: 0,
    });
  });

  it("keeps the turn-cap guard's own message when the capped run ends on its toolUse", async () => {
    const error = await runReflector({
      ...reflectorArgs,
      agentLoop: scriptedLoop([partialReflectionBatch], {
        capEndsRun: true,
        agentEnd: endMessages(assistantStop("toolUse"), toolResult),
      }),
      maxTurns: 1,
    }).catch((caught: unknown) => caught);

    // The cap cutting the run is a config limit reported by the turn-cap guard;
    // the completion check must not claim it as a generic provider failure.
    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error?.message).toContain("turn cap");
    expect(error?.message).not.toContain("Incomplete agent response");
  });

  it("keeps the zero-record empty success when a capped run ends on its toolUse", async () => {
    await expect(
      runReflector({
        ...reflectorArgs,
        agentLoop: scriptedLoop([], {
          capEndsRun: true,
          agentEnd: endMessages(assistantStop("toolUse"), toolResult),
        }),
        maxTurns: 1,
      }),
    ).resolves.toEqual({ reflections: undefined });
  });

  it("routes an output-length cut on a capped run to the turn-cap guard", async () => {
    const error = await runReflector({
      ...reflectorArgs,
      agentLoop: scriptedLoop([partialReflectionBatch], {
        capEndsRun: true,
        agentEnd: endMessages(assistantStop("length")),
      }),
      maxTurns: 1,
    }).catch((caught: unknown) => caught);

    // Same contract as the observer: cap + length is the config limit, and
    // the stage's session-model break-glass keys on turnCapExhausted.
    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error?.message).toContain("turn cap");
    expect(error).toMatchObject({ turnCapExhausted: true, discardedCount: 1 });
  });

  it("reports the stream error rather than the turn cap when both end the run", async () => {
    const error = await runReflector({
      ...reflectorArgs,
      agentLoop: scriptedLoop([partialReflectionBatch], {
        capEndsRun: true,
        agentEnd: endMessages(
          assistantStop("error", { errorMessage: "Stream connection severed" }),
        ),
      }),
      maxTurns: 1,
    }).catch((caught: unknown) => caught);

    // A provider error keeps its own classification (deterministic cooldown
    // depends on its message): error turns never spend budget, so the cap did
    // not cause it, and the run must not masquerade as a config limit.
    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: "Reflector API error: Stream connection severed",
      turnCapExhausted: false,
      discardedCount: 1,
    });
  });

  it("throws when the run ends on a deferred stop reason", async () => {
    const error = await runReflector({
      ...reflectorArgs,
      agentLoop: scriptedLoop([partialReflectionBatch], {
        agentEnd: endMessages(assistantStop("deferred")),
      }),
    }).catch((caught: unknown) => caught);

    // The reflector cursor advances over the whole window: an unfinished
    // evaluation reported as success would permanently skip crystallizing the
    // observations past the cut.
    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: "Reflector API error: Incomplete agent response (deferred); coverage not advanced.",
      discardedCount: 1,
    });
  });
});

describe("dropper completion strictness", () => {
  it("throws when the run ends on an output-length cut after a proposed candidate", async () => {
    const error = await runDropper({
      ...dropperArgs,
      agentLoop: scriptedLoop([dropperBatch], {
        agentEnd: endMessages(assistantStop("length")),
      }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: "Dropper API error: Incomplete agent response (length); coverage not advanced.",
      discardedCount: 1,
    });
  });

  it("throws when the run ends on a terminal toolUse with no cap", async () => {
    const error = await runDropper({
      ...dropperArgs,
      agentLoop: scriptedLoop([dropperBatch], {
        agentEnd: endMessages(assistantStop("toolUse"), toolResult),
      }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: "Dropper API error: Incomplete agent response (toolUse); coverage not advanced.",
      discardedCount: 1,
    });
  });

  it("keeps the turn-cap guard's own message when the capped run ends on its toolUse", async () => {
    const error = await runDropper({
      ...dropperArgs,
      agentLoop: scriptedLoop([dropperBatch], {
        capEndsRun: true,
        agentEnd: endMessages(assistantStop("toolUse"), toolResult),
      }),
      maxTurns: 1,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error?.message).toContain("turn cap");
    expect(error?.message).not.toContain("Incomplete agent response");
  });

  it("keeps the zero-candidate empty success when a capped run ends on its toolUse", async () => {
    await expect(
      runDropper({
        ...dropperArgs,
        agentLoop: scriptedLoop([], {
          capEndsRun: true,
          agentEnd: endMessages(assistantStop("toolUse"), toolResult),
        }),
        maxTurns: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it("routes an output-length cut on a capped run to the turn-cap guard", async () => {
    const error = await runDropper({
      ...dropperArgs,
      agentLoop: scriptedLoop([dropperBatch], {
        capEndsRun: true,
        agentEnd: endMessages(assistantStop("length")),
      }),
      maxTurns: 1,
    }).catch((caught: unknown) => caught);

    // The dropper has no complete flag, but a cap end on a tool-work turn is
    // still the sanctioned config-limit report — not a generic provider cut.
    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error?.message).toContain("turn cap");
    expect(error).toMatchObject({ turnCapExhausted: true, discardedCount: 1 });
  });

  it("reports the stream error rather than the turn cap when both end the run", async () => {
    const error = await runDropper({
      ...dropperArgs,
      agentLoop: scriptedLoop([dropperBatch], {
        capEndsRun: true,
        agentEnd: endMessages(
          assistantStop("error", { errorMessage: "Stream connection severed" }),
        ),
      }),
      maxTurns: 1,
    }).catch((caught: unknown) => caught);

    // Same carve-out as observer/reflector: the provider failure is classified
    // on its own message, never hidden behind the cap.
    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: "Dropper API error: Stream connection severed",
      turnCapExhausted: false,
      discardedCount: 1,
    });
  });

  it("reports success when the signal aborts after the run already stopped", async () => {
    const controller = new AbortController();
    controller.abort();

    // Same contract as the observer: a finished evaluation's proposals are
    // kept when the run stopped on its own — in batch mode discarding them
    // would void the whole run over a benign late cancel.
    const result = await runDropper({
      ...dropperArgs,
      signal: controller.signal,
      agentLoop: scriptedLoop([dropperBatch], {
        agentEnd: endMessages(assistantStop("stop")),
      }),
    });

    expect(result).toEqual(["aaaaaaaaaaaa"]);
  });
});
