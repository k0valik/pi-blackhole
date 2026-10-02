import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { buildSections, pathTokens } from "../src/core/build-sections.js";
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

describe("extractOutstandingContext — long tool output", () => {
  it.each([
    // Dotless blob: exercises the unanchored-rescan half of the fix.
    { kind: "dotless", isError: false, payload: `"A".repeat(30000)`, count: 0 },
    { kind: "dotless", isError: true, payload: `"A".repeat(30000)`, count: 1 },
    // Dot-bearing blob: exercises the overlapping-repetition (pre-dot
    // lookbehind) half. Reverting that half leaves the dotless cases green.
    { kind: "dotted", isError: false, payload: `"A.".repeat(15000)`, count: 0 },
    { kind: "dotted", isError: true, payload: `"A.".repeat(15000)`, count: 1 },
  ])(
    "finishes scanning a $kind long encoded tool result (isError=$isError)",
    ({ isError, payload, count }) => {
      // A synchronous regex hang also blocks an in-process test timeout.
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
          import { createRequire } from "node:module";
          const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
          const { createJiti } = require("jiti");
          const jiti = createJiti(import.meta.url, { fsCache: false });
          const { buildSections } = await jiti.import("./src/core/build-sections.ts");
          const text = JSON.stringify({ dbxs: [{ content: ${payload} }] });
          const t0 = performance.now();
          const sections = buildSections({
            blocks: [{ kind: "tool_result", name: "read", text, isError: ${isError} }],
          });
          console.log(JSON.stringify({ ms: performance.now() - t0, n: sections.outstandingContext.length }));
        `,
        ],
        // Startup (Node boot + jiti transpile, fsCache disabled) is charged
        // here too, so the deadline must exceed any plausible startup; the
        // scan itself is budgeted separately below from inside the child.
        { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 30_000 },
      );
      expect({
        error: child.error?.message,
        status: child.status,
        stdout: child.stdout,
        stderr: child.stderr,
      }).toEqual({ error: undefined, status: 0, stdout: expect.any(String), stderr: "" });
      const body = JSON.parse(child.stdout) as { ms?: unknown; n?: unknown };
      if (typeof body.ms !== "number" || typeof body.n !== "number") {
        throw new Error(`unexpected child output: ${child.stdout}`);
      }
      expect(body.n).toBe(count);
      expect(body.ms).toBeLessThan(5_000);
    },
  );
});

describe("extractOutstandingContext — path token bounds", () => {
  it("caps collected tokens on dot-dense input", () => {
    const distinct = Array.from({ length: 2000 }, (_, i) => `src/f${i}.txt`).join(" ");
    expect(pathTokens(distinct).size).toBeLessThanOrEqual(500);
  });

  it("still matches a path at the head before a large blob", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_result", name: "edit", text: "Could not update src/target.ts", isError: true },
      {
        kind: "tool_result",
        name: "edit",
        text: `Updated src/target.ts. ${"A".repeat(20000)}`,
        isError: false,
      },
    ];
    expect(buildSections({ blocks }).outstandingContext).toEqual([]);
  });

  it("still matches a path at the tail after a large blob", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_result", name: "edit", text: "Could not update src/target.ts", isError: true },
      {
        kind: "tool_result",
        name: "edit",
        text: `${"A".repeat(20000)} Updated src/target.ts.`,
        isError: false,
      },
    ];
    expect(buildSections({ blocks }).outstandingContext).toEqual([]);
  });
});

describe("extractOutstandingContext — retry-success extinguishes errors", () => {
  const call = (name: string, args: Record<string, unknown> = {}): NormalizedBlock => ({
    kind: "tool_call",
    name,
    args,
  });
  const ok = (name: string, text: string): NormalizedBlock => ({
    kind: "tool_result",
    name,
    text,
    isError: false,
  });
  const err = (name: string, text: string): NormalizedBlock => ({
    kind: "tool_result",
    name,
    text,
    isError: true,
  });

  it("drops a bash error when the identical command later succeeds", () => {
    const blocks: NormalizedBlock[] = [
      call("bash", { command: "pnpm test" }),
      err("bash", "FAIL src/a.test.ts: still failing"),
      call("bash", { command: "pnpm test" }),
      ok("bash", "Test Files 3 passed"),
    ];
    expect(buildSections({ blocks }).outstandingContext).toEqual([]);
  });

  it("keeps a bash error when only a different command later succeeds", () => {
    const blocks: NormalizedBlock[] = [
      call("bash", { command: "pnpm test" }),
      err("bash", "FAIL src/a.test.ts: still failing"),
      call("bash", { command: "git status --short" }),
      ok("bash", ""),
    ];
    const r = buildSections({ blocks });
    expect(r.outstandingContext.some((l) => l.includes("FAIL"))).toBe(true);
  });

  it("drops an edit error when the same file is later edited successfully", () => {
    const blocks: NormalizedBlock[] = [
      err(
        "edit",
        "Could not find oldText in CHANGELOG.md. The intended edit could not be applied.",
      ),
      ok("edit", "Successfully replaced 1 block in CHANGELOG.md."),
    ];
    expect(buildSections({ blocks }).outstandingContext).toEqual([]);
  });

  it.each([
    ["src/a.test.ts", "Updated src/a.test.ts.", 0],
    ["/repo/src/a.ts", "Updated /repo/src/a.ts.", 0],
    ["$WORK/src/a.ts", "Updated $work/src/a.ts.", 0],
    ["../src/a.ts", "Updated ../src/a.ts.", 0],
    ["src/a.tsx", "Updated src/a.tsx-long", 0],
    ["src/a.abcde", "Updated src/a.abcde", 0],
    ["src/a.ts", "Updated src/a.ts/contents", 0],
    ["src/a.ts", "Updated src/a.ts/other.md", 1],
    ["src/a.ts", "Updated /.ts", 1],
    ["src/a.ts", "Updated $.ts", 1],
    ["src/a.abcde", "Updated src/a.abcdef", 1],
  ])("matches error path %s against %s", (errorPath, successText, count) => {
    const blocks: NormalizedBlock[] = [
      err("edit", `Could not update ${errorPath}`),
      ok("edit", successText),
    ];
    const r = buildSections({ blocks });
    expect(r.outstandingContext).toHaveLength(count);
    if (count > 0) expect(r.outstandingContext[0]).toBe(`[edit] Could not update ${errorPath}`);
  });

  it("keeps an edit error when only a different file is later edited", () => {
    const blocks: NormalizedBlock[] = [
      err(
        "edit",
        "Could not find oldText in CHANGELOG.md. The intended edit could not be applied.",
      ),
      ok("edit", "Successfully replaced 1 block in src/other.ts."),
    ];
    const r = buildSections({ blocks });
    expect(r.outstandingContext.some((l) => l.includes("CHANGELOG"))).toBe(true);
  });

  it("keeps errors with no later success", () => {
    const blocks: NormalizedBlock[] = [err("edit", "Could not find oldText in CHANGELOG.md.")];
    expect(buildSections({ blocks }).outstandingContext.length).toBe(1);
  });

  it("keeps a path-bearing error when a later same-tool success carries no path", () => {
    // Same-tool success with no path token says nothing about the file in the
    // error — the overlap check must run whenever either side carries paths.
    const blocks: NormalizedBlock[] = [
      err("edit", "permission denied for src/a.ts"),
      ok("edit", "done"),
    ];
    const r = buildSections({ blocks });
    expect(r.outstandingContext.some((l) => l.includes("src/a.ts"))).toBe(true);
  });

  it("still extinguishes when both sides are pathless", () => {
    const blocks: NormalizedBlock[] = [err("edit", "Operation not permitted"), ok("edit", "done")];
    expect(buildSections({ blocks }).outstandingContext).toEqual([]);
  });

  it("an earlier success does not extinguish a later error", () => {
    const blocks: NormalizedBlock[] = [
      call("bash", { command: "pnpm test" }),
      ok("bash", "Test Files 3 passed"),
      call("bash", { command: "pnpm test" }),
      err("bash", "FAIL src/a.test.ts: still failing"),
    ];
    const r = buildSections({ blocks });
    expect(r.outstandingContext.some((l) => l.includes("FAIL"))).toBe(true);
  });
});
