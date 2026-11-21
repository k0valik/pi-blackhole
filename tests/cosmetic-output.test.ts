/**
 * Tests for the cosmetic pre-compaction output hook
 * (src/hooks/cosmetic-output.ts).
 *
 * Contract under test: the copy is display-only (plain `custom` entry, never
 * context), bounded, idempotent per compaction, branch-scoped, and opt-out via
 * `showPreCompactionMessage: false`.
 */
import { describe, expect, it, vi } from "vitest";
import {
  initTheme,
  sessionEntryToContextMessages,
  SessionManager,
  type CompactionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  PRE_COMPACTION_MAX_BYTES,
  PRE_COMPACTION_OUTPUT_TYPE,
  assistantText,
  buildPreCompactionOutputData,
  hasPreCompactionOutput,
  isPreCompactionOutputData,
  registerPreCompactionOutput,
  selectOmittedAssistantText,
  truncateToBytes,
} from "../src/hooks/cosmetic-output.js";
import { DEFAULTS } from "../src/core/unified-config.js";
import { estimateEntryTokens } from "../src/om/tokens.js";
import { serializeBranchEntries } from "../src/om/serialize.js";
import { isSourceEntry, rawTokensSinceLastCompaction } from "../src/om/ledger/progress.js";
import { buildOwnCut } from "../src/hooks/before-compact.js";
import { DECLARATIVE_ENV_OVERRIDES } from "../src/core/config-env.js";

vi.mock("../src/om/debug-log.js", () => ({ debugLog: vi.fn() }));

initTheme("dark");

type Entry = Record<string, unknown>;

function userMessage(id: string, text: string): Entry {
  return { type: "message", id, message: { role: "user", content: text } };
}

function assistantMessage(id: string, blocks: unknown[], stopReason: string = "stop"): Entry {
  return { type: "message", id, message: { role: "assistant", content: blocks, stopReason } };
}

function textBlock(text: string): unknown {
  return { type: "text", text };
}

function compactionEntry(id: string): Entry {
  return {
    type: "compaction",
    id,
    summary: "summary",
    firstKeptEntryId: "u2",
    tokensBefore: 100,
    details: { compactor: "blackhole", version: 1 },
  };
}

// ── assistantText ────────────────────────────────────────────────────────────

describe("assistantText", () => {
  it("returns string content unchanged", () => {
    expect(assistantText({ role: "assistant", content: "hello" })).toBe("hello");
  });

  it("joins text blocks and ignores thinking and tool blocks", () => {
    const text = assistantText({
      role: "assistant",
      content: [
        textBlock("one"),
        { type: "thinking", thinking: "hidden" },
        textBlock("two"),
        { type: "toolCall", name: "bash" },
      ],
    });
    expect(text).toBe("one\n\ntwo");
  });

  it("returns undefined for whitespace-only text", () => {
    expect(assistantText({ role: "assistant", content: "   \n " })).toBeUndefined();
  });

  it("returns undefined when no text block has content", () => {
    expect(
      assistantText({ role: "assistant", content: [{ type: "thinking", thinking: "x" }] }),
    ).toBeUndefined();
  });

  it("returns undefined for non-object input", () => {
    expect(assistantText("not a message")).toBeUndefined();
  });
});

// ── truncateToBytes ──────────────────────────────────────────────────────────

describe("truncateToBytes", () => {
  it("keeps text under the cap unchanged", () => {
    expect(truncateToBytes("short", 64)).toEqual({ text: "short", truncated: false });
  });

  it("keeps text exactly at the cap unchanged", () => {
    expect(truncateToBytes("abcd", 4)).toEqual({ text: "abcd", truncated: false });
  });

  it("truncates text over the cap within budget", () => {
    const result = truncateToBytes("abcdef", 4);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(4);
  });

  it("does not split a multi-byte code point", () => {
    const result = truncateToBytes("😀😀😀", 6);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("😀");
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(6);
  });
});

// ── selection ────────────────────────────────────────────────────────────────

