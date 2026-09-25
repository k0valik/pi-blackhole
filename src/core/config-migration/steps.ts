/**
 * Config-file migration steps (plan-10).
 *
 * Pure, per-file transforms over the raw JSON object:
 *  - only keys listed in a step's `consumes` are read or (eventually) deleted;
 *  - unknown keys are never touched;
 *  - a step that finds an unrecognized consumed value returns `error`, which
 *    aborts the whole file (plan-10 §3: "never project when anything is
 *    unrecognized").
 *
 * Steps never delete consumed keys themselves — the two-phase runner does that
 * only after the projected values are verified on disk (plan-10 §3–§4).
 */

/** Current on-disk config schema version, stamped on the first migration. */
export const CONFIG_VERSION = 1;

/** Pre-curve scaffold residue: never a deliberate pin. Dropped on migration. */
const LEGACY_SCAFFOLD_COMPACT_AFTER_TOKENS = 81_000;

export interface MigrationResult {
  /** True when the step wrote or changed a produced value. */
  changed: boolean;
  /** Present when a consumed value cannot be projected; aborts the file. */
  error?: string;
  /** Consumed keys that are dead and should be removed (phase 2). */
  delete?: string[];
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

// ── Validators (local copy so this module imports nothing → no cycles) ──────

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/** Old `compactAfterRatio` was a fraction in (0, 1]. */
function isOldFraction(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1;
}

/** Unit fraction, e.g. a dropper threshold. */
function isUnitFraction(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1;
}

export function isCompactAfterBy(v: unknown): boolean {
  return v === "preset" || v === "percent" || v === "tokens" || v === "reserve";
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
    const engine = raw.compactionEngine;
    const compaction = raw.compaction;
    if (engine !== undefined && engine !== "blackhole" && engine !== "pi-default") {
      return { changed: false, error: "unrecognized compactionEngine value" };
    }
    if (
      compaction !== undefined &&
      !["auto", "automatic", "manual", "off"].includes(compaction as string)
    ) {
      return { changed: false, error: "unrecognized compaction value" };
    }
    const folded = foldCompaction(compaction, engine);
    const deleteEngine = engine !== undefined ? ["compactionEngine"] : [];
    if (folded === undefined || folded === compaction) {
      return { changed: false, delete: deleteEngine };
    }
    raw.compaction = folded;
    return { changed: true, delete: deleteEngine };
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
    for (const k of ["passive", "noAutoCompact", "overrideDefaultCompaction"] as const) {
      if (raw[k] !== undefined && typeof raw[k] !== "boolean") {
        return { changed: false, error: `unrecognized ${k} value` };
      }
    }
    let changed = false;
    if (raw.compaction === undefined) {
      if (raw.passive === true) {
        raw.compaction = "off";
        raw.memory = false;
        changed = true;
      } else if (raw.noAutoCompact === true) {
        raw.compaction = "manual";
        changed = true;
      }
      if (raw.overrideDefaultCompaction === true) {
        if (raw.compaction === undefined) {
          raw.compaction = "automatic";
          changed = true;
        }
        if (raw.tailBehavior === undefined) {
          raw.tailBehavior = "minimal";
          changed = true;
        }
      } else if (raw.overrideDefaultCompaction === false) {
        if (raw.compaction === undefined) {
          raw.compaction = "off";
          changed = true;
        }
      }
    }
    return {
      changed,
      delete: ["passive", "noAutoCompact", "overrideDefaultCompaction"],
    };
  },
};

/**
 * Make the threshold shape explicit and convert the old ratio fraction to a
 * percent. `compactAfterBy` is set by the old precedence (tokens > percent >
 * reserve); the value keys themselves stay (they are the shape's value).
 */
const thresholdArray: ConfigMigration = {
  id: "threshold-array",
  consumes: ["compactAfterTokens", "compactAfterRatio", "compactReserveTokens"],
  produces: ["compactAfterBy", "compactAfterRatio", "compactAfterTokens", "compactReserveTokens"],
  message: "auto-compaction threshold shape recorded (compactAfterBy); ratio converted to percent",
  apply(raw) {
    // Idempotence: a file that already has the selector is done.
    if (isCompactAfterBy(raw.compactAfterBy)) return { changed: false };

    const tokens = raw.compactAfterTokens;
    const ratio = raw.compactAfterRatio;
    const reserve = raw.compactReserveTokens;
    if (tokens !== undefined && !isPositiveInt(tokens)) {
      return { changed: false, error: "unrecognized compactAfterTokens value" };
    }
    if (ratio !== undefined && !isOldFraction(ratio)) {
      return { changed: false, error: "unrecognized compactAfterRatio value" };
    }
    if (reserve !== undefined && !isPositiveInt(reserve)) {
      return { changed: false, error: "unrecognized compactReserveTokens value" };
    }

    // A literal 81000 was scaffold residue, never a real pin.
    const tokenPin =
      isPositiveInt(tokens) && tokens !== LEGACY_SCAFFOLD_COMPACT_AFTER_TOKENS ? tokens : undefined;

    let changed = false;
    const drop: string[] = [];
    // Convert any present old fraction, even when it is not the winning shape,
    // so a later switch to the percent shape is not misread.
    if (isOldFraction(ratio)) {
      raw.compactAfterRatio = Math.round(ratio * 100);
      changed = true;
    }
    // A literal 81000 was scaffold residue, never a real pin — drop it.
    if (isPositiveInt(tokens) && tokens === LEGACY_SCAFFOLD_COMPACT_AFTER_TOKENS) {
      drop.push("compactAfterTokens");
    }
    let shape: "tokens" | "percent" | "reserve" | undefined;
    if (tokenPin !== undefined) shape = "tokens";
    else if (isOldFraction(ratio)) shape = "percent";
    else if (isPositiveInt(reserve)) shape = "reserve";
    if (shape !== undefined && raw.compactAfterBy !== shape) {
      raw.compactAfterBy = shape;
      changed = true;
    }
    return { changed, delete: drop };
  },
};

