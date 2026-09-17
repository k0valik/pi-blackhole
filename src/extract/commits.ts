import type { NormalizedBlock } from "../types";

interface CommitInfo {
  hash?: string;
  message: string;
}

// Match short hash from git output — only as fallback after bracket/range patterns fail.
// Requires 8+ hex chars to reduce false positives from random hex in tool output.
const HASH_RE = /\b([0-9a-f]{8,12})\b/;

/** git's success line: `[branch ab12cd34] subject text`.
 * The bracket head is free-form — first commits print
 * `[main (root-commit) ab12cd34] …`, detached HEAD prints
 * `[detached HEAD ab12cd34] …`. Scoped to actual git-commit invocations
 * by the caller, so the loose prefix cannot misfire elsewhere. */
const OUTPUT_COMMIT_RE = /\[(?:[^\]\n]*\s)?([0-9a-f]{7,12})\]\s+(.+)/;
/** git refused to commit — not a commit artifact even though the command matched. */
const NOTHING_TO_COMMIT_RE =
  /nothing(?: to commit| added to commit but untracked)|no changes added to commit/;

const firstLineOf = (text: string): string => {
  const line = text.split(/\\n|\n/)[0] ?? "";
  return line.trim();
};

const cleanMessage = (msg: string): string => msg.replace(/\\"/g, '"').replace(/\\'/g, "'").trim();

/**
 * Tokenize a shell command respecting quotes and `\`-newline continuations.
 * Quoted segments stay single tokens so `grep "git commit -m 'x'"` cannot
 * masquerade as a git invocation. Bare newlines are kept as their own token
 * so multi-line scripts split into segments (a `\`-continuation still joins).
 */
const tokenizeCommand = (cmd: string): string[] => {
  const joined = cmd.replace(/\\\s*\n/g, " ");
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < joined.length; i++) {
    const c = joined[i];
    if (quote) {
      if (c === quote) {
        quote = undefined;
        cur += c;
      } else {
        cur += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "\n") {
      if (cur) tokens.push(cur);
      cur = "";
      tokens.push("\n");
      continue;
    }
    if (/\s/.test(c)) {
      if (cur) tokens.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur) tokens.push(cur);
  return tokens;
};

/**
 * Remove heredoc bodies from a command so their contents cannot leak into
 * token-based commit detection (e.g. a `cat <<EOF` body that mentions
 * `git commit` must not look like a git invocation). Delimiter start lines
 * are kept; body lines between them are dropped.
 */
const stripHeredocBodies = (cmd: string): string => {
  const out: string[] = [];
  let delim: string | undefined;
  for (const line of cmd.split("\n")) {
    if (delim !== undefined) {
      if (line.trim() === delim) delim = undefined;
      continue;
    }
    const m = line.match(/<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (m) delim = m[2];
    out.push(line);
  }
  return out.join("\n");
};

const SHELL_CONTROL = new Set(["&&", "||", ";", "|", "&", "\n"]);

/** Does this single-segment token list invoke `git commit` (not --dry-run)? */
const segmentInvokesCommit = (tokens: string[]): boolean => {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "commit") continue;
    let gitIdx = -1;
    for (let j = i - 1; j >= 0; j--) {
      const t = tokens[j];
      if (SHELL_CONTROL.has(t)) break; // different shell segment
      if (t === "git" || t.endsWith("/git")) {
        gitIdx = j;
        break;
      }
    }
    if (gitIdx === -1) continue;
    if (tokens.includes("--dry-run")) continue;
    return true;
  }
  return false;
};

/**
 * Token segments of actual `git commit` invocations, one per invocation.
 * Token-based: looks for a standalone `commit` token preceded by a `git`
 * executable token within the same shell segment, so flag order (`-c`, `-C`,
 * `--no-pager`, …) and flag values are irrelevant, and quoted occurrences
 * inside other commands don't match.
 */
const commitSegments = (cmd: string): string[][] => {
  const tokens = tokenizeCommand(stripHeredocBodies(cmd));
  const segments: string[][] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "commit") continue;
    let gitIdx = -1;
    for (let j = i - 1; j >= 0; j--) {
      const t = tokens[j];
      if (SHELL_CONTROL.has(t)) break; // different shell segment
      if (t === "git" || t.endsWith("/git")) {
        gitIdx = j;
        break;
      }
    }
    if (gitIdx === -1) continue;
    // Reject --dry-run: flags a commit that never happened. Segment-scoped
    // (from the git binary to the next control token) to stay precise.
    const segEnd = tokens.findIndex((t, k) => k > gitIdx && SHELL_CONTROL.has(t));
    const segment = tokens.slice(gitIdx, segEnd === -1 ? tokens.length : segEnd);
    if (segment.includes("--dry-run")) continue;
    segments.push(segment);
  }
  return segments;
};

