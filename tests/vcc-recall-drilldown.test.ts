/**
 * Phase 3 tests: #N:path drill-down for tool call file content.
 *
 * Tests the expandEntryFile() function that resolves #42:auth.ts
 * to the file content of the matching tool call in entry 42.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("parseDrillDown", () => {
  it("parses #N:path", async () => {
    const { parseDrillDown } = await import("../src/core/drill-down.js");
    const r = parseDrillDown("#42:auth.ts");
    expect(r).toEqual({ index: 42, pathPattern: "auth.ts", full: false });
  });

  it("parses #N:path:full", async () => {
    const { parseDrillDown } = await import("../src/core/drill-down.js");
    const r = parseDrillDown("#42:auth.ts:full");
    expect(r).toEqual({ index: 42, pathPattern: "auth.ts", full: true });
  });

  it("parses #N:file (keyword)", async () => {
    const { parseDrillDown } = await import("../src/core/drill-down.js");
    const r = parseDrillDown("#42:file");
    expect(r).toEqual({ index: 42, pathPattern: "file", full: false });
  });

  it("returns null for non-matching queries", async () => {
    const { parseDrillDown } = await import("../src/core/drill-down.js");
    expect(parseDrillDown("#42")).toBeNull(); // no colon = plain expand, not drill-down
    expect(parseDrillDown("hello")).toBeNull();
    expect(parseDrillDown("#abc:file")).toBeNull(); // non-numeric index
  });

  it("does NOT match plain #N (no colon) — leaves that for VCC_ENTRY_PATTERN", async () => {
    const { parseDrillDown } = await import("../src/core/drill-down.js");
    // Plain #42 should NOT match drill-down (no colon)
    expect(parseDrillDown("#42")).toBeNull();
    // But #42:anything should
    expect(parseDrillDown("#42:x")).not.toBeNull();
  });
});

describe("expandEntryFile", () => {
  it("returns content from a write tool call matching the given path pattern", async () => {
    const { expandEntryFile } = await import("../src/core/drill-down.js");
    const dir = mkdtempSync(join(tmpdir(), "drilldown-tc-"));
    const file = join(dir, "session.jsonl");
    try {
      const lines = [
        JSON.stringify({
          type: "message",
          id: "m1",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tc1",
                name: "write",
                arguments: {
                  path: "auth.ts",
                  content: "function login() {\n  return true;\n}\n",
                },
              },
            ],
          },
        }),
      ];
      writeFileSync(file, lines.join("\n") + "\n", "utf8");

      const result = expandEntryFile(file, 0, "auth.ts");
      expect(result).toContain("auth.ts");
      expect(result).toContain("function login()");
      expect(result).toContain("return true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns full content with :full suffix", async () => {
    const { expandEntryFile } = await import("../src/core/drill-down.js");
    const dir = mkdtempSync(join(tmpdir(), "drilldown-full-"));
    const file = join(dir, "session.jsonl");
    try {
      const longContent = Array.from({ length: 50 }, (_, i) => `line ${i + 1}: some content`).join("\n");
      const lines = [
        JSON.stringify({
          type: "message",
          id: "m1",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tc1",
                name: "write",
                arguments: {
                  path: "long.ts",
                  content: longContent,
                },
              },
            ],
          },
        }),
      ];
      writeFileSync(file, lines.join("\n") + "\n", "utf8");

      const result = expandEntryFile(file, 0, "long.ts", true);
      expect(result).toContain("line 50: some content");
      expect(result.split("\n").length).toBeGreaterThan(50);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns error message when entry index is out of range", async () => {
    const { expandEntryFile } = await import("../src/core/drill-down.js");
    const dir = mkdtempSync(join(tmpdir(), "drilldown-empty-"));
    const file = join(dir, "session.jsonl");
    try {
      writeFileSync(file, "\n", "utf8");
      const result = expandEntryFile(file, 42, "auth.ts");
      expect(result).toContain("not found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns error message when no matching tool call is found", async () => {
    const { expandEntryFile } = await import("../src/core/drill-down.js");
    const dir = mkdtempSync(join(tmpdir(), "drilldown-no-tc-"));
    const file = join(dir, "session.jsonl");
    try {
      const lines = [
        JSON.stringify({
          type: "message",
          id: "m1",
          message: {
            role: "user",
            content: "hello",
          },
        }),
      ];
      writeFileSync(file, lines.join("\n") + "\n", "utf8");
      const result = expandEntryFile(file, 0, "auth.ts");
      expect(result).toContain("No file content found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles #42:file keyword with single content-bearing call", async () => {
    const { expandEntryFile } = await import("../src/core/drill-down.js");
    const dir = mkdtempSync(join(tmpdir(), "drilldown-filekw-"));
    const file = join(dir, "session.jsonl");
    try {
      const lines = [
        JSON.stringify({
          type: "message",
          id: "m1",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tc1",
                name: "write",
                arguments: {
                  path: "config.json",
                  content: '{"key": "value"}',
                },
              },
            ],
          },
        }),
      ];
      writeFileSync(file, lines.join("\n") + "\n", "utf8");
      const result = expandEntryFile(file, 0, "file");
      expect(result).toContain("config.json");
      expect(result).toContain('"key": "value"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists options when #42:file matches multiple content-bearing calls", async () => {
    const { expandEntryFile } = await import("../src/core/drill-down.js");
    const dir = mkdtempSync(join(tmpdir(), "drilldown-multi-"));
    const file = join(dir, "session.jsonl");
    try {
      const lines = [
        JSON.stringify({
          type: "message",
          id: "m1",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tc1",
                name: "write",
                arguments: {
                  path: "a.ts",
                  content: "// a",
                },
              },
              {
                type: "toolCall",
                id: "tc2",
                name: "write",
                arguments: {
                  path: "b.ts",
                  content: "// b",
                },
              },
            ],
          },
        }),
      ];
      writeFileSync(file, lines.join("\n") + "\n", "utf8");
      const result = expandEntryFile(file, 0, "file");
      expect(result).toContain("2 file operations");
      expect(result).toContain("a.ts");
      expect(result).toContain("b.ts");
      expect(result).toContain("#0:a.ts");
      expect(result).toContain("#0:b.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles edit tool calls with edits[] array", async () => {
    const { expandEntryFile } = await import("../src/core/drill-down.js");
    const dir = mkdtempSync(join(tmpdir(), "drilldown-edit-"));
    const file = join(dir, "session.jsonl");
    try {
      const lines = [
        JSON.stringify({
          type: "message",
          id: "m1",
          message: {
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
          },
        }),
      ];
      writeFileSync(file, lines.join("\n") + "\n", "utf8");
      const result = expandEntryFile(file, 0, "main.go");
      expect(result).toContain("main.go");
      expect(result).toContain("func old()");
      expect(result).toContain("func new()");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recognizes filePath, file_path, and file as path keys", async () => {
    const { expandEntryFile } = await import("../src/core/drill-down.js");

    // Test filePath key (used by read tool)
    const dir = mkdtempSync(join(tmpdir(), "drilldown-fp-"));
    const file = join(dir, "session.jsonl");
    try {
      const lines = [
        JSON.stringify({
          type: "message",
          id: "m1",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tc1",
                name: "read",
                arguments: {
                  filePath: "README.md",
                },
              },
              {
                type: "toolCall",
                id: "tc2",
                name: "write",
                arguments: {
                  file_path: "config.yaml",
                  content: "key: value\n",
                },
              },
            ],
          },
        }),
      ];
      writeFileSync(file, lines.join("\n") + "\n", "utf8");
      // filePath key should be recognized but "read" calls aren't content-bearing
      // (no content field), so it won't appear as a content-bearing call.
      const result = expandEntryFile(file, 0, "config.yaml");
      expect(result).toContain("config.yaml");
      expect(result).toContain("key: value");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("matches path substrings", async () => {
    const { expandEntryFile } = await import("../src/core/drill-down.js");
    const dir = mkdtempSync(join(tmpdir(), "drilldown-substr-"));
    const file = join(dir, "session.jsonl");
    try {
      const lines = [
        JSON.stringify({
          type: "message",
          id: "m1",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tc1",
                name: "write",
                arguments: {
                  path: "src/middleware/auth.ts",
                  content: "export function authorize() {}",
                },
              },
            ],
          },
        }),
      ];
      writeFileSync(file, lines.join("\n") + "\n", "utf8");
      const result = expandEntryFile(file, 0, "auth.ts");
      expect(result).toContain("export function authorize()");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
