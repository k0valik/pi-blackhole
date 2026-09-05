#!/usr/bin/env node
/**
 * Analyze chars/4 token estimation vs actual model usage across real pi sessions.
 *
 * Motivation: our compaction + coverage counters (rawTokensSinceLastCompaction,
 * rawTokensSinceCoverage) estimate tokens as chars/4 via pi's estimateTokens().
 * This systematically underreports actual provider usage (often ~2-3x), so
 * auto-compaction and the observer/reflector/dropper thresholds fire late.
 *
 * This script replays both counting methods over real session JSONL files:
 *   - `est`   : current behavior — estimateTokens() over source entries since the
 *               last coverage marker / compaction (mirrors progress.ts).
 *   - `usage` : proposed behavior —
 *               * compaction: last assistant message's calculateContextTokens()
 *                 after the compaction point + estimate for trailing messages
 *                 (mirrors tavasti fork commit 360f24a / pi's estimateContextTokens).
 *               * coverage : usage DELTA — last assistant usage after the marker
 *                 minus last assistant usage before the marker + trailing estimate.
 *                 (Needed because coverage markers sit mid-context; the last usage
 *                 alone would report the whole context, not "since the marker".)
 *
 * Beyond the raw comparison it computes an algorithmic calibration surface for
 * planning default threshold bumps (see work_docs/issue-usage-based-token-counting.md):
 *   - churn multiplier: how many more times each stage would fire under truthful
 *     counting with unchanged thresholds (usageOver / estOver);
 *   - same-fire-count threshold: the usage threshold T' whose firing frequency
 *     equals today's est-based frequency (largest T' with count(usage >= T')
 *     <= count(est >= T_current));
 *   - usage distribution percentiles (p50/p75/p90/p95/max) per stage, the raw
 *     material for generation-aware preset proposals.
 *
 * Usage: node scripts/analyze-token-estimation.mjs [N] [--defaults] [--summary <path>]
 *   N = number of most-recent session files to analyze.
 *   Omit N (or pass "all") to analyze EVERY unique session (realpath-deduped).
 *   --defaults = evaluate with the built-in code defaults (observe 15k /
 *                reflect+drop 25k / compact 81k) instead of the user's global
 *                config values — the surface an auto-install user gets.
 *   --summary <path> = also write a tracked review artifact to <path> with
 *                only the math (aggregate + calibration + observer input
 *                simulation) for BOTH surfaces — no per-window rows. Intended
 *                for work_docs/ so the numbers are reviewable on GitHub.
 *
 * Output:
 *   - console: per-window table (first 70 rows) + aggregate + calibration
 *   - observer input simulation: what the observer would serialize upstream
 *     (role shares + trimming of oversized tool results AND thinking blocks —
 *     head+tail; tunable via --trim-head/--trim-tail/--trim-threshold and
 *     --think-head-pct/--think-tail-pct/--think-threshold) — orthogonal to
 *     the counters, which use provider usage of the session context
 *   - tmp/token-estimation-report.md (or -defaults.md): full report incl. ALL
 *     rows, per-stage aggregate, calibration table, usage distributions, and
 *     the observer simulation (reproducible).
 */
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  realpathSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { calculateContextTokens, estimateTokens } from "@earendil-works/pi-coding-agent";

const SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");
const args = process.argv.slice(2);
const useDefaults = args.includes("--defaults");
const positional = args.find((a) => !a.startsWith("--"));
const limit = positional && positional !== "all" ? Number(positional) || 0 : 0;
const summaryArg = args.indexOf("--summary");
const summaryPath = summaryArg >= 0 ? args[summaryArg + 1] : undefined;
const flagNum = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return def;
  const v = Number(hit.slice(`--${name}=`.length));
  return Number.isFinite(v) && v > 0 ? v : def;
};
const OM_TYPES = {
  observations: "om.observations.recorded",
  reflections: "om.reflections.recorded",
  drops: "om.observations.dropped",
};
const SOURCE_TYPES = new Set(["message", "custom_message", "branch_summary"]);
const CONSOLE_ROW_CAP = 70;

// Trim simulation parameters for the observer's serialized input (see plan
// doc appendix; the provider usage numbers that drive the counters are NOT
// affected — this only models what the observer serializes upstream).
// Tunable via --trim-head=, --trim-tail=, --trim-threshold=,
// --think-head-pct=, --think-tail-pct=, --think-threshold=.
const TRIM = {
  headChars: flagNum("trim-head", 1000),
  tailChars: flagNum("trim-tail", 1000),
  thresholdChars: flagNum("trim-threshold", 4096), // only trim tool results larger than this
};
const THINK = {
  headPct: flagNum("think-head-pct", 20) / 100, // percent of block kept as head
  tailPct: flagNum("think-tail-pct", 20) / 100,
  thresholdChars: flagNum("think-threshold", 4096), // only trim thinking blocks larger than this
};

// Achieved-context tiers for preset calibration. Tier = the max context the
// session actually reached (max usage.totalTokens) — a measured lower bound
// on the model's window; long sessions approach the real window. Tiering by
// ACHIEVED context (not the theoretical window) sizes thresholds to how much
// context sessions genuinely accumulate, and works on any user's machine.
const TIERS = [
  { name: "low (<100k)", max: 100_000 },
  { name: "medium (100–200k)", max: 200_000 },
  { name: "high (200k+)", max: Infinity },
];
const tierOf = (ctx) => (ctx < TIERS[0].max ? 0 : ctx < TIERS[1].max ? 1 : 2);

// ── config thresholds (global config, or built-in code defaults with --defaults)
function loadThresholds(useDefaults) {
  const codeDefaults = {
    observe: 15_000,
    reflect: 25_000,
    drop: 25_000,
    compact: 81_000,
    observerChunk: 40_000,
  };
  if (useDefaults) return codeDefaults;
  const cfgPath = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "pi-blackhole",
    "pi-blackhole-config.json",
  );
  try {
    const raw = JSON.parse(readFileSync(cfgPath, "utf8"));
    return {
      observe: raw.observeAfterTokens ?? codeDefaults.observe,
      reflect: raw.reflectAfterTokens ?? codeDefaults.reflect,
      drop: raw.reflectAfterTokens ?? codeDefaults.drop,
      compact: raw.compactAfterTokens ?? codeDefaults.compact,
      observerChunk: raw.observerChunkMaxTokens ?? codeDefaults.observerChunk,
    };
  } catch {
    return codeDefaults;
  }
}

