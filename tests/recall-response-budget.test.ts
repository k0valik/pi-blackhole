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
import { parseDrillDown } from "../src/core/drill-down.js";
import { capDrillDownText } from "../src/core/recall-budget.js";
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

/**
 * Space-free line tokens keep clip() on a hard character cut (its word-boundary
 * search only finds spaces in the header), so the line the cap stopped inside
 * is exactly predictable in assertions.
 */
const lineToken = (n: number) => `L${String(n).padStart(4, "0")}`;

const numberedBody = (count: number) =>
  Array.from({ length: count }, (_, i) => lineToken(i + 1)).join("\n");

const writeEntry = (path: string, content: string) => ({
  id: "m1",
  type: "message",
  message: {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc1", name: "write", arguments: { path, content } }],
  },
});

const textEntry = (text: string) => ({
  id: "m1",
  type: "message",
  message: { role: "user", content: [{ type: "text", text }] },
});

/** Pull the drill-down query out of the cap hint the tool appends. */
const hintQuery = (text: string): string => {
  const m = text.match(/recall response capped at \d+ characters; (?:[^#]*)(#\S+) ---/);
  if (!m) throw new Error(`no cap hint query found in: ${text.slice(-300)}`);
  return m[1];
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

  it("reads the budget live per call, so settings edits apply without reload", async () => {
    const { dir, file } = makeSession(bigEntries);
    try {
      const runtime = { config: { recallResponseMaxChars: 5_000 } } as any;
      let tool: any;
      registerRecallTool(
        {
          registerTool: (t: any) => {
            tool = t;
          },
        } as any,
        runtime,
      );
      const small = await invoke(tool, file, { expand: [0] }, bigEntries);
      expect(small.length).toBeLessThan(5_000);
      expect(small).toContain("payload-0");
      runtime.config.recallResponseMaxChars = 48_000;
      const large = await invoke(tool, file, { expand: [0] }, bigEntries);
      expect(large.length).toBeGreaterThan(small.length);
      expect(large.length).toBeLessThan(48_000);
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

  it("caps large #N:path drill-down content to maxChars", async () => {
    const hugeContent = "const line = 'x';\n".repeat(4_000);
    const session = [
      {
        id: "m1",
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc1",
              name: "write",
              arguments: { path: "huge.ts", content: hugeContent },
            },
          ],
        },
      },
    ];
    const { dir, file } = makeSession(session as any);
    try {
      const tool = register(300);
      const text = await invoke(tool, file, { query: "#0:huge.ts" }, session);
      expect(text.length).toBeLessThanOrEqual(300);
      expect(text).toContain("--- recall response capped at 300 characters");
      const resume = parseDrillDown(hintQuery(text));
      expect(resume).toMatchObject({ index: 0, pathPattern: "huge.ts" });
      expect(resume?.offset).toBeGreaterThan(0);
      expect(resume?.limit).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps large #N:text message body drill-down content to maxChars", async () => {
    const hugeBody = "user message text\n".repeat(4_000);
    const session = [
      {
        id: "m1",
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: hugeBody }],
        },
      },
    ];
    const { dir, file } = makeSession(session as any);
    try {
      const tool = register(300);
      const text = await invoke(tool, file, { query: "#0:text" }, session);
      expect(text.length).toBeLessThanOrEqual(300);
      expect(text).toContain("--- recall response capped at 300 characters");
      const resume = parseDrillDown(hintQuery(text));
      expect(resume).toMatchObject({ index: 0, pathPattern: "text" });
      expect(resume?.offset).toBeGreaterThan(0);
      expect(resume?.limit).toBeGreaterThan(0);
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

// ── drill-down cap hint (actionable resume) ────────────────────────────────

describe("drill-down cap hint resumes where the cap stopped", () => {
  it("resumes a capped #N:path preview at the exact next line", async () => {
    const session = [writeEntry("huge.ts", numberedBody(500))];
    const { dir, file } = makeSession(session as any);
    try {
      const tool = register(200);
      const first = await invoke(tool, file, { query: "#0:huge.ts" }, session);
      expect(first.length).toBeLessThanOrEqual(400);
      expect(first).toContain("File: huge.ts");

      const query = hintQuery(first);
      const resume = parseDrillDown(query);
      expect(resume).toMatchObject({ index: 0, pathPattern: "huge.ts" });
      expect(resume?.offset).toBeGreaterThan(0);
      expect(resume?.limit).toBeGreaterThan(0);

      // The last body line in the first chunk is cut mid-token; the resume must
      // start at the line right after it — nothing skipped, nothing re-read.
      const capped = first.slice(0, first.indexOf("\n\n--- recall response capped at"));
      const partial = capped.slice(capped.lastIndexOf("\n") + 1);
      expect(partial.length).toBeGreaterThan(0);
      expect(lineToken(resume!.offset!).startsWith(partial)).toBe(true);

      const second = await invoke(tool, file, { query }, session);
      expect(second).toContain(`Lines ${resume!.offset! + 1}-`);
      expect(second).toContain(`\n${lineToken(resume!.offset! + 1)}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resumes a capped #N:text body at the exact next line", async () => {
    const session = [textEntry(numberedBody(500))];
    const { dir, file } = makeSession(session as any);
    try {
      const tool = register(200);
      const first = await invoke(tool, file, { query: "#0:text" }, session);
      expect(first).toContain("Entry #0 message text");

      const query = hintQuery(first);
      const resume = parseDrillDown(query);
      expect(resume).toMatchObject({ index: 0, pathPattern: "text" });
      expect(resume?.offset).toBeGreaterThan(0);

      const second = await invoke(tool, file, { query }, session);
      expect(second).toContain(`lines ${resume!.offset! + 1}-`);
      expect(second).toContain(`\n${lineToken(resume!.offset! + 1)}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a colon-bearing path resolvable in the hint", async () => {
    const session = [writeEntry("src/a:b.ts", numberedBody(200))];
    const { dir, file } = makeSession(session as any);
    try {
      const tool = register(200);
      const first = await invoke(tool, file, { query: "#0:src/a:b.ts" }, session);
      const query = hintQuery(first);
      const resume = parseDrillDown(query);
      expect(resume).toMatchObject({ index: 0, pathPattern: "src/a:b.ts" });
      expect(resume?.offset).toBeGreaterThan(0);

      const second = await invoke(tool, file, { query }, session);
      expect(second).toContain("File: src/a:b.ts");
      expect(second).toContain(`Lines ${resume!.offset! + 1}-`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resumes a capped explicit offset window past the window start", async () => {
    const session = [writeEntry("huge.ts", numberedBody(500))];
    const { dir, file } = makeSession(session as any);
    try {
      const tool = register(400);
      const first = await invoke(tool, file, { query: "#0:huge.ts:100:200" }, session);
      expect(first).toContain("Lines 101-300 (of 500)");

      const query = hintQuery(first);
      const resume = parseDrillDown(query);
      expect(resume?.offset).toBeGreaterThan(100);

      const second = await invoke(tool, file, { query }, session);
      expect(second).toContain(`Lines ${resume!.offset! + 1}-`);
      expect(second).toContain(`\n${lineToken(resume!.offset! + 1)}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resumes a capped #N:path:full at the exact next line", async () => {
    const session = [writeEntry("huge.ts", numberedBody(500))];
    const { dir, file } = makeSession(session as any);
    try {
      const tool = register(200);
      const first = await invoke(tool, file, { query: "#0:huge.ts:full" }, session);
      expect(first.length).toBeLessThanOrEqual(400);

      const query = hintQuery(first);
      const resume = parseDrillDown(query);
      expect(resume).toMatchObject({ index: 0, pathPattern: "huge.ts" });
      expect(resume?.offset).toBeGreaterThan(0);

      const second = await invoke(tool, file, { query }, session);
      expect(second).toContain(`Lines ${resume!.offset! + 1}-`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("points at a real line when the only line is larger than the budget", async () => {
    const session = [writeEntry("min.js", `${"Z".repeat(20_000)}\n${numberedBody(3)}`)];
    const { dir, file } = makeSession(session as any);
    try {
      const tool = register(400);
      const first = await invoke(tool, file, { query: "#0:min.js" }, session);
      expect(first.length).toBeLessThanOrEqual(400);

      const query = hintQuery(first);
      const resume = parseDrillDown(query);
      expect(resume?.offset).toBe(1);
      expect(resume?.limit).toBe(3);

      const second = await invoke(tool, file, { query }, session);
      expect(second).toContain(`Lines 2-4 (of 4)`);
      expect(second).toContain("\nL0002\n");
      expect(second).not.toContain("beyond file length");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("capDrillDownText", () => {
  const paging = {
    startLine: 0,
    shownLines: 30,
    totalLines: 500,
    headerNewlines: 3,
  };
  const rendered = `File: huge.ts\nTool: write\n\n${numberedBody(30)}`;

  it("leaves text under the budget untouched", () => {
    expect(
      capDrillDownText({
        text: rendered,
        paging,
        index: 0,
        pathPattern: "huge.ts",
        maxChars: 100_000,
      }),
    ).toBe(rendered);
  });

  it("leaves text untouched when the budget is disabled", () => {
    expect(
      capDrillDownText({ text: rendered, paging, index: 0, pathPattern: "huge.ts", maxChars: 0 }),
    ).toBe(rendered);
  });

  it("emits a parseable resume query with concrete numbers", () => {
    const out = capDrillDownText({
      text: rendered,
      paging,
      index: 3,
      pathPattern: "huge.ts",
      maxChars: 200,
    });
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).toContain("--- recall response capped at 200 characters; continue at #3:huge.ts:");
    expect(out).not.toContain("offset:limit");
    const resume = parseDrillDown(hintQuery(out));
    expect(resume).toMatchObject({ index: 3, pathPattern: "huge.ts" });
    expect(resume?.offset).toBeGreaterThan(0);
    expect(resume?.limit).toBe(30);
  });

  it("never exceeds the budget when the note alone is longer than it", () => {
    const out = capDrillDownText({
      text: rendered,
      paging,
      index: 0,
      pathPattern: "huge.ts",
      maxChars: 20,
    });
    expect(out.length).toBeLessThanOrEqual(20);
  });

  it("suggests a single line when the cap left no body line visible", () => {
    const longPath = "d/".repeat(40);
    const text = `File: ${longPath}\nTool: write\n\n${numberedBody(30)}`;
    const out = capDrillDownText({
      text,
      paging: { ...paging, headerNewlines: 3 },
      index: 0,
      pathPattern: longPath,
      maxChars: 260,
    });
    expect(out.length).toBeLessThanOrEqual(260);
    expect(out).toContain("no content fit the budget");
    expect(hintQuery(out)).toBe(`#0:${longPath}:0:1`);
  });

  it("drops the numeric resume when no lines remain to page", () => {
    const out = capDrillDownText({
      text: `File: min.js\nTool: write\n\n${"Z".repeat(5_000)}\n`,
      paging: { startLine: 0, shownLines: 1, totalLines: 1, headerNewlines: 3 },
      index: 0,
      pathPattern: "min.js",
      maxChars: 300,
    });
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out).toContain("no further lines to page");
    expect(out).not.toContain("continue at #");
  });

  it("falls back to a generic hint without paging metadata", () => {
    const out = capDrillDownText({
      text: numberedBody(30),
      index: 1,
      pathPattern: "log.ts",
      maxChars: 120,
    });
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out).toContain("re-request a narrower range with #1:log.ts:offset:limit");
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
