/**
 * Shared retryable-error regex and detection function.
 *
 * Extracted from compaction-trigger.ts and cooldown.ts which had diverging
 * copies of the same logic. This is the single source of truth.
 *
 * Now also re-exports Pi's context-overflow detection from @earendil-works/pi-ai,
 * avoiding the need to duplicate 20+ provider-specific overflow patterns.
 */

import { isContextOverflow } from "@earendil-works/pi-ai";

/** Rate-limit, quota, billing and payment failures (same long cooldown). */
const RATE_LIMIT_ERROR_SOURCE = [
  "rate.?limit",
  "rate increased too quickly",
  "too[ _-]?many[ _-]?requests",
  "\\b429\\b",
  "quota",
  "insufficient[ _-]?(?:quota|balance|credit|funds)",
  "credit[ _-]?balance",
  "credit[ _-]?limit",
  "out of credits",
  "spend[ _-]?(?:limit|cap)",
  "budget[ _-]?(?:limit|exceeded)",
  "billing",
  "payment required",
  "usage[ _-]?not[ _-]?included",
  "free[ _-]?usage",
  "you(?:['’]ve| have)? (?:hit|reached) your (?:[a-z0-9-]+\\s+){0,3}limit",
  "(?:usage|weekly|daily|monthly|hourly|session|5-hour)[ _-]?limit[ _-]?(?:reached|exceeded|exhausted|hit)",
  "usage[ _-]?limit(?:error|exception)",
  "limit reached,? resets",
  "extra usage is required",
  "slow[ _-]?down",
  "throttl(?:e|ed|ing)",
  "package has expired",
  "plan does not (?:yet )?include",
  "(?:organization|project|api[ _-]?key)[ _-]?(?:usage|spend)[ _-]?limit",
].join("|");

/** 5xx status with explicit HTTP/status/error framing (not arbitrary counts). */
const TRANSIENT_HTTP_STATUS_SOURCE =
  "(?:^\\s*|\\bHTTP(?:/[\\d.]+)?\\s+|\\bstatus(?:Code|_code)?\\s*:?\\s*|\\berror\\s*[:(]?\\s*|\\bcode\\s*:?\\s*|\\bresponse\\s+(?:status|code)\\s*:?\\s*)5\\d{2}\\b";

/** Network, overload and 5xx failures (short cooldown, retry the same model later). */
const TRANSIENT_ERROR_SOURCE = [
  "overloaded",
  "provider.?returned.?error",
  TRANSIENT_HTTP_STATUS_SOURCE,
  "server had an error",
  "at capacity",
  "capacity unavailable",
  "server (?:is )?busy",
  "temporarily limiting",
  "service.?unavailable",
  "temporarily unavailable",
  "\\bapi[ _-]?error\\b",
  "server.?error",
  "internal[ _-]?server",
  "internal.?error",
  "model[ _-]?stream[ _-]?error",
  "resource[ _-]?exhausted",
  "network.?error",
  "connection.?error",
  "connection.?refused",
  "connection.?reset",
  "connection.?lost",
  "connection.?closed",
  "connection[ _-]?limit[ _-]?reached",
  "websocket.?closed",
  "websocket.?error",
  "stream error",
  "other side closed",
  "fetch failed",
  "failed to fetch",
  "upstream[ _-]?(?:connect|connection|request|response|failure|error)",
  "reset before headers",
  "socket hang up",
  "ended without",
  "http2 request did not get a response",
  "request buffer limit",
  "timed? out",
  "timeout",
  "terminated",
  "retry delay",
  "try again",
  "please retry",
  "retry (?:the |this |your )?request",
  "try your request again",
  "\\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE)\\b",
  "UND_ERR_[A-Z0-9_]+",
].join("|");

