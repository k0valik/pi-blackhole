import { describe, it, expect } from "vitest";
import { extractPreferences } from "../src/extract/preferences.js";
import type { NormalizedBlock } from "../src/types.js";

describe("extractPreferences", () => {
  it("returns empty for no blocks", () => {
    expect(extractPreferences([])).toEqual([]);
  });

  it("captures preference patterns from user", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "I prefer TypeScript over JavaScript" },
    ];
    expect(extractPreferences(blocks).length).toBe(1);
  });

  it("ignores assistant blocks", () => {
    const blocks: NormalizedBlock[] = [{ kind: "assistant", text: "I always use best practices" }];
    expect(extractPreferences(blocks)).toEqual([]);
  });

  it("captures please use pattern", () => {
    const blocks: NormalizedBlock[] = [{ kind: "user", text: "please use bun instead of node" }];
    expect(extractPreferences(blocks).length).toBe(1);
  });
});

describe("extractPreferences — question gate precision", () => {
  it("captures a directive phrased as a question", () => {
    // "Can you …" is a request, not an information question.
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Can you always run tests before pushing?" },
    ];
    expect(extractPreferences(blocks).length).toBe(1);
  });

  it("still drops information questions", () => {
    for (const text of [
      "What should I use here?",
      "How do I enable debug logging?",
      "Which do you prefer?",
      "为什么这里是 any？",
    ]) {
      expect(extractPreferences([{ kind: "user", text }])).toEqual([]);
    }
  });
});

describe("extractPreferences — correction anchors (English)", () => {
  it("captures stop-doing corrections", () => {
    expect(extractPreferences([{ kind: "user", text: "stop using var in new code" }]).length).toBe(
      1,
    );
  });

  it("captures that-is-wrong corrections", () => {
    expect(
      extractPreferences([
        { kind: "user", text: "that's wrong, the config goes in unified-config.ts" },
      ]).length,
    ).toBe(1);
  });

  it("captures revert/undo directives", () => {
    expect(
      extractPreferences([{ kind: "user", text: "please revert that change to the extractor" }])
        .length,
    ).toBe(1);
  });

  it("does not capture bare instead-lines (no correction marker)", () => {
    expect(
      extractPreferences([{ kind: "user", text: "let's try the other approach instead" }]),
    ).toEqual([]);
  });
});

describe("extractPreferences — CJK corrections", () => {
  it("captures 不要 directives", () => {
    const blocks: NormalizedBlock[] = [{ kind: "user", text: "不要用 any 类型，用具体类型" }];
    expect(extractPreferences(blocks).length).toBe(1);
  });

  it("captures 先不要 scoped deferrals", () => {
    expect(extractPreferences([{ kind: "user", text: "先不要管上面的了" }]).length).toBe(1);
  });

  it("captures 回退 directives", () => {
    expect(extractPreferences([{ kind: "user", text: "回退这个改动" }]).length).toBe(1);
  });

  it("captures 不用 directives", () => {
    expect(extractPreferences([{ kind: "user", text: "不用加注释了，代码自解释" }]).length).toBe(1);
  });

  it("captures CJK directive ending with fullwidth stop", () => {
    expect(
      extractPreferences([{ kind: "user", text: "以后不要用 pnpm run dev，用 vitest。" }]).length,
    ).toBe(1);
  });

  it("does not capture CJK chatter without a correction marker", () => {
    for (const text of [
      "都要修复正确哦",
      "这个功能看起来不错",
      "只清理残留文件",
      "测试都通过了，辛苦",
    ]) {
      expect(extractPreferences([{ kind: "user", text }])).toEqual([]);
    }
  });

  it("does not capture assistant CJK text", () => {
    expect(extractPreferences([{ kind: "assistant", text: "不要担心，我会修复的" }])).toEqual([]);
  });
});

describe("extractPreferences — CJK standing instructions (#105 follow-up)", () => {
  it("captures a bare 2-char correction (回退)", () => {
    // The old 5-char floor dropped this before the pattern ever ran, even
    // though the issue quotes it as a missed user correction.
    expect(extractPreferences([{ kind: "user", text: "回退" }]).length).toBe(1);
  });

  it("captures 记住 directives", () => {
    expect(extractPreferences([{ kind: "user", text: "记住提交信息用中文" }]).length).toBe(1);
  });

  it("captures 以后/下次/必须 future-scoped instructions", () => {
    for (const text of [
      "以后提交前先跑一遍测试",
      "下次记得更新 changelog",
      "必须用 pnpm，不能用 npm",
    ]) {
      expect(extractPreferences([{ kind: "user", text }]).length).toBe(1);
    }
  });

  it("does not capture 记住 acknowledgements", () => {
    // 记住了/记住吧/记住哦 acknowledges a previous message — no directive.
    for (const text of ["记住了", "记住了，谢谢", "记住吧"]) {
      expect(extractPreferences([{ kind: "user", text }])).toEqual([]);
    }
  });

  it("does not capture chatter containing excluded broad negatives", () => {
    for (const text of ["别人都说这个方案好", "如果不行的话就告诉我", "这个不对吧，我再看看"]) {
      expect(extractPreferences([{ kind: "user", text }])).toEqual([]);
    }
  });
});
