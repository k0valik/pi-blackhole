import { describe, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { collectFilesTouched } from "../src/extract/file-touch.js";
import { extractFiles } from "../src/extract/files.js";
import { loadGitFileTags } from "../src/extract/git-status.js";
import { normalize } from "../src/core/normalize.js";
import { filterNoise } from "../src/core/filter-noise.js";

const SESSION = "docs/archived_docs/105-compaction-session-01a0b03e.jsonl";
const CWD = "/home/kovalik/projects/pi-blackhole-dev";

const loadWindowMessages = (from: number, to: number) => {
  const out: any[] = [];
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
    out.push(e.message);
  }
  return out;
};

describe("forensic2: extractFiles direct", () => {
  it("prints the act sets", () => {
    const raw = loadWindowMessages(322, 559);
    const touched = collectFilesTouched(raw, CWD);
    const blocks = filterNoise(normalize(raw as any));
    const gitTags = loadGitFileTags(CWD);
    const act = extractFiles(blocks, { readFiles: [], modifiedFiles: [] }, touched, gitTags, CWD);
    writeFileSync(
      "/tmp/forensic-act.txt",
      JSON.stringify(
        {
          modified: [...act.modified],
          created: [...act.created],
          read: [...act.read],
          gitTags: act.gitTags ? [...act.gitTags] : undefined,
        },
        null,
        1,
      ),
    );
  });
});