/** Content-policy refusals: request-specific, never model-wide unavailability. */
const CONTENT_REFUSAL_SOURCE = [
  "terms (?:of service|of use)",
  "usage polic(?:y|ies)",
  "content[ _-]?polic(?:y|ies)",
  "content[ _-]?(?:filter|filtering|management|moderation|blocked)",
  "safety (?:system|polic(?:y|ies)|filter|settings)",
  "moderation",
  "responsible ai",
  "responsibleAIPolicyViolation",
  "prohibited[ _-]?content",
  "harmful content",
  "unsafe or sensitive content",
  "\\bSAFETY\\b",
  "image[ _-]?safety",
  "blocklist",
  "cyber[ _-]?policy|cybersecurity risk",
  "bio[ _-]?policy",
  "misalignment polic(?:y|ies)",
  "datainspectionfailed",
  "\\brefusal\\b",
  "refused to respond",
  "flagged (?:by|as)",
  "blocked (?:by|due to) .{0,40}(?:safety|content|policy|filter)",
  "rejected (?:as a result of our|by the) safety system",
  "violat(?:e|es|ed|ion of) .{0,60}(?:polic(?:y|ies)|terms|usage|guidelines)",
].join("|");

const RATE_LIMIT_ERROR_RE = new RegExp(RATE_LIMIT_ERROR_SOURCE, "i");
const TRANSIENT_ERROR_RE = new RegExp(TRANSIENT_ERROR_SOURCE, "i");
const CONTENT_REFUSAL_RE = new RegExp(CONTENT_REFUSAL_SOURCE, "i");

/** Account-wide restrictions need a config/billing fix, not a different prompt. */
const ACCOUNT_RESTRICTION_RE =
  /\b(?:account|organization|workspace|subscription)\b[\s\S]{0,80}\b(?:suspended|disabled|deactivated|banned|restricted|terminated|blocked|violat(?:e|es|ed|ing|ion)|breach(?:ed|es)?)\b/i;

/**
 * Pi's auto-retry heuristic, used by the compaction trigger to avoid running
 * while the host may retry the same assistant turn. Deliberately narrower than
 * the cooldown classifier: quota/plan-limit failures are still classified for
 * cooldown purposes, but Pi does not auto-retry them, so they must not suppress
 * a compaction pass.
 */
const AUTO_RETRY_ERROR_SOURCE = [
  "overloaded",
  "provider.?returned.?error",
  "rate.?limit",
  "too many requests",
  "\\b429\\b",
  "\\b500\\b",
  "\\b502\\b",
  "\\b503\\b",
  "\\b504\\b",
  "service.?unavailable",
  "server.?error",
  "internal.?error",
  "network.?error",
  "connection.?error",
  "connection.?refused",
  "connection.?lost",
  "websocket.?closed",
  "websocket.?error",
  "other side closed",
  "fetch failed",
  "upstream.?connect",
  "reset before headers",
  "socket hang up",
  "ended without",
  "http2 request did not get a response",
  "timed? out",
  "timeout",
  "terminated",
  "retry delay",
].join("|");

export const AUTO_RETRY_ERROR_RE = new RegExp(AUTO_RETRY_ERROR_SOURCE, "i");

/** Broad retryable classification used by the cooldown/debug paths. */
export const RETRYABLE_ERROR_RE = new RegExp(
  `${RATE_LIMIT_ERROR_SOURCE}|${TRANSIENT_ERROR_SOURCE}`,
  "i",
);

/** The error message text without relying on `instanceof Error` (SDK errors may be plain objects). */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error || "");
}

/** Provider text without the worker's own `… API error: ` prefix. */
function providerErrorText(error: unknown): string {
  return errorText(error).replace(WORKER_FRAMING_RE, "");
}

/** Transport codes can live on the error or its `cause` (undici fetch failures). */
function transportCodeText(error: unknown): string {
  if (error === null || typeof error !== "object") return "";
  const own = "code" in error ? String((error as { code: unknown }).code ?? "") : "";
  const cause = "cause" in error ? (error as { cause: unknown }).cause : undefined;
  const causeCode =
    cause !== null && typeof cause === "object" && "code" in cause
      ? String((cause as { code: unknown }).code ?? "")
      : "";
  return `${own} ${causeCode}`;
}

/** Numeric HTTP status carried by SDK errors (`status` or `statusCode`). */
function numericStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const raw =
    "status" in error
      ? (error as { status: unknown }).status
      : "statusCode" in error
        ? (error as { statusCode: unknown }).statusCode
        : undefined;
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  if (typeof raw === "string" && /^\d{3}$/.test(raw)) return Number(raw);
  return undefined;
}

