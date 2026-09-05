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
}

/**
 * Resolve the effective auto-compaction threshold.
 *
 * Precedence (issue #60):
 *  1. Explicit `compactAfterTokens` (always wins when set)
 *  2. `compactAfterRatio` → max(1, floor(window × ratio))
 *  3. `compactReserveTokens` → max(1, window − reserve)
 *  4. Fixed legacy default (81000) when no knob is set
 *
 * The two derived knobs are only ever set in derived mode — the loader drops
 * the fixed default when either is configured without explicit tokens — so
 * passing a config straight from loadUnifiedConfig yields the same result as
 * this function's own fallback.
 */
export function compactThresholdTokens(cfg: CompactThresholdConfig, contextWindow: number): number {
  if (cfg.compactAfterTokens !== undefined) return cfg.compactAfterTokens;
  if (cfg.compactAfterRatio !== undefined) {
    return Math.max(1, Math.floor(contextWindow * cfg.compactAfterRatio));
  }
  if (cfg.compactReserveTokens !== undefined) {
    return Math.max(1, contextWindow - cfg.compactReserveTokens);
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
