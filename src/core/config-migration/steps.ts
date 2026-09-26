/**
 * Config-file migration steps (plan-10, hardened in plan-11).
 *
 * Pure, per-file transforms over the raw JSON object:
 *  - only keys listed in a step's `consumes` are read or (eventually) deleted;
 *  - unknown keys are never touched;
 *  - a value that is the documented `0` "not set" sentinel is treated as
 *    absent, never as invalid;
 *  - an unrecognized value is *skipped*, not fatal: the step leaves that key
 *    untouched and returns a `warning`, so one bad value cannot silently revert
 *    the rest of the file (plan-11 §2.3).
 *
 * Steps never delete consumed keys themselves — the two-phase runner does that
 * only after the projected values are verified on disk (plan-10 §3–§4).
 *
 * Validity predicates come from `config-validators.ts`, the same module the
 * loader and resolver use, so the migration can never be stricter or looser
 * than the runtime for the same key.
 */

import {
  isCompactAfterBy,
  isCompactionValue,
  isFixedTokenThreshold,
  isReserveTokens,
  isUnitFraction,
  isUnsetZero,
  isWindowPercent,
  LEGACY_SCAFFOLD_COMPACT_AFTER_TOKENS,
  legacyFractionToPercent,
  windowPercent,
} from "../config-validators.js";

/** Current on-disk config schema version, stamped on the first clean migration. */
export const CONFIG_VERSION = 1;

export interface MigrationWarning {
  /** The owned key whose value was not recognized. */
  key: string;
  value: unknown;
  reason: string;
}

export interface MigrationResult {
  /** True when the step wrote or changed a produced value. */
  changed: boolean;
  /** Consumed keys that are safe to remove (phase 2). */
  delete?: string[];
  /** Present when a consumed value cannot be projected — that key is skipped. */
  warning?: MigrationWarning;
}

