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
 * Find the longest common directory prefix among absolute paths.
 * Returns "" if fewer than 2 absolute paths or no meaningful common prefix.
 */
const longestCommonDirPrefix = (paths: string[]): string => {
  // Normalize backslashes (Windows) to forward slashes for uniform comparison
  const normalized = paths.map((p) => p.replace(/\\/g, "/"));
  const abs = normalized.filter((p) => p.startsWith("/") || /^[A-Za-z]:\//.test(p));
  if (abs.length < 2) return "";
  const split = abs.map((p) => p.split("/"));
  const min = Math.min(...split.map((s) => s.length));
  let i = 0;
  while (i < min - 1) {
    const seg = split[0][i];
    if (!split.every((s) => s[i] === seg)) break;
    i++;
  }
  if (i < 2) return ""; // require at least /a/b common
  return split[0].slice(0, i).join("/") + "/";
};

const trimPaths = (set: Set<string>, prefix: string): Set<string> => {
  if (!prefix) return set;
  const out = new Set<string>();
  for (const p of set) {
    out.add(p.startsWith(prefix) ? p.slice(prefix.length) : p);
  }
  return out;
};

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

const toLookupPath = (p: string, cwd?: string): string =>
  p.replace(/\\/g, "/").startsWith("/") || /^[A-Za-z]:\//.test(p)
    ? p.replace(/\\/g, "/")
    : cwd
      ? path.resolve(cwd, p).replace(/\\/g, "/")
      : p;

export const extractFiles = (
  blocks: NormalizedBlock[],
  fileOps?: FileOps,
  touched: FilesTouchedEntry[] = [],
  gitTags?: Map<string, string>,
  cwd?: string,
): FileActivity => {
  const act: FileActivity = {
    read: new Set(fileOps?.readFiles ?? []),
    modified: new Set(fileOps?.modifiedFiles ?? []),
    created: new Set(fileOps?.createdFiles ?? []),
  };

  seedFromTouched(act, touched);

  // Legacy name/path-args scan — fallback for tools the touch collector does
  // not model (e.g. custom extensions writing via path-like args).
  for (const b of blocks) {
    if (b.kind !== "tool_call") continue;
    const p = extractPath(b.args);
    if (!p) continue;

    if (FILE_READ_TOOLS.has(b.name)) act.read.add(p);
    if (FILE_WRITE_TOOLS.has(b.name)) act.modified.add(p);
    if (FILE_CREATE_TOOLS.has(b.name)) act.created.add(p);
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

  const all = [...act.read, ...act.modified, ...act.created];
  const prefix = longestCommonDirPrefix(all);

  // Annotate using the original (pre-trim) paths — the lookup needs the full
  // absolute path; keys are the trimmed display paths. "new" is suppressed on
  // Read-only entries — an untracked file that was only read was not created
  // by this session's writes.
  if (gitTags) {
    const annotations = new Map<string, string>();
    const collect = (set: Set<string>, allowNew: boolean) => {
      for (const p of set) {
        const tag = gitTags.get(toLookupPath(p, cwd));
        if (!tag || (tag === "new" && !allowNew)) continue;
        const display = prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p;
        annotations.set(display, tag);
      }
    };
    collect(act.modified, true);
    collect(act.created, true);
    collect(act.read, false);
    if (annotations.size > 0) act.gitTags = annotations;
  }

  if (prefix) {
    act.read = trimPaths(act.read, prefix);
    act.modified = trimPaths(act.modified, prefix);
    act.created = trimPaths(act.created, prefix);
  }

  return act;
};
