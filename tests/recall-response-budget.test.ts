/**
 * Recall response budget (issue #83) — bounded recall output.
 *
 * Regression tests: a single huge stored message (long tool-result line, big
 * expanded entry, giant observation body) must never flood the recall
 * response. Per-entry/excerpt bounds + a total character budget with
 * explicit continuation, while the full stored content stays reachable.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerRecallTool, clipExpandedEntry } from "../src/tools/recall.js";
import {
  expandAllocation,
  capRecallBlocks,
  EXPAND_FLOOR_CHARS,
} from "../src/core/recall-budget.js";
import { searchEntriesDetailed } from "../src/core/search-entries.js";
import type { RenderedEntry } from "../src/core/render-entries.js";
import type { Message } from "@earendil-works/pi-ai";
import { formatRelatedObservations } from "../src/om/reverse-recall.js";

// ── fixture helpers ───────────────────────────────────────────────────────

const toolEntry = (
  id: string,
  index: number,
  output: string,
): { rendered: RenderedEntry; msg: Message } => {
  const rendered = {
    index,
    id,
    role: "tool_result",
    summary: `[read] ${output.slice(0, 200)}`,
  };
  const msg = {
    role: "toolResult",
    toolName: "read",
    content: [{ type: "text", text: output }],
    isError: false,
  } as unknown as Message;
  return { rendered, msg };
};

const makeSession = (
  entries: Array<{ id: string; type: string; message?: Record<string, unknown> }>,
) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-vcc-recall-budget-"));
  const file = join(dir, "session.jsonl");
  const lines = entries.map((e) => JSON.stringify(e));
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return { dir, file };
};

const register = (maxChars: number) => {
  let tool: any;
  registerRecallTool(
    {
      registerTool: (t: any) => {
        tool = t;
      },
    } as any,
    { config: { recallResponseMaxChars: maxChars } } as any,
  );
  return tool;
};

const invoke = async (
  tool: any,
  file: string,
  params: Record<string, unknown>,
  entries: Array<{ id: string }>,
) => {
  const result = await tool.execute("tool-call", params, undefined, undefined, {
    sessionManager: {
      getSessionFile: () => file,
      getBranch: () => entries,
      getEntries: () => entries,
    },
  });
  return result.content[0].text as string;
};

// ── expandAllocation / clipExpandedEntry unit ─────────────────────────────

describe("expandAllocation", () => {
  it("gives a single entry the whole budget (bounded, never verbatim-unbounded)", () => {
    expect(expandAllocation(1, 48_000)).toBe(47_800);
    expect(expandAllocation(1, 48_000)).toBeLessThan(48_000);
  });

  it("splits the budget evenly across many entries", () => {
    const alloc = expandAllocation(12, 48_000);
    expect(alloc).toBeGreaterThan(0);
    expect(alloc * 12).toBeLessThan(48_000); // overhead reserved
  });

  it("keeps a readability floor when the share is small", () => {
    expect(expandAllocation(20, 48_000)).toBeGreaterThanOrEqual(EXPAND_FLOOR_CHARS);
  });

  it("returns 0 for empty/zero inputs", () => {
    expect(expandAllocation(0, 48_000)).toBe(0);
    expect(expandAllocation(3, 0)).toBe(0);
  });
});

describe("clipExpandedEntry", () => {
  it("passes short entries through unchanged", () => {
    const e: RenderedEntry = { index: 1, id: "a", role: "user", summary: "hello" };
    expect(clipExpandedEntry(e, 100)).toBe(e);
  });

  it("clips a long entry and adds a continuation marker", () => {
    const e: RenderedEntry = { index: 4, id: "a", role: "user", summary: "x".repeat(10_000) };
    const out = clipExpandedEntry(e, 1_000);
    expect(out.summary.length).toBeLessThan(10_000);
    expect(out.summary).toContain("#4:text:full");
    expect(out.summary).toContain("truncated");
  });
});

// ── search snippets (line cap) ────────────────────────────────────────────

describe("search snippet line cap", () => {
  it("caps a 50KB matching line so a search page stays small", () => {
    const payload = "budgetneedle pick " + "x".repeat(50_000);
    const { rendered, msg } = toolEntry("m1", 0, payload);
    const result = searchEntriesDetailed([rendered], [msg], "budgetneedle");
    expect(result.hits).toHaveLength(1);
    const snippet = result.hits[0].snippet ?? "";
    expect(snippet.length).toBeLessThan(2_000);
    expect(snippet).toContain("budgetneedle");
  });
});

// ── total budget: search page + expand + observations ─────────────────────

describe("recall tool response budget", () => {
  const bigEntries = Array.from({ length: 50 }, (_, i) => ({
    id: `m${i}`,
    type: "message",
    message: {
      role: "toolResult",
      toolName: "read",
      content: [{ type: "text", text: `budgetneedle payload-${i} ` + "x".repeat(50_000) }],
      isError: false,
    },
  }));

  it("bounds the first search page (250k → under budget)", async () => {
    const { dir, file } = makeSession(bigEntries);
    try {
      const tool = register(48_000);
      const text = await invoke(tool, file, { query: "budgetneedle" }, bigEntries);
      expect(text.length).toBeLessThan(48_000);
      expect(text).toContain("budgetneedle");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounds a 12-entry expansion to the budget with every entry present", async () => {
    // toolResult entries at indices 0..49 (all messages preceded by none).
    // First entry is index 0 (user-less session), so expand indices 0..11.
    const { dir, file } = makeSession(bigEntries);
    try {
      const tool = register(48_000);
      const text = await invoke(
        tool,
        file,
        { expand: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
        bigEntries,
      );
      expect(text.length).toBeLessThan(48_000);
      // All requested indices present (as excerpts) — none silently dropped.
      for (let i = 0; i < 12; i++) {
        expect(text).toContain(`payload-${i}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounds a single expand to the budget with a continuation marker", async () => {
    const { dir, file } = makeSession(bigEntries);
    try {
      const tool = register(48_000);
      const text = await invoke(tool, file, { expand: [0] }, bigEntries);
      expect(text.length).toBeLessThan(48_000);
      expect(text).toContain("payload-0");
      expect(text).toContain("#0:text:full");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps observation augmentation below the budget", async () => {
    const obsData = {
      customType: "om.observations.recorded",
      data: {
        coversUpToId: "m49",
        observations: Array.from({ length: 30 }, (_, i) => ({
          id: i.toString(16).padStart(12, "0"),
          timestamp: "2000-01-01T00:00:00.000Z",
          relevance: "high",
          content: `synthetic-observation-${i} ` + "y".repeat(8_000),
          sourceEntryIds: bigEntries.slice(0, 5).map((e) => e.id),
          tokenCount: 2_010,
        })),
      },
    };
    const session = [...bigEntries, { id: "om1", type: "custom", ...obsData }];
    const { dir, file } = makeSession(session as any);
    try {
      const tool = register(48_000);
      const text = await invoke(tool, file, { query: "budgetneedle" }, session);
      expect(text.length).toBeLessThan(48_000);
      expect(text).toContain("Related observations:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("entry-aware truncation keeps the header and names the omitted count", () => {
    const capped = capRecallBlocks({
      header: 'Page 1/10 (50 matches) for "budgetneedle":',
      entryBlocks: Array.from({ length: 10 }, (_, i) => `#${i} [tool_result] ${"x".repeat(9_000)}`),
      budget: 48_000,
      continuation: "Use page:2 for more results",
    });
    expect(capped.capped).toBe(true);
    expect(capped.omittedEntries).toBeGreaterThan(0);
    expect(capped.text).toContain("Page 1/10 (50 matches)");
    expect(capped.text).toContain("omitted");
    expect(capped.text).toContain("Use page:2");
  });
});

// ── observation body cap (reverse-recall) ─────────────────────────────────

describe("formatRelatedObservations body cap", () => {
  it("caps a huge observation body while keeping the id reachable", () => {
    const out = formatRelatedObservations(
      [
        {
          memoryId: "aaaaaaaaaaaa",
          content: "budgetneedle-obs " + "z".repeat(20_000),
          timestamp: "2000-01-01T00:00:00.000Z",
          relevance: "high",
          status: "active" as const,
          matchedEntryIds: ["m1"],
        },
      ],
      [],
    );
    expect(out.length).toBeLessThan(2_000);
    expect(out).toContain("aaaaaaaaaaaa");
    expect(out).toContain("budgetneedle-obs");
  });
});
