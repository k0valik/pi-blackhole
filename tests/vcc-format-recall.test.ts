/**
 * Ported from upstream pi-vcc
 * Changes: bun:test → vitest, added .js import extensions
 */
import { describe, it, expect } from "vitest";
import { formatRecallOutput, formatTouchedOutput, shortPath } from "../src/core/format-recall.js";
import type { SearchHit, TouchedFile } from "../src/core/search-entries.js";

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

  it("shortens long absolute paths in file indicators", () => {
    const entries: SearchHit[] = [
      {
        index: 42,
        role: "assistant",
        summary: "done",
        id: "e1",
        fileMatches: [
          { toolName: "write", path: "/home/user/project/src/auth.ts", lineCount: 3 },
        ],
      },
    ];
    const r = formatRecallOutput(entries);
    // Label uses shortened path (last 3 components), not full absolute
    expect(r).toContain("[write] .../project/src/auth.ts");
    // Drill-down hint uses original path (not shortened)
    expect(r).toContain("#42:/home/user/project/src/auth.ts");
  });

  it("keeps short paths as-is in file indicators", () => {
    const entries: SearchHit[] = [
      {
        index: 5,
        role: "assistant",
        summary: "done",
        id: "e1",
        fileMatches: [
          { toolName: "write", path: "auth.ts", lineCount: 1 },
        ],
      },
    ];
    const r = formatRecallOutput(entries);
    expect(r).toContain("[write] auth.ts");
    expect(r).toContain("#5:auth.ts");
  });
});

// ── Touched output ──────────────────────────────────────────────────────────

describe("formatTouchedOutput", () => {
  it("shows empty message for empty list", () => {
    const r = formatTouchedOutput([], undefined);
    expect(r).toContain("No file operations");
  });

  it("groups file operations by path with entry indices", () => {
    const touched: TouchedFile[] = [
      {
        path: "src/auth.ts",
        entries: [
          { index: 3, toolName: "write" },
          { index: 8, toolName: "edit" },
        ],
      },
      {
        path: "src/config.go",
        entries: [{ index: 5, toolName: "write" }],
      },
    ];
    const r = formatTouchedOutput(touched, undefined);
    expect(r).toContain("src/auth.ts");
    expect(r).toContain("#3 (write)");
    expect(r).toContain("#8 (edit)");
    expect(r).toContain("src/config.go");
    expect(r).toContain("#5 (write)");
  });

  it("paginates touched file list", () => {
    const touched: TouchedFile[] = Array.from({ length: 10 }, (_, i) => ({
      path: `file${i}.ts`,
      entries: [{ index: i, toolName: "write" }],
    }));
    // Page 1 (PAGE_SIZE=5)
    const page1 = formatTouchedOutput(touched, 1, 5);
    expect(page1).toContain("Page 1/2");
    expect(page1).toContain("file0.ts");
    expect(page1).toContain("file4.ts");
    expect(page1).not.toContain("file5.ts");

    // Page 2
    const page2 = formatTouchedOutput(touched, 2, 5);
    expect(page2).toContain("Page 2/2");
    expect(page2).toContain("file5.ts");
    expect(page2).toContain("file9.ts");
  });
});

// ── shortPath ───────────────────────────────────────────────────────────────

describe("shortPath", () => {
  it("returns path relative to cwd when path starts with cwd", () => {
    const cwd = process.cwd();
    const abs = `${cwd}/src/auth.ts`;
    expect(shortPath(abs)).toBe("./src/auth.ts");
  });

  it("returns last 3 components for long paths outside cwd", () => {
    const r = shortPath("/some/other/project/src/middleware/auth.ts");
    expect(r).toBe(".../src/middleware/auth.ts");
  });

  it("keeps short paths as-is", () => {
    expect(shortPath("auth.ts")).toBe("auth.ts");
    expect(shortPath("src/auth.ts")).toBe("src/auth.ts");
  });

  it("handles paths with 2-3 components correctly", () => {
    expect(shortPath("a/b.ts")).toBe("a/b.ts");
    expect(shortPath("a/b/c.ts")).toBe("a/b/c.ts");
  });

  it("normalizes backslashes to forward slashes (cross-platform)", () => {
    // Windows path — should fall through to last-3-components shortening
    // (CWD is a Linux path so C:\ prefix won't match it)
    const result = shortPath("C:\\Users\\user\\project\\src\\auth.ts");
    expect(result).toBe(".../project/src/auth.ts");
  });
});
