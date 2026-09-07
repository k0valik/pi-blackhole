import type { Model } from "@earendil-works/pi-ai";
import type { OmModelConfig } from "../core/unified-config.js";
import { DEFAULTS } from "../core/unified-config.js";

/** Fixed-token auto-compaction default when no threshold knob is configured. */
export const DEFAULT_COMPACT_AFTER_TOKENS: number =
  // SAFETY: the fixed default is always present in DEFAULTS (81000); the
  // interface field is optional only because derived mode deletes it.
  DEFAULTS.compactAfterTokens as number;

export const AGENT_LOOP_MAX_TOKENS = 32_000;

export interface CompactThresholdConfig {
  compactAfterTokens?: number;
  compactAfterRatio?: number;
  compactReserveTokens?: number;
  /** Selection knob: name of the preset curve to apply (built-in or user-defined). */
  compactAfterPreset?: string;
  /** User-editable preset definitions (hand-edited JSON only — never a modal/DEFAULTS key). */
  compactAfterPresets?: Record<string, PresetAnchor[]>;
}

/** One anchor of a threshold curve: at `window`, compact at `ratio` of the window. */
export interface PresetAnchor {
  window: number;
  ratio: number;
}

/**
 * Built-in preset definitions. Effective presets = these overlaid by any user
 * `compactAfterPresets` entries in the config file (same-name override, new
 * names appended). Curve data is user-tunable (spec §7).
 */
export const BUILTIN_PRESETS: Record<string, PresetAnchor[]> = {
  default: [
    { window: 32_768, ratio: 0.9 },
    { window: 131_072, ratio: 0.8 },
    { window: 262_144, ratio: 0.7 },
    { window: 1_048_576, ratio: 0.4 },
  ],
};

/** Built-ins overlaid by the user's file definitions (spec §4.2). */
export function effectivePresets(
  cfg: Pick<CompactThresholdConfig, "compactAfterPresets">,
): Record<string, PresetAnchor[]> {
  return { ...BUILTIN_PRESETS, ...(cfg.compactAfterPresets ?? {}) };
}

/**
 * Ratio of `window` at which to compact under `anchors`: piecewise-linear
 * interpolation in window space, constant extrapolation outside the anchor
 * range. Anchors must be non-empty and sorted ascending by `window` (parse
 * guarantees this; literal callers keep them sorted). A single anchor yields a
 * constant ratio — a global-ratio preset.
 */
export function presetRatioForWindow(anchors: PresetAnchor[], window: number): number {
  if (anchors.length === 0) return 0.5; // unreachable via validated config; keep pure + finite
  if (window <= anchors[0].window) return anchors[0].ratio;
  const last = anchors[anchors.length - 1];
  if (window >= last.window) return last.ratio;
  for (let i = 0; i < anchors.length - 1; i++) {
    const a0 = anchors[i];
    const a1 = anchors[i + 1];
    if (window < a0.window || window > a1.window) continue;
    const span = a1.window - a0.window;
    if (span <= 0) return a1.ratio; // defensive: duplicate windows
    const t = (window - a0.window) / span;
    return a0.ratio + t * (a1.ratio - a0.ratio);
  }
  return last.ratio;
}

/**
 * Resolve the effective auto-compaction threshold.
 *
 * Precedence:
 *  1. Explicit `compactAfterTokens` (always wins when set)
 *  2. `compactAfterRatio` → max(1, floor(window × ratio))
 *  3. `compactReserveTokens` → max(1, window − reserve)
 *  4. Named preset curve (knob `compactAfterPreset`, defaulting to "default")
 *     → max(1, floor(window × ratio₍window₎)) over the effective anchors
 *  5. Fixed legacy default (81000) when no knob and no preset surface is set
 *     (removed in the config-surface flip — the built-in "default" curve then
 *     becomes the no-knob behavior)
 *
 * Numeric knobs are only ever set without the injected fixed default in derived
 * mode — the loader drops the fixed default when a derived knob or preset is
 * configured without explicit tokens — so a config straight from
 * loadUnifiedConfig resolves the same way as this function's own fallback.
 *
 * Always returns a positive integer ≥ 1 — never undefined (an undefined
 * threshold would invert the trigger gate and compact on every event).
 */
