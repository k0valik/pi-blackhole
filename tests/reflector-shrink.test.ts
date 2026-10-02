/**
 * Reflector measured preflight + shrink-to-fit batching (follow-up to F1/F2).
 *
 * Unlike the observer the reflector has no drain: its cursor advances over
 * the whole observation window on success, so a partial run must finish ALL
 * batches before anything advances — otherwise unprocessed observations are
 * never crystallized again. When no model fits the full input, the stage
 * partitions the new items into fitting batches against the largest resolved
 * window, runs them with that model, merges, and advances once.
 *
 * Harness: real Runtime, real runReflectorStage (exported for testability
 * like runObserverStage), module-mocked worker, real model resolution
 * against a registry double. getAgentDir is mocked to tmp so the (old)
 * persisted cooldown writes land in isolation.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const testDir = join(tmpdir(), `pi-blackhole-reflector-shrink-${Date.now()}`);

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

import type { ConsolidationCtx } from "../src/om/consolidation.js";
import { Runtime } from "../src/om/runtime.js";
import {
  observation,
  observationsRecordedEntry,
  rawMessage,
  type TestEntry,
  type TestObservation,
} from "./fixtures/session.js";

interface ReflectorCall {
  observations: TestObservation[];
  reflections: unknown[];
}

const runReflectorSpy = vi.hoisted(() =>
  vi.fn<(args: ReflectorCall) => Promise<{ reflections: unknown[] }>>(),
);

vi.mock("../src/om/agents/reflector/agent.js", () => ({
  runReflector: runReflectorSpy,
}));

function ctxWith(entries: TestEntry[], modelRegistry: unknown): ConsolidationCtx {
  return {
    cwd: "/tmp",
    hasUI: false,
    ui: undefined,
    model: undefined,
    modelRegistry,
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => "test-session",
    },
  } as unknown as ConsolidationCtx;
}

function makeRuntime(): Runtime {
  const runtime = new Runtime();
  runtime.config.memory = true;
  runtime.config.reflectAfterTokens = 100;
  runtime.config.sessionFallback = false;
  return runtime;
}

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

/** Large observation pool behind one recorded marker. */
function poolBranch(count: number, tokensEach: number): { entries: TestEntry[]; ids: string[] } {
  const ids: string[] = [];
  const observations: TestObservation[] = [];
  for (let i = 0; i < count; i += 1) {
    // Ledger ids must match MEMORY_ID_PATTERN (12 hex chars) or the marker
    // fails validation and the stage sees an empty pool.
    const id = `abcdabcd${String(i).padStart(4, "0")}`;
    ids.push(id);
    observations.push(
      observation(id, {
        content: `POOL-${i} ${"x".repeat(Math.max(0, tokensEach * 4 - 10))}`,
      }),
    );
  }
  const entries: TestEntry[] = [
    // Large opener: the reflector due-gate (rawTokensSinceReflectionCoverage)
    // only counts source entries, so the pool marker alone cannot trip it.
    rawMessage("m0", `session context opener ${"x".repeat(20_000)}`),
    observationsRecordedEntry("om-1", { observations, coversUpToId: "m0" }),
  ];
  return { entries, ids };
}

let batchSeq = 0;

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
  batchSeq = 0;
  runReflectorSpy.mockReset();
  // One reflection per batch, supporting exactly that batch's observations:
  // the merge across batches is asserted on supportingObservationIds union.
  runReflectorSpy.mockImplementation(async (args) => ({
    reflections: [
      {
        id: `r-batch-${batchSeq++}`,
        content: "batched reflection",
        supportingObservationIds: args.observations.map((o) => o.id),
        tokenCount: 5,
      },
    ],
  }));
  recordCooldownSpy.mockClear();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function runStage(runtime: Runtime, entries: TestEntry[], registry: unknown) {
  const { makeModelResolver, runReflectorStage } = await import("../src/om/consolidation.js");
  const ctx = ctxWith(entries, registry);
  const generation = runtime.captureGeneration("test-session");
  const appendEntry = vi.fn(() => true);
  const outcome = await runReflectorStage(
    { appendEntry } as any,
    runtime,
    ctx,
    generation,
    makeModelResolver(runtime, ctx, generation),
  );
  return { outcome, appendEntry };
}

