import { describe, expect, it } from "vitest";

import {
  AUTO_RETRY_ERROR_RE,
  classifyCooldownCause,
  getDiscardedCount,
  isContentRefusalError,
  isCooldownWorthyError,
  isDeterministicError,
  isRetryableError,
  withDiscardedCount,
  WorkerStreamError,
} from "../src/om/retryable-error.js";

describe("getDiscardedCount", () => {
  it("reads the count only from a WorkerStreamError", () => {
    expect(getDiscardedCount(new WorkerStreamError("Observer API error: x", 3))).toBe(3);
    expect(getDiscardedCount(new Error("Observer API error: x"))).toBeUndefined();
    expect(getDiscardedCount(undefined)).toBeUndefined();
    expect(getDiscardedCount(null)).toBeUndefined();
  });
});

describe("withDiscardedCount", () => {
  it("attaches the count without changing the thrown value", () => {
    const failure = new Error("stream blew up");
    expect(withDiscardedCount(failure, 4)).toBe(failure);
    expect(getDiscardedCount(failure)).toBe(4);
  });

  it("leaves primitives and nullish values untouched", () => {
    expect(withDiscardedCount("boom", 4)).toBe("boom");
    expect(withDiscardedCount(null, 4)).toBeNull();
    expect(withDiscardedCount(undefined, 4)).toBeUndefined();
    expect(getDiscardedCount("boom")).toBeUndefined();
    expect(getDiscardedCount(null)).toBeUndefined();
  });

  it("drops the count rather than the failure when the value cannot carry one", () => {
    const frozen = Object.freeze(new Error("frozen"));
    expect(() => withDiscardedCount(frozen, 4)).not.toThrow();
    expect(getDiscardedCount(frozen)).toBeUndefined();
  });

  it("ignores a plain discardedCount field on an unrelated object", () => {
    expect(getDiscardedCount({ discardedCount: 5 })).toBeUndefined();
  });
});

// Issue: OpenCode Go gateway rejects worker requests without x-opencode-session
// (400 MissingSessionID). That 400 is deterministic — retrying the same model
// cannot succeed — so it must cool the model down and engage fallbacks instead
// of retrying identically every consolidation cycle.
const MISSING_SESSION_BODY =
  'Reflector API error: 400: {"type":"MissingSessionID","message":"Error from provider (Console Go): Request is missing x-opencode-session. External coding-agent clients must send a stable x-opencode-session header."}';

describe("deterministic client errors", () => {
  it("classifies the OpenCode MissingSessionID body as deterministic, not retryable", () => {
    const error = new Error(MISSING_SESSION_BODY);
    expect(isDeterministicError(error)).toBe(true);
    // Transient retry would never heal this — documents the axis split.
    expect(isRetryableError(error)).toBe(false);
    expect(isCooldownWorthyError(error)).toBe(true);
  });

  it("classifies framed 4xx statuses as deterministic", () => {
    expect(isDeterministicError(new Error("HTTP 400 Bad Request"))).toBe(true);
    expect(isDeterministicError(new Error("request failed with status: 404"))).toBe(true);
    expect(isDeterministicError(new Error("provider error: 422"))).toBe(true);
    expect(isDeterministicError(new Error("HTTP 401 Unauthorized"))).toBe(true);
  });

  it("classifies auth-shaped failures as deterministic", () => {
    expect(isDeterministicError(new Error("invalid api key for provider"))).toBe(true);
    expect(isDeterministicError(new Error("Unauthorized"))).toBe(true);
  });

  it("classifies bare 4xx codes with an error signal as deterministic", () => {
    expect(isDeterministicError(new Error("403 RegionError: model not available"))).toBe(true);
    expect(isDeterministicError(new Error("400 Bad Request"))).toBe(true);
    expect(isDeterministicError(new Error("404 Not Found: /v1/models"))).toBe(true);
    expect(isDeterministicError(new Error("request failed with 404"))).toBe(true);
  });

  it("ignores bare 4xx codes without an error signal", () => {
    expect(isDeterministicError(new Error("recorded 404 observations"))).toBe(false);
    expect(isDeterministicError(new Error("processed 403 entries successfully"))).toBe(false);
    expect(isDeterministicError(new Error("context window 8000 too small for input 10000"))).toBe(
      false,
    );
  });

  // The workers prefix provider text with `<worker> API error: `. That word is
  // ours, not the provider's, so it must not stand in for the signal word the
  // bare-code branch requires.
  it("does not let a worker's own framing supply the signal word", () => {
    expect(isDeterministicError(new Error("Observer API error: processed 401 rows"))).toBe(false);
    expect(
      isDeterministicError(new Error("Reflector API error: prompt returned 403 candidates")),
    ).toBe(false);
    expect(isDeterministicError(new Error("Dropper API error: kept 422 rows"))).toBe(false);
  });

  it("still classifies a real status behind a worker's framing", () => {
    expect(isDeterministicError(new Error("Observer API error: 401"))).toBe(true);
    expect(
      isDeterministicError(new Error("Observer API error: 403 RegionError: model not available")),
    ).toBe(true);
    expect(isDeterministicError(new Error("Reflector API error: request failed with 404"))).toBe(
      true,
    );
    expect(
      isDeterministicError(new Error("Dropper API error: invalid model, got 400 Bad Request")),
    ).toBe(true);
  });

  it("does not mistake token counts or plain prose for status codes", () => {
    // Bare numbers without error framing must not match (e.g. progress lines
    // like "~401-token chunk" flow through nearby logging, never as errors,
    // but the classifier must stay precise regardless).
    expect(isDeterministicError(new Error("observer running on ~401-token chunk"))).toBe(false);
    expect(isDeterministicError(new Error("recorded 404 observations"))).toBe(false);
    expect(isDeterministicError(new Error("nothing new to record"))).toBe(false);
    expect(isDeterministicError(undefined)).toBe(false);
  });

  it("accepts string (non-Error) inputs", () => {
    expect(isDeterministicError("MissingSessionID")).toBe(true);
    expect(isCooldownWorthyError("HTTP 403 Forbidden")).toBe(true);
  });
});

