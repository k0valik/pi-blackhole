/**
 * Truthful stage-due measurement (plan-03).
 *
 * One measurement core (real usage + chars/4 trailing estimate), one
 * threshold resolver, one due function per stage.  Progress measures the
 * usage delta since the stage's anchor; thresholds auto-derive from the
 * session context window (or honor explicit config values verbatim).
 * Every worker trigger is capped by its worker context window minus the
 * agent-loop reserve and stage overhead (D7).
 */
import type { UnifiedConfig } from "../core/unified-config.js";
import { debugLog } from "./debug-log.js";
import {
  type CountBasis,
  entryIndexForId,
  findLastCompactionIndex,
  latestCoverageIndex,
  measureSinceAnchor,
  rawTokensAfterIndex,
  realContextTokens,
} from "./ledger/index.js";
import {
  OM_OBSERVATIONS_DROPPED,
  OM_OBSERVATIONS_RECORDED,
  OM_REFLECTIONS_RECORDED,
  type Entry,
  type V3MemoryCustomType,
} from "./ledger/types.js";
import {
  resolveSessionContextWindow,
  resolveWorkerWindow,
} from "./model-budget.js";
import type { Runtime } from "./runtime.js";

/** Fixed overhead for system prompt, tool definitions, and turn scaffold in
 *  context window pre-check (moved from consolidation.ts so due.ts can apply
 *  the worker-window upper bound without importing the pipeline). */
export const AGENT_LOOP_RESERVE = 8_000;

/** Additional stage overhead (serialization, preamble, tool definitions)
 *  reserved above AGENT_LOOP_RESERVE when bounding worker triggers (D7). */
export const STAGE_OVERHEAD = 4_000;

export const OBSERVE_THRESHOLD_RATIO = 0.25;
export const REFLECT_THRESHOLD_RATIO = 0.4;
export const COMPACT_THRESHOLD_RATIO = 0.65;
export const DERIVED_THRESHOLD_MIN_TOKENS = 1_000;

/** Synchronously-available session-window sources (mirrors what the
 *  compaction trigger and stage runners can resolve without awaiting). */
export type DueContext = {
  model?: { contextWindow?: number } | undefined;
  getContextUsage?: () => { contextWindow?: number } | undefined;
};

export type StageMeasurement = {
  due: boolean;
  /** Measured progress (usage delta since anchor, or chars/4 estimate). */
  progress: number;
  /** Effective threshold the stage was compared against (already bounded). */
  threshold: number;
  basis: CountBasis;
  /** Anchor entry index the progress was measured from. */
  anchorIndex: number;
  /** True when the worker-window upper bound capped the resolved threshold. */
  upperBoundApplied: boolean;
};

function deriveThreshold(
  sessionWindow: number,
  ratio: number,
  scale: number,
): number {
  return Math.max(
    Math.floor(sessionWindow * ratio * scale),
    DERIVED_THRESHOLD_MIN_TOKENS,
  );
}

/** Resolve trigger thresholds: explicit config values are honored verbatim;
 *  0 derives floor(sessionWindow × ratio × thresholdScale). */
export function resolveTriggerThresholds(
  config: UnifiedConfig,
  sessionWindow: number,
): {
  observeAfterTokens: number;
  reflectAfterTokens: number;
  compactAfterTokens: number;
} {
  const scale = config.thresholdScale ?? 1.0;
  return {
    observeAfterTokens:
      config.observeAfterTokens > 0
        ? config.observeAfterTokens
        : deriveThreshold(sessionWindow, OBSERVE_THRESHOLD_RATIO, scale),
    reflectAfterTokens:
      config.reflectAfterTokens > 0
        ? config.reflectAfterTokens
        : deriveThreshold(sessionWindow, REFLECT_THRESHOLD_RATIO, scale),
    compactAfterTokens:
      config.compactAfterTokens > 0
        ? config.compactAfterTokens
        : deriveThreshold(sessionWindow, COMPACT_THRESHOLD_RATIO, scale),
  };
}

/** Compaction threshold only (auto-derive = 65% of the session window). */
export function resolveCompactThreshold(
  config: UnifiedConfig,
  sessionWindow: number,
): number {
  return resolveTriggerThresholds(config, sessionWindow).compactAfterTokens;
}

/** Progress for a session with no anchor and no compaction yet: the real
 *  context usage (whole branch) is the truthful "tokens since session
 *  start"; fall back to the chars/4 estimate when unmeasurable. */
function measureFreshSession(entries: Entry[]): {
  tokens: number;
  basis: CountBasis;
} {
  const real = realContextTokens(entries);
  if (real !== undefined) return { tokens: real, basis: "usage" };
  return { tokens: rawTokensAfterIndex(entries, -1), basis: "estimate" };
}

