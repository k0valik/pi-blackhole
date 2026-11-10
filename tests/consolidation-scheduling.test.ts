/**
 * Coalesced consolidation recheck scheduling — lifecycle regressions for the
 * lost wake-up after a busy pipeline finishes (openspec change
 * fix-consolidation-lost-wakeup).
 *
 * Every test drives the real `registerConsolidationTrigger` handlers against a
 * real `Runtime` with the worker agents mocked: a held reflector or dropper is
 * a deferred mock promise, so no network, real agent loop, or real session
 * file is involved. Pending/cooldown writes redirect `getAgentDir` to a
 * per-test scratch directory.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentStartEvent,
  ExtensionHandler,
  SessionShutdownEvent,
  SessionStartEvent,
  TurnEndEvent,
  TurnEndEventResult,
} from "@earendil-works/pi-coding-agent";
import { Runtime } from "../src/om/runtime.js";
import { registerConsolidationTrigger, type ConsolidationCtx } from "../src/om/consolidation.js";
import { readPendingState } from "../src/om/pending.js";
import { recordCooldown } from "../src/om/cooldown.js";
import { DEBUG_LOG_RELATIVE_PATH, flushDebugLog } from "../src/om/debug-log.js";
import { ROOT_SESSIONS_ENV } from "../src/core/subagent-detector.js";
import { rawMessage, type TestEntry } from "./fixtures/session.js";
import { createExtensionApiDouble } from "./fixtures/pi-extension-api.js";

const scratch = vi.hoisted(() => ({ dir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
  getAgentDir: () => scratch.dir,
}));

interface ObserverAgentInput {
  chunk: string;
  allowedSourceEntryIds: string[];
  model?: { provider?: string; id?: string };
  maxTurns?: number;
}

const agents = vi.hoisted(() => ({
  runObserver: vi.fn(),
  runReflector: vi.fn(),
  runDropper: vi.fn(),
}));
vi.mock("../src/om/agents/observer/agent.js", () => ({ runObserver: agents.runObserver }));
vi.mock("../src/om/agents/reflector/agent.js", () => ({ runReflector: agents.runReflector }));
vi.mock("../src/om/agents/dropper/agent.js", () => ({ runDropper: agents.runDropper }));

const turnEndHandlers: ExtensionHandler<TurnEndEvent, TurnEndEventResult>[] = [];
const agentStartHandlers: ExtensionHandler<AgentStartEvent>[] = [];
const sessionStartHandlers: ExtensionHandler<SessionStartEvent>[] = [];
const shutdownHandlers: ExtensionHandler<SessionShutdownEvent>[] = [];

/** Deferred gate releases a failed assertion could otherwise strand (T6). */
const heldReleases: Array<() => void> = [];
let outstanding: Promise<unknown>[] = [];

function turnEndEvent(): TurnEndEvent {
  return {
    type: "turn_end",
    turnIndex: 0,
    messageEntryId: "entry-0",
    toolResultEntryIds: [],
    entries: [],
    continue: false,
    outcome: "completed",
    context: {
      contextEntries: [],
      contextMessages: [],
      llmMessages: [],
      pendingMessages: [],
      canContinue: false,
    },
    message: { role: "user", content: "trigger", timestamp: Date.now() },
    toolResults: [],
  };
}

/** Observation citing the chunk tail — the honest default worker outcome. */
function observationFor(tailEntryId: string, seq: number) {
  const id = `obs-${String(seq).padStart(4, "0")}`;
  return {
    id,
    content: `observation over ${tailEntryId}`,
    timestamp: "2026-10-21T10:00:00.000Z",
    relevance: "medium",
    sourceEntryIds: [tailEntryId],
    supportingObservationIds: [id],
    // 2500 tokens: above 10% of the 20k pool max, so the dropper fullness
    // gate passes and the stage actually runs (T2 — arm what the branch needs).
    tokenCount: 2500,
  } as const;
}

interface SchedulingFixtureOptions {
  manual?: boolean;
  observeAfterTokens?: number;
  reflectAfterTokens?: number;
  observeOnShutdown?: boolean;
  /** Skip the resolveModel stub so the real candidate walk runs (cooldowns). */
  useRealResolveModel?: boolean;
  /** Session model the trigger context reports (provider-skip tests). */
  sessionModel?: unknown;
}