export interface ConfigMigration {
  /** Stable id — logs and applied-step accounting. */
  id: string;
  /** Legacy keys this step owns. Nothing outside this list is read or deleted. */
  consumes: readonly string[];
  /** New keys this step is responsible for producing (the phase-1 targets). */
  produces: readonly string[];
  /**
   * Transform a clone of the raw config in place. Reads only `consumes`,
   * writes only `produces`. Never deletes a consumed key.
   */
  apply(raw: Record<string, unknown>): MigrationResult;
  /** One-line note describing what changed; surfaced once when the step runs. */
  message?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Collect one warning per unrecognized value, keeping the step total. */
class Skipped {
  readonly warnings: MigrationWarning[] = [];
  warn(key: string, value: unknown, reason: string): void {
    this.warnings.push({ key, value, reason });
  }
  get warning(): MigrationWarning | undefined {
    return this.warnings[0];
  }
}

/**
 * Treat a `0` value as the documented "not set" sentinel: leave it out of the
 * projection and mark the key for removal. Returns true when `value` was 0.
 */
function dropIfZero(value: unknown, key: string, del: string[]): boolean {
  if (isUnsetZero(value)) {
    del.push(key);
    return true;
  }
  return false;
}

/**
 * Fold the legacy two-key compaction surface into the single `compaction`
 * enum. Shared with the runtime loader (parseConfig) so the in-memory and
 * on-disk paths cannot disagree.
 */
export function foldCompaction(
  compaction: unknown,
  engine: unknown,
): "automatic" | "manual" | "off" | undefined {
  const engineIsPiDefault = engine === "pi-default";
  if (compaction === "off") return "off";
  if (compaction === "manual") return "manual";
  if (compaction === "automatic" || compaction === "auto") {
    return engineIsPiDefault ? "off" : "automatic";
  }
  // No (recognized) compaction value — the engine alone decides.
  if (engineIsPiDefault) return "off";
  if (engine === "blackhole") return "automatic";
  return undefined;
}

// ── Steps ───────────────────────────────────────────────────────────────────

/**
 * `compactionEngine` no longer exists. Fold it (and the legacy `auto` value)
 * into `compaction`: `auto` → `automatic`, and `pi-default` → `off` (the two
 * had identical behavior, plan-09 §3.1).
 */
const compactionEngineFold: ConfigMigration = {
  id: "compaction-engine-fold",
  consumes: ["compactionEngine", "compaction"],
  produces: ["compaction"],
  message: "compactionEngine was folded into compaction",
  apply(raw) {
    const warning = new Skipped();
    const del: string[] = [];

    const engine = raw.compactionEngine;
    const engineValid = engine === undefined || engine === "blackhole" || engine === "pi-default";
    if (!engineValid) {
      warning.warn("compactionEngine", engine, "unrecognized compactionEngine value");
    }

    const compaction = raw.compaction;
    const compactionValid =
      compaction === undefined || isCompactionValue(compaction) || compaction === "auto";
    if (!compactionValid) {
      warning.warn("compaction", compaction, "unrecognized compaction value");
    }

    // Only recognized values participate in the fold.
    const folded = foldCompaction(
      compactionValid ? compaction : undefined,
      engineValid ? engine : undefined,
    );
    if (engineValid && engine !== undefined) del.push("compactionEngine");

    if (folded === undefined || folded === compaction) {
      return { changed: false, delete: del, warning: warning.warning };
    }
    raw.compaction = folded;
    return { changed: true, delete: del, warning: warning.warning };
  },
};

/**
 * Pre-#14 legacy keys → the unified surface: `passive` → off + memory off,
 * `noAutoCompact` → manual, `overrideDefaultCompaction` → the engine fold plus
 * the aggressive tail cut. Only fills `compaction` when the new key is absent.
 */
const legacyModes: ConfigMigration = {
  id: "legacy-modes",
  consumes: ["passive", "noAutoCompact", "overrideDefaultCompaction"],
  produces: ["compaction", "memory", "tailBehavior"],
  message: "legacy compaction keys were folded into compaction",
  apply(raw) {
    const warning = new Skipped();
    const del: string[] = [];
    const keys = ["passive", "noAutoCompact", "overrideDefaultCompaction"] as const;
    const valid: Record<(typeof keys)[number], boolean> = {
      passive: true,
      noAutoCompact: true,
      overrideDefaultCompaction: true,
    };
    for (const k of keys) {
      const v = raw[k];
      if (v === undefined) continue;
      if (typeof v !== "boolean") {
        valid[k] = false;
        warning.warn(k, v, `unrecognized ${k} value`);
        continue;
      }
      del.push(k);
    }

    let changed = false;
    if (raw.compaction === undefined) {
      if (valid.passive && raw.passive === true) {
        raw.compaction = "off";
        raw.memory = false;
        changed = true;
      } else if (valid.noAutoCompact && raw.noAutoCompact === true) {
        raw.compaction = "manual";
        changed = true;
      }
      if (valid.overrideDefaultCompaction && raw.overrideDefaultCompaction === true) {
        if (raw.compaction === undefined) {
          raw.compaction = "automatic";
          changed = true;
        }
        if (raw.tailBehavior === undefined) {
          raw.tailBehavior = "minimal";
          changed = true;
        }
      } else if (valid.overrideDefaultCompaction && raw.overrideDefaultCompaction === false) {
        if (raw.compaction === undefined) {
          raw.compaction = "off";
          changed = true;
        }
      }
    }
    return { changed, delete: del, warning: warning.warning };
  },
};

/**
 * Make the threshold shape explicit and convert the old ratio fraction to a
 * percent. `compactAfterBy` is set by the old precedence (tokens > percent >
 * reserve) only when it is not already a valid selector; the ratio conversion
 * runs either way, so a fraction that reached the file alongside a selector is
 * still repaired.
 */
const thresholdArray: ConfigMigration = {
  id: "threshold-array",
  consumes: ["compactAfterTokens", "compactAfterRatio", "compactReserveTokens"],
  produces: ["compactAfterBy", "compactAfterRatio", "compactAfterTokens", "compactReserveTokens"],
  message: "auto-compaction threshold shape recorded (compactAfterBy); ratio converted to percent",
  apply(raw) {
    const warning = new Skipped();
    const del: string[] = [];
    const selector = isCompactAfterBy(raw.compactAfterBy) ? raw.compactAfterBy : undefined;

    // tokens: 0 = unset, 81000 = scaffold residue, positive int = a real pin.
    const rawTokens = raw.compactAfterTokens;
    let tokenPin: number | undefined;
    if (rawTokens !== undefined) {
      if (dropIfZero(rawTokens, "compactAfterTokens", del)) {
        // unset
      } else if (!isFixedTokenThreshold(rawTokens)) {
        warning.warn("compactAfterTokens", rawTokens, "unrecognized compactAfterTokens value");
      } else if (rawTokens === LEGACY_SCAFFOLD_COMPACT_AFTER_TOKENS) {
        del.push("compactAfterTokens");
      } else {
        tokenPin = rawTokens;
      }
    }

    // ratio: 0 = unset, (0, 100] with a selector / (0, 1] fraction without one.
    const rawRatio = raw.compactAfterRatio;
    let ratioValid = false;
    let converted = false;
    if (rawRatio !== undefined) {
      if (dropIfZero(rawRatio, "compactAfterRatio", del)) {
        // unset
      } else if (!isWindowPercent(rawRatio)) {
        warning.warn("compactAfterRatio", rawRatio, "unrecognized compactAfterRatio value");
      } else {
        ratioValid = true;
        // With no selector the ratio is the un-migrated legacy form, where a
        // bare `1` means 100%; with a selector it is already a percent, and a
        // value below 1 is a fraction that escaped repair.
        const normalized =
          selector === undefined ? legacyFractionToPercent(rawRatio) : windowPercent(rawRatio);
        if (normalized !== rawRatio) {
          raw.compactAfterRatio = normalized;
          converted = true;
        }
      }
    }

    // reserve: 0 = unset, positive int = headroom.
    const rawReserve = raw.compactReserveTokens;
    let reserveValid = false;
    if (rawReserve !== undefined) {
      if (dropIfZero(rawReserve, "compactReserveTokens", del)) {
        // unset
      } else if (!isReserveTokens(rawReserve)) {
        warning.warn("compactReserveTokens", rawReserve, "unrecognized compactReserveTokens value");
      } else {
        reserveValid = true;
      }
    }

    let changed = converted;

    let shape: "tokens" | "percent" | "reserve" | undefined;
    if (tokenPin !== undefined) shape = "tokens";
    else if (ratioValid) shape = "percent";
    else if (reserveValid) shape = "reserve";

    if (selector === undefined && shape !== undefined) {
      raw.compactAfterBy = shape;
      changed = true;
    }
    return { changed, delete: del, warning: warning.warning };
  },
};

/**
 * Merge the two dropper fractions into one knob. `dropperPressureThreshold`
 * survives; the new-data floor is derived from it at runtime (plan-11 §4), so
 * the survivor is `max(oldPressure, oldFullness)`.
 */
const dropperFractionMerge: ConfigMigration = {
  id: "dropper-fraction-merge",
  consumes: ["dropperPoolFullnessThreshold", "dropperPressureThreshold"],
  produces: ["dropperPressureThreshold"],
  message: "dropperPoolFullnessThreshold was merged into dropperPressureThreshold",
  apply(raw) {
    const warning = new Skipped();
    const del: string[] = [];
    const fullness = raw.dropperPoolFullnessThreshold;
    if (fullness === undefined) return { changed: false };
    if (dropIfZero(fullness, "dropperPoolFullnessThreshold", del)) {
      return { changed: false, delete: del };
    }
    if (!isUnitFraction(fullness)) {
      warning.warn(
        "dropperPoolFullnessThreshold",
        fullness,
        "unrecognized dropperPoolFullnessThreshold value",
      );
      return { changed: false, delete: del, warning: warning.warning };
    }
    const pressure = raw.dropperPressureThreshold;
    if (pressure !== undefined && !isUnsetZero(pressure) && !isUnitFraction(pressure)) {
      // Cannot safely merge onto an unrecognized pressure — leave both keys.
      warning.warn(
        "dropperPressureThreshold",
        pressure,
        "unrecognized dropperPressureThreshold value",
      );
      return { changed: false, delete: del, warning: warning.warning };
    }
    const base = typeof pressure === "number" && pressure > 0 ? pressure : 0.7;
    raw.dropperPressureThreshold = Math.max(base, fullness);
    del.push("dropperPoolFullnessThreshold");
    return { changed: true, delete: del, warning: warning.warning };
  },
};

/**
 * Merge the reflector and dropper memory-read budgets. `reflectorInputMaxTokens`
 * survives (UI: "Memory read per job"); the dropper key is dropped.
 */
const inputBudgetMerge: ConfigMigration = {
  id: "input-budget-merge",
  consumes: ["dropperInputMaxTokens", "reflectorInputMaxTokens"],
  produces: ["reflectorInputMaxTokens"],
  message: "dropperInputMaxTokens was merged into reflectorInputMaxTokens",
  apply(raw) {
    const warning = new Skipped();
    const del: string[] = [];
    const dropper = raw.dropperInputMaxTokens;
    if (dropper === undefined) return { changed: false };
    if (dropIfZero(dropper, "dropperInputMaxTokens", del)) {
      return { changed: false, delete: del };
    }
    if (!isFixedTokenThreshold(dropper)) {
      warning.warn("dropperInputMaxTokens", dropper, "unrecognized dropperInputMaxTokens value");
      return { changed: false, delete: del, warning: warning.warning };
    }
    const reflector = raw.reflectorInputMaxTokens;
    let changed = false;
    if (reflector === undefined || isUnsetZero(reflector)) {
      raw.reflectorInputMaxTokens = dropper;
      changed = true;
    } else if (!isFixedTokenThreshold(reflector)) {
      warning.warn(
        "reflectorInputMaxTokens",
        reflector,
        "unrecognized reflectorInputMaxTokens value",
      );
      return { changed: false, delete: del, warning: warning.warning };
    }
    del.push("dropperInputMaxTokens");
    return { changed, delete: del, warning: warning.warning };
  },
};

/** Dead/derived knobs with no runtime reader — delete them. */
const deadKnobs: ConfigMigration = {
  id: "dead-knobs",
  consumes: ["observationsPoolTargetTokens", "observerPreambleMaxTokens"],
  produces: [],
  message: "dead config knobs were removed",
  apply(raw) {
    const del: string[] = [];
    for (const k of ["observationsPoolTargetTokens", "observerPreambleMaxTokens"]) {
      if (raw[k] !== undefined) del.push(k);
    }
    return { changed: false, delete: del };
  },
};

/** Ordered steps. Order matters: the engine fold must precede legacy modes. */
export const STEPS: readonly ConfigMigration[] = [
  compactionEngineFold,
  legacyModes,
  thresholdArray,
  dropperFractionMerge,
  inputBudgetMerge,
  deadKnobs,
];

export interface ProjectionResult {
  /** Migrated config (new keys written; consumed keys still present). */
  config: Record<string, unknown>;
  /** True when any step changed a produced value. */
  valueChanged: boolean;
  /** True when at least one owned legacy key is present. */
  consumedPresent: boolean;
  /** Ids of steps that changed something. */
  applied: string[];
  messages: string[];
  /** Keys safe to delete in phase 2 (consumed but not produced). */
  consumedToDelete: string[];
  /** Unrecognized values that were skipped; their keys are left in place. */
  warnings: MigrationWarning[];
}

/**
 * Apply every step to a clone. Never deletes: the runner deletes
 * `consumedToDelete` only after the projected values are verified on disk.
 * Never aborts: an unrecognized value is skipped and reported.
 */
export function projectConfig(raw: Record<string, unknown>): ProjectionResult {
  const config = structuredClone(raw) as Record<string, unknown>;
  const applied: string[] = [];
  const messages: string[] = [];
  const warnings: MigrationWarning[] = [];
  const consumedToDelete = new Set<string>();
  let valueChanged = false;
  let consumedPresent = false;

  for (const step of STEPS) {
    const owns = step.consumes.filter((k) => k in config);
    if (owns.length === 0) continue;
    consumedPresent = true;
    const res = step.apply(config);
    if (res.warning) warnings.push(res.warning);
    if (res.changed) {
      valueChanged = true;
      applied.push(step.id);
      if (step.message) messages.push(step.message);
    }
    if (res.delete) {
      for (const k of res.delete) consumedToDelete.add(k);
    }
  }

  return {
    config,
    valueChanged,
    consumedPresent,
    applied,
    messages,
    consumedToDelete: [...consumedToDelete],
    warnings,
  };
}

/**
 * In-memory migration used by the runtime loader: apply the projection and
 * delete the safe consumed keys. Pure and safe to call on every load
 * (idempotent). Unrecognized values are skipped and reported via `warnings`.
 */
export function applyConfigMigrations(raw: Record<string, unknown>): {
  config: Record<string, unknown>;
  changed: boolean;
  warnings: MigrationWarning[];
} {
  const proj = projectConfig(raw);
  const needsRewrite = proj.valueChanged || proj.consumedToDelete.length > 0;
  if (!needsRewrite) return { config: raw, changed: false, warnings: proj.warnings };
  const config = structuredClone(proj.config);
  for (const k of proj.consumedToDelete) delete config[k];
  return { config, changed: true, warnings: proj.warnings };
}
