/**
 * Review follow-ups: output-allowance floor + length-cut size-miss routing.
 *
 * A generation cut at `stopReason: "length"` on an input the preflight
 * accepted blames the output allowance, not the model: the stage must
 * size-skip (no persisted cooldown) with shrink-to-fit left open, so the run
 * degrades instead of sidelining a healthy model for an hour.
 *
 * Written FIRST against untouched code (red), then the fixes land (green).
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const testDir = join(tmpdir(), `pi-blackhole-review-output-${Date.now()}`);

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
import { WorkerStreamError } from "../src/om/retryable-error.js";
import {
  observation,
  observationsRecordedEntry,
  rawMessage,
  type TestEntry,
  type TestObservation,
} from "./fixtures/session.js";

const runObserverSpy = vi.hoisted(() => vi.fn<(input: any) => Promise<any>>());
const runReflectorSpy = vi.hoisted(() => vi.fn<(input: any) => Promise<any>>());
const runDropperSpy = vi.hoisted(() => vi.fn<(input: any) => Promise<any>>());

vi.mock("../src/om/agents/observer/agent.js", () => ({
  runObserver: runObserverSpy,
}));

vi.mock("../src/om/agents/reflector/agent.js", () => ({
  runReflector: runReflectorSpy,
}));

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

function observerRuntime(observeAfterTokens: number, chunkMaxTokens: number): Runtime {
  const runtime = new Runtime();
  runtime.config.memory = true;
  runtime.config.observeAfterTokens = observeAfterTokens;
  runtime.config.observerChunkMaxTokens = chunkMaxTokens;
  runtime.config.sessionFallback = false;
  return runtime;
}

function reflectorRuntime(): Runtime {
  const runtime = new Runtime();
  runtime.config.memory = true;
  runtime.config.reflectAfterTokens = 100;
  runtime.config.sessionFallback = false;
  return runtime;
}

function dropperRuntime(): Runtime {
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

const textForTokens = (tokens: number, sentinel: string) =>
  `${sentinel} ${"x".repeat(Math.max(0, tokens * 4 - sentinel.length - 1))}`;

const emptyObserverResult = () => ({
  observations: [],
  emptyReason: { kind: "no_new_content" as const },
});

const lengthCutError = (worker: string) =>
  new WorkerStreamError(
    `${worker} API error: Incomplete agent response (length); coverage not advanced.`,
    0,
    false,
    true,
  );

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
  runObserverSpy.mockReset();
  runReflectorSpy.mockReset();
  runDropperSpy.mockReset();
  runObserverSpy.mockResolvedValue(emptyObserverResult());
  recordCooldownSpy.mockClear();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("length-cut candidate degrades via size-skip, not cooldown", () => {
  test("observer shrinks after a length cut instead of cooling the model", async () => {
    const entries = [
      rawMessage("m0", textForTokens(20_000, "OUT-A")),
      rawMessage("m1", textForTokens(20_000, "OUT-B")),
    ];
    const runtime = observerRuntime(100, 1_000_000);
    // No cooldownHours: a persisted cooldown would prove the model treated as
    // defective. The candidate fits the full chunk, so the preflight admits it.
    runtime.config.observerModel = { provider: "test-out", id: "out-m" };
    // Full two-entry chunks get cut; single-entry remainders succeed.
    runObserverSpy.mockImplementation(async (args: any) => {
      if (args.allowedSourceEntryIds.length > 1) throw lengthCutError("Observer");
      return emptyObserverResult();
    });

    const { makeModelResolver, runObserverStage } = await import("../src/om/consolidation.js");
    const ctx = ctxWith(entries, fakeRegistry(100_000, 2000));
    const generation = runtime.captureGeneration("test-session");
    const outcome = await runObserverStage(
      { appendEntry: vi.fn() } as any,
      runtime,
      ctx,
      generation,
      makeModelResolver(runtime, ctx, generation),
    );

    // Degrade (shrink + drain to full coverage), never cool a healthy model.
    expect(outcome).toBe("continue");
    expect(runObserverSpy.mock.calls.length).toBeGreaterThan(1);
    expect(runtime.getCursor("observer")?.entryId).toBe("m1");
    expect(recordCooldownSpy).not.toHaveBeenCalled();
  });

  test("reflector batches after a length cut instead of cooling the model", async () => {
    const observations: TestObservation[] = [
      observation("aaaaaaaaaaaa", { content: "small one" }),
      observation("bbbbbbbbbbbb", { content: "small two" }),
    ];
    const entries: TestEntry[] = [
      rawMessage("m0", `session context opener ${"x".repeat(20_000)}`),
      observationsRecordedEntry("om-1", { observations, coversUpToId: "m0" }),
    ];
    const runtime = reflectorRuntime();
    runtime.config.reflectorModel = { provider: "test-out", id: "out-r" };
    runReflectorSpy.mockImplementation(async (args: any) => {
      if (args.observations.length > 1) throw lengthCutError("Reflector");
      return {
        reflections: [
          {
            id: `r-${args.observations[0].id}`,
            content: "batched reflection",
            supportingObservationIds: args.observations.map((o: any) => o.id),
            tokenCount: 5,
          },
        ],
      };
    });

    const { makeModelResolver, runReflectorStage } = await import("../src/om/consolidation.js");
    const ctx = ctxWith(entries, fakeRegistry(100_000, 2000));
    const generation = runtime.captureGeneration("test-session");
    const outcome = await runReflectorStage(
      { appendEntry: vi.fn() } as any,
      runtime,
      ctx,
      generation,
      makeModelResolver(runtime, ctx, generation),
    );

    expect(outcome.outcome).toBe("continue");
    expect(runReflectorSpy.mock.calls.length).toBeGreaterThan(1);
    expect(recordCooldownSpy).not.toHaveBeenCalled();
  });

  test("dropper batches after a length cut instead of cooling the model", async () => {
    const observations: TestObservation[] = [
      observation("aaaaaaaaaaaa", { content: "small one", tokenCount: 50_000 }),
      observation("bbbbbbbbbbbb", { content: "small two", tokenCount: 50_000 }),
    ];
    const entries: TestEntry[] = [
      rawMessage("m0", `session context opener ${"x".repeat(20_000)}`),
      observationsRecordedEntry("om-1", { observations, coversUpToId: "m0" }),
    ];
    const runtime = dropperRuntime();
    runtime.config.observationsPoolMaxTokens = 2000;
    runtime.config.dropperModel = { provider: "test-out", id: "out-d" };
    runDropperSpy.mockImplementation(async (args: any) => {
      if (args.observations.length > 1) throw lengthCutError("Dropper");
      return args.observations.slice(0, 1).map((o: any) => o.id);
    });

    const { makeModelResolver, runDropperStage } = await import("../src/om/consolidation.js");
    const ctx = ctxWith(entries, fakeRegistry(100_000, 2000));
    const generation = runtime.captureGeneration("test-session");
    const outcome = await runDropperStage(
      { appendEntry: vi.fn() } as any,
      runtime,
      ctx,
      generation,
      makeModelResolver(runtime, ctx, generation),
      [],
      undefined,
    );

    expect(outcome).toBe("continue");
    expect(runDropperSpy.mock.calls.length).toBeGreaterThan(1);
    expect(recordCooldownSpy).not.toHaveBeenCalled();
  });
});