/** Was this command an actual `git commit` invocation? */
const isGitCommitCommand = (cmd: string): boolean => commitSegments(cmd).length > 0;

/** Extract the subject (first non-comment, non-empty line) from a heredoc body. */
const heredocSubject = (body: string): string | undefined => {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    return line;
  }
  return undefined;
};

/**
 * Extract the commit message from a `… commit … -F - <<DELIM … DELIM` heredoc
 * in the raw command text. Returns undefined when there is no `-F -`/`--file=-`
 * heredoc.
 *
 * Scoped to the commit's own stdin flag: an earlier command in the same bash
 * call may use its own heredoc (`cat > notes.md <<'EOF' …`) or even its own
 * stdin flag, which must not donate its body as the commit message. Each
 * `-F -`/`--file`/`--stdin` flag is accepted only when the shell segment
 * ending at it invokes `git commit` — only heredocs starting after such a
 * flag belong to this commit.
 */
const STDIN_FLAG_RE = /(?:^|\s)(?:-F|--file)(?:=|\s+)-(?=\s|$)|(?:^|\s)--stdin(?:\s|$)/;
const HEREDOC_RE =
  /<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1\s*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?:\n|$)/;

const extractHeredocMessage = (cmd: string): string | undefined => {
  for (const m of cmd.matchAll(new RegExp(STDIN_FLAG_RE.source, "g"))) {
    const flagIdx = m.index ?? 0;
    // Shell segment ending at this flag must invoke git commit; otherwise
    // the flag (and its heredoc) belongs to an earlier command. Tokenizing
    // is quote-aware, so a flag inside a quoted string can never qualify.
    const before = stripHeredocBodies(cmd.slice(0, flagIdx));
    const tokens = tokenizeCommand(before);
    let segStart = 0;
    for (let k = 0; k < tokens.length; k++) {
      if (SHELL_CONTROL.has(tokens[k])) segStart = k + 1;
    }
    if (!segmentInvokesCommit(tokens.slice(segStart))) continue;
    const hm = cmd.slice(flagIdx).match(HEREDOC_RE);
    if (!hm) continue;
    return heredocSubject(hm[3]);
  }
  return undefined;
};

/**
 * Extract the message from a `-m`/`--message` flag, position-independent.
 * Scoped to the commit invocation's own token segment: an `-m` belonging to
 * a later command (`… && docker run -m 2g img`) or inside a heredoc body must
 * not shadow the real message (or invent one for a `-F -` commit).
 */
const extractDashMMessage = (cmd: string): string | undefined => {
  for (const segment of commitSegments(cmd)) {
    const text = segment.join(" ");
    const m =
      text.match(/(?:^|\s)-m\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+))/) ??
      text.match(/(?:^|\s)--message(?:=|\s+)(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+))/);
    if (!m) continue;
    const message = firstLineOf(cleanMessage(m[1] ?? m[2] ?? m[3] ?? ""));
    if (message) return message;
  }
  return undefined;
};

/** Extract commit hash from git output text (tool_result or bash output). */
const extractHashFromOutput = (text: string): string | undefined => {
  const bracket = text.match(/\[(?:[^\]\n]*\s)?([0-9a-f]{7,12})\]/);
  if (bracket) return bracket[1];
  const range = text.match(/\b([0-9a-f]{7,12})\.\.([0-9a-f]{7,12})\b/);
  if (range) return range[2];
  const plain = text.match(HASH_RE);
  if (plain) return plain[1];
  return undefined;
};

/** Extract the subject from git's success line `[branch hash] subject`. */
const extractOutputSubject = (output: string): { hash: string; subject: string } | undefined => {
  const m = output.match(OUTPUT_COMMIT_RE);
  if (!m) return undefined;
  const subject = firstLineOf(m[2]);
  return subject ? { hash: m[1], subject } : undefined;
};

interface CommitExtraction {
  message?: string;
  /** Commit failed — do not record. */
  failed?: boolean;
}