describe("selectOmittedAssistantText", () => {
  const branch: Entry[] = [
    userMessage("u1", "first question"),
    assistantMessage("a1", [textBlock("older answer")]),
    userMessage("u2", "second question"),
    assistantMessage("a2", [textBlock("newest answer")]),
    compactionEntry("c1"),
  ];

  it("does not copy an older answer when the newest answer is retained", () => {
    const retained = new Set(["c1", "a2", "u2"]);
    expect(
      selectOmittedAssistantText({ branch, retainedIds: retained, compactionEntryId: "c1" }),
    ).toBeUndefined();
  });

  it("returns the last response when nothing is retained", () => {
    expect(
      selectOmittedAssistantText({
        branch,
        retainedIds: new Set(["c1"]),
        compactionEntryId: "c1",
      }),
    ).toEqual({ entryId: "a2", text: "newest answer" });
  });

  it("returns nothing when all answers are retained", () => {
    const retained = new Set(["c1", "a2", "u2", "a1", "u1"]);
    expect(
      selectOmittedAssistantText({ branch, retainedIds: retained, compactionEntryId: "c1" }),
    ).toBeUndefined();
  });

  it("skips aborted assistant messages", () => {
    const aborted: Entry[] = [
      assistantMessage("a1", [textBlock("complete output")]),
      assistantMessage("a2", [textBlock("partial output")], "aborted"),
      compactionEntry("c1"),
    ];
    expect(
      selectOmittedAssistantText({
        branch: aborted,
        retainedIds: new Set(["c1"]),
        compactionEntryId: "c1",
      }),
    ).toEqual({ entryId: "a1", text: "complete output" });
  });

  it("does not fall back when the latest eligible answer is retained behind an aborted tail", () => {
    const withAbortedTail: Entry[] = [
      assistantMessage("a1", [textBlock("omitted answer")]),
      assistantMessage("a2", [textBlock("retained answer")]),
      assistantMessage("a3", [textBlock("partial output")], "aborted"),
      compactionEntry("c1"),
    ];
    expect(
      selectOmittedAssistantText({
        branch: withAbortedTail,
        retainedIds: new Set(["c1", "a2", "a3"]),
        compactionEntryId: "c1",
      }),
    ).toBeUndefined();
  });

  it("skips non-assistant and text-less entries", () => {
    const mixed: Entry[] = [
      assistantMessage("a1", [textBlock("real output")]),
      assistantMessage("a2", [{ type: "toolCall", name: "bash" }]),
      { type: "custom", id: "x1", customType: "other", data: {} },
      compactionEntry("c1"),
    ];
    expect(
      selectOmittedAssistantText({
        branch: mixed,
        retainedIds: new Set(["c1"]),
        compactionEntryId: "c1",
      }),
    ).toEqual({ entryId: "a1", text: "real output" });
  });

  it("skips message entries whose message is not an object", () => {
    const malformed: Entry[] = [
      assistantMessage("a1", [textBlock("real output")]),
      { type: "message", id: "bad", message: null },
      compactionEntry("c1"),
    ];
    expect(
      selectOmittedAssistantText({
        branch: malformed,
        retainedIds: new Set(["c1"]),
        compactionEntryId: "c1",
      }),
    ).toEqual({ entryId: "a1", text: "real output" });
  });

  it("returns undefined when the compaction entry is absent from the branch", () => {
    expect(
      selectOmittedAssistantText({
        branch: [userMessage("u1", "q")],
        retainedIds: new Set(),
        compactionEntryId: "missing",
      }),
    ).toBeUndefined();
  });
});

// ── payload ──────────────────────────────────────────────────────────────────

describe("buildPreCompactionOutputData", () => {
  it("records source and compaction ids with the copied text", () => {
    const branch: Entry[] = [
      assistantMessage("a2", [textBlock("dropped answer")]),
      compactionEntry("c1"),
    ];
    expect(
      buildPreCompactionOutputData({
        branch,
        retainedIds: new Set(["c1"]),
        compactionEntry: { id: "c1" },
      }),
    ).toEqual({
      text: "dropped answer",
      sourceEntryId: "a2",
      compactionEntryId: "c1",
      truncated: false,
    });
  });

  it("marks the copy truncated when the source exceeds the byte cap", () => {
    const branch: Entry[] = [
      assistantMessage("a2", [textBlock("x".repeat(PRE_COMPACTION_MAX_BYTES + 1))]),
      compactionEntry("c1"),
    ];
    const data = buildPreCompactionOutputData({
      branch,
      retainedIds: new Set(["c1"]),
      compactionEntry: { id: "c1" },
    });
    expect(data?.truncated).toBe(true);
    expect(Buffer.byteLength(data?.text ?? "", "utf8")).toBeLessThanOrEqual(
      PRE_COMPACTION_MAX_BYTES,
    );
  });

  it("stores no terminal escape sequences from the source text", () => {
    const branch: Entry[] = [
      assistantMessage("a2", [textBlock("before\u001b[31mred\u001b[0m after")]),
      compactionEntry("c1"),
    ];
    const data = buildPreCompactionOutputData({
      branch,
      retainedIds: new Set(["c1"]),
      compactionEntry: { id: "c1" },
    });
    expect(data?.text).toBe("beforered after");
    expect(data?.text).not.toContain("\u001b");
  });

  it("returns undefined when no assistant text was dropped", () => {
    const branch: Entry[] = [assistantMessage("a2", [textBlock("kept")]), compactionEntry("c1")];
    expect(
      buildPreCompactionOutputData({
        branch,
        retainedIds: new Set(["c1", "a2"]),
        compactionEntry: { id: "c1" },
      }),
    ).toBeUndefined();
  });
});

