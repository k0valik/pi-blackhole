/**
 * Issue #207 — expose the Pi summarizer model boundary when compaction yields.
 *
 * Every `return` (or `undefined` result) from blackhole's session_before_compact
 * hook hands the compaction summary to Pi's own summarizer, which runs on the
 * ACTIVE SESSION MODEL (pi captures `this.model` before emitting the event;
 * virtual models re-resolve at request time). That is a separate ownership
 * domain from the OM worker chain: `sessionFallback` and OM cooldown policy do
 * not apply. These tests lock in the observable contract:
 *
 *  1. Each yield site traces `before_compact.yields_to_pi_summarizer` with the
 *     reason and the session model identity.
 *  2. When the session model sits in one of blackhole's persisted cooldown
 *     windows, the yield emits ONE warning naming the model — the actionable
 *     case where the boundary matters (the user can /model or switch
 *     compactionEngine to "blackhole").
 *  3. Cancel paths never emit the yield trace or toast — cancellation is a
 *     separate outcome (the issue calls this out explicitly).
 *
 * Mocks follow tests/compact-failed.test.ts (debug-log capture) and
 * tests/cooldown-write-log.test.ts (hoisted getAgentDir so the cooldown file
 * lands in a per-test tmp dir).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("../src/om/debug-log.js", () => ({
  debugLog: vi.fn(),
}));

const host = vi.hoisted(() => ({ dir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getAgentDir: () => host.dir,
}));

import { debugLog } from "../src/om/debug-log.js";
import { recordCooldown } from "../src/om/cooldown.js";
import {
  registerBeforeCompactHook,
  PI_VCC_COMPACT_INSTRUCTION,
} from "../src/hooks/before-compact.js";
import { registerCompactFailedHook } from "../src/hooks/compact-failed.js";

/** Real-shaped session model: provider + id + context window, like Model<any>. */
const SESSION_MODEL = { provider: "prov", id: "main-1", contextWindow: 200_000 };
/** Sentinel for "the host exposes no model" (passing undefined would trip the
 *  ctxModel default parameter and silently re-arm SESSION_MODEL). */
const NO_MODEL = Symbol("no-model");

const msg = (id: string, role: "user" | "assistant" | "toolResult", content = "x") => ({
  id,
  type: "message",
  message: { role, content },
});

function makeEvent(branchEntries: unknown[], customInstructions?: string) {
  return {
    type: "session_before_compact",
    customInstructions,
    branchEntries,
    preparation: {
      previousSummary: undefined,
      fileOps: { read: [], written: [], edited: [] },
      tokensBefore: 1000,
    },
    reason: "threshold",
    willRetry: false,
    signal: new AbortController().signal,
  };
}

function createMockPi(initialConfig?: Record<string, unknown>, ctxModel: unknown = SESSION_MODEL) {
  let handler: ((event: any, ctx: any) => any) | undefined;
  const notifyCalls: Array<{ msg: string; level: string }> = [];
  const config = {
    compaction: "auto",
    compactionEngine: "blackhole",
    tailBehavior: "minimal",
    overrideDefaultCompaction: true,
    ...initialConfig,
  };
  const ctx = {
    cwd: "/tmp/project",
    hasUI: true,
    model: ctxModel === NO_MODEL ? undefined : ctxModel,
    getSystemPrompt: () => "",
    sessionManager: { getEntries: () => [] },
    ui: {
      notify: (message: string, level: string) => {
        notifyCalls.push({ msg: message, level });
      },
    },
  };
  const omRuntime = {
    ensureConfig: vi.fn(() => {}),
    config,
    isMemoryEnabled: () => config.memory !== false,
    noteSubagentMemorySkip: vi.fn(),
    compactWasPiVcc: false,
    lastCompactCancelled: false,
  };
  return {
    pi: {
      on: (eventName: string, h: (event: any, ctx: any) => any) => {
        if (eventName === "session_before_compact") handler = h;
      },
    } as any,
    invoke: (event: any) => handler!(event, ctx),
    notifyCalls,
    omRuntime,
    config,
  };
}

function traceEvents(): string[] {
  return (vi.mocked(debugLog).mock.calls as unknown as [string][]).map((c) => c[0]);
}

function traceData(event: string): Record<string, unknown> | undefined {
  const call = (
    vi.mocked(debugLog).mock.calls as unknown as [string, Record<string, unknown>][]
  ).find((c) => c[0] === event);
  return call?.[1];
}

/** Toasts mentioning the yield boundary (unique token per T4). */
function yieldToasts(notifyCalls: Array<{ msg: string; level: string }>): string[] {
  return notifyCalls.filter((c) => c.msg.includes("compaction yielded to Pi")).map((c) => c.msg);
}

function cooldownFilePath(): string {
  return join(host.dir, "pi-blackhole", "pi-blackhole-cooldown.json");
}

