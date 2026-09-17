import { describe, it, expect } from "vitest";
import type { Message } from "@earendil-works/pi-ai";

import { collectFilesTouched } from "../src/extract/file-touch.js";
import { buildSections } from "../src/core/build-sections.js";

// ── message builders ─────────────────────────────────────────────

let idCounter = 0;
const nextId = () => `call_${++idCounter}`;

const assistantWith = (
  ...toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>
): Message =>
  ({
    role: "assistant",
    content: toolCalls.map((tc) => ({
      type: "toolCall" as const,
      id: tc.id,
      name: tc.name,
      arguments: tc.args,
    })),
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: ++idCounter,
  }) as unknown as Message;

const toolResult = (
  toolCallId: string,
  toolName: string,
  text: string,
  opts: { isError?: boolean; timestamp?: number } = {},
): Message =>
  ({
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text" as const, text }],
    isError: opts.isError ?? false,
    timestamp: opts.timestamp ?? ++idCounter,
  }) as unknown as Message;

const bashMessage = (command: string, timestamp?: number): Message =>
  ({
    role: "bashExecution",
    command,
    output: "",
    exitCode: 0,
    timestamp: timestamp ?? ++idCounter,
  }) as unknown as Message;

/** Find a single ops-set entry by path suffix in collector output. */
const opsOf = (touched: ReturnType<typeof collectFilesTouched>, pathSuffix: string) => {
  const matches = touched.filter((t) => t.path.endsWith(pathSuffix));
  expect(
    matches.length,
    `expected exactly one entry ending in ${pathSuffix}, got ${JSON.stringify(touched.map((t) => t.path))}`,
  ).toBe(1);
  return matches[0].operations;
};

// ── collector: native tools ──────────────────────────────────────

describe("collectFilesTouched — native pi tools", () => {
  it("attributes read/write/edit via args.path", () => {
    const a = nextId(),
      b = nextId(),
      c = nextId();
    const messages: Message[] = [
      assistantWith(
        { id: a, name: "read", args: { path: "src/a.ts" } },
        { id: b, name: "write", args: { path: "src/b.ts" } },
        { id: c, name: "edit", args: { path: "src/c.ts" } },
      ),
      toolResult(a, "read", "contents"),
      toolResult(b, "write", "Successfully wrote 10 bytes to src/b.ts"),
      toolResult(c, "edit", "Successfully replaced 1 block(s) in src/c.ts."),
    ];
    const touched = collectFilesTouched(messages, "/repo");
    expect(opsOf(touched, "src/a.ts").has("read")).toBe(true);
    expect(opsOf(touched, "src/b.ts").has("write")).toBe(true);
    expect(opsOf(touched, "src/c.ts").has("edit")).toBe(true);
  });

  it("skips failed tool results", () => {
    const a = nextId();
    const messages: Message[] = [
      assistantWith({ id: a, name: "write", args: { path: "src/a.ts" } }),
      toolResult(a, "write", "Error: disk full", { isError: true }),
    ];
    expect(collectFilesTouched(messages, "/repo")).toHaveLength(0);
  });

  it("suppresses no-op edits", () => {
    const a = nextId();
    const messages: Message[] = [
      assistantWith({ id: a, name: "edit", args: { path: "src/a.ts" } }),
      toolResult(
        a,
        "edit",
        "No changes made to src/a.ts. The replacement produced identical content.",
      ),
    ];
    expect(collectFilesTouched(messages, "/repo")).toHaveLength(0);
  });
});

// ── collector: hashline tools (no path in args) ──────────────────