describe("hasPreCompactionOutput", () => {
  const data = {
    text: "copied",
    sourceEntryId: "a1",
    compactionEntryId: "c1",
    truncated: false,
  };

  it("is true only for the matching compaction id", () => {
    const branch: Entry[] = [
      { type: "custom", id: "x1", customType: PRE_COMPACTION_OUTPUT_TYPE, data },
    ];
    expect(hasPreCompactionOutput(branch, "c1")).toBe(true);
    expect(hasPreCompactionOutput(branch, "c2")).toBe(false);
  });

  it("ignores other custom types", () => {
    const branch: Entry[] = [{ type: "custom", id: "x1", customType: "something-else", data }];
    expect(hasPreCompactionOutput(branch, "c1")).toBe(false);
  });

  it("ignores entries whose data fails validation", () => {
    const branch: Entry[] = [
      { type: "custom", id: "x1", customType: PRE_COMPACTION_OUTPUT_TYPE, data: { text: "" } },
    ];
    expect(hasPreCompactionOutput(branch, "c1")).toBe(false);
  });
});

describe("isPreCompactionOutputData", () => {
  it("accepts a complete payload", () => {
    expect(
      isPreCompactionOutputData({
        text: "t",
        sourceEntryId: "a",
        compactionEntryId: "c",
        truncated: false,
      }),
    ).toBe(true);
  });

  it("rejects a payload with empty text", () => {
    expect(
      isPreCompactionOutputData({
        text: "  ",
        sourceEntryId: "a",
        compactionEntryId: "c",
        truncated: false,
      }),
    ).toBe(false);
  });
});

// ── handler registration ─────────────────────────────────────────────────────

interface HarnessOptions {
  showPreCompactionMessage?: boolean;
  fromExtension?: boolean;
  details?: unknown;
  branch?: Entry[];
  contextEntries?: Entry[];
  sessionManager?: SessionManager;
  compaction?: CompactionEntry;
}

function makeHarness(options: HarnessOptions = {}) {
  let handler: ((event: unknown, ctx: unknown) => void) | undefined;
  let renderer: ((entry: unknown, opts: unknown, theme: unknown) => unknown) | undefined;
  const appendEntry = vi.fn((customType: string, data: unknown) =>
    options.sessionManager?.appendCustomEntry(customType, data),
  );
  const pi = {
    on: vi.fn((name: string, cb: any) => {
      if (name === "session_compact") handler = cb;
    }),
    registerEntryRenderer: vi.fn((_type: string, cb: any) => {
      renderer = cb;
    }),
    appendEntry,
  };
  const runtime = {
    ensureConfig: vi.fn(),
    config: {
      showPreCompactionMessage: options.showPreCompactionMessage ?? true,
      debugLog: false,
    },
  };

  const branch = options.branch ?? [
    userMessage("u1", "question"),
    assistantMessage("a2", [textBlock("dropped answer")]),
    compactionEntry("c1"),
  ];
  const contextEntries = options.contextEntries ?? branch.filter((entry) => entry.id === "c1");
  const ctx = {
    cwd: "/tmp/project",
    sessionManager: options.sessionManager ?? {
      getBranch: () => branch,
      buildContextEntries: () => contextEntries,
    },
  };

  registerPreCompactionOutput(pi as any, runtime as any);

  return {
    appendEntry,
    invoke: (overrides: Partial<HarnessOptions> = {}) =>
      handler?.(
        {
          type: "session_compact",
          compactionEntry: options.compaction ?? {
            id: "c1",
            details: options.details ?? { compactor: "blackhole", version: 1 },
          },
          fromExtension: overrides.fromExtension ?? options.fromExtension ?? true,
          reason: "manual",
          willRetry: false,
        },
        ctx,
      ),
    getRenderer: () => renderer,
  };
}

