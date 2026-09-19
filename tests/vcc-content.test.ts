/**
 * Ported from upstream pi-vcc
 * Changes: bun:test → vitest, added .js import extensions
 */
import { describe, it, expect } from "vitest";
import { clip, clipSentence, textParts, textOf } from "../src/core/content.js";

describe("textParts", () => {
  it("returns [] for undefined content", () => {
    expect(textParts(undefined as any)).toEqual([]);
  });

  it("returns [] for null content", () => {
    expect(textParts(null as any)).toEqual([]);
  });

  it("wraps string content", () => {
    expect(textParts("hello")).toEqual(["hello"]);
  });

  it("extracts text parts from array content", () => {
    const content = [
      { type: "text" as const, text: "first" },
      { type: "toolCall" as const, name: "x", id: "1", arguments: {} },
      { type: "text" as const, text: "second" },
    ];
    expect(textParts(content)).toEqual(["first", "second"]);
  });
});

describe("textOf", () => {
  it("returns empty string for undefined content", () => {
    expect(textOf(undefined as any)).toBe("");
  });
});

describe("toolCallArgsText", () => {
  it("returns empty string for string content", async () => {
    const { toolCallArgsText } = await import("../src/core/content.js");
    expect(toolCallArgsText("hello")).toBe("");
  });

  it("returns empty string for undefined content", async () => {
    const { toolCallArgsText } = await import("../src/core/content.js");
    expect(toolCallArgsText(undefined as any)).toBe("");
  });

  it("returns empty string when no tool calls are present", async () => {
    const { toolCallArgsText } = await import("../src/core/content.js");
    const content = [{ type: "text", text: "hello" }];
    expect(toolCallArgsText(content)).toBe("");
  });

  it("extracts content field from a write tool call", async () => {
    const { toolCallArgsText } = await import("../src/core/content.js");
    const content = [
      {
        type: "toolCall",
        id: "tc1",
        name: "write",
        arguments: {
          path: "auth.ts",
          content: "function login() {\n  return true;\n}",
        },
      },
    ];
    const result = toolCallArgsText(content);
    expect(result).toContain("function login()");
    expect(result).toContain("return true");
  });

  it("extracts edits[] array from an edit tool call", async () => {
    const { toolCallArgsText } = await import("../src/core/content.js");
    const content = [
      {
        type: "toolCall",
        id: "tc1",
        name: "edit",
        arguments: {
          path: "main.go",
          edits: [{ oldText: "func old() {}", newText: "func new() {}" }],
        },
      },
    ];
    const result = toolCallArgsText(content);
    expect(result).toContain("func old()");
    expect(result).toContain("func new()");
  });

  it("skips tool calls without path or content-bearing fields", async () => {
    const { toolCallArgsText } = await import("../src/core/content.js");
    const content = [
      {
        type: "toolCall",
        id: "tc1",
        name: "read",
        arguments: { filePath: "README.md" },
      },
      {
        type: "toolCall",
        id: "tc2",
        name: "bash",
        arguments: { command: "ls" },
      },
    ];
    // No content-bearing fields — no path + content/edits combo
    expect(toolCallArgsText(content)).toBe("");
  });

  it("caps extracted text at 10KB per call", async () => {
    const { toolCallArgsText } = await import("../src/core/content.js");
    const bigContent = "x".repeat(20000);
    const content = [
      {
        type: "toolCall",
        id: "tc1",
        name: "write",
        arguments: {
          path: "big.ts",
          content: bigContent,
        },
      },
    ];
    const result = toolCallArgsText(content);
    expect(result.length).toBeLessThanOrEqual(10240);
  });

  it("extracts from multiple tool calls in one message", async () => {
    const { toolCallArgsText } = await import("../src/core/content.js");
    const content = [
      {
        type: "toolCall",
        id: "tc1",
        name: "write",
        arguments: { path: "a.ts", content: "// file A" },
      },
      {
        type: "toolCall",
        id: "tc2",
        name: "edit",
        arguments: {
          path: "b.ts",
          oldText: "old code",
          newText: "new code",
        },
      },
    ];
    const result = toolCallArgsText(content);
    expect(result).toContain("// file A");
    expect(result).toContain("old code");
    expect(result).toContain("new code");
  });
});

