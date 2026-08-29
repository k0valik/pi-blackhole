/**
 * Shared retryable-error regex and detection function.
 *
 * Extracted from compaction-trigger.ts and cooldown.ts which had diverging
 * copies of the same logic. This is the single source of truth.
 *
 * Now also re-exports Pi's context-overflow detection from @earendil-works/pi-ai,
 * avoiding the need to duplicate 20+ provider-specific overflow patterns.
 */

/** Regex matching retryable API error messages. */
export const RETRYABLE_ERROR_RE =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

/** Check whether an error string or Error indicates a retryable error. */
export function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return RETRYABLE_ERROR_RE.test(message);
}

/** Detect Pi's "extension ctx is stale" error from session replacement/reload.
 *  These are not model errors and must not be recorded as cooldowns. */
export function isStaleExtensionContextError(error: unknown): boolean {
  let message: string;
  if (error instanceof Error) {
    message = error.message;
  } else if (error && typeof error === "object" && "message" in error) {
    message = String((error as { message: unknown }).message);
  } else {
    message = String(error || "");
  }
  return message.includes("extension ctx is stale") || message.includes("ctx is stale");
}