describe("collectFilesTouched — hashline anchor tools", () => {
  it("resolves path from replace result text", () => {
    const a = nextId();
    const messages: Message[] = [
      assistantWith({
        id: a,
        name: "replace",
        args: { remove_from: "otWa", remove_to: "otWa", replacement_lines: ["x"] },
      }),
      toolResult(
        a,
        "replace",
        "Successfully replaced in /repo/src/main.ts. Added 1 line(s), removed 1 line(s).",
      ),
    ];
    const touched = collectFilesTouched(messages, "/repo");
    expect(opsOf(touched, "src/main.ts").has("edit")).toBe(true);
  });

  it("resolves native edit path from result text when args carry no path", () => {
    const a = nextId();
    const messages: Message[] = [
      assistantWith({ id: a, name: "edit", args: { some_anchor: "abc" } }),
      toolResult(a, "edit", "Successfully replaced 3 block(s) in src/om/compaction-trigger.ts."),
    ];
    const touched = collectFilesTouched(messages, "/repo");
    expect(opsOf(touched, "compaction-trigger.ts").has("edit")).toBe(true);
  });

  it("resolves path from write result text", () => {
    const a = nextId();
    const messages: Message[] = [
      assistantWith({ id: a, name: "write", args: { content: "x" } }),
      toolResult(
        a,
        "write",
        "Successfully wrote 18601 bytes to tests/auto-compact-permutations.test.ts",
      ),
    ];
    const touched = collectFilesTouched(messages, "/repo");
    expect(opsOf(touched, "auto-compact-permutations.test.ts").has("write")).toBe(true);
  });

  it("does not record noop hashline results even via result text", () => {
    const a = nextId();
    const messages: Message[] = [
      assistantWith({
        id: a,
        name: "replace",
        args: { changes: [{ hash_range_inclusive: ["9MQ", "9MQ"] }] },
      }),
      toolResult(a, "replace", "No changes made to src/x.ts | Classification: noop |"),
    ];
    expect(collectFilesTouched(messages, "/repo")).toHaveLength(0);
  });
});

// ── collector: bash parsing ──────────────────────────────────────

describe("collectFilesTouched — bash mutations", () => {
  it.each([
    ["echo hi > out.txt", "out.txt", "write"],
    ["echo hi >> out.txt", "out.txt", "write"],
    ["sed -i 's/a/b/' conf.yaml", "conf.yaml", "edit"],
    ["echo hi | tee out.txt", "out.txt", "write"],
    ["cp a.txt b.txt", "b.txt", "write"],
    ["touch marker", "marker", "write"],
  ] as const)("%s → %s (%s)", (cmd, path, op) => {
    const messages: Message[] = [bashMessage(cmd)];
    const touched = collectFilesTouched(messages, "/repo");
    expect(opsOf(touched, path).has(op)).toBe(true);
  });

  it("parses the bash tool call like bare bashExecution messages", () => {
    const a = nextId();
    const messages: Message[] = [
      assistantWith({ id: a, name: "bash", args: { command: "sed -i 's/1/2/' file.txt" } }),
      toolResult(a, "bash", ""),
    ];
    const touched = collectFilesTouched(messages, "/repo");
    expect(opsOf(touched, "file.txt").has("edit")).toBe(true);
  });

  it("does not treat heredoc body lines as paths", () => {
    const messages: Message[] = [
      bashMessage("cat > notes.md <<'EOF'\nrm -rf /somewhere/evil\nsome > weird > lines\nEOF"),
    ];
    const touched = collectFilesTouched(messages, "/repo");
    const noteOps = touched.find((t) => t.path.endsWith("notes.md"));
    expect(noteOps?.operations.has("write")).toBe(true);
    expect(touched.find((t) => t.path.includes("evil"))).toBeUndefined();
    expect(touched.find((t) => t.path.endsWith("lines"))).toBeUndefined();
  });

  it("ignores /dev/null redirects and non-literal operands", () => {
    const messages: Message[] = [
      bashMessage("pnpm test 2>&1 >/dev/null && echo $OUT_VAR > $DYNAMIC"),
    ];
    expect(collectFilesTouched(messages, "/repo")).toHaveLength(0);
  });

  it("tracks reads from cat/head/tail", () => {
    const messages: Message[] = [bashMessage("cat README.md | head -5 && tail -3 CHANGELOG.md")];
    const touched = collectFilesTouched(messages, "/repo");
    expect(opsOf(touched, "README.md").has("read")).toBe(true);
    expect(opsOf(touched, "CHANGELOG.md").has("read")).toBe(true);
  });

  it("resolves moves: earlier ops on the old path merge into the destination", () => {
    const messages: Message[] = [
      bashMessage("echo v1 > draft.md"),
      bashMessage("sed -i 's/v1/v2/' draft.md"),
      bashMessage("mv draft.md final.md"),
    ];
    const touched = collectFilesTouched(messages, "/repo");
    const names = touched.map((t) => t.path);
    expect(names.some((n) => n.endsWith("draft.md"))).toBe(false);
    const dest = touched.find((t) => t.path.endsWith("final.md"));
    expect(dest).toBeDefined();
    expect(dest!.operations.has("write")).toBe(true);
    expect(dest!.operations.has("edit")).toBe(true);
    expect(dest!.operations.has("move")).toBe(true);
  });
});