// ── entry-level helpers (mirror src/om/tokens.ts + progress.ts) ──────────
function estimateStringTokens(text) {
  return Math.ceil(text.length / 4);
}

function estimateEntryTokens(entry) {
  if (entry.type === "message" && entry.message) {
    try {
      return estimateTokens(entry.message);
    } catch {
      return 0;
    }
  }
  if (entry.type === "custom_message" && entry.content) {
    const content = entry.content;
    if (typeof content === "string") return estimateStringTokens(content);
    if (Array.isArray(content)) {
      let total = 0;
      for (const block of content) {
        if (block.type === "text" && block.text) total += estimateStringTokens(block.text);
      }
      return total;
    }
  }
  if (entry.type === "branch_summary" && typeof entry.summary === "string") {
    return estimateStringTokens(entry.summary);
  }
  return 0;
}

function isSourceEntry(entry) {
  return SOURCE_TYPES.has(entry.type);
}

function usageTokens(message) {
  const usage = message?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  try {
    const t = calculateContextTokens(usage);
    return t > 0 ? t : undefined;
  } catch {
    return undefined;
  }
}

function rawTokensAfterIndex(entries, index) {
  let total = 0;
  for (let i = Math.max(0, index + 1); i < entries.length; i++) {
    if (isSourceEntry(entries[i])) total += estimateEntryTokens(entries[i]);
  }
  return total;
}

function latestCoverageIndex(entries, customType) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (
      e.type === "custom" &&
      e.customType === customType &&
      e.data &&
      typeof e.data.coversUpToId === "string"
    ) {
      return i;
    }
  }
  return -1;
}

function findLastCompactionIndex(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "compaction") return i;
  }
  return -1;
}

/** Index of the first entry in the runtime's current branch: the last
 *  compaction's firstKeptEntryId (or 0 when never compacted). The session
 *  JSONL file keeps pre-compaction messages; the runtime branch does not,
 *  so "since coverage" windows must be clamped to this boundary. */
function branchStartIndex(entries) {
  const ci = findLastCompactionIndex(entries);
  if (ci === -1) return 0;
  const fk = entries[ci].firstKeptEntryId;
  const fki = fk ? entries.findIndex((e) => e.id === fk) : -1;
  return fki === -1 ? ci : fki;
}

/** est tokens after index, clamped to the current branch start. */
function rawTokensAfterIndexBounded(entries, index) {
  const start = Math.max(0, index + 1, branchStartIndex(entries));
  let total = 0;
  for (let i = start; i < entries.length; i++) {
    if (isSourceEntry(entries[i])) total += estimateEntryTokens(entries[i]);
  }
  return total;
}

// ── proposed counters ─────────────────────────────────────────────────────
/** Usage-delta for coverage markers: last usage after marker − last usage
 *  before marker + trailing estimate. Falls back to estimate when no usage. */
function usageDeltaSinceCoverage(entries, customType) {
  const marker = latestCoverageIndex(entries, customType);
  const after = marker + 1;

  let baseline = 0; // last assistant usage at/before the marker (0 = fresh context)
  let ceiling = undefined;
  let ceilingIndex = -1;
  for (let i = branchStartIndex(entries); i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== "message" || !e.message) continue;
    const t = usageTokens(e.message);
    if (t === undefined) continue;
    if (i < after) baseline = t;
    else {
      ceiling = t;
      ceilingIndex = i;
    }
  }
  if (ceiling === undefined) return rawTokensAfterIndexBounded(entries, marker);

  let trailing = 0;
  for (let j = ceilingIndex + 1; j < entries.length; j++) {
    if (isSourceEntry(entries[j])) trailing += estimateEntryTokens(entries[j]);
  }
  return Math.max(0, ceiling - baseline) + trailing;
}

/** Usage-based for compaction: context is rebuilt after compacting, so the
 *  last assistant usage after the compaction point IS "tokens since". */
function usageSinceLastCompaction(entries) {
  const compactionIndex = findLastCompactionIndex(entries);
  let startIndex;
  if (compactionIndex === -1) {
    startIndex = -1;
  } else {
    const firstKept = entries[compactionIndex].firstKeptEntryId;
    const firstKeptIndex = firstKept ? entries.findIndex((e) => e.id === firstKept) : -1;
    startIndex = firstKeptIndex === -1 ? compactionIndex : firstKeptIndex - 1;
  }

  let lastUsage = undefined;
  let lastUsageIndex = -1;
  for (let i = entries.length - 1; i > startIndex; i--) {
    const e = entries[i];
    if (e.type !== "message" || !e.message) continue;
    const t = usageTokens(e.message);
    if (t !== undefined) {
      lastUsage = t;
      lastUsageIndex = i;
      break;
    }
  }
  if (lastUsage === undefined) return rawTokensAfterIndex(entries, startIndex);

  let trailing = 0;
  for (let j = lastUsageIndex + 1; j < entries.length; j++) {
    if (isSourceEntry(entries[j])) trailing += estimateEntryTokens(entries[j]);
  }
  return lastUsage + trailing;
}