describe("registerPreCompactionOutput", () => {
  it("registers exactly one entry renderer and one session_compact handler", () => {
    const harness = makeHarness();
    expect(harness.getRenderer()).toBeTypeOf("function");
    harness.invoke();
    expect(harness.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("appends nothing when showPreCompactionMessage is false", () => {
    const harness = makeHarness({ showPreCompactionMessage: false });
    harness.invoke();
    expect(harness.appendEntry).not.toHaveBeenCalled();
  });

  it("appends nothing for non-extension compactions", () => {
    const harness = makeHarness({ fromExtension: false });
    harness.invoke({ fromExtension: false });
    expect(harness.appendEntry).not.toHaveBeenCalled();
  });

  it("appends nothing when the compaction details are not Blackhole's", () => {
    const harness = makeHarness({ details: { compactor: "pi" } });
    harness.invoke();
    expect(harness.appendEntry).not.toHaveBeenCalled();
  });

  it("appends nothing when the dropped text is empty", () => {
    const harness = makeHarness({
      branch: [userMessage("u1", "question"), compactionEntry("c1")],
    });
    harness.invoke();
    expect(harness.appendEntry).not.toHaveBeenCalled();
  });

  it("appends a display copy of the newest dropped assistant text", () => {
    const harness = makeHarness();
    harness.invoke();
    expect(harness.appendEntry).toHaveBeenCalledWith(PRE_COMPACTION_OUTPUT_TYPE, {
      text: "dropped answer",
      sourceEntryId: "a2",
      compactionEntryId: "c1",
      truncated: false,
    });
  });

  it("appends nothing when this compaction already has a copy", () => {
    const data = {
      text: "dropped answer",
      sourceEntryId: "a2",
      compactionEntryId: "c1",
      truncated: false,
    };
    const harness = makeHarness({
      branch: [
        assistantMessage("a2", [textBlock("dropped answer")]),
        compactionEntry("c1"),
        { type: "custom", id: "x1", customType: PRE_COMPACTION_OUTPUT_TYPE, data },
      ],
    });
    harness.invoke();
    expect(harness.appendEntry).not.toHaveBeenCalled();
  });

  it("never throws when appending fails", () => {
    const harness = makeHarness();
    harness.appendEntry.mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => harness.invoke()).not.toThrow();
  });
});

// ── native Pi session contract ───────────────────────────────────────────────

function appendNativeAssistant(
  sessionManager: SessionManager,
  text: string,
  stopReason: "stop" | "aborted" = "stop",
): string {
  return sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  });
}

function appendNativeToolResult(sessionManager: SessionManager, toolCallId: string): string {
  return sessionManager.appendMessage({
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp: 0,
  });
}

function appendNativeCompaction(
  sessionManager: SessionManager,
  firstKeptEntryId: string | null = null,
): CompactionEntry {
  const id = sessionManager.appendCompaction(
    "summary",
    firstKeptEntryId,
    100,
    { compactor: "blackhole", version: 1 },
    true,
  );
  const entry = sessionManager.getEntry(id);
  if (entry?.type !== "compaction") throw new Error("Expected native compaction entry");
  return entry;
}

function nativeOutputCopies(sessionManager: SessionManager): unknown[] {
  return sessionManager
    .getBranch()
    .flatMap((entry) =>
      entry.type === "custom" && entry.customType === PRE_COMPACTION_OUTPUT_TYPE
        ? [entry.data]
        : [],
    );
}

function makeNativeScanSession(distance: number) {
  const sessionManager = SessionManager.inMemory();
  const sourceEntryId = appendNativeAssistant(sessionManager, "scan boundary answer");
  for (let i = 1; i < distance; i++) {
    sessionManager.appendCustomEntry("scan-padding", {});
  }
  const compaction = appendNativeCompaction(sessionManager);
  return { sessionManager, sourceEntryId, compaction };
}

