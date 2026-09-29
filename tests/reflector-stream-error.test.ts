/**
 * Reflector failure guard — mirrors tests/observer.test.ts.
 *
 * The reflector stage records whatever `runReflector` returns and advances the
 * reflector cursor to the observation coverage marker, so a run that failed
 * before it closed the review must not report its partial reflections as
 * success: the observations behind them would never be crystallized again.
 */

import { describe, expect, it } from "vitest";

import { runReflector } from "../src/om/agents/reflector/agent.js";
import {
  getDiscardedCount,
  isDeterministicError,
  isRetryableError,
  WorkerStreamError,
} from "../src/om/retryable-error.js";
import { observation } from "./fixtures/session.js";

describe("runReflector failure guard", () => {
  const baseArgs = {
    model: {} as any,
    apiKey: "test",
    reflections: [],
    observations: [observation("aaaaaaaaaaaa"), observation("bbbbbbbbbbbb")],
  };

  function reflectionBatch(content: string, complete: boolean) {
    return {
      reflections: [{ content, supportingObservationIds: ["aaaaaaaaaaaa"] }],
      complete,
    };
  }

  /**
   * Drive the tool the way a real run does, then optionally end the run the way
   * the host would when the turn cap or the provider cuts it off.
   */
  function scriptedLoop(
    batches: ReadonlyArray<Record<string, unknown>>,
    options: {
      capEndsRun?: boolean;
      legacyCapEndsRun?: boolean;
      capQuietTail?: boolean;
      agentError?: string;
      streamFailure?: unknown;
    } = {},
  ) {
    return ((_prompts: any[], context: any, config: any) => ({
      async *[Symbol.asyncIterator]() {
        for (const [index, batch] of batches.entries()) {
          await context.tools[0].execute(`call-${index}`, batch);
        }
        if (options.streamFailure !== undefined) throw options.streamFailure;
        if (options.capEndsRun) {
          config.finishTurn?.({ message: { stopReason: "toolUse" } });
        }
        // Legacy variant: drives shouldStopAfterTurn so the test fails if the
        // agent stops spreading the 0.86 hook into its loop config.
        if (options.legacyCapEndsRun) {
          config.shouldStopAfterTurn?.({ message: { stopReason: "toolUse" } });
        }
        if (options.capQuietTail) {
          config.finishTurn?.({ message: { stopReason: "stop" }, toolResults: [] });
        }
        if (options.agentError !== undefined) {
          yield {
            type: "agent_end",
            messages: [
              {
                role: "assistant",
                content: [],
                stopReason: "error",
                errorMessage: options.agentError,
              },
            ],
          };
        }
      },
      result: async () => ({}),
    })) as any;
  }

  it("throws when a trailing turn errors before the review closed", async () => {
    const error = await runReflector({
      ...baseArgs,
      agentLoop: scriptedLoop([reflectionBatch("Partial reflection", false)], {
        agentError: "Stream connection severed",
      }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: "Reflector API error: Stream connection severed",
      discardedCount: 1,
    });
  });

  it("throws with a zero count when the run recorded nothing before the error", async () => {
    const error = await runReflector({
      ...baseArgs,
      agentLoop: scriptedLoop([], { agentError: "Stream connection severed" }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({ discardedCount: 0 });
  });

  it("keeps a complete=true close when a later turn errors on a host that ignores terminate", async () => {
    const result = await runReflector({
      ...baseArgs,
      agentLoop: scriptedLoop([reflectionBatch("Closed reflection", true)], {
        agentError: "Stream connection severed",
      }),
    });

    expect(result.reflections?.map((item) => item.content)).toEqual(["Closed reflection"]);
  });

  it("returns the trailing failure as errorAfterClose instead of swallowing it", async () => {
    const result = await runReflector({
      ...baseArgs,
      agentLoop: scriptedLoop([reflectionBatch("Closed reflection", true)], {
        agentError: "Stream connection severed",
      }),
    });

    expect(result.errorAfterClose).toBe("Stream connection severed");
  });

  it("passes a bare provider code through errorAfterClose for stage classification", async () => {
    const result = await runReflector({
      ...baseArgs,
      agentLoop: scriptedLoop([reflectionBatch("Closed reflection", true)], {
        agentError: "401",
      }),
    });

    expect(result.reflections).toHaveLength(1);
    expect(result.errorAfterClose).toBe("401");
  });

  it("retracts the close when a later batch records new reflections", async () => {
    const error = await runReflector({
      ...baseArgs,
      agentLoop: scriptedLoop(
        [reflectionBatch("Closed reflection", true), reflectionBatch("Another one", false)],
        { agentError: "Stream connection severed" },
      ),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({ discardedCount: 2 });
  });

  it("throws when the turn cap ends a run that never closed", async () => {
    const error = await runReflector({
      ...baseArgs,
      agentLoop: scriptedLoop([reflectionBatch("Partial reflection", false)], {
        capEndsRun: true,
      }),
      maxTurns: 1,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: expect.stringContaining("turn cap"),
      discardedCount: 1,
    });
  });

  it("keeps a complete=true close when the turn cap fires after it", async () => {
    const result = await runReflector({
      ...baseArgs,
      agentLoop: scriptedLoop([reflectionBatch("Closed reflection", true)], {
        capEndsRun: true,
      }),
      maxTurns: 1,
    });

    expect(result.reflections?.map((item) => item.content)).toEqual(["Closed reflection"]);
    expect(result.errorAfterClose).toBeUndefined();
  });

  it("keeps a partial batch when the cap turn did no tool work", async () => {
    const result = await runReflector({
      ...baseArgs,
      agentLoop: scriptedLoop([reflectionBatch("Partial reflection", false)], {
        capQuietTail: true,
      }),
      maxTurns: 1,
    });

    expect(result.reflections).toHaveLength(1);
    expect(result.errorAfterClose).toBeUndefined();
  });

  it("returns undefined reflections when the turn cap cuts a run that recorded nothing", async () => {
    await expect(
      runReflector({
        ...baseArgs,
        agentLoop: scriptedLoop([], { capEndsRun: true }),
        maxTurns: 1,
      }),
    ).resolves.toEqual({ reflections: undefined });
  });

  it("throws on a trailing error even when the capped run recorded nothing", async () => {
    const error = await runReflector({
      ...baseArgs,
      agentLoop: scriptedLoop([], { capEndsRun: true, agentError: "Stream connection severed" }),
      maxTurns: 1,
    }).catch((caught: unknown) => caught);

    // A trailing provider error beats the zero-record cap empty-success: the
    // review never completed cleanly, so the stage must not advance the
    // reflector cursor over uncrystallized observations.
    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: "Reflector API error: Stream connection severed",
      discardedCount: 0,
    });
  });

  it("throws when the legacy turn-cap hook ends a run that never closed", async () => {
    const error = await runReflector({
      ...baseArgs,
      agentLoop: scriptedLoop([reflectionBatch("Partial reflection", false)], {
        legacyCapEndsRun: true,
      }),
      maxTurns: 1,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: expect.stringContaining("turn cap"),
      discardedCount: 1,
    });
  });

  it("does not classify turn-cap exhaustion as a provider error", async () => {
    const error = await runReflector({
      ...baseArgs,
      agentLoop: scriptedLoop([reflectionBatch("Partial reflection", false)], {
        capEndsRun: true,
      }),
      maxTurns: 1,
    }).catch((caught: unknown) => caught);

    // `agentMaxTurns` is a config limit, so it must neither cool the model as
    // deterministic nor look retryable to the cooldown classifier.
    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(isDeterministicError(error)).toBe(false);
    expect(isRetryableError(error)).toBe(false);
  });

  // A stream that breaks outright never produces agent_end, so the run's guard
  // never runs — but the reflections it had already recorded still exist.
  it("reports the records a raw stream failure discarded", async () => {
    const failure = new Error("stream blew up");
    const error = await runReflector({
      ...baseArgs,
      agentLoop: scriptedLoop([reflectionBatch("Partial reflection", false)], {
        streamFailure: failure,
      }),
    }).catch((caught: unknown) => caught);

    expect(error).toBe(failure);
    expect(getDiscardedCount(error)).toBe(1);
  });

  it("reports a zero count when the stream fails before anything was recorded", async () => {
    const failure = new Error("stream blew up");
    const error = await runReflector({
      ...baseArgs,
      agentLoop: scriptedLoop([], { streamFailure: failure }),
    }).catch((caught: unknown) => caught);

    expect(error).toBe(failure);
    expect(getDiscardedCount(error)).toBe(0);
  });
});
