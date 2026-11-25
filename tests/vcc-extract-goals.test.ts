import { describe, it, expect } from "vitest";
import { extractGoals } from "../src/extract/goals.js";
import type { NormalizedBlock } from "../src/types.js";

describe("extractGoals", () => {
  it("returns empty for no blocks", () => {
    expect(extractGoals([])).toEqual([]);
  });

  it("returns empty when no user blocks", () => {
    const blocks: NormalizedBlock[] = [{ kind: "assistant", text: "hello" }];
    expect(extractGoals(blocks)).toEqual([]);
  });

  it("extracts first user message lines as goals", () => {
    const blocks: NormalizedBlock[] = [{ kind: "user", text: "Fix login bug\nCheck auth flow" }];
    const goals = extractGoals(blocks);
    expect(goals).toEqual(["Fix login bug", "Check auth flow"]);
  });

  it("takes up to 6 lines from first user block", () => {
    const blocks: NormalizedBlock[] = [
      {
        kind: "user",
        text: "fix the login bug\ncheck auth flow\nupdate the tests\nrefactor utils\nclean up",
      },
    ];
    expect(extractGoals(blocks)).toHaveLength(5);
  });

  it("ignores subsequent user blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "first goal" },
      { kind: "assistant", text: "ok" },
      { kind: "user", text: "second request" },
    ];
    expect(extractGoals(blocks)).toEqual(["first goal"]);
  });

  it("detects scope change with explicit pivot keywords", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix login bug" },
      { kind: "assistant", text: "ok" },
      {
        kind: "user",
        text: "Actually, instead let's refactor the auth module",
      },
    ];
    const goals = extractGoals(blocks);
    expect(goals).toContain("Fix login bug");
    expect(goals).toContain("[Scope change]");
    expect(goals.some((g) => g.includes("refactor"))).toBe(true);
  });

  it("detects scope change from new task statements", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix login bug" },
      { kind: "assistant", text: "done" },
      { kind: "user", text: "Now implement the user registration flow" },
    ];
    const goals = extractGoals(blocks);
    expect(goals).toContain("[Scope change]");
  });

  it("scope-change marker carries the ref of its bullets", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix login bug", sourceIndex: 3 },
      { kind: "assistant", text: "done", sourceIndex: 4 },
      { kind: "user", text: "Change of plan, implement password reset", sourceIndex: 9 },
    ];
    const goals = extractGoals(blocks);
    expect(goals).toContain("[Scope change] (#9)");
    expect(goals).toContain("Change of plan, implement password reset (#9)");
  });

  it("keeps latest scope change only", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix login bug" },
      { kind: "assistant", text: "done" },
      { kind: "user", text: "Actually, fix the signup page instead" },
      { kind: "assistant", text: "ok" },
      { kind: "user", text: "Change of plan, implement password reset" },
    ];
    const goals = extractGoals(blocks);
    const scopeIdx = goals.indexOf("[Scope change]");
    expect(goals[scopeIdx + 1]).toContain("password reset");
  });

  it("keeps the latest scope change when the first message contributes its maximum lines", () => {
    const blocks: NormalizedBlock[] = [
      {
        kind: "user",
        text: "fix login bug\ncheck auth flow\nupdate tests\nrefactor utils\nclean up logs\nadd metrics",
      },
      { kind: "assistant", text: "ok" },
      {
        kind: "user",
        text: "Actually, instead let's refactor auth\nmigrate the database\nupdate the docs",
      },
    ];
    const goals = extractGoals(blocks);
    // The first block contributes at most 6 founding lines; with the 10-goal
    // cap this fits, so the latest scope change is kept in full.
    expect(goals.length).toBe(10);
    expect(goals[0]).toBe("fix login bug");
    expect(goals.slice(-4)).toEqual([
      "[Scope change]",
      "Actually, instead let's refactor auth",
      "migrate the database",
      "update the docs",
    ]);
  });
  describe("long-first-message fallback", () => {
    const longProse =
      "Delegation stance: implement. Build everything yourself; read-only helpers are fine. "
        .repeat(8)
        .trim();

    it("keeps a clipped goal from a single long prose line", () => {
      const blocks: NormalizedBlock[] = [{ kind: "user", text: longProse, sourceIndex: 7 }];
      const goals = extractGoals(blocks);
      expect(goals).toHaveLength(1);
      expect(goals[0]).toMatch(/^Delegation stance: implement\./);
      expect(goals[0]).toMatch(/… \(#7\)$/);
      expect(goals[0].length).toBeLessThanOrEqual(208);
    });

    it("does not add the fallback when the block has a short goal", () => {
      const blocks: NormalizedBlock[] = [{ kind: "user", text: `${longProse}\nFix login bug` }];
      expect(extractGoals(blocks)).toEqual(["Fix login bug"]);
    });

    it("rejects long code, path and unbroken data lines", () => {
      const code = "const x = " + "a".repeat(1200) + ";";
      const path = "https://example.com/" + "a".repeat(1200);
      const blob = "A".repeat(1200);
      for (const text of [code, path, blob]) {
        expect(extractGoals([{ kind: "user", text }])).toEqual([]);
      }
    });

    it("handles a long CJK-only line", () => {
      const text = "需求：实现完整的登录流程。".repeat(30);
      const goals = extractGoals([{ kind: "user", text }]);
      expect(goals).toHaveLength(1);
      expect(goals[0]).toMatch(/…$/);
    });

    it("does not add a fallback after a goal already exists", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "Fix login bug" },
        { kind: "assistant", text: "ok" },
        { kind: "user", text: longProse },
      ];
      expect(extractGoals(blocks)).toEqual(["Fix login bug"]);
    });
  });

  it("skips noise short user messages as goals", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "ok" },
      { kind: "assistant", text: "hello" },
      { kind: "user", text: "Fix the authentication module" },
    ];
    const goals = extractGoals(blocks);
    expect(goals[0]).toContain("Fix the authentication");
    expect(goals.some((g) => g === "ok")).toBe(false);
  });
});
