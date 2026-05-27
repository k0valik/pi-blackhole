/**
 * Ported from upstream pi-vcc
 * Changes:
 *   - bun:test → vitest, .js extensions
 *   - Adapted for blackhole's registerBeforeCompactHook which requires omRuntime param
 *   - Added mockRuntime with ensureConfig that reads our config format
 *   - Removed PI_VCC_CONFIG_PATH env var (blackhole uses unified config)
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import { existsSync, unlinkSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerBeforeCompactHook, PI_VCC_COMPACT_INSTRUCTION } from "../src/hooks/before-compact.js";

let tmpDir: string;
let CONFIG_PATH: string;
const DEBUG_PATH = "/tmp/pi-blackhole-debug.json";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-vcc-test-"));
  CONFIG_PATH = join(tmpDir, "blackhole-config.json");
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Minimal ExtensionAPI stub: capture handler + provide ctx with mocked ui.notify
function createMockPi() {
  let handler: ((event: any, ctx: any) => any) | undefined;
  const notifyCalls: Array<{ msg: string; level: string }> = [];
  const config = {
    overrideDefaultCompaction: false,
    noAutoCompact: false,
  };
  const ctx = {
    cwd: tmpDir,
    hasUI: true,
    ui: {
      notify: (msg: string, level: string) => {
        notifyCalls.push({ msg, level });
      },
    },
  };
  const omRuntime = {
    ensureConfig: vi.fn(() => {}),
    config,
  };
  return {
    pi: {
      on: (eventName: string, h: (e: any, c: any) => any) => {
        if (eventName === "session_before_compact") handler = h;
      },
    } as any,
    invoke: (event: any) => handler!(event, ctx),
    notifyCalls,
    omRuntime,
    config,
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

const msg = (id: string, role: "user" | "assistant" | "toolResult", content = "x") => ({
  id,
  type: "message",
  message: { role, content },
});
const comp = (id: string, firstKeptEntryId?: string) => ({ id, type: "compaction", firstKeptEntryId });

describe("registerBeforeCompactHook: cancel paths", () => {
  beforeEach(() => {
    if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  });
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  });

  test("/pi-vcc with too few live messages cancels and notifies warning", () => {
    const { pi, invoke, notifyCalls, omRuntime } = createMockPi();
    omRuntime.config.overrideDefaultCompaction = false;
    registerBeforeCompactHook(pi, omRuntime);

    const entries = [msg("m1", "user"), msg("m2", "assistant")];
    expect(invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))).toEqual({ cancel: true });
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].level).toBe("warning");
    expect(notifyCalls[0].msg).toContain("Too few messages");
  });

  test("/pi-vcc with no user message compacts all instead of cancelling", () => {
    const { pi, invoke, notifyCalls, omRuntime } = createMockPi();
    omRuntime.config.overrideDefaultCompaction = false;
    registerBeforeCompactHook(pi, omRuntime);

    const entries = [msg("m1", "assistant"), msg("m2", "assistant"), msg("m3", "assistant")];
    const result = invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
    // No longer cancels — compacts all to recover from context overflow
    expect(result.cancel).toBeUndefined();
    expect(result.compaction).toBeDefined();
    expect(result.compaction.firstKeptEntryId).toBe("");
  });

  test("/compact with override=true cancels and notifies (NEW: was silent before)", () => {
    const { pi, invoke, notifyCalls, omRuntime } = createMockPi();
    omRuntime.config.overrideDefaultCompaction = true;
    registerBeforeCompactHook(pi, omRuntime);

    const entries = [msg("m1", "user"), msg("m2", "assistant")];
    expect(invoke(makeEvent(entries, undefined))).toEqual({ cancel: true });
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].level).toBe("warning");
  });

  test("/compact with override=false short-circuits (no notify, returns undefined)", () => {
    const { pi, invoke, notifyCalls, omRuntime } = createMockPi();
    omRuntime.config.overrideDefaultCompaction = false;
    registerBeforeCompactHook(pi, omRuntime);

    const entries = [msg("m1", "user"), msg("m2", "assistant")];
    expect(invoke(makeEvent(entries, undefined))).toBeUndefined();
    expect(notifyCalls).toHaveLength(0);
  });

  test("debug:true writes metrics-only snapshot on cancel with no content leakage", () => {
    const { pi, invoke, omRuntime } = createMockPi();
    omRuntime.config.overrideDefaultCompaction = false;
    omRuntime.config.debug = true;
    registerBeforeCompactHook(pi, omRuntime);

    // Use too_few_live_messages cancel path to test content leakage
    const entries = [
      msg("m1", "user", "SECRET_TOKEN_abc123"),
      msg("m2", "assistant", "sensitive response"),
    ];
    expect(invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))).toEqual({ cancel: true });

    expect(existsSync(DEBUG_PATH)).toBe(true);
    const snapshot = JSON.parse(readFileSync(DEBUG_PATH, "utf-8"));
    expect(snapshot.cancelled).toBe(true);
    expect(snapshot.reason).toBe("too_few_live_messages");

    // No content leakage
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("SECRET_TOKEN_abc123");
    expect(serialized).not.toContain("sensitive response");
  });

  test("debug:false does NOT write snapshot", () => {
    const { pi, invoke, omRuntime } = createMockPi();
    omRuntime.config.overrideDefaultCompaction = false;
    registerBeforeCompactHook(pi, omRuntime);
    const entries = [msg("m1", "user"), msg("m2", "assistant")];
    expect(invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))).toEqual({ cancel: true });
    expect(existsSync(DEBUG_PATH)).toBe(false);
  });
});

describe("registerBeforeCompactHook: compact-all path", () => {
  beforeEach(() => {
    if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  });
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  });

  test("single-user + autonomous tail → returns compaction with empty firstKeptEntryId", () => {
    const { pi, invoke, notifyCalls, omRuntime } = createMockPi();
    omRuntime.config.overrideDefaultCompaction = false;
    registerBeforeCompactHook(pi, omRuntime);

    const entries = [
      msg("m1", "user", "go"),
      msg("m2", "assistant", "calling tool"),
      msg("m3", "toolResult", "result"),
      msg("m4", "assistant", "done"),
    ];
    const result = invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
    expect(result.compaction).toBeDefined();
    expect(result.compaction.firstKeptEntryId).toBe("");
    expect(notifyCalls).toHaveLength(0); // no cancel notify on success
  });
});
