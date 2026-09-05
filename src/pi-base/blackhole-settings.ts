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
import { openChangelogView } from "../changelog/changelog.js";
import type { Field } from "./settings/types.js";

const CONFIG_FILENAME = "pi-blackhole-config.json";

export const GLOBAL_CONFIG_DIR = join(getPiAgentDir(), "pi-blackhole");

// SAFETY: the fixed token default (81000) is always present in DEFAULTS — the
// interface field is optional only because derived mode (ratio/reserve) deletes
// it from the merged config.
const DEFAULT_COMPACT_AFTER_TOKENS = DEFAULTS.compactAfterTokens as number;

/**
 * Context-window-derived threshold fields (issue #60). Returned as a separate
 * list so they only appear in the modal once configured — they have no fixed
 * default, and an unset numeric field would otherwise render as "undefined".
 * Configure them via the config file or PI_BLACKHOLE_* env vars.
 */
function derivedThresholdFields(cfg: {
  compactAfterRatio?: number;
  compactReserveTokens?: number;
}): Field[] {
  const fields: Field[] = [];
  if (cfg.compactAfterRatio !== undefined) {
    fields.push({
      key: "compactAfterRatio",
      type: "number",
      label: "Auto-compact ratio (of context window)",
      description:
        "Compact when the session reaches this fraction of the active model's context window (e.g. 0.65 on a 200k model fires at ~130k). Overrides the fixed threshold; explicit tokens win over it.",
      value: cfg.compactAfterRatio,
      min: 0.05,
      max: 1,
      step: 0.05,
    });
  }
  if (cfg.compactReserveTokens !== undefined) {
    fields.push({
      key: "compactReserveTokens",
      type: "number",
      label: "Auto-compact headroom reserve",
      description:
        "Alternative derivation: compact when only this many tokens of headroom remain (threshold = window − reserve). Explicit tokens win over it; ratio wins when both are set.",
      value: cfg.compactReserveTokens,
      min: 1_000,
      max: 2_000_000,
      step: 1_000,
    });
  }
  return fields;
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
    {
      key: "compaction",
      type: "enum",
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
      label: "Compaction engine",
      description: "blackhole=structured summary+OM, pi-default=built-in Pi summarization",
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
      key: "compactAfterTokens",
      type: "number",
      label: "Auto-compact threshold (tokens)",
      description:
        "Explicit fixed token threshold. When set to a non-default value it overrides the context-window knobs below; at its default it is treated as unset so a ratio/reserve can govern.",
      value: cfg.compactAfterTokens ?? DEFAULT_COMPACT_AFTER_TOKENS,
      min: 1_000,
      max: 500_000,
      step: 1_000,
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
    // Context-window-derived knobs only show once configured (no fixed
    // default; unset would render "undefined"). Add them in the config file
    // or via PI_BLACKHOLE_* env vars — see docs/CONFIG.md.
    ...derivedThresholdFields(cfg),

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
      description: "Max tokens in observation pool before dropper prunes (fold pressure)",
      value: cfg.observationsPoolMaxTokens,
      min: 1_000,
      max: 200_000,
      step: 1_000,
    },
    {
      key: "observationsPoolTargetTokens",
      type: "number",
      label: "Observation pool target",
      description: "Target tokens after dropper prunes (defaults to half of pool max)",
      value: cfg.observationsPoolTargetTokens,
      min: 500,
      max: 200_000,
      step: 500,
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
      key: "observerPreambleMaxTokens",
      type: "number",
      label: "Observer preamble max",
      description: "Preamble budget in manual compaction mode (0=auto-compute 30% of chunk)",
      value: cfg.observerPreambleMaxTokens,
      min: 0,
      max: 100_000,
      step: 500,
    },
    {
      key: "dropperPressureThreshold",
      type: "number",
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
      key: "fullFoldAlways",
      type: "boolean",
      label: "Preserve OM on first compaction",
      description:
        "When true, early reflections/drops survive the first compaction in a fresh session",
      value: cfg.fullFoldAlways,
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
    if (parsed.compaction === undefined && parsed.compactionEngine === undefined) {
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

    // ── Merge with defaults ──
    const merged = { ...DEFAULTS, ...parsed } as UnifiedConfig;

    // ── Numeric field validation ──
    const REQUIRED_NUMERIC_KEYS: readonly (keyof UnifiedConfig)[] = [
      "observeAfterTokens",
      "reflectAfterTokens",
      "compactAfterTokens",
      "retainedToolOutputMaxTokens",
      "observationsPoolMaxTokens",
      "observationsPoolTargetTokens",
      "reflectorInputMaxTokens",
      "dropperInputMaxTokens",
      "observerChunkMaxTokens",
      "observerPreambleMaxTokens",
      "agentMaxTurns",
    ];
    for (const k of REQUIRED_NUMERIC_KEYS) {
      // SAFETY: merged is a plain config object; indexing by dynamic key needs
      // the Record view to read/write numeric fields uniformly.
      const v = (merged as unknown as Record<string, unknown>)[k];
      const minVal = k === "observerPreambleMaxTokens" ? 0 : 1;
      if (
        typeof v !== "number" ||
        !Number.isFinite(v) ||
        (k === "retainedToolOutputMaxTokens" && !Number.isInteger(v)) ||
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

    // observationsPoolTargetTokens — must be < max
    if (
      merged.observationsPoolTargetTokens === undefined ||
      merged.observationsPoolTargetTokens >= merged.observationsPoolMaxTokens
    ) {
      merged.observationsPoolTargetTokens = Math.floor(merged.observationsPoolMaxTokens / 2);
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
