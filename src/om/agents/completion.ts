/**
 * Completion strictness shared by the three consolidation workers (F2 of
 * work_docs/plan-observer-coverage-completion.md).
 *
 * A worker's `agent_end` messages prove completion only when the model stopped
 * on its own (`stop`) or the terminating tool batch closed the work. `length`
 * (output cap), `aborted`, and a terminal `toolUse` without a complete close
 * mean the review/evaluation was cut off mid-flight — reporting success would
 * advance the coverage cursor over work that never happened.
 *
 * `completedByTool`: the run ended through a mechanism the stage already
 * reports itself — for the observer/reflector the `complete=true` close
 * (`closedByCompleteBatch`), for any worker the turn cap cutting the run on a
 * tool-work turn (`turnCap.exhausted`), which the guards below surface through
 * their own `turn cap exhausted` message. Only `toolUse` gets that exemption:
 * an `error`/`length` trailing a close stays visible to the caller as
 * `errorAfterClose`, and a hard-exit reason can never coincide with the cap
 * (turn-cap.ts never counts `error`/`aborted` turns, and a capped turn with no
 * tool results never sets `exhausted`).
 *
 * Fail-closed allowlist: only an explicit `stop` (or an exempt tool close
 * above) proves the work finished. `length`, `aborted`, an unexempt terminal
 * `toolUse`, and any other reason a host reports (`deferred`, `pending`, or
 * anything a future provider adds) fail the run — every success-shaped
 * terminal the pi loop can produce on completed work ends `stop` or exempt
 * `toolUse` (idle turns end `stop`; closed/capped tool turns end `toolUse`
 * with completedByTool), so anything else denotes an outcome the cursor must
 * not advance over. A run that stopped on its own is success even if the
 * attempt signal aborted in the settle window: a late timeout/cancel must
 * not void completed work.
 *
 * The lookup reverse-finds the last message that HAS a stopReason: a host that
 * ends the run after a tool receipt leaves a `toolResult` (no stopReason) at
 * the tail, and the decision lives on the assistant message behind it.
 */
function lastMessageWithStopReason<T extends { stopReason?: string }>(
  messages: readonly T[],
): T | undefined {
  return [...messages].reverse().find((message) => typeof message?.stopReason === "string");
}

/**
 * The last `stopReason` the host reported on this run, if any. Agents read
 * this alongside `agentCompletionError` to rank overlapping failures: a
 * provider `error` keeps its own classification (deterministic cooldown
 * depends on its message) even when the turn cap had fired earlier — `error`
 * turns never spend budget, so the cap did not cause them.
 */
export function agentFailureStopReason(
  messages: readonly { stopReason?: string }[],
): string | undefined {
  return lastMessageWithStopReason(messages)?.stopReason;
}

export function agentCompletionError(
  messages: readonly { stopReason?: string; errorMessage?: string }[],
  signal?: AbortSignal,
  completedByTool = false,
): string | undefined {
  const last = lastMessageWithStopReason(messages);
  // A run that stopped on its own finished: report success even if the
  // attempt signal aborted in the settle window.
  if (last?.stopReason === "stop") return undefined;
  if (signal?.aborted) return "aborted";
  if (!last?.stopReason) return undefined;
  // A terminating tool batch the stage already reports itself (a complete=true
  // close, or the turn cap cutting the run on a tool-work turn) is a
  // sanctioned ending, not a cut-off evaluation.
  if (last.stopReason === "toolUse" && completedByTool) return undefined;
  // Byte-identical to the pre-existing error fallback: isDeterministicError
  // strips the worker framing and scans the rest for bare 4xx codes, so the
  // text must not drift on the path that already existed.
  if (last.stopReason === "error") return last.errorMessage ?? "Unknown API error";
  return (
    last.errorMessage ?? `Incomplete agent response (${last.stopReason}); coverage not advanced.`
  );
}