/** Check whether an error is an account-wide restriction. */
export function isAccountRestrictionError(error: unknown): boolean {
  return ACCOUNT_RESTRICTION_RE.test(providerErrorText(error));
}

/** Check whether an error is a rate-limit/quota/billing failure. */
export function isRateLimitError(error: unknown): boolean {
  return RATE_LIMIT_ERROR_RE.test(providerErrorText(error));
}

/** Check whether an error is a network/overload/5xx failure. */
export function isTransientProviderError(error: unknown): boolean {
  const status = numericStatus(error);
  if (status !== undefined && (status === 408 || (status >= 500 && status <= 599))) return true;
  if (TRANSIENT_ERROR_RE.test(providerErrorText(error))) return true;
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR_/i.test(
    transportCodeText(error),
  );
}

/** Check whether provider text is a request-content policy refusal. */
export function isContentRefusalError(error: unknown): boolean {
  if (isAccountRestrictionError(error)) return false;
  return CONTENT_REFUSAL_RE.test(providerErrorText(error));
}

/** Check whether an error string or Error indicates a retryable error. */
export function isRetryableError(error: unknown): boolean {
  return isRateLimitError(error) || isTransientProviderError(error);
}

/**
 * The policy-relevant cause of a worker/model failure. The consolidation stage
 * uses this instead of inferring the cooldown from the error text at each call
 * site; local, request-local and content-refusal failures never persist.
 */
export type CooldownCause =
  | "local_execution"
  | "content_refusal"
  | "request_local"
  | "provider_rate_limit"
  | "provider_configuration"
  | "provider_transient"
  | "unknown";

