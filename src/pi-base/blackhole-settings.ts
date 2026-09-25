/**
 * Blackhole settings — modal-based configuration via ConfigManager.
 *
 * The single config UI: pi-base's ConfigManager + openConfigFlow
 * (scope-selector → edit/display-all modal). `/blackhole configure` is a
 * hidden alias for `/blackhole settings` and opens this modal.
 *
 * Env-var overrides are applied by ConfigManager after load + validate,
 * so they take effect for both the runtime path (loadUnifiedConfig) and
 * the modal path (config.load / config.openSettings).
 *
 * Session-scoped config is enabled: blackhole-specific overrides are
 * persisted to the session JSONL and recovered on session_start.
 */

import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigManager } from "../pi-base/config-manager.js";
import { getPiAgentDir } from "../pi-base/paths.js";
import { DECLARATIVE_ENV_OVERRIDES } from "../core/config-env.js";
import {
  CACHE_RETENTION_VALUES,
  DEFAULTS,
  foldCompaction,
  normalizeCacheRetention,
  normalizeThresholdKnobs,
  type UnifiedConfig,
} from "../core/unified-config.js";
import { effectivePresets } from "../om/model-budget.js";
import { openChangelogView } from "../changelog/changelog.js";

const CONFIG_FILENAME = "pi-blackhole-config.json";

export const GLOBAL_CONFIG_DIR = join(getPiAgentDir(), "pi-blackhole");

// ── Copy helpers ─────────────────────────────────────────────────────────────

/** Compact token count for help copy: 20000 → "20k", 1000000 → "1M". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** A `type: "section"` heading row (non-interactive full-width label). */
function sectionRow(key: string, label: string) {
  return { key, type: "section" as const, label, value: label };
}

// ── ConfigManager instance ───────────────────────────────────────────────────