describe("isContentBearing", () => {
  it("returns true for args with path + content string", async () => {
    const { isContentBearing } = await import("../src/core/content.js");
    expect(isContentBearing({ path: "auth.ts", content: "function login() {}" })).toBe(true);
  });

  it("returns true for args with path + edits array", async () => {
    const { isContentBearing } = await import("../src/core/content.js");
    expect(
      isContentBearing({
        path: "main.go",
        edits: [{ oldText: "a", newText: "b" }],
      }),
    ).toBe(true);
  });

  it("returns true for args with path + oldText/newText", async () => {
    const { isContentBearing } = await import("../src/core/content.js");
    expect(isContentBearing({ path: "config.yaml", oldText: "a", newText: "b" })).toBe(true);
  });

  it("returns false for args without a path", async () => {
    const { isContentBearing } = await import("../src/core/content.js");
    expect(isContentBearing({ content: "hello" })).toBe(false);
    expect(isContentBearing({ command: "ls" })).toBe(false);
  });

  it("returns false for args with path but no content-bearing fields", async () => {
    const { isContentBearing } = await import("../src/core/content.js");
    // A read tool call has a path but no content/edits/oldText/newText
    expect(isContentBearing({ path: "README.md" })).toBe(false);
    expect(isContentBearing({ filePath: "README.md" })).toBe(false);
  });

  it("returns false for empty/null args", async () => {
    const { isContentBearing } = await import("../src/core/content.js");
    expect(isContentBearing({})).toBe(false);
    expect(isContentBearing(null as any)).toBe(false);
    expect(isContentBearing(undefined as any)).toBe(false);
  });

  it("recognizes filePath, file_path, and file as path keys", async () => {
    const { isContentBearing } = await import("../src/core/content.js");
    expect(isContentBearing({ filePath: "x.ts", content: "a" })).toBe(true);
    expect(isContentBearing({ file_path: "x.ts", content: "a" })).toBe(true);
    expect(isContentBearing({ file: "x.ts", content: "a" })).toBe(true);
  });
});

describe("clipSentence — CJK sentence boundaries (#106)", () => {
  it("cuts after a CJK ideographic full stop without trailing space", () => {
    const head = "中".repeat(55);
    const text = `${head}。后面还有更多中文内容没有结束`;
    expect(clipSentence(text, 60)).toBe(`${head}。`);
  });

  it("cuts after a fullwidth exclamation mark followed directly by text", () => {
    const head = "啊".repeat(50);
    const text = `${head}！然后继续说话说个不停说个不停说个不停说个不停`;
    expect(clipSentence(text, 60)).toBe(`${head}！`);
  });

  it("keeps English behavior: cut after '.' followed by space", () => {
    // '.' at index 16, end 17 ≥ 30*0.5=15 → accepted by the sentence window
    const text = `Some words here. ${"b".repeat(40)}`;
    expect(clipSentence(text, 30)).toBe("Some words here.");
  });

  it("keeps English behavior: no cut mid-word without space", () => {
    const text = `firstsecond${"c".repeat(60)}`;
    // No sentence boundary in the window and no space → hard cut via clip()
    expect(clipSentence(text, 40)).toBe(text.slice(0, 40));
  });

  it("falls back to clip() when no CJK sentence terminator is in the window", () => {
    const text = `${"中".repeat(40)}，${"文".repeat(40)}`;
    // No 。！？ in the window → clip() → CJK pause fallback cuts after ，
    expect(clipSentence(text, 50)).toBe(`${"中".repeat(40)}，`);
  });
});

describe("clip — CJK word boundaries (#106)", () => {
  it("cuts at the last CJK pause punctuation instead of a hard char cut", () => {
    const text = `${"中".repeat(40)}，${"文".repeat(40)}`;
    expect(clip(text, 50)).toBe(`${"中".repeat(40)}，`);
  });

  it("falls back to a hard cut when no CJK pause punctuation is in the window", () => {
    const text = "中".repeat(80);
    expect(clip(text, 50)).toBe("中".repeat(50));
  });

  it("keeps English behavior: cut at the last space", () => {
    expect(clip("alpha beta gamma", 10)).toBe("alpha beta");
  });

  it("keeps English behavior: hard cut when no space in the acceptable range", () => {
    expect(clip("abcdefghij", 5)).toBe("abcde");
  });

  it("still avoids splitting a surrogate pair", () => {
    const text = `${"a".repeat(9)}𠮷${"b".repeat(20)}`;
    // U+20BB7 is outside the CJK script classes → space path → surrogate guard
    expect(clip(text, 10)).toBe("a".repeat(9));
  });
});
