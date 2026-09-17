import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { tagFromPorcelain, loadGitFileTags } from "../src/extract/git-status.js";
import { extractFiles } from "../src/extract/files.js";
import { buildSections } from "../src/core/build-sections.js";
import { compile } from "../src/core/summarize.js";

// ── porcelain XY → word tag ──────────────────────────────────────

describe("tagFromPorcelain", () => {
  it.each([
    ["M ", "staged"],
    ["A ", "staged"],
    [" M", "unstaged"],
    ["MM", "staged,unstaged"],
    ["??", "new"],
    ["R ", "renamed"],
    ["C ", "renamed"],
    ["D ", "deleted"],
    [" D", "deleted"],
    ["UU", "conflicted"],
    ["AA", "conflicted"],
    ["DD", "conflicted"],
    ["UD", "conflicted"],
    ["!!", null], // ignored files never reach the map (status skips them), safe fallback
    ["  ", null],
  ] as const)("%s → %s", (xy, expected) => {
    expect(tagFromPorcelain(xy)).toBe(expected);
  });
});

// ── real repo integration ────────────────────────────────────────

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "bh-git-status-")));
const git = (args: string[], cwd: string = tmp) =>
  execFileSync("git", args, { cwd, encoding: "utf-8" });

try {
  git(["init", "-q"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(path.join(tmp, "committed.ts"), "one\n");
  git(["add", "."]);
  git(["commit", "-qm", "init"]);

  // staged modification
  writeFileSync(path.join(tmp, "committed.ts"), "two\n");
  git(["add", "committed.ts"]);
  // unstaged modification
  writeFileSync(path.join(tmp, "committed.ts"), "three\n");
  // untracked new file
  writeFileSync(path.join(tmp, "fresh.ts"), "new\n");

  describe("loadGitFileTags", () => {
    it("maps staged, staged+unstaged and untracked files by absolute path", () => {
      const tags = loadGitFileTags(tmp);
      expect(tags.get(path.join(tmp, "committed.ts"))).toBe("staged,unstaged");
      expect(tags.get(path.join(tmp, "fresh.ts"))).toBe("new");
    });

    it("returns an empty map outside a repo (fail-closed)", () => {
      expect(loadGitFileTags(tmpdir()).size).toBe(0);
    });
  });
} finally {
  // cleanup registered after all tests via afterAll below
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
}

// ── files.ts grounding ───────────────────────────────────────────

describe("extractFiles git grounding", () => {
  const abs = (p: string) => path.join(tmp, p);

  it("promotes untracked written files from Modified to Created", () => {
    const tags = new Map<string, string>([
      [abs("fresh.ts"), "new"],
      [abs("committed.ts"), "staged,unstaged"],
    ]);
    const act = extractFiles(
      [],
      { readFiles: [], modifiedFiles: [abs("fresh.ts"), abs("committed.ts")] },
      [],
      tags,
      tmp,
    );
    // shared-repo prefix is trimmed for display
    expect([...act.created]).toContain("fresh.ts");
    expect([...act.modified]).toContain("committed.ts");
    expect([...act.modified]).not.toContain("fresh.ts");
  });

  it("annotates display paths after prefix trimming", () => {
    const tags = new Map<string, string>([
      [abs("src/fresh.ts"), "new"],
      [abs("src/committed.ts"), "staged,unstaged"],
      [abs("src/read-only.md"), "unstaged"],
    ]);
    const act = extractFiles(
      [],
      {
        readFiles: [abs("src/read-only.md")],
        modifiedFiles: [abs("src/fresh.ts"), abs("src/committed.ts")],
      },
      [],
      tags,
      tmp,
    );
    // all files share <tmp>/src → trimmed to that prefix
    expect(act.gitTags?.get("fresh.ts")).toBe("new");
    expect(act.gitTags?.get("committed.ts")).toBe("staged,unstaged");
    expect(act.gitTags?.get("read-only.md")).toBe("unstaged");
  });

  it("suppresses the new tag on read-only entries", () => {
    const tags = new Map<string, string>([[abs("orphan.ts"), "new"]]);
    const act = extractFiles(
      [],
      { readFiles: [abs("orphan.ts")], modifiedFiles: [] },
      [],
      tags,
      tmp,
    );
    expect(act.gitTags?.has("orphan.ts") ?? false).toBe(false);
  });

  it("no tags when git status is unavailable", () => {
    const act = extractFiles([], { readFiles: [], modifiedFiles: ["a.ts"] }, []);
    expect(act.gitTags).toBeUndefined();
  });
});

// ── end-to-end rendering ─────────────────────────────────────────

describe("[Files And Changes] git annotations", () => {
  it("renders word tags on Modified/Created lines", () => {
    const tags = new Map<string, string>([
      [path.join(tmp, "src/main.ts"), "staged,unstaged"],
      [path.join(tmp, "src/new-file.ts"), "new"],
    ]);
    const r = buildSections({
      blocks: [],
      cwd: tmp,
      gitTags: tags,
      fileOps: {
        readFiles: [],
        modifiedFiles: [path.join(tmp, "src/main.ts"), path.join(tmp, "src/new-file.ts")],
      },
    });
    const files = r.filesAndChanges.join("\n");
    // all paths share <tmp>/src → prefix trimmed to it
    expect(files).toContain("Modified: main.ts (staged,unstaged)");
    expect(files).toContain("Created: new-file.ts (new)");
  });
});

// ── merge: fresh tags survive, stale prev tags are stripped ──────

describe("compile merge keeps only fresh git annotations", () => {
  it("strips tags from the previous summary, keeps fresh ones, dedups by stripped path", () => {
    const prev = ["[Files And Changes]", "- Modified: stale.ts (staged), both.ts (unstaged)"].join(
      "\n",
    );
    const messages = [];
    void messages;
    const freshInput = {
      messages,
      previousSummary: prev,
      fileOps: { readFiles: [], modifiedFiles: ["both.ts", "newly-staged.ts"] },
      gitTags: new Map<string, string>([
        ["/repo/both.ts", "staged"],
        ["/repo/newly-staged.ts", "staged"],
      ]),
      cwd: "/repo",
    };
    const out = compile(freshInput);
    // fresh tags survive on re-touched paths; prev-only paths keep no tag
    expect(out).toContain("both.ts (staged)");
    expect(out).toContain("newly-staged.ts (staged)");
    expect(out).toContain("stale.ts");
    expect(out).not.toContain("stale.ts (staged)");
    expect(out).not.toContain("(unstaged)");
  });
});
