/**
 * Stale extension ctx handling — ensure session replacement/reload errors
 * never leak into model cooldowns.
 */

import { describe, expect, it } from "vitest";
import { isStaleExtensionContextError } from "../src/om/retryable-error.js";

describe("isStaleExtensionContextError", () => {
  it("matches the exact Pi stale-ctx message", () => {
    const msg = "This extension ctx is stale after session replacement or reload.";
    expect(isStaleExtensionContextError(new Error(msg))).toBe(true);
    expect(isStaleExtensionContextError({ message: msg })).toBe(true);
    expect(isStaleExtensionContextError(msg)).toBe(true);
  });

  it("matches abbreviated variants", () => {
    expect(isStaleExtensionContextError(new Error("ctx is stale"))).toBe(true);
    expect(isStaleExtensionContextError("extension ctx is stale after reload.")).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(isStaleExtensionContextError(new Error("429 Too Many Requests"))).toBe(false);
    expect(isStaleExtensionContextError(new Error("network error"))).toBe(false);
    expect(isStaleExtensionContextError("timeout")).toBe(false);
    expect(isStaleExtensionContextError(null)).toBe(false);
    expect(isStaleExtensionContextError(undefined)).toBe(false);
  });
});
