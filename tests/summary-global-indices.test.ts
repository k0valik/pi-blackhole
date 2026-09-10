/**
 * Summary references must use session-global `#N` indices (the recall index
 * space), not the selected window's zero-based positions.
 *
 * Regression tests for the repeated-compaction / branching mismatch:
 * normalization numbered the compaction window from zero while recall counts
 * every message in the session file, so second-cycle summaries retrieved
 * unrelated operations (or failed lineage checks after branching).
 */
import { describe, it, expect, vi } from "vitest";
import { buildGlobalIndexById, isCountedMessageEntry } from "../src/core/global-indices.js";
import { normalize } from "../src/core/normalize.js";
import { compile } from "../src/core/summarize.js";
import {
  registerBeforeCompactHook,
  PI_VCC_COMPACT_INSTRUCTION,
} from "../src/hooks/before-compact.js";
import { userMsg, assistantWithToolCall, toolResult } from "./vcc-fixtures.js";

// ── global-indices unit ─────────────────────────────────────────────────

describe("buildGlobalIndexById", () => {
  it("counts only message entries in order", () => {
    const entries = [
      { type: "session", id: "header" },
      { id: "m1", type: "message", message: { role: "user" } },
      { id: "c1", type: "compaction", firstKeptEntryId: "" },
      { id: "x1", type: "custom", customType: "om.foo" },
      { id: "m2", type: "message", message: { role: "assistant" } },
      { id: "m3", type: "message", message: { role: "toolResult" } },
    ];
    const map = buildGlobalIndexById(entries);
    expect(map.get("m1")).toBe(0);
    expect(map.get("m2")).toBe(1);
    expect(map.get("m3")).toBe(2);
    expect(map.has("c1")).toBe(false);
    expect(map.has("x1")).toBe(false);
  });

  it("drops duplicate ids fail-closed but still advances positions", () => {
    const entries = [
      { id: "a", type: "message", message: { role: "user" } },
      { id: "a", type: "message", message: { role: "assistant" } },
      { id: "b", type: "message", message: { role: "assistant" } },
    ];
    const map = buildGlobalIndexById(entries);
    expect(map.has("a")).toBe(false);
    expect(map.get("b")).toBe(2);
  });

  it("entries without ids still occupy an index", () => {
    const entries = [
      { type: "message", message: { role: "user" } },
      { id: "x", type: "message", message: { role: "assistant" } },
    ];
    expect(buildGlobalIndexById(entries).get("x")).toBe(1);
  });

  it("isCountedMessageEntry requires a message payload", () => {
    expect(isCountedMessageEntry({ type: "message", message: {} })).toBe(true);
    expect(isCountedMessageEntry({ type: "message" })).toBe(false);
    expect(isCountedMessageEntry({ type: "compaction" })).toBe(false);
    expect(isCountedMessageEntry(null)).toBe(false);
  });
});

// ── normalize / compile threading ───────────────────────────────────────

describe("normalize with explicit sourceIndices", () => {
  it("uses global indices instead of window positions", () => {
    const blocks = normalize(
      [userMsg("inspect"), assistantWithToolCall("edit", { path: "beta.txt" })],
      [3, 4],
    );
    expect(blocks.map((b) => b.sourceIndex)).toEqual([3, 4]);
  });

  it("a missing entry yields no sourceIndex (fail-closed, not positional)", () => {
    const blocks = normalize(
      [userMsg("inspect"), assistantWithToolCall("edit", { path: "beta.txt" })],
      [3, undefined],
    );
    expect(blocks[0].sourceIndex).toBe(3);
    expect(blocks[1].sourceIndex).toBeUndefined();
  });

  it("omitted indices preserve the legacy positional behavior", () => {
    const blocks = normalize([userMsg("a"), userMsg("b")]);
    expect(blocks.map((b) => b.sourceIndex)).toEqual([0, 1]);
  });
});

describe("compile with sourceIndices", () => {
  it("emits the global ref for a second-window edit", () => {
    const summary = compile({
      messages: [
        userMsg("Modify the beta fixture"),
        assistantWithToolCall("edit", { path: "beta.txt" }),
        toolResult("edit", "done"),
      ],
      sourceIndices: [3, 4, 5],
    });
    expect(summary).toContain('* edit "beta.txt" (#4)');
    expect(summary).not.toContain('* edit "beta.txt" (#1)');
  });
});

// ── hook boundary: second compaction + branching ────────────────────────