/**
 * Merge the two dropper fractions into one knob. `dropperPressureThreshold`
 * survives; the new-data floor becomes the constant 0.10 (plan-09 §3.3), so
 * the survivor is `max(oldPressure, oldFullness)`.
 */
const dropperFractionMerge: ConfigMigration = {
  id: "dropper-fraction-merge",
  consumes: ["dropperPoolFullnessThreshold", "dropperPressureThreshold"],
  produces: ["dropperPressureThreshold"],
  message: "dropperPoolFullnessThreshold was merged into dropperPressureThreshold",
  apply(raw) {
    const fullness = raw.dropperPoolFullnessThreshold;
    if (fullness === undefined) return { changed: false };
    if (!isUnitFraction(fullness)) {
      return { changed: false, error: "unrecognized dropperPoolFullnessThreshold value" };
    }
    const pressure = raw.dropperPressureThreshold;
    if (pressure !== undefined && !isUnitFraction(pressure)) {
      return { changed: false, error: "unrecognized dropperPressureThreshold value" };
    }
    raw.dropperPressureThreshold = Math.max(isUnitFraction(pressure) ? pressure : 0.7, fullness);
    return { changed: true, delete: ["dropperPoolFullnessThreshold"] };
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
    const dropper = raw.dropperInputMaxTokens;
    if (dropper === undefined) return { changed: false };
    if (!isPositiveInt(dropper)) {
      return { changed: false, error: "unrecognized dropperInputMaxTokens value" };
    }
    const reflector = raw.reflectorInputMaxTokens;
    if (reflector !== undefined && !isPositiveInt(reflector)) {
      return { changed: false, error: "unrecognized reflectorInputMaxTokens value" };
    }
    // Only fill the survivor when it is unset; an explicit reflector value wins.
    let changed = false;
    if (reflector === undefined) {
      raw.reflectorInputMaxTokens = dropper;
      changed = true;
    }
    return { changed, delete: ["dropperInputMaxTokens"] };
  },
};

/** Dead/derived knobs with no runtime reader — delete them. */
const deadKnobs: ConfigMigration = {
  id: "dead-knobs",
  consumes: ["observationsPoolTargetTokens", "observerPreambleMaxTokens"],
  produces: [],
  message: "dead config knobs were removed",
  apply() {
    return {
      changed: false,
      delete: ["observationsPoolTargetTokens", "observerPreambleMaxTokens"],
    };
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
  /** Present when a consumed value was unrecognized; nothing may be written. */
  error?: string;
}

/**
 * Apply every step to a clone. Never deletes: the runner deletes
 * `consumedToDelete` only after the projected values are verified on disk.
 */
export function projectConfig(raw: Record<string, unknown>): ProjectionResult {
  const config = structuredClone(raw) as Record<string, unknown>;
  const applied: string[] = [];
  const messages: string[] = [];
  const consumedToDelete = new Set<string>();
  let valueChanged = false;
  let consumedPresent = false;

  for (const step of STEPS) {
    const owns = step.consumes.filter((k) => k in config);
    if (owns.length === 0) continue;
    consumedPresent = true;
    const res = step.apply(config);
    if (res.error) {
      return {
        config,
        valueChanged: false,
        consumedPresent,
        applied,
        messages,
        consumedToDelete: [],
        error: res.error,
      };
    }
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
  };
}

/**
 * In-memory migration used by the runtime loader: apply the projection and
 * delete the consumed keys. Pure and safe to call on every load (idempotent).
 * On `error`, returns the original config untouched.
 */
export function applyConfigMigrations(raw: Record<string, unknown>): {
  config: Record<string, unknown>;
  changed: boolean;
} {
  const proj = projectConfig(raw);
  if (proj.error) return { config: raw, changed: false };
  const needsRewrite = proj.valueChanged || proj.consumedToDelete.length > 0;
  if (!needsRewrite) return { config: raw, changed: false };
  const config = structuredClone(proj.config);
  for (const k of proj.consumedToDelete) delete config[k];
  return { config, changed: true };
}