/** Arm a persisted cooldown window for the session model. */
function armSessionModelCooldown(): void {
  recordCooldown(
    { provider: SESSION_MODEL.provider, id: SESSION_MODEL.id, cooldownHours: 1 },
    "HTTP 401 Unauthorized",
    "observer",
    "provider_configuration",
  );
}

const threeEntries = () => [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "toolResult")];

beforeEach(() => {
  host.dir = mkdtempSync(join(tmpdir(), "blackhole-yield-boundary-"));
  vi.mocked(debugLog).mockClear();
});

afterEach(() => {
  rmSync(host.dir, { recursive: true, force: true });
});

describe("yield sites trace the Pi summarizer boundary", () => {
  test('compactionEngine "pi-default" yields and traces the session model identity', () => {
    const { pi, invoke, omRuntime, notifyCalls } = createMockPi({
      compactionEngine: "pi-default",
    });
    registerBeforeCompactHook(pi, omRuntime);

    expect(invoke(makeEvent(threeEntries()))).toBeUndefined();
    expect(traceData("before_compact.yields_to_pi_summarizer")).toMatchObject({
      reason: "compactionEngine_pi_default",
      model: "prov/main-1",
      cooldownActive: false,
    });
    expect(yieldToasts(notifyCalls)).toHaveLength(0);
  });

  test('compaction "off" yields and traces reason compaction_off', () => {
    const { pi, invoke, omRuntime } = createMockPi({ compaction: "off" });
    registerBeforeCompactHook(pi, omRuntime);

    expect(invoke(makeEvent(threeEntries()))).toBeUndefined();
    expect(traceData("before_compact.yields_to_pi_summarizer")).toMatchObject({
      reason: "compaction_off",
      model: "prov/main-1",
    });
  });

  test('compaction "manual" yields and traces reason compaction_manual', () => {
    const { pi, invoke, omRuntime } = createMockPi({ compaction: "manual" });
    registerBeforeCompactHook(pi, omRuntime);

    expect(invoke(makeEvent(threeEntries()))).toBeUndefined();
    expect(traceData("before_compact.yields_to_pi_summarizer")).toMatchObject({
      reason: "compaction_manual",
      model: "prov/main-1",
    });
  });

  test("legacy overrideDefaultCompaction=false yields and traces its reason", () => {
    const { pi, invoke, omRuntime } = createMockPi({
      compaction: undefined,
      compactionEngine: undefined,
      overrideDefaultCompaction: false,
    });
    registerBeforeCompactHook(pi, omRuntime);

    expect(invoke(makeEvent(threeEntries()))).toBeUndefined();
    expect(traceData("before_compact.yields_to_pi_summarizer")).toMatchObject({
      reason: "overrideDefaultCompaction=false",
      model: "prov/main-1",
    });
  });

  test("provider-skip yield traces reason provider_skipped", () => {
    const { pi, invoke, omRuntime } = createMockPi({ skipForProviders: ["prov"] });
    registerBeforeCompactHook(pi, omRuntime);

    expect(invoke(makeEvent(threeEntries()))).toBeUndefined();
    expect(traceData("before_compact.yields_to_pi_summarizer")).toMatchObject({
      reason: "provider_skipped",
      model: "prov/main-1",
    });
  });

  test("yield with no session model traces model null and does not crash", () => {
    const { pi, invoke, omRuntime, notifyCalls } = createMockPi(
      { compactionEngine: "pi-default" },
      NO_MODEL,
    );
    registerBeforeCompactHook(pi, omRuntime);

    expect(invoke(makeEvent(threeEntries()))).toBeUndefined();
    expect(traceData("before_compact.yields_to_pi_summarizer")).toMatchObject({
      reason: "compactionEngine_pi_default",
      model: null,
      cooldownActive: false,
    });
    expect(yieldToasts(notifyCalls)).toHaveLength(0);
  });

  test("enter trace includes the session model identity", () => {
    const { pi, invoke, omRuntime } = createMockPi({ compactionEngine: "pi-default" });
    registerBeforeCompactHook(pi, omRuntime);

    invoke(makeEvent(threeEntries()));
    expect(traceData("before_compact.enter")?.model).toBe("prov/main-1");
  });
});

