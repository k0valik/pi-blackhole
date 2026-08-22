/**
 * Ported from upstream pi-observational-memory
 * Changes:
 *   - Import path: hooks/compaction-trigger.js → om/compaction-trigger.js
 *   - Adapted for blackhole's queueMicrotask-based deferral (upstream uses setTimeout)
 *   - Added noAutoCompact, memory, ensureConfig to runtime mock
 *   - Added getSessionId to sessionManager mock
 *   - Uses await flushAll() instead of vi.runAllTimersAsync()
 *   - Skipped "does not await observer/reflect promises" test (not applicable)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerCompactionTrigger } from "../src/om/compaction-trigger.js";
import { InlineCompactionUnavailableError } from "../src/om/inline-compaction.js";
import {
  compactionEntry,
  textCustomMessage,
  type TestEntry,
} from "./fixtures/session.js";

/** Flush microtasks AND fire pending fake timers (setTimeout callbacks).
 * With vi.useFakeTimers(), setTimeout callbacks don't fire automatically.
 * We need to advance timers manually after flushing microtasks. */
async function flushAll(): Promise<void> {
  // Flush microtask queue (Promise callbacks)
  await Promise.resolve();
  // Fire any setTimeout(..., 0) callbacks scheduled by the trigger
  vi.advanceTimersByTime(0);
  // Flush any chained microtasks from those callbacks
  await Promise.resolve();
}

/** Advance the auto-compaction retry loop by N ticks. Each tick = 200ms of
 *  fake-timer time plus a microtask flush, so a pending wait loop will check
 *  `ctx.isIdle()` again. */
async function advanceRetryTicks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    vi.advanceTimersByTime(200);
    await Promise.resolve();
  }
}

function captureHandler(
  args: {
    overrideDefaultCompaction?: boolean;
    compactAfterTokens?: number;
    passive?: boolean;
    compactInFlight?: boolean;
    noAutoCompact?: boolean;
    memory?: boolean;
    /** NEW: Unified compaction control */
    compaction?: "auto" | "manual" | "off";
    /** NEW: Which engine handles compaction */
    compactionEngine?: "blackhole" | "pi-default";
    /** NEW: Mid-run (turn_end) compaction behavior */
    midRunCompaction?: "resume" | "pause" | "off";
  } = {},
  inlineCompact = vi.fn(async () => ({ summary: "inline summary" })),
) {
  let agentEndHandler: ((event: unknown, ctx: unknown) => void) | undefined;
  let agentStartHandler: (() => void) | undefined;
  let turnEndHandler:
    ((event: unknown, ctx: unknown) => void | Promise<void>) | undefined;
  const pi = {
    on: vi.fn((name: string, cb: any) => {
      if (name === "agent_end") agentEndHandler = cb;
      if (name === "agent_start") agentStartHandler = cb;
      if (name === "turn_end") turnEndHandler = cb;
    }),
    sendMessage: vi.fn(),
  };
  const runtime = {
    ensureConfig: vi.fn(),
    resetInfoGate: vi.fn(),
    // Passthrough: call ui.notify so tests can observe notification content
    tryEmitInfo: vi.fn((hasUI: boolean, ui: any, msg: string) => {
      if (!hasUI || !ui) return;
      try {
        ui.notify(msg, "info");
      } catch {
        /* stale ctx */
      }
    }),
    config: {
      overrideDefaultCompaction: args.overrideDefaultCompaction ?? true,
      compactAfterTokens: args.compactAfterTokens ?? 3,
      passive: args.passive ?? false,
      noAutoCompact: args.noAutoCompact ?? false,
      memory: args.memory ?? true,
      /** NEW: Unified compaction control */
      compaction: args.compaction,
      /** NEW: Which engine handles compaction */
      compactionEngine: args.compactionEngine,
      /** NEW: Mid-run (turn_end) compaction behavior */
      midRunCompaction: args.midRunCompaction,
    },
    compactInFlight: args.compactInFlight ?? false,
    autoCompactionController: null as AbortController | null,
    midRunCompactionRetry: { failures: 0, retryAfter: 0 },
    inlineCompactionAdapterStatus: { supported: true },
    inlineCompactionWarningEmitted: false,
  };
  registerCompactionTrigger(pi as any, runtime as any, inlineCompact);
  if (!agentEndHandler) throw new Error("agent_end handler was not registered");
  if (!agentStartHandler)
    throw new Error("agent_start handler was not registered");
  if (!turnEndHandler) throw new Error("turn_end handler was not registered");
  return {
    handler: agentEndHandler,
    startHandler: agentStartHandler,
    turnHandler: turnEndHandler,
    runtime,
    pi,
    inlineCompact,
  };
}

