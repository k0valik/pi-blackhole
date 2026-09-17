/**
 * Section building — parses normalized blocks into structured sections.
 *
 * Upstream: https://github.com/sting8k/pi-vcc (src/core/build-sections.ts)
 * Modified by pi-blackhole:
 * - Files And Changes also attributes files from raw session messages via
 *   the file-touch collector (src/extract/file-touch.ts), covering anchor-
 *   based edit tools and bash mutations that PATH_KEYS matching cannot see.
 */
import type { Message } from "@earendil-works/pi-ai";
import type { FileOps, NormalizedBlock } from "../types";
import { clipSentence, firstLine, nonEmptyLines } from "./content";
import type { SectionData } from "../sections";
import { extractGoals } from "../extract/goals";
import { extractFiles } from "../extract/files";
import { collectFilesTouched } from "../extract/file-touch";
import { extractPreferences, dedupPreferencesAgainstGoals } from "../extract/preferences";
import { extractCommits, formatCommits } from "../extract/commits";
import { buildBriefSections, stringifyBrief } from "./brief";

export interface BuildSectionsInput {
  blocks: NormalizedBlock[];
  /** Raw pre-conversion session messages — enables file-touch attribution. */
  messages?: Message[];
  /** Working directory for relative-path merging in file-touch attribution. */
  cwd?: string;
  /** Pi's own file-op seed lists (read/written/edited). */
  fileOps?: FileOps;
}

const BLOCKER_RE =
  /\b(fail(ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (broken|failing|wrong)|blocked|blocker|not (fixed|resolved|working)|crash(es|ed|ing)?)\b/i;

const extractOutstandingContext = (blocks: NormalizedBlock[]): string[] => {
  const items: string[] = [];
  const tail = blocks.slice(-20);

  for (const b of tail) {
    if (b.kind === "tool_result" && b.isError) {
      items.push(`[${b.name}] ${firstLine(b.text, 150)}`);
      continue;
    }

    if (b.kind === "assistant" || b.kind === "user") {
      for (const line of nonEmptyLines(b.text)) {
        if (!BLOCKER_RE.test(line)) continue;
        if (line.length < 15) continue;
        // Skip continuation fragments (sub-bullets, parentheticals, dangling clauses)
        if (/^\s*[-*+>]\s/.test(line)) continue;
        if (/^\s*\(/.test(line)) continue;
        // Require sentence-like start: capital letter, code identifier, or quote
        if (!/^\s*["'`*_]?[A-Z`]/.test(line)) continue;
        const clipped =
          b.kind === "user" ? `[user] ${clipSentence(line, 150)}` : clipSentence(line, 150);
        if (!items.includes(clipped)) items.push(clipped);
        break;
      }
    }
  }

  return items.slice(0, 5);
};

const formatFileActivity = (input: BuildSectionsInput): string[] => {
  // Lazy: the touch collector only runs at compaction time, never per tool call.
  const touched = input.messages ? collectFilesTouched(input.messages, input.cwd) : [];
  const act = extractFiles(input.blocks, input.fileOps, touched);
  // Dedup: if already Modified, drop from Created (file existed before)
  for (const p of act.modified) act.created.delete(p);
  const lines: string[] = [];
  const cap = (set: Set<string>, limit: number) => {
    const arr = [...set];
    if (arr.length <= limit) return arr.join(", ");
    return arr.slice(0, limit).join(", ") + ` (+${arr.length - limit} more)`;
  };
  if (act.modified.size > 0) lines.push(`Modified: ${cap(act.modified, 10)}`);
  if (act.created.size > 0) lines.push(`Created: ${cap(act.created, 10)}`);
  if (act.read.size > 0) lines.push(`Read: ${cap(act.read, 10)}`);
  return lines;
};

export const buildSections = (input: BuildSectionsInput): SectionData => {
  const { blocks } = input;
  const briefSections = buildBriefSections(blocks);
  const sessionGoal = extractGoals(blocks);
  const userPreferences = dedupPreferencesAgainstGoals(extractPreferences(blocks), sessionGoal);
  return {
    sessionGoal,
    outstandingContext: extractOutstandingContext(blocks),
    filesAndChanges: formatFileActivity(input),
    commits: formatCommits(extractCommits(blocks)),
    userPreferences,
    briefTranscript: stringifyBrief(briefSections),
  };
};
