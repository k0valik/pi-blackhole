/**
 * Dropper measured preflight + shrink-to-fit batching (follow-up to F1/F2).
 *
 * The pressure run ships the whole live pool deliberately uncapped, so an
 * oversized pool fails every model's preflight and the stage aborts every
 * cycle with the cursor unmoved. The fix partitions the candidate pool into
 * fitting batches evaluated with the same global pressure numbers, merges
 * the raw proposals, and applies the deterministic ranker + global cap once
 * before the single advance — a partial evaluation must never be published
 * as a finished one under the drop marker.
 *
 * Harness: real Runtime, real runDropperStage (exported for testability),
 * module-mocked worker, real model resolution against a registry double.
 * getAgentDir is mocked to tmp so the (old) persisted cooldown writes land
 * in isolation. Pool fixtures carry production-shaped stored tokenCounts
 * (pressure sums stored counts, not content).
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const testDir = join(tmpdir(), `pi-blackhole-dropper-shrink-${Date.now()}`);

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

interface DropperCall {
  observations: TestObservation[];
}

const runDropperSpy = vi.hoisted(() =>
  vi.fn<(args: DropperCall) => Promise<string[] | undefined>>(),
);

vi.mock("../src/om/agents/dropper/agent.js", () => ({
  runDropper: runDropperSpy,
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

/** Observation pool behind one recorded marker (valid ledger ids). */
function poolBranch(
  count: number,
  tokensEach: number,
  storedTokensEach?: number,
): { entries: TestEntry[]; ids: string[] } {
  const ids: string[] = [];
  const observations: TestObservation[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `abcdabcd${String(i).padStart(4, "0")}`;
    ids.push(id);
    observations.push(
      observation(id, {
        content: `POOL-${i} ${"x".repeat(Math.max(0, tokensEach * 4 - 10))}`,
        tokenCount: storedTokensEach ?? 10,
      }),
    );
  }
  const entries: TestEntry[] = [
    // Large opener: the dropper due-gate (rawTokensSinceDropCoverage) only
    // counts source entries, so the pool marker alone cannot trip it.
    rawMessage("m0", `session context opener ${"x".repeat(20_000)}`),
    observationsRecordedEntry("om-1", { observations, coversUpToId: "m0" }),
  ];
  return { entries, ids };
}

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
  runDropperSpy.mockReset();
  // Propose the first two ids of every evaluated batch: the global cap is
  // asserted on the merged union, not on any single batch.
  runDropperSpy.mockImplementation(async (args) => args.observations.slice(0, 2).map((o) => o.id));
  recordCooldownSpy.mockClear();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function runStage(runtime: Runtime, entries: TestEntry[], registry: unknown) {
  const { makeModelResolver, runDropperStage } = await import("../src/om/consolidation.js");
  const ctx = ctxWith(entries, registry);
  const generation = runtime.captureGeneration("test-session");
  const appendEntry = vi.fn(() => true);
  const outcome = await runDropperStage(
    { appendEntry } as any,
    runtime,
    ctx,
    generation,
    makeModelResolver(runtime, ctx, generation),
    [],
    undefined,
  );
  return { outcome, appendEntry };
}

describe("dropper shrink-to-fit batching", () => {
  test("a pool the old formula accepted is skipped once the output allowance is priced", async () => {
    // ~11.5k content tokens against a 20k window: the old input-only check
    // (11.5k + 8000 < 20k) runs the model, but input + the output allowance
    // cannot share the window. Stored counts stay tiny, so the pool is far
    // under the fullness threshold either way.
    const { entries } = poolBranch(2, 5750, 10);
    const runtime = makeRuntime();
    runtime.config.observationsPoolMaxTokens = 1_000_000;
    runtime.config.dropperModel = { provider: "test-shr", id: "drop-out-rsv-m" };

    const { outcome } = await runStage(runtime, entries, fakeRegistry(20_000));

    // Nothing in the pool is droppable (far under the fullness threshold),
    // so the stage commits empty without spending model calls — even though
    // no model fits the input.
    expect(outcome).toBe("continue");
    expect(runDropperSpy).not.toHaveBeenCalled();
  });

  test("a 130k pressure pool on a 50k-window model batches with one global selection", async () => {
    const { entries, ids } = poolBranch(13, 10_000, 10_000);
    const runtime = makeRuntime();
    runtime.config.observationsPoolMaxTokens = 2000;
    runtime.config.dropperModel = { provider: "test-shr", id: "drop-shrink-m" };

    const { outcome, appendEntry } = await runStage(runtime, entries, fakeRegistry(50_000, 2000));

    // Old behavior: every attempt fails the preflight and the stage aborts
    // with the cursor unmoved. New: every pool member is evaluated across
    // bounded batches, then the ranker + global cap apply once.
    expect(outcome).toBe("continue");
    expect(runDropperSpy.mock.calls.length).toBeGreaterThan(1);
    // T4: the whole pool was evaluated (union over batches, no member lost).
    const seen = runDropperSpy.mock.calls
      .flatMap((call) => call[0].observations.map((o) => o.id))
      .sort();
    expect(seen).toEqual([...ids].sort());
    // One advance, globally capped: 7-8 raw proposals across batches cannot
    // exceed the pool-wide maxDrops (13 members at 0.5 ratio = 6).
    expect(appendEntry).toHaveBeenCalledTimes(1);
    const data = appendEntry.mock.calls[0][1] as { observationIds: string[] };
    expect(data.observationIds).toHaveLength(6);
    expect(runtime.getCursor("dropper")?.state).toBe("recorded");
  });

  test("a size mismatch cools nothing: the model is offered again next cycle", async () => {
    const { entries } = poolBranch(2, 5750, 10);
    const runtime = makeRuntime();
    runtime.config.observationsPoolMaxTokens = 1_000_000;
    runtime.config.dropperModel = { provider: "test-shr", id: "drop-nocool-m" };

    const { outcome } = await runStage(runtime, entries, fakeRegistry(20_000));

    // Settles instead of wedging: the under-target pool commits empty (no
    // model call, no cooldown), so the model stays available next cycle.
    expect(outcome).toBe("continue");
    expect(runDropperSpy).not.toHaveBeenCalled();
    expect(recordCooldownSpy).not.toHaveBeenCalled();
  });
});