function turnEnd() {
  return {
    type: "turn_end",
    message: {
      role: "assistant",
      content: "working...",
      stopReason: "toolUse",
    },
    toolResults: [],
  };
}

function agentEnd(errorMessage?: string) {
  return {
    type: "agent_end",
    messages: [
      { role: "user", content: "hello" },
      errorMessage
        ? { role: "assistant", content: [], stopReason: "error", errorMessage }
        : { role: "assistant", content: "done", stopReason: "end_turn" },
    ],
  };
}

function fakeCtx(
  branches: TestEntry[][],
  overrides: Record<string, unknown> = {},
) {
  let branchIndex = 0;
  const sessionId = "test-session-001";
  const getBranch = vi.fn(
    () => branches[Math.min(branchIndex++, branches.length - 1)],
  );
  return {
    cwd: "/tmp/project",
    sessionManager: {
      getBranch,
      getSessionId: vi.fn(() => sessionId),
    },
    getContextUsage: vi.fn(() => ({
      tokens: null,
      percent: null,
      contextWindow: 200_000,
    })),
    hasUI: true,
    ui: { notify: vi.fn() },
    isIdle: vi.fn(() => true),
    compact: vi.fn(),
    ...overrides,
  };
}

const dueBranch = [textCustomMessage("raw-1", "aaaaaaaaaaaa")]; // 3 tokens
const belowBranch = [textCustomMessage("raw-1", "aaaa")]; // 1 token