describe("session_compact with native Pi SessionManager", () => {
  it("restores the newest omitted assistant output from the real session path", () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: "question", timestamp: 0 });
    appendNativeAssistant(sessionManager, "older answer");
    const sourceEntryId = appendNativeAssistant(sessionManager, "Approve the latest plan?");
    const compaction = appendNativeCompaction(sessionManager);
    const harness = makeHarness({ sessionManager, compaction });

    harness.invoke();

    expect(nativeOutputCopies(sessionManager)).toEqual([
      {
        text: "Approve the latest plan?",
        sourceEntryId,
        compactionEntryId: compaction.id,
        truncated: false,
      },
    ]);
  });

  it("does not append an older answer when the latest answer is retained", () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: "first question", timestamp: 0 });
    appendNativeAssistant(sessionManager, "omitted answer");
    const firstKeptEntryId = sessionManager.appendMessage({
      role: "user",
      content: "second question",
      timestamp: 0,
    });
    appendNativeAssistant(sessionManager, "retained answer");
    const compaction = appendNativeCompaction(sessionManager, firstKeptEntryId);
    const harness = makeHarness({ sessionManager, compaction });

    harness.invoke();

    expect(nativeOutputCopies(sessionManager)).toEqual([]);
  });

  it("restores pre-compaction output even when later output exists", () => {
    const sessionManager = SessionManager.inMemory();
    const sourceEntryId = appendNativeAssistant(sessionManager, "before compaction");
    const compaction = appendNativeCompaction(sessionManager);
    appendNativeAssistant(sessionManager, "after compaction");
    const harness = makeHarness({ sessionManager, compaction });

    harness.invoke();

    expect(nativeOutputCopies(sessionManager)).toEqual([
      {
        text: "before compaction",
        sourceEntryId,
        compactionEntryId: compaction.id,
        truncated: false,
      },
    ]);
  });
});

describe("omitted output scan boundaries with native Pi entries", () => {
  it("includes the entry exactly maxScan entries before the compaction", () => {
    const { sessionManager, sourceEntryId, compaction } = makeNativeScanSession(3);
    expect(
      selectOmittedAssistantText({
        branch: sessionManager.getBranch(),
        retainedIds: new Set([compaction.id]),
        compactionEntryId: compaction.id,
        maxScan: 3,
      }),
    ).toEqual({ entryId: sourceEntryId, text: "scan boundary answer" });
  });

  it("excludes the entry one beyond maxScan", () => {
    const { sessionManager, compaction } = makeNativeScanSession(4);
    expect(
      selectOmittedAssistantText({
        branch: sessionManager.getBranch(),
        retainedIds: new Set([compaction.id]),
        compactionEntryId: compaction.id,
        maxScan: 3,
      }),
    ).toBeUndefined();
  });

  it("includes the 600th entry with the default scan budget", () => {
    const { sessionManager, sourceEntryId, compaction } = makeNativeScanSession(600);
    const harness = makeHarness({ sessionManager, compaction });
    harness.invoke();
    expect(nativeOutputCopies(sessionManager)).toEqual([
      {
        text: "scan boundary answer",
        sourceEntryId,
        compactionEntryId: compaction.id,
        truncated: false,
      },
    ]);
  });

  it("excludes the 601st entry with the default scan budget", () => {
    const { sessionManager, compaction } = makeNativeScanSession(601);
    const harness = makeHarness({ sessionManager, compaction });
    harness.invoke();
    expect(nativeOutputCopies(sessionManager)).toEqual([]);
  });

  it("selects nothing with a zero scan budget", () => {
    const { sessionManager, compaction } = makeNativeScanSession(1);
    expect(
      selectOmittedAssistantText({
        branch: sessionManager.getBranch(),
        retainedIds: new Set([compaction.id]),
        compactionEntryId: compaction.id,
        maxScan: 0,
      }),
    ).toBeUndefined();
  });

  it("does not select output after a compaction even if it is not in retainedIds", () => {
    const { sessionManager, sourceEntryId, compaction } = makeNativeScanSession(1);
    appendNativeAssistant(sessionManager, "later output must not be copied");
    expect(
      selectOmittedAssistantText({
        branch: sessionManager.getBranch(),
        retainedIds: new Set([compaction.id]),
        compactionEntryId: compaction.id,
      }),
    ).toEqual({ entryId: sourceEntryId, text: "scan boundary answer" });
  });

  it("selects nothing when the compaction anchor is at index zero", () => {
    const sessionManager = SessionManager.inMemory();
    const compaction = appendNativeCompaction(sessionManager);
    appendNativeAssistant(sessionManager, "later output must not be copied");
    expect(
      selectOmittedAssistantText({
        branch: sessionManager.getBranch(),
        retainedIds: new Set([compaction.id]),
        compactionEntryId: compaction.id,
      }),
    ).toBeUndefined();
  });

  it("selects nothing when a missing anchor has assistant candidates", () => {
    const sessionManager = SessionManager.inMemory();
    appendNativeAssistant(sessionManager, "unanchored output");
    expect(
      selectOmittedAssistantText({
        branch: sessionManager.getBranch(),
        retainedIds: new Set(),
        compactionEntryId: "missing",
      }),
    ).toBeUndefined();
  });
});

