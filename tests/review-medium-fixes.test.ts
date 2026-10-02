/**
 * Review follow-ups: every medium finding, one passing criterion each.
 *
 * Written FIRST against untouched code (red), then the fixes land (green).
 * Real Runtime + real stages, module-mocked workers, tmp-isolated cooldowns.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const testDir = join(tmpdir(), `pi-blackhole-review-medium-${Date.now()}`);

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

/** Registry double resolving every candidate with a fixed window. */
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

/** ~tokens estimated tokens of plain message text. */
const textForTokens = (tokens: number, sentinel: string) =>
  `${sentinel} ${"x".repeat(Math.max(0, tokens * 4 - sentinel.length - 1))}`;

const emptyObserverResult = () => ({
  observations: [],
  emptyReason: { kind: "no_new_content" as const },
});

/** Reflector pool behind one recorded marker + a token-counting opener. */
function reflectorPool(
  count: number,
  content: string,
  storedTokensEach = 10,
): { entries: TestEntry[]; ids: string[]; observations: TestObservation[] } {
  const ids: string[] = [];
  const observations: TestObservation[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `abcdabcd${String(i).padStart(4, "0")}`;
    ids.push(id);
    observations.push(observation(id, { content, tokenCount: storedTokensEach }));
  }
  const entries: TestEntry[] = [
    rawMessage("m0", `session context opener ${"x".repeat(20_000)}`),
    observationsRecordedEntry("om-1", { observations, coversUpToId: "m0" }),
  ];
  return { entries, ids, observations };
}

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

describe("M1: batch planners price rendered lines, not bare content", () => {
  test("reflector shrinks a single item whose wrappers overflow the batch", async () => {
    const { estimateStringTokens } = await import("../src/om/tokens.js");
    const { WORKER_TURN_HEADROOM_TOKENS, workerInputBudget, workerStaticPromptTokens } =
      await import("../src/om/prompt-budget.js");
    const { observationToSummaryLine } = await import("../src/om/ledger/index.js");

    const obs = observation("aaaaaaaaaaaa", { content: "x" });
    const contentTokens = estimateStringTokens(obs.content);
    const renderedTokens = estimateStringTokens(observationToSummaryLine(obs));
    // Setup validity: the wrapper must add real cost, or nothing discriminates.
    expect(renderedTokens - contentTokens).toBeGreaterThanOrEqual(6);

    const staticTokens = workerStaticPromptTokens("reflector");
    // Fresh pool: both existing summaries are "" so summaryTokens prices "\n".
    const summaryTokens = estimateStringTokens(`${""}\n${""}`);
    const fixedOverhead = summaryTokens + staticTokens + WORKER_TURN_HEADROOM_TOKENS;
    const itemTarget = contentTokens + Math.floor((renderedTokens - contentTokens) / 2);
    // Model reserve 500 (maxTokens: 500); window/4 must exceed it for exact math.
    const contextWindow = itemTarget + 500 + 1024 + fixedOverhead;
    expect(contextWindow / 4).toBeGreaterThan(500);

    const { entries } = reflectorPool(1, "x");
    const runtime = reflectorRuntime();
    runtime.config.reflectorModel = { provider: "test-m1", id: "m1-r" };

    const { makeModelResolver, runReflectorStage } = await import("../src/om/consolidation.js");
    const ctx = ctxWith(entries, fakeRegistry(contextWindow, 500));
    const generation = runtime.captureGeneration("test-session");
    const outcome = await runReflectorStage(
      { appendEntry: vi.fn() } as any,
      runtime,
      ctx,
      generation,
      makeModelResolver(runtime, ctx, generation),
    );

    // Content fits but the rendered line does not: no model call may go out.
    expect(runReflectorSpy).not.toHaveBeenCalled();
    expect(outcome.outcome).toBe("abort");
    void workerInputBudget;
  });

  test("dropper shrinks a single item whose wrappers overflow the batch", async () => {
    const { estimateStringTokens } = await import("../src/om/tokens.js");
    const { WORKER_TURN_HEADROOM_TOKENS, workerStaticPromptTokens } =
      await import("../src/om/prompt-budget.js");
    const { coverageTierForObservation, observationToDropperLine, reflectionCoverageMap } =
      await import("../src/om/agents/dropper/coverage.js");

    const obs = observation("aaaaaaaaaaaa", { content: "x", tokenCount: 50_000 });
    const contentTokens = estimateStringTokens(obs.content);
    const coverageById = reflectionCoverageMap([obs], []);
    const renderedTokens = estimateStringTokens(
      observationToDropperLine(obs, coverageTierForObservation(obs, coverageById)),
    );
    expect(renderedTokens - contentTokens).toBeGreaterThanOrEqual(6);

    const staticTokens = workerStaticPromptTokens("dropper");
    // Fresh pool: no existing summary, no reflections.
    const fixedOverhead = staticTokens + WORKER_TURN_HEADROOM_TOKENS;
    const itemTarget = contentTokens + Math.floor((renderedTokens - contentTokens) / 2);
    const contextWindow = itemTarget + 500 + 1024 + fixedOverhead;
    expect(contextWindow / 4).toBeGreaterThan(500);

    const entries: TestEntry[] = [
      rawMessage("m0", `session context opener ${"x".repeat(20_000)}`),
      observationsRecordedEntry("om-1", { observations: [obs], coversUpToId: "m0" }),
    ];
    const runtime = dropperRuntime();
    runtime.config.observationsPoolMaxTokens = 2000;
    runtime.config.dropperModel = { provider: "test-m1", id: "m1-d" };

    const { makeModelResolver, runDropperStage } = await import("../src/om/consolidation.js");
    const ctx = ctxWith(entries, fakeRegistry(contextWindow, 500));
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

    expect(runDropperSpy).not.toHaveBeenCalled();
    expect(outcome).toBe("abort");
  });
});

