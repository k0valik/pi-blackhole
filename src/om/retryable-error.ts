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
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

/** Check whether an error string or Error indicates a retryable error. */
export function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return RETRYABLE_ERROR_RE.test(message);
}

/**
 * Deterministic client errors: retrying the same model cannot succeed without
 * a config/header fix (missing provider-required headers, bad credentials,
 * unknown model, rejected payload). Unlike transient `isRetryableError`
 * failures (same model, later), these must engage the fallback chain and
 * cool the broken model down instead of burning every consolidation cycle.
 *
 * Anchored on explicit signals to avoid false positives from token counts
 * (e.g. "~401-token chunk") — framed codes match with an error framing
 * (`HTTP 400`, `status: 404`, `error: 422`), while bare codes (`403
 * RegionError`, `400 Bad Request`) only match alongside an error signal word
 * somewhere in the message. The preceding-character guard keeps `~401-token`
 * style counts out even when an error word is nearby.
 */
export const DETERMINISTIC_ERROR_RE =
  /MissingSessionID|missing.?session|invalid.?api.?key|unauthorized|HTTP\s+40[014]\b|HTTP\s+4(?:03|22)\b|status\s*:?\s*40[014]\b|status\s*:?\s*4(?:03|22)\b|error\s*:?\s*40[014]\b|error\s*:?\s*4(?:03|22)\b/i;

/** Bare 4xx status in status position (start, or after whitespace/punctuation). */
const BARE_DETERMINISTIC_CODE_RE = /(?:^|[\s:([{="'])(40[014]|403|422)\b/;

/** Error signal word required alongside a bare code (substring match). */
const DETERMINISTIC_SIGNAL_RE =
  /error|fail|missing|forbidden|denied|bad request|not found|unauthorized|invalid/i;

/** Workers whose own framing is prepended to provider error text. */
const WORKER_NAMES = ["Observer", "Reflector", "Dropper"] as const;

/** One of the consolidation workers whose messages reach the classifier. */
export type ConsolidationWorker = (typeof WORKER_NAMES)[number];

/**
 * Build `<worker> API error: <provider text>`. The framing is stripped again
 * in `isDeterministicError`, so building and stripping both read
 * `WORKER_NAMES` and cannot drift apart the way two literals would.
 */
export function workerStreamErrorMessage(
  worker: ConsolidationWorker,
  providerText: string,
): string {
  return `${worker} API error: ${providerText}`;
}

/** The framing `workerStreamErrorMessage` adds, anchored at the start only. */
const WORKER_FRAMING_RE = new RegExp(`^(?:${WORKER_NAMES.join("|")}) API error: `);

/**
 * A consolidation worker (observer, reflector, dropper) run that ended before
 * it settled its work, discarding whatever it had already recorded. The message
 * stays that worker's own `… API error: …` text (or names the turn cap) so the
 * regex classification below is unchanged; the count of records written before
 * the failure travels out of band, where no classifier can misread it as a
 * status code. It lives here rather than in the agent modules so consolidation
 * can read it without a static import of the lazily loaded workers.
 */
export class WorkerStreamError extends Error {
  constructor(
    message: string,
    readonly discardedCount: number,
    /** True when the agent turn cap cut the run off instead of a stream failure. */
    readonly turnCapExhausted = false,
    /**
     * True when the run ended on an output-length cut (`length`) rather than a
     * provider failure. Like the turn cap this is input-size-dependent, not a
     * broken model: retrying the identical input burns every attempt, so the
     * stage's session-model break-glass treats it the same way. Set by the
     * agents from the terminal stopReason; never inferred from message text.
     */
    readonly lengthCut = false,
  ) {
    super(message);
    this.name = "WorkerStreamError";
  }
}

/**
 * A symbol rather than a field so the count cannot collide with an error's own
 * properties and cannot surface when the error is spread into a log payload.
 */
const DISCARDED_COUNT = Symbol.for("pi-blackhole.discardedCount");

function isAttachable(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

/**
 * Attach the count of records a run is discarding to the value it is
 * rethrowing, then return that value unchanged. Deliberately not wrapped in
 * `WorkerStreamError`: the consolidation stage's catch switches on the identity
 * of stale-context and timeout errors, and replacing one with a stream error
 * would send it down the cooldown path instead of aborting or breaking.
 */
export function withDiscardedCount<T>(thrown: T, count: number): T {
  if (isAttachable(thrown)) {
    try {
      Object.defineProperty(thrown, DISCARDED_COUNT, {
        value: count,
        enumerable: false,
        configurable: true,
      });
    } catch {
      // Frozen or proxy-blocked: losing the count costs less than losing the
      // failure it describes.
    }
  }
  return thrown;
}

/** Records a worker stream error discarded, or undefined for any other error. */
export function getDiscardedCount(error: unknown): number | undefined {
  if (error instanceof WorkerStreamError) return error.discardedCount;
  if (isAttachable(error)) {
    const attached: unknown = Reflect.get(error, DISCARDED_COUNT);
    if (typeof attached === "number") return attached;
  }
  return undefined;
}

/** Check whether an error is a deterministic client error (see above). */
export function isDeterministicError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  if (DETERMINISTIC_ERROR_RE.test(message)) return true;
  // The worker's `… API error: ` framing is not provider text. Leaving it in
  // would let the word "error" satisfy DETERMINISTIC_SIGNAL_RE on every message
  // these workers produce, so BARE_DETERMINISTIC_CODE_RE alone would decide and
  // a status-shaped token anywhere in the body (`processed 401 rows`) would cool
  // the model for an hour. DETERMINISTIC_ERROR_RE above still sees the framing,
  // which is what makes a bare code that *opens* the provider text — a status
  // line — read as the status it is.
  const providerText = message.replace(WORKER_FRAMING_RE, "");
  return (
    BARE_DETERMINISTIC_CODE_RE.test(providerText) && DETERMINISTIC_SIGNAL_RE.test(providerText)
  );
}

/**
 * Cooldown-worthy errors: transient (retry the same model later) or
 * deterministic (try a fallback now, cool the broken model). The consolidation
 * pipeline observes both axes (`cooldownWorthy` in stage error debug logs);
 * candidate cooldowns are recorded regardless, while deterministic failures
 * additionally cool the resolved session model via `recordDeterministicError`.
 */
export function isCooldownWorthyError(error: unknown): boolean {
  return isRetryableError(error) || isDeterministicError(error);
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
