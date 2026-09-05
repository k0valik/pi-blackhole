/**
 * Unit tests for provider-aware engine coordination (matchesSkippedProvider).
 */
import { describe, test, expect } from "vitest";
import { matchesSkippedProvider } from "../src/core/provider-skip.js";

const codex = {
  provider: "openai-codex",
  api: "openai-codex-responses",
  id: "gpt-5.5",
};
const other = { provider: "anthropic", api: "completions", id: "claude" };

describe("matchesSkippedProvider", () => {
  test("no skip list → never skips", () => {
    expect(matchesSkippedProvider({ skipForProviders: undefined }, codex)).toBe(false);
    expect(matchesSkippedProvider({ skipForProviders: [] }, codex)).toBe(false);
    expect(matchesSkippedProvider({}, codex)).toBe(false);
  });

  test("bare provider entry skips any api of that provider", () => {
    expect(matchesSkippedProvider({ skipForProviders: ["openai-codex"] }, codex)).toBe(true);
    expect(
      matchesSkippedProvider(
        { skipForProviders: ["openai-codex"] },
        { provider: "openai-codex", api: "chat" },
      ),
    ).toBe(true);
  });

  test("provider:api entry skips only that exact api", () => {
    const cfg = { skipForProviders: ["openai-codex:openai-codex-responses"] };
    expect(matchesSkippedProvider(cfg, codex)).toBe(true);
    expect(matchesSkippedProvider(cfg, { provider: "openai-codex", api: "chat" })).toBe(false);
  });

  test("trailing-colon entry skips models without an api", () => {
    const cfg = { skipForProviders: ["openai-codex:"] };
    expect(matchesSkippedProvider(cfg, { provider: "openai-codex" })).toBe(true);
    expect(matchesSkippedProvider(cfg, codex)).toBe(false);
  });

  test("non-listed providers and non-codex models are not skipped", () => {
    expect(matchesSkippedProvider({ skipForProviders: ["openai-codex"] }, other)).toBe(false);
    expect(matchesSkippedProvider({ skipForProviders: ["claude"] }, codex)).toBe(false);
  });

  test("malformed input never throws", () => {
    expect(matchesSkippedProvider({ skipForProviders: ["openai-codex"] }, null)).toBe(false);
    expect(matchesSkippedProvider({ skipForProviders: ["openai-codex"] }, undefined)).toBe(false);
    expect(matchesSkippedProvider({ skipForProviders: ["openai-codex"] }, "openai-codex")).toBe(
      false,
    );
    expect(matchesSkippedProvider({ skipForProviders: ["openai-codex"] }, { provider: 42 })).toBe(
      false,
    );
    expect(matchesSkippedProvider({ skipForProviders: ["openai-codex"] }, {})).toBe(false);
  });

  test("whitespace entries are tolerated", () => {
    expect(matchesSkippedProvider({ skipForProviders: [" openai-codex ", ""] }, codex)).toBe(true);
  });
});
