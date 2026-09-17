import path from "node:path";

import type { FileOps, NormalizedBlock } from "../types";
import { extractPath } from "../core/tool-args";
import type { FilesTouchedEntry } from "./file-touch";

interface FileActivity {
  read: Set<string>;
  modified: Set<string>;
  created: Set<string>;
  /** Display path → git word tag ("staged", "new", …); only when git status was provided. */
  gitTags?: Map<string, string>;
}

const FILE_READ_TOOLS = new Set(["Read", "read_file", "View", "read", "view"]);

const FILE_WRITE_TOOLS = new Set([
  "Edit",
  "Write",
  "edit",
  "write",
  "edit_file",
  "write_file",
  "MultiEdit",
]);

// Pi never exposes a "createdFiles" field — Write operations are tracked as modified.
// FILE_CREATE_TOOLS kept as empty set for forward-compat if Pi adds a creation signal.
const FILE_CREATE_TOOLS = new Set<string>();

/**
 * Display form of a canonical absolute path: relative to the session cwd
 * when inside it (`/repo/src/a.ts` → `src/a.ts`), absolute otherwise
 * (`/tmp/up.ts` stays absolute). Forward slashes on all platforms so the
 * summary reads the same on macOS, Linux, and Windows (drive-relative
 * paths that escape the cwd fall back to absolute).
 */
const displayPath = (abs: string, cwd?: string): string => {
  if (cwd) {
    const rel = path.relative(cwd, abs);
    if (rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) {
      return rel.split(path.sep).join("/");
    }
  }
  return abs;
};

const isOutsideCwd = (display: string): boolean =>
  display.startsWith("/") || /^[A-Za-z]:\//.test(display);

/**
 * Rank in-cwd files before outside-cwd ones (scratch `/tmp` redirect
 * targets, system paths). Stable within each group — recency order from
 * the touch collector is preserved.
 */
const rankByCwd = (set: Set<string>): Set<string> =>
  new Set([...set].filter((p) => !isOutsideCwd(p)).concat([...set].filter(isOutsideCwd)));

/**
 * Path cleanup ported from pi-files-touched (sanitizeReference/stripLineSuffix).
 * Tool args carry raw strings: surrounding quotes/brackets, trailing
 * punctuation, and editor line suffixes (`a.ts:10`, `a.ts:10-40`, `a.ts#L10`).
 * Without stripping, `src/a.ts:10-40` and `/repo/src/a.ts` coexist as phantom
 * duplicates that defeat display trimming and cross-compaction dedup.
 */