describe("content refusals", () => {
  const refusals = [
    new Error(
      'Reflector API error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your request was rejected as a result of our safety system. Your request may contain material that violates our Terms of Service."}}',
    ),
    new Error("Observer API error: 400 This content was flagged by our moderation system."),
    new Error(
      "Observer API error: 400 The response was filtered due to the prompt triggering Azure OpenAI's content management policy.",
    ),
    new Error(
      'Observer API error: 400 got status: INVALID_ARGUMENT. {"error":{"code":400,"message":"The response was blocked due to safety settings","status":"INVALID_ARGUMENT"}}',
    ),
    new Error("Dropper API error: 400 content_filter"),
    new Error("Observer API error: 400 prohibited content detected"),
  ];

  it("recognizes provider content-policy failures", () => {
    for (const error of refusals) expect(isContentRefusalError(error)).toBe(true);
  });

  it("does not treat a 400 refusal as a deterministic configuration error", () => {
    const error = new Error(
      "Observer API error: 400 Bad Request: request violates our usage policy",
    );
    expect(isDeterministicError(error)).toBe(false);
    expect(isCooldownWorthyError(error)).toBe(false);
    expect(classifyCooldownCause(error)).toBe("content_refusal");
  });
});

describe("cooldown cause classification", () => {
  it.each([
    [new Error("Observer API error: WebSocket error"), "provider_transient"],
    [new Error("overloaded_error"), "provider_transient"],
    [new Error("HTTP 503 Service Unavailable"), "provider_transient"],
    [new Error("HTTP 529 Overloaded"), "provider_transient"],
    [new Error("try again later"), "provider_transient"],
    [new Error("ECONNRESET"), "provider_transient"],
    [new Error("socket hang up"), "provider_transient"],
    [new TypeError("fetch failed"), "provider_transient"],
    [new TypeError("terminated"), "provider_transient"],
    [
      Object.assign(new TypeError("body read failed"), { cause: { code: "UND_ERR_BODY_TIMEOUT" } }),
      "provider_transient",
    ],
    [new Error("429 Too Many Requests"), "provider_rate_limit"],
    [new Error("rate limit exceeded"), "provider_rate_limit"],
    [new Error("insufficient_quota"), "provider_rate_limit"],
    [new Error("Your credit balance is too low"), "provider_rate_limit"],
    [new Error("billing hard limit reached"), "provider_rate_limit"],
    [new Error("HTTP 401 Unauthorized"), "provider_configuration"],
    [new Error("HTTP 404 model not found"), "provider_configuration"],
    [new Error("MissingSessionID"), "provider_configuration"],
    [new Error("HTTP 400 Bad Request: maximum context length is 8192 tokens"), "request_local"],
    [new Error("HTTP 400 Bad Request: invalid thinking level"), "request_local"],
    [
      new Error("Observer API error: 400 Bad Request: request violates our usage policy"),
      "content_refusal",
    ],
    [new Error("all good"), "unknown"],
  ])("classifies %s as %s", (error, cause) => {
    expect(classifyCooldownCause(error)).toBe(cause);
  });

  it("keeps local execution errors local even when they mention a provider status", () => {
    expect(
      classifyCooldownCause(new TypeError("Cannot read properties of undefined: HTTP 503")),
    ).toBe("local_execution");
    expect(classifyCooldownCause(new DOMException("The operation was aborted", "AbortError"))).toBe(
      "local_execution",
    );
  });

  it("checks content refusal before deterministic framing and rate-limit status", () => {
    expect(
      classifyCooldownCause(
        new Error("HTTP 403 quota exceeded: request violates our usage policy"),
      ),
    ).toBe("content_refusal");
  });
});

