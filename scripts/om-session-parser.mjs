#!/usr/bin/env node
// Shared pi session JSONL parsing core for offline tooling.
//
// Sessions are append-only trees over `parentId`; the last line is the live
// leaf. Entries behind a compaction are deleted from the file; /tree
// backtracking abandons branches that remain in the file. Every accessor
// here therefore works on explicit ancestor paths, never on raw file order.
//
// CLI:
//   node scripts/om-session-parser.mjs <session.jsonl> [--json]
//   node scripts/om-session-parser.mjs --recent <N> [--json]
//
// Library consumers (e.g. analyze-token-estimation.mjs) import the exported
// functions directly.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SOURCE_TYPES = new Set([
  "message",
  "custom_message",
  "branch_summary",
]);

export const OM_MARKER_STAGES = {
  "om.observations.recorded": "observer",
  "om.observation": "observer",
  "om.reflections.recorded": "reflector",
  "om.observations.dropped": "dropper",
};

export function loadEntries(filePath) {
  const entries = [];
  const raw = fs.readFileSync(filePath, "utf-8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // corrupt lines are silently dropped by pi too
    }
  }
  return entries;
}

export function indexById(entries) {
  const byId = new Map();
  for (const e of entries) {
    if (e && typeof e.id === "string") byId.set(e.id, e);
  }
  return byId;
}

/** Ancestor ids of `entry` (inclusive), CHRONOLOGICAL order (root → entry).
 *  Stops at missing parents (compaction deletes entries) and at the root.
 *  Memoized per parse. */
function makeAncestorWalker(byId) {
  const memo = new Map();
  return function ancestors(entry) {
    if (!entry || !entry.id) return [];
    const chain = [];
    let seen = entry;
    while (seen && !memo.has(seen.id)) {
      chain.push(seen);
      seen = seen.parentId ? byId.get(seen.parentId) : undefined;
    }
    const out = seen ? (memo.get(seen.id) ?? []).slice() : [];
    for (let i = chain.length - 1; i >= 0; i--) {
      out.push(chain[i].id);
      memo.set(chain[i].id, out.slice());
    }
    return memo.get(entry.id) ?? [entry.id];
  };
}

/** Active branch of the session as flown: root->leaf entry list. */
export function activeBranch(entries, byId = indexById(entries)) {
  const leaf = [...entries].reverse().find((e) => e && e.id && byId.has(e.id));
  if (!leaf) return [];
  const walker = makeAncestorWalker(byId);
  const ids = walker(leaf);
  return ids.map((id) => byId.get(id));
}

/** Chronological ancestor slice of one entry (the context as it existed
 *  when that entry was appended). */
export function sliceAt(entry, byId, ancestors) {
  return ancestors(entry).map((id) => byId.get(id));
}

// ── usage (mirrors pi's compaction guards: calculateContextTokens /
// getLastAssistantUsage semantics — totalTokens preferred, error/aborted/
// zero excluded) ─────────────────────────────────────────────────────────────

export function contextTokens(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  if (
    typeof usage.totalTokens === "number" &&
    Number.isFinite(usage.totalTokens) &&
    usage.totalTokens > 0
  ) {
    return usage.totalTokens;
  }
  const sum =
    (usage.input ?? 0) +
    (usage.output ?? 0) +
    (usage.cacheRead ?? 0) +
    (usage.cacheWrite ?? 0);
  return Number.isFinite(sum) && sum > 0 ? sum : undefined;
}

export function assistantUsage(message) {
  if (!message || typeof message !== "object") return undefined;
  if (message.role !== "assistant") return undefined;
  if (message.stopReason === "error" || message.stopReason === "aborted")
    return undefined;
  return contextTokens(message.usage);
}

/** Last valid assistant usage at or before each position of `slice`. */
export function prefixUsage(slice) {
  const out = new Array(slice.length);
  let cur;
  for (let i = 0; i < slice.length; i++) {
    const u = assistantUsage(slice[i]?.message);
    if (u !== undefined) cur = u;
    out[i] = cur;
  }
  return out;
}

// ── chars/4 estimation (mirrors src/om/tokens.ts estimateEntryTokens) ──────

export function estimateStringTokens(text) {
  return Math.ceil(text.length / 4);
}

function blockText(block) {
  if (!block || typeof block !== "object") return "";
  if (block.type === "text" || block.type === "thinking")
    return block.text ?? block.thinking ?? "";
  if (block.type === "toolCall") return JSON.stringify(block.arguments ?? {});
  return "";
}

export function estimateEntryTokens(entry) {
  if (!entry || typeof entry !== "object") return 0;
  const msg = entry.message;
  if (entry.type === "message" && msg) {
    let total = 0;
    if (msg.role === "toolResult") {
      const c = msg.content;
      if (typeof c === "string") total += estimateStringTokens(c);
      else if (Array.isArray(c))
        for (const b of c) total += estimateStringTokens(blockText(b));
      return total;
    }
    const c = msg.content;
    if (typeof c === "string") return estimateStringTokens(c);
    if (Array.isArray(c))
      for (const b of c) total += estimateStringTokens(blockText(b));
    return total;
  }
  if (entry.type === "custom_message" && typeof entry.content === "string") {
    return estimateStringTokens(entry.content);
  }
  if (entry.type === "branch_summary" && typeof entry.summary === "string") {
    return estimateStringTokens(entry.summary);
  }
  return 0;
}