const sanitizeReference = (raw: string): string => {
  let value = raw.trim();
  if (!value) return value;
  const first = value.charCodeAt(0);
  const last = value.charCodeAt(value.length - 1);
  if (
    first === 34 ||
    first === 39 ||
    first === 96 ||
    first === 40 ||
    first === 60 ||
    first === 91 ||
    last === 34 ||
    last === 39 ||
    last === 96 ||
    last === 62 ||
    last === 59 ||
    last === 41 ||
    last === 93 ||
    last === 46 ||
    last === 44 ||
    last === 58 ||
    last === 92
  ) {
    value = value.replace(/^["'`(<[]+/, "");
    value = value.replace(/[>"'`,;).\]]+$/, "");
    value = value.replace(/[.,;:]+$/, "");
  }
  return value;
};

const stripLineSuffix = (value: string): string => {
  if (!value.includes("#") && !value.includes(":")) return value;
  let result = value.replace(/#L\d+(C\d+)?$/i, "");
  const lastSeparator = Math.max(result.lastIndexOf("/"), result.lastIndexOf("\\"));
  const segmentStart = lastSeparator >= 0 ? lastSeparator + 1 : 0;
  const segment = result.slice(segmentStart);
  const colonIndex = segment.indexOf(":");
  if (colonIndex >= 0 && /\d/.test(segment[colonIndex + 1] ?? "")) {
    result = result.slice(0, segmentStart + colonIndex);
    return result;
  }
  const lastColon = result.lastIndexOf(":");
  if (lastColon > lastSeparator) {
    const suffix = result.slice(lastColon + 1);
    if (/^\d+(?::\d+)?$/.test(suffix)) {
      result = result.slice(0, lastColon);
    }
  }
  return result;
};

const stripReadSliceSuffix = (p: string): string => p.replace(/:(\d+)-(\d+)$/, "");

/**
 * Merge session-touched file attribution (see file-touch.ts) into the
 * activity sets. Files whose most recent operation was a delete (or that were
 * moved away) are dropped entirely — scratch scripts created and deleted
 * mid-session should not surface in [Files And Changes].
 */
const seedFromTouched = (act: FileActivity, touched: FilesTouchedEntry[]): void => {
  for (const t of touched) {
    if (t.lastOperation === "delete") continue;
    const ops = t.operations;
    if (ops.has("write") || ops.has("edit") || ops.has("move")) {
      act.modified.add(t.path);
    } else if (ops.has("read")) {
      act.read.add(t.path);
    }
  }
};

const toLookupPath = (p: string, cwd?: string): string => {
  // Clean raw tool-arg strings first (quotes, trailing punctuation, editor
  // `:line`/`:start-end`/`#L` suffixes) so they resolve to the same absolute
  // form the file-touch collector produces.
  const cleaned = stripLineSuffix(sanitizeReference(stripReadSliceSuffix(p)));
  const slashed = cleaned.replace(/\\/g, "/");
  return slashed.startsWith("/") || /^[A-Za-z]:\//.test(slashed)
    ? slashed
    : cwd
      ? path.resolve(cwd, cleaned).replace(/\\/g, "/")
      : cleaned;
};

export const extractFiles = (
  blocks: NormalizedBlock[],
  fileOps?: FileOps,
  touched: FilesTouchedEntry[] = [],
  gitTags?: Map<string, string>,
  cwd?: string,
): FileActivity => {
  // Canonicalize seeds through cwd so relative Pi fileOps entries and legacy
  // relative tool-arg paths resolve to the same absolute form the file-touch
  // collector produces — otherwise "src/a.ts" and "/repo/src/a.ts" coexist as
  // phantom duplicates and break longestCommonDirPrefix display trimming.
  const canon = (p: string): string => toLookupPath(p, cwd);
  const act: FileActivity = { read: new Set(), modified: new Set(), created: new Set() };

  // Seed the touch collector first: its output is recency-ordered (most
  // recent first), so the per-category cap keeps the latest touches rather
  // than Pi's unordered fileOps lists. fileOps entries append after — they
  // add files the collector did not model, never reorder it.
  seedFromTouched(act, touched);
  for (const p of fileOps?.readFiles ?? []) act.read.add(canon(p));
  for (const p of fileOps?.modifiedFiles ?? []) act.modified.add(canon(p));
  for (const p of fileOps?.createdFiles ?? []) act.created.add(canon(p));

  // Legacy name/path-args scan — fallback for tools the touch collector does
  // not model (e.g. custom extensions writing via path-like args).
  for (const b of blocks) {
    if (b.kind !== "tool_call") continue;
    const p = extractPath(b.args);
    if (!p) continue;
    const c = canon(p);

    if (FILE_READ_TOOLS.has(b.name)) act.read.add(c);
    if (FILE_WRITE_TOOLS.has(b.name)) act.modified.add(c);
    if (FILE_CREATE_TOOLS.has(b.name)) act.created.add(c);
  }

  // Git grounding: a written/edited file git reports as untracked was created
  // in this session — surface it under Created instead of Modified.
  if (gitTags) {
    for (const p of act.modified) {
      if (gitTags.get(toLookupPath(p, cwd)) === "new") {
        act.modified.delete(p);
        act.created.add(p);
      }
    }
  }

  // A file that was modified is never interesting as "read"
  for (const p of act.modified) act.read.delete(p);

  // Annotate using the canonical (absolute) paths — the git status lookup
  // needs the full path; keys are the display paths.
  if (gitTags) {
    const annotations = new Map<string, string>();
    const collect = (set: Set<string>, allowNew: boolean) => {
      for (const p of set) {
        const tag = gitTags.get(toLookupPath(p, cwd));
        if (!tag || (tag === "new" && !allowNew)) continue;
        annotations.set(displayPath(p, cwd), tag);
      }
    };
    collect(act.modified, true);
    collect(act.created, true);
    collect(act.read, false);
    if (annotations.size > 0) act.gitTags = annotations;
  }

  // Display relative to cwd; outside-cwd files rank last.
  act.read = rankByCwd(new Set([...act.read].map((p) => displayPath(p, cwd))));
  act.modified = rankByCwd(new Set([...act.modified].map((p) => displayPath(p, cwd))));
  act.created = rankByCwd(new Set([...act.created].map((p) => displayPath(p, cwd))));

  return act;
};

/**
 * Render one file category as a single section item: a `Name (n):` header
 * followed by one path per line (indented so merge parser recognizes them
 * as continuation lines). One entry per line (instead of a wrapped
 * comma-joined bullet) keeps long paths scannable and never splits a path
 * mid-word at the wrap width. Entries carry trailing commas so the list
 * still parses after `sectionOf` rejoins continuation lines during
 * cross-compaction merge.
 */
export const formatFileList = (category: string, paths: string[], limit: number): string => {
  const shown = paths.slice(0, limit);
  const lines = [`${category} (${paths.length}):`, ...shown.map((p) => `  ${p},`)];
  if (paths.length > limit) lines.push(`  (+${paths.length - limit} more)`);
  return lines.join("\n");
};
