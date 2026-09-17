import { describe, it, expect } from "vitest";
import { extractCommits, formatCommits } from "../src/extract/commits.js";
import type { NormalizedBlock } from "../src/types.js";

const toolCall = (cmd: string): NormalizedBlock => ({
  kind: "tool_call",
  name: "bash",
  args: { command: cmd },
});
const toolResult = (text: string, isError = false): NormalizedBlock => ({
  kind: "tool_result",
  name: "bash",
  text,
  isError,
});
const bashBlock = (command: string, output = "", exitCode = 0): NormalizedBlock => ({
  kind: "bash",
  command,
  output,
  exitCode,
});
const userRan = (cmd: string, output = ""): NormalizedBlock => ({
  kind: "user",
  text: `Ran \`${cmd}\`\n\`\`\`\n${output}\n\`\`\``,
});

describe("formatCommits — recall refs", () => {
  const callAt = (cmd: string, sourceIndex: number): NormalizedBlock => ({
    kind: "tool_call",
    name: "bash",
    args: { command: cmd },
    sourceIndex,
  });
  const resultAt = (text: string, sourceIndex: number): NormalizedBlock => ({
    kind: "tool_result",
    name: "bash",
    text,
    isError: false,
    sourceIndex,
  });

  it("emits the invoking command's (#N) ref", () => {
    const out = extractCommits([
      callAt(`git commit -m "fix: x"`, 41),
      resultAt("[main 99e6a9f] fix: x", 42),
    ]);
    expect(formatCommits(out)).toEqual(["99e6a9f: fix: x (#41)"]);
  });

  it("emits no ref when the source index is unknown", () => {
    const out = extractCommits([
      toolCall(`git commit -m "fix: x"`),
      toolResult("[main 99e6a9f] fix: x"),
    ]);
    expect(formatCommits(out)).toEqual(["99e6a9f: fix: x"]);
  });

  it("dedup keeps the first occurrence's ref", () => {
    const out = extractCommits([
      callAt(`git commit -m "fix: x"`, 41),
      resultAt("[main 99e6a9f] fix: x", 42),
      callAt(`git commit -m "fix: x"`, 90),
      resultAt("[main 99e6a9f] fix: x", 91),
    ]);
    expect(formatCommits(out)).toEqual(["99e6a9f: fix: x (#41)"]);
  });

  it("bash execution blocks carry their own ref", () => {
    const out = extractCommits([
      { ...bashBlock(`git commit -m "fix: x"`, "[main 99e6a9f] fix: x"), sourceIndex: 7 },
    ]);
    expect(formatCommits(out)).toEqual(["99e6a9f: fix: x (#7)"]);
  });
});