// ── deleted / moved-away files are dropped entirely ──────────────

describe("collectFilesTouched — deleted files", () => {
  it("marks scratch files as lastOperation=delete (extractFiles drops them)", () => {
    const messages: Message[] = [
      bashMessage("echo x > /tmp/scratch.py"),
      bashMessage("python3 /tmp/scratch.py"),
      bashMessage("rm /tmp/scratch.py"),
    ];
    const touched = collectFilesTouched(messages, "/repo");
    expect(touched.find((t) => t.path.endsWith("scratch.py"))?.lastOperation).toBe("delete");
  });

  it("keeps files recreated after a delete", () => {
    const messages: Message[] = [
      bashMessage("rm marker.txt"),
      bashMessage("echo fresh > marker.txt"),
    ];
    const touched = collectFilesTouched(messages, "/repo");
    const entry = touched.find((t) => t.path.endsWith("marker.txt"));
    expect(entry).toBeDefined();
    expect(entry!.operations.has("write")).toBe(true);
    expect(entry!.lastOperation).not.toBe("delete");
  });

  it("flags delete as the last operation (dropped downstream from the summary)", () => {
    const messages: Message[] = [bashMessage("cat /tmp/old.log"), bashMessage("rm /tmp/old.log")];
    const touched = collectFilesTouched(messages, "/repo");
    const entry = touched.find((t) => t.path.endsWith("old.log"));
    expect(entry?.lastOperation).toBe("delete");
  });
});

// ── dedup across relative/absolute forms ─────────────────────────

describe("collectFilesTouched — path canonicalization", () => {
  it("merges relative and absolute references to the same file", () => {
    const a = nextId(),
      b = nextId();
    const messages: Message[] = [
      assistantWith({ id: a, name: "edit", args: { path: "src/main.ts" } }),
      toolResult(a, "edit", "Successfully replaced 1 block(s) in src/main.ts."),
      assistantWith({ id: b, name: "read", args: { path: "/repo/src/main.ts" } }),
      toolResult(b, "read", "contents"),
    ];
    const touched = collectFilesTouched(messages, "/repo");
    const entries = touched.filter((t) => t.path.endsWith("main.ts"));
    expect(entries).toHaveLength(1);
    expect(entries[0].operations.has("edit")).toBe(true);
    expect(entries[0].operations.has("read")).toBe(true);
  });

  it("strips read-slice suffixes from read paths", () => {
    const a = nextId();
    const messages: Message[] = [
      assistantWith({ id: a, name: "read", args: { path: "src/main.ts:10-40" } }),
      toolResult(a, "read", "contents"),
    ];
    const touched = collectFilesTouched(messages, "/repo");
    const entry = touched.find((t) => t.path.endsWith("main.ts"));
    expect(entry?.path.includes(":10-40")).toBe(false);
  });
});

// ── buildSections integration ────────────────────────────────────

