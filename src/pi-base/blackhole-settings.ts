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
    {
      key: "compaction",
      type: "enum",
      label: "Compaction mode",
      description:
        "automatic=trigger on threshold, manual=only /blackhole, off=auto:Pi handles, /blackhole:blackhole pipeline",
      value: cfg.compaction,
      options: ["automatic", "manual", "off"],
      optionLabels: {
        automatic: "automatic — trigger on threshold",
        manual: "manual — only /blackhole",
        off: "off — auto:Pi handles, /blackhole:blackhole pipeline",
      },
    },
    {
      key: "compactionSummaryMode",
      type: "enum",
      label: "Summary history",
      description:
        "default=replace one complete summary, append=freeze automatic segments and rebase on /blackhole",
      value: cfg.compactionSummaryMode,
      options: ["default", "append"],
      optionLabels: {
        default: "default — one complete replacement summary",
        append: "append — immutable auto segments; /blackhole rebases",
      },
    },
    {
      key: "tailBehavior",
      type: "enum",
      label: "Visible tail",
      description:
        "minimal=keep last user message only (default), pi-default=keep Pi's preserved visible context",
      value: cfg.tailBehavior,
      options: ["minimal", "pi-default"],
      optionLabels: {
        minimal: "minimal — keep last user message only (default)",
        "pi-default": "pi-default — keep Pi's preserved visible context",
      },
    },
    {
      key: "midRunCompaction",
      type: "enum",
      label: "Mid-run compaction",
      description:
        "resume=compact transparently and continue the same run, pause=interrupt and stop, off=only check when run ends (default)",
      value: cfg.midRunCompaction,
      options: ["resume", "pause", "off"],
      optionLabels: {
        resume: "resume — transparent compact, same run (experimental)",
        pause: "pause — interrupt, compact, and stop",
        off: "off — only check when run ends (default)",
      },
    },
    {
      key: "showPreCompactionMessage",
      type: "boolean",
      label: "Show pre-compaction output",
      description:
        "Display-only copy (max 16 KiB) of the newest assistant output the compaction dropped. Never enters model context or memory.",
      value: cfg.showPreCompactionMessage,
      valueDescriptions: {
        on: "Shown — recent output re-rendered below the compaction card",
        off: "Hidden — compaction card only",
      },
    },
    {
      key: "compactAfterBy",
      type: "enum",
      label: "Auto-compact when",
      description:
        "How the automatic compaction point is chosen. Presets scale with the model's context window; percent, tokens, and reserve are absolute overrides.",
      value: cfg.compactAfterBy ?? "preset",
      options: ["preset", "percent", "tokens", "reserve"],
      optionLabels: {
        preset: "preset — a curve scaled to each model's window",
        percent: "percent — a percent of each model's window",
        tokens: "tokens — the same fixed count on every model",
        reserve: "reserve — keep a fixed amount of headroom free",
      },
    },
    {
      key: "compactAfterTokens",
      type: "number",
      label: "Fixed token threshold",
      description: "Compact once the session reaches this many tokens, on any model.",
      value: cfg.compactAfterTokens ?? 0,
      min: 0,
      max: 500_000,
      step: 1_000,
      depth: 1,
      visibleWhen: (v) => v.get("compactAfterBy") === "tokens",
    },
    {
      key: "retainedToolOutputMaxTokens",
      type: "number",
      label: "Retained tool outputs",
      description:
        "Token budget for historical tool-output text; newest is retained first and older text remains available via recall",
      value: cfg.retainedToolOutputMaxTokens,
      min: 1_000,
      max: 200_000,
      step: 1_000,
    },
    // Shape + band (plan-09 §3.2). The selector picks exactly one shape; the
    // floor/ceiling always apply on top of whatever it computes. 0 = "not set"
    // for every numeric field here (the loader treats 0 as unset).
    {
      key: "compactAfterRatio",
      type: "number",
      label: "Percent of context window",
      description:
        "Compact once the session reaches this percent of the active model's context window (e.g. 65 on a 200k model fires at ~130k).",
      value: cfg.compactAfterRatio ?? 0,
      min: 0,
      max: 100,
      depth: 1,
      visibleWhen: (v) => v.get("compactAfterBy") === "percent",
    },
    {
      key: "compactReserveTokens",
      type: "number",
      label: "Context headroom kept free",
      description:
        "Compact once only this many tokens of headroom remain (threshold = window − reserve).",
      value: cfg.compactReserveTokens ?? 0,
      integer: true,
      min: 0,
      max: 2_000_000,
      depth: 1,
      visibleWhen: (v) => v.get("compactAfterBy") === "reserve",
    },
    {
      key: "compactAfterMinTokens",
      type: "number",
      label: "Never compact below",
      description:
        "Lower bound on the threshold, whatever the shape computes — protects a big model's setting when you switch to a smaller one.",
      value: cfg.compactAfterMinTokens ?? 0,
      min: 0,
      max: 2_000_000,
      step: 1_000,
      depth: 1,
    },
    {
      key: "compactAfterMaxTokens",
      type: "number",
      label: "Never compact later than",
      description:
        "Upper bound on the threshold, whatever the shape computes — pins an absolute operating point on a huge window.",
      value: cfg.compactAfterMaxTokens ?? 0,
      min: 0,
      max: 2_000_000,
      step: 1_000,
      depth: 1,
    },
    {
      key: "compactAfterPreset",
      type: "enum",
      label: "Preset curve",
      description:
        "The window-scaled curve used when the shape is preset (default: compact at 90% of a 32k window, falling to 40% at 1M). To edit the curve or add presets, hand-edit compactAfterPresets in the config file.",
      value: cfg.compactAfterPreset ?? "default",
      // Options = built-in preset names + any user-added names from the file
      // (same effective-presets merge the resolver uses, so the modal list and
      // runtime resolution cannot disagree).
      options: Object.keys(effectivePresets(cfg)),
      optionLabels: Object.fromEntries(
        Object.keys(effectivePresets(cfg)).map((name) => [
          name,
          name === "default"
            ? "default — falling curve (0.90 @ 32k → 0.40 @ 1M)"
            : `${name} (custom preset)`,
        ]),
      ),
      depth: 1,
      visibleWhen: (v) => v.get("compactAfterBy") === "preset",
    },

    // ── Observational Memory ──
    {
      key: "memory",
      type: "boolean",
      label: "Observational memory",
      description: "Enable OM workers (observer, reflector, dropper) and content injection",
      value: cfg.memory,
      valueDescriptions: {
        on: "Active — OM workers + content injection enabled",
        off: "Suspended — OM disabled",
      },
    },
    {
      key: "sessionFallback",
      type: "boolean",
      label: "Session model fallback",
      description:
        "off=skip stage when all OM models fail, instead of falling back to the main coding model",
      value: cfg.sessionFallback ?? true,
    },
    {
      key: "observeAfterTokens",
      type: "number",
      label: "Observer threshold",
      description: "Tokens accumulated since last observer run before triggering next observe",
      value: cfg.observeAfterTokens,
      min: 1_000,
      max: 200_000,
      step: 1_000,
    },
    {
      key: "reflectAfterTokens",
      type: "number",
      label: "Reflect + dropper threshold",
      description: "Tokens accumulated since last reflect before triggering reflector and dropper",
      value: cfg.reflectAfterTokens,
      min: 1_000,
      max: 200_000,
      step: 1_000,
    },
    {
      key: "observationsPoolMaxTokens",
      type: "number",
      label: "Observation pool max",
      description:
        "Full-fold pressure and max estimated rendered observation-line tokens in compaction output",
      value: cfg.observationsPoolMaxTokens,
      min: 1_000,
      max: 200_000,
      step: 1_000,
    },
    {
      key: "reflectionsPoolMaxTokens",
      type: "number",
      label: "Reflection output max",
      description:
        "Max estimated rendered reflection-line tokens in compaction output. 0 disables the cap. Full source records remain available through recall.",
      value: cfg.reflectionsPoolMaxTokens,
      min: 0,
      max: 200_000,
      step: 1_000,
    },
    {
      key: "reflectorInputMaxTokens",
      type: "number",
      label: "Reflector input max",
      description: "Max prompt tokens for reflector model input (rolling window cap)",
      value: cfg.reflectorInputMaxTokens,
      min: 1_000,
      max: 500_000,
      step: 1_000,
    },
    {
      key: "dropperInputMaxTokens",
      type: "number",
      label: "Dropper input max",
      description: "Max prompt tokens for dropper model input (rolling window cap)",
      value: cfg.dropperInputMaxTokens,
      min: 1_000,
      max: 500_000,
      step: 1_000,
    },
    {
      key: "observerChunkMaxTokens",
      type: "number",
      label: "Observer chunk max",
      description: "Max source entry tokens sent to observer per chunk",
      value: cfg.observerChunkMaxTokens,
      min: 1_000,
      max: 200_000,
      step: 1_000,
    },
    {
      key: "dropperPressureThreshold",
      type: "number",
      label: "Dropper pressure threshold",
      description:
        "Fraction of observationsPoolMaxTokens that triggers pressure-driven dropper (1 disables)",
      value: cfg.dropperPressureThreshold,
      min: 0.01,
      max: 1,
      step: 0.01,
    },
    {
      key: "dropperPoolFullnessThreshold",
      type: "number",
      label: "Dropper pool fullness threshold",
      description:
        "Min observation-pool fullness (fraction of pool max) before the dropper runs (0-1, default 0.10)",
      value: cfg.dropperPoolFullnessThreshold,
      min: 0.01,
      max: 1,
      step: 0.01,
    },
    {
      key: "agentMaxTurns",
      type: "number",
      label: "Max turns per agent",
      description: "Shared turn cap for background memory agents",
      value: cfg.agentMaxTurns,
      min: 1,
      max: 100,
      step: 1,
    },
    {
      key: "providerIdleTimeoutMs",
      type: "number",
      label: "Provider idle timeout (ms)",
      description:
        "Body-idle timeout for background provider streams; 0 = disabled, unset = inherit pi's default",
      value: cfg.providerIdleTimeoutMs ?? 0,
      min: 0,
      max: 3_600_000,
      step: 1000,
    },
    {
      key: "cacheRetention",
      type: "enum",
      label: "Worker prompt-cache retention",
      description:
        "Provider-neutral prompt-cache retention for the memory workers; unset defers to pi's effective setting. Adapters ignore values they do not support.",
      // "unset" is a modal-only sentinel: validate() drops it before the config
      // is persisted, so an untouched field never pins a value in the file.
      value: cfg.cacheRetention ?? "unset",
      options: ["unset", ...CACHE_RETENTION_VALUES],
      optionLabels: {
        unset: "unset — inherit pi's effective setting",
        none: "none — no prompt caching where supported",
        short: "short — pi's provider default",
        long: "long — extended retention where supported",
      },
    },
    {
      key: "workerAttemptTimeoutMs",
      type: "number",
      label: "Worker attempt timeout (ms)",
      description:
        "Hard elapsed deadline per worker/model attempt; timeout aborts the call and tries the next fallback; 0 = disabled",
      value: cfg.workerAttemptTimeoutMs ?? 0,
      min: 0,
      max: 3_600_000,
      step: 1000,
    },
    {
      key: "fullFoldAlways",
      type: "boolean",
      label: "Preserve OM on first compaction",
      description:
        "When true, early reflections/drops survive the first compaction in a fresh session",
      value: cfg.fullFoldAlways,
    },

    // ── UI ──
    {
      key: "statusBar",
      type: "boolean",
      label: "Footer status bar",
      description: "Show token gauges (O/P/X) and worker events in the footer",
      value: cfg.statusBar,
    },
    {
      key: "showWorkerNotifications",
      type: "boolean",
      label: "Worker notifications",
      description:
        "Show routine observer/reflector/dropper progress toasts; warnings, errors and compaction notices always show",
      value: cfg.showWorkerNotifications,
      valueDescriptions: {
        on: "On — routine worker progress toasts shown",
        off: "Off — quiet; warnings/errors only",
      },
    },

    // ── Debug ──
    {
      key: "debug",
      type: "boolean",
      label: "Debug snapshots",
      description: "Write detailed debug snapshots to /tmp/pi-blackhole-debug.json",
      value: cfg.debug,
    },
    {
      key: "debugLog",
      type: "boolean",
      label: "Debug JSONL logging",
      description: "Write structured JSONL debug logs to agent directory",
      value: cfg.debugLog,
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
      "dropperInputMaxTokens",
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

    // dropperPoolFullnessThreshold — must be in (0, 1]
    const dpf = merged.dropperPoolFullnessThreshold;
    if (typeof dpf !== "number" || !Number.isFinite(dpf) || dpf <= 0 || dpf > 1) {
      merged.dropperPoolFullnessThreshold = DEFAULTS.dropperPoolFullnessThreshold;
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