export interface SchedulingFixture {
  runtime: Runtime;
  entries: TestEntry[];
  ctx: ConsolidationCtx;
  /** Mid-flight ownership samples, recorded by the observer mock per call. */
  observerSamples: Array<{ inFlight: boolean; phase: string | undefined; hadPromise: boolean }>;
  fireTurnEnd(ctxOverride?: ConsolidationCtx): void;
  fireAgentStart(): void;
  fireSessionStart(sessionId: string): void;
  fireShutdown(reason: SessionShutdownEvent["reason"]): Promise<void> | void;
  /** Hold the next dropper model call open; returns its release. */
  holdDropper(): () => void;
  holdReflector(): () => void;
  /** Hold the next observer model call open; optionally cite a partial prefix. */
  holdObserver(cite?: string): () => void;
  /** Replace the next observer result while still holding the default shape. */
  setNextObserverResult(result: unknown): void;
  makeCtx(overrides: Partial<ConsolidationCtx>): ConsolidationCtx;
  setStale(): void;
}

function makeSchedulingFixture(options: SchedulingFixtureOptions = {}): SchedulingFixture {
  const runtime = new Runtime();
  runtime.configLoaded = true;
  runtime.config.memory = true;
  runtime.config.compaction = options.manual ? "manual" : "auto";
  runtime.config.observeAfterTokens = options.observeAfterTokens ?? 5_000;
  runtime.config.reflectAfterTokens = options.reflectAfterTokens ?? 1_000_000;
  if (options.observeOnShutdown !== undefined)
    runtime.config.observeOnShutdown = options.observeOnShutdown;
  runtime.config.observerModel = { provider: "test", id: "observer-model" };
  runtime.config.observerFallbackModels = [];
  runtime.config.reflectorModel = { provider: "test", id: "reflector-model" };
  runtime.config.dropperModel = { provider: "test", id: "dropper-model" };
  if (!options.useRealResolveModel) {
    runtime.resolveModel = async () => ({
      ok: true as const,
      source: "candidate" as const,
      candidateConfig: { provider: "test", id: "resolved-model" },
      model: { provider: "test", id: "resolved-model", contextWindow: 1_000_000 },
      apiKey: "test",
    });
  } else {
    runtime.config.observerModel = { provider: "test", id: "hot", cooldownHours: 1 };
    runtime.config.observerFallbackModels = [{ provider: "test", id: "cool", cooldownHours: 1 }];
    runtime.config.dropperModel = { provider: "test", id: "drop" };
  }

  const entries: TestEntry[] = [];
  const observerSamples: SchedulingFixture["observerSamples"] = [];
  let observationSeq = 0;
  const defaultObserverResult = (input: ObserverAgentInput) => {
    observerSamples.push({
      inFlight: runtime.consolidationInFlight,
      phase: runtime.consolidationPhase,
      hadPromise: runtime.consolidationPromise !== null,
    });
    const tail = input.allowedSourceEntryIds.at(-1);
    if (!tail) return { observations: [], coverageComplete: true };
    return { observations: [observationFor(tail, ++observationSeq)], coverageComplete: true };
  };
  agents.runObserver.mockReset();
  agents.runObserver.mockImplementation(async (input: ObserverAgentInput) =>
    defaultObserverResult(input),
  );
  agents.runReflector.mockReset();
  agents.runReflector.mockResolvedValue({ reflections: [] });
  agents.runDropper.mockReset();
  agents.runDropper.mockResolvedValue([]);

  let sessionId = "scheduling-session";
  let staleSessions = false;
  const sessionManager = {
    getBranch: () => entries,
    getSessionId: () => {
      if (staleSessions) throw new Error("extension ctx is stale");
      return sessionId;
    },
    isPersisted: () => true,
  };
  const modelRegistry = {
    find: (_provider: string, id: string) => ({ provider: "test", id, contextWindow: 1_000_000 }),
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
    hasConfiguredAuth: () => true,
  };
  const ctx: ConsolidationCtx = {
    cwd: scratch.dir,
    hasUI: false,
    model: options.sessionModel,
    modelRegistry,
    sessionManager,
  };

  const pi = createExtensionApiDouble({
    turnEndHandlers,
    shutdownHandlers,
    agentStartHandlers,
    sessionStartHandlers,
    appendEntry: (customType, data) => {
      entries.push({
        type: "custom",
        id: `appended-${entries.length}`,
        parentId: entries.at(-1)?.id ?? null,
        timestamp: "2026-10-21T10:00:00.000Z",
        customType,
        data,
      });
    },
  });
  registerConsolidationTrigger(pi, runtime);

  const dispatch = <E>(handlers: ExtensionHandler<E>[], event: E, useCtx: ConsolidationCtx) => {
    const handler = handlers[0];
    if (!handler) throw new Error(`No ${event.type} handler registered`);
    // The double's handlers are typed against the full host context; the
    // consolidation wiring only touches the ConsolidationCtx subset.
    return handler(event, useCtx as never);
  };

  const hold = (mock: typeof agents.runDropper, result: () => unknown) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    heldReleases.push(release);
    mock.mockImplementationOnce(async () => {
      await gate;
      return result();
    });
    return release;
  };

  return {
    runtime,
    entries,
    ctx,
    observerSamples,
    fireTurnEnd: (ctxOverride?: ConsolidationCtx) =>
      void dispatch(turnEndHandlers, turnEndEvent(), ctxOverride ?? ctx),
    fireAgentStart: () =>
      void dispatch(agentStartHandlers, { type: "agent_start" } satisfies AgentStartEvent, ctx),
    fireSessionStart: (next: string) => {
      sessionId = next;
      void dispatch(
        sessionStartHandlers,
        { type: "session_start", reason: "new" } satisfies SessionStartEvent,
        ctx,
      );
    },
    fireShutdown: (reason: SessionShutdownEvent["reason"]) =>
      dispatch(
        shutdownHandlers,
        { type: "session_shutdown", reason } satisfies SessionShutdownEvent,
        ctx,
      ),
    holdDropper: () => hold(agents.runDropper, () => []),
    holdReflector: () => hold(agents.runReflector, () => ({ reflections: [] })),
    holdObserver: (cite?: string) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      heldReleases.push(release);
      agents.runObserver.mockImplementationOnce(async (input: ObserverAgentInput) => {
        await gate;
        if (cite) {
          // A partial prefix commit: the batch cites only `cite`, so the
          // stage's in-run drain continues past it (see partialCoverageId).
          return {
            observations: [observationFor(cite, ++observationSeq)],
            partialCoverageId: cite,
            coverageComplete: true,
          };
        }
        return defaultObserverResult(input);
      });
      return release;
    },
    setNextObserverResult: (result: unknown) => {
      agents.runObserver.mockImplementationOnce(async () => result);
    },
    makeCtx: (overrides: Partial<ConsolidationCtx>) => ({ ...ctx, ...overrides }),
    setStale: () => {
      staleSessions = true;
    },
  };
}

