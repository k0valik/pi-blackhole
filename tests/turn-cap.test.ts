/**
 * Turn-cap tests for the OM agent loops across Pi's turn-hook generations.
 *
 * Pi <= 0.86 caps a run with `shouldStopAfterTurn`, a boolean predicate.
 * Pi 0.87 removed that option and added `finishTurn`, whose `{ action: "end" }`
 * decision ends the run. The cap emits both options with independent counters so
 * whichever hook the loaded host calls enforces the same `agentMaxTurns` budget;
 * these tests pin the contract each host relies on.
 */
import { describe, expect, it } from "vitest";

import { createTurnCap } from "../src/om/agents/turn-cap.js";

/** A completed turn that did not hard-exit and may be followed by another request. */
const completedTurn = { message: { stopReason: "toolUse" } };
const errorTurn = { message: { stopReason: "error" } };
const abortedTurn = { message: { stopReason: "aborted" } };

describe("createTurnCap", () => {
  it("keeps the run going until the 0.87 finishTurn hook reaches the cap", () => {
    const cap = createTurnCap(3);

    expect(cap.finishTurn(completedTurn)).toBeUndefined();
    expect(cap.finishTurn(completedTurn)).toBeUndefined();
    expect(cap.finishTurn(completedTurn)).toEqual({ action: "end" });
  });

  it("keeps the run going until the 0.86 shouldStopAfterTurn hook reaches the cap", () => {
    const cap = createTurnCap(2);

    expect(cap.shouldStopAfterTurn(completedTurn)).toBe(false);
    expect(cap.shouldStopAfterTurn(completedTurn)).toBe(true);
  });

  it("ends on the first completed turn when the cap is one", () => {
    expect(createTurnCap(1).finishTurn(completedTurn)).toEqual({ action: "end" });
  });

  it.each([0, -1, Number.NaN, 1.5])("rejects an invalid turn cap (%s)", (maxTurns) => {
    expect(() => createTurnCap(maxTurns)).toThrow(RangeError);
  });

  it("names the offending value when it rejects a turn cap", () => {
    expect(() => createTurnCap(0)).toThrow(
      "createTurnCap requires a positive integer turn cap, got 0",
    );
  });

  it("leaves an error response undecided on the finishTurn hook", () => {
    expect(createTurnCap(1).finishTurn(errorTurn)).toBeUndefined();
  });

  it("leaves an aborted response undecided on the finishTurn hook", () => {
    expect(createTurnCap(1).finishTurn(abortedTurn)).toBeUndefined();
  });

  it("leaves an error response undecided on the shouldStopAfterTurn hook", () => {
    expect(createTurnCap(1).shouldStopAfterTurn(errorTurn)).toBe(false);
  });

  it("leaves an aborted response undecided on the shouldStopAfterTurn hook", () => {
    expect(createTurnCap(1).shouldStopAfterTurn(abortedTurn)).toBe(false);
  });

  it("does not spend the finishTurn budget on an error response", () => {
    const cap = createTurnCap(1);

    expect(cap.finishTurn(errorTurn)).toBeUndefined();
    expect(cap.finishTurn(completedTurn)).toEqual({ action: "end" });
  });

  it("does not spend the shouldStopAfterTurn budget on an aborted response", () => {
    const cap = createTurnCap(1);

    expect(cap.shouldStopAfterTurn(abortedTurn)).toBe(false);
    expect(cap.shouldStopAfterTurn(completedTurn)).toBe(true);
  });

  it("caps each hook on its own when a host calls both", () => {
    const cap = createTurnCap(2);

    expect(cap.finishTurn(completedTurn)).toBeUndefined();
    expect(cap.shouldStopAfterTurn(completedTurn)).toBe(false);
    expect(cap.finishTurn(completedTurn)).toEqual({ action: "end" });
    expect(cap.shouldStopAfterTurn(completedTurn)).toBe(true);
  });

  it("counts a turn without a message as a completed turn", () => {
    expect(createTurnCap(1).finishTurn({})).toEqual({ action: "end" });
  });

  it("reports exhaustion only once a hook actually ends the run", () => {
    const cap = createTurnCap(2);

    expect(cap.exhausted).toBe(false);
    cap.finishTurn(completedTurn);
    expect(cap.exhausted).toBe(false);
    cap.finishTurn(completedTurn);
    expect(cap.exhausted).toBe(true);
  });

  it("reports exhaustion from the 0.86 shouldStopAfterTurn hook", () => {
    const cap = createTurnCap(1);

    expect(cap.shouldStopAfterTurn(completedTurn)).toBe(true);
    expect(cap.exhausted).toBe(true);
  });

  it("never reports exhaustion for hard-exited turns", () => {
    const cap = createTurnCap(1);

    cap.finishTurn(errorTurn);
    cap.finishTurn(abortedTurn);
    cap.shouldStopAfterTurn(errorTurn);
    cap.shouldStopAfterTurn(abortedTurn);

    expect(cap.exhausted).toBe(false);
  });

  it("does not report exhaustion before the cap is reached", () => {
    const cap = createTurnCap(3);

    cap.finishTurn(completedTurn);
    cap.shouldStopAfterTurn(completedTurn);

    expect(cap.exhausted).toBe(false);
  });

  it("ends the run without exhaustion when the cap turn did no tool work", () => {
    const cap = createTurnCap(1);
    const quietTurn = { message: { stopReason: "stop" }, toolResults: [] };

    expect(cap.finishTurn(quietTurn)).toEqual({ action: "end" });
    expect(cap.exhausted).toBe(false);
  });

  it("reports exhaustion when the cap turn produced tool results", () => {
    const cap = createTurnCap(1);
    const workingTurn = { message: { stopReason: "toolUse" }, toolResults: [{}] };

    expect(cap.finishTurn(workingTurn)).toEqual({ action: "end" });
    expect(cap.exhausted).toBe(true);
  });

  it("leaves shouldStopAfterTurn undecided-exhaustion on a quiet cap turn", () => {
    const cap = createTurnCap(1);
    const quietTurn = { message: { stopReason: "stop" }, toolResults: [] };

    expect(cap.shouldStopAfterTurn(quietTurn)).toBe(true);
    expect(cap.exhausted).toBe(false);
  });

  it("assumes work when a legacy host omits toolResults", () => {
    const cap = createTurnCap(1);
    cap.finishTurn(completedTurn);
    expect(cap.exhausted).toBe(true);
  });
});
