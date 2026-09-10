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
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  recordMidRunFailure,
  registerCompactionTrigger,
  resetMidRunRetry,
} from "../src/om/compaction-trigger.js";
import {
  InlineCompactionUnavailableError,
  installHostInlineCompactionAdapter,
  installInlineCompactionAdapter,
} from "../src/om/inline-compaction.js";
import { compactionEntry, textCustomMessage, type TestEntry } from "./fixtures/session.js";

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
    /** NEW: Context-window-derived threshold knobs (issue #60) */
    compactAfterRatio?: number;
    compactReserveTokens?: number;
  } = {},
  inlineCompact = vi.fn(async () => ({ summary: "inline summary" })),
) {
  let agentEndHandler: ((event: unknown, ctx: unknown) => void) | undefined;
  let agentStartHandler: (() => void) | undefined;
  let turnEndHandler: ((event: unknown, ctx: unknown) => void | Promise<void>) | undefined;
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
      // In derived mode (ratio/reserve configured) no fixed token default is
      // injected — mirrors loadUnifiedConfig, which drops the 81000 default.
      compactAfterTokens:
        args.compactAfterTokens ??
        (args.compactAfterRatio !== undefined || args.compactReserveTokens !== undefined
          ? undefined
          : 3),
      compactAfterRatio: args.compactAfterRatio,
      compactReserveTokens: args.compactReserveTokens,
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
    inlineCompactionAdapterStatus: undefined as { supported: boolean; reason?: string } | undefined,
    inlineCompactionWarningEmitted: false,
  };
  registerCompactionTrigger(pi as any, runtime as any, inlineCompact);
  if (!agentEndHandler) throw new Error("agent_end handler was not registered");
  if (!agentStartHandler) throw new Error("agent_start handler was not registered");
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