describe("M2: shrink batch fan-out is bounded per invocation", () => {
  test("reflector defers a pool needing far more batches than the cap", async () => {
    // ~500k content tokens on a 50k window: ~12 batches content-planned.
    const { entries } = reflectorPool(100, `POOL ${"x".repeat(20_000)}`);
    const runtime = reflectorRuntime();
    runtime.config.reflectorModel = { provider: "test-m2", id: "m2-r" };
    runReflectorSpy.mockImplementation(async (args) => ({
      reflections: [
        {
          id: `r-${Math.random()}`,
          content: "batched reflection",
          supportingObservationIds: args.observations.map((o: any) => o.id),
          tokenCount: 5,
        },
      ],
    }));

    const consolidation = await import("../src/om/consolidation.js");
    const cap = (consolidation as any).WORKER_SHRINK_MAX_BATCHES;
    expect(cap).toBeLessThanOrEqual(12);

    const ctx = ctxWith(entries, fakeRegistry(50_000, 2000));
    const generation = runtime.captureGeneration("test-session");
    const outcome = await consolidation.runReflectorStage(
      { appendEntry: vi.fn() } as any,
      runtime,
      ctx,
      generation,
      consolidation.makeModelResolver(runtime, ctx, generation),
    );

    // Bounded cost: no model call goes out, nothing advances.
    expect(runReflectorSpy).not.toHaveBeenCalled();
    expect(outcome.outcome).toBe("abort");
  });

  test("dropper defers a pool needing far more batches than the cap", async () => {
    const ids: string[] = [];
    const observations: TestObservation[] = [];
    for (let i = 0; i < 100; i += 1) {
      const id = `abcdabcd${String(i).padStart(4, "0")}`;
      ids.push(id);
      observations.push(
        observation(id, { content: `POOL-${i} ${"x".repeat(20_000)}`, tokenCount: 10_000 }),
      );
    }
    const entries: TestEntry[] = [
      rawMessage("m0", `session context opener ${"x".repeat(20_000)}`),
      observationsRecordedEntry("om-1", { observations, coversUpToId: "m0" }),
    ];
    const runtime = dropperRuntime();
    runtime.config.observationsPoolMaxTokens = 2000;
    runtime.config.dropperModel = { provider: "test-m2", id: "m2-d" };
    runDropperSpy.mockImplementation(async (args: any) =>
      args.observations.slice(0, 2).map((o: any) => o.id),
    );

    const consolidation = await import("../src/om/consolidation.js");
    const cap = (consolidation as any).WORKER_SHRINK_MAX_BATCHES;
    expect(cap).toBeLessThanOrEqual(12);

    const ctx = ctxWith(entries, fakeRegistry(50_000, 2000));
    const generation = runtime.captureGeneration("test-session");
    const outcome = await consolidation.runDropperStage(
      { appendEntry: vi.fn() } as any,
      runtime,
      ctx,
      generation,
      consolidation.makeModelResolver(runtime, ctx, generation),
      [],
      undefined,
    );

    expect(runDropperSpy).not.toHaveBeenCalled();
    expect(outcome).toBe("abort");
    void ids;
  });
});

