/**
 * Tests for /blackhole command — compaction trigger, om-off/om-on, noAutoCompact flush.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const { testRoot } = vi.hoisted(() => {
  // Use require() to avoid import-hoisting issues with vi.mock
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  return {
    testRoot: join(tmpdir(), `pi-blackhole-cmd-test-${process.pid}-${Date.now()}`),
  };
});

// Mock the pi SDK before importing our module
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => join(testRoot, "agent"),
}));

// Mock the canonical config-flow so openSettings doesn't mount a real UI.
// The canonical flow renders a scope-selector + modal via ctx.ui.custom,
// which doesn't exist in these command-level tests.
vi.mock("../src/pi-base/settings/config-flow.js", () => ({
  openConfigFlow: vi.fn(async () => {}),
}));

import { registerPiVccCommand } from "../src/commands/pi-vcc.js";
import { installInlineCompactionAdapter } from "../src/om/inline-compaction.js";
import { openConfigFlow } from "../src/pi-base/settings/config-flow.js";

function createMockEnvironment() {
  const compactCalls: Array<{
    customInstructions: string;
    onComplete: () => void;
    onError: (err: Error) => void;
  }> = [];
  const appendEntryCalls: Array<{ customType: string; data: unknown }> = [];
  const notifyCalls: Array<{ msg: string; level: string }> = [];

  const pi = {
    registerCommand: vi.fn(
      (
        name: string,
        def: {
          handler: (args: unknown, ctx: unknown) => Promise<void>;
          getArgumentCompletions?: (prefix: string) => Array<{ value: string }>;
        },
      ) => {
        handlerMap.set(name, def.handler as any);
        if (def.getArgumentCompletions) {
          completionMap.set(name, def.getArgumentCompletions as any);
        }
      },
    ),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      appendEntryCalls.push({ customType, data });
    }),
  };

  const handlerMap = new Map<string, (args: unknown, ctx: unknown) => Promise<void>>();
  const completionMap = new Map<string, (prefix: string) => Array<{ value: string }>>();

  const runtime: any = {
    ensureConfig: vi.fn(),
    resetInfoGate: vi.fn(),
    tryEmitInfo: vi.fn((hasUI: boolean, ui: any, msg: string) => {
      if (!hasUI || !ui) return;
      try {
        ui.notify(msg, "info");
      } catch {
        /* stale ctx */
      }
    }),
    config: {
      memory: true,
      noAutoCompact: false,
    },
    compactionStats: null,
  };

  function makeHandlerArgs(overrides: Record<string, unknown> = {}) {
    const base = {
      cwd: testRoot,
      sessionManager: {
        getBranch: vi.fn(() => []),
        getSessionId: vi.fn(() => "test-session"),
      },
      compact: vi.fn(
        (opts: {
          customInstructions?: string;
          onComplete?: () => void;
          onError?: (err: Error) => void;
        }) => {
          compactCalls.push({
            customInstructions: opts.customInstructions ?? "",
            onComplete: opts.onComplete ?? (() => {}),
            onError: opts.onError ?? (() => {}),
          });
        },
      ),
      ui: {
        notify: vi.fn((msg: string, level: string) => {
          notifyCalls.push({ msg, level });
        }),
        custom: vi.fn(),
      },
      ...overrides,
    };
    return base as any;
  }

  return {
    pi,
    runtime,
    handlerMap,
    completionMap,
    makeHandlerArgs,
    compactCalls,
    appendEntryCalls,
    notifyCalls,
  };
}

