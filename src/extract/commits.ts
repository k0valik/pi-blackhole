import type { NormalizedBlock } from "../types";

interface CommitInfo {
  hash?: string;
  message: string;
}

const COMMIT_MSG_RE =
  /git\s+commit[^\n]*?-m\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|\$?'((?:[^'\\]|\\.)*)')/;
// Match short hash from git output — only as fallback after bracket/range patterns fail.
// Requires 8+ hex chars to reduce false positives from random hex in tool output.
const HASH_RE = /\b([0-9a-f]{8,12})\b/;

const firstLineOf = (text: string): string => {
  const line = text.split(/\\n|\n/)[0] ?? "";
  return line.trim();
};

const cleanMessage = (msg: string): string => msg.replace(/\\"/g, '"').replace(/\\'/g, "'").trim();

/** Extract commit hash from git output text (tool_result or bash output). */
const extractHashFromOutput = (text: string): string | undefined => {
  const bracket = text.match(/\[\S+\s+([0-9a-f]{7,12})\]/);
  if (bracket) return bracket[1];
  const range = text.match(/\b([0-9a-f]{7,12})\.\.([0-9a-f]{7,12})\b/);
  if (range) return range[2];
  const plain = text.match(HASH_RE);
  if (plain) return plain[1];
  return undefined;
};

/** Try to extract a commit message from a git commit command string. */
const tryExtractMessage = (cmd: string): string | undefined => {
  if (!/\bgit\s+commit\b/.test(cmd)) return undefined;
  const m = cmd.match(COMMIT_MSG_RE);
  if (!m) return undefined;
  const message = firstLineOf(cleanMessage(m[1] ?? m[2] ?? m[3] ?? ""));
  return message || undefined;
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
      const message = tryExtractMessage(cmd);
      if (!message) continue;

      let hash: string | undefined;
      for (let j = i + 1; j < Math.min(blocks.length, i + 3); j++) {
        const r = blocks[j];
        if (r.kind !== "tool_result") continue;
        hash = extractHashFromOutput(r.text);
        if (hash) break;
      }
      addCommit(hash, message);
      continue;
    }

    // ── Case 2: bash execution message ──
    if (b.kind === "bash") {
      const message = tryExtractMessage(b.command);
      if (!message) continue;
      const hash = extractHashFromOutput(b.output);
      addCommit(hash, message);
      continue;
    }

    // ── Case 3: user message wrapping a bash execution (post-convertToLlm) ──
    if (b.kind === "user") {
      // Detect "Ran `git commit -m "..."`" pattern in user text
      const ranCmd = b.text.match(/Ran\s+`((?:[^`\\]|\\.)*)`/);
      if (!ranCmd) continue;
      const message = tryExtractMessage(ranCmd[1]);
      if (!message) continue;
      // Extract output from the code block following the command
      const codeBlock = b.text.match(/```\n([\s\S]*?)```/);
      const hash = codeBlock ? extractHashFromOutput(codeBlock[1]) : undefined;
      addCommit(hash, message);
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