/** A source entry well above the default 5k observe threshold. */
const bigSource = (id: string) => rawMessage(id, `BIG-${id} ${"y".repeat(40_000)}`);

beforeEach(() => {
  scratch.dir = mkdtempSync(join(tmpdir(), "consolidation-scheduling-"));
});

afterEach(async () => {
  for (const release of heldReleases.splice(0)) release();
  await Promise.allSettled(outstanding);
  outstanding = [];
  turnEndHandlers.length = 0;
  agentStartHandlers.length = 0;
  sessionStartHandlers.length = 0;
  shutdownHandlers.length = 0;
  vi.restoreAllMocks();
  flushDebugLog();
  rmSync(scratch.dir, { recursive: true, force: true });
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("runtime recheck callback failures", () => {
  test.each([true, false])("contains callback errors with debugLog=%s", async (enabled) => {
    const runtime = new Runtime();
    runtime.config.debugLog = enabled;
    runtime.startSession("callback-session");
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    heldReleases.push(release);
    const pipeline = runtime.launchConsolidationTask({ hasUI: false }, async () => gate);
    outstanding.push(pipeline);
    const callback = vi.fn(() => {
      throw new Error("runtime recheck callback failure");
    });
    runtime.requestConsolidationRecheck(runtime.captureGeneration("callback-session"), callback);
    release();

    await expect(pipeline).resolves.toBeUndefined();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(runtime.consolidationInFlight).toBe(false);
    expect(runtime.consolidationPromise).toBeNull();
    flushDebugLog();
    const path = join(scratch.dir, DEBUG_LOG_RELATIVE_PATH);
    const log = existsSync(path) ? readFileSync(path, "utf-8") : "";
    const errors = log
      .split("\n")
      .filter((line) => line.includes('"event":"consolidation.recheck_callback_error"'));
    if (enabled) {
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('"errorMessage":"Error: runtime recheck callback failure"');
    } else {
      expect(errors).toHaveLength(0);
    }
  });
});

describe("headless coalesced recheck errors", () => {
  test.each([
    { debugLog: true, stale: false, shouldLog: true },
    { debugLog: false, stale: false, shouldLog: false },
    { debugLog: true, stale: true, shouldLog: false },
  ])(
    "debugLog=$debugLog stale=$stale records error=$shouldLog",
    async ({ debugLog, stale, shouldLog }) => {
      const f = makeSchedulingFixture({ reflectAfterTokens: 1 });
      f.runtime.config.debugLog = debugLog;
      f.entries.push(bigSource("big-1"));
      const releaseDropper = f.holdDropper();
      f.fireTurnEnd();
      const pipeline = f.runtime.consolidationPromise;
      if (!pipeline) throw new Error("Expected an active consolidation pipeline");
      outstanding.push(pipeline);
      await vi.waitFor(() => expect(agents.runDropper).toHaveBeenCalledTimes(1));

      f.entries.push(bigSource("final-1"));
      f.fireTurnEnd();
      const errorMessage = stale ? "extension ctx is stale" : "headless recheck branch failure";
      const getBranch = vi.spyOn(f.ctx.sessionManager, "getBranch").mockImplementationOnce(() => {
        throw new Error(errorMessage);
      });
      releaseDropper();
      await pipeline;
      expect(getBranch).toHaveBeenCalledTimes(1);
      expect(f.runtime.consolidationInFlight).toBe(false);

      flushDebugLog();
      const path = join(scratch.dir, DEBUG_LOG_RELATIVE_PATH);
      const log = existsSync(path) ? readFileSync(path, "utf-8") : "";
      const errors = log
        .split("\n")
        .filter((line) => line.includes('"event":"consolidation.recheck_error"'));
      if (shouldLog) {
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('"errorMessage":"Error: headless recheck branch failure"');
      } else {
        expect(errors).toHaveLength(0);
      }
    },
  );
});

describe("coalesced recheck scheduling", () => {
  test("observes the final transcript after the dropper finishes without another user message", async () => {
    const f = makeSchedulingFixture({ reflectAfterTokens: 1 });
    f.entries.push(bigSource("big-1"));
    const releaseDropper = f.holdDropper();

    f.fireTurnEnd();
    await vi.waitFor(() => expect(agents.runDropper).toHaveBeenCalledTimes(1));

    // The transcript crosses the observe threshold while the dropper is held.
    f.entries.push(bigSource("final-1"));
    f.fireTurnEnd();

    // No second observer may start while the dropper still owns execution.
    expect(agents.runObserver).toHaveBeenCalledTimes(1);
    expect(f.runtime.consolidationInFlight).toBe(true);
    expect(f.runtime.consolidationPhase).toBe("dropper");
    expect(f.runtime.consolidationPromise).not.toBeNull();

    releaseDropper();

    await vi.waitFor(() => expect(agents.runObserver).toHaveBeenCalledTimes(2));
    const secondCall = agents.runObserver.mock.calls[1]![0] as ObserverAgentInput;
    expect(secondCall.allowedSourceEntryIds).toContain("final-1");

    // Ownership: the follow-up runs as a tracked task and settles cleanly.
    const secondSample = f.observerSamples[1]!;
    expect(secondSample.inFlight).toBe(true);
    expect(secondSample.phase).toBe("observer");
    expect(secondSample.hadPromise).toBe(true);
    await vi.waitFor(() => expect(f.runtime.consolidationInFlight).toBe(false));
    expect(f.runtime.consolidationPromise).toBeNull();

    // Coverage of the new final transcript, not just a launcher invocation.
    expect(f.runtime.getCursor("observer")).toEqual({ entryId: "final-1", state: "recorded" });
    // One follow-up only — no self-sustaining third pipeline.
    expect(agents.runObserver).toHaveBeenCalledTimes(2);
  });

  test("observes the final transcript after the reflector finishes without another user message", async () => {
    const f = makeSchedulingFixture({ reflectAfterTokens: 5_000 });
    f.entries.push(bigSource("big-1"));
    const releaseReflector = f.holdReflector();

    f.fireTurnEnd();
    await vi.waitFor(() => expect(agents.runReflector).toHaveBeenCalledTimes(1));

    f.entries.push(bigSource("final-1"));
    f.fireTurnEnd();
    expect(agents.runObserver).toHaveBeenCalledTimes(1);

    releaseReflector();

    await vi.waitFor(() => expect(agents.runObserver).toHaveBeenCalledTimes(2));
    const secondCall = agents.runObserver.mock.calls[1]![0] as ObserverAgentInput;
    expect(secondCall.allowedSourceEntryIds).toContain("final-1");
    await vi.waitFor(() => expect(f.runtime.consolidationInFlight).toBe(false));
    expect(agents.runObserver).toHaveBeenCalledTimes(2);
  });

  test("observes the final transcript after the dropper finishes in manual mode", async () => {
    const f = makeSchedulingFixture({ manual: true, reflectAfterTokens: 1 });
    f.entries.push(bigSource("big-1"));
    const releaseDropper = f.holdDropper();

    f.fireTurnEnd();
    await vi.waitFor(() => expect(agents.runDropper).toHaveBeenCalledTimes(1));

    f.entries.push(bigSource("final-1"));
    f.fireTurnEnd();
    expect(agents.runObserver).toHaveBeenCalledTimes(1);

    releaseDropper();

    await vi.waitFor(() => expect(agents.runObserver).toHaveBeenCalledTimes(2));
    const secondCall = agents.runObserver.mock.calls[1]![0] as ObserverAgentInput;
    expect(secondCall.allowedSourceEntryIds).toContain("final-1");
    await vi.waitFor(() => expect(f.runtime.consolidationInFlight).toBe(false));

    // Both manual-mode runs buffered their observation batches.
    const pending = readPendingState("scheduling-session");
    expect(pending.observationBatches?.length).toBe(2);
  });
});

describe("coalescing and follow-up bounds", () => {
  test("coalesces many busy triggers into one follow-up", async () => {
    const f = makeSchedulingFixture({ reflectAfterTokens: 1 });
    f.entries.push(bigSource("big-1"));
    const releaseDropper = f.holdDropper();

    f.fireTurnEnd();
    await vi.waitFor(() => expect(agents.runDropper).toHaveBeenCalledTimes(1));

    f.entries.push(bigSource("final-1"));
    f.fireTurnEnd();
    f.fireTurnEnd();
    f.fireAgentStart();

    releaseDropper();

    await vi.waitFor(() => expect(agents.runObserver).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(f.runtime.consolidationInFlight).toBe(false));
    // One coalesced follow-up, not one pipeline per busy trigger.
    expect(agents.runObserver).toHaveBeenCalledTimes(2);
  });

  test("starts no worker when the active observer's drain already covered the transcript", async () => {
    const f = makeSchedulingFixture();
    f.entries.push(bigSource("big-1"), bigSource("mid-1"));
    // Hold the first batch to a partial prefix commit so its drain continues.
    const releaseObserver = f.holdObserver("big-1");

    f.fireTurnEnd();
    await vi.waitFor(() => expect(agents.runObserver).toHaveBeenCalledTimes(1));

    // New content arrives while the first observer batch is still running.
    f.entries.push(bigSource("final-1"));
    f.fireTurnEnd();

    // The first batch commits big-1; its drain then snapshots the branch
    // again and covers mid-1..final-1 within the same pipeline run.
    releaseObserver();

    await vi.waitFor(() => expect(agents.runObserver).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(f.runtime.consolidationInFlight).toBe(false));
    const secondCall = agents.runObserver.mock.calls[1]![0] as ObserverAgentInput;
    expect(secondCall.allowedSourceEntryIds).toContain("final-1");
    // The deferred trigger found nothing due at recheck time — no third worker.
    expect(agents.runObserver).toHaveBeenCalledTimes(2);
    expect(f.runtime.getCursor("observer")).toEqual({ entryId: "final-1", state: "recorded" });
  });

  test("finishing with work still due and no deferred trigger starts no pipeline", async () => {
    const f = makeSchedulingFixture({ reflectAfterTokens: 1 });
    f.entries.push(bigSource("big-1"));
    const releaseDropper = f.holdDropper();

    f.fireTurnEnd();
    await vi.waitFor(() => expect(agents.runDropper).toHaveBeenCalledTimes(1));

    // The transcript crosses the threshold while busy, but no lifecycle
    // trigger fires — completion alone must not start another pipeline.
    f.entries.push(bigSource("final-1"));

    releaseDropper();
    await vi.waitFor(() => expect(f.runtime.consolidationInFlight).toBe(false));
    expect(agents.runObserver).toHaveBeenCalledTimes(1);
  });

  test("stops after a no-progress follow-up until another trigger", async () => {
    const f = makeSchedulingFixture({ reflectAfterTokens: 1 });
    f.entries.push(bigSource("big-1"));
    const releaseDropper = f.holdDropper();

    f.fireTurnEnd();
    await vi.waitFor(() => expect(agents.runDropper).toHaveBeenCalledTimes(1));

    f.entries.push(bigSource("final-1"));
    f.fireTurnEnd();

    // The follow-up observer returns without validated coverage — an
    // empty-result model attempt, not an error (no retry gate is set).
    f.setNextObserverResult({
      observations: [],
      emptyReason: { kind: "tool_not_called" },
      coverageComplete: false,
    });

    releaseDropper();

    await vi.waitFor(() => expect(agents.runObserver).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(f.runtime.consolidationInFlight).toBe(false));
    // Exactly one follow-up: a still-due result alone must not relaunch.
    expect(agents.runObserver).toHaveBeenCalledTimes(2);
    // No coverage was claimed over the still-due transcript.
    expect(f.runtime.getCursor("observer")).toEqual({ entryId: "big-1", state: "recorded" });
  });

  test("handles a trigger arriving during the follow-up pipeline", async () => {
    const f = makeSchedulingFixture({ reflectAfterTokens: 1 });
    f.entries.push(bigSource("big-1"));
    const releaseDropper = f.holdDropper();

    f.fireTurnEnd();
    await vi.waitFor(() => expect(agents.runDropper).toHaveBeenCalledTimes(1));

    f.entries.push(bigSource("final-1"));
    f.fireTurnEnd();

    // Hold the follow-up pipeline's own observer call.
    const releaseFollowUpObserver = f.holdObserver();
    releaseDropper();
    await vi.waitFor(() => expect(agents.runObserver).toHaveBeenCalledTimes(2));

    f.entries.push(bigSource("final-2"));
    f.fireTurnEnd();

    releaseFollowUpObserver();

    await vi.waitFor(() => expect(agents.runObserver).toHaveBeenCalledTimes(3));
    const thirdCall = agents.runObserver.mock.calls[2]![0] as ObserverAgentInput;
    expect(thirdCall.allowedSourceEntryIds).toContain("final-2");
    await vi.waitFor(() => expect(f.runtime.consolidationInFlight).toBe(false));
    expect(agents.runObserver).toHaveBeenCalledTimes(3);
  });
});

describe("rechecks preserve the existing launch policy", () => {
  test("consumes the recheck without relaunching while the retry gate is active", async () => {
    const f = makeSchedulingFixture({ reflectAfterTokens: 1 });
    f.entries.push(bigSource("big-1"));
    const releaseDropper = f.holdDropper();
    const gateSpy = vi.spyOn(f.runtime, "isConsolidationRetryGated");

    f.fireTurnEnd();
    await vi.waitFor(() => expect(agents.runDropper).toHaveBeenCalledTimes(1));
    expect(gateSpy).toHaveBeenCalledTimes(1); // fresh launch checked the gate

    f.entries.push(bigSource("final-1"));
    f.fireTurnEnd();
    // A stage error arms the consolidation retry gate before the recheck is
    // consumed — the same state a failed pipeline leaves behind.
    f.runtime.markConsolidationError();

    releaseDropper();

    await vi.waitFor(() => {
      // The recheck re-entered the launch path and was stopped by the gate.
      expect(gateSpy).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => expect(f.runtime.consolidationInFlight).toBe(false));
    expect(agents.runObserver).toHaveBeenCalledTimes(1);
  });

  test("stops a deferred recheck when memory is disabled before completion", async () => {
    const f = makeSchedulingFixture({ reflectAfterTokens: 1 });
    f.entries.push(bigSource("big-1"));
    const releaseDropper = f.holdDropper();
    const ensureSpy = vi.spyOn(f.runtime, "ensureConfig");

    f.fireTurnEnd();
    await vi.waitFor(() => expect(agents.runDropper).toHaveBeenCalledTimes(1));

    f.entries.push(bigSource("final-1"));
    f.fireTurnEnd();
    f.runtime.config.memory = false;

    releaseDropper();

    await vi.waitFor(() => expect(ensureSpy).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(f.runtime.consolidationInFlight).toBe(false));
    expect(agents.runObserver).toHaveBeenCalledTimes(1);
  });

  test("stops a deferred recheck when legacy passive mode applies", async () => {
    const f = makeSchedulingFixture({ reflectAfterTokens: 1 });
    f.entries.push(bigSource("big-1"));
    const releaseDropper = f.holdDropper();
    const ensureSpy = vi.spyOn(f.runtime, "ensureConfig");

    f.fireTurnEnd();
    await vi.waitFor(() => expect(agents.runDropper).toHaveBeenCalledTimes(1));

    f.entries.push(bigSource("final-1"));
    f.fireTurnEnd();
    // Unmigrated config + passive: true is the legacy exclusion.
    f.runtime.config.compaction = undefined;
    f.runtime.config.compactionEngine = undefined;
    f.runtime.config.passive = true;

    releaseDropper();

    await vi.waitFor(() => expect(ensureSpy).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(f.runtime.consolidationInFlight).toBe(false));
    expect(agents.runObserver).toHaveBeenCalledTimes(1);
  });

  test("invalidates a superseded recheck when the latest trigger context is provider-excluded", async () => {
    const f = makeSchedulingFixture({ reflectAfterTokens: 1, sessionModel: { provider: "main" } });
    f.runtime.config.skipForProviders = ["excluded"];
    f.entries.push(bigSource("big-1"));
    const releaseDropper = f.holdDropper();
    const ensureSpy = vi.spyOn(f.runtime, "ensureConfig");

    f.fireTurnEnd();
    await vi.waitFor(() => expect(agents.runDropper).toHaveBeenCalledTimes(1));

    f.entries.push(bigSource("final-1"));
    f.fireTurnEnd(); // eligible trigger — request remembered
    expect(ensureSpy).toHaveBeenCalledTimes(2);
    // A newer trigger from an excluded provider must invalidate it.
    f.fireTurnEnd(f.makeCtx({ model: { provider: "excluded" } }));
    expect(ensureSpy).toHaveBeenCalledTimes(3);

    releaseDropper();

    await vi.waitFor(() => expect(f.runtime.consolidationInFlight).toBe(false));
    // No recheck ran for the superseded eligible trigger.
    expect(ensureSpy).toHaveBeenCalledTimes(3);
    expect(agents.runObserver).toHaveBeenCalledTimes(1);
  });

  test("resolves a fallback model for the follow-up when the observer model is in cooldown", async () => {
    const f = makeSchedulingFixture({
      reflectAfterTokens: 1,
      useRealResolveModel: true,
    });
    f.entries.push(bigSource("big-1"));
    const releaseDropper = f.holdDropper();

    f.fireTurnEnd();
    await vi.waitFor(() => expect(agents.runDropper).toHaveBeenCalledTimes(1));
    const firstCall = agents.runObserver.mock.calls[0]![0] as ObserverAgentInput;
    expect(firstCall.model?.id).toBe("hot");

    f.entries.push(bigSource("final-1"));
    f.fireTurnEnd();
    // The observer model enters a cooldown window before the recheck runs.
    recordCooldown(
      { provider: "test", id: "hot", cooldownHours: 1 },
      "observer cooldown test",
      "observer",
    );

    releaseDropper();

    await vi.waitFor(() => expect(agents.runObserver).toHaveBeenCalledTimes(2));
    const secondCall = agents.runObserver.mock.calls[1]![0] as ObserverAgentInput;
    // Ordinary model resolution picked the configured fallback.
    expect(secondCall.model?.id).toBe("cool");
  });
});

describe("deferred work is session scoped", () => {
  test("drops the old session's recheck when the session is replaced", async () => {
    const f = makeSchedulingFixture({ reflectAfterTokens: 1 });
    f.entries.push(bigSource("big-1"));
    const releaseDropper = f.holdDropper();

    f.fireTurnEnd();
    await vi.waitFor(() => expect(agents.runDropper).toHaveBeenCalledTimes(1));

    f.entries.push(bigSource("final-1"));
    f.fireTurnEnd(); // remembered for the old session
    f.fireSessionStart("session-B");

    releaseDropper();
    await vi.waitFor(() => expect(f.runtime.consolidationInFlight).toBe(false));
    // The replaced session's request started no work against either session.
    expect(agents.runObserver).toHaveBeenCalledTimes(1);

    // The new session can still consolidate on its own triggers.
    f.entries.push(bigSource("final-2"));
    f.fireTurnEnd();
    await vi.waitFor(() => expect(agents.runObserver).toHaveBeenCalledTimes(2));
    const secondCall = agents.runObserver.mock.calls[1]![0] as ObserverAgentInput;
    expect(secondCall.allowedSourceEntryIds).toContain("final-2");
    await vi.waitFor(() => expect(f.runtime.consolidationInFlight).toBe(false));
  });

  test("hands a new session's request to the follow-up while the old pipeline unwinds", async () => {
    const f = makeSchedulingFixture({ reflectAfterTokens: 1 });
    f.entries.push(bigSource("big-1"));
    const releaseDropper = f.holdDropper();

    f.fireTurnEnd();
    await vi.waitFor(() => expect(agents.runDropper).toHaveBeenCalledTimes(1));

    f.entries.push(bigSource("final-1"));
    f.fireTurnEnd(); // remembered for the old session
    f.fireSessionStart("session-B");
    // The old pipeline is still unwinding (busy), so the new session's
    // trigger is deferred too — it must survive the old task's exit.
    f.fireTurnEnd();

    releaseDropper();
    await vi.waitFor(() => expect(agents.runObserver).toHaveBeenCalledTimes(2));
    const secondCall = agents.runObserver.mock.calls[1]![0] as ObserverAgentInput;
    expect(secondCall.allowedSourceEntryIds).toContain("final-1");
    await vi.waitFor(() => expect(f.runtime.consolidationInFlight).toBe(false));
    expect(agents.runObserver).toHaveBeenCalledTimes(2);
  });

  test("drops a pending recheck when the runtime is disposed before completion", async () => {
    const f = makeSchedulingFixture({ reflectAfterTokens: 1 });
    f.entries.push(bigSource("big-1"));
    const releaseDropper = f.holdDropper();

    f.fireTurnEnd();
    await vi.waitFor(() => expect(agents.runDropper).toHaveBeenCalledTimes(1));

    f.entries.push(bigSource("final-1"));
    f.fireTurnEnd(); // remembered
    f.runtime.dispose();

    releaseDropper();
    await vi.waitFor(() => expect(f.runtime.consolidationInFlight).toBe(false));
    expect(agents.runObserver).toHaveBeenCalledTimes(1);
  });

  test("discards a stale-context recheck without an unhandled rejection", async () => {
    const f = makeSchedulingFixture({ reflectAfterTokens: 1 });
    f.entries.push(bigSource("big-1"));
    const releaseDropper = f.holdDropper();

    f.fireTurnEnd();
    const pipeline = f.runtime.consolidationPromise;
    expect(pipeline).not.toBeNull();
    await vi.waitFor(() => expect(agents.runDropper).toHaveBeenCalledTimes(1));

    f.entries.push(bigSource("final-1"));
    f.fireTurnEnd(); // remembered; the host context goes stale before recheck
    f.setStale();

    releaseDropper();

    await vi.waitFor(() => expect(f.runtime.consolidationInFlight).toBe(false));
    expect(agents.runObserver).toHaveBeenCalledTimes(1);
    // The completed task settled cleanly instead of rejecting.
    await expect(pipeline).resolves.toBeUndefined();
  });
});

describe("shutdown owns its bounded observation attempt", () => {
  test("cancels the pending recheck at shutdown when shutdown observation is disabled", async () => {
    const f = makeSchedulingFixture({ reflectAfterTokens: 1, observeOnShutdown: false });
    f.entries.push(bigSource("big-1"));
    const releaseDropper = f.holdDropper();
    const disposeSpy = vi.spyOn(f.runtime, "dispose");

    f.fireTurnEnd();
    await vi.waitFor(() => expect(agents.runDropper).toHaveBeenCalledTimes(1));

    f.entries.push(bigSource("final-1"));
    f.fireTurnEnd(); // remembered
    f.fireShutdown("quit");
    expect(disposeSpy).toHaveBeenCalled();

    releaseDropper();
    await vi.waitFor(() => expect(f.runtime.consolidationInFlight).toBe(false));
    // Neither a regular follow-up nor a shutdown observation ran.
    expect(agents.runObserver).toHaveBeenCalledTimes(1);

    // The next session revives regular consolidation.
    f.fireSessionStart("session-next");
    f.entries.push(bigSource("final-2"));
    f.fireTurnEnd();
    await vi.waitFor(() => expect(agents.runObserver).toHaveBeenCalledTimes(2));
    const secondCall = agents.runObserver.mock.calls[1]![0] as ObserverAgentInput;
    expect(secondCall.allowedSourceEntryIds).toContain("final-2");
    // A regular pipeline run, not the bounded shutdown attempt.
    expect(secondCall.maxTurns).toBe(f.runtime.config.agentMaxTurns);
    await vi.waitFor(() => expect(f.runtime.consolidationInFlight).toBe(false));
  });

  test("cancels the pending recheck at shutdown even for an unobserved reason", async () => {
    vi.stubEnv(ROOT_SESSIONS_ENV, "scheduling-session");
    const f = makeSchedulingFixture({ reflectAfterTokens: 1, observeOnShutdown: true });
    f.entries.push(bigSource("big-1"));
    const releaseDropper = f.holdDropper();

    f.fireTurnEnd();
    await vi.waitFor(() => expect(agents.runDropper).toHaveBeenCalledTimes(1));

    f.entries.push(bigSource("final-1"));
    f.fireTurnEnd(); // remembered
    f.fireShutdown("reload");

    releaseDropper();
    await vi.waitFor(() => expect(f.runtime.consolidationInFlight).toBe(false));
    expect(agents.runObserver).toHaveBeenCalledTimes(1);
  });

  test("keeps the bounded shutdown observer the only follow-up while it waits", async () => {
    vi.stubEnv(ROOT_SESSIONS_ENV, "scheduling-session");
    const f = makeSchedulingFixture({ reflectAfterTokens: 1, observeOnShutdown: true });
    f.entries.push(bigSource("big-1"));
    const releaseDropper = f.holdDropper();

    f.fireTurnEnd();
    await vi.waitFor(() => expect(agents.runDropper).toHaveBeenCalledTimes(1));

    f.entries.push(bigSource("final-1"));
    f.fireTurnEnd(); // remembered
    const shutdownWork = f.fireShutdown("quit");
    outstanding.push(Promise.resolve(shutdownWork));

    releaseDropper();
    await vi.waitFor(() => expect(agents.runObserver).toHaveBeenCalledTimes(2));
    // The second observer call is the bounded shutdown attempt (maxTurns: 1),
    // not a competing regular follow-up (maxTurns: agentMaxTurns).
    const secondCall = agents.runObserver.mock.calls[1]![0] as ObserverAgentInput;
    expect(secondCall.maxTurns).toBe(1);
    expect(secondCall.allowedSourceEntryIds).toContain("final-1");

    await vi.waitFor(() => expect(f.runtime.consolidationInFlight).toBe(false));
    // Exactly one follow-up attempt — the shutdown observer's single request.
    expect(agents.runObserver).toHaveBeenCalledTimes(2);
  });
});