/** Classify an error for cooldown policy. Order matters: see the predicates above. */
export function classifyCooldownCause(error: unknown): CooldownCause {
  if (isLocalExecutionError(error)) return "local_execution";
  if (isAccountRestrictionError(error)) return "provider_configuration";
  if (isContentRefusalError(error)) return "content_refusal";
  if (isRequestLocalError(error)) return "request_local";
  if (isRateLimitError(error)) return "provider_rate_limit";
  if (isDeterministicError(error)) return "provider_configuration";
  if (isTransientProviderError(error)) return "provider_transient";
  return "unknown";
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
  // Account-wide restrictions cannot be fixed by changing the request content.
  if (isAccountRestrictionError(error)) return true;
  // A content refusal may carry a 400 status, but retrying the same model can
  // succeed on different content. It is not a config/header failure.
  if (isContentRefusalError(error)) return false;
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
  return (
    !isLocalExecutionError(error) &&
    !isRequestLocalError(error) &&
    !isContentRefusalError(error) &&
    (isRetryableError(error) || isDeterministicError(error))
  );
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

/** Local execution failures do not establish provider/model unavailability. */
export function isLocalExecutionError(error: unknown): boolean {
  const fields = error !== null && typeof error === "object" ? error : undefined;
  const name = fields && "name" in fields ? fields.name : undefined;
  const code = fields && "code" in fields ? fields.code : undefined;
  const message = fields && "message" in fields ? String(fields.message) : String(error || "");
  const text = message.replace(WORKER_FRAMING_RE, "");
  const cause = fields && "cause" in fields ? fields.cause : undefined;
  const causeCode =
    cause !== null && typeof cause === "object" && "code" in cause ? cause.code : undefined;
  // Fetch/undici reject transport and mid-body failures with TypeError too.
  if (
    name === "TypeError" &&
    (/^(?:fetch failed|Failed to fetch|terminated|NetworkError when attempting to fetch resource\.?)$/i.test(
      text,
    ) ||
      (typeof causeCode === "string" && causeCode.startsWith("UND_ERR_")))
  )
    return false;
  return (
    name === "AbortError" ||
    name === "TypeError" ||
    name === "ReferenceError" ||
    name === "SyntaxError" ||
    name === "RangeError" ||
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "MODULE_NOT_FOUND" ||
    /^Cannot find (?:module|package) /i.test(text) ||
    // Framed provider text can describe malformed responses, not local bugs.
    (!WORKER_FRAMING_RE.test(message) &&
      /^(?:Cannot read properties of |[\w$]+ is not defined\b|(?:TypeError|ReferenceError|SyntaxError):)/i.test(
        text,
      )) ||
    /^(?:The operation was aborted|request aborted|aborted)$/i.test(text) ||
    isStaleExtensionContextError(error)
  );
}

/**
 * Request-size/options rejection does not establish model-wide unavailability.
 * SDKs expose status + code/param, while workers can flatten provider failures
 * to text. Text fallbacks require a status framing and a specific rejection,
 * never merely the word "context" or a blanket exclusion of every 400.
 */
export function isRequestLocalError(error: unknown): boolean {
  const fields = error !== null && typeof error === "object" ? error : undefined;
  const message = fields && "message" in fields ? String(fields.message) : String(error || "");
  const text = message.replace(WORKER_FRAMING_RE, "");
  const rawStatus =
    fields && "status" in fields
      ? fields.status
      : fields && "statusCode" in fields
        ? fields.statusCode
        : undefined;
  // The outer status wins: do not read an upstream 400 inside a 503 body.
  const statusText = text.match(
    /^(?:HTTP(?:\/[\d.]+)?\s+|[\w -]+ API error\s*\(|status\s*:?\s*|error\s*[:(]\s*)?([45]\d{2})\b/i,
  )?.[1];
  // Gemini/Vertex flatten their ApiError to JSON with no HTTP prefix.
  // Only accept that leading error envelope, never a quoted code in prose.
  const jsonStatus = text.match(
    /^(?:got status: INVALID_ARGUMENT\.\s*)?\{\s*"error"\s*:\s*\{\s*"code"\s*:\s*(4\d{2})\b/i,
  )?.[1];
  const status = typeof rawStatus === "number" ? rawStatus : Number(statusText ?? jsonStatus);
  if (status === 413) return true;
  if (status !== 400 && status !== 422) return false;
  // pi-ai 0.85.1 classified any bodyless 400 as context overflow. Keep the
  // current contract on that supported peer too: no evidence means no exemption.
  if (/\(no body\)/i.test(text)) return false;
  // A provider-required session header is configuration-wide, not payload-local.
  if (/MissingSessionID|missing.?session|invalid.?api.?key|unauthorized/i.test(text)) return false;
  const detail =
    fields && "error" in fields && fields.error !== null && typeof fields.error === "object"
      ? fields.error
      : fields;
  const code = detail && "code" in detail ? detail.code : undefined;
  const param = detail && "param" in detail ? detail.param : undefined;
  if (code === "context_length_exceeded" || code === "request_too_large") return true;
  if (
    (param === "reasoning_effort" ||
      param === "reasoning.effort" ||
      param === "thinking_level" ||
      param === "thinking.level") &&
    (code === "unsupported_value" || code === "invalid_value")
  )
    return true;
  // Reuse pi-ai's maintained provider overflow patterns without treating a
  // bare 400 as overflow. Only the error-message arm is used (no usage inference).
  if (
    isContextOverflow({
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "unknown",
      model: "unknown",
      stopReason: "error",
      errorMessage: text,
      timestamp: 0,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    })
  )
    return true;
  // OpenAI provider text: openai/openai-python#2112. Responses uses the
  // reasoning.effort param spelling (openai/codex#45955). Match the rejected
  // parameter plus error code, not an arbitrary unsupported-value message.
  const thinkingParam =
    /"param"\s*:\s*"(?:reasoning[._]effort|thinking_level|thinking\.level)"/i.test(text);
  const unsupportedValue = /"code"\s*:\s*"(?:unsupported_value|invalid_value)"/i.test(text);
  // Literal "invalid thinking level" is a defensive fallback for custom
  // providers; the parameter-specific patterns above have incident evidence.
  return (
    (thinkingParam && unsupportedValue) ||
    /Unsupported value:\s*['"]reasoning_effort['"] does not support ['"][^'"]+['"] with this model\./i.test(
      text,
    ) ||
    /\b(?:payload|request(?: body)?) (?:is )?too large\b|\b(?:invalid|unsupported) thinking level\b|\bthinking level .{1,40} (?:is )?(?:invalid|not supported)\b/i.test(
      text,
    )
  );
}
