/**
 * Dropper failure guard — mirrors tests/observer.test.ts and
 * tests/reflector-stream-error.test.ts.
 *
 * The dropper has no complete=true close: every candidate it proposes is
 * recorded, and the stage then writes an OM_OBSERVATIONS_DROPPED marker over
 * the observation coverage window. A run that failed halfway therefore must not
 * report its prefix as a finished evaluation — the observations it had not got
 * to would never be evaluated again by a cadence run.
 */

import { describe, expect, it } from "vitest";

import { runDropper } from "../src/om/agents/dropper/agent.js";
import {
  getDiscardedCount,
  isDeterministicError,
  isRetryableError,
  WorkerStreamError,
} from "../src/om/retryable-error.js";
import { observation, reflection } from "./fixtures/session.js";

describe("runDropper failure guard", () => {
  const baseArgs = {
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

  it("throws when a trailing turn errors after candidates were proposed", async () => {
    const error = await runDropper({
      ...baseArgs,
      agentLoop: scriptedLoop([{ ids: ["aaaaaaaaaaaa"] }], {
        agentError: "Stream connection severed",
      }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: "Dropper API error: Stream connection severed",
      discardedCount: 1,
    });
  });

  it("has no kept-close path: a trailing error always throws instead of returning", async () => {
    const error = await runDropper({
      ...baseArgs,
      agentLoop: scriptedLoop([{ ids: ["aaaaaaaaaaaa"] }], {
        agentError: "Stream connection severed",
      }),
    }).catch((caught: unknown) => caught);

    // `drop_observations` carries no complete flag, so unlike the observer and
    // reflector there is no `errorAfterClose` to return — parity holds via the
    // exception path, which the stage cools like any other worker failure.
    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).not.toHaveProperty("errorAfterClose");
  });

  it("carries a zero count when the run proposed nothing before the error", async () => {
    const error = await runDropper({
      ...baseArgs,
      agentLoop: scriptedLoop([], { agentError: "Stream connection severed" }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({ discardedCount: 0 });
  });

  it("throws when the turn cap ends a run that proposed candidates", async () => {
    const error = await runDropper({
      ...baseArgs,
      agentLoop: scriptedLoop([{ ids: ["aaaaaaaaaaaa"] }], { capEndsRun: true }),
      maxTurns: 1,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: expect.stringContaining("turn cap"),
      discardedCount: 1,
    });
  });

  it("returns undefined when the turn cap cuts a run that proposed nothing", async () => {
    await expect(
      runDropper({
        ...baseArgs,
        agentLoop: scriptedLoop([], { capEndsRun: true }),
        maxTurns: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps a complete evaluation that stopped naturally on its last allowed turn", async () => {
    await expect(
      runDropper({
        ...baseArgs,
        agentLoop: scriptedLoop([{ ids: ["aaaaaaaaaaaa"] }], { capQuietTail: true }),
        maxTurns: 1,
      }),
    ).resolves.toEqual(["aaaaaaaaaaaa"]);
  });

  it("throws the trailing error rather than the turn cap when a capped run proposed nothing", async () => {
    const error = await runDropper({
      ...baseArgs,
      agentLoop: scriptedLoop([], { capEndsRun: true, agentError: "Stream connection severed" }),
      maxTurns: 1,
    }).catch((caught: unknown) => caught);

    // The provider error precedes the cap guard, so a capped run that also
    // failed reports the failure (with its zero discarded count) instead of
    // an empty success the stage would advance the cursor over.
    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: "Dropper API error: Stream connection severed",
      discardedCount: 0,
    });
  });

  it("throws when the legacy turn-cap hook ends a run that proposed candidates", async () => {
    const error = await runDropper({
      ...baseArgs,
      agentLoop: scriptedLoop([{ ids: ["aaaaaaaaaaaa"] }], { legacyCapEndsRun: true }),
      maxTurns: 1,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: expect.stringContaining("turn cap"),
      discardedCount: 1,
    });
  });

  it("does not classify turn-cap exhaustion as a provider error", async () => {
    const error = await runDropper({
      ...baseArgs,
      agentLoop: scriptedLoop([{ ids: ["aaaaaaaaaaaa"] }], { capEndsRun: true }),
      maxTurns: 1,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(isDeterministicError(error)).toBe(false);
    expect(isRetryableError(error)).toBe(false);
  });

  // A stream that breaks outright never produces agent_end, so the run's guard
  // never runs — but the candidates it had already proposed still exist.
  it("reports the candidates a raw stream failure discarded", async () => {
    const failure = new Error("stream blew up");
    const error = await runDropper({
      ...baseArgs,
      agentLoop: scriptedLoop([{ ids: ["aaaaaaaaaaaa"] }], { streamFailure: failure }),
    }).catch((caught: unknown) => caught);

    expect(error).toBe(failure);
    expect(getDiscardedCount(error)).toBe(1);
  });

  it("reports a zero count when the stream fails before anything was proposed", async () => {
    const failure = new Error("stream blew up");
    const error = await runDropper({
      ...baseArgs,
      agentLoop: scriptedLoop([], { streamFailure: failure }),
    }).catch((caught: unknown) => caught);

    expect(error).toBe(failure);
    expect(getDiscardedCount(error)).toBe(0);
  });
});
