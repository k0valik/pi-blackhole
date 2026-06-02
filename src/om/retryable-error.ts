/**
 * Shared retryable-error utilities.
 *
 * Combines blackhole's retryable error patterns with Pi's context-overflow
 * detection from @earendil-works/pi-ai, to avoid duplicating provider-specific
 * overflow patterns.
 */

/** Regex matching retryable API error messages. */
export const RETRYABLE_ERROR_RE =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

/** Check whether an error string or Error indicates a retryable error. */
export function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return RETRYABLE_ERROR_RE.test(message);
}

/**
 * Re-export Pi's context-overflow detection so blackhole callers use one
 * authoritative source instead of rolling their own provider-specific regexes.
 * @see @earendil-works/pi-ai/dist/utils/overflow.d.ts
 */
export { isContextOverflow } from "@earendil-works/pi-ai";