describe("V3 compaction trigger (blackhole)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing below compactAfterTokens", async () => {
    const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
    const ctx = fakeCtx([belowBranch]);

    handler(agentEnd(), ctx);
    await flushAll();

    expect(runtime.compactInFlight).toBe(false);
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("calls compact when compactAfterTokens is reached", async () => {
    const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
    const ctx = fakeCtx([dueBranch]);

    handler(agentEnd(), ctx);
    expect(runtime.compactInFlight).toBe(true);
    await flushAll();

    expect(ctx.compact).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Observational memory: compaction threshold reached (~3 tokens); triggering compaction",
      "info",
    );
  });

  it("uses Pi context usage instead of the lower raw source estimate", async () => {
    const { handler } = captureHandler({ compactAfterTokens: 100 });
    const ctx = fakeCtx([belowBranch], {
      getContextUsage: vi.fn(() => ({
        tokens: 120,
        percent: 60,
        contextWindow: 200,
      })),
    });

    handler(agentEnd(), ctx);
    await flushAll();

    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("caps an oversized configured threshold at 65% of the context window", async () => {
    const { handler } = captureHandler({ compactAfterTokens: 217_600 });
    const ctx = fakeCtx([belowBranch], {
      getContextUsage: vi.fn(() => ({
        tokens: 176_800,
        percent: 65,
        contextWindow: 272_000,
      })),
    });

    handler(agentEnd(), ctx);
    await flushAll();

    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("preserves a lower configured threshold", async () => {
    const { handler } = captureHandler({ compactAfterTokens: 100 });
    const ctx = fakeCtx([belowBranch], {
      getContextUsage: vi.fn(() => ({
        tokens: 99,
        contextWindow: 1_000,
      })),
    });

    handler(agentEnd(), ctx);
    await flushAll();

    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("rechecks Pi context usage after deferral", async () => {
    const { handler, runtime } = captureHandler({ compactAfterTokens: 100 });
    const getContextUsage = vi
      .fn()
      .mockReturnValueOnce({ tokens: 120, contextWindow: 200 })
      .mockReturnValueOnce({ tokens: 10, contextWindow: 200 });
    const ctx = fakeCtx([belowBranch], { getContextUsage });

    handler(agentEnd(), ctx);
    await flushAll();

    expect(getContextUsage).toHaveBeenCalledTimes(2);
    expect(ctx.compact).not.toHaveBeenCalled();
    expect(runtime.compactInFlight).toBe(false);
  });

  it("compaction:auto + compactionEngine:pi-default skips trigger (pi-default means Pi handles timing too)", async () => {
    const { handler, runtime } = captureHandler({
      compaction: "auto",
      compactionEngine: "pi-default",
      compactAfterTokens: 3,
    });
    const ctx = fakeCtx([dueBranch]);

    handler(agentEnd(), ctx);
    expect(runtime.compactInFlight).toBe(false);
    await flushAll();

    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("LEGACY-BACKWARD: overrideDefaultCompaction:false with no new keys — legacy guard fires, no trigger", async () => {
    const { handler, runtime } = captureHandler({
      overrideDefaultCompaction: false,
      compaction: undefined,
      compactionEngine: undefined,
    });
    const ctx = fakeCtx([dueBranch]);

    handler(agentEnd(), ctx);
    await flushAll();

    expect(runtime.compactInFlight).toBe(false);
    expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("LEGACY-BACKWARD: passive:true with no new keys — legacy guard fires, no trigger", async () => {
    const { handler, runtime } = captureHandler({
      passive: true,
      compaction: undefined,
      compactionEngine: undefined,
    });
    const ctx = fakeCtx([dueBranch]);

    handler(agentEnd(), ctx);
    await flushAll();

    expect(runtime.compactInFlight).toBe(false);
    expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("skips when compaction is already in flight", async () => {
    const { handler } = captureHandler({ compactInFlight: true });
    const ctx = fakeCtx([dueBranch]);

    handler(agentEnd(), ctx);
    await flushAll();

    expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("skips retryable assistant errors", async () => {
    const { handler, runtime } = captureHandler();
    const ctx = fakeCtx([dueBranch]);

    handler(agentEnd("fetch failed: connection lost"), ctx);
    await flushAll();

    expect(runtime.compactInFlight).toBe(false);
    expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("ignores stale extension ctx during agent_end", async () => {
    const { handler, runtime } = captureHandler();
    const staleCtx = {
      get cwd() {
        throw {
          message:
            "This extension ctx is stale after session replacement or reload.",
        };
      },
    };

    expect(() => handler(agentEnd(), staleCtx)).not.toThrow();
    await flushAll();

    expect(runtime.ensureConfig).not.toHaveBeenCalled();
    expect(runtime.compactInFlight).toBe(false);
  });

  it("cancels deferred compaction if ctx becomes stale before the timer fires", async () => {
    const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
    const ctx = fakeCtx([dueBranch]);

    handler(agentEnd(), ctx);
    expect(runtime.compactInFlight).toBe(true);
    ctx.sessionManager.getSessionId.mockImplementation(() => {
      throw new Error(
        "This extension ctx is stale after session replacement or reload.",
      );
    });
    await flushAll();

    expect(runtime.compactInFlight).toBe(false);
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("aborts the wait loop when the session changes mid-wait (e.g. /resume)", async () => {
    const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
    // First call (during scheduling) returns the original session; subsequent
    // calls (during the wait loop) return a different session id.
    const ctx = fakeCtx([dueBranch]);
    ctx.sessionManager.getSessionId = vi
      .fn()
      .mockReturnValueOnce("test-session-001") // scheduling
      .mockReturnValue("test-session-002"); // mid-wait (different)

    handler(agentEnd(), ctx);
    expect(runtime.compactInFlight).toBe(true);
    await flushAll();
    await advanceRetryTicks(1);

    expect(runtime.compactInFlight).toBe(false);
    expect(runtime.autoCompactionController).toBeNull();
    expect(ctx.compact).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Observational memory: compaction cancelled — session changed before compaction",
      "info",
    );
  });

  it("ignores stale notification errors in async compaction callbacks", async () => {
    const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
    const ctx = fakeCtx([dueBranch]);

    handler(agentEnd(), ctx);
    await flushAll();

    expect(ctx.compact).toHaveBeenCalledTimes(1);
    const compactOptions = ctx.compact.mock.calls[0][0];
    ctx.ui.notify.mockImplementation(() => {
      throw new Error(
        "This extension ctx is stale after session replacement or reload.",
      );
    });

    runtime.compactInFlight = true;
    expect(() => compactOptions.onComplete({})).not.toThrow();
    expect(runtime.compactInFlight).toBe(false);

    runtime.compactInFlight = true;
    expect(() =>
      compactOptions.onError({ message: "test failure" }),
    ).not.toThrow();
    expect(runtime.compactInFlight).toBe(false);
  });

  it("waits for the agent to become idle and then compacts (the issue #31 race)", async () => {
    const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
    // isIdle returns false for the first 3 retries (simulating a slow async
    // agent_end handler from another extension), then true. The trigger must
    // keep waiting — not bail — until the agent truly settles.
    const isIdle = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const ctx = fakeCtx([dueBranch], { isIdle });

    handler(agentEnd(), ctx);
    expect(runtime.compactInFlight).toBe(true);
    await flushAll();

    // isIdle was called once during the initial setTimeout(0) check.
    // After 3 more 200ms ticks, isIdle returns true and compact() fires.
    await advanceRetryTicks(3);

    expect(ctx.compact).toHaveBeenCalledTimes(1);
    expect(isIdle).toHaveBeenCalledTimes(4);
  });

  it("aborts the pending wait when a new agent_start fires (user started a new turn)", async () => {
    const { handler, startHandler, runtime } = captureHandler({
      compactAfterTokens: 3,
    });
    // isIdle always false: trigger keeps waiting.
    const ctx = fakeCtx([dueBranch], { isIdle: vi.fn(() => false) });

    handler(agentEnd(), ctx);
    expect(runtime.compactInFlight).toBe(true);
    await flushAll();

    // User starts a new turn while we're still waiting.
    startHandler();
    await flushAll();

    // Advance many ticks to confirm the loop really stopped.
    await advanceRetryTicks(5);

    expect(ctx.compact).not.toHaveBeenCalled();
    expect(runtime.compactInFlight).toBe(false);
    expect(runtime.autoCompactionController).toBeNull();
  });

  it("re-checks threshold after deferral and skips if another compaction already reduced pressure", async () => {
    const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
    const ctx = fakeCtx([dueBranch, belowBranch]);

    handler(agentEnd(), ctx);
    await flushAll();

    expect(ctx.compact).not.toHaveBeenCalled();
    expect(runtime.compactInFlight).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Observational memory: compaction skipped — another compaction already ran before deferred compaction",
      "info",
    );
  });

  it("counts raw tokens since the latest Pi compaction using V3 progress helpers", async () => {
    const { handler } = captureHandler({ compactAfterTokens: 3 });
    const branch = [
      textCustomMessage("raw-1", "aaaaaaaaaaaa"),
      compactionEntry("cmp-1", { firstKeptEntryId: "raw-2" }),
      textCustomMessage("raw-2", "aaaa"),
      textCustomMessage("raw-3", "bbbbbbbb"),
    ];
    const ctx = fakeCtx([branch]);

    handler(agentEnd(), ctx);
    await flushAll();

    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  // ── Phase 7: New config key guards ─────────────────────────────────

  it("T13: compaction:auto calls compact when threshold reached", async () => {
    const { handler } = captureHandler({
      compaction: "auto",
      compactAfterTokens: 3,
    });
    const ctx = fakeCtx([dueBranch]);

    handler(agentEnd(), ctx);
    await flushAll();

    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("T14: compaction:auto does nothing below threshold", async () => {
    const { handler, runtime } = captureHandler({
      compaction: "auto",
      compactAfterTokens: 3,
    });
    const ctx = fakeCtx([belowBranch]);

    handler(agentEnd(), ctx);
    await flushAll();

    expect(runtime.compactInFlight).toBe(false);
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("T15: compaction:manual skips threshold check entirely", async () => {
    const { handler, runtime } = captureHandler({
      compaction: "manual",
      compactAfterTokens: 3,
    });
    const ctx = fakeCtx([dueBranch]);

    handler(agentEnd(), ctx);
    await flushAll();

    expect(runtime.compactInFlight).toBe(false);
    expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("T16: compaction:off skips threshold check entirely", async () => {
    const { handler, runtime } = captureHandler({
      compaction: "off",
      compactAfterTokens: 3,
    });
    const ctx = fakeCtx([dueBranch]);

    handler(agentEnd(), ctx);
    await flushAll();

    expect(runtime.compactInFlight).toBe(false);
    expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("T17: memory:false + compaction:auto still compacts when threshold reached", async () => {
    const { handler } = captureHandler({
      compaction: "auto",
      memory: false,
      compactAfterTokens: 3,
    });
    const ctx = fakeCtx([dueBranch]);

    handler(agentEnd(), ctx);
    await flushAll();

    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("T18: compaction:manual with retryable error skips before threshold check", async () => {
    const { handler, runtime } = captureHandler({
      compaction: "manual",
      compactAfterTokens: 3,
    });
    const ctx = fakeCtx([dueBranch]);

    handler(agentEnd("fetch failed: connection lost"), ctx);
    await flushAll();

    expect(runtime.compactInFlight).toBe(false);
    expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
    expect(ctx.compact).not.toHaveBeenCalled();
  });
});

describe("mid-run compaction trigger (turn_end)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("M1: does nothing below compactAfterTokens", () => {
    const { turnHandler, runtime } = captureHandler({ compactAfterTokens: 3 });
    const ctx = fakeCtx([belowBranch]);

    turnHandler(turnEnd(), ctx);

    expect(runtime.compactInFlight).toBe(false);
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("M2: awaits transparent compaction immediately at the threshold", async () => {
    const { turnHandler, runtime, inlineCompact } = captureHandler({
      compactAfterTokens: 3,
      midRunCompaction: "resume",
    });
    const ctx = fakeCtx([belowBranch], {
      getContextUsage: vi.fn(() => ({ tokens: 3, contextWindow: 100 })),
    });

    const pending = turnHandler(turnEnd(), ctx);

    expect(runtime.compactInFlight).toBe(true);
    expect(inlineCompact).toHaveBeenCalledOnce();
    expect(inlineCompact).toHaveBeenCalledWith(ctx.sessionManager);
    expect(ctx.compact).not.toHaveBeenCalled();
    expect(ctx.isIdle).not.toHaveBeenCalled();

    await pending;
    expect(runtime.compactInFlight).toBe(false);
  });

  it("M3: resume mode continues the same run without a synthetic message", async () => {
    const { turnHandler, runtime, pi } = captureHandler({
      compactAfterTokens: 3,
      midRunCompaction: "resume",
    });
    const ctx = fakeCtx([dueBranch]);

    await turnHandler(turnEnd(), ctx);

    expect(runtime.compactInFlight).toBe(false);
    expect(ctx.compact).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("M3a: keeps the outer run pending until inline compaction finishes", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inlineCompact = vi.fn(async () => {
      await gate;
      return { summary: "inline summary" };
    });
    const { turnHandler } = captureHandler(
      {
        compactAfterTokens: 3,
        midRunCompaction: "resume",
      },
      inlineCompact,
    );
    const ctx = fakeCtx([dueBranch]);
    let continued = false;

    const outerRun = (async () => {
      await turnHandler(turnEnd(), ctx);
      continued = true;
      return "continued";
    })();
    await Promise.resolve();

    expect(continued).toBe(false);
    release?.();
    await expect(outerRun).resolves.toBe("continued");
    expect(continued).toBe(true);
  });

  it("M4: pause mode compacts but does not inject a resume message", () => {
    const { turnHandler, runtime, pi } = captureHandler({
      compactAfterTokens: 3,
      midRunCompaction: "pause",
    });
    const ctx = fakeCtx([dueBranch]);

    turnHandler(turnEnd(), ctx);
    expect(ctx.compact).toHaveBeenCalledTimes(1);
    const options = ctx.compact.mock.calls[0][0];
    options.onComplete({});

    expect(runtime.compactInFlight).toBe(false);
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("M5: off mode never compacts mid-run (agent_end path still works)", async () => {
    const { turnHandler, handler, runtime } = captureHandler({
      compactAfterTokens: 3,
      midRunCompaction: "off",
    });
    const ctx = fakeCtx([dueBranch]);

    turnHandler(turnEnd(), ctx);
    expect(ctx.compact).not.toHaveBeenCalled();
    expect(runtime.compactInFlight).toBe(false);

    handler(agentEnd(), ctx);
    await flushAll();
    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("M6: inline failure clears in-flight state and starts bounded backoff without aborting", async () => {
    const inlineCompact = vi.fn(async () => {
      throw new Error("boom");
    });
    const { turnHandler, runtime, pi } = captureHandler(
      {
        compactAfterTokens: 3,
        midRunCompaction: "resume",
      },
      inlineCompact,
    );
    const ctx = fakeCtx([dueBranch]);

    await turnHandler(turnEnd(), ctx);

    expect(runtime.compactInFlight).toBe(false);
    expect(runtime.midRunCompactionRetry.failures).toBe(1);
    expect(runtime.midRunCompactionRetry.retryAfter).toBe(Date.now() + 1_000);
    expect(ctx.compact).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("M7: skips when compaction is already in flight", () => {
    const { turnHandler } = captureHandler({
      compactAfterTokens: 3,
      compactInFlight: true,
    });
    const ctx = fakeCtx([dueBranch]);

    turnHandler(turnEnd(), ctx);

    expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("M7a: skips inline compaction when another operation already aborted the run", async () => {
    const { turnHandler, inlineCompact } = captureHandler({
      compactAfterTokens: 3,
      midRunCompaction: "resume",
    });
    const controller = new AbortController();
    controller.abort();
    const ctx = fakeCtx([dueBranch], { signal: controller.signal });

    await turnHandler(turnEnd(), ctx);

    expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
    expect(inlineCompact).not.toHaveBeenCalled();
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("M8: respects compaction:off guard", () => {
    const { turnHandler, runtime } = captureHandler({
      compaction: "off",
      compactAfterTokens: 3,
    });
    const ctx = fakeCtx([dueBranch]);

    turnHandler(turnEnd(), ctx);

    expect(runtime.compactInFlight).toBe(false);
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("M9: respects compaction:manual guard", () => {
    const { turnHandler, runtime } = captureHandler({
      compaction: "manual",
      compactAfterTokens: 3,
    });
    const ctx = fakeCtx([dueBranch]);

    turnHandler(turnEnd(), ctx);

    expect(runtime.compactInFlight).toBe(false);
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("M10: respects compactionEngine:pi-default guard", () => {
    const { turnHandler, runtime } = captureHandler({
      compaction: "auto",
      compactionEngine: "pi-default",
      compactAfterTokens: 3,
    });
    const ctx = fakeCtx([dueBranch]);

    turnHandler(turnEnd(), ctx);

    expect(runtime.compactInFlight).toBe(false);
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("M11: LEGACY-BACKWARD: overrideDefaultCompaction:false with no new keys — no mid-run trigger", () => {
    const { turnHandler, runtime } = captureHandler({
      overrideDefaultCompaction: false,
      compaction: undefined,
      compactionEngine: undefined,
      compactAfterTokens: 3,
    });
    const ctx = fakeCtx([dueBranch]);

    turnHandler(turnEnd(), ctx);

    expect(runtime.compactInFlight).toBe(false);
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("M12: LEGACY-BACKWARD: noAutoCompact:true with no new keys — no mid-run trigger", () => {
    const { turnHandler, runtime } = captureHandler({
      noAutoCompact: true,
      compaction: undefined,
      compactionEngine: undefined,
      compactAfterTokens: 3,
    });
    const ctx = fakeCtx([dueBranch]);

    turnHandler(turnEnd(), ctx);

    expect(runtime.compactInFlight).toBe(false);
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("M13: ignores stale extension ctx at turn_end", () => {
    const { turnHandler, runtime } = captureHandler({ compactAfterTokens: 3 });
    const staleCtx = {
      get cwd() {
        throw {
          message:
            "This extension ctx is stale after session replacement or reload.",
        };
      },
    };

    expect(() => turnHandler(turnEnd(), staleCtx)).not.toThrow();
    expect(runtime.compactInFlight).toBe(false);
  });

  it("M14: threshold reset — a fresh compaction entry zeroes accumulated tokens, no re-trigger loop", () => {
    const { turnHandler, runtime } = captureHandler({ compactAfterTokens: 3 });
    // Branch after a mid-run compaction: compaction entry + small tail.
    const postCompactionBranch = [
      compactionEntry("comp-1", {
        summary: "summary",
        firstKeptEntryId: "raw-9",
      }),
      textCustomMessage("raw-10", "aaaa"), // 1 token
    ];
    const ctx = fakeCtx([postCompactionBranch]);

    turnHandler(turnEnd(), ctx);

    expect(runtime.compactInFlight).toBe(false);
    expect(ctx.compact).not.toHaveBeenCalled();
  });
});

describe("mid-run compaction cancellation resilience", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("M15: cancelled inline compaction backs off, then retries without injecting continuation", async () => {
    const inlineCompact = vi.fn(async () => {
      throw new Error("Compaction cancelled");
    });
    const { turnHandler, runtime, pi } = captureHandler(
      {
        compactAfterTokens: 3,
        midRunCompaction: "resume",
      },
      inlineCompact,
    );
    const ctx = fakeCtx([dueBranch, dueBranch]);

    await turnHandler(turnEnd(), ctx);

    expect(runtime.compactInFlight).toBe(false);
    expect(runtime.midRunCompactionRetry.failures).toBe(1);
    expect(pi.sendMessage).not.toHaveBeenCalled();

    await turnHandler(turnEnd(), ctx);
    expect(inlineCompact).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    await turnHandler(turnEnd(), ctx);
    expect(inlineCompact).toHaveBeenCalledTimes(2);
    expect(runtime.midRunCompactionRetry.failures).toBe(2);
    expect(runtime.midRunCompactionRetry.retryAfter).toBe(Date.now() + 2_000);
  });

  it("M15a: agent_end remains the settled fallback during inline backoff", async () => {
    const inlineCompact = vi.fn(async () => {
      throw new Error("Compaction cancelled");
    });
    const { turnHandler, handler, runtime } = captureHandler(
      {
        compactAfterTokens: 3,
        midRunCompaction: "resume",
      },
      inlineCompact,
    );
    const ctx = fakeCtx([dueBranch, dueBranch]);

    await turnHandler(turnEnd(), ctx);
    expect(runtime.midRunCompactionRetry.failures).toBe(1);

    handler(agentEnd(), ctx);
    await flushAll();

    expect(inlineCompact).toHaveBeenCalledTimes(1);
    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("M16: retry state clears once pressure drops below threshold", async () => {
    const inlineCompact = vi
      .fn()
      .mockRejectedValueOnce(new Error("Compaction cancelled"))
      .mockResolvedValue({ summary: "inline summary" });
    const { turnHandler } = captureHandler(
      {
        compactAfterTokens: 3,
        midRunCompaction: "resume",
      },
      inlineCompact,
    );
    // Sequence: due (cancel) → due (suspended) → below (clear) → due (trigger again)
    const ctx = fakeCtx([dueBranch, dueBranch, belowBranch, dueBranch]);

    await turnHandler(turnEnd(), ctx);
    await turnHandler(turnEnd(), ctx);
    expect(inlineCompact).toHaveBeenCalledTimes(1);

    await turnHandler(turnEnd(), ctx);
    await turnHandler(turnEnd(), ctx);
    expect(inlineCompact).toHaveBeenCalledTimes(2);
  });

  it("M16a: backoff caps at 30 seconds", async () => {
    const inlineCompact = vi.fn(async () => {
      throw new Error("boom");
    });
    const { turnHandler, runtime } = captureHandler(
      {
        compactAfterTokens: 3,
        midRunCompaction: "resume",
      },
      inlineCompact,
    );
    const ctx = fakeCtx([dueBranch]);

    for (let failure = 1; failure <= 7; failure++) {
      await turnHandler(turnEnd(), ctx);
      const expectedDelay = Math.min(30_000, 1_000 * 2 ** (failure - 1));
      expect(runtime.midRunCompactionRetry.failures).toBe(failure);
      expect(runtime.midRunCompactionRetry.retryAfter).toBe(
        Date.now() + expectedDelay,
      );
      vi.advanceTimersByTime(expectedDelay);
    }
  });

  it("M16b: unsupported inline adapter warns once and leaves agent_end fallback active", async () => {
    const inlineCompact = vi.fn(async () => {
      throw new InlineCompactionUnavailableError("unsupported host");
    });
    const { turnHandler, handler, runtime } = captureHandler(
      {
        compactAfterTokens: 3,
        midRunCompaction: "resume",
      },
      inlineCompact,
    );
    const ctx = fakeCtx([dueBranch]);

    await turnHandler(turnEnd(), ctx);
    await turnHandler(turnEnd(), ctx);

    expect(inlineCompact).toHaveBeenCalledTimes(1);
    expect(runtime.inlineCompactionAdapterStatus).toEqual({
      supported: false,
      reason: "unsupported host",
    });
    expect(
      ctx.ui.notify.mock.calls.filter(([message]) =>
        String(message).includes("using settled compaction fallback"),
      ),
    ).toHaveLength(1);

    handler(agentEnd(), ctx);
    await flushAll();
    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("M17: pause mode does not resume on cancellation", () => {
    const { turnHandler, pi } = captureHandler({
      compactAfterTokens: 3,
      midRunCompaction: "pause",
    });
    const ctx = fakeCtx([dueBranch]);

    turnHandler(turnEnd(), ctx);
    ctx.compact.mock.calls[0][0].onError({ message: "Compaction cancelled" });

    expect(pi.sendMessage).not.toHaveBeenCalled();
  });
});
