import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { tagFromPorcelain, loadGitFileTags, gitEnv } from "../src/extract/git-status.js";
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
// `env: gitEnv()` strips GIT_DIR/GIT_WORK_TREE/... so these setup commands can
// never target (and mutate, e.g. `git config`) a repo from the ambient env.
const git = (args: string[], cwd: string = tmp) =>
  execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf-8" });

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

    it("ignores an ambient GIT_DIR — discovery is anchored to cwd", () => {
      const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "bh-non-repo-")));
      const prev = process.env.GIT_DIR;
      process.env.GIT_DIR = path.join(tmp, ".git");
      try {
        // A leaked GIT_DIR (e.g. from the agent's worktree env) must not make a
        // non-repo directory look like a repo, nor leak the other repo's tags.
        expect(loadGitFileTags(outside).size).toBe(0);
      } finally {
        if (prev === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = prev;
        rmSync(outside, { recursive: true, force: true });
      }
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

  it("annotates display paths after cwd-relative trimming", () => {
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
    // paths render cwd-relative (src/fresh.ts), not longest-common-prefix trimmed
    expect(act.gitTags?.get("src/fresh.ts")).toBe("new");
    expect(act.gitTags?.get("src/committed.ts")).toBe("staged,unstaged");
    expect(act.gitTags?.get("src/read-only.md")).toBe("unstaged");
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

  it("strips a trailing backslash so the path dedups with its clean form", () => {
    // sanitizeReference gates cleaning on a trailing backslash (charCode 92)
    // but the strip regexes never removed it — the key kept a trailing "\"
    // (rendered "/" after slash normalization) and dodged dedup.
    const act = extractFiles(
      [],
      { readFiles: [], modifiedFiles: ["src/a.ts\\", "src/a.ts"] },
      [],
      undefined,
      "/repo",
    );
    expect([...act.modified]).toEqual(["src/a.ts"]);
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
    // paths render cwd-relative, one per line under counted headers
    expect(files).toContain("Modified (1):");
    expect(files).toContain("src/main.ts (staged,unstaged)");
    expect(files).toContain("Created (1):");
    expect(files).toContain("src/new-file.ts (new)");
  });
});

// ── merge: fresh tags survive, stale prev tags are stripped ──────

describe("compile merge keeps only fresh git annotations", () => {
  it("strips tags from the previous summary, keeps fresh ones, dedups by stripped path", () => {
    // Previous summary uses cwd-relative paths (src/both.ts) so merge keys match
    const prev = [
      "[Files And Changes]",
      "- Modified: src/stale.ts (staged), src/both.ts (unstaged)",
    ].join("\n");
    const messages = [];
    void messages;
    const freshInput = {
      messages,
      previousSummary: prev,
      fileOps: { readFiles: [], modifiedFiles: ["/repo/src/both.ts", "/repo/src/newly-staged.ts"] },
      gitTags: new Map<string, string>([
        ["/repo/src/both.ts", "staged"],
        ["/repo/src/newly-staged.ts", "staged"],
      ]),
      cwd: "/repo",
    };
    const out = compile(freshInput);
    // fresh tags survive on re-touched paths; prev-only paths keep no tag
    expect(out).toContain("src/both.ts (staged)");
    expect(out).toContain("src/newly-staged.ts (staged)");
    expect(out).toContain("src/stale.ts");
    expect(out).not.toContain("src/stale.ts (staged)");
    expect(out).not.toContain("(unstaged)");
  });
});
