/**
 * Callable host schemas must not break worker prompt measurement (#174).
 *
 * On omp / oh-my-pi, typebox imports are mapped to an ArkType-backed shim
 * where Type.Object(...) returns a callable function. A function has no
 * toJSON(), so JSON.stringify(schema) is the primitive `undefined`; pricing
 * that with the token estimator used to reach text.matchAll(undefined) at
 * module import time and the whole extension failed to load.
 *
 * Verified against omp's shim (packages/coding-agent/src/extensibility/
 * legacy-typebox.ts + omptype's AnySchema): omptype builders return callable
 * schemas that carry toJsonSchema() but no toJSON, so JSON.stringify yields
 * `undefined`. The real omp shape is therefore the toJsonSchema case below
 * (accurate pricing); the bare-callable and throwing variants are
 * defense-in-depth for other or future shims (largest worker schema is ~321
 * tokens, well inside the 1024-token safety margin when priced at zero).
 *
 * The contract pinned here: measureStatic prices any schema shape without
 * throwing — plain typebox objects exactly as before, toJsonSchema-exposing
 * callables from their JSON output, and anything else at zero.
 *
 * Each case re-imports prompt-budget with a freshly mocked observer
 * tool-schema module so the import-time STATIC_PROMPT_TOKENS computation —
 * the actual crash site — is what gets exercised.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import { OBSERVER_SYSTEM } from "../src/om/agents/observer/prompts.js";
import { RelevanceSchema } from "../src/om/agents/observer/tool-schema.js";
import { estimateStringTokens } from "../src/om/tokens.js";
import { WORKER_FRAMING_TOKENS } from "../src/om/prompt-budget.js";

type PromptBudgetModule = typeof import("../src/om/prompt-budget.js");

/** Re-import prompt-budget with the observer schema replaced, forcing the
 * import-time static measurement to run against `schema`. */
async function loadBudgetWithObserverSchema(schema: unknown): Promise<PromptBudgetModule> {
  // RelevanceSchema passes through: the reflector tool schema imports it
  // (#208 marker) and runs at import time alongside the mocked observer
  // schema, so the factory must keep providing the real union.
  vi.doMock("../src/om/agents/observer/tool-schema.js", () => ({
    RecordObservationsSchema: schema,
    RelevanceSchema,
  }));
  vi.resetModules();
  return await import("../src/om/prompt-budget.js");
}

afterEach(() => {
  vi.doUnmock("../src/om/agents/observer/tool-schema.js");
  vi.resetModules();
});

describe("worker static measurement with non-typebox schema shapes", () => {
  test("loads and prices a bare callable schema at zero (shim without toJsonSchema)", async () => {
    // Regression for the #174 load crash: importing prompt-budget with a
    // callable schema used to reject with
    // "undefined is not an object (evaluating 'e.matchAll')".
    const callable = function recordObservationsSchema(): void {};
    const budget = await loadBudgetWithObserverSchema(callable);
    expect(budget.workerStaticPromptTokens("observer")).toBe(
      estimateStringTokens(OBSERVER_SYSTEM) + WORKER_FRAMING_TOKENS,
    );
  });

  test("prices a callable schema exposing toJsonSchema from its JSON output", async () => {
    const json = { type: "object", properties: { alpha: { type: "string" } } };
    const callable = Object.assign(function recordObservationsSchema(): void {}, {
      toJsonSchema: () => json,
    });
    const budget = await loadBudgetWithObserverSchema(callable);
    expect(budget.workerStaticPromptTokens("observer")).toBe(
      estimateStringTokens(OBSERVER_SYSTEM) +
        estimateStringTokens(JSON.stringify(json)) +
        WORKER_FRAMING_TOKENS,
    );
  });

  test("a throwing toJsonSchema degrades to zero instead of killing the import", async () => {
    const callable = Object.assign(function recordObservationsSchema(): void {}, {
      toJsonSchema: () => {
        throw new Error("shim cannot produce JSON schema");
      },
    });
    const budget = await loadBudgetWithObserverSchema(callable);
    expect(budget.workerStaticPromptTokens("observer")).toBe(
      estimateStringTokens(OBSERVER_SYSTEM) + WORKER_FRAMING_TOKENS,
    );
  });

  test("an undefined schema export prices at zero instead of crashing", async () => {
    const budget = await loadBudgetWithObserverSchema(undefined);
    expect(budget.workerStaticPromptTokens("observer")).toBe(
      estimateStringTokens(OBSERVER_SYSTEM) + WORKER_FRAMING_TOKENS,
    );
  });

  test("a plain typebox-shaped object schema keeps its exact price", async () => {
    // Pins the real-typebox else-branch: behavior under pi itself must not
    // change — the full serialized object is what gets priced.
    const object = { type: "object", properties: { beta: { type: "number" } } };
    const budget = await loadBudgetWithObserverSchema(object);
    expect(budget.workerStaticPromptTokens("observer")).toBe(
      estimateStringTokens(OBSERVER_SYSTEM) +
        estimateStringTokens(JSON.stringify(object)) +
        WORKER_FRAMING_TOKENS,
    );
  });
});
