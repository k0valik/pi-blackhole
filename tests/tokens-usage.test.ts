/**
 * Ported from feat/token-rework@f4e915f (plan-01 measurement core).
 * Approach origin: tavasti@360f24a (pi-blackhole fork), pi-vcc upstream PR #40.
 *
 * Tests the usage-aware token helpers on src/om/tokens.ts.
 */
import { describe, expect, it } from "vitest";

import { getUsageTokens, hasUsageData } from "../src/om/tokens.js";

const assistantWithUsage = (usage: unknown, overrides: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: [],
  stopReason: "stop",
  usage,
  ...overrides,
});

describe("getUsageTokens", () => {
  it("returns totalTokens when present", () => {
    expect(getUsageTokens(assistantWithUsage({ input: 10, output: 5, totalTokens: 15 }))).toBe(15);
  });

  it("falls back to summing components when totalTokens is missing or zero", () => {
    expect(
      getUsageTokens(
        assistantWithUsage({
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
        }),
      ),
    ).toBe(15);
    expect(
      getUsageTokens(
        assistantWithUsage({
          input: 10,
          output: 5,
          cacheRead: 3,
          cacheWrite: 0,
          totalTokens: 0,
        }),
      ),
    ).toBe(18);
  });

  it("returns undefined for zero or negative usage", () => {
    expect(getUsageTokens(assistantWithUsage({ totalTokens: 0 }))).toBeUndefined();
    expect(getUsageTokens(assistantWithUsage({ totalTokens: -5 }))).toBeUndefined();
  });

  it("returns undefined for non-finite usage", () => {
    expect(getUsageTokens(assistantWithUsage({ totalTokens: Number.NaN }))).toBeUndefined();
  });

  it("returns undefined when usage is missing", () => {
    expect(getUsageTokens({ role: "assistant", stopReason: "stop" })).toBeUndefined();
  });

  it("excludes error and aborted assistant messages", () => {
    expect(
      getUsageTokens(assistantWithUsage({ totalTokens: 100 }, { stopReason: "error" })),
    ).toBeUndefined();
    expect(
      getUsageTokens(assistantWithUsage({ totalTokens: 100 }, { stopReason: "aborted" })),
    ).toBeUndefined();
  });

  it("never reads non-assistant roles, even with usage present", () => {
    expect(
      getUsageTokens({
        role: "toolResult",
        stopReason: "stop",
        usage: { totalTokens: 100 },
      }),
    ).toBeUndefined();
  });

  it("returns undefined for non-object input without throwing", () => {
    expect(getUsageTokens(null)).toBeUndefined();
    expect(getUsageTokens("x")).toBeUndefined();
    expect(getUsageTokens(42)).toBeUndefined();
  });

  it("never throws on malformed usage shapes", () => {
    expect(getUsageTokens(assistantWithUsage("garbage"))).toBeUndefined();
    expect(getUsageTokens(assistantWithUsage([]))).toBeUndefined();
  });
});

describe("hasUsageData", () => {
  it("mirrors getUsageTokens", () => {
    expect(hasUsageData(assistantWithUsage({ totalTokens: 100 }))).toBe(true);
    expect(hasUsageData({ role: "user" })).toBe(false);
    expect(hasUsageData(assistantWithUsage({ totalTokens: 0 }))).toBe(false);
  });
});
