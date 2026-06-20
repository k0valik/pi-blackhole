/**
 * Ported from upstream pi-vcc
 * Changes: bun:test → vitest, added .js import extensions
 */
import { describe, it, expect } from "vitest";
import { searchEntries } from "../src/core/search-entries.js";
import type { RenderedEntry } from "../src/core/render-entries.js";
import type { Message } from "@earendil-works/pi-ai";

const entries: RenderedEntry[] = [
  { index: 0, role: "user", summary: "Fix login bug" },
  { index: 1, role: "assistant", summary: "Reading auth.ts" },
  { index: 2, role: "tool_result", summary: "[Read] code here" },
  { index: 3, role: "assistant", summary: "Found the root cause in auth module" },
];

const messages: Message[] = [
  { role: "user", content: "Fix login bug" } as any,
  { role: "assistant", content: [{ type: "text", text: "Reading auth.ts" }] } as any,
  { role: "toolResult", content: [{ type: "text", text: "[Read] code here" }] } as any,
  { role: "assistant", content: [{ type: "text", text: "Found the root cause in auth module" }] } as any,
];

describe("searchEntries", () => {
  it("returns all for empty query", () => {
    expect(searchEntries(entries, messages)).toEqual(entries);
    expect(searchEntries(entries, messages, "")).toEqual(entries);
  });

  it("filters by single term", () => {
    const r = searchEntries(entries, messages, "login");
    expect(r).toHaveLength(1);
    expect(r[0].index).toBe(0);
  });

  it("returns empty for no match", () => {
    expect(searchEntries(entries, messages, "xyz123")).toEqual([]);
  });

  it("finds keyword beyond clip boundary in full content", () => {
    const longText = "A".repeat(400) + " hidden_keyword here";
    const longEntries: RenderedEntry[] = [
      { index: 0, role: "user", summary: "A".repeat(300) },
    ];
    const longMsgs: Message[] = [
      { role: "user", content: longText } as any,
    ];
    const r = searchEntries(longEntries, longMsgs, "hidden_keyword");
    expect(r).toHaveLength(1);
    expect(r[0].snippet).toContain("hidden_keyword");
  });

  it("returns snippet around matched term", () => {
    const r = searchEntries(entries, messages, "root");
    expect(r).toHaveLength(1);
    expect(r[0].snippet).toBeDefined();
    expect(r[0].snippet).toContain("root");
  });

  // ── regex support ──

  it("supports regex pattern: alternation", () => {
    const r = searchEntries(entries, messages, "login|auth");
    expect(r).toHaveLength(3); // "login bug", "auth.ts", "auth module"
    expect(r.map((h) => h.index).sort()).toEqual([0, 1, 3]);
  });

  it("supports regex pattern: wildcard", () => {
    const r = searchEntries(entries, messages, "Read.*auth");
    expect(r).toHaveLength(1);
    expect(r[0].index).toBe(1);
  });

  it("falls back to escaped literal for invalid regex", () => {
    const extraEntries: RenderedEntry[] = [
      { index: 0, role: "user", summary: "test (foo" },
      { index: 1, role: "assistant", summary: "no match here" },
    ];
    const extraMsgs: Message[] = [
      { role: "user", content: "error with (foo pattern" } as any,
      { role: "assistant", content: [{ type: "text", text: "no match here" }] } as any,
    ];
    const r = searchEntries(extraEntries, extraMsgs, "(foo");
    expect(r).toHaveLength(1);
    expect(r[0].index).toBe(0);
  });

  it("regex is case-insensitive", () => {
    const r = searchEntries(entries, messages, "FIX|ROOT");
    expect(r).toHaveLength(2);
  });

  // ── natural language queries (OR logic + ranking) ──

  it("natural language query uses OR logic", () => {
    // "root cause auth" -- matches entries containing ANY of these terms
    const r = searchEntries(entries, messages, "root cause auth");
    expect(r.length).toBeGreaterThanOrEqual(2); // #3 has all 3, #1 has auth
    // Best match (highest BM25) should come first
    expect(r[0].index).toBe(3); // "Found the root cause in auth module" matches all 3
  });

  it("natural language ranks by BM25 score", () => {
    const r = searchEntries(entries, messages, "root cause auth");
    // Top result has more terms matched = higher BM25 score
    expect(r[0].matchCount!).toBeGreaterThanOrEqual(r[r.length - 1].matchCount!);
  });

  it("filters stopwords from queries", () => {
    // "the root cause of it" → stopwords: the, of, it → meaningful: root, cause
    const r = searchEntries(entries, messages, "the root cause of it");
    expect(r).toHaveLength(1);
    expect(r[0].index).toBe(3);
  });

  it("keeps all terms if all are stopwords", () => {
    // When all terms are stopwords, keep them (don't drop everything)
    // "the" appears in "Found the root cause" so it matches
    const r = searchEntries(entries, messages, "the");
    expect(r.length).toBeGreaterThan(0);
  });

  // ── line-based snippet ──

  it("snippet shows context lines around match", () => {
    const multiline = "line 0\nline 1\nline 2 TARGET\nline 3\nline 4\nline 5";
    const e: RenderedEntry[] = [{ index: 0, role: "user", summary: "test" }];
    const m: Message[] = [{ role: "user", content: multiline } as any];
    const r = searchEntries(e, m, "TARGET");
    expect(r).toHaveLength(1);
    const snip = r[0].snippet!;
    expect(snip).toContain("line 2 TARGET");
    expect(snip).toContain("line 0");
    expect(snip).toContain("line 4");
    expect(snip).not.toContain("line 5");
  });

  it("snippet handles match at beginning", () => {
    const multiline = "TARGET here\nline 1\nline 2\nline 3";
    const e: RenderedEntry[] = [{ index: 0, role: "user", summary: "test" }];
    const m: Message[] = [{ role: "user", content: multiline } as any];
    const r = searchEntries(e, m, "TARGET");
    const snip = r[0].snippet!;
    expect(snip).toContain("TARGET here");
    expect(snip).toContain("line 2");
    expect(snip).not.toContain("line 3");
  });

  // ── file content searchability (Phase 1) ──

  it("finds text written via tool call content field", () => {
    const e: RenderedEntry[] = [
      { index: 0, role: "assistant", summary: "write path=a.ts" },
    ];
    const m: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me write the file" },
          {
            type: "toolCall",
            id: "tc1",
            name: "write",
            arguments: {
              path: "auth.ts",
              content: "function rateLimitExceeded() { return true; }",
            },
          },
        ],
      } as any,
    ];
    const r = searchEntries(e, m, "rateLimitExceeded");
    expect(r).toHaveLength(1);
    expect(r[0].index).toBe(0);
  });

  it("finds text from edit tool call edits array", () => {
    const e: RenderedEntry[] = [
      { index: 0, role: "assistant", summary: "edit path=main.go" },
    ];
    const m: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc1",
            name: "edit",
            arguments: {
              path: "main.go",
              edits: [
                { oldText: "func old() {}", newText: "func new() {}" },
              ],
            },
          },
        ],
      } as any,
    ];
    const r = searchEntries(e, m, "func new()");
    expect(r).toHaveLength(1);
    expect(r[0].index).toBe(0);
  });

  it("finds text from hex_edit tool call oldText", () => {
    const e: RenderedEntry[] = [
      { index: 0, role: "assistant", summary: "hex_edit path=config.yaml" },
    ];
    const m: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc1",
            name: "hex_edit",
            arguments: {
              path: "config.yaml",
              oldText: "debug: false",
              newText: "debug: true",
            },
          },
        ],
      } as any,
    ];
    const r = searchEntries(e, m, "debug: false");
    expect(r).toHaveLength(1);
    expect(r[0].index).toBe(0);
  });

  // ── mode filtering (Phase 4) ──

  it("mode:'file' only searches tool call args, not transcript text", () => {
    const e: RenderedEntry[] = [
      { index: 0, role: "assistant", summary: "summary" },
    ];
    const m: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "The user wants login fix" },
          {
            type: "toolCall",
            id: "tc1",
            name: "write",
            arguments: {
              path: "auth.ts",
              content: "function login() { return true; }",
            },
          },
        ],
      } as any,
    ];
    // "login" appears in both transcript + file content — should match both
    const hybrid = searchEntries(e, m, "login");
    expect(hybrid).toHaveLength(1);

    // "login" in file mode should match (from tool call content)
    const fileMode = searchEntries(e, m, "login", undefined, "file");
    expect(fileMode).toHaveLength(1);

    // "user wants" in file mode should NOT match (only in transcript)
    const noMatch = searchEntries(e, m, "user wants", undefined, "file");
    expect(noMatch).toHaveLength(0);

  });

  it("mode:'file' populates fileMatches correctly", () => {
    const e: RenderedEntry[] = [
      { index: 0, role: "assistant", summary: "write step" },
    ];
    const m: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc1",
            name: "write",
            arguments: {
              path: "auth.ts",
              content: "function login() { return true; }",
            },
          },
        ],
      } as any,
    ];
    const r = searchEntries(e, m, "login", undefined, "file");
    expect(r).toHaveLength(1);
    expect(r[0].fileMatches).toBeDefined();
    expect(r[0].fileMatches![0].toolName).toBe("write");
    expect(r[0].fileMatches![0].path).toBe("auth.ts");
  });

  it("mode field works with regex queries", () => {
    const e: RenderedEntry[] = [
      { index: 0, role: "assistant", summary: "editing" },
    ];
    const m: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me fix" },
          {
            type: "toolCall",
            id: "tc1",
            name: "edit",
            arguments: {
              path: "main.go",
              edits: [{ oldText: "old version", newText: "new version" }],
            },
          },
        ],
      } as any,
    ];
    // regex in file mode should match edit content (same line)
    const r = searchEntries(e, m, "old.*version", undefined, "file");
    expect(r).toHaveLength(1);

  });

  it("mode:'file' does not include bash command output", () => {
    const e: RenderedEntry[] = [
      { index: 0, role: "assistant", summary: "ran bash" },
    ];
    const m: Message[] = [
      {
        role: "bashExecution" as any,
        command: "echo secret_api_key",
        output: "secret_api_key",
      } as any,
    ];
    // In mode:'file', bash output should NOT be searchable
    const r = searchEntries(e, m, "secret_api_key", undefined, "file");
    expect(r).toHaveLength(0);
    // In hybrid mode, bash output should still be searchable (existing behavior)
    const hybrid = searchEntries(e, m, "secret_api_key");
    expect(hybrid).toHaveLength(1);
  });

});
