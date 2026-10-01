/**
 * Measured worker prompt budget + shrink-to-fit (follow-up to F1/F2).
 *
 * The preflight fit-check prices the prompt as chunk + preamble + system + a
 * flat AGENT_LOOP_RESERVE (8000), ignoring both the actual static overhead
 * (system + exactly one tool schema + framing — far smaller) and the output
 * allowance (up to AGENT_LOOP_MAX_TOKENS, sharing the same window). And when
 * no configured model fits, the stage cools every candidate for an hour and
 * aborts — wedging even future normal-size cycles instead of degrading.
 *
 * Harness mirrors tests/observer-coverage.test.ts: real Runtime, real stage,
 * module-mocked worker. getAgentDir is mocked to tmp so the (old) persisted
 * cooldown writes land in isolation; every test uses a unique model id.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const testDir = join(tmpdir(), `pi-blackhole-observer-shrink-${Date.now()}`);

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getAgentDir: () => testDir };
});

const recordCooldownSpy = vi.hoisted(() => vi.fn());

vi.mock("../src/om/cooldown.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    recordCooldown: (...args: unknown[]) => {
      recordCooldownSpy(...args);
      return (actual.recordCooldown as (...a: unknown[]) => unknown)(...args);
    },
  };
});

import { runObserverStage, type ConsolidationCtx } from "../src/om/consolidation.js";
import { Runtime } from "../src/om/runtime.js";
import { rawMessage, type TestEntry } from "./fixtures/session.js";

interface ObserverStageInput {
  chunk: string;
  allowedSourceEntryIds: string[];
}

const runObserverSpy = vi.hoisted(() => vi.fn<(input: ObserverStageInput) => Promise<unknown>>());

vi.mock("../src/om/agents/observer/agent.js", () => ({
  runObserver: runObserverSpy,
}));

function ctxWith(entries: TestEntry[]): ConsolidationCtx {
  return {
    cwd: "/tmp",
    hasUI: false,
    ui: undefined,
    model: undefined,
    modelRegistry: {
      find: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: false }),
    },
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => "test-session",
    },
  } as unknown as ConsolidationCtx;
}

function makeRuntime(observeAfterTokens: number, chunkMaxTokens: number): Runtime {
  const runtime = new Runtime();
  runtime.config.memory = true;
  runtime.config.observeAfterTokens = observeAfterTokens;
  runtime.config.observerChunkMaxTokens = chunkMaxTokens;
  return runtime;
}

/** ResolvedModel shape the stage consumes (custom resolver, bypasses resolveModel). */
function testModel(provider: string, id: string, contextWindow: number, maxTokens?: number) {
  return {
    source: "candidate" as const,
    candidateConfig: { provider, id },
    model: { provider, id, contextWindow, ...(maxTokens ? { maxTokens } : {}) },
    apiKey: "test",
  } as any;
}

function runStage(runtime: Runtime, entries: TestEntry[], resolved: any) {
  const generation = runtime.captureGeneration("test-session");
  return runObserverStage(
    { appendEntry: vi.fn() } as any,
    runtime,
    ctxWith(entries),
    generation,
    async () => resolved,
  );
}

/** ~tokens estimated tokens of plain message text (chars/4 estimator). */
const textForTokens = (tokens: number, sentinel: string) =>
  `${sentinel} ${"x".repeat(Math.max(0, tokens * 4 - sentinel.length - 1))}`;

