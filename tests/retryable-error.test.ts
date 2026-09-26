import { describe, expect, it } from "vitest";

import {
  getDiscardedObservations,
  isCooldownWorthyError,
  isDeterministicError,
  isRetryableError,
  ObserverStreamError,
} from "../src/om/retryable-error.js";

describe("getDiscardedObservations", () => {
  it("reads the count only from an ObserverStreamError", () => {
    expect(getDiscardedObservations(new ObserverStreamError("Observer API error: x", 3))).toBe(3);
    expect(getDiscardedObservations(new Error("Observer API error: x"))).toBeUndefined();
    expect(getDiscardedObservations(undefined)).toBeUndefined();
    expect(getDiscardedObservations(null)).toBeUndefined();
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