describe("real provider limit and transient messages", () => {
  it.each([
    // Claude Code / Anthropic subscription and API limits
    ["You've hit your weekly limit · resets Mon", "provider_rate_limit"],
    ["You've hit your 5-hour limit · resets at 3pm", "provider_rate_limit"],
    ["5-hour limit reached · resets at 3pm", "provider_rate_limit"],
    ["limit reached, resets at 3pm", "provider_rate_limit"],
    ["Request rejected (429)", "provider_rate_limit"],
    ["Your credit balance is too low to access the Anthropic API", "provider_rate_limit"],
    ["Extra usage is required for long context requests", "provider_rate_limit"],
    ["Server is temporarily limiting requests (not your usage limit)", "provider_transient"],
    // OpenAI API / Codex / ChatGPT plan limits
    ["You've hit your usage limit. Try again at Apr 30th, 2026 11:21 AM.", "provider_rate_limit"],
    ["You've reached your usage limit", "provider_rate_limit"],
    ["You have reached your limit", "provider_rate_limit"],
    [
      "You exceeded your current quota, please check your plan and billing details.",
      "provider_rate_limit",
    ],
    ["Quota exceeded. Check your plan and billing details.", "provider_rate_limit"],
    ["usage_not_included", "provider_rate_limit"],
    ["organization_usage_limit_exceeded", "provider_rate_limit"],
    ["project_spend_limit_exceeded", "provider_rate_limit"],
    ["credit_balance_exhausted", "provider_rate_limit"],
    ["spend limit exceeded", "provider_rate_limit"],
    ["session budget exceeded", "provider_rate_limit"],
    ["rate_limit_exceeded", "provider_rate_limit"],
    ["slow_down", "provider_rate_limit"],
    ["too_many_requests", "provider_rate_limit"],
    ["The server had an error while processing your request", "provider_transient"],
    ["Model temporarily overloaded", "provider_transient"],
    ["server_is_overloaded", "provider_transient"],
    ["resource_exhausted", "provider_transient"],
    ["internal_server_exception", "provider_transient"],
    ["model_stream_error_exception", "provider_transient"],
    ["serviceunavailableexception", "provider_transient"],
    ["api_error", "provider_transient"],
    ["websocket_connection_limit_reached", "provider_transient"],
    // OpenCode provider classification fallbacks
    ["Free usage exceeded", "provider_rate_limit"],
    ["gousagelimiterror", "provider_rate_limit"],
    ["budgetlimiterror", "provider_rate_limit"],
    ["creditlimitexceeded", "provider_rate_limit"],
    ["Request rate increased too quickly", "provider_rate_limit"],
    ["Too many requests, please slow down", "provider_rate_limit"],
    [
      "The model is currently at capacity due to high demand. Please try again in a few minutes",
      "provider_transient",
    ],
    ["The service is temporarily at capacity.", "provider_transient"],
    ["The server is busy.", "provider_transient"],
    ["HTTP 503 Service Unavailable: retry budget exhausted", "provider_transient"],
    ["HTTP 507 Insufficient Storage", "provider_transient"],
    ["507 Insufficient Storage", "provider_transient"],
    ["request failed with status 507", "provider_transient"],
    ["processed 512 rows", "unknown"],
    ["Flex capacity unavailable.", "provider_transient"],
    ["policy-restricted capacity unavailable", "provider_transient"],
    ["Please retry your request shortly.", "provider_transient"],
    ["Try your request again.", "provider_transient"],
    ["Upstream connection failed", "provider_transient"],
    ["Exceeded request buffer limit while retrying upstream", "provider_transient"],
    // Content-policy rejections from the same ecosystems
    [
      "Invalid prompt: your prompt was flagged as potentially violating our usage policy.",
      "content_refusal",
    ],
    ["Output blocked by content filtering policy", "content_refusal"],
    ["Request rejected in accordance with our terms of use and policies.", "content_refusal"],
    ["This content was flagged for possible cybersecurity risk.", "content_refusal"],
    ["content_policy_violation", "content_refusal"],
    ["cyber_policy", "content_refusal"],
    ["bio_policy", "content_refusal"],
    ["misalignment policy violation", "content_refusal"],
    ["datainspectionfailed", "content_refusal"],
    ["blocklist", "content_refusal"],
    ["image_safety", "content_refusal"],
    ["content_blocked", "content_refusal"],
    ["prohibited_content", "content_refusal"],
    ["Claude refused to respond", "content_refusal"],
    ["The response was blocked due to safety settings", "content_refusal"],
    // Account-wide restrictions are not request-content refusals.
    [
      "HTTP 403 Your account has been suspended for violating our terms of service",
      "provider_configuration",
    ],
    ["Your account has been disabled", "provider_configuration"],
    ["Your workspace has been restricted", "provider_configuration"],
    ["Your account session expired", "unknown"],
    ["Your account token expired", "unknown"],
  ])("classifies %s as %s", (message, cause) => {
    expect(classifyCooldownCause(new Error(message))).toBe(cause);
  });

  it.each([
    [Object.assign(new Error("Request failed"), { status: 503 }), "provider_transient"],
    [Object.assign(new Error("Request failed"), { statusCode: 507 }), "provider_transient"],
    [Object.assign(new Error("Request failed"), { status: 408 }), "provider_transient"],
    [Object.assign(new Error("Request failed"), { status: "503" }), "provider_transient"],
    [Object.assign(new Error("Request failed"), { status: 400 }), "unknown"],
  ])("reads numeric status fields: %s", (error, cause) => {
    expect(classifyCooldownCause(error)).toBe(cause);
  });
});