// ── statistics helpers (algorithmic calibration surface) ──────────────────
function percentile(sorted, p) {
  if (sorted.length === 0) return undefined;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/** The k-th largest usage value — the threshold at which exactly k windows
 *  would fire under truthful counting (modulo ties), i.e. the usage-equivalent
 *  of today's est-based fire count (estOverCount). A low T' means the est
 *  counter was already firing a lot; a high T' means it rarely fired. */
function sameFireCountThreshold(usageValues, k) {
  if (k <= 0 || usageValues.length === 0) return undefined;
  const asc = [...usageValues].sort((a, b) => a - b);
  return asc[Math.max(0, asc.length - k)];
}

/** Achieved fire count at a given threshold (tie-aware; may exceed k). */
function countAtOrAbove(values, threshold) {
  if (threshold === undefined) return undefined;
  let c = 0;
  for (const v of values) if (v >= threshold) c++;
  return c;
}

function fmtPct(sorted, p) {
  const v = percentile(sorted, p);
  return v === undefined ? "n/a" : String(v);
}

function fmtNum(v) {
  return v === undefined ? "n/a" : String(v);
}

// ── observer input simulation (what the observer would send upstream) ────
// Mirrors serialize.ts serializeConversation + consolidation.ts
// capSourceEntriesToTokens. The provider usage numbers that drive the
// counters measure the SESSION context and are unaffected by trimming —
// this simulation only models the observer's own serialized input volume.
function textOfBlock(block) {
  return typeof block?.text === "string" ? block.text : "";
}

function messageText(msg) {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(textOfBlock).filter(Boolean).join("\n");
  return "";
}

function observerChunkEntries(entries, maxChunkTokens) {
  const marker = latestCoverageIndex(entries, OM_TYPES.observations);
  const start = Math.max(0, marker + 1, branchStartIndex(entries));
  const window = entries.slice(start).filter(isSourceEntry);
  let totalTokens = 0;
  const kept = [];
  for (let i = window.length - 1; i >= 0; i--) {
    const entry = window[i];
    let chars = 0;
    if (entry.type === "message" && entry.message) {
      const msg = entry.message;
      if (typeof msg.content === "string") chars = msg.content.length;
      else if (Array.isArray(msg.content)) {
        for (const block of msg.content) if (block?.text) chars += block.text.length;
      }
    } else if (entry.type === "custom") {
      chars = String(JSON.stringify(entry.data ?? {})).length;
    } else if (entry.summary) {
      chars = String(entry.summary).length;
    }
    const estTokens = Math.ceil(chars / 4);
    if (totalTokens + estTokens > maxChunkTokens && kept.length > 0) break;
    if (totalTokens + estTokens > maxChunkTokens && kept.length === 0) {
      kept.unshift(entry); // oversized newest entry: include it, then stop
      break;
    }
    kept.unshift(entry);
    totalTokens += estTokens;
  }
  return kept;
}

function zeroBuckets() {
  return {
    user: 0,
    assistantText: 0,
    thinking: 0,
    toolCall: 0,
    toolResult: 0,
    custom: 0,
    summary: 0,
    toolResultChars: 0,
    toolResultTrimmedChars: 0,
    thinkingChars: 0,
    thinkingTrimmedChars: 0,
  };
}

/** Classify a serialized chunk by message role; simulate head+tail trimming
 *  of oversized tool results (mirrors how serializeConversation renders). */
function classifyChunk(chunk) {
  const b = zeroBuckets();
  const est = (s) => Math.ceil((s ?? "").length / 4);
  for (const entry of chunk) {
    if (entry.type === "message" && entry.message) {
      const msg = entry.message;
      const content = msg.content;
      if (msg.role === "user") {
        b.user += est(messageText(msg));
        continue;
      }
      if (msg.role === "assistant") {
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "text" && typeof block.text === "string")
              b.assistantText += est(block.text);
            else if (block?.type === "thinking" && typeof block.thinking === "string") {
              const t = block.thinking;
              b.thinking += est(t);
              b.thinkingChars += t.length;
              if (t.length > THINK.thresholdChars) {
                const head = t.slice(0, Math.round(t.length * THINK.headPct));
                const tail = t.slice(-Math.round(t.length * THINK.tailPct));
                const dropped = t.length - head.length - tail.length;
                b.thinkingTrimmedChars +=
                  head.length +
                  tail.length +
                  `\n… [thinking truncated ${dropped} chars] …\n`.length;
              } else {
                b.thinkingTrimmedChars += t.length;
              }
            } else if (block?.type === "toolCall")
              b.toolCall += est((block.name ?? "") + JSON.stringify(block.arguments ?? {}));
          }
        }
        continue;
      }
      // tool result (any other role)
      const text = messageText(msg);
      b.toolResult += est(text);
      b.toolResultChars += text.length;
      if (text.length > TRIM.thresholdChars) {
        const head = text.slice(0, TRIM.headChars);
        const tail = text.slice(-TRIM.tailChars);
        const dropped = text.length - head.length - tail.length;
        b.toolResultTrimmedChars +=
          head.length + tail.length + `\n… [truncated ${dropped} chars] …\n`.length;
      } else {
        b.toolResultTrimmedChars += text.length;
      }
      continue;
    }
    if (entry.type === "custom_message") {
      const text =
        typeof entry.content === "string"
          ? entry.content
          : Array.isArray(entry.content)
            ? entry.content.map(textOfBlock).filter(Boolean).join("\n")
            : "";
      b.custom += est(text);
      continue;
    }
    if (entry.type === "branch_summary" && typeof entry.summary === "string") {
      b.summary += est(entry.summary);
      continue;
    }
  }
  return b;
}
// ── session discovery ─────────────────────────────────────────────────────
function findSessions(limit) {
  const seen = new Set();
  const files = [];
  for (const dir of readdirSync(SESSIONS_DIR)) {
    const full = path.join(SESSIONS_DIR, dir);
    let entries = [];
    try {
      entries = readdirSync(full);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const p = path.join(full, f);
      let real;
      try {
        real = realpathSync(p);
      } catch {
        continue;
      }
      if (seen.has(real)) continue; // dedupe symlinks/hardlinks
      seen.add(real);
      try {
        files.push({ path: real, mtime: statSync(real).mtimeMs });
      } catch {
        /* skip */
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return limit > 0 ? files.slice(0, limit) : files;
}

function parseEntries(filePath) {
  const entries = [];
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      /* skip malformed */
    }
  }
  return entries;
}

// ── single-pass analysis (computation + console + tmp report) ─────────────
function analyzeOnce(useDefaults, limit) {
  const th = loadThresholds(useDefaults);
  const REPORT_PATH = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "tmp",
    useDefaults ? "token-estimation-report-defaults.md" : "token-estimation-report.md",
  );
  const sessions = findSessions(limit);

  const stages = [
    { name: "observer", type: OM_TYPES.observations, threshold: th.observe },
    { name: "reflector", type: OM_TYPES.reflections, threshold: th.reflect },
    { name: "dropper", type: OM_TYPES.drops, threshold: th.drop },
    { name: "compaction", type: null, threshold: th.compact },
  ];

  const agg = Object.fromEntries(
    stages.map((s) => [
      s.name,
      {
        ratios: [], // est/usage over marker-present, usage>0 windows
        estValues: [], // est over all windows with usage>0 (calibration surface)
        usageValues: [], // usage over all windows with usage>0
        estOver: 0, // est >= threshold (all windows)
        usageOver: 0, // usage >= threshold (all windows)
        late: 0, // est<thr but usage>=thr
        early: 0, // est>=thr but usage<thr
        withMarker: 0,
        noMarker: 0,
        noUsage: 0,
      },
    ]),
  );

  const rows = []; // full per-window rows for the report file
  const obsSim = []; // observer input simulation rows
  const tierBuckets = TIERS.map(() => ({
    maxCtx: [],
    usage: Object.fromEntries(stages.map((s) => [s.name, []])),
  }));

  console.log(
    `Analyzing ${sessions.length} session files under ${SESSIONS_DIR}\n` +
      `Thresholds: observe=${th.observe} reflect=${th.reflect} drop=${th.drop} compact=${th.compact}\n` +
      `(est = current chars/4 estimate over the branch window; usage = proposed usage-based count; marker = index of last coverage marker / compaction, -1 = none)`,
  );
  console.log("stage      est       usage     ratio  marker  est>=thr  usage>=thr  session");

  for (const [si, s] of sessions.entries()) {
    if ((si + 1) % 100 === 0) console.log(`… processed ${si + 1}/${sessions.length} sessions`);
    const entries = parseEntries(s.path);
    const name = path
      .basename(s.path)
      .replace(/_019[a-f0-9-]+\.jsonl$/, "")
      .slice(-22);
    let maxCtx = 0;
    for (const e of entries) {
      if (e.type !== "message" || !e.message) continue;
      const t = usageTokens(e.message);
      if (t !== undefined && t > maxCtx) maxCtx = t;
    }
    const ti = maxCtx > 0 ? tierOf(maxCtx) : -1;
    for (const stage of stages) {
      const marker =
        stage.type === null
          ? findLastCompactionIndex(entries)
          : latestCoverageIndex(entries, stage.type);
      const est = rawTokensAfterIndexBounded(entries, marker);
      const usage =
        stage.type === null
          ? usageSinceLastCompaction(entries)
          : usageDeltaSinceCoverage(entries, stage.type);
      const ratio = usage > 0 ? est / usage : undefined;
      const estOver = est >= stage.threshold;
      const usageOver = usage >= stage.threshold;

      const a = agg[stage.name];
      if (marker >= 0) a.withMarker++;
      else a.noMarker++;
      if (usage > 0) {
        if (marker >= 0) a.ratios.push(ratio);
        a.estValues.push(est);
        a.usageValues.push(usage);
        if (ti >= 0) {
          tierBuckets[ti].usage[stage.name].push(usage);
        }
      }
      if (usage === 0 && est === 0) a.noUsage++;
      if (estOver) a.estOver++;
      if (usageOver) a.usageOver++;
      if (usageOver && !estOver) a.late++;
      if (estOver && !usageOver) a.early++;

      rows.push({
        stage: stage.name,
        est,
        usage,
        ratio,
        marker,
        estOver,
        usageOver,
        session: name,
      });
    }
    if (ti >= 0) tierBuckets[ti].maxCtx.push(maxCtx);

    // Observer input simulation: what the observer would send upstream now.
    const obsChunk = observerChunkEntries(entries, th.observerChunk);
    if (obsChunk.length > 0) {
      const b = classifyChunk(obsChunk);
      const chunkTokens =
        b.user + b.assistantText + b.thinking + b.toolCall + b.toolResult + b.custom + b.summary;
      const trimmedTokens =
        chunkTokens -
        b.toolResult -
        b.thinking +
        Math.ceil(b.toolResultTrimmedChars / 4) +
        Math.ceil(b.thinkingTrimmedChars / 4);
      if (chunkTokens > 0) {
        obsSim.push({
          session: name,
          chunkTokens,
          toolResultTokens: b.toolResult,
          thinkingTokens: b.thinking,
          toolResultTrimmedTokens: Math.ceil(b.toolResultTrimmedChars / 4),
          thinkingTrimmedTokens: Math.ceil(b.thinkingTrimmedChars / 4),
          trimmedTokens,
        });
      }
    }
  }

  // ── console aggregate ─────────────────────────────────────────────────────
  console.log("\n── Aggregate (ratios over marker-present, usage>0 windows) ──");
  for (const stage of stages) {
    const a = agg[stage.name];
    const ratios = [...a.ratios].sort((x, y) => x - y);
    const med = ratios.length ? ratios[Math.floor(ratios.length / 2)].toFixed(2) : "n/a";
    const min = ratios.length ? ratios[0].toFixed(2) : "n/a";
    const max = ratios.length ? ratios[ratios.length - 1].toFixed(2) : "n/a";
    const trigger =
      a.late || a.early ? `| fires LATE:${a.late} EARLY:${a.early}` : "| triggers agree";
    console.log(
      `${stage.name.padEnd(10)} n=${String(ratios.length).padStart(3)}  est/usage median=${med} min=${min} max=${max}  | est>=thr:${a.estOver} usage>=thr:${a.usageOver} (windows: ${a.withMarker} marker / ${a.noMarker} no-marker)${a.noUsage ? ` no-usage:${a.noUsage}` : ""} ${trigger}`,
    );
  }

  // ── calibration (planning input for default threshold bumps) ──────────────
  console.log("\n── Calibration (usage-accurate counting with unchanged thresholds) ──");
  console.log(
    "stage      estOver usageOver  churn×   calibrated(median)  same-fire-count T'  usage p50    p90    p95    max",
  );
  const cal = [];
  for (const stage of stages) {
    const a = agg[stage.name];
    const usageSorted = [...a.usageValues].sort((x, y) => x - y);
    const churn = a.estOver > 0 ? a.usageOver / a.estOver : undefined;
    // calibrated via median(usage/est) over marker windows
    const invRatios = a.ratios
      .map((r) => (r > 0 ? 1 / r : undefined))
      .filter((v) => v !== undefined);
    invRatios.sort((x, y) => x - y);
    const medInv = invRatios.length ? invRatios[Math.floor(invRatios.length / 2)] : undefined;
    const calibrated = medInv !== undefined ? Math.round(stage.threshold * medInv) : undefined;
    const sameCount = sameFireCountThreshold(a.usageValues, a.estOver);
    const sameCountAchieved = countAtOrAbove(a.usageValues, sameCount);
    cal.push({
      stage: stage.name,
      ...a,
      churn,
      calibrated,
      sameCount,
      sameCountAchieved,
      usageSorted,
    });
    console.log(
      `${stage.name.padEnd(10)} ${String(a.estOver).padStart(7)} ${String(a.usageOver).padStart(9)}  ${churn !== undefined ? churn.toFixed(1).padStart(5) : "  n/a"}  ${fmtNum(calibrated).padStart(20)}  ${fmtNum(sameCount).padStart(17)}  ${fmtPct(usageSorted, 0.5).padStart(8)} ${fmtPct(usageSorted, 0.9).padStart(6)} ${fmtPct(usageSorted, 0.95).padStart(6)} ${fmtPct(usageSorted, 1).padStart(7)}`,
    );
  }
  console.log(
    `\nSessions analyzed: ${sessions.length} | est/usage < 1 means est UNDERREPORTS usage (fires late); > 1 overreports (fires early)
churn× = usageOver/estOver (how many more fires with truthful counting, unchanged thresholds)
calibrated(median) = threshold × median(usage/est) — same fire frequency on the median window
same-fire-count T' = k-th largest actual usage with k = today's est fire count — reproduces today's fire frequency under truthful counting`,
  );

  // ── observer input simulation (console) ───────────────────────────────────
  if (obsSim.length > 0) {
    const med = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : undefined);
    const pct = (arr, p) =>
      arr.length ? arr[Math.min(arr.length - 1, Math.ceil(p * arr.length) - 1)] : undefined;
    const chunks = obsSim.map((r) => r.chunkTokens).sort((a, b) => a - b);
    const trShares = obsSim.map((r) => r.toolResultTokens / r.chunkTokens).sort((a, b) => a - b);
    const thShares = obsSim.map((r) => r.thinkingTokens / r.chunkTokens).sort((a, b) => a - b);
    const saves = obsSim.map((r) => 1 - r.trimmedTokens / r.chunkTokens).sort((a, b) => a - b);
    const medChunk = med(chunks);
    const medTrimmed = med(obsSim.map((r) => r.trimmedTokens).sort((a, b) => a - b));
    const fmtP = (v) => (v === undefined ? "n/a" : (100 * v).toFixed(0) + "%");
    const toolSaves = obsSim
      .map((r) => 1 - r.toolResultTrimmedTokens / r.toolResultTokens)
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);
    const thinkSaves = obsSim
      .map((r) => 1 - r.thinkingTrimmedTokens / r.thinkingTokens)
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);
    console.log(
      `\n── Observer input simulation (chunk = entries since last marker, capped at observerChunkMaxTokens=${th.observerChunk}; tool-result trim ${TRIM.headChars}/${TRIM.tailChars} chars ≥ ${TRIM.thresholdChars}; thinking trim head+tail ${Math.round(THINK.headPct * 100)}%/${Math.round(THINK.tailPct * 100)}% ≥ ${THINK.thresholdChars} chars) ──`,
    );
    console.log(`windows with content: ${obsSim.length}`);
    console.log(
      `median chunk tokens: ${medChunk?.toLocaleString()} | tool_result share: ${fmtP(med(trShares))} | thinking share: ${fmtP(med(thShares))}`,
    );
    console.log(
      `trim: median ${medChunk?.toLocaleString()} → ${medTrimmed?.toLocaleString()} tokens (combined median save ${fmtP(med(saves))}, p90 ${fmtP(pct(saves, 0.9))})`,
    );
    console.log(
      `  · tool results: median ${fmtP(med(toolSaves))} of tool-result tokens saved (of the ~${fmtP(med(trShares))} share)`,
    );
    console.log(
      `  · thinking: median ${fmtP(med(thinkSaves))} saved of thinking tokens (p90 ${fmtP(pct(thinkSaves, 0.9))}, p95 ${fmtP(pct(thinkSaves, 0.95))}, max ${fmtP(thinkSaves[thinkSaves.length - 1])})`,
    );
    console.log(
      `note: provider usage (session context) is unchanged — trimming only reduces what the observer serializes upstream.`,
    );
  }

  // ── tier calibration (console) ───────────────────────────────────────────
  // Usage values per stage are threshold-independent, so the tier calibration
  // is identical for both config surfaces. Computed here, reused in summary.
  const tierCal = [];
  for (let ti = 0; ti < TIERS.length; ti++) {
    const t = tierBuckets[ti];
    const maxCtxSorted = [...t.maxCtx].sort((a, b) => a - b);
    if (maxCtxSorted.length === 0) continue;
    const p50 = percentile(maxCtxSorted, 0.5);
    const p90 = percentile(maxCtxSorted, 0.9);
    const compact = Math.round(p90 * 0.65); // 65% of the tier's achieved context
    tierCal.push({
      ti,
      n: maxCtxSorted.length,
      p50,
      p90,
      compact,
      usage: Object.fromEntries(
        stages.map((s) => [s.name, [...t.usage[s.name]].sort((a, b) => a - b)]),
      ),
    });
  }
  console.log(
    "\n── Tier calibration (per achieved-context tier; compact = 65% of tier p90 achieved context) ──",
  );
  console.log("tier              n    p50 ctx  p90 ctx  compact(65%)");
  for (const c of tierCal) {
    console.log(
      `${TIERS[c.ti].name.padEnd(18)} ${String(c.n).padStart(5)} ${fmtNum(c.p50).padStart(8)} ${fmtNum(c.p90).padStart(8)}  ${fmtNum(c.compact)}`,
    );
  }
  console.log(
    "\nworker thresholds at fire-rate targets (usage tokens; fire-20% = only 20% of tier windows exceed it):",
  );
  for (const c of tierCal) {
    console.log(`  ${TIERS[c.ti].name}:`);
    for (const s of stages) {
      const v = c.usage[s.name];
      if (!v.length) {
        console.log(`    ${s.name.padEnd(11)} (no usage data)`);
        continue;
      }
      const t20 = percentile(v, 0.8);
      const t40 = percentile(v, 0.6);
      const t60 = percentile(v, 0.4);
      console.log(
        `    ${s.name.padEnd(11)} fire-20%: ${fmtNum(t20)}  fire-40%: ${fmtNum(t40)}  fire-60%: ${fmtNum(t60)}`,
      );
    }
  }

  // ── write full report file ────────────────────────────────────────────────
  const md = [];
  md.push("# Token estimation vs actual usage — algorithmic report");
  md.push("");
  md.push(
    `- Command: \`node scripts/analyze-token-estimation.mjs${limit ? ` ${limit}` : ""}${useDefaults ? " --defaults" : ""}\``,
  );
  md.push(
    `- Sessions analyzed: ${sessions.length} (unique, realpath-deduped) under \`${SESSIONS_DIR}\``,
  );
  md.push(
    `- Thresholds (from global config): observe=${th.observe} reflect=${th.reflect} drop=${th.drop} compact=${th.compact}`,
  );
  md.push(`- Generated: ${new Date().toISOString()}`);
  md.push("");
  md.push("## Per-window rows");
  md.push("");
  md.push("| stage | est | usage | ratio | marker | est>=thr | usage>=thr | session |");
  md.push("|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    md.push(
      `| ${r.stage} | ${r.est} | ${r.usage} | ${r.ratio !== undefined ? r.ratio.toFixed(2) : "n/a"} | ${r.marker} | ${r.estOver} | ${r.usageOver} | ${r.session} |`,
    );
  }
  md.push("");
  md.push("## Aggregate (ratios over marker-present, usage>0 windows)");
  md.push("");
  md.push(
    "| stage | n | median | min | max | est>=thr | usage>=thr | marker | no-marker | no-usage | LATE | EARLY |",
  );
  md.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const stage of stages) {
    const a = agg[stage.name];
    const ratios = [...a.ratios].sort((x, y) => x - y);
    const med = ratios.length ? ratios[Math.floor(ratios.length / 2)].toFixed(2) : "n/a";
    const min = ratios.length ? ratios[0].toFixed(2) : "n/a";
    const max = ratios.length ? ratios[ratios.length - 1].toFixed(2) : "n/a";
    md.push(
      `| ${stage.name} | ${ratios.length} | ${med} | ${min} | ${max} | ${a.estOver} | ${a.usageOver} | ${a.withMarker} | ${a.noMarker} | ${a.noUsage} | ${a.late} | ${a.early} |`,
    );
  }
  md.push("");
  md.push("## Calibration (planning input for default threshold bumps)");
  md.push("");
  md.push("Interpretation:");
  md.push(
    "- **churn×** = `usageOver / estOver` — how many more times the stage would fire under truthful counting with unchanged thresholds. This is the API-call/cost multiplier auto-install users would silently absorb.",
  );
  md.push(
    "- **calibrated(median)** = `threshold × median(usage/est)` — the threshold preserving today's fire frequency on the median window.",
  );
  md.push(
    "- **same-fire-count T'** = the **k-th largest** actual usage across windows (k = today's est fire count) — the threshold under truthful counting that reproduces today's total fire frequency. Achieved count is reported alongside (may exceed k on ties).",
  );
  md.push(
    "- **usage p50/p90/p95/max** = distribution of actual usage at trigger-decision points. Planned default bumps should sit comfortably above p90/p95 to control churn for auto-install users (their models now run 256k–1M windows; see work_docs plan).",
  );
  md.push("");
  md.push(
    "| stage | threshold | estOver | usageOver | churn× | calibrated(median) | same-fire-count T' | achieved | usage p50 | p90 | p95 | max |",
  );
  md.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const c of cal) {
    md.push(
      `| ${c.stage} | ${stages.find((s) => s.name === c.stage).threshold} | ${c.estOver} | ${c.usageOver} | ${c.churn !== undefined ? c.churn.toFixed(1) : "n/a"} | ${fmtNum(c.calibrated)} | ${fmtNum(c.sameCount)} | ${fmtNum(c.sameCountAchieved)} | ${fmtPct(c.usageSorted, 0.5)} | ${fmtPct(c.usageSorted, 0.9)} | ${fmtPct(c.usageSorted, 0.95)} | ${fmtPct(c.usageSorted, 1)} |`,
    );
  }
  md.push("");

  // ── tier calibration (report section) ────────────────────────────────────
  if (tierCal.length > 0) {
    md.push("## Tier calibration (per achieved-context tier)");
    md.push("");
    md.push(
      "Tier = the max context each session actually reached (max `usage.totalTokens`) — a measured lower bound on the model's window, usable on any user's machine. Usage values per stage are threshold-independent, so this section is identical for both config surfaces. Compact anchor = 65% of the tier's p90 achieved context (README 60–70% rule). Worker thresholds are read off the tier's usage distribution at target fire rates.",
    );
    md.push("");
    md.push("| tier | n | p50 ctx | p90 ctx | compact (65%) |");
    md.push("|---|---|---|---|---|");
    for (const c of tierCal) {
      md.push(
        `| ${TIERS[c.ti].name} | ${c.n} | ${fmtNum(c.p50)} | ${fmtNum(c.p90)} | ${fmtNum(c.compact)} |`,
      );
    }
    md.push("");
    md.push("| tier | stage | fire-20% | fire-40% | fire-60% |");
    md.push("|---|---|---|---|---|");
    for (const c of tierCal) {
      for (const s of stages) {
        const v = c.usage[s.name];
        if (!v.length) continue;
        md.push(
          `| ${TIERS[c.ti].name} | ${s.name} | ${fmtNum(percentile(v, 0.8))} | ${fmtNum(percentile(v, 0.6))} | ${fmtNum(percentile(v, 0.4))} |`,
        );
      }
    }
    md.push("");
  }

  md.push(
    `_Generated by \`scripts/analyze-token-estimation.mjs\`. Re-run any time to reproduce. See \`work_docs/issue-usage-based-token-counting.md\` for the plan._`,
  );

  // ── observer input simulation (report section) ────────────────────────────
  if (obsSim.length > 0) {
    const med = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : undefined);
    const pct = (arr, p) =>
      arr.length ? arr[Math.min(arr.length - 1, Math.ceil(p * arr.length) - 1)] : undefined;
    const chunks = obsSim.map((r) => r.chunkTokens).sort((a, b) => a - b);
    const trShares = obsSim.map((r) => r.toolResultTokens / r.chunkTokens).sort((a, b) => a - b);
    const thShares = obsSim.map((r) => r.thinkingTokens / r.chunkTokens).sort((a, b) => a - b);
    const saves = obsSim.map((r) => 1 - r.trimmedTokens / r.chunkTokens).sort((a, b) => a - b);
    const fmtP = (v) => (v === undefined ? "n/a" : (100 * v).toFixed(0) + "%");
    const toolSaves = obsSim
      .map((r) => 1 - r.toolResultTrimmedTokens / r.toolResultTokens)
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);
    const thinkSaves = obsSim
      .map((r) => 1 - r.thinkingTrimmedTokens / r.thinkingTokens)
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);
    md.push("");
    md.push("## Observer input simulation (what the observer would send upstream)");
    md.push("");
    md.push(
      `Chunk = source entries since the last observation marker, capped at \`observerChunkMaxTokens=${th.observerChunk}\` (mirrors capSourceEntriesToTokens). Role shares are chars/4 estimates of the serialized text (mirrors serialize.ts). Trim policy: tool results > ${TRIM.thresholdChars} chars → head+tail ${TRIM.headChars}/${TRIM.tailChars} chars; thinking blocks > ${THINK.thresholdChars} chars → head+tail ${Math.round(THINK.headPct * 100)}%/${Math.round(THINK.tailPct * 100)}% (fractional). **Provider usage (session context) is unaffected — trimming only reduces the observer's own input volume.**`,
    );
    md.push("");
    md.push("| session | chunk tokens | tool_result % | thinking % | trimmed tokens | save % |");
    md.push("|---|---|---|---|---|---|");
    for (const r of obsSim) {
      md.push(
        `| ${r.session} | ${r.chunkTokens} | ${((100 * r.toolResultTokens) / r.chunkTokens).toFixed(0)}% | ${((100 * r.thinkingTokens) / r.chunkTokens).toFixed(0)}% | ${r.trimmedTokens} | ${(100 * (1 - r.trimmedTokens / r.chunkTokens)).toFixed(0)}% |`,
      );
    }
    md.push("");
    md.push(
      `Aggregate: median chunk ${med(chunks)?.toLocaleString()} tokens; median tool_result share ${fmtP(med(trShares))}; median thinking share ${fmtP(med(thShares))}; combined median save ${fmtP(med(saves))} (p90 ${fmtP(pct(saves, 0.9))}); of tool-result tokens median ${fmtP(med(toolSaves))} saved; of thinking tokens median ${fmtP(med(thinkSaves))} saved (p90 ${fmtP(pct(thinkSaves, 0.9))}, max ${fmtP(thinkSaves[thinkSaves.length - 1])}).`,
    );
  }

  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, md.join("\n") + "\n");
  console.log(`\nFull report written to ${REPORT_PATH}`);

  return {
    th,
    sessions,
    stages,
    agg,
    rows,
    cal,
    obsSim,
    tierCal,
    useDefaults,
    limit,
  };
}