describe("M3: size-skips do not consume the attempt budget", () => {
  test("observer shrinks after exhausting 11 too-small candidates", async () => {
    const entries = [
      rawMessage("m0", textForTokens(23_400, "BIG-A")),
      rawMessage("m1", textForTokens(23_400, "BIG-B")),
      rawMessage("m2", textForTokens(23_400, "BIG-C")),
    ];
    const runtime = observerRuntime(100, 1_000_000);
    runtime.config.observerModel = { provider: "test-m3", id: "m3-primary" };
    runtime.config.observerFallbackModels = Array.from({ length: 10 }, (_, i) => ({
      provider: "test-m3",
      id: `m3-fb-${i}`,
    }));

    const { makeModelResolver, runObserverStage } = await import("../src/om/consolidation.js");
    const ctx = ctxWith(entries, fakeRegistry(40_000, 2000));
    const generation = runtime.captureGeneration("test-session");
    const outcome = await runObserverStage(
      { appendEntry: vi.fn() } as any,
      runtime,
      ctx,
      generation,
      makeModelResolver(runtime, ctx, generation),
    );

    // Cheap skips must not eat the 10 error attempts: the shrink still fires.
    expect(outcome).toBe("continue");
    expect(runObserverSpy).toHaveBeenCalled();
    expect(runtime.getCursor("observer")?.entryId).toBe("m2");
  });

  test("reflector batches after exhausting 11 too-small candidates", async () => {
    const { entries, ids } = reflectorPool(6, `POOL ${"x".repeat(10_000)}`);
    const runtime = reflectorRuntime();
    runtime.config.reflectorModel = { provider: "test-m3", id: "m3r-primary" };
    runtime.config.reflectorFallbackModels = Array.from({ length: 10 }, (_, i) => ({
      provider: "test-m3",
      id: `m3r-fb-${i}`,
    }));
    let batchSeq = 0;
    runReflectorSpy.mockImplementation(async (args: any) => ({
      reflections: [
        {
          id: `r-batch-${batchSeq++}`,
          content: "batched reflection",
          supportingObservationIds: args.observations.map((o: any) => o.id),
          tokenCount: 5,
        },
      ],
    }));

    const { makeModelResolver, runReflectorStage } = await import("../src/om/consolidation.js");
    const ctx = ctxWith(entries, fakeRegistry(20_000));
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
    const seen = runReflectorSpy.mock.calls
      .flatMap((call) => call[0].observations.map((o: any) => o.id))
      .sort();
    expect(seen).toEqual([...ids].sort());
  });

  test("dropper batches after exhausting 11 too-small candidates", async () => {
    const ids: string[] = [];
    const observations: TestObservation[] = [];
    for (let i = 0; i < 6; i += 1) {
      const id = `abcdabcd${String(i).padStart(4, "0")}`;
      ids.push(id);
      observations.push(
        observation(id, { content: `POOL-${i} ${"x".repeat(10_000)}`, tokenCount: 10_000 }),
      );
    }
    const entries: TestEntry[] = [
      rawMessage("m0", `session context opener ${"x".repeat(20_000)}`),
      observationsRecordedEntry("om-1", { observations, coversUpToId: "m0" }),
    ];
    const runtime = dropperRuntime();
    runtime.config.observationsPoolMaxTokens = 2000;
    runtime.config.dropperModel = { provider: "test-m3", id: "m3d-primary" };
    runtime.config.dropperFallbackModels = Array.from({ length: 10 }, (_, i) => ({
      provider: "test-m3",
      id: `m3d-fb-${i}`,
    }));
    runDropperSpy.mockImplementation(async (args: any) =>
      args.observations.slice(0, 2).map((o: any) => o.id),
    );

    const { makeModelResolver, runDropperStage } = await import("../src/om/consolidation.js");
    const ctx = ctxWith(entries, fakeRegistry(20_000));
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
    const seen = runDropperSpy.mock.calls
      .flatMap((call) => call[0].observations.map((o: any) => o.id))
      .sort();
    expect(seen).toEqual([...ids].sort());
  });
});