describe("/blackhole command", () => {
  beforeEach(() => {
    mkdirSync(join(testRoot, "agent", "pi-blackhole"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("registers the blackhole command", () => {
    const { pi, runtime } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);
    expect(pi.registerCommand).toHaveBeenCalledWith(
      "blackhole",
      expect.objectContaining({
        description: expect.stringContaining("Manual compact"),
      }),
    );
  });

  it("surfaces a single 'settings' completion (with 'configure' alias matching)", () => {
    const { pi, runtime, completionMap } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    // Exactly one configuration entry — the settings handle, no separate
    // "configure" entry in the dropdown
    const completions = completionMap.get("blackhole")!("");
    const values = completions.map((c) => c.value);
    expect(values).toContain("settings");
    expect(values).not.toContain("configure");

    // Typing /blackhole config… surfaces the settings entry via its alias
    const configMatches = completionMap.get("blackhole")!("config").map((c) => c.value);
    expect(configMatches).toEqual(["settings"]);
  });

  it("refreshes runtime config after saving settings", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    vi.mocked(openConfigFlow).mockImplementationOnce(async (params: any) => {
      await params.save({ retainedToolOutputMaxTokens: 9_000 }, "global");
    });
    registerPiVccCommand(pi as any, runtime as any);

    await handlerMap.get("blackhole")!("settings", makeHandlerArgs());

    expect(runtime.config.retainedToolOutputMaxTokens).toBe(9_000);
  });

  it("calls ctx.compact with PI_VCC_COMPACT_INSTRUCTION", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    expect(ctx.compact).toHaveBeenCalledTimes(1);
    const call = ctx.compact.mock.calls[0][0];
    expect(call.customInstructions).toBe("__pi_vcc__");
  });

  it("sends onComplete notification with stats when available", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    runtime.compactionStats = { summarized: 42, kept: 10, keptTokensEst: 5000 };
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    const call = ctx.compact.mock.calls[0][0];
    call.onComplete();

    expect(notifyCalls[notifyCalls.length - 1].msg).toContain("compacted 42 conversation entries");
    expect(notifyCalls[notifyCalls.length - 1].msg).toContain("5.0k tokens");
  });

  it("sends onComplete fallback notification without stats", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    const call = ctx.compact.mock.calls[0][0];
    call.onComplete();

    expect(notifyCalls[notifyCalls.length - 1].msg).toContain("blackhole: compacted");
  });

  it("adds no toast when a compaction is cancelled", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    const call = ctx.compact.mock.calls[0][0];
    const before = notifyCalls.length;
    call.onError(new Error("Compaction cancelled"));

    // Our own-cut guard already named the specific reason
    // (before-compact.ts REASON_MESSAGES) before returning { cancel: true }, and
    // Pi renders "Compaction cancelled" itself for manual aborts. A second,
    // vaguer "Nothing to compact" toast on top of that is pure noise.
    expect(notifyCalls.length).toBe(before);
  });

  it("handles onError for general failure", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    const call = ctx.compact.mock.calls[0][0];
    call.onError(new Error("Model API error"));

    expect(notifyCalls[notifyCalls.length - 1].level).toBe("error");
    expect(notifyCalls[notifyCalls.length - 1].msg).toContain(
      "blackhole: compaction failed — Model API error",
    );
  });

  it("/blackhole om-off disables memory and saves config", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);
    runtime.config.memory = true;

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("om-off", ctx);

    expect(runtime.config.memory).toBe(false);
    expect(notifyCalls[0].msg).toContain("Observational memory disabled");
  });

  it("/blackhole om-on enables memory and saves config", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);
    runtime.config.memory = false;

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("om-on", ctx);

    expect(runtime.config.memory).toBe(true);
    expect(notifyCalls[0].msg).toContain("Observational memory enabled");
  });

  it("flush pending entries when noAutoCompact is active and pending data exists", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    runtime.config.compaction = "manual";
    registerPiVccCommand(pi as any, runtime as any);

    // Write a pending state file — name pattern is <sessionId>-pending.json
    const pendingDir = join(testRoot, "agent", "pi-blackhole");
    const pendingFile = join(pendingDir, "test-session-pending.json");
    writeFileSync(
      pendingFile,
      JSON.stringify({
        // isPendingOMState checks for .observation/.reflection with coversUpToId
        observation: {
          coversUpToId: "raw-1",
          data: { observations: [{ id: "aaaaaaaaaaaa", content: "test obs" }] },
        },
        reflection: {
          coversUpToId: "raw-1",
          data: {
            reflections: [
              {
                id: "eeeeeeeeeeee",
                content: "test ref",
                supportingObservationIds: ["aaaaaaaaaaaa"],
              },
            ],
          },
        },
        observationBatches: [
          {
            data: {
              observations: [{ id: "aaaaaaaaaaaa", content: "test obs" }],
              coversUpToId: "raw-1",
            },
          },
        ],
        reflectionBatches: [
          {
            data: {
              reflections: [
                {
                  id: "eeeeeeeeeeee",
                  content: "test ref",
                  supportingObservationIds: ["aaaaaaaaaaaa"],
                },
              ],
              coversUpToId: "raw-1",
            },
          },
        ],
      }),
    );

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    expect(notifyCalls[0].msg).toContain("blackhole: pending memory flushed");
    expect(existsSync(pendingFile)).toBe(false); // cleared after flush
    // Should call compact after flush
    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });
});

// ── Manual-compaction eligibility ───────────────────────────────────────────
//
// Pi's AgentSession.compact() runs prepareCompaction() *before* it emits
// session_before_compact, so an ineligible branch is refused by the host before
// any blackhole hook runs — there is no in-hook way to see or soften it. The
// command has to ask the same question the host will ask, before it calls.