describe("omitted output across repeated compactions", () => {
  const selectFrom = (sessionManager: SessionManager, compactionEntryId: string) =>
    selectOmittedAssistantText({
      branch: sessionManager.getBranch(),
      retainedIds: new Set(sessionManager.buildContextEntries().map((entry) => entry.id)),
      compactionEntryId,
    });

  it("selects the newest answer after a previous compaction", () => {
    const sessionManager = SessionManager.inMemory();
    appendNativeAssistant(sessionManager, "answer summarized by the first compaction");
    appendNativeCompaction(sessionManager);
    sessionManager.appendMessage({ role: "user", content: "second question", timestamp: 0 });
    const sourceEntryId = appendNativeAssistant(sessionManager, "newest dropped answer");
    const firstKeptEntryId = sessionManager.appendMessage({
      role: "user",
      content: "third question",
      timestamp: 0,
    });
    appendNativeToolResult(sessionManager, "call-1");
    const compaction = appendNativeCompaction(sessionManager, firstKeptEntryId);

    expect(selectFrom(sessionManager, compaction.id)).toEqual({
      entryId: sourceEntryId,
      text: "newest dropped answer",
    });
  });

  it("does not restore an older answer when several answers are retained", () => {
    const sessionManager = SessionManager.inMemory();
    appendNativeAssistant(sessionManager, "omitted answer");
    const firstKeptEntryId = sessionManager.appendMessage({
      role: "user",
      content: "second question",
      timestamp: 0,
    });
    appendNativeAssistant(sessionManager, "retained text answer");
    appendNativeToolResult(sessionManager, "call-1");
    sessionManager.appendMessage({ role: "user", content: "third question", timestamp: 0 });
    appendNativeAssistant(sessionManager, "newest retained answer");
    const compaction = appendNativeCompaction(sessionManager, firstKeptEntryId);

    expect(selectFrom(sessionManager, compaction.id)).toBeUndefined();
  });

  it("selects text the previous compaction left visible", () => {
    const sessionManager = SessionManager.inMemory();
    const firstKeptEntryId = sessionManager.appendMessage({
      role: "user",
      content: "first question",
      timestamp: 0,
    });
    const sourceEntryId = appendNativeAssistant(
      sessionManager,
      "answer still visible after the first compaction",
    );
    appendNativeCompaction(sessionManager, firstKeptEntryId);
    appendNativeAssistant(sessionManager, "partial answer", "aborted");
    const compaction = appendNativeCompaction(sessionManager);

    expect(selectFrom(sessionManager, compaction.id)).toEqual({
      entryId: sourceEntryId,
      text: "answer still visible after the first compaction",
    });
  });

  it("falls back to the newest text from before the previous compaction when nothing newer survives", () => {
    // The first cut dropped this answer without a display copy (copy disabled or a
    // host-only compaction), so it is the last assistant text the user saw before
    // the second cut. Restoring it is best-effort continuity, not resurrection of
    // text that was visible a moment ago.
    const sessionManager = SessionManager.inMemory();
    const sourceEntryId = appendNativeAssistant(
      sessionManager,
      "answer hidden by the first compaction",
    );
    const firstKeptEntryId = sessionManager.appendMessage({
      role: "user",
      content: "question after the hidden answer",
      timestamp: 0,
    });
    appendNativeCompaction(sessionManager, firstKeptEntryId);
    appendNativeAssistant(sessionManager, "partial answer", "aborted");
    const compaction = appendNativeCompaction(sessionManager);

    expect(selectFrom(sessionManager, compaction.id)).toEqual({
      entryId: sourceEntryId,
      text: "answer hidden by the first compaction",
    });
  });

  it("keeps the same text visible across consecutive compactions", () => {
    const sessionManager = SessionManager.inMemory();
    const sourceEntryId = appendNativeAssistant(sessionManager, "only assistant answer");
    const firstCompaction = appendNativeCompaction(sessionManager);
    makeHarness({ sessionManager, compaction: firstCompaction }).invoke();
    appendNativeAssistant(sessionManager, "partial answer", "aborted");
    const secondCompaction = appendNativeCompaction(sessionManager);
    makeHarness({ sessionManager, compaction: secondCompaction }).invoke();

    // Each compaction owns its copy; only the newest one is after the latest cut,
    // so the rebuilt view still shows the answer exactly once.
    expect(nativeOutputCopies(sessionManager)).toEqual([
      {
        text: "only assistant answer",
        sourceEntryId,
        compactionEntryId: firstCompaction.id,
        truncated: false,
      },
      {
        text: "only assistant answer",
        sourceEntryId,
        compactionEntryId: secondCompaction.id,
        truncated: false,
      },
    ]);
  });
});

