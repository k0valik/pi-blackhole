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

const debugEvents = vi.hoisted(() => [] as Array<{ event: string; data: any }>);

vi.mock("../src/om/debug-log.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    debugLog: (event: string, data: Record<string, unknown> = {}) => {
      debugEvents.push({ event, data });
    },
  };
});

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
  debugEvents.length = 0;
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("measured worker prompt budget", () => {
  test("the observer static overhead is measured and far below the flat reserve", async () => {
    const { workerStaticPromptTokens } = await import("../src/om/prompt-budget.js");
    // The former flat reserve lived in consolidation.ts as AGENT_LOOP_RESERVE
    // (8000); it is removed now that the budget is measured, so the baseline
    // is hardcoded here.
    const FLAT_RESERVE = 8_000;
    const { OBSERVER_SYSTEM } = await import("../src/om/agents/observer/prompts.js");
    const { estimateStringTokens } = await import("../src/om/tokens.js");

    const overhead = workerStaticPromptTokens("observer");
    const systemTokens = estimateStringTokens(OBSERVER_SYSTEM);

    // T4: two directional pins — the tool schema must be INCLUDED (overhead
    // exceeds the system prompt alone) and the total must free budget versus
    // the flat reserve it replaces.
    expect(overhead).toBeGreaterThan(systemTokens);
    expect(overhead).toBeLessThan(FLAT_RESERVE);
    expect(workerStaticPromptTokens("observer")).toBe(overhead);
  });

  test("a chunk the old formula accepted is skipped once the output allowance is priced", async () => {
    // 20k-token chunk against a 30k window: the old input-only check
    // (20k + system + 8000 < 30k) runs the model, but input + the output
    // allowance cannot share the window — the provider would 400. The
    // allowance is capped at a quarter of the window, so the 20k chunk still
    // exceeds the ~21.5k clamped budget.
    const entries = [rawMessage("s0", textForTokens(20_000, "SMALL"))];
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
    // The dispatched generation cap matches the preflight allowance: the
    // 40k window with a 2000-token model caps output at 2000, not 32k.
    const { workerOutputAllowance } = await import("../src/om/prompt-budget.js");
    expect((runObserverSpy.mock.calls[0][0] as any).maxOutputTokens).toBe(
      workerOutputAllowance(40_000, { maxTokens: 2000 } as any),
    );
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

  test("a many-small-entries backlog shrinks to a serialized-fitting chunk and drains", async () => {
    const { capSourceEntriesToTokens } = await import("../src/om/consolidation.js");
    const {
      WORKER_SAFETY_MARGIN_TOKENS,
      WORKER_TURN_HEADROOM_TOKENS,
      workerOutputReserveTokens,
      workerStaticPromptTokens,
    } = await import("../src/om/prompt-budget.js");
    const { estimateStringTokens } = await import("../src/om/tokens.js");
    const { serializeSourceAddressedBranchEntries } = await import("../src/om/serialize.js");

    const maxTokens = 1000;
    const staticTokens = workerStaticPromptTokens("observer");
    const reserve = workerOutputReserveTokens({ maxTokens } as any);
    // A low-thousands shrink budget: big enough for a real prefix, small
    // enough that per-entry headers + framing overflow it.
    const shrinkBudget = 4200;
    const contextWindow =
      shrinkBudget +
      staticTokens +
      WORKER_TURN_HEADROOM_TOKENS +
      reserve +
      WORKER_SAFETY_MARGIN_TOKENS;

    // Grow the backlog until the capped prefix fits the per-entry cap but its
    // serialized form overflows the same budget — the wedge: without measuring
    // the serialized text, the best model re-skips and the stage aborts with
    // the cursor unmoved. Sized adaptively so estimator drift fails loudly
    // here instead of silently un-wedging the test below.
    const unitText = textForTokens(100, "UNIT");
    let entries: TestEntry[] = [];
    for (let n = 2; n <= 200; n++) {
      const candidate = Array.from({ length: n }, (_, i) => rawMessage(`k${i}`, unitText));
      const kept = capSourceEntriesToTokens(candidate as any, shrinkBudget);
      if (kept.length < n) {
        const serialized = serializeSourceAddressedBranchEntries(kept as any).text;
        if (estimateStringTokens(serialized) > shrinkBudget) {
          entries = candidate;
          break;
        }
      }
    }
    expect(entries.length).toBeGreaterThan(0);

    // Real model resolution (not a scripted resolver): the candidate is
    // size-skipped, the chain exhausts, the chunk shrinks to its serialized
    // budget, and the un-skipped model is re-offered — then the drain covers
    // the rest. A scripted always-resolving double would never reach the
    // shrink branch, so it cannot exercise this path.
    const runtime = makeRuntime(1, 1_000_000);
    runtime.config.sessionFallback = false;
    runtime.config.observerModel = { provider: "test-shr", id: "shrink-ser-m" };
    const registry = fakeRegistry(contextWindow, maxTokens);
    const baseCtx = ctxWith(entries);
    const generation = runtime.captureGeneration("test-session");
    const { makeModelResolver, runObserverStage: runShrinkStage } =
      await import("../src/om/consolidation.js");
    const outcome = await runShrinkStage(
      { appendEntry: vi.fn() } as any,
      runtime,
      ctxWith(entries),
      generation,
      makeModelResolver(runtime, { ...baseCtx, modelRegistry: registry }, generation),
    );

    expect(outcome).toBe("continue");
    expect(runObserverSpy).toHaveBeenCalled();
    const firstChunk = (runObserverSpy.mock.calls[0][0] as { chunk: string }).chunk;
    expect(estimateStringTokens(firstChunk)).toBeLessThanOrEqual(shrinkBudget);
    const tip = entries[entries.length - 1];
    expect(runtime.getCursor("observer")?.entryId).toBe(tip.id);
  });

  test("a CJK chunk is priced CJK-aware, not chars/4", async () => {
    const { WORKER_SAFETY_MARGIN_TOKENS, WORKER_TURN_HEADROOM_TOKENS, workerStaticPromptTokens } =
      await import("../src/om/prompt-budget.js");

    const staticTokens = workerStaticPromptTokens("observer");
    const maxTokens = 500;
    // The input budget lands between the flat chars/4 price (~313) and the
    // CJK-aware price (~1213) of the same 1200-char chunk, net of static
    // overhead + turn headroom: the old estimator admits a prompt that
    // overflows, the CJK-aware one skips it without cooling the model.
    const contextWindow =
      staticTokens + WORKER_TURN_HEADROOM_TOKENS + maxTokens + WORKER_SAFETY_MARGIN_TOKENS + 760;
    const entries = [rawMessage("c0", "中".repeat(1200))];

    // Real resolution: the candidate size-skips, the chain exhausts, and the
    // single-entry shrink cannot trim further — abort with no model call.
    const runtime = makeRuntime(1, 1_000_000);
    runtime.config.sessionFallback = false;
    runtime.config.observerModel = { provider: "test-shr", id: "cjk-m" };
    const registry = fakeRegistry(contextWindow, maxTokens);
    const baseCtx = ctxWith(entries);
    const generation = runtime.captureGeneration("test-session");
    const { makeModelResolver, runObserverStage: runCjkStage } =
      await import("../src/om/consolidation.js");
    const outcome = await runCjkStage(
      { appendEntry: vi.fn() } as any,
      runtime,
      ctxWith(entries),
      generation,
      makeModelResolver(runtime, { ...baseCtx, modelRegistry: registry }, generation),
    );

    expect(outcome).toBe("abort");
    expect(runObserverSpy).not.toHaveBeenCalled();
    expect(recordCooldownSpy).not.toHaveBeenCalled();
    // A single entry the largest window cannot hold aborts every cycle with
    // the cursor unmoved — surfaced as a diagnostic, not silent.
    expect(debugEvents.some((entry) => entry.event === "observer.shrink_single_oversized")).toBe(
      true,
    );
  });
});

describe("trimSerializedPrefix", () => {
  const unitEntries = () =>
    Array.from({ length: 4 }, (_, i) => rawMessage(`q${i}`, textForTokens(100, `Q${i}`)));

  test("returns the whole prefix when it already fits", async () => {
    const { trimSerializedPrefix } = await import("../src/om/consolidation.js");
    const { serializeSourceAddressedBranchEntries } = await import("../src/om/serialize.js");
    const { estimateStringTokens } = await import("../src/om/tokens.js");

    const entries = unitEntries();
    const full = estimateStringTokens(serializeSourceAddressedBranchEntries(entries as any).text);
    expect(trimSerializedPrefix(entries as any, full + 100)).toHaveLength(4);
  });

  test("trims the tail to the largest serialized-fitting prefix", async () => {
    const { trimSerializedPrefix } = await import("../src/om/consolidation.js");
    const { serializeSourceAddressedBranchEntries } = await import("../src/om/serialize.js");
    const { estimateStringTokens } = await import("../src/om/tokens.js");

    const entries = unitEntries();
    const sized = (list: TestEntry[]) =>
      estimateStringTokens(serializeSourceAddressedBranchEntries(list as any).text);
    const budget = sized(entries.slice(0, 2));
    const trimmed = trimSerializedPrefix(entries as any, budget);

    // A prefix, in order, fitting the budget — and maximal: the next entry
    // back overflows (unless nothing was trimmed at all).
    expect(trimmed.length).toBeGreaterThanOrEqual(1);
    expect(trimmed.map((entry) => entry.id)).toEqual(
      entries.slice(0, trimmed.length).map((entry) => entry.id),
    );
    expect(sized(trimmed)).toBeLessThanOrEqual(budget);
    if (trimmed.length < entries.length) {
      expect(sized([...trimmed, entries[trimmed.length]])).toBeGreaterThan(budget);
    }
  });

  test("retains one entry when even that overflows", async () => {
    const { trimSerializedPrefix } = await import("../src/om/consolidation.js");
    const { serializeSourceAddressedBranchEntries } = await import("../src/om/serialize.js");
    const { estimateStringTokens } = await import("../src/om/tokens.js");

    const entries = unitEntries().slice(0, 1);
    const single = estimateStringTokens(serializeSourceAddressedBranchEntries(entries as any).text);
    const trimmed = trimSerializedPrefix(entries as any, single - 1);
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0].id).toBe("q0");
  });

  test("returns empty for empty input", async () => {
    const { trimSerializedPrefix } = await import("../src/om/consolidation.js");
    expect(trimSerializedPrefix([], 1000)).toEqual([]);
  });
});
