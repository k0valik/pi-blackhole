/**
 * Measured worker prompt budget — input-budget clamp.
 *
 * workerInputBudget prices the prompt against window minus output allowance
 * minus safety margin. When a model's maxTokens approaches its contextWindow
 * (self-hosted registries commonly report maxTokens === contextWindow, and
 * small windows are below the 32k allowance outright) the unclamped reserve
 * drives the budget negative and observational memory silently never runs on
 * that model — a regression versus the flat reserve this replaced.
 */
import { describe, expect, test } from "vitest";

import { AGENT_LOOP_MAX_TOKENS } from "../src/om/model-budget.js";
import { workerInputBudget } from "../src/om/prompt-budget.js";
import { WORKER_SAFETY_MARGIN_TOKENS } from "../src/om/prompt-budget.js";
import { workerOutputAllowance } from "../src/om/prompt-budget.js";

const modelWith = (maxTokens?: number) => (maxTokens !== undefined ? { maxTokens } : {});

describe("workerInputBudget", () => {
  test("reserves the full output allowance on large windows", () => {
    expect(workerInputBudget(128_000, modelWith(32_000) as any)).toBe(
      128_000 - 32_000 - WORKER_SAFETY_MARGIN_TOKENS,
    );
  });

  test("stays positive when maxTokens approaches the window", () => {
    // 32768/32768 registry entry: unclamped this is 32768 - 32000 - 1024 < 0.
    // The reserve is capped at a quarter of the window, so the budget stays
    // usable instead of size-skipping every attempt forever.
    const budget = workerInputBudget(32_768, modelWith(32_768) as any);
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBe(32_768 - Math.floor(32_768 * 0.25) - WORKER_SAFETY_MARGIN_TOKENS);
  });

  test("stays non-negative on small windows", () => {
    // An 8k window can never host the 32k allowance: clamp, don't go negative.
    expect(workerInputBudget(8_000, modelWith(8_000) as any)).toBeGreaterThanOrEqual(0);
  });

  test("assumes the maximum allowance for unknown models", () => {
    expect(workerInputBudget(128_000, undefined)).toBe(
      128_000 - AGENT_LOOP_MAX_TOKENS - WORKER_SAFETY_MARGIN_TOKENS,
    );
  });
});

describe("workerOutputAllowance", () => {
  test("caps the dispatched output at a quarter of the window", () => {
    // 32768/32768 registry entry: preflight reserves 8192, so dispatch must
    // request 8192 — not 32000 — or the provider 400s on generation overflow.
    expect(workerOutputAllowance(32_768, modelWith(32_768) as any)).toBe(Math.floor(32_768 * 0.25));
  });

  test("leaves large windows at the full allowance", () => {
    expect(workerOutputAllowance(128_000, modelWith(32_000) as any)).toBe(32_000);
    expect(workerOutputAllowance(128_000, undefined)).toBe(AGENT_LOOP_MAX_TOKENS);
  });

  test("honors a smaller model maxTokens", () => {
    expect(workerOutputAllowance(128_000, modelWith(2000) as any)).toBe(2000);
  });

  test("preflight and dispatch are priced from the one number", () => {
    // The fit check must never admit a prompt the dispatched request cannot
    // honor: budget + allowance + margin reconstructs the window exactly.
    for (const window of [8_000, 32_768, 128_000]) {
      const model = modelWith(32_768) as any;
      expect(
        workerInputBudget(window, model) +
          workerOutputAllowance(window, model) +
          WORKER_SAFETY_MARGIN_TOKENS,
      ).toBe(window);
    }
  });
});