/**
 * Minimal stand-in for the host AgentSession. `installInlineCompactionAdapter`
 * shape-detects `compact()`, and the binding its patched `_bindExtensionCore`
 * installs is what `getCompactionIneligibility` resolves `prepareCompaction`
 * and the effective compaction settings through — an unbound sessionManager
 * simply fails open, so the probe would be untestable. A fresh class per call
 * keeps the module-global registry's per-prototype `installs` from leaking
 * between tests.
 */
function createHostSession(options: {
  /** Omit to model a host that exposes no prepareCompaction (fail-open path). */
  prepareCompaction?: (entries: unknown[], settings: unknown) => unknown;
  branchEntries?: unknown[];
}) {
  const getCompactionSettings = vi.fn((_model?: unknown) => ({
    enabled: true,
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
  }));
  const branchEntries = options.branchEntries ?? [
    { id: "e1", type: "message", message: { role: "user", content: "hi" } },
  ];

  class HostSession {
    sessionManager = {
      getBranch: (): unknown[] => branchEntries,
      getSessionId: (): string => "test-session",
      buildSessionContext: (): { messages: unknown[] } => ({ messages: [] }),
      appendCompaction: (): void => {},
    };
    agent = {
      state: { messages: [] as unknown[] },
      prepareNextTurnWithContext: async (turn: any) => ({ context: turn.context }),
    };
    settingsManager = { getCompactionSettings };
    async abort(): Promise<void> {}
    async compact(): Promise<void> {
      await this.abort();
      this.sessionManager.appendCompaction();
      this.agent.state.messages = [];
    }
    _bindExtensionCore(_runner: unknown): void {}
  }

  installInlineCompactionAdapter({
    sessionClass: HostSession as any,
    hostPrepareCompaction: options.prepareCompaction as any,
  });
  const session = new HostSession();
  session._bindExtensionCore({});

  return { sessionManager: session.sessionManager, getCompactionSettings, branchEntries };
}

function writePendingState(): string {
  const pendingFile = join(testRoot, "agent", "pi-blackhole", "test-session-pending.json");
  writeFileSync(
    pendingFile,
    JSON.stringify({
      observationBatches: [
        {
          data: { observations: [{ id: "aaaaaaaaaaaa", content: "test obs" }] },
          coversUpToId: "raw-1",
        },
      ],
      reflectionBatches: [
        {
          data: {
            reflections: [
              {
                id: "eeeeeeeeeeee",
                content: "test ref",
                supportingObservationIds: ["aaaaaaaaaaaa"],
              },
            ],
          },
          coversUpToId: "raw-1",
        },
      ],
    }),
  );
  return pendingFile;
}

describe("/blackhole manual-compaction eligibility", () => {
  beforeEach(() => {
    mkdirSync(join(testRoot, "agent", "pi-blackhole"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("refuses without compacting when the host reports the branch as too small", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);
    const host = createHostSession({ prepareCompaction: () => undefined });

    const ctx = makeHandlerArgs({ sessionManager: host.sessionManager });
    await handlerMap.get("blackhole")!("", ctx);

    expect(ctx.compact).not.toHaveBeenCalled();
    expect(notifyCalls[notifyCalls.length - 1].msg).toContain("nothing to compact yet");
    expect(notifyCalls[notifyCalls.length - 1].level).toBe("info");
  });

  it("reports an already-compacted branch distinctly from a too-small one", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);
    const host = createHostSession({
      prepareCompaction: () => undefined,
      branchEntries: [{ id: "c1", type: "compaction", summary: "prior" }],
    });

    const ctx = makeHandlerArgs({ sessionManager: host.sessionManager });
    await handlerMap.get("blackhole")!("", ctx);

    expect(ctx.compact).not.toHaveBeenCalled();
    expect(notifyCalls[notifyCalls.length - 1].msg).toContain("already compacted");
  });

  it("does not flush pending observational memory when the branch is ineligible", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls, appendEntryCalls } =
      createMockEnvironment();
    runtime.config.compaction = "manual";
    registerPiVccCommand(pi as any, runtime as any);
    const host = createHostSession({ prepareCompaction: () => undefined });
    const pendingFile = writePendingState();

    const ctx = makeHandlerArgs({ sessionManager: host.sessionManager });
    await handlerMap.get("blackhole")!("", ctx);

    expect(appendEntryCalls).toHaveLength(0);
    expect(existsSync(pendingFile)).toBe(true);
    expect(notifyCalls.some((n) => n.msg.includes("pending entries flushed"))).toBe(false);
  });

  it("compacts when the host reports the branch as eligible", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);
    const host = createHostSession({
      prepareCompaction: () => ({ firstKeptEntryId: "e1" }),
    });

    const ctx = makeHandlerArgs({ sessionManager: host.sessionManager });
    await handlerMap.get("blackhole")!("", ctx);

    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("fails open when the host exposes no prepareCompaction", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);
    const host = createHostSession({});

    const ctx = makeHandlerArgs({ sessionManager: host.sessionManager });
    await handlerMap.get("blackhole")!("", ctx);

    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("resolves the host's compaction settings with the session model", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);
    const host = createHostSession({
      prepareCompaction: () => ({ firstKeptEntryId: "e1" }),
    });
    const model = { provider: "anthropic", id: "claude-sonnet-4" };

    const ctx = makeHandlerArgs({ sessionManager: host.sessionManager, model });
    await handlerMap.get("blackhole")!("", ctx);

    // Pi resolves per-model overrides with getCompactionSettings(model); asking
    // without the model answers a different question than the host will ask.
    expect(host.getCompactionSettings).toHaveBeenCalledWith(model);
  });

  it("loads config before the manual path reads it", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    expect(runtime.ensureConfig).toHaveBeenCalledWith(ctx.cwd, expect.any(Function));
  });

  it("treats a nothing-to-compact refusal as information, not a failure", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    const call = ctx.compact.mock.calls[0][0];
    call.onError(new Error("Nothing to compact (session too small)"));

    const last = notifyCalls[notifyCalls.length - 1];
    expect(last.level).toBe("info");
    expect(last.msg).toContain("nothing to compact");
    expect(last.msg).not.toContain("Compaction failed:");
  });

  it("reports an already-compacted refusal from the host as information", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    const call = ctx.compact.mock.calls[0][0];
    call.onError(new Error("Already compacted"));

    const last = notifyCalls[notifyCalls.length - 1];
    expect(last.level).toBe("info");
    expect(last.msg).toContain("already compacted");
  });
});