describe("M4: drain re-evaluates size-skips against the smaller remainder", () => {
  test("a model skipped for the parent chunk runs the drain remainder", async () => {
    const entries = [
      rawMessage("m0", textForTokens(20_000, "BIG-A")),
      rawMessage("m1", textForTokens(5_000, "SMALL-B")),
    ];
    const runtime = observerRuntime(100, 22_000);
    runtime.config.observerModel = { provider: "test-m4", id: "m4-small" };
    runtime.config.observerFallbackModels = [{ provider: "test-m4", id: "m4-big" }];
    const registry = {
      find: (provider: string, id: string) => ({
        provider,
        id,
        contextWindow: id === "m4-small" ? 30_000 : 60_000,
      }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
    };

    const { makeModelResolver, runObserverStage } = await import("../src/om/consolidation.js");
    const ctx = ctxWith(entries, registry);
    const generation = runtime.captureGeneration("test-session");
    const outcome = await runObserverStage(
      { appendEntry: vi.fn() } as any,
      runtime,
      ctx,
      generation,
      makeModelResolver(runtime, ctx, generation),
    );

    expect(outcome).toBe("continue");
    expect(runObserverSpy).toHaveBeenCalledTimes(2);
    expect((runObserverSpy.mock.calls[0][0] as any).model.id).toBe("m4-big");
    // The remainder fits the small model: it must be re-offered, not skipped.
    expect((runObserverSpy.mock.calls[1][0] as any).model.id).toBe("m4-small");
    expect(runtime.getCursor("observer")?.entryId).toBe("m1");
  });
});

describe("M5: a turn-cap-only record still allows shrink-to-fit", () => {
  test("observer shrinks after a turn-cap when the largest window was skipped", async () => {
    const entries = [
      rawMessage("m0", textForTokens(20_000, "M5-A")),
      rawMessage("m1", textForTokens(20_000, "M5-B")),
    ];
    const runtime = observerRuntime(100, 1_000_000);
    runtime.config.observerModel = { provider: "test-m5", id: "m5-a", cooldownHours: 0 };
    runtime.config.observerFallbackModels = [{ provider: "test-m5", id: "m5-b", cooldownHours: 0 }];
    // A (50k window, tiny output reserve) fits the ~40k chunk and runs;
    // B (60k window, huge output reserve) is the largest but size-skipped.
    const registry = {
      find: (provider: string, id: string) => ({
        provider,
        id,
        contextWindow: id === "m5-a" ? 50_000 : 60_000,
        maxTokens: id === "m5-a" ? 500 : 32_000,
      }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
    };
    let calls = 0;
    runObserverSpy.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        throw new WorkerStreamError(
          "Observer turn cap exhausted: 2 observations recorded with no complete=true close",
          2,
          true,
        );
      }
      return emptyObserverResult();
    });

    const { makeModelResolver, runObserverStage } = await import("../src/om/consolidation.js");
    const ctx = ctxWith(entries, registry);
    const generation = runtime.captureGeneration("test-session");
    const outcome = await runObserverStage(
      { appendEntry: vi.fn() } as any,
      runtime,
      ctx,
      generation,
      makeModelResolver(runtime, ctx, generation),
    );

    expect(outcome).toBe("continue");
    expect(runObserverSpy.mock.calls.length).toBeGreaterThan(1);
  });

  test("reflector batches after a turn-cap when the largest window was skipped", async () => {
    // ~10k tokens each: the full ~40k pool fits A but not B (see M5-observer).
    const { entries, ids } = reflectorPool(4, `POOL ${"x".repeat(40_000)}`);
    const runtime = reflectorRuntime();
    runtime.config.reflectorModel = { provider: "test-m5", id: "m5r-a", cooldownHours: 0 };
    runtime.config.reflectorFallbackModels = [
      { provider: "test-m5", id: "m5r-b", cooldownHours: 0 },
    ];
    const registry = {
      find: (provider: string, id: string) => ({
        provider,
        id,
        contextWindow: id === "m5r-a" ? 50_000 : 60_000,
        maxTokens: id === "m5r-a" ? 500 : 32_000,
      }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
    };
    let calls = 0;
    runReflectorSpy.mockImplementation(async (args: any) => {
      calls += 1;
      if (calls === 1) {
        throw new WorkerStreamError(
          "Reflector turn cap exhausted: 2 reflections recorded with no complete=true close",
          2,
          true,
        );
      }
      return {
        reflections: [
          {
            id: `r-batch-${calls}`,
            content: "batched reflection",
            supportingObservationIds: args.observations.map((o: any) => o.id),
            tokenCount: 5,
          },
        ],
      };
    });

    const { makeModelResolver, runReflectorStage } = await import("../src/om/consolidation.js");
    const ctx = ctxWith(entries, registry);
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
    const seen = runReflectorSpy.mock.calls
      .slice(1)
      .flatMap((call) => call[0].observations.map((o: any) => o.id))
      .sort();
    expect(seen).toEqual([...ids].sort());
  });

  test("dropper batches after a turn-cap when the largest window was skipped", async () => {
    const ids: string[] = [];
    const observations: TestObservation[] = [];
    for (let i = 0; i < 4; i += 1) {
      const id = `abcdabcd${String(i).padStart(4, "0")}`;
      ids.push(id);
      observations.push(
        observation(id, { content: `POOL-${i} ${"x".repeat(44_000)}`, tokenCount: 11_000 }),
      );
    }
    const entries: TestEntry[] = [
      rawMessage("m0", `session context opener ${"x".repeat(20_000)}`),
      observationsRecordedEntry("om-1", { observations, coversUpToId: "m0" }),
    ];
    const runtime = dropperRuntime();
    runtime.config.observationsPoolMaxTokens = 2000;
    runtime.config.dropperModel = { provider: "test-m5", id: "m5d-a", cooldownHours: 0 };
    runtime.config.dropperFallbackModels = [{ provider: "test-m5", id: "m5d-b", cooldownHours: 0 }];
    const registry = {
      find: (provider: string, id: string) => ({
        provider,
        id,
        contextWindow: id === "m5d-a" ? 50_000 : 60_000,
        maxTokens: id === "m5d-a" ? 500 : 32_000,
      }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
    };
    let calls = 0;
    runDropperSpy.mockImplementation(async (args: any) => {
      calls += 1;
      if (calls === 1) {
        throw new WorkerStreamError(
          "Dropper turn cap exhausted: 2 drop candidates recorded before the run ended",
          2,
          true,
        );
      }
      return args.observations.slice(0, 2).map((o: any) => o.id);
    });

    const { makeModelResolver, runDropperStage } = await import("../src/om/consolidation.js");
    const ctx = ctxWith(entries, registry);
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
    void ids;
  });
});

describe("M6: a length-cut session model breaks instead of burning all attempts", () => {
  const lengthCutError = (worker: string) =>
    new WorkerStreamError(
      `${worker} API error: Incomplete agent response (length); coverage not advanced.`,
      0,
      false,
      true,
    );

  test("observer stops after one length-cut session attempt", async () => {
    const entries = [rawMessage("m0", textForTokens(1_000, "M6"))];
    const runtime = observerRuntime(100, 1_000_000);
    runtime.config.sessionFallback = true;
    runObserverSpy.mockRejectedValue(lengthCutError("Observer"));

    const { runObserverStage } = await import("../src/om/consolidation.js");
    const generation = runtime.captureGeneration("test-session");
    const outcome = await runObserverStage(
      { appendEntry: vi.fn() } as any,
      runtime,
      ctxWith(entries, fakeRegistry(0)),
      generation,
      async () =>
        ({
          source: "session" as const,
          model: { provider: "test-m6", id: "sess-m", contextWindow: 100_000 },
          apiKey: "k",
        }) as any,
    );

    expect(outcome).toBe("abort");
    expect(runObserverSpy).toHaveBeenCalledTimes(1);
    expect(recordCooldownSpy).not.toHaveBeenCalled();
  });

  test("reflector stops after one length-cut session attempt", async () => {
    const { entries } = reflectorPool(1, "tiny reflection input");
    const runtime = reflectorRuntime();
    runtime.config.sessionFallback = true;
    runReflectorSpy.mockRejectedValue(lengthCutError("Reflector"));

    const { runReflectorStage } = await import("../src/om/consolidation.js");
    const ctx = ctxWith(entries, fakeRegistry(0));
    const generation = runtime.captureGeneration("test-session");
    const outcome = await runReflectorStage(
      { appendEntry: vi.fn() } as any,
      runtime,
      ctx,
      generation,
      async () =>
        ({
          source: "session" as const,
          model: { provider: "test-m6", id: "sess-m", contextWindow: 100_000 },
          apiKey: "k",
        }) as any,
    );

    expect(outcome.outcome).toBe("abort");
    expect(runReflectorSpy).toHaveBeenCalledTimes(1);
    expect(recordCooldownSpy).not.toHaveBeenCalled();
  });

  test("dropper stops after one length-cut session attempt", async () => {
    const obs = observation("aaaaaaaaaaaa", { content: "tiny", tokenCount: 50_000 });
    const entries: TestEntry[] = [
      rawMessage("m0", `session context opener ${"x".repeat(20_000)}`),
      observationsRecordedEntry("om-1", { observations: [obs], coversUpToId: "m0" }),
    ];
    const runtime = dropperRuntime();
    runtime.config.observationsPoolMaxTokens = 2000;
    runtime.config.sessionFallback = true;
    runDropperSpy.mockRejectedValue(lengthCutError("Dropper"));

    const { runDropperStage } = await import("../src/om/consolidation.js");
    const ctx = ctxWith(entries, fakeRegistry(0));
    const generation = runtime.captureGeneration("test-session");
    const outcome = await runDropperStage(
      { appendEntry: vi.fn() } as any,
      runtime,
      ctx,
      generation,
      async () =>
        ({
          source: "session" as const,
          model: { provider: "test-m6", id: "sess-m", contextWindow: 100_000 },
          apiKey: "k",
        }) as any,
      [],
      undefined,
    );

    expect(outcome).toBe("abort");
    expect(runDropperSpy).toHaveBeenCalledTimes(1);
    expect(recordCooldownSpy).not.toHaveBeenCalled();
  });
});

describe("M7: bridge calls the matched provider handler outside the guard", () => {
  test("a synchronously throwing custom handler surfaces instead of falling through", async () => {
    const { createBridgeStreamFn } = await import("../src/om/provider-stream.js");
    const customHandler = () => {
      throw new Error("custom-auth-boom");
    };
    const registry = {
      getRegisteredProviderIds: () => ["custom-a"],
      getRegisteredProviderConfig: (id: string) =>
        id === "custom-a" ? { api: "openai-completions", streamSimple: customHandler } : undefined,
    };
    const compat = () => {
      throw new Error("compat-boom");
    };
    const fn = createBridgeStreamFn(compat, registry);
    expect(() => fn({ provider: "custom-a", api: "openai-completions" }, {}, {})).toThrow(
      "custom-auth-boom",
    );
  });

  test("a healthy custom handler still routes by exact provider match", async () => {
    const { createBridgeStreamFn } = await import("../src/om/provider-stream.js");
    const registry = {
      getRegisteredProviderIds: () => ["custom-a", "custom-b"],
      getRegisteredProviderConfig: (id: string) => ({
        api: "openai-completions",
        streamSimple: (...args: unknown[]) => `ok-${id}:${args.length}`,
      }),
    };
    const fn = createBridgeStreamFn(() => "compat", registry);
    expect(fn({ provider: "custom-b", api: "openai-completions" }, {}, {})).toBe("ok-custom-b:3");
  });
});

describe("M8: shrink un-skips the same identity the skip recorded", () => {
  test("observer re-offers the best model when the registry aliases its id", async () => {
    const entries = [
      rawMessage("m0", textForTokens(23_400, "BIG-A")),
      rawMessage("m1", textForTokens(23_400, "BIG-B")),
      rawMessage("m2", textForTokens(23_400, "BIG-C")),
    ];
    const runtime = observerRuntime(100, 1_000_000);
    runtime.config.observerModel = { provider: "test-m8", id: "m8-m" };
    // Registry normalizes the id: the resolved model never matches the
    // candidate config the skip recorded.
    const registry = {
      find: (_provider: string, _id: string) => ({
        provider: "test-m8",
        id: "m8-m-aliased",
        contextWindow: 40_000,
        maxTokens: 2000,
      }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
    };

    const { makeModelResolver, runObserverStage } = await import("../src/om/consolidation.js");
    const ctx = ctxWith(entries, registry);
    const generation = runtime.captureGeneration("test-session");
    const outcome = await runObserverStage(
      { appendEntry: vi.fn() } as any,
      runtime,
      ctx,
      generation,
      makeModelResolver(runtime, ctx, generation),
    );

    expect(outcome).toBe("continue");
    expect(runObserverSpy).toHaveBeenCalled();
    expect(runtime.getCursor("observer")?.entryId).toBe("m2");
  });
});
