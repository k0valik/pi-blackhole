/**
 * Usage-aware token helpers (plan-01 measurement core).
 *
 * Tests hasUsageData / getUsageTokens real-usage extraction and
 * observationLineTokenCount serialization parity.
 */
import { describe, expect, it } from "vitest";

import {
  estimateStringTokens,
  getUsageTokens,
  hasUsageData,
  observationLineTokenCount,
} from "../src/om/tokens.js";

function assistantMessage(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    role: "assistant",
    stopReason: "stop",
    usage: {
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
      totalTokens: 165,
    },
    ...overrides,
  };
}

describe("getUsageTokens", () => {
  it("returns totalTokens when present", () => {
    expect(getUsageTokens(assistantMessage())).toBe(165);
  });

  it("falls back to summing components when totalTokens is missing or zero", () => {
    const components = {
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
    } as const;
    expect(
      getUsageTokens(
        assistantMessage({ usage: { ...components, totalTokens: 0 } }),
      ),
    ).toBe(165);
    expect(getUsageTokens(assistantMessage({ usage: components }))).toBe(165);
  });

  it("returns undefined for zero or negative usage", () => {
    expect(
      getUsageTokens(
        assistantMessage({
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("returns undefined for non-finite usage", () => {
    expect(
      getUsageTokens(
        assistantMessage({
          usage: {
            input: NaN,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: NaN,
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("returns undefined when usage is missing", () => {
    expect(
      getUsageTokens(assistantMessage({ usage: undefined })),
    ).toBeUndefined();
  });

  it("excludes error and aborted assistant messages", () => {
    expect(
      getUsageTokens(assistantMessage({ stopReason: "error" })),
    ).toBeUndefined();
    expect(
      getUsageTokens(assistantMessage({ stopReason: "aborted" })),
    ).toBeUndefined();
  });

  it("never reads non-assistant roles, even with usage present", () => {
    expect(getUsageTokens({ role: "user", content: "hi" })).toBeUndefined();
    expect(
      getUsageTokens({
        role: "toolResult",
        toolName: "bash",
        usage: assistantMessage().usage,
      }),
    ).toBeUndefined();
  });

  it("returns undefined for non-object input without throwing", () => {
    expect(getUsageTokens(undefined)).toBeUndefined();
    expect(getUsageTokens(null)).toBeUndefined();
    expect(getUsageTokens("assistant")).toBeUndefined();
    expect(getUsageTokens(42)).toBeUndefined();
  });

  it("never throws on malformed usage shapes", () => {
    expect(() =>
      getUsageTokens(assistantMessage({ usage: "bogus" })),
    ).not.toThrow();
    expect(() => getUsageTokens(assistantMessage({ usage: {} }))).not.toThrow();
    expect(() =>
      getUsageTokens(assistantMessage({ usage: { totalTokens: "many" } })),
    ).not.toThrow();
  });
});

describe("hasUsageData", () => {
  it("mirrors getUsageTokens", () => {
    expect(hasUsageData(assistantMessage())).toBe(true);
    expect(hasUsageData(assistantMessage({ stopReason: "error" }))).toBe(false);
    expect(hasUsageData({ role: "user", content: "hi" })).toBe(false);
  });
});

describe("observationLineTokenCount", () => {
  it("matches estimateStringTokens of the serialized line", () => {
    const obs = {
      id: "abcdef123456",
      timestamp: "2026-05-02T10:00:00.000Z",
      relevance: "high",
      content: "the user prefers pnpm over npm",
    };
    expect(observationLineTokenCount(obs)).toBe(
      estimateStringTokens(
        `[${obs.id}] ${obs.timestamp} [${obs.relevance}] ${obs.content}`,
      ),
    );
  });
});