describe("copy placement in the rebuilt view", () => {
  it("renders the copy after the retained tail and before later turns", () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: "first question", timestamp: 0 });
    appendNativeAssistant(sessionManager, "dropped answer");
    const firstKeptEntryId = sessionManager.appendMessage({
      role: "user",
      content: "second question",
      timestamp: 0,
    });
    const compaction = appendNativeCompaction(sessionManager, firstKeptEntryId);
    makeHarness({ sessionManager, compaction }).invoke();
    const afterCompaction = appendNativeAssistant(sessionManager, "next turn answer");

    const context = sessionManager.buildContextEntries();
    const copy = context.find(
      (entry) => entry.type === "custom" && entry.customType === PRE_COMPACTION_OUTPUT_TYPE,
    );
    if (copy?.type !== "custom") throw new Error("Expected the display copy in the rebuilt view");
    // The TUI renders buildContextEntries().slice(1) and appends the compaction
    // card, so everything here is visible after the rebuild.
    expect(context.map((entry) => entry.id)).toEqual([
      compaction.id,
      firstKeptEntryId,
      copy.id,
      afterCompaction,
    ]);
  });
});

describe("older hosts without entry renderers", () => {
  it("registers no session_compact handler", () => {
    const on = vi.fn();
    const runtime = {
      ensureConfig: vi.fn(),
      config: { showPreCompactionMessage: true, debugLog: false },
    };
    registerPreCompactionOutput(
      { on } as unknown as Parameters<typeof registerPreCompactionOutput>[0],
      runtime as unknown as Parameters<typeof registerPreCompactionOutput>[1],
    );
    expect(on).not.toHaveBeenCalled();
  });
});

// ── renderer ─────────────────────────────────────────────────────────────────

function renderOutput(entry: unknown): string {
  const harness = makeHarness();
  const renderer = harness.getRenderer() as (
    entry: unknown,
    options: { expanded: boolean },
    theme: unknown,
  ) => { render: (width: number) => string[] } | undefined;
  const component = renderer(entry, { expanded: false }, makeTheme());
  return component ? component.render(80).join("\n") : "";
}

function makeTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
  };
}

describe("pre-compaction entry renderer", () => {
  it("returns undefined for invalid stored data", () => {
    const harness = makeHarness();
    const renderer = harness.getRenderer() as (e: unknown, o: unknown, t: unknown) => unknown;
    expect(renderer({ data: undefined }, { expanded: false }, makeTheme())).toBeUndefined();
  });

  it("renders the label and the copied text", () => {
    const output = renderOutput({
      data: {
        text: "kept visible answer",
        sourceEntryId: "a2",
        compactionEntryId: "c1",
        truncated: false,
      },
    });
    expect(output).toContain("[Previous output — display only]");
    expect(output).toContain("kept visible answer");
    expect(output).not.toContain("[Copy truncated]");
  });

  it("renders the truncation notice only for a truncated copy", () => {
    const output = renderOutput({
      data: {
        text: "cut answer",
        sourceEntryId: "a2",
        compactionEntryId: "c1",
        truncated: true,
      },
    });
    expect(output).toContain("[Copy truncated]");
  });
});

