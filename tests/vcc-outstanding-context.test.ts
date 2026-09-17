import { describe, it, expect } from "vitest";
import { buildSections } from "../src/core/build-sections.js";
import type { NormalizedBlock } from "../src/types.js";

const assistant = (text: string): NormalizedBlock => ({ kind: "assistant", text });
const user = (text: string): NormalizedBlock => ({ kind: "user", text });
const filler = (n: number): NormalizedBlock[] =>
  Array.from({ length: n }, (_, i) =>
    assistant(`Implemented step ${i} of the migration plan successfully.`),
  );

describe("extractOutstandingContext — window", () => {
  it("captures a blocker raised early in a long session", () => {
    const blocks: NormalizedBlock[] = [
      assistant("The streaming parser is still broken after the retry."),
      ...filler(60),
    ];
    const r = buildSections({ blocks });
    expect(r.outstandingContext.length).toBeGreaterThan(0);
    expect(r.outstandingContext[0]).toContain("still broken");
  });

  it("keeps the most recent 5 blockers when more exist", () => {
    const blocks: NormalizedBlock[] = [
      assistant(`Blocker number one is unresolved and stuck.`),
      assistant(`Blocker number two is unresolved and stuck.`),
      assistant(`Blocker number three is unresolved and stuck.`),
      assistant(`Blocker number four is unresolved and stuck.`),
      assistant(`Blocker number five is unresolved and stuck.`),
      assistant(`Blocker number six is unresolved and stuck.`),
      assistant(`Blocker number seven is unresolved and stuck.`),
    ];
    const r = buildSections({ blocks });
    expect(r.outstandingContext.length).toBe(5);
    // earliest two dropped, most recent kept
    const joined = r.outstandingContext.join("\n");
    expect(joined).not.toContain("number one");
    expect(joined).not.toContain("number two");
    expect(joined).toContain("number seven");
  });

  it("deduplicates repeated blockers by normalized text, latest wording wins", () => {
    const blocks: NormalizedBlock[] = [
      assistant("The CI pipeline is still failing on windows runners."),
      ...filler(30),
      assistant("The CI pipeline is still failing on windows runners."),
    ];
    const r = buildSections({ blocks });
    const hits = r.outstandingContext.filter((l) => l.includes("CI pipeline"));
    expect(hits.length).toBe(1);
  });
});

describe("extractOutstandingContext — precision (must not appear)", () => {
  it("still requires an ASCII capital / quote start for English lines", () => {
    const r = buildSections({ blocks: [assistant("still broken after the fix")] });
    expect(r.outstandingContext).toEqual([]);
  });

  it("still skips continuation fragments even with blocker keywords", () => {
    const blocks: NormalizedBlock[] = [
      assistant("- still failing on the retry path"),
      assistant("(still failing intermittently)"),
      assistant("> still broken, see ticket"),
    ];
    const r = buildSections({ blocks });
    expect(r.outstandingContext).toEqual([]);
  });

  it("does not flag CJK lines without a failure stem", () => {
    for (const text of ["这个测试通过了", "代码看起来不错", "我们把文档更新一下吧"]) {
      expect(buildSections({ blocks: [user(text)] }).outstandingContext).toEqual([]);
    }
  });

  it("does not flag short chatter", () => {
    expect(buildSections({ blocks: [user("hi")] }).outstandingContext).toEqual([]);
  });
});

describe("extractOutstandingContext — CJK blockers", () => {
  it("captures a CJK user blocker", () => {
    const r = buildSections({ blocks: [user("测试还是失败，怎么办")] });
    expect(r.outstandingContext.length).toBe(1);
    expect(r.outstandingContext[0]).toContain("[user]");
    expect(r.outstandingContext[0]).toContain("测试还是失败");
  });

  it("captures a CJK assistant blocker", () => {
    const r = buildSections({ blocks: [assistant("数据库连接还是报错，重试三次后卡住")] });
    expect(r.outstandingContext.length).toBe(1);
    expect(r.outstandingContext[0]).toContain("数据库连接还是报错");
  });

  it("captures a CJK blocker deep in the session", () => {
    const blocks: NormalizedBlock[] = [assistant("构建还是失败，找不到依赖"), ...filler(60)];
    const r = buildSections({ blocks });
    expect(r.outstandingContext.length).toBe(1);
  });
});

describe("extractOutstandingContext — CJK precision (#105 follow-up)", () => {
  it("does not flag error-handling mechanism discussion", () => {
    // 错误处理 describes mechanism, not malfunction — the old stem test
    // fired on this.
    for (const text of [
      "我们需要给解析器添加错误处理逻辑",
      "错误码的定义放在 constants 里",
      "失败率最近降到了 1%",
    ]) {
      expect(buildSections({ blocks: [assistant(text)] }).outstandingContext).toEqual([]);
    }
  });

  it("still fires when a real stem survives beside benign compounds", () => {
    // Stripping 错误处理 must not swallow the residual 报错.
    const r = buildSections({ blocks: [assistant("错误处理逻辑里还是报错，启动失败")] });
    expect(r.outstandingContext.length).toBe(1);
  });

  it("captures short CJK failure reports", () => {
    // 失败了 is complete at 3 chars; the old 5-char floor dropped it.
    const r = buildSections({ blocks: [user("失败了")] });
    expect(r.outstandingContext.length).toBe(1);
  });

  it("captures bracket-led CJK blocker headings", () => {
    const r = buildSections({ blocks: [assistant("【报错】服务启动失败，端口被占用")] });
    expect(r.outstandingContext.length).toBe(1);
    expect(r.outstandingContext[0]).toContain("服务启动失败");
  });
});

describe("extractOutstandingContext — tool errors unchanged", () => {
  it("still reports tool errors", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_result", name: "bash", text: "command not found: bunx", isError: true },
      ...filler(25),
    ];
    const r = buildSections({ blocks });
    expect(r.outstandingContext.some((l) => l.includes("[bash]"))).toBe(true);
  });
});