const msgEntry = (id: string, message: unknown) => ({ id, type: "message", message });
const compactionEntry = (id: string, firstKeptEntryId: string) => ({
  id,
  type: "compaction",
  firstKeptEntryId,
  summary: "prior summary",
});

function hookHarness(allEntries: any[], config: Record<string, unknown> = {}) {
  let handler: ((event: any, ctx: any) => any) | undefined;
  const pi = {
    on: (name: string, h: (e: any, c: any) => any) => {
      if (name === "session_before_compact") handler = h;
    },
  } as any;
  const omRuntime = {
    ensureConfig: vi.fn(() => {}),
    config: {
      compaction: "auto",
      compactionEngine: "blackhole",
      tailBehavior: "minimal",
      compactionSummaryMode: "default",
      memory: false,
      debug: false,
      debugLog: false,
      retainedToolOutputMaxTokens: 0,
      ...config,
    },
  } as any;
  const ctx = {
    cwd: "/synthetic",
    ui: { notify: () => {} },
    sessionManager: { getEntries: () => allEntries },
  };
  registerBeforeCompactHook(pi, omRuntime);
  if (!handler) throw new Error("hook not registered");
  const invoke = (branchEntries: any[], preparation: any) => {
    return handler(
      {
        branchEntries,
        preparation: {
          fileOps: { read: new Set(), written: new Set(), edited: new Set() },
          tokensBefore: 1000,
          ...preparation,
        },
        customInstructions: PI_VCC_COMPACT_INSTRUCTION,
      },
      ctx,
    );
  };
  return { invoke };
}

const alphaRead = assistantWithToolCall("read", { path: "alpha.txt" });
const betaEdit = assistantWithToolCall("edit", { path: "beta.txt" });

describe("before-compact hook emits session-global refs", () => {
  it("second compact-all numbers the edit at its global index", () => {
    const all = [
      msgEntry("m1", userMsg("Inspect the alpha fixture")),
      msgEntry("m2", alphaRead),
      msgEntry("m3", toolResult("read", "alpha contents")),
      compactionEntry("c1", ""),
      msgEntry("m4", userMsg("Modify the beta fixture")),
      msgEntry("m5", betaEdit),
      msgEntry("m6", toolResult("edit", "done")),
    ];
    const { invoke } = hookHarness(all);
    const result = invoke(all, {
      previousSummary: "[Session Goal]\n- Inspect the alpha fixture",
    });
    expect(result.compaction).toBeDefined();
    expect(result.compaction.summary).toContain('* edit "beta.txt" (#4)');
    expect(result.compaction.summary).not.toContain('* edit "beta.txt" (#1)');
  });

  it("compaction after branching numbers the active edit globally", () => {
    const fileOrder = [
      msgEntry("r1", userMsg("Inspect the active fixture")),
      msgEntry("a1", assistantWithToolCall("read", { path: "abandoned.txt" })),
      msgEntry("a2", toolResult("read", "abandoned contents")),
      msgEntry("b1", assistantWithToolCall("edit", { path: "active.txt" })),
      msgEntry("b2", toolResult("edit", "done")),
    ];
    // Active lineage only — abandoned entries are in the file, not the branch.
    const branch = [fileOrder[0], fileOrder[3], fileOrder[4]];
    const { invoke } = hookHarness(fileOrder);
    const result = invoke(branch, {});
    expect(result.compaction).toBeDefined();
    expect(result.compaction.summary).toContain('* edit "active.txt" (#3)');
    expect(result.compaction.summary).not.toContain('* edit "active.txt" (#1)');
  });

  it("append-mode segments freeze the global ref, not the window position", () => {
    const all = [
      msgEntry("m1", userMsg("Inspect the alpha fixture")),
      msgEntry("m2", alphaRead),
      msgEntry("m3", toolResult("read", "alpha contents")),
      compactionEntry("c1", ""),
      msgEntry("m4", userMsg("Modify the beta fixture")),
      msgEntry("m5", betaEdit),
      msgEntry("m6", toolResult("edit", "done")),
    ];
    const { invoke } = hookHarness(all, { compactionSummaryMode: "append" });
    const result = invoke(all, {
      previousSummary: "[Session Goal]\n- Inspect the alpha fixture",
    });
    expect(result.compaction).toBeDefined();
    const segment = (result.compaction.details as any)?.segment?.summary;
    expect(typeof segment).toBe("string");
    expect(segment).toContain('* edit "beta.txt" (#4)');
    expect(segment).not.toContain('* edit "beta.txt" (#1)');
  });
});
