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
    const { pi, runtime, handlerMap, makeHandlerArgs } =
      createMockEnvironment();
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

    expect(notifyCalls[notifyCalls.length - 1].msg).toContain("42 source entries");
    expect(notifyCalls[notifyCalls.length - 1].msg).toContain("5.0k tok");
  });

  it("sends onComplete fallback notification without stats", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    const call = ctx.compact.mock.calls[0][0];
    call.onComplete();

    expect(notifyCalls[notifyCalls.length - 1].msg).toContain("Compacted with blackhole");
  });

  it("handles onError for cancellation", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    const call = ctx.compact.mock.calls[0][0];
    call.onError(new Error("Compaction cancelled"));

    expect(notifyCalls[notifyCalls.length - 1].level).toBe("warning");
    expect(notifyCalls[notifyCalls.length - 1].msg).toContain("Nothing to compact");
  });

  it("handles onError for general failure", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    const call = ctx.compact.mock.calls[0][0];
    call.onError(new Error("Model API error"));

    expect(notifyCalls[notifyCalls.length - 1].level).toBe("error");
    expect(notifyCalls[notifyCalls.length - 1].msg).toContain("Compaction failed: Model API error");
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

    expect(notifyCalls[0].msg).toContain("pending entries flushed");
    expect(existsSync(pendingFile)).toBe(false); // cleared after flush
    // Should call compact after flush
    expect(ctx.compact).toHaveBeenCalledTimes(1);
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
