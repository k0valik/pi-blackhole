/**
 * Cross-generation turn cap for the OM agent loops.
 *
 * Pi <= 0.86 caps a run with `shouldStopAfterTurn`, a boolean predicate called
 * after each completed turn; returning truthy ends the run. Pi 0.87 removed that
 * option in favour of `finishTurn`, which ends the run by returning
 * `{ action: "end" }`. A host ignores the option it does not know, so the cap
 * emits both and lets the loaded Pi generation pick its own: emitting only
 * `shouldStopAfterTurn` silently dropped the `agentMaxTurns` budget on 0.87,
 * where workers ran until they stopped naturally, errored, or were aborted.
 *
 * Each hook counts separately, so a host that calls both still ends the run after
 * `maxTurns` turns instead of half of them. A turn that already hard-exited
 * (`error` or `aborted`) is never a decision and never spends budget: the loop
 * aborts those runs itself, and the cap only governs completed turns.
 *
 * See https://github.com/elpapi42/pi-observational-memory/pull/83.
 */
import type { AgentTurnDecision } from "@earendil-works/pi-agent-core";

/** Completed-turn payload shared by Pi 0.86 `ShouldStopAfterTurnContext` and 0.87 `AgentTurnContext`. */
export interface TurnCapContext {
  message?: { stopReason?: string };
  /**
   * Tool results produced by the ended turn. Pi 0.87 populates this on every
   * `finishTurn` call (empty when the model produced no tool calls); a legacy
   * 0.86 host may omit it, in which case the cap assumes the turn did work.
   */
  toolResults?: readonly unknown[];
}

/** Pi <= 0.86 turn hook. Absent from the 0.87 `AgentLoopConfig` type, like the loop's `fetch` option. */
export type LegacyTurnCapOption = {
  shouldStopAfterTurn?: (context: TurnCapContext) => boolean;
};

export interface TurnCap {
  /** Pi <= 0.86 hook: truthy ends the run. */
  shouldStopAfterTurn: (context: TurnCapContext) => boolean;
  /** Pi 0.87 hook: `{ action: "end" }` ends the run, `undefined` keeps normal scheduling. */
  finishTurn: (context: TurnCapContext) => AgentTurnDecision | undefined;
  /**
   * True once either hook has ended the run on a turn that did tool work.
   * Hard-exited turns (`error`/`aborted`) never set it: the loop ends
   * those runs itself, so the cap was not the cause. A cap turn with no tool
   * results (the model stopped naturally on exactly its last allowed turn)
   * also leaves it unset: the run still ends, but downstream must read it as
   * a natural stop, not as the cap cutting off pending work. A legacy host
   * that omits `toolResults` is assumed to have done work (previous behavior).
   */
  readonly exhausted: boolean;
}

/**
 * Turn cap a loop spreads into its `AgentLoopConfig` when `maxTurns` is configured.
 *
 * @param maxTurns Completed turns allowed before the cap ends the run. Must be a
 *   positive integer: `0`/`-1` would end the run on its first turn and `NaN`
 *   would disable the cap entirely, so callers omit the cap instead of passing
 *   a non-positive value. Resolved config already guarantees the contract
 *   (`positiveInt` normalization of `agentMaxTurns`), so this only fires on a
 *   programming error.
 * @throws {RangeError} When `maxTurns` is not a positive integer.
 */
export function createTurnCap(maxTurns: number): TurnCap {
  if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
    throw new RangeError(`createTurnCap requires a positive integer turn cap, got ${maxTurns}`);
  }

  let legacyTurns = 0;
  let finishTurns = 0;
  let exhausted = false;

  const hardExited = (context: TurnCapContext): boolean => {
    const stopReason = context.message?.stopReason;
    return stopReason === "error" || stopReason === "aborted";
  };

  // A turn that produced no tool results is a model that stopped on its own,
  // not pending work the cap truncated. Pi 0.87 always sends `toolResults`
  // (possibly empty); a host that omits the field predates the distinction,
  // so assume work to preserve the previous behavior there.
  const didToolWork = (context: TurnCapContext): boolean => {
    if (!("toolResults" in context) || context.toolResults === undefined) return true;
    return context.toolResults.length > 0;
  };

  return {
    shouldStopAfterTurn: (context) => {
      if (hardExited(context)) return false;
      legacyTurns++;
      if (legacyTurns < maxTurns) return false;
      if (didToolWork(context)) exhausted = true;
      return true;
    },
    finishTurn: (context) => {
      if (hardExited(context)) return undefined;
      finishTurns++;
      if (finishTurns < maxTurns) return undefined;
      if (didToolWork(context)) exhausted = true;
      return { action: "end" };
    },
    get exhausted() {
      return exhausted;
    },
  };
}