export function compactThresholdTokens(cfg: CompactThresholdConfig, contextWindow: number): number {
  if (cfg.compactAfterTokens !== undefined) return cfg.compactAfterTokens;
  if (cfg.compactAfterRatio !== undefined) {
    return Math.max(1, Math.floor(contextWindow * cfg.compactAfterRatio));
  }
  if (cfg.compactReserveTokens !== undefined) {
    return Math.max(1, contextWindow - cfg.compactReserveTokens);
  }
  if (cfg.compactAfterPreset !== undefined || cfg.compactAfterPresets !== undefined) {
    const name = cfg.compactAfterPreset ?? "default";
    const anchors = effectivePresets(cfg)[name] ?? BUILTIN_PRESETS.default;
    return Math.max(1, Math.floor(contextWindow * presetRatioForWindow(anchors, contextWindow)));
  }
  return DEFAULT_COMPACT_AFTER_TOKENS;
}

/**
 * Per-model context-window override slots on UnifiedConfig that may carry an
 * OmModelConfig.contextWindow value (base session model + OM stage models and
 * their fallbacks).
 */
export interface SessionWindowConfig {
  model?: OmModelConfig;
  observerModel?: OmModelConfig;
  reflectorModel?: OmModelConfig;
  dropperModel?: OmModelConfig;
  observerFallbackModels?: readonly OmModelConfig[];
  reflectorFallbackModels?: readonly OmModelConfig[];
  dropperFallbackModels?: readonly OmModelConfig[];
}

/** Collect every configured model slot that could carry a contextWindow override. */
function contextWindowOverrides(config: SessionWindowConfig): OmModelConfig[] {
  const out: OmModelConfig[] = [];
  const push = (m: OmModelConfig | undefined): void => {
    if (m) out.push(m);
  };
  push(config.model);
  push(config.observerModel);
  push(config.reflectorModel);
  push(config.dropperModel);
  for (const list of [
    config.observerFallbackModels,
    config.reflectorFallbackModels,
    config.dropperFallbackModels,
  ]) {
    if (list) {
      for (const m of list) push(m);
    }
  }
  return out;
}

/**
 * Effective context window for the session model: honors a per-model config
 * override (matched by provider + id across the configured model slots)
 * before the model registry value, then the 128k fallback.
 */
export function sessionContextWindow(
  model: Model<any> | undefined,
  config: SessionWindowConfig,
): number {
  if (model && typeof model.provider === "string" && typeof model.id === "string") {
    const override = contextWindowOverrides(config).find(
      (m) => m.provider === model.provider && m.id === model.id,
    );
    if (override) return effectiveContextWindow(model, override);
  }
  return effectiveContextWindow(model, undefined);
}

/**
 * Effective auto-compaction threshold for a session model: resolve the model's
 * window first, then derive the threshold from it. Evaluated per check, so a
 * mid-session `/model` switch is picked up on the next evaluation.
 */
export function autoCompactThreshold(
  cfg: CompactThresholdConfig & SessionWindowConfig,
  model: Model<any> | undefined,
): number {
  return compactThresholdTokens(cfg, sessionContextWindow(model, cfg));
}

export function boundedMaxTokens(
  model: Model<any>,
  requested: number = AGENT_LOOP_MAX_TOKENS,
): number {
  return typeof model.maxTokens === "number" && model.maxTokens > 0
    ? Math.min(model.maxTokens, requested)
    : requested;
}

/**
 * Get the effective context window for a resolved model.
 *
 * Resolution order:
 * 1. Config override on the model config (OmModelConfig.contextWindow)
 * 2. Pi's model registry value (model.contextWindow)
 * 3. Fallback default (128000)
 */
export function effectiveContextWindow(
  resolvedModel: Model<any> | undefined,
  modelConfig?: OmModelConfig,
): number {
  if (modelConfig?.contextWindow !== undefined && modelConfig.contextWindow > 0) {
    return modelConfig.contextWindow;
  }
  if (
    resolvedModel &&
    typeof resolvedModel.contextWindow === "number" &&
    resolvedModel.contextWindow > 0
  ) {
    return resolvedModel.contextWindow;
  }
  return 128_000;
}
