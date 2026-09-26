/**
 * Dependency-free validity predicates shared by the config loader
 * (`unified-config.ts`), the settings-modal `validate`, the trigger resolver
 * (`model-budget.ts`), and the on-disk migration (`config-migration/steps.ts`).
 *
 * This module imports nothing (not even from the rest of `src/core`), so the
 * migration can reuse the loader's exact rules without creating an import
 * cycle. If a rule changes here, every reader changes together — the loader and
 * the migration can never disagree about whether a value is valid.
 */

/**
 * Legacy scaffold default (pre-curve): the settings modal used to materialize
 * `compactAfterTokens: 81000` even for users who never chose it. It reads as
 * "the old default" and yields to the preset curve / derived knobs. An env-set
 * 81000 stays explicit.
 */
export const LEGACY_SCAFFOLD_COMPACT_AFTER_TOKENS = 81_000;

/** Positive integer — a fixed token threshold or headroom reserve. */
export function isFixedTokenThreshold(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/** Threshold percentage of the context window, in (0, 100]. */
export function isWindowPercent(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 100;
}

/**
 * Convert a pre-plan *fraction* to a percent. Used by the migration, where a
 * value in `(0, 1]` is unambiguously the old fraction form (`1` = 100%).
 * Clamped to at least 1 so the result is never re-scaled.
 */
export function legacyFractionToPercent(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return v;
  return v <= 1 ? Math.max(1, Math.round(v * 100)) : v;
}

/**
 * Seatbelt normalizer for a window-percent value that reached the resolver or
 * the loader un-migrated. A value **below** 1 is the pre-plan fraction range
 * (0.65 = 65%) and is scaled; `1` itself stays 1% (the migration is what turns
 * a bare legacy `1` into 100% — see `legacyFractionToPercent`). Clamped to at
 * least 1 so the transform is idempotent (a fraction below 0.01 becomes 1%,
 * never a re-scalable sub-1 value).
 */
export function windowPercent(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return v;
  return v < 1 ? Math.max(1, Math.round(v * 100)) : v;
}

export function isReserveTokens(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/** Shape selector for the auto-compaction threshold (plan-09 §3.2). */
export const COMPACT_AFTER_BY_VALUES = ["preset", "percent", "tokens", "reserve"] as const;
export type CompactAfterBy = (typeof COMPACT_AFTER_BY_VALUES)[number];
export function isCompactAfterBy(v: unknown): v is CompactAfterBy {
  return typeof v === "string" && (COMPACT_AFTER_BY_VALUES as readonly string[]).includes(v);
}

/** A unit fraction, e.g. a dropper fullness/pressure threshold: (0, 1]. */
export function isUnitFraction(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1;
}

/** The legacy "not set" sentinel for numeric knobs. */
export function isUnsetZero(v: unknown): boolean {
  return v === 0;
}

/** The single `compaction` enum (plan-09 §3.1). `auto` is the legacy alias. */
export const COMPACTION_VALUES = ["automatic", "manual", "off"] as const;
export const LEGACY_COMPACTION_VALUES = ["auto"] as const;
export function isCompactionValue(v: unknown): v is "automatic" | "manual" | "off" {
  return typeof v === "string" && (COMPACTION_VALUES as readonly string[]).includes(v);
}
/** True for any compaction value the loader accepts, including the legacy `auto`. */
export function isAnyCompactionValue(v: unknown): boolean {
  return isCompactionValue(v) || v === "auto";
}
