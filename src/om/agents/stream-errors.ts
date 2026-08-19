/**
 * Stream-error visibility for consolidation agents (plan-02).
 *
 * Consolidation agents drain agent-loop events; failures surface as
 * `message_end` / `agent_end` events carrying a message whose stopReason is
 * "error" or "aborted".  This helper turns those into a `${stage}.stream_error`
 * debug event plus an optional onError callback (wired to the runtime's
 * last-* stage error fields).
 */
import { debugLog } from "../debug-log.js";

export type StreamErrorStage = "observer" | "reflector" | "dropper";

export type AgentStreamEvent = {
  type: string;
  stopReason?: unknown;
  errorMessage?: unknown;
  message?: unknown;
  messages?: unknown[];
};

/** Returns the failure message when the event carries a failed or aborted
 *  stream termination, otherwise undefined.  Logs `${stage}.stream_error` and
 *  invokes `onError` when a failure is detected. */
export function logAgentStreamError(
  stage: StreamErrorStage,
  event: AgentStreamEvent,
  onError?: (message: string) => void,
): string | undefined {
  const messages = (event.messages ?? []).map(
    (m) => m as { stopReason?: unknown; errorMessage?: unknown },
  );
  const eventMessage = event.message as
    { stopReason?: unknown; errorMessage?: unknown } | undefined;
  const stopReason = [
    event.stopReason,
    eventMessage?.stopReason,
    ...messages.map((m) => m.stopReason),
  ].find((s) => s === "error" || s === "aborted");
  if (stopReason === undefined) return undefined;

  const lastMessage = messages.at(-1) ?? eventMessage;
  const errorMessage =
    typeof lastMessage?.errorMessage === "string"
      ? lastMessage.errorMessage
      : undefined;
  const message =
    errorMessage ?? `Agent stream ended with stopReason "${stopReason}"`;
  debugLog(`${stage}.stream_error`, { stopReason, message });
  onError?.(message);
  return message;
}