describe("reflector shrink-to-fit batching", () => {
  test("a chunk the old formula accepted is skipped once the output allowance is priced", async () => {
    // A single ~11k observation against a 20k window: the old input-only
    // check (11k + 8000 < 20k) runs the model, but input + the output
    // allowance cannot share the window. A single item also defeats the
    // shrink (its lone batch still overflows), so the stage aborts.
    const { entries } = poolBranch(1, 11_000);
    const runtime = makeRuntime();
    runtime.config.reflectorModel = { provider: "test-shr", id: "ref-out-rsv-m" };

    const { outcome } = await runStage(runtime, entries, fakeRegistry(20_000));

    expect(outcome.outcome).toBe("abort");
    expect(runReflectorSpy).not.toHaveBeenCalled();
  });

  test("a 130k pool on a 50k-window model batches with one advance at the end", async () => {
    const { entries, ids } = poolBranch(13, 10_000);
    const runtime = makeRuntime();
    runtime.config.reflectorModel = { provider: "test-shr", id: "ref-shrink-m" };

    const { outcome, appendEntry } = await runStage(runtime, entries, fakeRegistry(50_000, 2000));

    // Old behavior: every attempt fails the preflight and the stage aborts
    // with the cursor unmoved. New: the pool is partitioned into fitting
    // batches, all run before anything advances.
    expect(outcome.outcome).toBe("continue");
    expect(runReflectorSpy.mock.calls.length).toBeGreaterThan(1);
    // T4: every observation was shown to exactly one batch (union, no drops).
    const seen = runReflectorSpy.mock.calls
      .flatMap((call) => call[0].observations.map((o) => o.id))
      .sort();
    expect(seen).toEqual([...ids].sort());
    // And the cursor advanced exactly once, over the merged result.
    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(outcome.sameRunReflections).toHaveLength(runReflectorSpy.mock.calls.length);
    expect(runtime.getCursor("reflector")?.state).toBe("recorded");
    // Every batch dispatches the preflight allowance for the largest window.
    const { workerOutputAllowance } = await import("../src/om/prompt-budget.js");
    for (const call of runReflectorSpy.mock.calls) {
      expect((call[0] as any).maxOutputTokens).toBe(
        workerOutputAllowance(50_000, { maxTokens: 2000 } as any),
      );
    }
  });

  test("a size mismatch cools nothing: the model is offered again next cycle", async () => {
    const { entries } = poolBranch(1, 11_000);
    const runtime = makeRuntime();
    runtime.config.reflectorModel = { provider: "test-shr", id: "ref-nocool-m" };

    const { outcome } = await runStage(runtime, entries, fakeRegistry(20_000));

    expect(outcome.outcome).toBe("abort");
    expect(runReflectorSpy).not.toHaveBeenCalled();
    expect(recordCooldownSpy).not.toHaveBeenCalled();
  });

  test("a fitting run dispatches the preflight output allowance", async () => {
    const { entries } = poolBranch(2, 50);
    const runtime = makeRuntime();
    runtime.config.reflectorModel = { provider: "test-shr", id: "ref-cap-m" };

    const { outcome } = await runStage(runtime, entries, fakeRegistry(20_000));

    // ~100 tokens of items against a 20k window: the normal path runs (no
    // shrink), and the dispatched generation cap is the preflight allowance
    // — a quarter of the window here, not the legacy 32k.
    expect(outcome.outcome).toBe("continue");
    expect(runReflectorSpy).toHaveBeenCalledTimes(1);
    const { workerOutputAllowance } = await import("../src/om/prompt-budget.js");
    expect((runReflectorSpy.mock.calls[0][0] as any).maxOutputTokens).toBe(
      workerOutputAllowance(20_000, undefined),
    );
  });
});