/** Try to recover the commit message from a git commit command + its output. */
const extractFromCommitCommand = (cmd: string, output: string): CommitExtraction => {
  if (!isGitCommitCommand(cmd)) return {};
  if (NOTHING_TO_COMMIT_RE.test(output)) return { failed: true };

  // 1. -m flag (subject)
  const dashM = extractDashMMessage(cmd);
  if (dashM) return { message: dashM };

  // 2. -F - / --file=- heredoc body (subject)
  const heredoc = extractHeredocMessage(cmd);
  if (heredoc) return { message: heredoc };

  // 3. git's success line in the output (covers --file=<path>, wrappers, -q gaps)
  const fromOutput = extractOutputSubject(output);
  if (fromOutput) return { message: fromOutput.subject };

  // 4. Known hash but unrecoverable message → stable placeholder. Without a
  //    hash (quiet/suppressed output) there is nothing recordable — drop.
  const hash = extractHashFromOutput(output);
  if (hash) return { message: "(message not captured)" };
  return {};
};

/** Commit info from a command + the output of its execution, if any. */
const tryExtract = (
  cmd: string,
  output: string,
): { hash?: string; message: string } | undefined => {
  const { message, failed } = extractFromCommitCommand(cmd, output);
  if (failed || !message) return undefined;
  const hash = extractHashFromOutput(output);
  return { hash, message };
};

/**
 * Extract git commits from bash tool calls, bash execution messages,
 * and user messages that wrap bash execution output (post-convertToLlm).
 *
 * Handles three block kinds:
 * - tool_call (name: "bash") — agent tool call to the bash tool
 * - bash — pi's internal bashExecution message
 * - user — convertToLlm wraps bashExecution as "Ran `cmd`\n```\noutput\n```"
 */
export const extractCommits = (blocks: NormalizedBlock[]): CommitInfo[] => {
  const commits: CommitInfo[] = [];
  const addCommit = (hash: string | undefined, message: string) => {
    const key = `${hash ?? ""}::${message}`;
    if (!commits.some((c) => `${c.hash ?? ""}::${c.message}` === key)) {
      commits.push({ hash, message });
    }
  };

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];

    // ── Case 1: tool_call (agent calls bash tool) ──
    if (b.kind === "tool_call" && b.name === "bash") {
      const cmd = b.args && typeof b.args.command === "string" ? b.args.command : "";
      if (!isGitCommitCommand(cmd)) continue;

      // Pair the command with its own result. Normalized results carry the
      // tool name, so a sibling tool's result — or its error — must not be
      // consumed here: an interleaved foreign error previously killed the
      // commit, and a foreign success line could misattribute hash/message.
      for (let j = i + 1; j < Math.min(blocks.length, i + 3); j++) {
        const r = blocks[j];
        if (r.kind !== "tool_result") continue;
        if (r.name !== b.name) continue;
        if (r.isError) break;
        const commit = tryExtract(cmd, r.text);
        if (commit) addCommit(commit.hash, commit.message);
        break;
      }
      continue;
    }

    // ── Case 2: bash execution message ──
    if (b.kind === "bash") {
      // Nonzero exit → the commit did not happen.
      if (b.exitCode !== undefined && b.exitCode !== 0) continue;
      const commit = tryExtract(b.command, b.output);
      if (commit) addCommit(commit.hash, commit.message);
      continue;
    }

    // ── Case 3: user message wrapping a bash execution (post-convertToLlm) ──
    if (b.kind === "user") {
      // Detect "Ran `git commit …`" pattern in user text
      const ranCmd = b.text.match(/Ran\s+`((?:[^`\\]|\\.)*)`/);
      if (!ranCmd) continue;
      if (!isGitCommitCommand(ranCmd[1])) continue;
      // Extract output from the code block following the command
      const codeBlock = b.text.match(/```\n([\s\S]*?)```/);
      const output = codeBlock ? codeBlock[1] : "";
      const commit = tryExtract(ranCmd[1], output);
      if (commit) addCommit(commit.hash, commit.message);
    }
  }

  return commits;
};

export const formatCommits = (commits: CommitInfo[], limit = 8): string[] => {
  const lines: string[] = [];
  const items = commits.slice(-limit); // keep most recent
  for (const c of items) {
    const prefix = c.hash ? `${c.hash}: ` : "";
    lines.push(`${prefix}${c.message}`);
  }
  return lines;
};
