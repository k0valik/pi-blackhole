/**
 * Blackhole settings — modal-based configuration via ConfigManager.
 *
 * Replaces the hand-rolled configure overlay (src/om/configure-overlay.ts)
 * with pi-base's ConfigManager + openConfigFlow (scope-selector →
 * edit/display-all modal).
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
import { DEFAULTS, type UnifiedConfig } from "../core/unified-config.js";

const CONFIG_FILENAME = "pi-blackhole-config.json";

export const GLOBAL_CONFIG_DIR = join(getPiAgentDir(), "pi-blackhole");

/** valueDescriptions note for "0 = auto-derive" number fields. */
const AUTO_DERIVE_NOTE = (note: string): Record<string, string> => ({
  "0": note,
});

// ── ConfigManager instance ───────────────────────────────────────────────────

export const config = new ConfigManager<UnifiedConfig>({
  id: "pi-blackhole",
  label: "pi-blackhole",
  filename: CONFIG_FILENAME,
  defaults: DEFAULTS,
  scopes: { global: true, project: true, session: true },
  sessionConfig: { entryType: "session-config-pi-blackhole" },
  tabs: [
    { id: "presets", label: "Presets" },
    { id: "settings", label: "Settings" },
  ],
  presets: [
    {
      id: "auto",
      label: "Auto (recommended)",
      description:
        "all thresholds and budgets auto-derive from your model context windows",
      values: {
        compactAfterTokens: 0,
        observeAfterTokens: 0,
        reflectAfterTokens: 0,
        observationsPoolMaxTokens: 0,
        observationsPoolTargetTokens: 0,
        reflectorInputMaxTokens: 0,
        dropperInputMaxTokens: 0,
        observerChunkMaxTokens: 0,
        thresholdScale: 1.0,
      },
    },
    {
      id: "costSaver",
      label: "Cost-saver",
      description:
        "scale auto-derived trigger thresholds by 1.5 — fewer background runs, later compaction",
      values: { thresholdScale: 1.5 },
    },
    {
      id: "balanced",
      label: "Balanced",
      description:
        "scale auto-derived trigger thresholds by 1.0 — the default posture",
      values: { thresholdScale: 1.0 },
    },
    {
      id: "responsive",
      label: "Responsive",
      description:
        "scale auto-derived trigger thresholds by 0.6 — workers trigger earlier and more often",
      values: { thresholdScale: 0.6 },
    },
  ],

  fields: (cfg) => [
    // ── Presets ──
    {
      key: "preset.how",
      type: "readonly",
      tab: "presets",
      label: "How presets work",
      value: "apply → review → Save",
      hint: "Presets fill the current scope's buffer; nothing is written until you press Save.",
    },
    {
      key: "preset.auto",
      type: "action",
      tab: "presets",
      label: "Auto (recommended)",
      description:
        "All thresholds and budgets auto-derive from your model context windows. Equivalent to clearing every threshold and budget field to 0.",
      display: "apply",
      onActivate: () => {},
    },
    {
      key: "preset.costSaver",
      type: "action",
      tab: "presets",
      label: "Cost-saver",
      description:
        "Multiplies auto-derived trigger thresholds by 1.5: fewer background observer/reflector/dropper runs and less frequent, later compaction. Custom thresholds are untouched.",
      display: "apply",
      onActivate: () => {},
    },
    {
      key: "preset.balanced",
      type: "action",
      tab: "presets",
      label: "Balanced",
      description:
        "Multiplies auto-derived trigger thresholds by 1.0: the default posture. Custom thresholds are untouched.",
      display: "apply",
      onActivate: () => {},
    },
    {
      key: "preset.responsive",
      type: "action",
      tab: "presets",
      label: "Responsive",
      description:
        "Multiplies auto-derived trigger thresholds by 0.6: workers trigger earlier and more often, memory stays fresher. Custom thresholds are untouched.",
      display: "apply",
      onActivate: () => {},
    },

    // ── Compaction ──
    {
      key: "compaction",
      type: "enum",
      tab: "settings",
      label: "Compaction mode",
      description:
        "auto=trigger on threshold, manual=only /blackhole, off=auto:Pi handles, /blackhole:blackhole pipeline",
      value: cfg.compaction,
      options: ["auto", "manual", "off"],
      optionLabels: {
        auto: "auto — trigger on threshold",
        manual: "manual — only /blackhole",
        off: "off — auto:Pi handles, /blackhole:blackhole pipeline",
      },
    },
    {
      key: "compactionEngine",
      type: "enum",
      tab: "settings",
      label: "Compaction engine",
      description:
        "blackhole=structured summary+OM, pi-default=built-in Pi summarization",
      value: cfg.compactionEngine,
      options: ["blackhole", "pi-default"],
      optionLabels: {
        blackhole: "blackhole — structured summary + OM",
        "pi-default": "pi-default — built-in Pi summarization",
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
      tab: "settings",
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
      tab: "settings",
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
      key: "compactAfterTokens",
      type: "number",
      tab: "settings",
      label: "Auto-compact threshold",
      description:
        "Real context tokens (assistant usage + chars/4 tail) that triggers auto-compaction. 0 = auto-derive 65% of the session context window (× thresholdScale), clamped ≥ 1000.",
      value: cfg.compactAfterTokens,
      min: 0,
      max: 500_000,
      step: 1_000,
      valueDescriptions: AUTO_DERIVE_NOTE("65% of session context window"),
    },

    // ── Observational Memory ──
    {
      key: "memory",
      type: "boolean",
      tab: "settings",
      label: "Observational memory",
      description:
        "Enable OM workers (observer, reflector, dropper) and content injection",
      value: cfg.memory,
      valueDescriptions: {
        on: "Active — OM workers + content injection enabled",
        off: "Suspended — OM disabled",
      },
    },
    {
      key: "sessionFallback",
      type: "boolean",
      tab: "settings",
      label: "Session model fallback",
      description:
        "off=skip stage when all OM models fail, instead of falling back to the main coding model",
      value: cfg.sessionFallback ?? true,
    },
    {
      key: "observeAfterTokens",
      type: "number",
      tab: "settings",
      label: "Observer threshold",
      description:
        "Real usage tokens since the last observer run before triggering the next observe. 0 = auto-derive 25% of the session context window (× thresholdScale), clamped ≥ 1000.",
      value: cfg.observeAfterTokens,
      min: 0,
      max: 200_000,
      step: 1_000,
      valueDescriptions: AUTO_DERIVE_NOTE("25% of session context window"),
    },
    {
      key: "reflectAfterTokens",
      type: "number",
      tab: "settings",
      label: "Reflect + dropper threshold",
      description:
        "Real usage tokens since the last reflect before triggering reflector and dropper. 0 = auto-derive 40% of the session context window (× thresholdScale), clamped ≥ 1000.",
      value: cfg.reflectAfterTokens,
      min: 0,
      max: 200_000,
      step: 1_000,
      valueDescriptions: AUTO_DERIVE_NOTE("40% of session context window"),
    },
    {
      key: "observationsPoolMaxTokens",
      type: "number",
      tab: "settings",
      label: "Observation pool max",
      description:
        "Max observation-pool tokens before the dropper prunes (fold pressure). 0 = auto-derive 15% of the session context window, clamped ≥ 1000.",
      value: cfg.observationsPoolMaxTokens,
      min: 0,
      max: 200_000,
      step: 1_000,
      valueDescriptions: AUTO_DERIVE_NOTE("15% of session context window"),
    },
    {
      key: "observationsPoolTargetTokens",
      type: "number",
      tab: "settings",
      label: "Observation pool target",
      description:
        "Target pool tokens after the dropper prunes. 0 = auto-derive half of the resolved pool max.",
      value: cfg.observationsPoolTargetTokens,
      min: 0,
      max: 200_000,
      step: 500,
      valueDescriptions: AUTO_DERIVE_NOTE("half of resolved pool max"),
    },
    {
      key: "reflectorInputMaxTokens",
      type: "number",
      tab: "settings",
      label: "Reflector input max",
      description:
        "Max prompt tokens for the reflector model input. 0 = auto-derive 60% of the reflector's context window, clamped ≥ 1000.",
      value: cfg.reflectorInputMaxTokens,
      min: 0,
      max: 500_000,
      step: 1_000,
      valueDescriptions: AUTO_DERIVE_NOTE("60% of worker context window"),
    },
    {
      key: "dropperInputMaxTokens",
      type: "number",
      tab: "settings",
      label: "Dropper input max",
      description:
        "Max prompt tokens for the dropper model input. 0 = auto-derive 60% of the dropper's context window, clamped ≥ 1000.",
      value: cfg.dropperInputMaxTokens,
      min: 0,
      max: 500_000,
      step: 1_000,
      valueDescriptions: AUTO_DERIVE_NOTE("60% of worker context window"),
    },
    {
      key: "observerChunkMaxTokens",
      type: "number",
      tab: "settings",
      label: "Observer chunk max",
      description:
        "Max source-entry tokens sent to the observer per chunk. 0 = auto-derive 20% of the observer's context window, clamped ≥ 256.",
      value: cfg.observerChunkMaxTokens,
      min: 0,
      max: 200_000,
      step: 1_000,
      valueDescriptions: AUTO_DERIVE_NOTE("20% of worker context window"),
    },
    {
      key: "observerPreambleMaxTokens",
      type: "number",
      tab: "settings",
      label: "Observer preamble max",
      description:
        "Preamble budget in manual compaction mode (0=auto-compute 30% of chunk)",
      value: cfg.observerPreambleMaxTokens,
      min: 0,
      max: 100_000,
      step: 500,
    },
    {
      key: "thresholdScale",
      type: "number",
      tab: "settings",
      label: "Auto-derive scale",
      description:
        "Multiplier for auto-derived trigger thresholds (observer/reflector/compaction). 0.6 = cost-saver, 1.0 = balanced (default), 1.5 = responsive. Ignored for explicit threshold values.",
      value: cfg.thresholdScale,
      min: 0.1,
      max: 10,
      step: 0.1,
    },
    {
      key: "dropperPressureThreshold",
      type: "number",
      tab: "settings",
      label: "Dropper pressure threshold",
      description:
        "Fraction of reflectorInputMaxTokens that triggers pressure-driven dropper (0-1, default 0.70)",
      value: cfg.dropperPressureThreshold,
      min: 0.01,
      max: 1,
      step: 0.01,
    },
    {
      key: "dropperPoolFullnessThreshold",
      type: "number",
      tab: "settings",
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
      tab: "settings",
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
      tab: "settings",
      label: "Provider idle timeout (ms)",
      description:
        "Body-idle timeout for background provider streams; 0 = disabled, unset = inherit pi's default",
      value: cfg.providerIdleTimeoutMs ?? 0,
      min: 0,
      max: 3_600_000,
      step: 1000,
    },
    {
      key: "fullFoldAlways",
      type: "boolean",
      tab: "settings",
      label: "Preserve OM on first compaction",
      description:
        "When true, early reflections/drops survive the first compaction in a fresh session",
      value: cfg.fullFoldAlways,
    },

    // ── Debug ──
    {
      key: "debug",
      type: "boolean",
      tab: "settings",
      label: "Debug snapshots",
      description:
        "Write detailed debug snapshots to /tmp/pi-blackhole-debug.json",
      value: cfg.debug,
    },
    {
      key: "debugLog",
      type: "boolean",
      tab: "settings",
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
    if (
      parsed.compaction === undefined &&
      parsed.compactionEngine === undefined
    ) {
      if (parsed.passive === true) {
        parsed.compaction = "off";
        parsed.memory = false;
      } else if (parsed.noAutoCompact === true) {
        parsed.compaction = "manual";
      }
      if (parsed.overrideDefaultCompaction === true) {
        parsed.compactionEngine = "blackhole";
        if (parsed.tailBehavior === undefined) {
          parsed.tailBehavior = "minimal";
        }
      } else if (parsed.overrideDefaultCompaction === false) {
        parsed.compactionEngine = "pi-default";
      }
      delete (parsed as Record<string, unknown>).passive;
      delete (parsed as Record<string, unknown>).noAutoCompact;
      delete (parsed as Record<string, unknown>).overrideDefaultCompaction;
    }

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
      if (!["auto", "manual", "off"].includes(trimmed)) {
        console.warn(
          `blackhole: invalid PI_BLACKHOLE_COMPACTION value "${envCompaction}"; ignoring`,
        );
      }
    }

    const envCompactionEngine = process.env.PI_BLACKHOLE_COMPACTION_ENGINE;
    if (envCompactionEngine !== undefined) {
      const trimmed = envCompactionEngine.trim().toLowerCase();
      if (!["blackhole", "pi-default"].includes(trimmed)) {
        console.warn(
          `blackhole: invalid PI_BLACKHOLE_COMPACTION_ENGINE value "${envCompactionEngine}"; ignoring`,
        );
      }
    }

    const envCompactionSummaryMode =
      process.env.PI_BLACKHOLE_COMPACTION_SUMMARY_MODE;
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

    // ── Merge with defaults ──
    const merged = { ...DEFAULTS, ...parsed } as UnifiedConfig;

    // ── Numeric field validation ──
    const REQUIRED_NUMERIC_KEYS: readonly (keyof UnifiedConfig)[] = [
      "observeAfterTokens",
      "reflectAfterTokens",
      "compactAfterTokens",
      "observationsPoolMaxTokens",
      "observationsPoolTargetTokens",
      "reflectorInputMaxTokens",
      "dropperInputMaxTokens",
      "observerChunkMaxTokens",
      "observerPreambleMaxTokens",
      "agentMaxTurns",
    ];
    for (const k of REQUIRED_NUMERIC_KEYS) {
      const v = (merged as unknown as Record<string, unknown>)[k];
      // 0 = auto-derive for all threshold/budget fields; only agentMaxTurns
      // must be > 0.
      const minVal = k === "agentMaxTurns" ? 1 : 0;
      if (typeof v !== "number" || !Number.isFinite(v) || v < minVal) {
        (merged as unknown as Record<string, unknown>)[k] = DEFAULTS[k];
      }
    }

    // thresholdScale — finite > 0, clamped to [0.1, 10]
    const ts = merged.thresholdScale;
    if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) {
      merged.thresholdScale = DEFAULTS.thresholdScale;
    } else {
      merged.thresholdScale = Math.min(10, Math.max(0.1, ts));
    }

    // dropperPressureThreshold — must be in (0, 1]
    const dpt = merged.dropperPressureThreshold;
    if (
      typeof dpt !== "number" ||
      !Number.isFinite(dpt) ||
      dpt <= 0 ||
      dpt > 1
    ) {
      merged.dropperPressureThreshold = DEFAULTS.dropperPressureThreshold;
    }

    // dropperPoolFullnessThreshold — must be in (0, 1]
    const dpf = merged.dropperPoolFullnessThreshold;
    if (
      typeof dpf !== "number" ||
      !Number.isFinite(dpf) ||
      dpf <= 0 ||
      dpf > 1
    ) {
      merged.dropperPoolFullnessThreshold =
        DEFAULTS.dropperPoolFullnessThreshold;
    }

    // observationsPoolTargetTokens — must be < max
    if (
      merged.observationsPoolTargetTokens === undefined ||
      merged.observationsPoolTargetTokens >= merged.observationsPoolMaxTokens
    ) {
      merged.observationsPoolTargetTokens = Math.floor(
        merged.observationsPoolMaxTokens / 2,
      );
    }

    return merged;
  },

  env: DECLARATIVE_ENV_OVERRIDES,
});

// ── Public entry point ───────────────────────────────────────────────────────

export async function openBlackholeSettings(
  ctx: ExtensionContext,
): Promise<void> {
  await config.openSettings(
    ctx,
    ctx.cwd,
    (_updated) => {
      // Caller (pi-vcc.ts) reloads runtime.config after save.
    },
    GLOBAL_CONFIG_DIR,
  );
}
