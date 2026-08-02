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

import {
  registerCompactionTrigger,
  resolveCompactThreshold,
} from "../src/om/compaction-trigger.js";
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
    compactAfterPercent?: number;
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
) {
  let agentEndHandler: ((event: unknown, ctx: unknown) => void) | undefined;
  let agentStartHandler: (() => void) | undefined;
  let turnEndHandler: ((event: unknown, ctx: unknown) => void) | undefined;
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
      compactAfterPercent: args.compactAfterPercent,
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
  };
  registerCompactionTrigger(pi as any, runtime as any);
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

  it("M2: compacts immediately at threshold — no idle wait, agent is mid-run by definition", () => {
    const { turnHandler, runtime } = captureHandler({
      compactAfterTokens: 3,
      midRunCompaction: "resume",
    });
    const ctx = fakeCtx([dueBranch]);

    turnHandler(turnEnd(), ctx);

    // Synchronous: no flushAll/timer advance — ctx.compact must already be called.
    expect(runtime.compactInFlight).toBe(true);
    expect(ctx.compact).toHaveBeenCalledTimes(1);
    expect(ctx.isIdle).not.toHaveBeenCalled();
  });

  it("M3: resume mode — onComplete injects a resume message with triggerTurn", () => {
    const { turnHandler, runtime, pi } = captureHandler({
      compactAfterTokens: 3,
      midRunCompaction: "resume",
    });
    const ctx = fakeCtx([dueBranch]);
    turnHandler(turnEnd(), ctx);
    const options = ctx.compact.mock.calls[0][0];
    options.onComplete({});

    expect(runtime.compactInFlight).toBe(false);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const [message, sendOptions] = pi.sendMessage.mock.calls[0];
    expect(message.customType).toBe("blackhole-resume");
    expect(typeof message.content).toBe("string");
    expect(message.content.length).toBeGreaterThan(0);
    expect(sendOptions).toMatchObject({ triggerTurn: true });
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

  it("M6: onError clears compactInFlight, suspends further attempts, and still resumes (resume mode)", () => {
    const { turnHandler, runtime, pi } = captureHandler({
      compactAfterTokens: 3,
      midRunCompaction: "resume",
    });
    const ctx = fakeCtx([dueBranch]);

    turnHandler(turnEnd(), ctx);
    const options = ctx.compact.mock.calls[0][0];
    options.onError({ message: "boom" });

    expect(runtime.compactInFlight).toBe(false);
    expect(runtime.midRunCompactionSuspended).toBe(true);
    // The run was already aborted by ctx.compact() — resume mode must still
    // send the resume message or the agent stalls mid-task.
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
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
  it("M15: cancelled compaction still resumes the agent and suspends further mid-run attempts", () => {
    const { turnHandler, runtime, pi } = captureHandler({
      compactAfterTokens: 3,
      midRunCompaction: "resume",
    });
    const ctx = fakeCtx([dueBranch, dueBranch]);
    turnHandler(turnEnd(), ctx);
    const options = ctx.compact.mock.calls[0][0];
    // The before-compact hook cancelled (e.g. too few live messages).
    // The run was already aborted by ctx.compact() — without a resume
    // message the agent would stall mid-task.
    options.onError({ message: "Compaction cancelled" });

    expect(runtime.compactInFlight).toBe(false);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    // Next turn_end must NOT re-trigger (tokens unchanged, compaction would
    // cancel again — abort/cancel thrash loop).
    turnHandler(turnEnd(), ctx);
    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("M16: suspension clears once pressure drops below threshold (successful compaction elsewhere)", () => {
    const { turnHandler } = captureHandler({
      compactAfterTokens: 3,
      midRunCompaction: "resume",
    });
    // Sequence: due (trigger+cancel) → due (suspended) → below (clears) → due (triggers again)
    const ctx = fakeCtx([dueBranch, dueBranch, belowBranch, dueBranch]);

    turnHandler(turnEnd(), ctx);
    ctx.compact.mock.calls[0][0].onError({ message: "Compaction cancelled" });
    turnHandler(turnEnd(), ctx); // suspended — no new compact
    expect(ctx.compact).toHaveBeenCalledTimes(1);

    turnHandler(turnEnd(), ctx); // below threshold — clears suspension
    turnHandler(turnEnd(), ctx); // due again — triggers
    expect(ctx.compact).toHaveBeenCalledTimes(2);
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

describe("compactAfterPercent (context-window-relative threshold)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolveCompactThreshold uses percent x contextWindow when both known", () => {
    const runtime = {
      config: { compactAfterTokens: 81_000, compactAfterPercent: 0.75 },
    } as any;
    expect(resolveCompactThreshold(runtime, { contextWindow: 1_000_000 })).toBe(
      750_000,
    );
    expect(resolveCompactThreshold(runtime, { contextWindow: 272_000 })).toBe(
      204_000,
    );
  });

  it("resolveCompactThreshold falls back to compactAfterTokens without a usable window", () => {
    const runtime = {
      config: { compactAfterTokens: 81_000, compactAfterPercent: 0.75 },
    } as any;
    expect(resolveCompactThreshold(runtime, undefined)).toBe(81_000);
    expect(resolveCompactThreshold(runtime, {})).toBe(81_000);
    expect(resolveCompactThreshold(runtime, { contextWindow: 0 })).toBe(81_000);
  });

  it("resolveCompactThreshold ignores percent when unset", () => {
    const runtime = { config: { compactAfterTokens: 81_000 } } as any;
    expect(resolveCompactThreshold(runtime, { contextWindow: 1_000_000 })).toBe(
      81_000,
    );
  });

  it("percent threshold wins over a huge compactAfterTokens (agent_end)", async () => {
    const { handler, runtime } = captureHandler({
      compactAfterTokens: 999_999,
      compactAfterPercent: 0.5,
    });
    // window 4 x 0.5 = threshold 2; dueBranch has ~3 tokens
    const ctx = fakeCtx([dueBranch], { model: { contextWindow: 4 } });

    handler(agentEnd(), ctx);
    expect(runtime.compactInFlight).toBe(true);
    await flushAll();

    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("stays below a percent threshold larger than accumulated tokens (agent_end)", async () => {
    const { handler, runtime } = captureHandler({
      compactAfterTokens: 1,
      compactAfterPercent: 0.5,
    });
    // window 100 x 0.5 = threshold 50; dueBranch has ~3 tokens.
    // compactAfterTokens=1 alone would have fired - percent must take precedence.
    const ctx = fakeCtx([dueBranch], { model: { contextWindow: 100 } });

    handler(agentEnd(), ctx);
    await flushAll();

    expect(runtime.compactInFlight).toBe(false);
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("applies the percent threshold on the turn_end (mid-run) path", async () => {
    const { turnHandler, runtime } = captureHandler({
      compactAfterTokens: 999_999,
      compactAfterPercent: 0.5,
      midRunCompaction: "pause",
    });
    const ctx = fakeCtx([dueBranch], { model: { contextWindow: 4 } });

    turnHandler(turnEnd(), ctx);

    expect(runtime.compactInFlight).toBe(true);
    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });
});