describe("compaction-trigger auto-retry heuristic", () => {
  it("keeps the legacy transient and rate-limit signals", () => {
    expect(AUTO_RETRY_ERROR_RE.test("HTTP 503 Service Unavailable")).toBe(true);
    expect(AUTO_RETRY_ERROR_RE.test("429 Too Many Requests")).toBe(true);
    expect(AUTO_RETRY_ERROR_RE.test("connection refused")).toBe(true);
  });

  it("does not suppress compaction for quota or plan-limit failures", () => {
    expect(AUTO_RETRY_ERROR_RE.test("You've hit your usage limit")).toBe(false);
    expect(AUTO_RETRY_ERROR_RE.test("insufficient_quota")).toBe(false);
    expect(AUTO_RETRY_ERROR_RE.test("billing hard limit reached")).toBe(false);
  });
});

describe("retryable error classification", () => {
  it("matches standalone status codes and real provider phrasing", () => {
    expect(isRetryableError(new Error("429 Too Many Requests"))).toBe(true);
    expect(isRetryableError(new Error("HTTP 503 Service Unavailable"))).toBe(true);
    expect(isRetryableError(new Error("request failed with status 502"))).toBe(true);
    expect(isRetryableError(new Error("429"))).toBe(true);
  });

  // The numeric alternatives must not match as substrings: token counts,
  // row counts, and port-like numbers flow through the same logs and must
  // not read as provider statuses on the retryable/cooldownWorthy axis.
  it("does not match status codes embedded in larger numbers", () => {
    expect(isRetryableError(new Error("processed 1500 tokens"))).toBe(false);
    expect(isRetryableError(new Error("processed 5000 rows"))).toBe(false);
    expect(isRetryableError(new Error("entry 14290 compacted"))).toBe(false);
    expect(isRetryableError(new Error("all good"))).toBe(false);
  });
});

describe("cooldown-worthy errors (transient OR deterministic)", () => {
  it("keeps transient failures cooldown-worthy", () => {
    expect(isCooldownWorthyError(new Error("429 Too Many Requests"))).toBe(true);
    expect(isCooldownWorthyError(new Error("503 Service Unavailable"))).toBe(true);
    expect(isCooldownWorthyError(new Error("upstream connect timeout"))).toBe(true);
  });

  it("keeps transient/detail axes separate", () => {
    // 429 is transient (same model, later) — not deterministic.
    expect(isRetryableError(new Error("429 Too Many Requests"))).toBe(true);
    expect(isDeterministicError(new Error("429 Too Many Requests"))).toBe(false);
  });

  it("rejects benign input on all axes", () => {
    const error = new Error("all good");
    expect(isRetryableError(error)).toBe(false);
    expect(isDeterministicError(error)).toBe(false);
    expect(isCooldownWorthyError(error)).toBe(false);
  });
});