function fakeCtx(branches: TestEntry[][], overrides: Record<string, unknown> = {}) {
  let branchIndex = 0;
  const sessionId = "test-session-001";
  const getBranch = vi.fn(() => branches[Math.min(branchIndex++, branches.length - 1)]);
  return {
    cwd: "/tmp/project",
    sessionManager: {
      getBranch,
      getSessionId: vi.fn(() => sessionId),
    },
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
          message: "This extension ctx is stale after session replacement or reload.",
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
      throw new Error("This extension ctx is stale after session replacement or reload.");
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
      throw new Error("This extension ctx is stale after session replacement or reload.");
    });

    runtime.compactInFlight = true;
    expect(() => compactOptions.onComplete({})).not.toThrow();
    expect(runtime.compactInFlight).toBe(false);

    runtime.compactInFlight = true;
    expect(() => compactOptions.onError({ message: "test failure" })).not.toThrow();
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
    const ctx = fakeCtx([dueBranch]);

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

  it("M6: inline failure clears in-flight state and suspends retries without aborting", async () => {
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
    expect(runtime.midRunCompactionRetry.retryAfter).toBeGreaterThanOrEqual(Date.now());
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("retrying in 1s"), "error");
    expect(ctx.compact).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("M6a: retries inline compaction once the backoff window has elapsed", async () => {
    const inlineCompact = vi
      .fn(async () => {
        throw new Error("boom");
      })
      .mockImplementationOnce(async () => {
        throw new Error("boom");
      })
      .mockImplementation(async () => undefined);
    const { turnHandler, runtime } = captureHandler(
      {
        compactAfterTokens: 3,
        midRunCompaction: "resume",
      },
      inlineCompact,
    );
    const ctx = fakeCtx([dueBranch, dueBranch]);

    await turnHandler(turnEnd(), ctx);
    expect(inlineCompact).toHaveBeenCalledTimes(1);

    // Simulate the backoff window elapsing.
    runtime.midRunCompactionRetry.retryAfter = Date.now() - 1;

    await turnHandler(turnEnd(), ctx);
    expect(inlineCompact).toHaveBeenCalledTimes(2);
    expect(runtime.midRunCompactionRetry.failures).toBe(0);
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
          message: "This extension ctx is stale after session replacement or reload.",
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
  it("M15: cancelled inline compaction suspends retries without injecting continuation", async () => {
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
  });

  it("M15a: agent_end does not immediately retry a failed mid-run compaction", async () => {
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

    expect(inlineCompact).toHaveBeenCalledTimes(1);
    expect(ctx.compact).not.toHaveBeenCalled();
    expect(runtime.compactInFlight).toBe(false);
  });

  it("M16: suspension clears once pressure drops below threshold", async () => {
    const inlineCompact = vi
      .fn()
      .mockRejectedValueOnce(new Error("Compaction cancelled"))
      .mockResolvedValue({ summary: "inline summary" });
    const { turnHandler, runtime } = captureHandler(
      {
        compactAfterTokens: 3,
        midRunCompaction: "resume",
      },
      inlineCompact,
    );
    // Sequence: due (cancel) → due (backoff) → below (clear) → due (trigger again)
    const ctx = fakeCtx([dueBranch, dueBranch, belowBranch, dueBranch]);

    await turnHandler(turnEnd(), ctx);
    expect(runtime.midRunCompactionRetry.failures).toBe(1);
    await turnHandler(turnEnd(), ctx);
    expect(inlineCompact).toHaveBeenCalledTimes(1);

    await turnHandler(turnEnd(), ctx);
    expect(runtime.midRunCompactionRetry).toEqual({
      failures: 0,
      retryAfter: 0,
    });
    await turnHandler(turnEnd(), ctx);
    expect(inlineCompact).toHaveBeenCalledTimes(2);
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

  it("M18: pause failure records backoff; completion resets it", () => {
    const { turnHandler, runtime } = captureHandler({
      compactAfterTokens: 3,
      midRunCompaction: "pause",
    });
    const ctx = fakeCtx([dueBranch, dueBranch]);

    turnHandler(turnEnd(), ctx);
    ctx.compact.mock.calls[0][0].onError({ message: "boom" });
    expect(runtime.midRunCompactionRetry.failures).toBe(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("retrying in 1s"), "error");

    ctx.compact.mock.calls[0][0].onComplete({});
    expect(runtime.midRunCompactionRetry).toEqual({
      failures: 0,
      retryAfter: 0,
    });
  });
});

describe("mid-run compaction retry math", () => {
  it("doubles the delay per failure and caps at 30 seconds", () => {
    const runtime: any = {
      midRunCompactionRetry: { failures: 0, retryAfter: 0 },
    };
    const expectedDelays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (const expected of expectedDelays) {
      const delay = recordMidRunFailure(runtime);
      expect(delay).toBe(expected);
    }
    resetMidRunRetry(runtime);
    expect(runtime.midRunCompactionRetry).toEqual({
      failures: 0,
      retryAfter: 0,
    });
  });
});

describe("inline adapter classification", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const unavailableInline = () =>
    vi.fn(async () => {
      throw new InlineCompactionUnavailableError("pi 0.80.1 lacks inline compaction API");
    });

  it("marks the adapter unsupported and warns once instead of recording backoff", async () => {
    const { turnHandler, runtime, inlineCompact } = captureHandler(
      { midRunCompaction: "resume" },
      unavailableInline(),
    );
    const ctx = fakeCtx([dueBranch]);

    await turnHandler(turnEnd(), ctx);

    expect(runtime.inlineCompactionAdapterStatus).toEqual({
      supported: false,
      reason: "pi 0.80.1 lacks inline compaction API",
    });
    // One info (threshold reached) + one warning (settled fallback).
    expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
    const warnCall = ctx.ui.notify.mock.calls.find((call) => call[1] === "warning");
    expect(warnCall?.[0]).toContain("using settled compaction fallback");
    // Permanent condition — not a retryable failure.
    expect(runtime.midRunCompactionRetry.failures).toBe(0);

    // Later turns skip the adapter entirely and stay silent.
    await turnHandler(turnEnd(), ctx);
    expect(inlineCompact).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
  });

  it("warns once at agent_start for configured resume with a known-bad adapter", () => {
    const { startHandler, runtime } = captureHandler({
      midRunCompaction: "resume",
    });
    runtime.inlineCompactionAdapterStatus = {
      supported: false,
      reason: "pi lacks API",
    };
    const ctx = fakeCtx([belowBranch]);

    startHandler(undefined, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify.mock.calls[0][0]).toContain("pi lacks API");
    expect(ctx.ui.notify.mock.calls[0][1]).toBe("warning");

    startHandler(undefined, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
  });

  it("does not warn at agent_start when mode is not resume or adapter is fine", () => {
    const { startHandler, runtime } = captureHandler({
      midRunCompaction: "pause",
    });
    runtime.inlineCompactionAdapterStatus = { supported: false };
    const ctx = fakeCtx([belowBranch]);
    startHandler(undefined, ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();

    const ok = captureHandler({ midRunCompaction: "resume" });
    ok.runtime.inlineCompactionAdapterStatus = { supported: true };
    ok.startHandler(undefined, fakeCtx([belowBranch]));
    expect(ok.runtime.config.midRunCompaction).toBe("resume");
  });
});

describe("Context-window-derived threshold (issue #60)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const windowedCtx = (window: number, branch: TestEntry[]) =>
    fakeCtx([branch], { model: { provider: "test", id: "test", contextWindow: window } });

  it("compacts above a window-derived ratio threshold (0.5 × 100 = 50)", async () => {
    const { handler, runtime } = captureHandler({ compactAfterRatio: 0.5 });
    const ctx = windowedCtx(100, [textCustomMessage("raw-1", "a".repeat(300))]); // 75 tokens ≥ 50

    handler(agentEnd(), ctx);
    expect(runtime.compactInFlight).toBe(true);
    await flushAll();

    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("fires exactly at the derived threshold (tokens == threshold)", async () => {
    const { handler } = captureHandler({ compactAfterRatio: 0.5 });
    const ctx = windowedCtx(100, [textCustomMessage("raw-1", "a".repeat(200))]); // 50 tokens == 50

    handler(agentEnd(), ctx);
    await flushAll();

    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("does not compact below the derived threshold", async () => {
    const { handler, runtime } = captureHandler({ compactAfterRatio: 0.5 });
    const ctx = windowedCtx(100, [textCustomMessage("raw-1", "a".repeat(196))]); // 49 tokens < 50

    handler(agentEnd(), ctx);
    await flushAll();

    expect(runtime.compactInFlight).toBe(false);
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("compacts above a reserve-derived threshold (100 − 60 = 40)", async () => {
    const { handler } = captureHandler({ compactReserveTokens: 60 });
    const ctx = windowedCtx(100, [textCustomMessage("raw-1", "a".repeat(200))]); // 50 tokens ≥ 40

    handler(agentEnd(), ctx);
    await flushAll();

    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("re-derives from the session model window at each evaluation (/model switch)", async () => {
    // Same configured ratio, two evaluations with different model windows: a
    // 100-window model compacts at 50; a 1M-window model's derived threshold
    // (500k) is far above the same 75-token branch, so it must NOT compact.
    const small = captureHandler({ compactAfterRatio: 0.5 });
    const smallCtx = windowedCtx(100, [textCustomMessage("raw-1", "a".repeat(300))]);
    small.handler(agentEnd(), smallCtx);
    await flushAll();
    expect(smallCtx.compact).toHaveBeenCalledTimes(1);

    const big = captureHandler({ compactAfterRatio: 0.5 });
    const bigCtx = windowedCtx(1_000_000, [textCustomMessage("raw-1", "a".repeat(300))]);
    big.handler(agentEnd(), bigCtx);
    await flushAll();
    expect(bigCtx.compact).not.toHaveBeenCalled();
    expect(big.runtime.compactInFlight).toBe(false);
  });

  it("explicit compactAfterTokens beats a configured ratio", async () => {
    const { handler } = captureHandler({ compactAfterTokens: 3, compactAfterRatio: 0.5 });
    const ctx = windowedCtx(100, dueBranch); // 3 tokens ≥ explicit 3; < ratio 50

    handler(agentEnd(), ctx);
    await flushAll();

    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("an explicit fixed token threshold applies regardless of window", async () => {
    // A literal explicit compactAfterTokens (here 81k, the legacy flat value)
    // wins over any window-derived surface at the resolution level, so a
    // 75-token branch must NOT auto-compact on a tiny-window model.
    const { handler, runtime } = captureHandler({ compactAfterTokens: 81_000 });
    const ctx = windowedCtx(100, [textCustomMessage("raw-1", "a".repeat(300))]);
    handler(agentEnd(), ctx);
    await flushAll();
    expect(runtime.compactInFlight).toBe(false);
    expect(ctx.compact).not.toHaveBeenCalled();
  });
});

describe("Eligibility guard (proactive auto-compaction Nothing to compact / session too small)", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    const cliPath = join(
      process.cwd(),
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "bundle",
      "cli.js",
    );
    await installHostInlineCompactionAdapter({ entrypoint: cliPath, stack: "" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const smallIneligibleBranch: TestEntry[] = [
    {
      type: "message",
      id: "small-user-1",
      parentId: null,
      timestamp: "2026-05-02T10:00:00.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "a".repeat(4000) }],
      },
    },
    {
      type: "message",
      id: "small-assistant-2",
      parentId: null,
      timestamp: "2026-05-02T10:00:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "b".repeat(4000) }],
        usage: { totalTokens: 85_000, inputTokens: 84_000, outputTokens: 1_000 },
      },
    },
  ];

  function makeLargeBranch(): TestEntry[] {
    const branch: TestEntry[] = [];
    for (let i = 0; i < 8; i++) {
      branch.push({
        type: "message",
        id: `large-msg-${i}`,
        parentId: null,
        timestamp: "2026-05-02T10:00:00.000Z",
        message: {
          role: i % 2 === 0 ? "user" : "assistant",
          content: [{ type: "text", text: "x".repeat(16_000) }],
          ...(i === 7
            ? { usage: { totalTokens: 85_000, inputTokens: 84_000, outputTokens: 1_000 } }
            : {}),
        },
      });
    }
    return branch;
  }

  class TriggerTestSession {
    settingsManager: {
      getCompactionSettings: () => {
        enabled: boolean;
        reserveTokens: number;
        keepRecentTokens: number;
      };
    };
    sessionManager: {
      buildSessionContext: () => { messages: unknown[] };
      getBranch: () => TestEntry[];
      getSessionId: () => string;
    };
    agent = { state: { messages: [] } };

    constructor(
      getBranchFn: () => TestEntry[],
      settings: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number },
    ) {
      this.settingsManager = {
        getCompactionSettings: () => ({
          enabled: settings.enabled ?? true,
          reserveTokens: settings.reserveTokens ?? 1000,
          keepRecentTokens: settings.keepRecentTokens ?? 20_000,
        }),
      };
      this.sessionManager = {
        buildSessionContext: () => ({ messages: [] }),
        getBranch: getBranchFn,
        getSessionId: () => "test-session-settings",
      };
    }

    async compact() {
      await this.abort();
      (this as any).sessionManager.appendCompaction?.();
      this.agent.state.messages = [];
    }

    async abort() {}

    _bindExtensionCore(runner: unknown) {
      void runner;
    }
  }

  function ctxWithSettings(
    branchOrBranches: TestEntry[] | TestEntry[][],
    settings: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number } = {
      enabled: true,
      reserveTokens: 1000,
      keepRecentTokens: 20_000,
    },
    overrides: Record<string, unknown> = {},
  ) {
    const branches =
      Array.isArray(branchOrBranches[0]) && "type" in (branchOrBranches[0] as any) === false
        ? (branchOrBranches as TestEntry[][])
        : [branchOrBranches as TestEntry[]];
    let branchIndex = 0;
    const getBranch = vi.fn(() => branches[Math.min(branchIndex++, branches.length - 1)]);

    installInlineCompactionAdapter({ sessionClass: TriggerTestSession as never });
    const session = new TriggerTestSession(getBranch, settings);
    session._bindExtensionCore({});

    return fakeCtx(branches, {
      sessionManager: session.sessionManager,
      ...overrides,
    });
  }

  it("skips settled auto-compaction initially when provider threshold is reached but session entries are ineligible", async () => {
    const { handler, runtime } = captureHandler({ compactAfterTokens: 81_000 });
    const ctx = ctxWithSettings(smallIneligibleBranch);

    handler(agentEnd(), ctx);
    expect(runtime.compactInFlight).toBe(false);
    await flushAll();

    expect(ctx.compact).not.toHaveBeenCalled();
    const infoNotices = ctx.ui.notify.mock.calls.filter((call) => call[1] === "info");
    expect(
      infoNotices.some((call) => String(call[0]).includes("compaction threshold reached")),
    ).toBe(false);
  });

  it("deferred recheck skips compaction when session becomes ineligible before agent settles", async () => {
    const { handler, runtime } = captureHandler({ compactAfterTokens: 81_000 });
    const largeBranch = makeLargeBranch();
    let idle = false;
    const branches = [largeBranch, smallIneligibleBranch];
    const ctx = ctxWithSettings(
      branches,
      {
        enabled: true,
        reserveTokens: 1000,
        keepRecentTokens: 20_000,
      },
      {
        isIdle: vi.fn(() => idle),
      },
    );

    handler(agentEnd(), ctx);
    // Initial check on large branch passes and marks compactInFlight
    expect(runtime.compactInFlight).toBe(true);

    // Agent becomes idle, but now the branch has switched to smallIneligibleBranch
    idle = true;
    await flushAll();
    await advanceRetryTicks(1);

    expect(runtime.compactInFlight).toBe(false);
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("resumes auto-compaction after history grows past keepRecentTokens", async () => {
    const { handler, runtime } = captureHandler({ compactAfterTokens: 81_000 });
    const ineligibleCtx = ctxWithSettings(smallIneligibleBranch);

    // Turn 1: ineligible -> skipped
    handler(agentEnd(), ineligibleCtx);
    await flushAll();
    expect(ineligibleCtx.compact).not.toHaveBeenCalled();
    expect(runtime.compactInFlight).toBe(false);

    // Turn 2: history grew to largeBranch -> eligible
    const eligibleCtx = ctxWithSettings(makeLargeBranch());
    handler(agentEnd(), eligibleCtx);
    expect(runtime.compactInFlight).toBe(true);
    await flushAll();

    expect(eligibleCtx.compact).toHaveBeenCalledTimes(1);
  });

  it("respects effective configured keepRecentTokens rather than a hardcoded 20k", async () => {
    const { handler, runtime } = captureHandler({ compactAfterTokens: 81_000 });
    // Small branch has ~2k tokens. Under keepRecentTokens: 500, it IS eligible!
    const ctx = ctxWithSettings(smallIneligibleBranch, {
      enabled: true,
      reserveTokens: 500,
      keepRecentTokens: 500,
    });

    handler(agentEnd(), ctx);
    expect(runtime.compactInFlight).toBe(true);
    await flushAll();

    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("mid-run mode (resume): skips inline compaction when threshold reached but session is ineligible", async () => {
    const { turnHandler, runtime, inlineCompact } = captureHandler({
      compactAfterTokens: 81_000,
      midRunCompaction: "resume",
    });
    const ctx = ctxWithSettings(smallIneligibleBranch);

    await turnHandler(turnEnd(), ctx);

    expect(inlineCompact).not.toHaveBeenCalled();
    expect(runtime.midRunCompactionRetry.failures).toBe(0);
    const infoNotices = ctx.ui.notify.mock.calls.filter((call) => call[1] === "info");
    expect(
      infoNotices.some((call) => String(call[0]).includes("compaction threshold reached mid-run")),
    ).toBe(false);
  });

  it("mid-run mode (pause): skips pause compaction when threshold reached but session is ineligible", async () => {
    const { turnHandler, runtime } = captureHandler({
      compactAfterTokens: 81_000,
      midRunCompaction: "pause",
    });
    const ctx = ctxWithSettings(smallIneligibleBranch);

    await turnHandler(turnEnd(), ctx);

    expect(ctx.compact).not.toHaveBeenCalled();
    expect(runtime.midRunCompactionRetry.failures).toBe(0);
    const infoNotices = ctx.ui.notify.mock.calls.filter((call) => call[1] === "info");
    expect(
      infoNotices.some((call) => String(call[0]).includes("compaction threshold reached mid-run")),
    ).toBe(false);
  });

  it("genuine compaction errors remain visible when eligible compaction fails", async () => {
    const { handler } = captureHandler({ compactAfterTokens: 81_000 });
    const ctx = ctxWithSettings(makeLargeBranch(), undefined, {
      compact: vi.fn((options: any) => {
        options?.onError?.(new Error("API rate limit exceeded: quota 0"));
      }),
    });

    handler(agentEnd(), ctx);
    await flushAll();

    expect(ctx.compact).toHaveBeenCalledTimes(1);
    const errorNotices = ctx.ui.notify.mock.calls.filter((call) => call[1] === "error");
    expect(errorNotices.length).toBeGreaterThan(0);
    expect(errorNotices.some((call) => String(call[0]).includes("API rate limit exceeded"))).toBe(
      true,
    );
  });

  it("fails open and proceeds with compaction when settings are unavailable (session not captured)", async () => {
    const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
    // Bare mock session with no settingsManager captured
    const ctx = fakeCtx([dueBranch]);

    handler(agentEnd(), ctx);
    expect(runtime.compactInFlight).toBe(true);
    await flushAll();

    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("fails open and proceeds with compaction when prepareCompaction is unavailable", async () => {
    installInlineCompactionAdapter({ prepareCompaction: undefined });
    const { handler, runtime } = captureHandler({ compactAfterTokens: 81_000 });
    const ctx = ctxWithSettings(smallIneligibleBranch);

    handler(agentEnd(), ctx);
    expect(runtime.compactInFlight).toBe(true);
    await flushAll();

    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });
});