function measureStage(
  entries: Entry[],
  stage: "observer" | "reflector" | "dropper",
  anchorIndex: number,
  threshold: number,
  workerWindow: number,
): StageMeasurement {
  const { tokens, basis } =
    anchorIndex < 0 && findLastCompactionIndex(entries) === -1
      ? measureFreshSession(entries)
      : measureSinceAnchor(entries, anchorIndex);

  // Worker-window upper bound (D7): never run a worker when its own
  // context window can't fit the progress + agent-loop overhead.
  const upperBound = workerWindow - AGENT_LOOP_RESERVE - STAGE_OVERHEAD;
  const effectiveThreshold = Math.min(threshold, upperBound);
  const upperBoundApplied = effectiveThreshold < threshold;
  const due = tokens >= effectiveThreshold;
  if (upperBoundApplied && due) {
    debugLog(`${stage}.upper_bound`, {
      progress: tokens,
      threshold,
      upperBound,
      workerWindow,
    });
  }
  return {
    due,
    progress: tokens,
    threshold: effectiveThreshold,
    basis,
    anchorIndex,
    upperBoundApplied,
  };
}

function resolveAnchor(
  entries: Entry[],
  runtime: Runtime,
  stage: "observer" | "reflector" | "dropper",
  coverageType: V3MemoryCustomType,
  compactionFallback: boolean,
): number {
  const cursor = runtime.getCursor(stage);
  if (cursor) {
    const idx = entryIndexForId(entries, cursor.entryId);
    if (idx >= 0) return idx;
  }
  const coverageIdx = latestCoverageIndex(entries, coverageType);
  if (coverageIdx >= 0) return coverageIdx;
  return compactionFallback ? findLastCompactionIndex(entries) : -1;
}

function sessionWindowFor(dueCtx: DueContext): number {
  return resolveSessionContextWindow(dueCtx.model, dueCtx.getContextUsage);
}

/** Observer: cursor → observations-recorded coverage → latest compaction
 *  (cold start) → −1. */
export function measureObserverDue(
  entries: Entry[],
  runtime: Runtime,
  dueCtx: DueContext,
): StageMeasurement {
  const sessionWindow = sessionWindowFor(dueCtx);
  const threshold = resolveTriggerThresholds(
    runtime.config,
    sessionWindow,
  ).observeAfterTokens;
  const workerWindow = resolveWorkerWindow(
    runtime.config.observerModel,
    sessionWindow,
  );
  const anchorIndex = resolveAnchor(
    entries,
    runtime,
    "observer",
    OM_OBSERVATIONS_RECORDED,
    true,
  );
  return measureStage(
    entries,
    "observer",
    anchorIndex,
    threshold,
    workerWindow,
  );
}

/** Measure options: manual-mode stages pass an explicit anchor index
 *  (pending-batch coversUpToId) instead of cursor/coverage resolution. */
export type MeasureOptions = {
  anchorIndex?: number;
};

/** Reflector tokens leg: cursor → reflections-recorded coverage → −1.
 *  (New-data marker/pending legs stay in the pipeline.) Manual mode passes
 *  the pending batch anchor explicitly. */
export function measureReflectorDue(
  entries: Entry[],
  runtime: Runtime,
  dueCtx: DueContext,
  options: MeasureOptions = {},
): StageMeasurement {
  const sessionWindow = sessionWindowFor(dueCtx);
  const threshold = resolveTriggerThresholds(
    runtime.config,
    sessionWindow,
  ).reflectAfterTokens;
  const workerWindow = resolveWorkerWindow(
    runtime.config.reflectorModel,
    sessionWindow,
  );
  const anchorIndex =
    options.anchorIndex !== undefined
      ? options.anchorIndex
      : resolveAnchor(
          entries,
          runtime,
          "reflector",
          OM_REFLECTIONS_RECORDED,
          false,
        );
  return measureStage(
    entries,
    "reflector",
    anchorIndex,
    threshold,
    workerWindow,
  );
}

/** Dropper tokens leg: cursor → observations-dropped coverage → −1.
 *  (Pool fullness/pressure and new-data legs stay in the pipeline.) Manual
 *  mode passes the pending batch anchor explicitly. */
export function measureDropperDue(
  entries: Entry[],
  runtime: Runtime,
  dueCtx: DueContext,
  options: MeasureOptions = {},
): StageMeasurement {
  const sessionWindow = sessionWindowFor(dueCtx);
  const threshold = resolveTriggerThresholds(
    runtime.config,
    sessionWindow,
  ).reflectAfterTokens;
  const workerWindow = resolveWorkerWindow(
    runtime.config.dropperModel,
    sessionWindow,
  );
  const anchorIndex =
    options.anchorIndex !== undefined
      ? options.anchorIndex
      : resolveAnchor(
          entries,
          runtime,
          "dropper",
          OM_OBSERVATIONS_DROPPED,
          false,
        );
  return measureStage(entries, "dropper", anchorIndex, threshold, workerWindow);
}
