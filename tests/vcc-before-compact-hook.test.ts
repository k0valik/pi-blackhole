import { convertToLlm, estimateTokens } from "@earendil-works/pi-coding-agent";
/**
 * Ported from upstream pi-vcc
 * Changes:
 *   - bun:test → vitest, .js extensions
 *   - Adapted for blackhole's registerBeforeCompactHook which requires omRuntime param
 *   - Added mockRuntime with ensureConfig that reads our config format
 *   - Removed PI_VCC_CONFIG_PATH env var (blackhole uses unified config)
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import { existsSync, unlinkSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  registerBeforeCompactHook,
  PI_VCC_COMPACT_INSTRUCTION,
} from "../src/hooks/before-compact.js";

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
function createMockPi(
  initialConfig?: Record<string, unknown>,
  ctxModel?: unknown,
  systemPrompt = "",
) {
  let handler: ((event: any, ctx: any) => any) | undefined;
  const notifyCalls: Array<{ msg: string; level: string }> = [];
  const config = {
    overrideDefaultCompaction: false,
    noAutoCompact: false,
    compaction: "auto",
    compactionEngine: "blackhole",
    tailBehavior: "pi-default",
    ...initialConfig,
  };
  const ctx = {
    cwd: tmpDir,
    hasUI: true,
    model: ctxModel,
    getSystemPrompt: () => systemPrompt,
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
    expect(invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))).toEqual({
      cancel: true,
    });
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].level).toBe("warning");
    expect(notifyCalls[0].msg).toContain("Too few live");
  });

  test("/pi-vcc with no user message compacts all instead of cancelling", () => {
    const { pi, invoke, omRuntime } = createMockPi();
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
    // Use legacy-style config (no new keys) to exercise the legacy guard path
    const { pi, invoke, notifyCalls, omRuntime } = createMockPi({
      compaction: undefined,
      compactionEngine: undefined,
    });
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
    expect(invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))).toEqual({
      cancel: true,
    });

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
    expect(invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))).toEqual({
      cancel: true,
    });
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

// ── Phase 8: New config key guards (before-compact hook) ─────────────────

describe("registerBeforeCompactHook: new config key guards", () => {
  beforeEach(() => {
    if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  });
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  });

  test("T28: compaction:off + /blackhole → proceeds (blackhole pipeline)", () => {
    const { pi, invoke, omRuntime } = createMockPi({ compaction: "off" });
    registerBeforeCompactHook(pi, omRuntime);

    const entries = [
      msg("m1", "user"),
      msg("m2", "assistant"),
      msg("m3", "user"),
      msg("m4", "assistant"),
    ];
    const result = invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));

    // compaction: "off" allows explicit /blackhole through blackhole's pipeline
    expect(result.cancel).toBeUndefined();
    expect(result.compaction).toBeDefined();
  });

  test("T29: compaction:off + auto → returns early, Pi handles", () => {
    const { pi, invoke, omRuntime } = createMockPi({ compaction: "off" });
    registerBeforeCompactHook(pi, omRuntime);

    const entries = [
      msg("m1", "user"),
      msg("m2", "assistant"),
      msg("m3", "user"),
      msg("m4", "assistant"),
    ];
    const result = invoke(makeEvent(entries, undefined));

    expect(result).toBeUndefined();
  });

  test("T30: compaction:manual + /blackhole → proceeds (allows manual)", () => {
    const { pi, invoke, omRuntime } = createMockPi({ compaction: "manual" });
    registerBeforeCompactHook(pi, omRuntime);

    const entries = [
      msg("m1", "user"),
      msg("m2", "assistant"),
      msg("m3", "user"),
      msg("m4", "assistant"),
    ];
    const result = invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));

    // Should proceed to buildOwnCut with enough messages
    expect(result.cancel).toBeUndefined();
    expect(result.compaction).toBeDefined();
  });

  test("T31: compaction:manual + auto → return (let Pi handle)", () => {
    const { pi, invoke, omRuntime } = createMockPi({ compaction: "manual" });
    registerBeforeCompactHook(pi, omRuntime);

    const entries = [
      msg("m1", "user"),
      msg("m2", "assistant"),
      msg("m3", "user"),
      msg("m4", "assistant"),
    ];
    const result = invoke(makeEvent(entries, undefined));

    expect(result).toBeUndefined();
  });

  test("T32: compaction:auto + /blackhole → proceeds", () => {
    const { pi, invoke, omRuntime } = createMockPi({ compaction: "auto" });
    registerBeforeCompactHook(pi, omRuntime);

    const entries = [
      msg("m1", "user"),
      msg("m2", "assistant"),
      msg("m3", "user"),
      msg("m4", "assistant"),
    ];
    const result = invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));

    expect(result.cancel).toBeUndefined();
    expect(result.compaction).toBeDefined();
  });

  test("T33: compaction:auto + auto → proceeds", () => {
    const { pi, invoke, omRuntime } = createMockPi({ compaction: "auto" });
    registerBeforeCompactHook(pi, omRuntime);

    const entries = [
      msg("m1", "user"),
      msg("m2", "assistant"),
      msg("m3", "user"),
      msg("m4", "assistant"),
    ];
    const result = invoke(makeEvent(entries, undefined));

    expect(result.cancel).toBeUndefined();
    expect(result.compaction).toBeDefined();
  });

  test("T34: compactionEngine:pi-default + auto → return (let Pi handle)", () => {
    const { pi, invoke, omRuntime } = createMockPi({
      compactionEngine: "pi-default",
    });
    registerBeforeCompactHook(pi, omRuntime);

    const entries = [
      msg("m1", "user"),
      msg("m2", "assistant"),
      msg("m3", "user"),
      msg("m4", "assistant"),
    ];
    const result = invoke(makeEvent(entries, undefined));

    expect(result).toBeUndefined();
  });

  test("T35: compactionEngine:pi-default + /blackhole → proceeds (/blackhole always uses blackhole)", () => {
    const { pi, invoke, omRuntime } = createMockPi({
      compactionEngine: "pi-default",
    });
    registerBeforeCompactHook(pi, omRuntime);

    const entries = [
      msg("m1", "user"),
      msg("m2", "assistant"),
      msg("m3", "user"),
      msg("m4", "assistant"),
    ];
    const result = invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));

    expect(result.cancel).toBeUndefined();
    expect(result.compaction).toBeDefined();
  });
});

// ── Bug A: CompactionStats fully populated from buildOwnCut return data ──────

describe("registerBeforeCompactHook: CompactionStats population", () => {
  beforeEach(() => {
    if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  });
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  });

  test("populates every CompactionStats field on successful compaction", () => {
    const { pi, invoke, omRuntime } = createMockPi();
    omRuntime.config.overrideDefaultCompaction = false;
    registerBeforeCompactHook(pi, omRuntime);

    // 4 user + 4 assistant = 8 messages, normal cut at last user
    const entries = [
      msg("m1", "user"),
      msg("m2", "assistant"),
      msg("m3", "user"),
      msg("m4", "assistant"),
      msg("m5", "user"),
      msg("m6", "assistant"),
      msg("m7", "user"),
      msg("m8", "assistant"),
    ];
    invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));

    const stats = omRuntime.compactionStats;
    expect(stats).not.toBeNull();
    expect(stats!.summarized).toBe(6); // m1-m6 summarized
    expect(stats!.kept).toBe(2); // m7, m8 kept
    expect(stats!.keptTokensEst).toBeGreaterThan(0);
    expect(stats!.totalUserTurns).toBe(4); // m1, m3, m5, m7
    expect(stats!.keptUserTurns).toBe(1); // m7 only
    expect(stats!.requestedKeepUserTurns).toBe(1); // default
    expect(stats!.keepUserTurnsExplicit).toBe(false); // no keep:N
    expect(stats!.keepFallbackToCompactAll).toBe(false); // normal cut
    expect(stats!.smartKeepAdjusted).toBe(false); // not implemented yet
    expect(stats!.smartFromKeep).toBe(1); // default
  });

  test("keepFallbackToCompactAll is true when compactAll", () => {
    const { pi, invoke, omRuntime } = createMockPi();
    omRuntime.config.overrideDefaultCompaction = false;
    registerBeforeCompactHook(pi, omRuntime);

    // Single user + autonomous tail → compactAll
    const entries = [
      msg("m1", "user", "go"),
      msg("m2", "assistant"),
      msg("m3", "toolResult"),
      msg("m4", "assistant"),
    ];
    invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));

    const stats = omRuntime.compactionStats;
    expect(stats).not.toBeNull();
    expect(stats!.keepFallbackToCompactAll).toBe(true);
    expect(stats!.compactAll).toBe(true);
  });

  test("totalUserTurns counts all user messages in branch", () => {
    const { pi, invoke, omRuntime } = createMockPi();
    omRuntime.config.overrideDefaultCompaction = false;
    registerBeforeCompactHook(pi, omRuntime);

    const entries = [
      msg("m1", "user"),
      msg("m2", "assistant"),
      msg("m3", "user"),
      msg("m4", "assistant"),
      msg("m5", "user"),
    ];
    invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));

    expect(omRuntime.compactionStats!.totalUserTurns).toBe(3);
  });

  test("keptUserTurns counts user messages after the cut", () => {
    const { pi, invoke, omRuntime } = createMockPi();
    omRuntime.config.overrideDefaultCompaction = false;
    registerBeforeCompactHook(pi, omRuntime);

    // 3 users, cut at last user (m5), so m5 is kept, m1+m3 summarized
    const entries = [
      msg("m1", "user"),
      msg("m2", "assistant"),
      msg("m3", "user"),
      msg("m4", "assistant"),
      msg("m5", "user"),
      msg("m6", "assistant"),
    ];
    invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));

    expect(omRuntime.compactionStats!.keptUserTurns).toBe(1); // only m5
  });

  test("keptUserTurns is 0 for compactAll (firstKeptEntryId sentinel)", () => {
    const { pi, invoke, omRuntime } = createMockPi();
    omRuntime.config.overrideDefaultCompaction = false;
    registerBeforeCompactHook(pi, omRuntime);

    const entries = [
      msg("m1", "user", "go"),
      msg("m2", "assistant"),
      msg("m3", "toolResult"),
      msg("m4", "assistant"),
    ];
    invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));

    // compactAll: everything summarized, nothing kept
    expect(omRuntime.compactionStats!.compactAll).toBe(true);
    expect(omRuntime.compactionStats!.keptUserTurns).toBe(0);
  });
});

describe("registerBeforeCompactHook: provider-aware skip", () => {
  const codexModel = {
    provider: "openai-codex",
    api: "openai-codex-responses",
    id: "gpt-5.5",
  };

  test("listed provider (Codex) → hook steps aside entirely (returns undefined)", () => {
    const { pi, invoke, omRuntime } = createMockPi(
      { skipForProviders: ["openai-codex"] },
      codexModel,
    );
    registerBeforeCompactHook(pi, omRuntime);
    const entries = [
      msg("m1", "user", "hello"),
      msg("m2", "assistant", "hi"),
      msg("m3", "user", "more"),
      msg("m4", "assistant", "reply"),
    ];
    // Even with plenty of live messages (which would normally compact), the
    // Codex provider must be left to pi-codex-compaction.
    expect(invoke(makeEvent(entries))).toBeUndefined();
  });

  test("listed provider:api (Codex responses) → steps aside", () => {
    const { pi, invoke, omRuntime } = createMockPi(
      { skipForProviders: ["openai-codex:openai-codex-responses"] },
      codexModel,
    );
    registerBeforeCompactHook(pi, omRuntime);
    expect(
      invoke(
        makeEvent([
          msg("m1", "user"),
          msg("m2", "assistant"),
          msg("m3", "user"),
          msg("m4", "assistant"),
        ]),
      ),
    ).toBeUndefined();
  });

  test("explicit /blackhole on a listed provider → still steps aside", () => {
    const { pi, invoke, omRuntime } = createMockPi(
      { skipForProviders: ["openai-codex"] },
      codexModel,
    );
    registerBeforeCompactHook(pi, omRuntime);
    expect(
      invoke(
        makeEvent(
          [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user"), msg("m4", "assistant")],
          PI_VCC_COMPACT_INSTRUCTION,
        ),
      ),
    ).toBeUndefined();
  });

  test("non-listed provider (non-Codex) → normal blackhole compaction", () => {
    const { pi, invoke, omRuntime } = createMockPi(
      { skipForProviders: ["openai-codex"] },
      { provider: "anthropic", api: "completions", id: "claude" },
    );
    registerBeforeCompactHook(pi, omRuntime);
    const result = invoke(
      makeEvent([
        msg("m1", "user", "a"),
        msg("m2", "assistant", "b"),
        msg("m3", "user", "c"),
        msg("m4", "assistant", "d"),
      ]),
    );
    expect(result.cancel).toBeUndefined();
    expect(result.compaction).toBeDefined();
    expect(typeof result.compaction.summary).toBe("string");
    expect(result.compaction.summary.length).toBeGreaterThan(0);
  });

  test("no skip list → Codex provider still compacts (existing behavior preserved)", () => {
    const { pi, invoke, omRuntime } = createMockPi({}, codexModel);
    registerBeforeCompactHook(pi, omRuntime);
    const result = invoke(
      makeEvent([
        msg("m1", "user", "a"),
        msg("m2", "assistant", "b"),
        msg("m3", "user", "c"),
        msg("m4", "assistant", "d"),
      ]),
    );
    expect(result.compaction).toBeDefined();
  });
});

describe("unobserved safe deferral", () => {
  test("oversized original tail cancels instead of delegating or dropping", () => {
    const { pi, invoke, omRuntime, notifyCalls } = createMockPi(
      { tailBehavior: "unobserved" },
      { contextWindow: 100, provider: "test", id: "test" },
    );
    registerBeforeCompactHook(pi, omRuntime);
    expect(
      invoke(
        makeEvent(
          [msg("m1", "user", "x".repeat(10000)), msg("m2", "assistant"), msg("m3", "user")],
          PI_VCC_COMPACT_INSTRUCTION,
        ),
      ),
    ).toEqual({ cancel: true });
    expect(notifyCalls.some((call) => call.msg.includes("unobserved"))).toBe(true);
  });
  test("no coverage and no summary cancels rather than native fallback", () => {
    const { pi, invoke, omRuntime } = createMockPi({ tailBehavior: "unobserved" });
    registerBeforeCompactHook(pi, omRuntime);
    expect(
      invoke(
        makeEvent(
          [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user")],
          PI_VCC_COMPACT_INSTRUCTION,
        ),
      ),
    ).toEqual({ cancel: true });
  });
});

test("unobserved successful compaction preserves raw tool output and continuity intent", () => {
  const { pi, invoke, omRuntime } = createMockPi(
    { tailBehavior: "unobserved", retainedToolOutputMaxTokens: 1 },
    { contextWindow: 100000, provider: "test", id: "test" },
  );
  registerBeforeCompactHook(pi, omRuntime);
  const entries = [
    msg("m1", "user", "Build a feature"),
    msg("m2", "assistant", "Old response"),
    msg("m3", "user", "Pending task"),
    msg("m4", "toolResult", "raw output"),
    {
      id: "om1",
      type: "custom",
      customType: "om.observations.recorded",
      data: {
        coversUpToId: "m2",
        observations: [
          {
            id: "aaaaaaaaaaaa",
            content: "Completed old task",
            timestamp: "2026-01-01T00:00:00Z",
            relevance: "high",
            tokenCount: 5,
            sourceEntryIds: ["m1", "m2"],
          },
        ],
      },
    },
  ];
  const result = invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
  expect(result.compaction.firstKeptEntryId).toBe("m3");
  expect(result.compaction.details["om.preserveSourceHistory"]).toBe(true);
  expect(result.compaction.details.retainedToolOutputProjection).toBeUndefined();
});

test("unobserved budget includes retained custom source entries", () => {
  const { pi, invoke, omRuntime } = createMockPi(
    { tailBehavior: "unobserved" },
    { contextWindow: 2000, provider: "test", id: "test" },
  );
  registerBeforeCompactHook(pi, omRuntime);
  const entries = [
    msg("m1", "user", "Build feature"),
    msg("m2", "assistant", "done"),
    { id: "pending", type: "custom_message", customType: "test", content: "p".repeat(20000) },
    msg("m3", "user", "next"),
    {
      id: "om1",
      type: "custom",
      customType: "om.observations.recorded",
      data: {
        coversUpToId: "m2",
        observations: [
          {
            id: "aaaaaaaaaaaa",
            content: "Done",
            timestamp: "2026-01-01T00:00:00Z",
            relevance: "high",
            tokenCount: 5,
            sourceEntryIds: ["m1", "m2"],
          },
        ],
      },
    },
  ];
  expect(invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))).toEqual({ cancel: true });
});

test("unobserved unknown model capacity defers rather than assuming a window", () => {
  const { pi, invoke, omRuntime } = createMockPi(
    { tailBehavior: "unobserved" },
    { provider: "test", id: "test" },
  );
  registerBeforeCompactHook(pi, omRuntime);
  const event = makeEvent(
    [
      msg("m1", "user", "Build feature"),
      msg("m2", "assistant", "done"),
      msg("m3", "user", "next"),
      {
        id: "om1",
        type: "custom",
        customType: "om.observations.recorded",
        data: {
          coversUpToId: "m2",
          observations: [
            {
              id: "aaaaaaaaaaaa",
              content: "Done",
              timestamp: "2026-01-01T00:00:00Z",
              relevance: "high",
              tokenCount: 5,
              sourceEntryIds: ["m1", "m2"],
            },
          ],
        },
      },
    ],
    PI_VCC_COMPACT_INSTRUCTION,
  );
  expect(invoke(event)).toEqual({ cancel: true });
});
test("completed OM batch survives a tool-safe cut inside its coverage", () => {
  const { pi, invoke, omRuntime } = createMockPi(
    { tailBehavior: "unobserved" },
    { provider: "test", id: "test", contextWindow: 10000 },
  );
  registerBeforeCompactHook(pi, omRuntime);
  const entries = [
    msg("m1", "user", "old task"),
    msg("m2", "assistant", "old response"),
    msg("m3", "user", "new task"),
    {
      ...msg("m4", "assistant"),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t", name: "read", arguments: {} }],
      },
    },
    {
      ...msg("m5", "toolResult"),
      message: {
        role: "toolResult",
        toolCallId: "t",
        toolName: "read",
        content: [{ type: "text", text: "pending" }],
      },
    },
    {
      id: "om1",
      type: "custom",
      customType: "om.observations.recorded",
      data: {
        coversUpToId: "m4",
        observations: [
          {
            id: "aaaaaaaaaaaa",
            content: "UNIQUE-OLDER-COMPLETED-FACT",
            timestamp: "2026-01-01T00:00:00Z",
            relevance: "high",
            tokenCount: 5,
            sourceEntryIds: ["m1", "m2"],
          },
        ],
      },
    },
  ];
  const result = invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
  expect(result.compaction.firstKeptEntryId).toBe("m3");
  expect(result.compaction.details["om.folded"].observations.map((item) => item.id)).toEqual([
    "aaaaaaaaaaaa",
  ]);
});

test("capacity includes the current system prompt", () => {
  const { pi, invoke, omRuntime } = createMockPi(
    { tailBehavior: "unobserved" },
    { provider: "test", id: "test", contextWindow: 2000 },
    "system ".repeat(2000),
  );
  registerBeforeCompactHook(pi, omRuntime);
  const event = makeEvent(
    [
      msg("m1", "user", "Build feature"),
      msg("m2", "assistant", "done"),
      msg("m3", "user", "next"),
      {
        id: "om1",
        type: "custom",
        customType: "om.observations.recorded",
        data: {
          coversUpToId: "m2",
          observations: [
            {
              id: "aaaaaaaaaaaa",
              content: "Done",
              timestamp: "2026-01-01T00:00:00Z",
              relevance: "high",
              tokenCount: 5,
              sourceEntryIds: ["m1", "m2"],
            },
          ],
        },
      },
    ],
    PI_VCC_COMPACT_INSTRUCTION,
  );
  event.preparation.settings = { reserveTokens: 100, keepRecentTokens: 100 };
  expect(invoke(event)).toEqual({ cancel: true });
});

test("unobserved capacity includes the real host summary wrapper", () => {
  const entries = [
    msg("m1", "user", "Build feature"),
    msg("m2", "assistant", "done"),
    msg("m3", "user", "next"),
    {
      id: "om1",
      type: "custom",
      customType: "om.observations.recorded",
      data: {
        coversUpToId: "m2",
        observations: [
          {
            id: "aaaaaaaaaaaa",
            content: "Done",
            timestamp: "2026-01-01T00:00:00Z",
            relevance: "high",
            tokenCount: 5,
            sourceEntryIds: ["m1", "m2"],
          },
        ],
      },
    },
  ];
  const run = (window: number) => {
    const { pi, invoke, omRuntime } = createMockPi(
      { tailBehavior: "unobserved" },
      { provider: "test", id: "test", contextWindow: window },
    );
    registerBeforeCompactHook(pi, omRuntime);
    return invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
  };
  const summary = run(10000).compaction.summary;
  const wrapped = convertToLlm([
    { role: "compactionSummary", summary, tokensBefore: 1000, timestamp: 0 },
  ]).reduce((total, message) => total + estimateTokens(message), 0);
  expect(run(wrapped)).toEqual({ cancel: true });
});
