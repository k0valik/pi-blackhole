#!/usr/bin/env node
/**
 * Dump compaction data from a pi session JSONL for offline investigation.
 *
 * Fills the gap between "the summary says X" and "what did the extractor
 * actually see": for each compaction entry it resolves the summarized window
 * (messages between the previous compaction's firstKeptEntryId and this
 * compaction's firstKeptEntryId), counts them, and lists every write/edit/
 * read/bash-git-commit tool call inside it — so you can compare "what the
 * window contained" against "what [Files And Changes] / [Commits] rendered".
 *
 * Usage:
 *   node scripts/dump-compaction-data.mjs <session.jsonl> [compactionId]
 *
 * Examples:
 *   node scripts/dump-compaction-data.mjs /tmp/inspect.jsonl
 *   node scripts/dump-compaction-data.mjs /tmp/inspect.jsonl 3ec1ca93
 *
 * No deps, stdlib only. Never reads live files in place — copy first.
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
const onlyId = process.argv[3];
if (!file) {
  console.error("usage: node scripts/dump-compaction-data.mjs <session.jsonl> [compactionId]");
  process.exit(1);
}

const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
const entries = [];
for (let i = 0; i < lines.length; i++) {
  try {
    entries.push({ line: i + 1, entry: JSON.parse(lines[i]) });
  } catch {
    // corrupt line — skip
  }
}

const row = (e) =>
  `${String(e.line).padStart(5)} ${String(e.entry.type).padEnd(14)} ${e.entry.id ?? ""}  ${(e.entry.timestamp ?? "").slice(11, 19)}`;

const messageText = (m) => {
  if (!m || typeof m !== "object") return "";
  const c = m.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .map((b) => (b && typeof b === "object" && typeof b.text === "string" ? b.text : ""))
    .join("\n")
    .trim();
};

const compactions = entries.filter((r) => r.entry.type === "compaction");

if (compactions.length === 0) {
  console.log("No compaction entries found in", file);
  process.exit(0);
}

console.log("=== Compactions in", file, "===\n");
for (const r of compactions) {
  const s = r.entry.summary ?? "";
  const firstKept = r.entry.firstKeptEntryId ?? "?";
  const kept = entries.find((x) => x.entry.id === firstKept);
  const prevKeptIdx =
    compactions.indexOf(r) > 0
      ? compactions[compactions.indexOf(r) - 1].entry.firstKeptEntryId
      : null;
  console.log(
    row(r),
    "\n  firstKeptEntryId:",
    firstKept,
    kept ? `(line ${kept.line}, ${kept.entry.type})` : "(NOT FOUND IN FILE!)",
    "\n  prev compaction firstKept:",
    prevKeptIdx ?? "(none — window starts at file head)",
    "\n  summary length:",
    s.length,
    "\n  summary preview:",
    JSON.stringify(s.slice(0, 140)),
    "\n",
  );
}

const target = onlyId
  ? compactions.find((r) => r.entry.id === onlyId)
  : compactions[compactions.length - 1];
if (!target) {
  console.error("compaction id not found:", onlyId);
  process.exit(1);
}

// ── Resolve the window this compaction summarized ────────────────
const myIdx = compactions.indexOf(target);
const prevFirstKept = myIdx > 0 ? compactions[myIdx - 1].entry.firstKeptEntryId : null;
const boundaryLine =
  entries.find((x) => x.entry.id === target.entry.firstKeptEntryId)?.line ?? null;

let windowEntries = [];
let windowRaw = [];
if (boundaryLine !== null) {
  // Everything from (prev boundary+1 … this boundary-1) that is a message.
  // NOTE: this is an approximation — pi slices the ACTIVE BRANCH, not raw line
  // order, and model_change entries start new branch roots. Verify with
  // `--branch-aware` below if counts don't match the debug log's messageCount.
  const start = prevFirstKept
    ? (entries.find((x) => x.entry.id === prevFirstKept)?.line ?? 0) + 1
    : 1;
  windowRaw = entries.filter((r) => r.line >= start && r.line < boundaryLine);
  windowEntries = windowRaw.filter((r) => r.entry.type === "message");
}
const msgs = windowEntries.map((r) => ({
  ...r,
  role: r.entry.message?.role,
  text: messageText(r.entry.message),
}));

const toolCalls = [];
for (const r of windowEntries) {
  const content = r.entry.message?.content;
  if (!Array.isArray(content)) continue;
  for (const b of content) {
    if (b && typeof b === "object" && b.type === "toolCall") {
      toolCalls.push({
        line: r.line,
        name: b.name,
        args: b.arguments ?? {},
        text: messageText({ content: b }),
      });
    }
  }
}

console.log(`\n=== Window summarized by compaction ${target.entry.id} ===`);
console.log("messages in window :", msgs.length);
console.log("roles             :", [...new Set(msgs.map((m) => m.role))].join(", "));
console.log("tool calls        :", toolCalls.length);

const byName = {};
for (const tc of toolCalls) byName[tc.name] = (byName[tc.name] ?? 0) + 1;
console.log("tool histogram    :", JSON.stringify(byName));

const argPath = (args) => args?.path ?? args?.file_path ?? args?.filePath ?? args?.file ?? "?";
const fileOps = toolCalls.filter((t) => ["write", "edit"].includes(t.name));
console.log(`\n-- write/edit tool calls (${fileOps.length}) --`);
for (const t of fileOps)
  console.log(`  L${String(t.line).padStart(4)} ${t.name.padEnd(5)} ${argPath(t.args)}`);

const reads = toolCalls.filter((t) => t.name === "read");
console.log(`\n-- read tool calls (${reads.length}) --`);
for (const t of reads.slice(0, 12))
  console.log(`  L${String(t.line).padStart(4)} ${argPath(t.args)}`);
if (reads.length > 12) console.log(`  ... (+${reads.length - 12} more)`);

const commits = toolCalls.filter(
  (t) =>
    t.name === "bash" &&
    /(^|(?:&&|\|\||[;|\n]))\s*(?:sudo\s+)?git(\s|\/)[^\n]*\bcommit\b/.test(
      String(t.args?.command ?? ""),
    ),
);
console.log(`\n-- bash calls containing a git commit token (${commits.length}) --`);
for (const t of commits) {
  const cmd = String(t.args?.command ?? "").replace(/\n/g, "⏎");
  console.log(
    `  L${String(t.line).padStart(4)} ${cmd.slice(0, 130)}${cmd.length > 130 ? "…" : ""}`,
  );
}

// ── What the summary claims ──────────────────────────────────────
const s = target.entry.summary ?? "";
console.log("\n=== Sections the summary emitted ===");
const sections = {};
let current = null;
for (const ln of s.split("\n")) {
  const m = ln.match(/^\[([^\]]+)\]/);
  if (m) {
    current = m[1];
    sections[current] = [];
  } else if (current && ln.trim() && !ln.trim().startsWith("---")) {
    sections[current].push(ln.trim());
  }
}
for (const [name, body] of Object.entries(sections)) {
  console.log(`[${name}] (${body.length} lines)`);
  for (const l of body.slice(0, 12)) console.log("  " + l.slice(0, 160));
  if (body.length > 12) console.log(`  ... (+${body.length - 12} more)`);
}

// ── Branch-awareness check ───────────────────────────────────────
const branchBreaks = windowRaw.filter((r) => r.entry.type === "model_change").length;
if (branchBreaks > 0) {
  console.log(
    `\n⚠  ${branchBreaks} model_change entries inside the raw window — the active branch may exclude some line ranges.`,
  );
  console.log(
    "   If the window count above ≠ the debug log's messageCount, slice by parentId chain instead of line ranges.",
  );
}

// ── First-kept context ───────────────────────────────────────────
if (boundaryLine !== null) {
  console.log(`\n=== First kept entry (line ${boundaryLine}) — this is where the window cut ===`);
  const fb = entries[boundaryLine - 1];
  console.log(row(fb));
  console.log(
    "  text:",
    JSON.stringify(messageText(fb.entry.message ?? fb.entry.data).slice(0, 200)),
  );
}