describe("extractCommits — detection (flag-order tolerance)", () => {
  it("detects git -C <dir> commit", () => {
    const out = extractCommits([
      toolCall(`git -C ~/repo commit -m "fix parser"`),
      toolResult("[main 99e6a9f] fix parser"),
    ]);
    expect(formatCommits(out)).toContain("99e6a9f: fix parser");
  });

  it("detects git -c key=val commit", () => {
    const out = extractCommits([
      toolCall(`git -c user.name="bot" commit -m "fix: x"`),
      toolResult("[main 99e6a9f] fix: x"),
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.message).toBe("fix: x");
  });

  it("detects git --no-pager commit", () => {
    const out = extractCommits([
      toolCall(`git --no-pager commit -m "fix: y"`),
      toolResult("[main 99e6a9f] fix: y"),
    ]);
    expect(out.length).toBe(1);
  });

  it("detects commit across a line continuation", () => {
    const out = extractCommits([
      toolCall(`git commit -m "fix: z" \\\n  --no-edit`),
      toolResult("[main 99e6a9f] fix: z"),
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.message).toBe("fix: z");
  });

  it("detects commit inside a compound command", () => {
    const out = extractCommits([
      toolCall(`pnpm build && git commit -m "fix: compound" && git push`),
      toolResult("[main 99e6a9f] fix: compound"),
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.message).toBe("fix: compound");
  });
});

describe("extractCommits — precision: commands that must NOT extract", () => {
  it("does not extract from grep quoting a git commit string", () => {
    // This is a live false positive of the old regex: `-m 'x'` inside the
    // quoted pattern matches COMMIT_MSG_RE.
    const out = extractCommits([
      toolCall(`grep -rn "git commit -m 'x'" src/`),
      toolResult("src/a.ts:1: git commit -m 'x'"),
    ]);
    expect(out).toEqual([]);
  });

  it("does not extract from echo of a commit string", () => {
    const out = extractCommits([
      toolCall(`echo "run git commit -m 'nope' to ship"`),
      toolResult("run git commit -m 'nope' to ship"),
    ]);
    expect(out).toEqual([]);
  });

  it("does not extract from a quoted heredoc body mentioning commits", () => {
    const out = extractCommits([
      toolCall(`cat <<'EOF'\ngit commit -m "not a real command"\nEOF`),
      toolResult(""),
    ]);
    expect(out).toEqual([]);
  });

  it("does not extract git log / git show / git diff", () => {
    for (const cmd of [`git log --oneline -5`, `git show 99e6a9f`, `git diff --stat HEAD~1`]) {
      expect(extractCommits([toolCall(cmd), toolResult("[main 99e6a9f] whatever")])).toEqual([]);
    }
  });

  it("does not extract --dry-run (no commit is created)", () => {
    const out = extractCommits([
      toolCall(`git commit --dry-run -m "wip"`),
      toolResult("On branch main\nnothing to commit, working tree clean"),
    ]);
    expect(out).toEqual([]);
  });

  it("does not extract a failed commit (nothing to commit output)", () => {
    const out = extractCommits([
      toolCall(`git commit -m "fix: will fail"`),
      toolResult("On branch main\nnothing to commit, working tree clean"),
    ]);
    expect(out).toEqual([]);
  });

  it("does not extract a commit whose tool result errored", () => {
    const out = extractCommits([
      toolCall(`git commit -m "fix: hook rejected"`),
      toolResult("husky > pre-commit failed", true),
    ]);
    expect(out).toEqual([]);
  });
});

describe("extractCommits — -F - heredoc messages", () => {
  it("extracts subject from quoted-delimiter heredoc", () => {
    const cmd = [
      `cd ~/proj && git add -A && git commit -q -F - <<'MSG'`,
      `fix: read SGLang live rates from realtime_tokens_total`,
      ``,
      `Long body paragraph with the why.`,
      `MSG`,
    ].join("\n");
    const out = extractCommits([
      toolCall(cmd),
      toolResult("[main 99e6a9f] fix: read SGLang live rates from realtime_tokens_total"),
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.message).toBe("fix: read SGLang live rates from realtime_tokens_total");
  });

  it("skips leading comment lines in heredoc body", () => {
    const cmd = [`git commit -F - <<'MSG'`, `# draft note`, `fix: real subject`, `MSG`].join("\n");
    const out = extractCommits([toolCall(cmd), toolResult("[main 99e6a9f] fix: real subject")]);
    expect(out[0]?.message).toBe("fix: real subject");
  });

  it("handles unquoted heredoc delimiters", () => {
    const cmd = [`git commit -F - <<MSG`, `fix: unquoted delim`, `MSG`].join("\n");
    const out = extractCommits([toolCall(cmd), toolResult("[main 99e6a9f] fix: unquoted delim")]);
    expect(out[0]?.message).toBe("fix: unquoted delim");
  });

  it("terminates heredoc at the delimiter, not at a lookalike inside the body", () => {
    const cmd = [
      `git commit -F - <<'MSG'`,
      `fix: subject line`,
      `refer to MSG marker in text`,
      `MSG`,
      `git push`,
    ].join("\n");
    const out = extractCommits([toolCall(cmd), toolResult("[main 99e6a9f] fix: subject line")]);
    expect(out[0]?.message).toBe("fix: subject line");
  });

  it("keeps message subject-only (body is not pasted into the section)", () => {
    const cmd = [
      `git commit -F - <<'MSG'`,
      `fix: subject`,
      ``,
      `body line that must not appear`,
      `MSG`,
    ].join("\n");
    const out = extractCommits([toolCall(cmd), toolResult("")]);
    expect(out[0]?.message).toBe("fix: subject");
  });
});

describe("extractCommits — message recovery fallbacks", () => {
  it("recovers subject from git output when command has no message flag", () => {
    const out = extractCommits([
      toolCall(`git commit --file=/tmp/msg.txt`),
      toolResult("[main 99e6a9f] fix: subject from output"),
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.hash).toBe("99e6a9f");
    expect(out[0]?.message).toBe("fix: subject from output");
  });

  it("records a hash-only placeholder when message is unrecoverable but hash is known", () => {
    // Output shows the bracket line but was truncated before the subject.
    const out = extractCommits([
      toolCall(`git commit -q --file=/tmp/msg.txt`),
      toolResult("[main 99e6a9f]"),
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.hash).toBe("99e6a9f");
    expect(out[0]?.message).toContain("not captured");
  });

  it("drops a detected commit with neither message nor hash (no placeholder noise)", () => {
    const out = extractCommits([toolCall(`git commit -q --file=/tmp/msg.txt`), toolResult("")]);
    expect(out).toEqual([]);
  });

  it("still extracts plain -m commands (regression armor)", () => {
    const out = extractCommits([
      toolCall(`git commit -m "fix parser"`),
      toolResult("[main 99e6a9f] fix parser"),
    ]);
    expect(formatCommits(out)).toEqual(["99e6a9f: fix parser"]);
  });

  it("still unescapes \\-escaped quotes in -m messages", () => {
    const out = extractCommits([
      toolCall(`git commit -m "fix \\"quoted\\" parser"`),
      toolResult('[main 99e6a9f] fix "quoted" parser'),
    ]);
    expect(out[0]?.message).toBe(`fix "quoted" parser`);
  });
});

describe("extractCommits — other block kinds", () => {
  it("handles bash-execution messages with flag-order + heredoc", () => {
    const cmd = [`git -c user.name=x commit -F - <<'MSG'`, `fix: via bash kind`, `MSG`].join("\n");
    const out = extractCommits([bashBlock(cmd, "[main 99e6a9f] fix: via bash kind")]);
    expect(out[0]?.message).toBe("fix: via bash kind");
    expect(out[0]?.hash).toBe("99e6a9f");
  });

  it("does not extract failed bash-execution commits (nonzero exit)", () => {
    const out = extractCommits([
      bashBlock(`git commit -m "fix: failed"`, "error: pre-commit hook rejected", 1),
    ]);
    expect(out).toEqual([]);
  });

  it("handles user-wrapped Ran `…` messages with flag order", () => {
    const out = extractCommits([
      userRan(`git -C dir commit -m "fix user wrap"`, "[main 99e6a9f] fix user wrap"),
    ]);
    expect(out[0]?.message).toBe("fix user wrap");
  });

  it("does not extract user text that merely mentions git commit", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "you should run git commit -m 'x' more often" },
    ];
    expect(extractCommits(blocks)).toEqual([]);
  });
});

describe("extractCommits — flag scoping and success-line forms (#105 follow-up)", () => {
  const namedResult = (name: string, text: string, isError = false): NormalizedBlock => ({
    kind: "tool_result",
    name,
    text,
    isError,
  });

  it("extracts the space-separated --message long form", () => {
    // Quiet output: nothing recoverable from git's stdout, so the flag
    // itself must parse (old code only knew --message=).
    const out = extractCommits([
      toolCall(`git commit -q --message "fix: long form"`),
      toolResult(""),
    ]);
    expect(out[0]?.message).toBe("fix: long form");
  });

  it("ignores -m belonging to a later command in the same call", () => {
    // The -m flag here belongs to `docker run`, not the commit. The old
    // whole-command scan returned "2g" and — by priority order — shadowed
    // the real heredoc message.
    const cmd = [
      `git commit -q -F - <<'MSG'`,
      `fix: real subject from heredoc`,
      `MSG`,
      `docker run -m 2g img`,
    ].join("\n");
    const out = extractCommits([toolCall(cmd), toolResult("")]);
    expect(out[0]?.message).toBe("fix: real subject from heredoc");
  });

  it("ignores an earlier command's heredoc when recovering the commit message", () => {
    // The first heredoc in the raw command belongs to `cat`, not the commit.
    // The unscoped search returned "Some notes" and — by priority order —
    // shadowed both the real heredoc message and git's success line.
    const cmd = [
      `cat > notes.md <<'EOF'`,
      `Some notes`,
      `EOF`,
      `git add -A && git commit -F - <<'MSG'`,
      `fix: real subject`,
      `MSG`,
    ].join("\n");
    const out = extractCommits([toolCall(cmd), toolResult("[main 99e6a9f] fix: real subject")]);
    expect(out[0]?.message).toBe("fix: real subject");
  });

  it("ignores an earlier command's own stdin flag and heredoc", () => {
    // Both commands carry `-F -`. The flag-first search must not stop at the
    // earlier command's flag: its segment does not invoke git commit, so its
    // heredoc body must not become the message.
    const cmd = [
      `render -F - <<'EOF'`,
      `not the message`,
      `EOF`,
      `git commit -F - <<'MSG'`,
      `fix: real subject`,
      `MSG`,
    ].join("\n");
    const out = extractCommits([toolCall(cmd), toolResult("[main 99e6a9f] fix: real subject")]);
    expect(out[0]?.message).toBe("fix: real subject");
  });

  it("ignores -m-like text inside the heredoc body", () => {
    const cmd = [
      `git commit -q -F - <<'MSG'`,
      `fix: real subject`,
      ``,
      `Note: run the container with -m 4g of memory.`,
      `MSG`,
    ].join("\n");
    const out = extractCommits([toolCall(cmd), toolResult("")]);
    expect(out[0]?.message).toBe("fix: real subject");
  });

  it("extracts root-commit success lines", () => {
    const out = extractCommits([
      toolCall(`git commit -m "feat: initial"`),
      toolResult("[main (root-commit) 99e6a9f] feat: initial"),
    ]);
    expect(out[0]?.message).toBe("feat: initial");
    expect(out[0]?.hash).toBe("99e6a9f");
  });

  it("extracts detached-HEAD success lines", () => {
    const out = extractCommits([
      toolCall(`git commit --amend --no-edit`),
      toolResult("[detached HEAD 99e6a9f] fix: amended on detached head"),
    ]);
    expect(out[0]?.message).toBe("fix: amended on detached head");
    expect(out[0]?.hash).toBe("99e6a9f");
  });

  it("does not consume a sibling tool's result for pairing", () => {
    // Parallel calls interleave results; the read result must not stand in
    // for the commit's own output (old code took the first result, losing
    // the hash here).
    const out = extractCommits([
      toolCall(`git commit -m "fix: mine"`),
      namedResult("read", "file contents here"),
      toolResult("[main 99e6a9f] fix: mine"),
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.message).toBe("fix: mine");
    expect(out[0]?.hash).toBe("99e6a9f");
  });

  it("does not let a foreign error result kill the commit", () => {
    const out = extractCommits([
      toolCall(`git commit -m "fix: survives"`),
      namedResult("read", "Error: file not found", true),
      toolResult("[main 99e6a9f] fix: survives"),
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.message).toBe("fix: survives");
  });

  it("still drops the commit on its own tool error (regression armor)", () => {
    const out = extractCommits([
      toolCall(`git commit -m "fix: hook rejected"`),
      toolResult("husky > pre-commit failed", true),
    ]);
    expect(out).toEqual([]);
  });
});