export const config = new ConfigManager<UnifiedConfig>({
  id: "pi-blackhole",
  label: "pi-blackhole",
  filename: CONFIG_FILENAME,
  configDir: GLOBAL_CONFIG_DIR,
  defaults: DEFAULTS,
  scopes: { global: true, project: true, session: true },
  sessionConfig: { entryType: "session-config-pi-blackhole" },

  fields: (cfg) => [
    // ── Compaction ──
    sectionRow("_sec_compaction", "Compaction"),
    {
      key: "compaction",
      type: "enum",
      label: "When to compact",
      description:
        "How blackhole handles compaction of the chat history. Automatic compacts on its own when the threshold is reached; manual only compacts when you run /blackhole; off leaves compaction to Pi.",
      value: cfg.compaction,
      options: ["automatic", "manual", "off"],
      optionLabels: {
        automatic: "automatic",
        manual: "manual",
        off: "off",
      },
      valueDescriptions: {
        automatic: "blackhole compacts automatically when the threshold is reached (recommended).",
        manual: "Only /blackhole compacts; memory notes are held until then.",
        off: "blackhole steps aside and Pi handles compaction; /blackhole still works.",
      },
    },
    {
      key: "compactionSummaryMode",
      type: "enum",
      label: "How summaries are kept",
      description: "What happens to earlier summaries when a new compaction happens.",
      value: cfg.compactionSummaryMode,
      options: ["default", "append"],
      optionLabels: {
        default: "default",
        append: "append",
      },
      valueDescriptions: {
        default: "Each compaction replaces the previous summary with one current summary.",
        append: "Every summary is kept as a separate part; /blackhole merges them back into one.",
      },
    },
    {
      key: "tailBehavior",
      type: "enum",
      label: "Recent messages kept visible",
      description:
        "How much of the most recent chat stays on screen after a compaction. Everything before that point is summarized and removed from view.",
      value: cfg.tailBehavior,
      options: ["minimal", "pi-default"],
      optionLabels: {
        minimal: "minimal",
        "pi-default": "pi-default",
      },
      valueDescriptions: {
        minimal: "Keep only your last message (default).",
        "pi-default": "Keep roughly the last 20k tokens of chat.",
      },
    },
    {
      key: "midRunCompaction",
      type: "enum",
      label: "Compacting during a long task",
      description: "Whether blackhole may compact while a long task is still running.",
      value: cfg.midRunCompaction,
      options: ["resume", "pause", "off"],
      optionLabels: {
        resume: "resume",
        pause: "pause",
        off: "off",
      },
      valueDescriptions: {
        resume: "Compact mid-task and continue without interrupting (experimental).",
        pause: "Interrupt the task, compact, and stop so you can review.",
        off: "Only check the threshold between tasks (default).",
      },
    },
    {
      key: "showPreCompactionMessage",
      type: "boolean",
      label: "Keep the last answer visible",
      description:
        "After a compaction, re-display the newest answer that was scrolled out of view. Display only — never sent to the model.",
      value: cfg.showPreCompactionMessage,
      valueDescriptions: {
        on: "The dropped answer is shown again below the compaction card (up to 16 KiB).",
        off: "Only the compaction card is shown.",
      },
    },

    // ── When to compact automatically ──
    sectionRow("_sec_auto", "When to compact automatically"),
    {
      key: "compactAfterBy",
      type: "enum",
      label: "Auto-compact when",
      description:
        "How the auto-compaction point is chosen. A preset adapts to each model's context window; percent, fixed, and reserve are simple overrides.",
      value: cfg.compactAfterBy ?? "preset",
      options: ["preset", "percent", "tokens", "reserve"],
      optionLabels: {
        preset: "preset",
        percent: "percent",
        tokens: "tokens",
        reserve: "reserve",
      },
      valueDescriptions: {
        preset:
          "The threshold follows a curve scaled to each model's context window (recommended).",
        percent:
          "The same fraction of every model's window; add a floor or ceiling to stay sane across models.",
        tokens: "The same fixed number of tokens on every model.",
        reserve:
          "Keep a fixed amount of context free; compact once the remaining headroom would drop below it.",
      },
    },
    {
      key: "compactAfterRatio",
      type: "number",
      label: "Percent of context window",
      description:
        "Compact once the conversation reaches this percentage of the active model's context window. Add a floor and ceiling if you switch between very different model sizes.",
      value: cfg.compactAfterRatio ?? 0,
      min: 0,
      max: 100,
      depth: 1,
      visibleWhen: (v) => v.get("compactAfterBy") === "percent",
      valueDescription: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return "Not set — pick a percentage to use this shape.";
        const small = Math.round((256_000 * n) / 100);
        const big = Math.round((1_000_000 * n) / 100);
        return `At ${n}% — a 256k-token model compacts near ${fmtTokens(small)} tokens; a 1M model near ${fmtTokens(big)} unless a ceiling is set.`;
      },
    },
    {
      key: "compactAfterTokens",
      type: "number",
      label: "Fixed token count",
      description:
        "Compact once the conversation reaches this exact number of tokens, regardless of the model's context window.",
      value: cfg.compactAfterTokens ?? 0,
      min: 0,
      max: 500_000,
      step: 1_000,
      depth: 1,
      visibleWhen: (v) => v.get("compactAfterBy") === "tokens",
      valueDescription: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return "At 0 — no fixed threshold.";
        return `At ${n} — compaction starts at ${fmtTokens(n)} tokens on every model.`;
      },
    },
    {
      key: "compactReserveTokens",
      type: "number",
      label: "Headroom reserve",
      description:
        "Keep this many tokens of context free — compact once the remaining headroom would drop below it (threshold = window − reserve). Keeps a constant margin on any model size.",
      value: cfg.compactReserveTokens ?? 0,
      integer: true,
      min: 0,
      max: 2_000_000,
      depth: 1,
      visibleWhen: (v) => v.get("compactAfterBy") === "reserve",
      valueDescription: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return "At 0 — no reserve (this shape is inactive).";
        const small = Math.max(1, 200_000 - n);
        const big = Math.max(1, 1_000_000 - n);
        return `At ${n} — a 200k model compacts near ${fmtTokens(small)} tokens; a 1M model near ${fmtTokens(big)}.`;
      },
    },
    {
      key: "compactAfterPreset",
      type: "enum",
      label: "Preset",
      description:
        "Which window-scaled curve sets the compaction point. Edit curves in the config file under compactAfterPresets.",
      value: cfg.compactAfterPreset ?? "default",
      // Options = built-in preset names + any user-added names from the file
      // (same effective-presets merge the resolver uses, so the modal list and
      // runtime resolution cannot disagree).
      options: Object.keys(effectivePresets(cfg)),
      optionLabels: Object.fromEntries(
        Object.keys(effectivePresets(cfg)).map((name) => [
          name,
          name === "default" ? "default" : `${name} (custom)`,
        ]),
      ),
      valueDescriptions: {
        default: "Gently falling curve: ~90% of a small window, ~40% of a 1M window.",
      },
      depth: 1,
      visibleWhen: (v) => v.get("compactAfterBy") === "preset",
    },
    {
      key: "compactAfterMinTokens",
      type: "number",
      label: "Never compact below",
      description:
        "Never compact before the conversation grows past this many tokens, whatever the percentage or preset says. Protects you when you switch to a smaller-context model and the percentage alone would compact far too early.",
      value: cfg.compactAfterMinTokens ?? 0,
      min: 0,
      max: 2_000_000,
      step: 1_000,
      depth: 1,
      valueDescription: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return "At 0 — no floor (default).";
        return `At ${n} — never compacts before ${fmtTokens(n)} tokens, even on a smaller model.`;
      },
    },
    {
      key: "compactAfterMaxTokens",
      type: "number",
      label: "Never compact later than",
      description:
        "Never let the conversation grow past this many tokens before compacting, whatever the percentage or preset says. Useful on very large windows where a percentage would wait far too long.",
      value: cfg.compactAfterMaxTokens ?? 0,
      min: 0,
      max: 2_000_000,
      step: 1_000,
      depth: 1,
      valueDescription: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return "At 0 — no ceiling (default).";
        return `At ${n} — compacts by ${fmtTokens(n)} tokens even on a very large window.`;
      },
    },

    // ── Context budgets ──
    sectionRow("_sec_context", "Context budgets"),
    {
      key: "retainedToolOutputMaxTokens",
      type: "number",
      label: "Tool output kept",
      description:
        "How much recent tool and command output stays in context. Older output is replaced by a recall pointer, so nothing is lost — it just is not sent to the model every turn.",
      value: cfg.retainedToolOutputMaxTokens,
      min: 1_000,
      max: 200_000,
      step: 1_000,
      valueDescription: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0)
          return "At 0 — no limit; all tool output stays in context.";
        return `At ${n} — the newest ~${fmtTokens(n)} tokens of tool output stay in context${n === 20_000 ? " (default)" : ""}.`;
      },
    },
    {
      key: "recallResponseMaxChars",
      type: "number",
      label: "Recall answer size",
      description:
        "Largest single answer the recall tool may return, so one huge old message cannot flood the context. Full content stays reachable through paged drill-downs.",
      value: cfg.recallResponseMaxChars,
      min: 0,
      max: 2_000_000,
      step: 1_000,
      valueDescription: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return "At 0 — no cap on a single recall answer.";
        const toks = Math.round(n / 4);
        return `At ${n} — one recall answer is capped at ~${fmtTokens(n)} characters (~${fmtTokens(toks)} tokens)${n === 48_000 ? " (default)" : ""}.`;
      },
    },

    // ── Memory — behavior ──
    sectionRow("_sec_memory_behavior", "Memory — behavior"),
    {
      key: "memory",
      type: "boolean",
      label: "Observational memory",
      description:
        "Background jobs that read your conversation and keep durable notes and insights across compactions.",
      value: cfg.memory,
      valueDescriptions: {
        on: "Memory jobs run and their notes are included in compactions (default).",
        off: "No memory jobs and no memory content; compaction still works.",
      },
    },
    {
      key: "observeAfterTokens",
      type: "number",
      label: "Take notes every",
      description:
        "How much new conversation accumulates before the note-taker runs. Lower keeps memory more current at the cost of more background calls.",
      value: cfg.observeAfterTokens,
      min: 1_000,
      max: 200_000,
      step: 1_000,
      valueDescription: (v) => {
        const n = Number(v);
        return `At ${n} — a note-taking pass starts after ~${fmtTokens(n)} new tokens${n === 15_000 ? " (default)" : ""}.`;
      },
    },
    {
      key: "reflectAfterTokens",
      type: "number",
      label: "Build insights every",
      description:
        "How much new conversation accumulates before notes are distilled into durable insights and memory is pruned of low-value notes.",
      value: cfg.reflectAfterTokens,
      min: 1_000,
      max: 200_000,
      step: 1_000,
      valueDescription: (v) => {
        const n = Number(v);
        return `At ${n} — insights are built and memory is pruned after ~${fmtTokens(n)} new tokens${n === 25_000 ? " (default)" : ""}.`;
      },
    },
    {
      key: "dropperPressureThreshold",
      type: "number",
      label: "Prune memory when",
      description:
        "How full note memory gets, as a share of the note memory budget, before low-value notes are pruned. Pruning always needs this threshold.",
      value: cfg.dropperPressureThreshold,
      min: 0.01,
      max: 1,
      step: 0.01,
      valueDescription: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return "Not set — pruning needs a positive threshold.";
        const pct = Math.round(n * 100);
        return `At ${pct}% — pruning starts once note memory is ~${pct}% full${n === 0.7 ? " (default)" : ""}. Lower prunes earlier; higher keeps more notes.`;
      },
    },

    // ── Memory — sizes ──
    sectionRow("_sec_memory_sizes", "Memory — sizes"),
    {
      key: "observationsPoolMaxTokens",
      type: "number",
      label: "Note memory budget",
      description:
        "How much note text is kept in the memory sent to the model. Once saved notes reach this size, blackhole runs a full memory maintenance pass that keeps the most useful notes.",
      value: cfg.observationsPoolMaxTokens,
      min: 1_000,
      max: 200_000,
      step: 1_000,
      valueDescription: (v) => {
        const n = Number(v);
        return `At ${n} — memory is maintained once notes reach ~${fmtTokens(n)} tokens${n === 20_000 ? " (default)" : ""}. Raise to retain more detail; lower to send less memory every turn.`;
      },
    },
    {
      key: "reflectionsPoolMaxTokens",
      type: "number",
      label: "Insight memory budget",
      description:
        "How much insight text is kept in the memory sent to the model. Older insights drop out of view but stay available through recall.",
      value: cfg.reflectionsPoolMaxTokens,
      min: 0,
      max: 200_000,
      step: 1_000,
      valueDescription: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return "At 0 — keep all insights.";
        return `At ${n} — the newest ~${fmtTokens(n)} tokens of insights are kept${n === 8_000 ? " (default)" : ""}.`;
      },
    },
    {
      key: "observerChunkMaxTokens",
      type: "number",
      label: "Conversation read per pass",
      description:
        "How much new conversation the note-taker reads in one pass. Anything beyond this is read on a later pass.",
      value: cfg.observerChunkMaxTokens,
      min: 1_000,
      max: 200_000,
      step: 1_000,
      valueDescription: (v) => {
        const n = Number(v);
        return `At ${n} — up to ~${fmtTokens(n)} tokens of conversation per pass${n === 40_000 ? " (default)" : ""}.`;
      },
    },
    {
      key: "reflectorInputMaxTokens",
      type: "number",
      label: "Memory read per job",
      description:
        "Largest memory snapshot an insight-building or pruning job reads at once. Lower is cheaper but sees less context.",
      value: cfg.reflectorInputMaxTokens,
      min: 1_000,
      max: 500_000,
      step: 1_000,
      valueDescription: (v) => {
        const n = Number(v);
        return `At ${n} — up to ~${fmtTokens(n)} tokens of memory per job${n === 80_000 ? " (default)" : ""}.`;
      },
    },

    // ── Advanced ──
    sectionRow("_sec_advanced", "Advanced"),
    {
      key: "sessionFallback",
      type: "boolean",
      label: "Fall back to session model",
      description: "What to do when every model configured for a memory job fails.",
      value: cfg.sessionFallback ?? true,
      valueDescriptions: {
        on: "Use your main chat model for that memory job (default).",
        off: "Skip that memory update instead of spending your chat model on it.",
      },
    },
    {
      key: "agentMaxTurns",
      type: "number",
      label: "Max steps per memory job",
      description:
        "Maximum tool and reasoning steps a single background memory job may take before it stops.",
      value: cfg.agentMaxTurns,
      min: 1,
      max: 100,
      step: 1,
      valueDescription: (v) => {
        const n = Number(v);
        return `At ${n} — up to ${n} step${n === 1 ? "" : "s"} per job${n === 16 ? " (default)" : ""}.`;
      },
    },
    {
      key: "fullFoldAlways",
      type: "boolean",
      label: "Keep early notes through first compaction",
      description:
        "Keep notes and insights gathered early in a session through its first compaction, instead of letting that compaction start memory fresh.",
      value: cfg.fullFoldAlways,
      valueDescriptions: {
        on: "Early memory survives the first compaction (default).",
        off: "The first compaction starts memory from scratch.",
      },
    },
    {
      key: "cacheRetention",
      type: "enum",
      label: "Memory job prompt caching",
      description:
        "Whether memory jobs ask the provider to cache their prompts. Caching can cut cost and latency when the same prompt is reused.",
      // "unset" is a modal-only sentinel: validate() drops it before the config
      // is persisted, so an untouched field never pins a value in the file.
      value: cfg.cacheRetention ?? "unset",
      options: ["unset", ...CACHE_RETENTION_VALUES],
      optionLabels: {
        unset: "unset",
        none: "none",
        short: "short",
        long: "long",
      },
      valueDescriptions: {
        unset: "Use pi's default (short).",
        none: "Do not request caching.",
        short: "pi's default retention.",
        long: "Extended retention where the provider supports it.",
      },
    },
    {
      key: "providerIdleTimeoutMs",
      type: "number",
      label: "Memory job idle timeout",
      description:
        "How long a memory job's model connection may go silent before it is treated as dead. 0 disables the timeout; unset uses pi's default.",
      value: cfg.providerIdleTimeoutMs ?? 0,
      min: 0,
      max: 3_600_000,
      step: 1000,
      valueDescription: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return "At 0 — disabled (default).";
        return `At ${n} — a job's connection may go silent this long before it is treated as dead.`;
      },
    },
    {
      key: "workerAttemptTimeoutMs",
      type: "number",
      label: "Memory job attempt timeout",
      description:
        "Hard time limit for one memory-job model attempt. When it expires, blackhole aborts and tries the next fallback model. 0 disables it.",
      value: cfg.workerAttemptTimeoutMs ?? 0,
      min: 0,
      max: 3_600_000,
      step: 1000,
      valueDescription: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return "At 0 — disabled (default).";
        return `At ${n} — one attempt is aborted after this long and the next fallback is tried.`;
      },
    },
    {
      key: "statusBar",
      type: "boolean",
      label: "Footer status bar",
      description: "Show the footer memory gauges and background job activity.",
      value: cfg.statusBar,
      valueDescriptions: {
        on: "Gauges and job activity shown (default).",
        off: "Hidden.",
      },
    },
    {
      key: "showWorkerNotifications",
      type: "boolean",
      label: "Memory job notifications",
      description:
        "Show routine progress messages while background memory jobs run. Warnings and errors always show.",
      value: cfg.showWorkerNotifications,
      valueDescriptions: {
        on: "Routine progress messages shown (default).",
        off: "Quiet; warnings and errors only.",
      },
    },
    {
      key: "debug",
      type: "boolean",
      label: "Debug snapshots",
      description:
        "Save a detailed snapshot of each compaction to /tmp/pi-blackhole-debug.json for troubleshooting.",
      value: cfg.debug,
      valueDescriptions: {
        on: "Snapshots written.",
        off: "None (default).",
      },
    },
    {
      key: "debugLog",
      type: "boolean",
      label: "Debug JSONL logging",
      description:
        "Append a rolling structured log of background activity to ~/.pi/agent/pi-blackhole/debug.ndjson.",
      value: cfg.debugLog,
      valueDescriptions: {
        on: "Log written (rotates at 10 MB).",
        off: "None (default).",
      },
    },
  ],

  /**
   * Validate raw loaded data, apply legacy migration, clamp numeric fields,
   * and apply all env-var overrides (both declarative env-map and legacy
   * passive/compaction env vars).
   */
  validate: (raw) => {
    const parsed = { ...raw } as Partial<UnifiedConfig>;

    // ── Migration: legacy keys → new surface ──
    // Fold the two-key compaction surface (plan-09 §3.1) with the same helper
    // the file loader uses, so the modal and the runtime agree.
    const foldedCompaction = foldCompaction(
      (parsed as Record<string, unknown>).compaction,
      (parsed as Record<string, unknown>).compactionEngine,
    );
    if (foldedCompaction !== undefined) parsed.compaction = foldedCompaction;
    delete (parsed as Record<string, unknown>).compactionEngine;

    if (parsed.compaction === undefined) {
      if (parsed.passive === true) {
        parsed.compaction = "off";
        parsed.memory = false;
      } else if (parsed.noAutoCompact === true) {
        parsed.compaction = "manual";
      }
      if (parsed.overrideDefaultCompaction === true) {
        if (parsed.compaction === undefined) parsed.compaction = "automatic";
        if (parsed.tailBehavior === undefined) {
          parsed.tailBehavior = "minimal";
        }
      } else if (parsed.overrideDefaultCompaction === false) {
        if (parsed.compaction === undefined) parsed.compaction = "off";
      }
    }
    delete (parsed as Record<string, unknown>).passive;
    delete (parsed as Record<string, unknown>).noAutoCompact;
    delete (parsed as Record<string, unknown>).overrideDefaultCompaction;

    // ── Legacy passive env vars (Layer 4, highest priority) ──
    const envPassive =
      process.env.PI_BLACKHOLE_PASSIVE ??
      process.env.PI_VCC_OM_PASSIVE ??
      process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE;
    if (envPassive !== undefined) {
      const v = envPassive.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(v)) {
        parsed.compaction = "off";
        parsed.memory = false;
      } else if (["0", "false", "no", "off"].includes(v)) {
        if (raw.passive === true) {
          delete parsed.compaction;
          delete (parsed as Record<string, unknown>).memory;
        }
      }
    }

    // ── Warn on invalid enum env vars (application handled by applyEnvOverrides) ──
    const envCompaction = process.env.PI_BLACKHOLE_COMPACTION;
    if (envCompaction !== undefined) {
      const trimmed = envCompaction.trim().toLowerCase();
      // "auto" is the pre-plan alias; env vars are not migrated.
      if (!["automatic", "manual", "off", "auto"].includes(trimmed)) {
        console.warn(
          `blackhole: invalid PI_BLACKHOLE_COMPACTION value "${envCompaction}"; ignoring`,
        );
      }
    }

    const envCompactionSummaryMode = process.env.PI_BLACKHOLE_COMPACTION_SUMMARY_MODE;
    if (envCompactionSummaryMode !== undefined) {
      const trimmed = envCompactionSummaryMode.trim().toLowerCase();
      if (!["default", "append"].includes(trimmed)) {
        console.warn(
          `blackhole: invalid PI_BLACKHOLE_COMPACTION_SUMMARY_MODE value "${envCompactionSummaryMode}"; ignoring`,
        );
      }
    }
    const envMidRunCompaction = process.env.PI_BLACKHOLE_MID_RUN_COMPACTION;
    if (envMidRunCompaction !== undefined) {
      const trimmed = envMidRunCompaction.trim().toLowerCase();
      if (!["resume", "pause", "off"].includes(trimmed)) {
        console.warn(
          `blackhole: invalid PI_BLACKHOLE_MID_RUN_COMPACTION value "${envMidRunCompaction}"; ignoring`,
        );
      }
    }

    // ── Threshold knobs: same scrubber the file loader uses ──
    // 0 means "not set", out-of-range values are dropped, legacy 81000
    // residue is dropped, and preset definitions are validated + sorted —
    // so the modal path agrees with loadUnifiedConfig on every key.
    // (Runs before the merge so an emptied preset name falls back to the
    // DEFAULTS "default", and dropped knobs stay absent. Env overrides
    // re-apply afterwards, so env-set values stay explicit.)
    // SAFETY: parsed is a plain config record; the normalizer only validates or deletes named properties.
    normalizeThresholdKnobs(parsed as unknown as Record<string, unknown>);

    // ── cacheRetention: drop the modal "unset" sentinel and any unsupported value ──
    // Keeps the modal path in lockstep with loadUnifiedConfig's parseConfig,
    // which only accepts none|short|long (case-insensitively, via the same
    // normalizer). Deleting here is also how the modal clears a stored value:
    // the save diff carries the key as undefined, so the key leaves the file.
    const cacheRetention = normalizeCacheRetention(parsed.cacheRetention);
    if (cacheRetention) {
      parsed.cacheRetention = cacheRetention;
    } else {
      delete parsed.cacheRetention;
    }

    // ── Merge with defaults ──
    const merged = { ...DEFAULTS, ...parsed } as UnifiedConfig;

    // ── Numeric field validation ──
    const REQUIRED_NUMERIC_KEYS: readonly (keyof UnifiedConfig)[] = [
      "observeAfterTokens",
      "reflectAfterTokens",
      "retainedToolOutputMaxTokens",
      "observationsPoolMaxTokens",
      "reflectionsPoolMaxTokens",
      "reflectorInputMaxTokens",
      "observerChunkMaxTokens",
      "agentMaxTurns",
    ];
    for (const k of REQUIRED_NUMERIC_KEYS) {
      // SAFETY: merged is a plain config object; indexing by dynamic key needs
      // the Record view to read/write numeric fields uniformly.
      const v = (merged as unknown as Record<string, unknown>)[k];
      const minVal = k === "reflectionsPoolMaxTokens" ? 0 : 1;
      if (
        typeof v !== "number" ||
        !Number.isFinite(v) ||
        ((k === "retainedToolOutputMaxTokens" || k === "reflectionsPoolMaxTokens") &&
          !Number.isInteger(v)) ||
        v < minVal
      ) {
        // SAFETY: dynamic-key write as above; DEFAULTS[k] is always a number
        // for keys in REQUIRED_NUMERIC_KEYS.
        (merged as unknown as Record<string, unknown>)[k] = DEFAULTS[k];
      }
    }

    // dropperPressureThreshold — must be in (0, 1]
    const dpt = merged.dropperPressureThreshold;
    if (typeof dpt !== "number" || !Number.isFinite(dpt) || dpt <= 0 || dpt > 1) {
      merged.dropperPressureThreshold = DEFAULTS.dropperPressureThreshold;
    }

    return merged;
  },

  env: DECLARATIVE_ENV_OVERRIDES,
});

// ── Public entry point ───────────────────────────────────────────────────────

export async function openBlackholeSettings(ctx: ExtensionContext): Promise<void> {
  await config.openSettings(
    ctx,
    ctx.cwd,
    (_updated) => {
      // Caller (pi-vcc.ts) reloads runtime.config after save.
    },
    GLOBAL_CONFIG_DIR,
    undefined,
    [
      {
        id: "changelog",
        label: "Display Changelog",
        available: true,
      },
    ],
    async (id: string) => {
      if (id === "changelog") await openChangelogView(ctx);
    },
  );
}