// ── host context exclusion ───────────────────────────────────────────────────

describe("host context projection", () => {
  it("keeps the cosmetic entry out of provider context", () => {
    const entry = {
      type: "custom",
      id: "x1",
      parentId: "c1",
      timestamp: new Date().toISOString(),
      customType: PRE_COMPACTION_OUTPUT_TYPE,
      data: {
        text: "copied",
        sourceEntryId: "a1",
        compactionEntryId: "c1",
        truncated: false,
      },
    };
    expect(sessionEntryToContextMessages(entry as never)).toEqual([]);
  });
});

// ── Blackhole consumer exclusion ─────────────────────────────────────────────

describe("Blackhole memory and summary inputs", () => {
  const cosmeticEntry = {
    type: "custom",
    id: "x1",
    parentId: "c1",
    timestamp: new Date().toISOString(),
    customType: PRE_COMPACTION_OUTPUT_TYPE,
    data: {
      text: "copied answer text",
      sourceEntryId: "a1",
      compactionEntryId: "c1",
      truncated: false,
    },
  };

  it("is not serialized into observer or summary input", () => {
    expect(serializeBranchEntries([cosmeticEntry] as never)).toBe("");
  });

  it("costs zero source tokens", () => {
    expect(estimateEntryTokens(cosmeticEntry as never)).toBe(0);
  });

  it("is not treated as a memory source entry", () => {
    expect(isSourceEntry(cosmeticEntry as never)).toBe(false);
  });
});

// ── compaction result equivalence ────────────────────────────────────────────

describe("compaction result is unchanged by an existing copy", () => {
  function liveConversation(): any[] {
    return [
      { type: "compaction", id: "c0", firstKeptEntryId: "u1", summary: "old" },
      { type: "message", id: "u1", message: { role: "user", content: "first question" } },
      {
        type: "message",
        id: "a1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first answer" }],
          stopReason: "stop",
        },
      },
      { type: "message", id: "u2", message: { role: "user", content: "second question" } },
      {
        type: "message",
        id: "a2",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "second answer" }],
          stopReason: "stop",
        },
      },
    ];
  }

  const copyEntry = {
    type: "custom",
    id: "x1",
    parentId: "a1",
    timestamp: new Date().toISOString(),
    customType: PRE_COMPACTION_OUTPUT_TYPE,
    data: { text: "first answer", sourceEntryId: "a1", compactionEntryId: "c0", truncated: false },
  };

  it("keeps the same cut point", () => {
    const without = buildOwnCut(liveConversation());
    const withcopy = buildOwnCut([
      ...liveConversation().slice(0, 3),
      copyEntry,
      ...liveConversation().slice(3),
    ]);
    expect(withcopy).toEqual(without);
  });

  it("keeps the same pi-default cut point", () => {
    const branch = [...liveConversation().slice(0, 3), copyEntry, ...liveConversation().slice(3)];
    expect(buildOwnCut(branch, "a1", "pi-default")).toEqual(
      buildOwnCut(liveConversation(), "a1", "pi-default"),
    );
  });

  it("adds no tokens to the next compaction threshold", () => {
    const without = rawTokensSinceLastCompaction(liveConversation() as never);
    const withcopy = rawTokensSinceLastCompaction([
      ...liveConversation().slice(0, 3),
      copyEntry,
      ...liveConversation().slice(3),
    ] as never);
    expect(withcopy).toBe(without);
  });

  it("changes no provider context message", () => {
    const messagesOf = (entries: any[]) =>
      entries.map((e) => sessionEntryToContextMessages(e as never));
    const without = messagesOf(liveConversation());
    const withcopy = messagesOf([
      ...liveConversation().slice(0, 3),
      copyEntry,
      ...liveConversation().slice(3),
    ]);
    expect(withcopy).toEqual([...without.slice(0, 3), [], ...without.slice(3)]);
  });
});

// ── configuration surface ────────────────────────────────────────────────────

describe("showPreCompactionMessage configuration", () => {
  it("defaults to on", () => {
    expect(DEFAULTS.showPreCompactionMessage).toBe(true);
  });

  it("has a declarative env override", () => {
    expect(DECLARATIVE_ENV_OVERRIDES.showPreCompactionMessage).toBe(
      "PI_BLACKHOLE_SHOW_PRE_COMPACTION_MESSAGE",
    );
  });
});
