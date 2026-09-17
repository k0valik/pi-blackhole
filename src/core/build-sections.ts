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
import { extractFiles, formatFileList } from "../extract/files";
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
  /** Git working-tree tags (abs path → "staged"/"new"/…), see src/extract/git-status.ts. */
  gitTags?: Map<string, string>;
}

const BLOCKER_RE =
  /\b(fail(ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (broken|failing|wrong)|blocked|blocker|not (fixed|resolved|working)|crash(es|ed|ing)?)\b/i;

// CJK failure/blocker stems — no \b (CJK has no word boundaries). Kept to
// unambiguous failure words; conversational hedges like 不行 and 不对 are
// excluded to avoid chit-chat matches.
const BLOCKER_CJK_RE = /失败|报错|错误|卡住|崩溃/;

// Benign technical compounds that contain a failure stem but describe
// mechanism, not malfunction ("add error handling" is not a blocker).
// Stripped before the stem test, so a line only flags on a *residual* stem:
// a line with both ("the error handling still 报错") still fires via 报错.
const CJK_BENIGN_RE = /错误(?:处理|信息|消息|码|类型|日志|堆栈)|失败(?:重试|率)/g;

// Sentence-like start: capital letter, code identifier, quote, CJK bracket —
// or any CJK character (CJK sentences start with a han character, not ASCII
// capitals). 【/『/「 lead bracketed CJK headings like 【报错】服务启动失败.
const SENTENCE_START_RE = /^\s*["'`*_【『「]?[A-Z`\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

const OUTSTANDING_CLIP = 200;

/** Path-like tokens (`src/a.ts`, `/repo/b.md`) used to match an error to its retry. */
const pathTokens = (text: string): Set<string> => {
  const out = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z0-9_.$/-]*[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,5}\b/g)) {
    out.add(m[0].toLowerCase());
  }
  return out;
};

const extractOutstandingContext = (blocks: NormalizedBlock[]): string[] => {
  const pending: { index: number; text: string }[] = [];
  const seen = new Set<string>();
  const push = (index: number, text: string) => {
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    pending.push({ index, text });
  };

  // An error retried successfully later in the window is resolved, not
  // outstanding. Bash errors extinguish only when the identical command
  // later succeeds — a different command succeeding says nothing about the
  // failure (e.g. tests fail, then `git status` works: the failure stands).
  // Other tools extinguish on a later success sharing a path-like token
  // with the error text (same file fixed); with no path tokens on either
  // side, same-tool success is enough.
  interface ErrorEntry {
    name: string;
    index: number;
    command?: string;
    paths: Set<string>;
    text: string;
  }
  const errors: ErrorEntry[] = [];
  const successes: { name: string; index: number; command?: string; paths: Set<string> }[] = [];
  const lastCallCommand = new Map<string, string>();
  blocks.forEach((b, index) => {
    if (b.kind === "tool_call") {
      if (b.name === "bash" && typeof b.args.command === "string") {
        lastCallCommand.set(b.name, b.args.command);
      }
      return;
    }
    if (b.kind !== "tool_result") return;
    if (b.isError) {
      errors.push({
        name: b.name,
        index,
        command: lastCallCommand.get(b.name),
        paths: pathTokens(b.text),
        text: b.text,
      });
    } else {
      successes.push({
        name: b.name,
        index,
        command: lastCallCommand.get(b.name),
        paths: pathTokens(b.text),
      });
    }
  });

  const isExtinguished = (e: ErrorEntry): boolean =>
    successes.some((s) => {
      if (s.name !== e.name || s.index <= e.index) return false;
      if (e.name === "bash") return s.command !== undefined && s.command === e.command;
      if (e.paths.size > 0 && s.paths.size > 0) {
        return [...e.paths].some((p) => s.paths.has(p));
      }
      return true;
    });

  for (const e of errors) {
    if (isExtinguished(e)) continue;
    push(e.index, `[${e.name}] ${firstLine(e.text, OUTSTANDING_CLIP)}`);
  }

  blocks.forEach((b, index) => {
    if (b.kind === "tool_result" && b.isError) return;

    if (b.kind === "assistant" || b.kind === "user") {
      for (const line of nonEmptyLines(b.text)) {
        // Benign-compound strip first: mechanism discussion must not flag.
        const scannable = line.replace(CJK_BENIGN_RE, "");
        if (!BLOCKER_RE.test(scannable) && !BLOCKER_CJK_RE.test(scannable)) continue;
        // CJK conveys ~2-3x the information per char — 15 is an English floor.
        // A short failure report (失败了) is complete at 3 chars.
        const minLength = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(line) ? 2 : 15;
        if (line.length < minLength) continue;
        // Skip continuation fragments (sub-bullets, parentheticals, dangling clauses)
        if (/^\s*[-*+>]\s/.test(line)) continue;
        if (/^\s*\(/.test(line)) continue;
        // Require sentence-like start: capital/quote, or any CJK character
        if (!SENTENCE_START_RE.test(line)) continue;
        const clipped =
          b.kind === "user"
            ? `[user] ${clipSentence(line, OUTSTANDING_CLIP)}`
            : clipSentence(line, OUTSTANDING_CLIP);
        const before = seen.size;
        push(index, clipped);
        if (seen.size > before) break;
      }
    }
  });

  // Chronological (errors and prose interleaved as they occurred), keep recent.
  pending.sort((a, z) => a.index - z.index);
  return pending.slice(-5).map((p) => p.text);
};

const formatFileActivity = (input: BuildSectionsInput): string[] => {
  // Lazy: the touch collector only runs at compaction time, never per tool call.
  const touched = input.messages ? collectFilesTouched(input.messages, input.cwd) : [];
  const act = extractFiles(input.blocks, input.fileOps, touched, input.gitTags, input.cwd);
  // Dedup: if already Modified, drop from Created (file existed before)
  for (const p of act.modified) act.created.delete(p);
  const lines: string[] = [];
  const tagOf = (p: string): string => {
    const tag = act.gitTags?.get(p);
    return tag ? ` (${tag})` : "";
  };
  // Modified/Created render as one-per-line lists (up to 20 — the touched
  // set is the session's ground truth, worth preserving); Read stays a
  // comma-joined bullet capped at 10.
  const list = (set: Set<string>) => [...set].map((p) => `${p}${tagOf(p)}`);
  if (act.modified.size > 0) lines.push(formatFileList("Modified", list(act.modified), 20));
  if (act.created.size > 0) lines.push(formatFileList("Created", list(act.created), 20));
  if (act.read.size > 0) {
    const arr = list(act.read);
    lines.push(
      `Read: ${arr.slice(0, 10).join(", ")}${arr.length > 10 ? ` (+${arr.length - 10} more)` : ""}`,
    );
  }
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
