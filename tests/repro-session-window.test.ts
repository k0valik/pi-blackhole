import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import { collectFilesTouched } from "../src/extract/file-touch.js";
import { extractFiles } from "../src/extract/files.js";
import { extractCommits, formatCommits } from "../src/extract/commits.js";
import { normalize } from "../src/core/normalize.js";

const SESSION = "/tmp/inspect.jsonl";
const CWD = "/home/kovalik/projects/pi-blackhole-dev";

// Reconstruct the raw message array pi's session manager hands to the hook.
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

describe("repro: compaction-2 window (lines 322-559) — real pipeline", () => {
  const raw = loadWindowMessages(322, 559);
  const blocks = normalize(raw as Message[]);

  it("window has tool calls for the 6 bug files", () => {
    const names = raw
      .filter((m) => m.role === "assistant")
      .flatMap((m: any) => m.content ?? [])
      .filter((b: any) => b?.type === "toolCall" && (b.name === "write" || b.name === "edit"))
      .map((b: any) => b.name + ":" + (b.arguments?.path ?? "?"));
    for (const f of [
      "commits.ts",
      "preferences.ts",
      "build-sections.ts",
      "outstanding-context",
      "extract-commits",
      "before-compact",
    ]) {
      expect(
        names.some((n) => n.includes(f)),
        `no tool call mentions ${f} — got: ${names.join(" | ")}`,
      ).toBe(true);
    }
  });

  it("collectFilesTouched → extractFiles contains all 6", () => {
    const touched = collectFilesTouched(raw, CWD);
    const act = extractFiles(blocks, undefined, touched, undefined, CWD);
    const all = [...act.modified, ...act.created, ...act.read].map((p) => p.split("/").pop());
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
        all,
        `extractFiles missing ${f} — got: ${[
            { s: "modified", v: act.modified },
            { s: "created", v: act.created },
            { s: "read", v: act.read },
          ].flatMap((g) => [...g.v].map((p) => g.s + ":" + p.split("/").pop())).join(" | ")}`,
      ).toContain(f);
    }
  });

  it("extractCommits on normalized blocks finds both window commits", () => {
    const commits = extractCommits(blocks);
    const rendered = formatCommits(commits).join("\n");
    console.log("COMMITS DETECTED:\n" + rendered);
    // 5de4695 (git-status commit) is inside lines 322-559
    expect(rendered).toContain("ground [Files And Changes] with git status word tags");
    expect(rendered).toContain("language- and flag-tolerant");
  });
});
