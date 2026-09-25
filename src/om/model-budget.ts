import type { Model } from "@earendil-works/pi-ai";
import {
  isFixedTokenThreshold,
  isReserveTokens,
  isWindowPercent,
  type OmModelConfig,
} from "../core/unified-config.js";

export const AGENT_LOOP_MAX_TOKENS = 32_000;

export interface CompactThresholdConfig {
  /** Shape selector (plan-09 §3.2). Unset preserves the legacy precedence. */
  compactAfterBy?: "preset" | "percent" | "tokens" | "reserve";
  compactAfterTokens?: number;
  /** Percent of the context window, in (0, 100]. */
  compactAfterRatio?: number;
  compactReserveTokens?: number;
  /** Floor: never compact below this many tokens. */
  compactAfterMinTokens?: number;
  /** Ceiling: never wait past this many tokens. */
  compactAfterMaxTokens?: number;
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
  return { ...BUILTIN_PRESETS, ...cfg.compactAfterPresets };
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

/** Names already warned about (unknown preset fallback) — warn once per process. */
const warnedPresetNames = new Set<string>();

/** Threshold from the selected preset curve (with unknown-name fallback + warn). */
function presetThreshold(cfg: CompactThresholdConfig, contextWindow: number): number {
  const name = cfg.compactAfterPreset ?? "default";
  const anchors = effectivePresets(cfg)[name];
  if (anchors === undefined) {
    if (!warnedPresetNames.has(name)) {
      warnedPresetNames.add(name);
      console.warn(
        `blackhole: unknown compaction preset "${name}" — falling back to the built-in "default" curve`,
      );
    }
    return Math.max(
      1,
      Math.floor(contextWindow * presetRatioForWindow(BUILTIN_PRESETS.default, contextWindow)),
    );
  }
  return Math.max(1, Math.floor(contextWindow * presetRatioForWindow(anchors, contextWindow)));
}

/**
 * Resolve the shape's own threshold — before the floor/ceiling band is applied.
 *
 * When `compactAfterBy` is set, only that shape is consulted; if its value is
 * invalid/absent it falls through to the legacy precedence (tokens > percent >
 * reserve > preset), which is also what an unset selector uses. That keeps
 * pre-plan in-memory configs (and read-only installs that were never rewritten
 * on disk) behaving exactly as before.
 */
function shapeThreshold(cfg: CompactThresholdConfig, contextWindow: number): number {
  const shape = cfg.compactAfterBy;
  if (shape === "tokens") {
    if (isFixedTokenThreshold(cfg.compactAfterTokens)) return cfg.compactAfterTokens;
  } else if (shape === "percent") {
    if (isWindowPercent(cfg.compactAfterRatio)) {
      return Math.max(1, Math.floor((contextWindow * cfg.compactAfterRatio) / 100));
    }
  } else if (shape === "reserve") {
    if (isReserveTokens(cfg.compactReserveTokens)) {
      return Math.max(1, contextWindow - cfg.compactReserveTokens);
    }
  } else if (shape === "preset") {
    return presetThreshold(cfg, contextWindow);
  }
  // Unset selector, or an explicit shape whose value is missing: legacy
  // precedence (each tier applies only when its value is valid).
  if (isFixedTokenThreshold(cfg.compactAfterTokens)) return cfg.compactAfterTokens;
  if (isWindowPercent(cfg.compactAfterRatio)) {
    return Math.max(1, Math.floor((contextWindow * cfg.compactAfterRatio) / 100));
  }
  if (isReserveTokens(cfg.compactReserveTokens)) {
    return Math.max(1, contextWindow - cfg.compactReserveTokens);
  }
  return presetThreshold(cfg, contextWindow);
}

/**
 * Resolve the effective auto-compaction threshold.
 *
 * `effective = max(1, compactAfterMinTokens, min(shape(window), compactAfterMaxTokens))`
 *
 * The shape is chosen by `compactAfterBy` (preset | percent | tokens |
 * reserve); when unset, the legacy precedence applies (tokens > percent >
 * reserve > preset). Both band bounds are optional and orthogonal to the
 * shape: the floor protects against a model downgrade when a percent shape is
 * pinned, the ceiling pins an absolute operating point on a huge window.
 *
 * Always returns a positive integer ≥ 1 — never undefined (an undefined
 * threshold would invert the trigger gate and compact on every event).
 */
export function compactThresholdTokens(cfg: CompactThresholdConfig, contextWindow: number): number {
  const base = shapeThreshold(cfg, contextWindow);
  const min = isFixedTokenThreshold(cfg.compactAfterMinTokens) ? cfg.compactAfterMinTokens : 0;
  const max = isFixedTokenThreshold(cfg.compactAfterMaxTokens)
    ? cfg.compactAfterMaxTokens
    : Number.POSITIVE_INFINITY;
  return Math.max(1, min, Math.min(base, max));
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