// ── summary writer (tracked review artifact in work_docs/) ────────────────
// Runs BOTH config surfaces (author config + code defaults) and writes only
// the math (aggregate, calibration, observer simulation) — no per-window rows.
function writeSummary(primary, secondary, outPath) {
  const med = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : undefined);
  const pct = (arr, p) =>
    arr.length ? arr[Math.min(arr.length - 1, Math.ceil(p * arr.length) - 1)] : undefined;
  const fmtP = (v) => (v === undefined ? "n/a" : (100 * v).toFixed(0) + "%");
  const fmtN = (v) => (v === undefined ? "n/a" : v.toLocaleString());

  const surface = (run, title) => {
    const { th, stages, agg, cal, obsSim } = run;
    const lines = [];
    lines.push(`## ${title}`);
    lines.push("");
    lines.push("### Aggregate (ratios over marker-present, usage>0 windows)");
    lines.push("");
    lines.push(
      "| stage | threshold | n | median | min | max | est fires | usage fires | churn× | LATE | EARLY | marker | no-marker | no-usage |",
    );
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const s of stages) {
      const a = agg[s.name];
      const ratios = [...a.ratios].sort((x, y) => x - y);
      const medR = ratios.length ? ratios[Math.floor(ratios.length / 2)].toFixed(2) : "n/a";
      const minR = ratios.length ? ratios[0].toFixed(2) : "n/a";
      const maxR = ratios.length ? ratios[ratios.length - 1].toFixed(2) : "n/a";
      lines.push(
        `| ${s.name} | ${s.threshold.toLocaleString()} | ${ratios.length} | ${medR} | ${minR} | ${maxR} | ${a.estOver} | ${a.usageOver} | ${(a.usageOver / a.estOver).toFixed(1)} | ${a.late} | ${a.early} | ${a.withMarker} | ${a.noMarker} | ${a.noUsage} |`,
      );
    }
    lines.push("");
    lines.push("### Calibration (usage threshold that reproduces today's fire frequency)");
    lines.push("");
    lines.push(
      "| stage | threshold | same-fire-count T' | achieved | usage p50 | p90 | p95 | max |",
    );
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const c of cal) {
      lines.push(
        `| ${c.stage} | ${stages.find((s) => s.name === c.stage).threshold.toLocaleString()} | ${fmtN(c.sameCount)} | ${fmtN(c.sameCountAchieved)} | ${fmtN(percentile(c.usageSorted, 0.5))} | ${fmtN(percentile(c.usageSorted, 0.9))} | ${fmtN(percentile(c.usageSorted, 0.95))} | ${fmtN(percentile(c.usageSorted, 1))} |`,
      );
    }
    lines.push("");
    if (obsSim.length > 0) {
      const chunks = obsSim.map((r) => r.chunkTokens).sort((a, b) => a - b);
      const trShares = obsSim.map((r) => r.toolResultTokens / r.chunkTokens).sort((a, b) => a - b);
      const thShares = obsSim.map((r) => r.thinkingTokens / r.chunkTokens).sort((a, b) => a - b);
      const saves = obsSim.map((r) => 1 - r.trimmedTokens / r.chunkTokens).sort((a, b) => a - b);
      const toolSaves = obsSim
        .map((r) => 1 - r.toolResultTrimmedTokens / r.toolResultTokens)
        .filter((v) => Number.isFinite(v))
        .sort((a, b) => a - b);
      const thinkSaves = obsSim
        .map((r) => 1 - r.thinkingTrimmedTokens / r.thinkingTokens)
        .filter((v) => Number.isFinite(v))
        .sort((a, b) => a - b);
      lines.push("### Observer input simulation (tool-result + thinking trimming)");
      lines.push("");
      lines.push(`- windows with content: ${obsSim.length}`);
      lines.push(
        `- median chunk: ${fmtN(med(chunks))} tokens | tool_result share: ${fmtP(med(trShares))} | thinking share: ${fmtP(med(thShares))}`,
      );
      lines.push(
        `- trim policy: tool results > ${TRIM.thresholdChars} chars → head+tail ${TRIM.headChars}/${TRIM.tailChars} chars; thinking > ${THINK.thresholdChars} chars → head+tail ${Math.round(THINK.headPct * 100)}%/${Math.round(THINK.tailPct * 100)}% (fractional)`,
      );
      lines.push(
        `- median ${fmtN(med(chunks))} → ${fmtN(med(obsSim.map((r) => r.trimmedTokens).sort((a, b) => a - b)))} tokens (combined median save ${fmtP(med(saves))}, p90 ${fmtP(pct(saves, 0.9))}); of tool-result tokens median ${fmtP(med(toolSaves))} saved; of thinking tokens median ${fmtP(med(thinkSaves))} saved`,
      );
      lines.push("");
    }
    return lines.join("\n");
  };

  const md = [];
  md.push("# Token estimation — calibration summary (review artifact)");
  md.push("");
  md.push(`- Generated: ${new Date().toISOString()}`);
  md.push(
    `- Sessions: ${primary.sessions.length} unique (realpath-deduped) under \`~/.pi/agent/sessions\``,
  );
  md.push(`- Command: \`node scripts/analyze-token-estimation.mjs --summary ${outPath}\``);
  md.push("- Full plan: \`work_docs/issue-usage-based-token-counting.md\`");
  md.push(
    "- Raw per-window reports (gitignored, regenerate with the script): \`tmp/token-estimation-report.md\` (author config), \`tmp/token-estimation-report-defaults.md\` (code defaults)",
  );
  md.push("");
  md.push(
    "Reading guide: **churn×** = how many more fires truthful counting produces with unchanged thresholds; **LATE** = windows where the trigger should have fired under truthful counting but didn't; **same-fire-count T'** = k-th largest actual usage with k = today's est fire count (reproduces today's frequency); **tool_result share** = share of the observer's serialized input that is tool-result text.",
  );
  md.push("");
  md.push(
    surface(
      primary,
      `Author's config (observe ${primary.th.observe.toLocaleString()} / reflect+drop ${primary.th.reflect.toLocaleString()} / compact ${primary.th.compact.toLocaleString()})`,
    ),
  );
  md.push("");

  // ── tier calibration (threshold-independent → shown once) ───────────────
  if (primary.tierCal.length > 0) {
    md.push("## Tier calibration (per achieved-context tier)");
    md.push("");
    md.push(
      "Tier = max context each session actually reached (max `usage.totalTokens`) — a measured lower bound on the model's window; usable on any user's machine. Compact anchor = 65% of the tier's p90 achieved context (README 60–70% rule). Worker thresholds read off the tier's usage distribution at target fire rates: **fire-20%** = only 20% of that tier's windows exceed it. Usage values are threshold-independent, so this section is identical for both config surfaces.",
    );
    md.push("");
    md.push("| tier | n | p50 ctx | p90 ctx | compact (65%) |");
    md.push("|---|---|---|---|---|");
    for (const c of primary.tierCal) {
      md.push(
        `| ${TIERS[c.ti].name} | ${c.n} | ${fmtN(c.p50)} | ${fmtN(c.p90)} | ${fmtN(c.compact)} |`,
      );
    }
    md.push("");
    md.push("| tier | stage | fire-20% | fire-40% | fire-60% |");
    md.push("|---|---|---|---|---|");
    for (const c of primary.tierCal) {
      for (const s of primary.stages) {
        const v = c.usage[s.name];
        if (!v.length) continue;
        md.push(
          `| ${TIERS[c.ti].name} | ${s.name} | ${fmtN(percentile(v, 0.8))} | ${fmtN(percentile(v, 0.6))} | ${fmtN(percentile(v, 0.4))} |`,
        );
      }
    }
    md.push("");
  }

  md.push(
    surface(
      secondary,
      `Code defaults (observe ${secondary.th.observe.toLocaleString()} / reflect+drop ${secondary.th.reflect.toLocaleString()} / compact ${secondary.th.compact.toLocaleString()} — auto-install surface)`,
    ),
  );
  md.push("");
  md.push(
    `_Generated by \`scripts/analyze-token-estimation.mjs --summary\`. Re-run any time to reproduce._`,
  );

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, md.join("\n") + "\n");
  console.log(`Summary written to ${outPath}`);
}

// main
const primary = analyzeOnce(useDefaults, limit);
if (summaryPath) {
  const secondary = analyzeOnce(!useDefaults, limit);
  writeSummary(primary, secondary, summaryPath);
}