// ── Feature 1: Follow-up prompt after compaction ────────────────────────────

describe("/blackhole follow-up prompt", () => {
  beforeEach(() => {
    mkdirSync(join(testRoot, "agent", "pi-blackhole"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("extracts follow-up text from /blackhole <args> and sends it after compaction", async () => {
    const sendUserMessageCalls: Array<{ content: string }> = [];
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    (pi as any).sendUserMessage = vi.fn((content: string) => {
      sendUserMessageCalls.push({ content });
    });
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("fix the auth bug", ctx);

    expect(ctx.compact).toHaveBeenCalledTimes(1);
    const call = ctx.compact.mock.calls[0][0];
    expect(call.customInstructions).toBe("__pi_vcc__");
    // Simulate compaction completion — follow-up should fire
    call.onComplete();
    expect(sendUserMessageCalls).toHaveLength(1);
    expect(sendUserMessageCalls[0].content).toBe("fix the auth bug");
  });

  it("does NOT extract subcommands as follow-up", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("configure", ctx);

    // Should NOT compact — subcommand handled separately
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("treats 'settings' as an alias for 'configure'", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("settings", ctx);

    // Should open the config overlay (like configure), not compact
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("no args → no follow-up prompt sent", async () => {
    const sendUserMessageCalls: Array<{ content: string }> = [];
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    (pi as any).sendUserMessage = vi.fn((content: string) => {
      sendUserMessageCalls.push({ content });
    });
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    expect(ctx.compact).toHaveBeenCalledTimes(1);
    const call = ctx.compact.mock.calls[0][0];
    call.onComplete();
    expect(sendUserMessageCalls).toHaveLength(0);
  });

  it("fires follow-up via sendUserMessage after compaction completes", async () => {
    const sendUserMessageCalls: Array<{ content: string }> = [];
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    (pi as any).sendUserMessage = vi.fn((content: string) => {
      sendUserMessageCalls.push({ content });
    });
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("continue the refactor", ctx);

    const call = ctx.compact.mock.calls[0][0];
    // Simulate compaction completion
    call.onComplete();

    // The follow-up should be sent as a user message
    expect(sendUserMessageCalls).toHaveLength(1);
    expect(sendUserMessageCalls[0].content).toBe("continue the refactor");
  });

  it("does not fire follow-up when compaction fails", async () => {
    const sendUserMessageCalls: Array<{ content: string }> = [];
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    (pi as any).sendUserMessage = vi.fn((content: string) => {
      sendUserMessageCalls.push({ content });
    });
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("continue", ctx);

    const call = ctx.compact.mock.calls[0][0];
    // Simulate compaction failure
    call.onError(new Error("context overflow"));

    expect(sendUserMessageCalls).toHaveLength(0);
  });
});
