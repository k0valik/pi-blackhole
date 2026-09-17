import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { compile } from "../src/core/summarize.js";
import { collectFilesTouched } from "../src/extract/file-touch.js";
import { loadGitFileTags } from "../src/extract/git-status.js";
import type { Message } from "@earendil-works/pi-ai";

const SESSION = "docs/archived_docs/105-compaction-session-01a0b03e.jsonl";
const CWD = "/home/kovalik/projects/pi-blackhole-dev";

const loadWindowMessages = (from: number, to: number): Message[] => {
  const out: Message[] = [];
  const lines = readFileSync(SESSION, "utf8").split("\n");
  for (let i = from; i <= to && i <= lines.length; i++) {
    const line = lines[i - 1];
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== "message") continue;
    out.push(e.message as Message);
  }
  return out;
};

const findPreviousSummary = (): string => {
  const lines = readFileSync(SESSION, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    if (e.type === "compaction") return e.summary ?? "";
  }
  return "";
};

describe("forensic: 18:36 production compile on archived data", () => {
  const raw = loadWindowMessages(322, 559);
  it("window count is 147 (matches before_compact.proceeding)", () => {
    expect(raw.length).toBe(147);
  });

  it("collectFilesTouched on raw window finds the 11 bug-2/3/4 files", () => {
    const touched = collectFilesTouched(raw, CWD);
    const files = touched.map((t) => t.path);
    console.log(
      "TOUCHED:",
      files.length,
      JSON.stringify(
        files.map((p) => p.split("/").pop()),
        null,
        0,
      ),
    );
    for (const f of [
      "commits.ts",
      "preferences.ts",
      "build-sections.ts",
      "outstanding-context.test.ts",
      "extract-commits.test.ts",
      "before-compact.ts",
      "summarize.ts",
      "git-status.ts",
      "files.ts",
      "git-status-annotation.test.ts",
      "CHANGELOG.md",
    ]) {
      expect(
        files.some((p) => p.split("/").pop() === f),
        `missing ${f}`,
      ).toBe(true);
    }
  });

  it("full compile() with previousSummary + gitTags reproduces production?", () => {
    const prev = findPreviousSummary();
    const gitTags = loadGitFileTags(CWD);
    const out = compile({
      messages: raw,
      touchMessages: raw,
      previousSummary: prev,
      fileOps: { readFiles: [], modifiedFiles: [] },
      gitTags,
      cwd: CWD,
    });
    const filesSection = out.slice(out.indexOf("[Files And Changes]"), out.indexOf("[Commits]"));
    require("fs").writeFileSync("/tmp/compiled-files-section.txt", filesSection);
    console.log("COMPILED FILES SECTION:\n" + filesSection);
    console.log(
      "GENUINE 3-FILE OUTPUT:",
      filesSection.includes("CHANGELOG.md") && !filesSection.includes("commits.ts, "),
    );
  });
});
describe("forensic: extractFiles merge step", () => {
  const raw = loadWindowMessages(322, 559);
  it("shows what happens inside extractFiles", () => {
    const touched = collectFilesTouched(raw, CWD);
    const gitTags = loadGitFileTags(CWD);
    const fs = require("fs");
    fs.writeFileSync(
      "/tmp/forensic-debug.txt",
      JSON.stringify(
        {
          touchedCount: touched.length,
          touchedPaths: touched.map((t) => t.path),
          touchedMeta: touched.map((t) => ({
            p: t.path,
            ops: [...t.operations],
            last: t.lastOperation,
          })),
          gitTags: gitTags
            ? [...gitTags.entries()].filter(([, v]) => v === "new").slice(0, 30)
            : "none",
        },
        null,
        1,
      ),
    );
  });
});