export function prefixSourceEstimate(slice) {
  const out = new Array(slice.length + 1);
  out[0] = 0;
  for (let i = 0; i < slice.length; i++) {
    out[i + 1] =
      out[i] +
      (SOURCE_TYPES.has(slice[i]?.type) ? estimateEntryTokens(slice[i]) : 0);
  }
  return out;
}

// ── domain extraction ───────────────────────────────────────────────────────

export function extractModelChanges(entries) {
  return entries
    .filter((e) => e?.type === "model_change")
    .map((e) => ({
      timestamp: e.timestamp,
      provider: e.provider,
      modelId: e.modelId,
    }));
}

export function extractCompactions(entries) {
  return entries
    .filter((e) => e?.type === "compaction")
    .map((e) => {
      const d = e.details ?? {};
      const seg = d.segment ?? {};
      return {
        entry: e,
        index: e.__index,
        timestamp: e.timestamp,
        tokensBefore: e.tokensBefore,
        fromHook: e.fromHook === true,
        compactor: d.compactor,
        summaryMode: d.summaryMode,
        chainStart: d.chainStart,
        sequence: seg.sequence,
        firstKeptEntryId: e.firstKeptEntryId,
      };
    });
}

/** All om coverage markers in append order, stage-tagged, with resolved
 *  anchor positions (`anchorIndex` null when coversUpToId is dangling). */
export function extractMarkers(entries, byId = indexById(entries)) {
  const markers = [];
  for (const e of entries) {
    if (e?.type !== "custom") continue;
    const stage = OM_MARKER_STAGES[e.customType];
    if (!stage) continue;
    const data = e.data ?? {};
    const coverId = data.coversUpToId;
    const target = coverId ? byId.get(coverId) : undefined;
    markers.push({
      stage,
      customType: e.customType,
      entry: e,
      index: e.__index,
      timestamp: e.timestamp,
      coversUpToId: coverId ?? null,
      anchorEntry: target ?? null,
      anchorIndex: target ? (target.__index ?? null) : null,
      dangling: !target,
    });
  }
  return markers;
}

/** Decorate entries with their append-order index (parser contract). */
export function withIndices(entries) {
  for (let i = 0; i < entries.length; i++) entries[i].__index = i;
  return entries;
}

/** Full parse: everything a session-analysis consumer needs in one call. */
export function parseSession(filePath) {
  const entries = withIndices(loadEntries(filePath));
  const byId = indexById(entries);
  const ancestors = makeAncestorWalker(byId);
  const header = entries.find((e) => e?.type === "session");
  return {
    filePath,
    entries,
    byId,
    ancestors,
    header,
    cwd: header?.cwd,
    models: extractModelChanges(entries),
    active: activeBranch(entries, byId),
    compactions: extractCompactions(entries),
    markers: extractMarkers(entries, byId),
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function findRecentSessions(limit) {
  const sessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions");
  const files = [];
  for (const scope of fs.readdirSync(sessionsDir)) {
    const dir = path.join(sessionsDir, scope);
    if (!fs.statSync(dir).isDirectory() || scope === ".trash") continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".jsonl")) files.push(path.join(dir, f));
    }
  }
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files.slice(0, limit);
}

function summarize(parsed) {
  const stageCounts = {};
  for (const m of parsed.markers)
    stageCounts[m.stage] = (stageCounts[m.stage] ?? 0) + 1;
  const dangling = parsed.markers.filter((m) => m.dangling).length;
  return {
    file: parsed.filePath,
    cwd: parsed.cwd,
    entries: parsed.entries.length,
    activeBranchEntries: parsed.active.length,
    models: parsed.models,
    markers: stageCounts,
    danglingMarkers: dangling,
    compactions: parsed.compactions.map((c) => ({
      timestamp: c.timestamp,
      tokensBefore: c.tokensBefore,
      fromHook: c.fromHook,
      compactor: c.compactor,
      summaryMode: c.summaryMode,
      sequence: c.sequence,
      chainStart: c.chainStart,
      anchorResolved:
        !!c.firstKeptEntryId && parsed.byId.has(c.firstKeptEntryId),
    })),
  };
}

function printHuman(s) {
  console.log(
    `${path.basename(s.file)}  (${s.entries} entries, ${s.activeBranchEntries} on active branch)`,
  );
  console.log(`  cwd: ${s.cwd}`);
  for (const m of s.models)
    console.log(`  model: ${m.timestamp} ${m.provider}/${m.modelId}`);
  console.log(
    `  markers: ${JSON.stringify(s.markers)}  dangling: ${s.danglingMarkers}`,
  );
  for (const c of s.compactions) {
    console.log(
      `  compaction: ${c.timestamp} before=${c.tokensBefore} hook=${c.fromHook} ` +
        `${c.compactor}/${c.summaryMode}${c.sequence ? ` seq=${c.sequence}` : ""} anchor=${c.anchorResolved}`,
    );
  }
}

const args = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  const json = args.includes("--json");
  const recentIdx = args.indexOf("--recent");
  let files;
  if (recentIdx !== -1)
    files = findRecentSessions(Number(args[recentIdx + 1] ?? 5));
  else files = [args.find((a) => !a.startsWith("--"))];
  for (const f of files.filter(Boolean)) {
    const s = summarize(parseSession(f));
    if (json) console.log(JSON.stringify(s, null, 2));
    else printHuman(s);
  }
}
