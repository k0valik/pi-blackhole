/**
 * Ported from upstream pi-vcc
 * Changes: bun:test → vitest, added .js import extensions
 */
import { describe, it, expect } from "vitest";
import { formatRecallOutput } from "../src/core/format-recall.js";
import type { SearchHit } from "../src/core/search-entries.js";

describe("formatRecallOutput", () => {
  it("shows no-match message with query", () => {
    const r = formatRecallOutput([], "xyz");
    expect(r).toContain('No matches for "xyz"');
  });

  it("shows no-entries message without query", () => {
    expect(formatRecallOutput([])).toContain("No entries");
  });

  it("formats entries with index and role", () => {
    const entries: SearchHit[] = [
      { index: 0, role: "user", summary: "hello", id: "1" },
    ];
    const r = formatRecallOutput(entries);
    expect(r).toContain("#0 [user] hello");
  });

  it("shows match count with query", () => {
    const entries: SearchHit[] = [
      { index: 2, role: "assistant", summary: "done", id: "1" },
    ];
    const r = formatRecallOutput(entries, "done");
    expect(r).toContain('Found 1 matches for "done"');
  });

  it("renders file indicators for matched tool calls", () => {
    const entries: SearchHit[] = [
      {
        index: 42,
        role: "assistant",
        summary: "Let me write the auth handler...",
        id: "e1",
        fileMatches: [
          { toolName: "write", path: "auth.ts", lineCount: 3 },
          { toolName: "edit", path: "auth.ts", lineCount: 1 },
        ],
      },
    ];
    const r = formatRecallOutput(entries, "auth");
    expect(r).toContain("#42 [assistant]");
    expect(r).toContain("Let me write the auth handler...");
    expect(r).toContain("[write] auth.ts — 3 matches");
    expect(r).toContain("[edit] auth.ts — 1 match");
  });

  it("formats file indicators with use #N:path drill hint", () => {
    const entries: SearchHit[] = [
      {
        index: 42,
        role: "assistant",
        summary: "done",
        id: "e1",
        fileMatches: [
          { toolName: "write", path: "auth.ts", lineCount: 2 },
        ],
      },
    ];
    const r = formatRecallOutput(entries);
    expect(r).toContain("#42:auth.ts");
  });

  it("shows file match snippet inline under the file indicator", () => {
    const entries: SearchHit[] = [
      {
        index: 7,
        role: "assistant",
        summary: "done",
        id: "e1",
        snippet: "unrelated text",
        fileMatches: [
          {
            toolName: "write",
            path: "middleware.go",
            lineCount: 1,
            snippet: "func rateLimitExceeded(r *http.Request) bool {",
          },
        ],
      },
    ];
    const r = formatRecallOutput(entries, "rateLimitExceeded");
    // The snippet should appear inline under the file indicator
    expect(r).toContain("[write] middleware.go — 1 match");
    expect(r).toContain("    | func rateLimitExceeded");
  });

  it("still shows basic format when no fileMatches", () => {
    const entries: SearchHit[] = [
      { index: 0, role: "user", summary: "hello", id: "1" },
    ];
    const r = formatRecallOutput(entries);
    expect(r).toContain("#0 [user] hello");
  });
});