const emptyResult = () => ({
  observations: [],
  emptyReason: { kind: "no_new_content" as const },
});

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
  runObserverSpy.mockReset();
  runObserverSpy.mockResolvedValue(emptyResult());
  recordCooldownSpy.mockClear();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("measured worker prompt budget", () => {
  test("the observer static overhead is measured and far below the flat reserve", async () => {
    const { workerStaticPromptTokens } = await import("../src/om/prompt-budget.js");
    const { AGENT_LOOP_RESERVE } = await import("../src/om/consolidation.js");
    const { OBSERVER_SYSTEM } = await import("../src/om/agents/observer/prompts.js");
    const { estimateStringTokens } = await import("../src/om/tokens.js");

    const overhead = workerStaticPromptTokens("observer");
    const systemTokens = estimateStringTokens(OBSERVER_SYSTEM);

    // T4: two directional pins — the tool schema must be INCLUDED (overhead
    // exceeds the system prompt alone) and the total must free budget versus
    // the flat reserve it replaces.
    expect(overhead).toBeGreaterThan(systemTokens);
    expect(overhead).toBeLessThan(AGENT_LOOP_RESERVE);
    expect(workerStaticPromptTokens("observer")).toBe(overhead);
  });

  test("a chunk the old formula accepted is skipped once the output allowance is priced", async () => {
    // 2k-token chunk against a 30k window: the old input-only check
    // (2k + system + 8000 < 30k) runs the model, but input + the default 32k
    // output allowance cannot share the window — the provider would 400.
    const entries = [rawMessage("s0", textForTokens(2000, "SMALL"))];
    const runtime = makeRuntime(100, 1_000_000);

    const outcome = await runStage(runtime, entries, testModel("test-shr", "output-rsv-m", 30_000));

    expect(outcome).toBe("abort");
    expect(runObserverSpy).not.toHaveBeenCalled();
  });
});

describe("observer shrink-to-fit", () => {
  /** Registry double resolving one candidate with a fixed window. */
  function fakeRegistry(contextWindow: number, maxTokens?: number) {
    return {
      find: (provider: string, id: string) => ({
        provider,
        id,
        contextWindow,
        ...(maxTokens ? { maxTokens } : {}),
      }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
    };
  }

  test("a 70k chunk on a 40k-window model drains in bounded batches with full coverage", async () => {
    const entries = [
      rawMessage("m0", textForTokens(23_400, "BIG-A")),
      rawMessage("m1", textForTokens(23_400, "BIG-B")),
      rawMessage("m2", textForTokens(23_400, "BIG-C")),
    ];
    const runtime = makeRuntime(100, 1_000_000);
    runtime.config.sessionFallback = false;
    runtime.config.observerModel = { provider: "test-shr", id: "shrink-m" };
    const registry = fakeRegistry(40_000, 2000);
    // Real model resolution (not a scripted resolver): the candidate is
    // size-skipped, the chain exhausts, the chunk shrinks to its budget, and
    // the un-skipped model is re-offered — then the F1 drain covers the rest.
    const baseCtx = ctxWith(entries);
    const generation = runtime.captureGeneration("test-session");
    const { makeModelResolver, runObserverStage: runStage } =
      await import("../src/om/consolidation.js");
    const resolveModel = makeModelResolver(
      runtime,
      { ...baseCtx, modelRegistry: registry },
      generation,
    );

    const outcome = await runStage(
      { appendEntry: vi.fn() } as any,
      runtime,
      ctxWith(entries),
      generation,
      resolveModel,
    );

    // Old behavior: every attempt fails the preflight, the model is
    // persistently cooled, the stage aborts with the cursor unmoved.
    expect(outcome).toBe("continue");
    expect(runObserverSpy).toHaveBeenCalledTimes(3);
    const seen = runObserverSpy.mock.calls.map((call) => call[0].allowedSourceEntryIds);
    expect(seen).toEqual([["m0"], ["m1"], ["m2"]]);
    expect(runtime.getCursor("observer")?.entryId).toBe("m2");
  });

  test("a size mismatch cools nothing: the model is offered again next cycle", async () => {
    const entries = [rawMessage("s0", textForTokens(25_000, "MID"))];
    const runtime = makeRuntime(100, 1_000_000);

    // 25k chunk against a 30k window with the default 32k output allowance:
    // nothing this model can do fits, so the stage must abort — but a
    // too-small window is not a broken model, and cooling it for an hour
    // would wedge every later cycle too.
    const outcome = await runStage(runtime, entries, testModel("test-shr", "nocool-m", 30_000));

    expect(outcome).toBe("abort");
    expect(runObserverSpy).not.toHaveBeenCalled();
    expect(recordCooldownSpy).not.toHaveBeenCalled();
  });
});