describe("cooldown-aware yield warning", () => {
  test("yield warns once when the session model is in a persisted cooldown window", () => {
    armSessionModelCooldown();
    const { pi, invoke, omRuntime, notifyCalls } = createMockPi({
      compactionEngine: "pi-default",
    });
    registerBeforeCompactHook(pi, omRuntime);

    expect(invoke(makeEvent(threeEntries()))).toBeUndefined();
    expect(yieldToasts(notifyCalls)).toHaveLength(1);
    expect(notifyCalls[0].level).toBe("warning");
    expect(notifyCalls[0].msg).toContain("compaction yielded to Pi");
    expect(notifyCalls[0].msg).toContain("prov/main-1");
    expect(notifyCalls[0].msg).toContain("cooldown window");
    expect(traceData("before_compact.yields_to_pi_summarizer")?.cooldownActive).toBe(true);
  });

  test("yield without a cooldown emits no toast", () => {
    const { pi, invoke, omRuntime, notifyCalls } = createMockPi({
      compactionEngine: "pi-default",
    });
    registerBeforeCompactHook(pi, omRuntime);

    expect(invoke(makeEvent(threeEntries()))).toBeUndefined();
    expect(notifyCalls).toHaveLength(0);
  });

  test("repeated yields in the same cooldown window warn once", () => {
    armSessionModelCooldown();
    const { pi, invoke, omRuntime, notifyCalls } = createMockPi({
      compactionEngine: "pi-default",
    });
    registerBeforeCompactHook(pi, omRuntime);

    invoke(makeEvent(threeEntries()));
    invoke(makeEvent(threeEntries()));
    expect(yieldToasts(notifyCalls)).toHaveLength(1);
  });

  test("a fresh cooldown window warns again", () => {
    armSessionModelCooldown();
    const { pi, invoke, omRuntime, notifyCalls } = createMockPi({
      compactionEngine: "pi-default",
    });
    registerBeforeCompactHook(pi, omRuntime);

    invoke(makeEvent(threeEntries()));
    expect(yieldToasts(notifyCalls)).toHaveLength(1);

    // Simulate a new window: rewrite the persisted entry with a later expiry.
    const map = JSON.parse(readFileSync(cooldownFilePath(), "utf-8"));
    map["prov/main-1"].until = new Date(Date.now() + 2 * 3_600_000).toISOString();
    writeFileSync(cooldownFilePath(), `${JSON.stringify(map, null, 2)}\n`);

    invoke(makeEvent(threeEntries()));
    expect(yieldToasts(notifyCalls)).toHaveLength(2);
  });

  test("armed cooldown but no session model identity: no toast, no crash", () => {
    armSessionModelCooldown();
    const { pi, invoke, omRuntime, notifyCalls } = createMockPi(
      { compactionEngine: "pi-default" },
      NO_MODEL,
    );
    registerBeforeCompactHook(pi, omRuntime);

    expect(invoke(makeEvent(threeEntries()))).toBeUndefined();
    expect(yieldToasts(notifyCalls)).toHaveLength(0);
  });
});

describe("cancel paths never yield to Pi's summarizer", () => {
  test("/blackhole cancels on too few live messages: no yield trace, no toast", () => {
    armSessionModelCooldown();
    const { pi, invoke, omRuntime, notifyCalls } = createMockPi({
      compactionEngine: "pi-default",
      // pi-default tail: fewer than 2 live messages cancels (minimal compacts all).
      tailBehavior: "pi-default",
    });
    registerBeforeCompactHook(pi, omRuntime);

    const twoEntries = [msg("m1", "user"), msg("m2", "assistant")];
    expect(invoke(makeEvent(twoEntries, PI_VCC_COMPACT_INSTRUCTION))).toEqual({
      cancel: true,
    });
    expect(traceEvents()).not.toContain("before_compact.yields_to_pi_summarizer");
    expect(yieldToasts(notifyCalls)).toHaveLength(0);
  });

  test("legacy manual-mode cancel: no yield trace, no toast", () => {
    armSessionModelCooldown();
    const { pi, invoke, omRuntime, notifyCalls } = createMockPi({
      compaction: undefined,
      compactionEngine: undefined,
      overrideDefaultCompaction: true,
      noAutoCompact: true,
    });
    registerBeforeCompactHook(pi, omRuntime);

    expect(invoke(makeEvent(threeEntries()))).toEqual({ cancel: true });
    expect(traceEvents()).not.toContain("before_compact.yields_to_pi_summarizer");
    expect(yieldToasts(notifyCalls)).toHaveLength(0);
  });
});

describe("compact-failed trace carries the boundary", () => {
  test("pi-default noise-filter trace includes the session model identity", () => {
    let handler: ((event: any, ctx: any) => void) | undefined;
    const pi = {
      on: vi.fn((name: string, cb: any) => {
        if (name === "session_compact_failed") handler = cb;
      }),
    };
    const runtime = {
      ensureConfig: vi.fn(),
      config: { compactionEngine: "pi-default", debugLog: false },
      compactWasPiVcc: false,
      lastCompactCancelled: false,
      compactInFlight: false,
      autoCompactionController: null,
    };
    registerCompactFailedHook(pi as any, runtime as any);

    const ctx = {
      cwd: "/tmp/project",
      hasUI: true,
      model: SESSION_MODEL,
      sessionManager: { getSessionId: () => "test-session-001" },
      ui: { notify: vi.fn() },
    };
    handler!({ reason: "threshold", aborted: false, willRetry: false, fromExtension: false }, ctx);

    expect(traceData("compact_failed.skipped_pi_default")).toMatchObject({
      reason: "threshold",
      model: "prov/main-1",
    });
  });
});
