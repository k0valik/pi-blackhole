/**
 * Tests for the session_compact_failed hook (src/hooks/compact-failed.ts).
 *
 * Covers: handler registration, pending-controller abort and compactInFlight
 * reset on abort/error, overflow-retry visibility, pi-default noise filtering,
 * error notification gating, and attempt-scoped attribution (upstream pi only
 * flags content-bearing compactions, so hook { cancel: true } returns are
 * mislabeled — we correct via compactWasPiVcc / lastCompactCancelled).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/om/debug-log.js", () => ({
  debugLog: vi.fn(),
}));

import { debugLog } from "../src/om/debug-log.js";
import { registerCompactFailedHook } from "../src/hooks/compact-failed.js";
import {
  PI_VCC_COMPACT_INSTRUCTION,
  registerBeforeCompactHook,
} from "../src/hooks/before-compact.js";
import { registerCompactionTrigger } from "../src/om/compaction-trigger.js";

function traceEvents(): string[] {
  return (vi.mocked(debugLog).mock.calls as unknown as [string][]).map(
    (c) => c[0],
  );
}

function traceData(event: string): Record<string, unknown> | undefined {
  const call = (
    vi.mocked(debugLog).mock.calls as unknown as [
      string,
      Record<string, unknown>,
    ][]
  ).find((c) => c[0] === event);
  return call?.[1];
}

interface FailedEvent {
  reason?: "manual" | "threshold" | "overflow";
  errorMessage?: string;
  aborted?: boolean;
  willRetry?: boolean;
  fromExtension?: boolean;
}

function captureHandler(
  args: {
    compactionEngine?: "blackhole" | "pi-default";
    compactInFlight?: boolean;
    compactWasPiVcc?: boolean;
    lastCompactCancelled?: boolean;
  } = {},
) {
  let handler: ((event: FailedEvent, ctx: unknown) => void) | undefined;
  const pi = {
    on: vi.fn((name: string, cb: any) => {
      if (name === "session_compact_failed") handler = cb;
    }),
  };
  const controller = args.compactInFlight ? new AbortController() : null;
  const runtime = {
    ensureConfig: vi.fn(),
    config: {
      compactionEngine: args.compactionEngine ?? "blackhole",
      debugLog: false,
    },
    compactInFlight: args.compactInFlight ?? false,
    autoCompactionController: controller,
    compactWasPiVcc: args.compactWasPiVcc ?? false,
    lastCompactCancelled: args.lastCompactCancelled ?? false,
  };
  registerCompactFailedHook(pi as any, runtime as any);
  if (!handler)
    throw new Error("session_compact_failed handler was not registered");
  return { handler: handler!, pi, runtime };
}

function fakeCtx(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/tmp/project",
    sessionManager: { getSessionId: vi.fn(() => "test-session-001") },
    hasUI: true,
    ui: { notify: vi.fn() },
    ...overrides,
  };
}

function failedEvent(e: FailedEvent = {}): FailedEvent {
  return {
    reason: e.reason ?? "threshold",
    errorMessage: e.errorMessage,
    aborted: e.aborted ?? false,
    willRetry: e.willRetry ?? false,
    fromExtension: e.fromExtension ?? false,
  };
}

describe("compact-failed hook", () => {
  beforeEach(() => {
    vi.mocked(debugLog).mockClear();
  });

  it("registers a session_compact_failed handler", () => {
    const { pi } = captureHandler();
    expect(pi.on).toHaveBeenCalledWith(
      "session_compact_failed",
      expect.any(Function),
    );
  });

  it("aborts the pending controller before resetting compactInFlight", () => {
    const { handler, runtime } = captureHandler({ compactInFlight: true });
    const ctx = fakeCtx();
    const pendingController = runtime.autoCompactionController;

    handler(failedEvent({ reason: "manual", aborted: true }), ctx);

    expect(pendingController?.signal.aborted).toBe(true);
    expect(runtime.compactInFlight).toBe(false);
    expect(runtime.autoCompactionController).toBeNull();
    expect(traceData("compact_failed.compactInFlight_reset")).toMatchObject({
      abortedPendingWait: true,
    });
  });

  it("resets compactInFlight on non-abort errors", () => {
    const { handler, runtime } = captureHandler({ compactInFlight: true });
    const ctx = fakeCtx();

    handler(
      failedEvent({ reason: "threshold", errorMessage: "provider 500" }),
      ctx,
    );

    expect(runtime.compactInFlight).toBe(false);
    expect(runtime.autoCompactionController).toBeNull();
    expect(traceEvents()).toContain("compact_failed.compactInFlight_reset");
  });

  it("does not emit a reset trace when nothing was in flight", () => {
    const { handler, runtime } = captureHandler({ compactInFlight: false });
    const ctx = fakeCtx();

    handler(failedEvent({ reason: "manual", aborted: true }), ctx);

    expect(runtime.compactInFlight).toBe(false);
    expect(traceEvents()).not.toContain("compact_failed.compactInFlight_reset");
  });

  it("notifies overflow-retry visibility (aborted + willRetry)", () => {
    const { handler } = captureHandler();
    const ctx = fakeCtx();

    handler(
      failedEvent({ reason: "overflow", aborted: true, willRetry: true }),
      ctx,
    );

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "blackhole: overflow compaction aborted, retrying turn",
      "info",
    );
  });

  it("does not notify overflow-retry when willRetry is false", () => {
    const { handler } = captureHandler();
    const ctx = fakeCtx();

    handler(
      failedEvent({ reason: "overflow", aborted: true, willRetry: false }),
      ctx,
    );

    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("skips detailed handling for pi-default engine failures that are not ours", () => {
    const { handler } = captureHandler({ compactionEngine: "pi-default" });
    const ctx = fakeCtx();

    handler(
      failedEvent({
        reason: "threshold",
        errorMessage: "boom",
        fromExtension: false,
      }),
      ctx,
    );

    // Received is still traced (lightweight observability), then the skip trace.
    expect(traceEvents()).toContain("compact_failed.received");
    expect(traceEvents()).toContain("compact_failed.skipped_pi_default");
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("notifies errors when fromExtension is true", () => {
    const { handler } = captureHandler();
    const ctx = fakeCtx();

    handler(
      failedEvent({
        reason: "overflow",
        errorMessage: "summary too long",
        fromExtension: true,
      }),
      ctx,
    );

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "blackhole: compaction failed — summary too long",
      "error",
    );
  });

  it("does not notify errors when not attributed to blackhole", () => {
    const { handler } = captureHandler();
    const ctx = fakeCtx();

    handler(
      failedEvent({
        reason: "threshold",
        errorMessage: "boom",
        fromExtension: false,
      }),
      ctx,
    );

    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("attributes the current /blackhole failure and consumes compactWasPiVcc", () => {
    const { handler, runtime } = captureHandler({
      compactionEngine: "pi-default",
      compactWasPiVcc: true,
    });
    const ctx = fakeCtx();

    handler(
      failedEvent({
        reason: "manual",
        errorMessage: "boom",
        fromExtension: false,
      }),
      ctx,
    );

    // compactWasPiVcc means the current failure is ours: not skipped, error
    // surfaced, and the attempt marker consumed before a later failure arrives.
    expect(traceEvents()).not.toContain("compact_failed.skipped_pi_default");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "blackhole: compaction failed — boom",
      "error",
    );
    expect(traceData("compact_failed.received")).toMatchObject({
      fromExtension: false,
      compactWasPiVcc: true,
      attributedFromExtension: true,
    });
    expect(runtime.compactWasPiVcc).toBe(false);
  });

  it("attributes aborted compactions cancelled by our hook (lastCompactCancelled)", () => {
    // Upstream quirk: a { cancel: true } from session_before_compact emits
    // aborted:true with fromExtension:false. Our flag corrects the record.
    const { handler, runtime } = captureHandler({
      compactionEngine: "pi-default",
      lastCompactCancelled: true,
    });
    const ctx = fakeCtx();

    handler(
      failedEvent({ reason: "manual", aborted: true, fromExtension: false }),
      ctx,
    );

    expect(traceData("compact_failed.received")).toMatchObject({
      aborted: true,
      fromExtension: false,
      lastCompactCancelled: true,
      attributedFromExtension: true,
    });
    // Not skipped despite pi-default engine — the cancel was ours.
    expect(traceEvents()).not.toContain("compact_failed.skipped_pi_default");
    // The flag is consumed after the event is handled.
    expect(runtime.lastCompactCancelled).toBe(false);
  });

  it("ignores stale extension ctx during handling", () => {
    const { handler, runtime } = captureHandler();
    const staleCtx = {
      get cwd() {
        throw {
          message:
            "This extension ctx is stale after session replacement or reload.",
        };
      },
    };

    expect(() =>
      handler(failedEvent({ reason: "manual", aborted: true }), staleCtx),
    ).not.toThrow();
    expect(runtime.ensureConfig).not.toHaveBeenCalled();
  });
});

describe("compact-failed attribution × before-compact hook", () => {
  beforeEach(() => {
    vi.mocked(debugLog).mockClear();
  });

  function captureBeforeCompact() {
    let handler: ((event: any, ctx: any) => any) | undefined;
    let compactHandler: ((event: any, ctx: any) => void) | undefined;
    let failedHandler: ((event: FailedEvent, ctx: any) => void) | undefined;
    const pi = {
      on: vi.fn((name: string, cb: any) => {
        if (name === "session_before_compact") handler = cb;
        if (name === "session_compact") compactHandler = cb;
        if (name === "session_compact_failed") failedHandler = cb;
      }),
    };
    const runtime = {
      ensureConfig: vi.fn(),
      config: {
        compaction: "auto",
        compactionEngine: "blackhole",
        overrideDefaultCompaction: true,
        noAutoCompact: false,
        memory: true,
        debugLog: false,
      },
      compactInFlight: false,
      autoCompactionController: null,
      lastCompactCancelled: false,
      compactWasPiVcc: false,
      compactionStats: null,
    };
    registerBeforeCompactHook(pi as any, runtime as any);
    registerCompactFailedHook(pi as any, runtime as any);
    if (!handler)
      throw new Error("session_before_compact handler was not registered");
    if (!compactHandler)
      throw new Error("session_compact handler was not registered");
    if (!failedHandler)
      throw new Error("session_compact_failed handler was not registered");
    return {
      handler: handler!,
      compactHandler: compactHandler!,
      failedHandler: failedHandler!,
      runtime,
    };
  }

  function makeEvent(branchEntries: any[], customInstructions?: string) {
    return {
      type: "session_before_compact",
      customInstructions,
      branchEntries,
      preparation: {
        previousSummary: undefined,
        fileOps: { read: [], written: [], edited: [] },
        tokensBefore: 1000,
      },
      signal: new AbortController().signal,
    };
  }

  function fakeCtx2() {
    return {
      cwd: "/tmp/project",
      hasUI: true,
      ui: { notify: vi.fn() },
    };
  }

  it("sets lastCompactCancelled when own-cut cancels (too few live messages)", () => {
    const { handler, runtime } = captureBeforeCompact();
    const branch = [
      {
        id: "e1",
        type: "message",
        message: { role: "user", content: "hello" },
      },
      {
        id: "e2",
        type: "message",
        message: { role: "assistant", content: "hi" },
      },
    ];

    const result = handler(makeEvent(branch), fakeCtx2());

    expect(result).toEqual({ cancel: true });
    expect(runtime.lastCompactCancelled).toBe(true);
  });

  it("resets lastCompactCancelled when a compaction proceeds", () => {
    const { handler, runtime } = captureBeforeCompact();
    runtime.lastCompactCancelled = true;
    const branch = [
      {
        id: "e1",
        type: "message",
        message: { role: "user", content: "first question" },
      },
      {
        id: "e2",
        type: "message",
        message: { role: "assistant", content: "first answer" },
      },
      {
        id: "e3",
        type: "message",
        message: { role: "user", content: "second question" },
      },
    ];

    const result = handler(makeEvent(branch), fakeCtx2());

    expect(result?.compaction).toBeTruthy();
    expect(runtime.lastCompactCancelled).toBe(false);
  });

  it("overwrites stale /blackhole attribution before a pi-default attempt", () => {
    const { handler, failedHandler, runtime } = captureBeforeCompact();
    const ctx = fakeCtx2();
    runtime.compactWasPiVcc = true;
    runtime.config.compactionEngine = "pi-default";
    const branch = [
      {
        id: "e1",
        type: "message",
        message: { role: "user", content: "first question" },
      },
      {
        id: "e2",
        type: "message",
        message: { role: "assistant", content: "first answer" },
      },
      {
        id: "e3",
        type: "message",
        message: { role: "user", content: "second question" },
      },
    ];

    expect(handler(makeEvent(branch), ctx)).toBeUndefined();
    expect(runtime.compactWasPiVcc).toBe(false);

    failedHandler(
      failedEvent({ reason: "threshold", errorMessage: "provider 500" }),
      ctx,
    );

    expect(traceEvents()).toContain("compact_failed.skipped_pi_default");
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("consumes /blackhole attribution after a successful compaction", () => {
    const { handler, compactHandler, runtime } = captureBeforeCompact();
    const branch = [
      {
        id: "e1",
        type: "message",
        message: { role: "user", content: "first question" },
      },
      {
        id: "e2",
        type: "message",
        message: { role: "assistant", content: "first answer" },
      },
      {
        id: "e3",
        type: "message",
        message: { role: "user", content: "second question" },
      },
    ];

    const result = handler(
      makeEvent(branch, PI_VCC_COMPACT_INSTRUCTION),
      fakeCtx2(),
    );
    expect(result?.compaction).toBeTruthy();
    expect(runtime.compactWasPiVcc).toBe(true);

    compactHandler({ fromExtension: true }, fakeCtx2());

    expect(runtime.compactWasPiVcc).toBe(false);
  });
});

describe("compact-failed × pending auto-compaction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(debugLog).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts an old wait loop before a later agent_end schedules its replacement", async () => {
    const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
    const pi = {
      on: vi.fn((name: string, cb: (event: any, ctx: any) => void) => {
        const registered = handlers.get(name) ?? [];
        registered.push(cb);
        handlers.set(name, registered);
      }),
    };
    const runtime = {
      ensureConfig: vi.fn(),
      config: {
        compaction: "auto",
        compactionEngine: "blackhole",
        compactAfterTokens: 3,
        debugLog: false,
      },
      compactInFlight: false,
      autoCompactionController: null as AbortController | null,
      compactWasPiVcc: false,
      lastCompactCancelled: false,
      midRunCompactionRetry: { failures: 0, retryAfter: 0 },
      resetInfoGate: vi.fn(),
      tryEmitInfo: vi.fn(() => true),
    };
    registerCompactionTrigger(pi as any, runtime as any);
    registerCompactFailedHook(pi as any, runtime as any);

    const branch = [
      {
        id: "m1",
        type: "message",
        message: { role: "user", content: "aaaaaaaaaaaa" },
      },
    ];
    const compact = vi.fn();
    const ctx = {
      cwd: "/tmp/project",
      hasUI: false,
      ui: undefined,
      sessionManager: {
        getBranch: vi.fn(() => branch),
        getSessionId: vi.fn(() => "session-1"),
      },
      isIdle: vi.fn(() => true),
      compact,
    };
    const agentEnd = {
      type: "agent_end",
      messages: [{ role: "assistant", content: "done", stopReason: "stop" }],
    };

    handlers.get("agent_end")![0](agentEnd, ctx);
    const firstController = runtime.autoCompactionController;
    expect(firstController).not.toBeNull();

    handlers.get("session_compact_failed")![0](
      failedEvent({ reason: "manual", aborted: true }),
      ctx,
    );
    expect(firstController?.signal.aborted).toBe(true);

    handlers.get("agent_start")![0]({ type: "agent_start" }, ctx);
    handlers.get("agent_end")![0](agentEnd, ctx);
    await vi.runAllTimersAsync();

    expect(compact).toHaveBeenCalledTimes(1);
  });
});