describe("buildSections Files And Changes via session messages", () => {
  it("lists real deliverables and omits deleted scratch files", () => {
    const a = nextId(),
      b = nextId(),
      c = nextId(),
      d = nextId(),
      e = nextId();
    const messages: Message[] = [
      assistantWith({ id: a, name: "read", args: { path: "/repo/src/main.ts" } }),
      toolResult(a, "read", "contents", { timestamp: 1 }),
      assistantWith({
        id: b,
        name: "replace",
        args: { remove_from: "otWa", remove_to: "otWa", replacement_lines: ["x"] },
      }),
      toolResult(
        b,
        "replace",
        "Successfully replaced in /repo/src/main.ts. Added 1 line(s), removed 1 line(s).",
        { timestamp: 2 },
      ),
      assistantWith({ id: c, name: "write", args: { path: "/repo/README.md" } }),
      toolResult(c, "write", "Successfully wrote 200 bytes to /repo/README.md", { timestamp: 3 }),
      assistantWith({ id: d, name: "bash", args: { command: "python3 bench.py" } }),
      toolResult(d, "bash", "ok", { timestamp: 4 }),
      assistantWith({ id: e, name: "bash", args: { command: "echo x > bench.py" } }),
      toolResult(e, "bash", "", { timestamp: 5 }),
      bashMessage("rm bench.py", 6),
    ];
    const r = buildSections({ blocks: [], messages, cwd: "/repo" });
    const files = r.filesAndChanges.join("\n");
    const modifiedLine = files.split("\n").find((l) => l.startsWith("Modified:")) ?? "";
    // modified beats read for main.ts; common prefix "/repo/" is trimmed;
    // insertion order is recency-based, so assert membership not position
    expect(modifiedLine).toContain("src/main.ts");
    expect(modifiedLine).toContain("README.md");
    expect(files).not.toContain("Read:");
    expect(files).not.toContain("bench.py");
  });

  it("still supports the legacy block-only path when no messages are provided", () => {
    const r = buildSections({
      blocks: [
        { kind: "tool_call", name: "Edit", args: { file_path: "src/legacy.ts" } },
        { kind: "tool_result", name: "Edit", text: "ok" },
      ],
    });
    expect(r.filesAndChanges.join("\n")).toContain("legacy.ts");
  });

  it("fileOps seeds survive when messages are absent", () => {
    const r = buildSections({
      blocks: [],
      fileOps: { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] },
    });
    const files = r.filesAndChanges.join("\n");
    expect(files).toContain("Read: a.ts");
    expect(files).toContain("Modified: b.ts");
  });

  it("merges relative legacy tool-arg paths with absolute collector paths (no dupes)", () => {
    // The collector resolves to absolute paths via cwd while the legacy
    // block scan sees the raw relative arg — both describe one file and must
    // render once, trimmed to the shared prefix.
    const a = nextId();
    const messages: Message[] = [
      assistantWith({ id: a, name: "write", args: { path: "/repo/src/main.ts" } }),
      toolResult(a, "write", "ok", { timestamp: 1 }),
    ];
    const r = buildSections({
      blocks: [{ kind: "tool_call", name: "Edit", args: { file_path: "src/main.ts" } }],
      messages,
      cwd: "/repo",
    });
    const files = r.filesAndChanges.join("\n");
    const occurrences = files.split("src/main.ts").length - 1;
    expect(occurrences).toBe(1);
    // single absolute path has no shared prefix to trim — the point is it
    // renders once, not as both "src/main.ts" and "/repo/src/main.ts"
    expect(files).toContain("Modified: /repo/src/main.ts");
  });
});

describe("buildSections Files And Changes — path cleanup and recency ordering", () => {
  it("strips quotes and :start-end suffixes from legacy tool-arg paths", () => {
    // Raw tool args carry editor strings — without cleanup the literal
    // `"src/quoted.ts:10-40"` becomes a phantom entry distinct from the file.
    const r = buildSections({
      blocks: [{ kind: "tool_call", name: "Edit", args: { file_path: '"src/quoted.ts:10-40"' } }],
    });
    expect(r.filesAndChanges.join("\n")).toContain("Modified: src/quoted.ts");
  });

  it("strips #L anchors from legacy tool-arg paths", () => {
    const r = buildSections({
      blocks: [{ kind: "tool_call", name: "read", args: { path: "src/anchor.ts#L12" } }],
    });
    const files = r.filesAndChanges.join("\n");
    expect(files).toContain("Read: src/anchor.ts");
    expect(files).not.toContain("#L");
  });

  it("orders Modified by touch recency ahead of fileOps seeds", () => {
    // The collector output is recency-ordered (most recent first); Pi's
    // fileOps lists are unordered. Seeding touched first keeps the latest
    // touches at the head of the capped line.
    const a = nextId();
    const b = nextId();
    const messages: Message[] = [
      assistantWith({ id: a, name: "write", args: { path: "/repo/src/old-touch.ts" } }),
      toolResult(a, "write", "ok", { timestamp: 1 }),
      assistantWith({ id: b, name: "write", args: { path: "/repo/src/new-touch.ts" } }),
      toolResult(b, "write", "ok", { timestamp: 2 }),
    ];
    const r = buildSections({
      blocks: [],
      messages,
      fileOps: { readFiles: [], modifiedFiles: ["/repo/src/seed.ts"] },
      cwd: "/repo",
    });
    const modifiedLine =
      r.filesAndChanges
        .join("\n")
        .split("\n")
        .find((l) => l.startsWith("Modified:")) ?? "";
    const idxNew = modifiedLine.indexOf("new-touch.ts");
    const idxOld = modifiedLine.indexOf("old-touch.ts");
    const idxSeed = modifiedLine.indexOf("seed.ts");
    expect(idxNew).toBeGreaterThanOrEqual(0);
    expect(idxNew).toBeLessThan(idxOld);
    expect(idxNew).toBeLessThan(idxSeed);
  });
});
