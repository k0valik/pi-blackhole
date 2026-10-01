/**
 * Consolidation pipeline — observer → reflector → dropper with fallback retry.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (src/hooks/consolidation-trigger.ts)
 * Modified by pi-vcc-om:
 * - Each stage retries through fallback models when any error occurs.
 * - All errors record cooldown (so the failed model is skipped next iteration).
 * - 30s retry gate prevents repeated failed runs (isConsolidationRetryGated).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesSkippedProvider } from "../core/provider-skip.js";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ConfiguredModel } from "./config.js";
import { debugLog, withDebugLogContext } from "./debug-log.js";
import { type ResolveResult, type Runtime, type RuntimeGeneration } from "./runtime.js";
import { withProviderAttributionHeaders } from "./provider-stream.js";
import { runWorkerAttempt, WorkerAttemptTimeoutError } from "./worker-attempt.js";
import {
  getDiscardedCount,
  isCooldownWorthyError,
  isDeterministicError,
  isRetryableError,
  isStaleExtensionContextError,
  WorkerStreamError,
  workerStreamErrorMessage,
  type ConsolidationWorker,
} from "./retryable-error.js";
import { effectiveContextWindow } from "./model-budget.js";
import { maxDropCountForPool, selectDropCandidates } from "./agents/dropper/selection.js";
import {
  WORKER_SAFETY_MARGIN_TOKENS,
  WORKER_TURN_HEADROOM_TOKENS,
  workerOutputReserveTokens,
  workerStaticPromptTokens,
} from "./prompt-budget.js";
import { estimateEntryTokens, estimateStringTokens } from "./tokens.js";
import { serializeSourceAddressedBranchEntries } from "./serialize.js";
import { OBSERVER_SYSTEM } from "./agents/observer/prompts.js";

import {
  readPendingState,
  savePendingObservation,
  savePendingReflection,
  savePendingDropped,
  isObservationChunkPending,
  PendingOMState,
} from "./pending.js";
import { isManualMode } from "../core/unified-config.js";
import {
  OM_OBSERVATIONS_DROPPED,
  OM_OBSERVATIONS_RECORDED,
  OM_REFLECTIONS_RECORDED,
  buildExistingObservationsSummary,
  buildExistingReflectionsSummary,
  buildObservationsDroppedData,
  buildObservationsRecordedData,
  buildReflectionsRecordedData,
  earlierCoverageMarkerId,
  entryIndexForId,
  foldLedger,
  findLastCompactionIndex,
  fullProjection,
  isSourceEntry,
  latestCoverageIndex,
  latestCoverageMarkerId,
  livePoolObservations,
  observationsCreatedAfterIndex,
  observationPoolTokens,
  observationToSummaryLine,
  rawTokensAfterIndex,
  rawTokensSinceDropCoverage,
  rawTokensSinceObservationCoverage,
  rawTokensSinceReflectionCoverage,
  reflectionToSummaryLine,
  reflectionsCreatedAfterIndex,
  selectPriorObservations,
  selectPriorReflections,
  type Entry,
  type Observation,
  type Reflection,
} from "./ledger/index.js";

export type ResolvedModel = Extract<ResolveResult, { ok: true }>;

export type ConsolidationCtx = {
  cwd: string;
  hasUI: boolean;
  ui?: {
    notify: (message: string, type?: "warning" | "info" | "error") => void;
  };
  model: unknown;
  modelRegistry: any;
  sessionManager: { getBranch: () => unknown; getSessionId: () => string };
};

type StageOutcome = "continue" | "abort";

type ReflectorStageResult = {
  outcome: StageOutcome;
  sameRunReflections: Reflection[];
  effectiveReflectionCoverageId?: string;
};

// Max attempts per stage (primary + all fallbacks the runtime will try internally).
// Each call to resolveModel tries all non-cooldown candidates.  If the agent throws
// a retryable error, we record cooldown and call resolveModel again (up to this many times).
const MAX_STAGE_ATTEMPTS = 10;

/**
 * How many drain batches one observer pipeline run may add after its initial
 * batch. The backlog beyond this bound waits for the next cycle with the
 * cursor at the last delivered entry — a delay, never a loss (F1 of
 * work_docs/plan-observer-coverage-completion.md).
 */
export const OBSERVER_DRAIN_MAX_BATCHES = 3;

function sourceEntriesAfter(entries: Entry[], index: number): Entry[] {
  return entries.slice(index + 1).filter(isSourceEntry);
}

/**
 * Cap source entries to maxTokens by keeping the OLDEST contiguous prefix,
 * walking forward until the token budget is exceeded.
 * Reuses estimateEntryTokens (the same estimator rawTokensAfterIndex uses for
 * the trigger) so the cap and the trigger never drift apart (#110).
 *
 * The prefix direction is a correctness requirement, not a preference: the
 * stage's coversUpToId is the last kept entry, so a suffix cap (newest first)
 * would let coverage claim the branch tip while the older entries it skipped
 * were never sent to the model — and never observed again. With a prefix,
 * everything from the cursor up to coversUpToId has been delivered, and the
 * rest stays in the backlog for the drain batches.
 */
export function capSourceEntriesToTokens(entries: Entry[], maxTokens: number): Entry[] {
  let totalTokens = 0;
  const kept: Entry[] = [];
  for (const entry of entries) {
    const estTokens = estimateEntryTokens(entry);
    if (totalTokens + estTokens > maxTokens) {
      // Prefix walk stops as soon as the budget is exceeded — except for the
      // first entry itself: a single oversized first entry is still included
      // (kept.length === 0) so a model that can fit it still makes progress.
      if (kept.length > 0) break;
      kept.push(entry);
      break;
    }
    kept.push(entry);
    totalTokens += estTokens;
  }
  return kept;
}

function appendEntry(
  pi: ExtensionAPI,
  runtime: Runtime,
  generation: RuntimeGeneration,
  customType: string,
  data: unknown,
): boolean {
  if (!runtime.isGenerationActive(generation)) return false;
  pi.appendEntry(customType, data);
  return true;
}

function mergeReflections(existing: Reflection[], additional: Reflection[]): Reflection[] {
  const seen = new Set(existing.map((reflection) => reflection.id));
  const merged = [...existing];
  for (const reflection of additional) {
    if (seen.has(reflection.id)) continue;
    seen.add(reflection.id);
    merged.push(reflection);
  }
  return merged;
}

/**
 * Extract all pending observations from accumulated batches that were recorded
 * after a given coverage ID (e.g., the last reflection or drop coverage ID).
 * This is needed in manual mode (pending-based) because the reflector/dropper may skip
 * a pipeline cycle, leaving unprocessed batches in observationBatches that
 * should still be served as "new" on subsequent runs.
 */
function pendingObservationsCreatedAfter(
  pending: PendingOMState,
  entries: Entry[],
  afterCoversUpToId: string | undefined,
): Observation[] {
  const batches = pending.observationBatches ?? [];
  if (!afterCoversUpToId || entryIndexForId(entries, afterCoversUpToId) < 0) {
    return batches.flatMap((b: any) => (b.data as any)?.observations ?? []);
  }
  const afterIdx = entryIndexForId(entries, afterCoversUpToId);
  const newObs: Observation[] = [];
  for (const batch of batches) {
    const batchIdx = entryIndexForId(entries, batch.coversUpToId);
    if (batchIdx >= 0 && batchIdx > afterIdx) {
      newObs.push(...((batch.data as any)?.observations ?? []));
    }
  }
  return newObs;
}

/**
 * Pressure gate for the dropper: the pool is full enough that it should be
 * pruned even though no new observation or reflection data has arrived.
 *
 * The basis is `observationsPoolMaxTokens` — the same maximum the footer
 * P gauge and `/blackhole-memory` divide by — not `reflectorInputMaxTokens`,
 * which only sizes reflector/dropper prompts. Both configured fractions have to
 * clear, so the effective trigger is
 * `max(dropperPressureThreshold, dropperPoolFullnessThreshold) × pool max`.
 * A threshold of `1.0` (the documented "off" value), or a non-positive pool
 * max, disables pressure entirely; the ordinary new-data trigger is
 * unaffected.
 */
function dropperPressureReached(config: Runtime["config"], poolTokens: number): boolean {
  const poolMax = config.observationsPoolMaxTokens;
  if (poolMax <= 0 || config.dropperPressureThreshold >= 1) return false;
  return (
    poolTokens / poolMax >= (config.dropperPoolFullnessThreshold ?? 0.1) &&
    poolTokens >= config.dropperPressureThreshold * poolMax
  );
}

/**
 * Identity of the live pool: its observation ids, sorted so the key does not
 * depend on branch order or on where an observation came from. Ids are assigned
 * once at write time and never rewritten, so the id set changing is the only
 * way the pool's contents can change — which is exactly what the pressure
 * retry guard needs to notice.
 */
function activePoolSignature(entries: Entry[], pending?: PendingOMState): string {
  const observationIds = livePoolObservations(entries, pending)
    .map((observation) => observation.id)
    .sort();
  return JSON.stringify(observationIds);
}

/**
 * True when this exact pool has already been pressure-pruned and came back
 * empty: `runDropperStage` binds the signature to the `"empty"` dropper cursor
 * precisely so repeated due-checks cannot re-issue the same model call against
 * a pool the dropper just declined to touch. Any pool change — a new
 * observation, or a drop from a cadence run — yields a different signature and
 * re-arms pressure.
 */
function matchesEmptyPressurePool(runtime: Runtime, poolSignature: string): boolean {
  const cursor = runtime.cursors?.dropper;
  return cursor?.state === "empty" && cursor.activePoolSignature === poolSignature;
}

/** Cursor-aware stage-due check.  Uses cursors when available; falls back to
 *  legacy coverage markers when cursors are absent (cold start, fork recovery).
 *
 *  In compaction: "manual" mode, the branch has no OM markers — observations
 *  live in the per‑session pending file.  `pending` provides the pool fullness
 *  and new‑data visibility that the reflector/dropper checks need. */
export function anyStageDue(entries: Entry[], runtime: Runtime, pending?: PendingOMState): boolean {
  const config = runtime.config;
  const cursors = runtime.cursors ?? {};

  // ── Observer ──────────────────────────────────────────────────────────
  const observerDue = (() => {
    const cursor = cursors.observer;
    if (!cursor) {
      return rawTokensSinceObservationCoverage(entries) >= config.observeAfterTokens;
    }
    const idx = entryIndexForId(entries, cursor.entryId);
    const tokensSince =
      idx >= 0 ? rawTokensAfterIndex(entries, idx) : rawTokensSinceObservationCoverage(entries);
    return tokensSince >= config.observeAfterTokens;
  })();

  // ── Reflector ─────────────────────────────────────────────────────────
  const reflectorDue = (() => {
    const cursor = cursors.reflector;
    if (!cursor) {
      return rawTokensSinceReflectionCoverage(entries) >= config.reflectAfterTokens;
    }
    const idx = entryIndexForId(entries, cursor.entryId);
    if (idx < 0) {
      return rawTokensSinceReflectionCoverage(entries) >= config.reflectAfterTokens;
    }
    // Must have enough accumulated tokens before considering reflector
    const tokensSince = rawTokensAfterIndex(entries, idx);
    if (tokensSince < config.reflectAfterTokens) {
      return false;
    }
    // Check for new observation batches after the cursor
    for (let i = idx + 1; i < entries.length; i++) {
      const e = entries[i];
      if (e.type === "custom" && e.customType === OM_OBSERVATIONS_RECORDED) {
        // Skip if this marker's coversUpToId is at or before the cursor
        // — data it covers was already processed.
        const markerCoversUpTo: string | undefined = (e as any).data?.coversUpToId;
        if (markerCoversUpTo) {
          const markerCoversIdx = entryIndexForId(entries, markerCoversUpTo);
          if (markerCoversIdx >= 0 && markerCoversIdx <= idx) continue;
        }
        return true;
      }
    }
    // In manual mode, also check pending observation batches that arrived
    // after the cursor (since branch has no OM markers).
    if (pending) {
      const pendingBatches = pending.observationBatches ?? [];
      for (const batch of pendingBatches) {
        if (batch.coversUpToId) {
          const batchIdx = entryIndexForId(entries, batch.coversUpToId);
          if (batchIdx >= 0 && batchIdx > idx) return true;
        }
      }
    }
    return false;
  })();

  // ── Dropper ───────────────────────────────────────────────────────────
  // Short‑circuit: only compute dropperDue when observer and reflector are
  // both not due — if either is due, the pipeline launches anyway.
  const dropperDue =
    observerDue || reflectorDue
      ? false
      : (() => {
          // Live active pool, plus pending observation batches in manual mode.
          const poolTokens = observationPoolTokens(entries, pending).tokens;
          const fullnessVsPool =
            config.observationsPoolMaxTokens > 0
              ? poolTokens / config.observationsPoolMaxTokens
              : 0;

          // Must have at least dropperPoolFullnessThreshold fullness to consider dropper
          if (fullnessVsPool < (config.dropperPoolFullnessThreshold ?? 0.1)) return false;

          // Pressure check: pool ≥ max(pressure, fullness) fraction of
          // observationsPoolMaxTokens — and not for a pool the dropper has
          // already evaluated and left untouched.
          if (
            dropperPressureReached(config, poolTokens) &&
            !matchesEmptyPressurePool(runtime, activePoolSignature(entries, pending))
          )
            return true;

          // New data check: new obs or ref batches after dropper cursor
          const cursor = cursors.dropper;
          if (!cursor) {
            // In manual mode, pending batches are the only source of new‑data
            // visibility (branch has no OM markers).
            const hasPendingNewData = pending
              ? (pending.observationBatches?.length ?? 0) > 0 ||
                (pending.reflectionBatches?.length ?? 0) > 0
              : false;
            if (hasPendingNewData) return true;
            return rawTokensSinceDropCoverage(entries) >= config.reflectAfterTokens;
          }
          const idx = entryIndexForId(entries, cursor.entryId);
          if (idx < 0) {
            return rawTokensSinceDropCoverage(entries) >= config.reflectAfterTokens;
          }
          // Must have enough accumulated tokens before considering dropper
          const tokensSince = rawTokensAfterIndex(entries, idx);
          if (tokensSince < config.reflectAfterTokens) {
            return false;
          }
          for (let i = idx + 1; i < entries.length; i++) {
            const e = entries[i];
            if (
              e.type === "custom" &&
              (e.customType === OM_OBSERVATIONS_RECORDED ||
                e.customType === OM_REFLECTIONS_RECORDED)
            ) {
              const markerCoversUpTo: string | undefined = (e as any).data?.coversUpToId;
              if (markerCoversUpTo) {
                const markerCoversIdx = entryIndexForId(entries, markerCoversUpTo);
                if (markerCoversIdx >= 0 && markerCoversIdx <= idx) continue;
              }
              return true;
            }
          }
          // In manual mode, also check pending batches after the cursor
          if (pending) {
            const pendingObs = pending.observationBatches ?? [];
            const pendingRef = pending.reflectionBatches ?? [];
            for (const batch of [...pendingObs, ...pendingRef]) {
              if (batch.coversUpToId) {
                const batchIdx = entryIndexForId(entries, batch.coversUpToId);
                if (batchIdx >= 0 && batchIdx > idx) return true;
              }
            }
          }
          return false;
        })();

  return observerDue || reflectorDue || dropperDue;
}

function stageModelConfig(
  runtime: Runtime,
  stage: "observer" | "reflector" | "dropper",
): ConfiguredModel | undefined {
  if (stage === "observer") return runtime.config.observerModel;
  if (stage === "reflector") return runtime.config.reflectorModel;
  return runtime.config.dropperModel;
}

function stageFallbackModels(
  runtime: Runtime,
  stage: "observer" | "reflector" | "dropper",
): ConfiguredModel[] {
  if (stage === "observer") return runtime.config.observerFallbackModels ?? [];
  if (stage === "reflector") return runtime.config.reflectorFallbackModels ?? [];
  return runtime.config.dropperFallbackModels ?? [];
}

function stageThinkingLevel(
  runtime: Runtime,
  stage: "observer" | "reflector" | "dropper",
  modelConfig?: ConfiguredModel,
): ModelThinkingLevel {
  const stageModel = modelConfig ?? stageModelConfig(runtime, stage);
  return stageModel?.thinking ?? runtime.config.model?.thinking ?? "low";
}

export function makeModelResolver(
  runtime: Runtime,
  ctx: ConsolidationCtx,
  generation: RuntimeGeneration,
): (stage: "observer" | "reflector" | "dropper") => Promise<ResolvedModel | undefined> {
  return async (stage) => {
    const stageFallbacks = stageFallbackModels(runtime, stage);
    const resolved = await runtime.resolveModel(
      {
        model: ctx.model,
        modelRegistry: ctx.modelRegistry,
        hasUI: ctx.hasUI,
        ui: ctx.ui,
        stageModel: stageModelConfig(runtime, stage),
        stageFallbacks,
      },
      generation.signal,
    );
    if (!runtime.isGenerationActive(generation)) return undefined;
    if (resolved.ok) {
      runtime.resolveFailureNotified = false;
      return resolved;
    }
    debugLog(`${stage}.model_unavailable`, { reason: resolved.reason });
    if (!runtime.resolveFailureNotified && ctx.hasUI && ctx.ui) {
      if (runtime.failedInCycle.size > 0 && resolved.reason.includes("all candidates exhausted")) {
        const fallbackMsg =
          stageFallbacks.length === 0 ? "no fallbacks configured" : "no available fallbacks";
        runtime.tryEmitInfo(
          true,
          ctx.ui,
          `Observational memory: ${stage} skipped — model unavailable (cooldown set to 0, ${fallbackMsg}, will retry next run)`,
        );
      } else {
        ctx.ui.notify(`Observational memory: ${stage} skipped — ${resolved.reason}`, "warning");
      }
      runtime.resolveFailureNotified = true;
    }
    return undefined;
  };
}

// ── Trigger registration ────────────────────────────────────────────────────

function currentSessionIdentity(ctx: ConsolidationCtx): string | undefined {
  return ctx.sessionManager.getSessionId?.();
}

export function registerConsolidationTrigger(pi: ExtensionAPI, runtime: Runtime): void {
  pi.on("session_start", (_event, ctx) => {
    runtime.startSession(currentSessionIdentity(ctx as ConsolidationCtx));
  });
  pi.on("session_shutdown", () => {
    runtime.dispose();
  });
  const launch = (_event: unknown, ctx: ConsolidationCtx) => {
    maybeLaunchConsolidation(pi, runtime, ctx);
  };
  pi.on("agent_start", launch);
  pi.on("turn_end", launch);
}

/** Validate cursors against the current branch.  If a cursor's entry ID no longer
 *  exists in the branch (fork, navigation, compaction), fall back to the best
 *  available coverage marker for that stage. */
function validateCursors(entries: Entry[], runtime: Runtime): void {
  const cursors = runtime.cursors ?? {};

  // Observer: fall back to latest OM_OBSERVATIONS_RECORDED marker
  if (cursors.observer && entryIndexForId(entries, cursors.observer.entryId) < 0) {
    const markerId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
    if (markerId) {
      cursors.observer = { entryId: markerId, state: "initial" };
    } else {
      delete cursors.observer;
    }
  }

  // Reflector: fall back to latest OM_REFLECTIONS_RECORDED marker
  if (cursors.reflector && entryIndexForId(entries, cursors.reflector.entryId) < 0) {
    const markerId = latestCoverageMarkerId(entries, OM_REFLECTIONS_RECORDED);
    if (markerId) {
      cursors.reflector = { entryId: markerId, state: "initial" };
    } else {
      delete cursors.reflector;
    }
  }

  // Dropper: fall back to latest OM_OBSERVATIONS_DROPPED marker
  if (cursors.dropper && entryIndexForId(entries, cursors.dropper.entryId) < 0) {
    const markerId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_DROPPED);
    if (markerId) {
      cursors.dropper = { entryId: markerId, state: "initial" };
    } else {
      delete cursors.dropper;
    }
  }
}

function maybeLaunchConsolidation(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx): void {
  runtime.ensureConfig(ctx.cwd, (msg) => ctx.ui?.notify?.(msg, "warning"));
  if (runtime.config.memory === false) return;

  // Provider-aware skip: another engine owns this provider (e.g. Codex native
  // compaction); blackhole also steps aside from observational-memory
  // consolidation so it never touches opaque checkpoints.
  // EXPERIMENTAL compat shim — do not extend; see src/core/provider-skip.ts.
  if (matchesSkippedProvider(runtime.config, ctx.model)) return;

  // LEGACY: passive check — only applies when new keys are absent (unmigrated config)
  if (runtime.config.compaction === undefined && runtime.config.compactionEngine === undefined) {
    if (runtime.config.passive === true) return;
  }
  if (runtime.consolidationInFlight) return;
  if (runtime.isConsolidationRetryGated()) return;

  // Load and validate cursors from pending file (once per session; re-load on fork)
  let sessionId: string;
  try {
    sessionId = ctx.sessionManager.getSessionId();
  } catch (error) {
    if (isStaleExtensionContextError(error)) return;
    throw error;
  }
  if (runtime.cursorsLoadedSessionId !== sessionId) {
    if (typeof runtime.loadCursorsFromPending === "function") {
      runtime.loadCursorsFromPending(sessionId);
    }
    let entries: Entry[];
    try {
      entries = ctx.sessionManager.getBranch() as Entry[];
    } catch (error) {
      if (isStaleExtensionContextError(error)) return;
      throw error;
    }
    validateCursors(entries, runtime);
    runtime.cursorsLoadedSessionId = sessionId;
    const c = runtime.cursors ?? {};
    debugLog("cursor.loaded", {
      observer: c.observer ?? null,
      reflector: c.reflector ?? null,
      dropper: c.dropper ?? null,
    });
  }

  let entries: Entry[];
  try {
    entries = ctx.sessionManager.getBranch() as Entry[];
  } catch (error) {
    if (isStaleExtensionContextError(error)) return;
    throw error;
  }
  // In manual mode, the branch has no OM markers — pending state provides
  // pool fullness and new‑data visibility for reflector/dropper checks.
  const pending = isManualMode(runtime.config) ? readPendingState(sessionId) : undefined;
  if (!anyStageDue(entries, runtime, pending)) return;

  // Capture the generation at launch time so we can detect session changes
  // mid-pipeline and abort stale work.
  const generation = runtime.captureGeneration(currentSessionIdentity(ctx));
  if (!runtime.isGenerationActive(generation)) return;

  const runId = `consolidation-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
  const consolidationCtx: ConsolidationCtx = {
    cwd: ctx.cwd,
    hasUI: ctx.hasUI,
    ui: ctx.ui,
    model: ctx.model,
    modelRegistry: ctx.modelRegistry,
    sessionManager: ctx.sessionManager,
  };

  void runtime.launchConsolidationTask(ctx, async () =>
    withDebugLogContext(
      { enabled: runtime.config.debugLog === true, cwd: ctx.cwd, runId },
      async () => {
        if (!runtime.isGenerationActive(generation)) return;
        await runConsolidationPipeline(pi, runtime, consolidationCtx, generation);
      },
    ),
  );
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

export async function runConsolidationPipeline(
  pi: ExtensionAPI,
  runtime: Runtime,
  ctx: ConsolidationCtx,
  generation: RuntimeGeneration,
): Promise<void> {
  if (!runtime.isGenerationActive(generation)) return;
  const resolveModel = makeModelResolver(runtime, ctx, generation);

  runtime.consolidationPhase = "observer";
  runtime.failedInCycle.clear();
  runtime.sizeSkippedInCycle.clear();
  runtime.resolveFailureNotified = false;
  try {
    const observerOutcome = await runObserverStage(pi, runtime, ctx, generation, resolveModel);
    if (!runtime.isGenerationActive(generation) || observerOutcome === "abort") return;
  } catch (error) {
    if (!runtime.isGenerationActive(generation)) return;
    debugLog("observer.error", {
      errorMessage: runtime.recordConsolidationStageError(ctx, "observer", error),
    });
    return;
  }

  runtime.consolidationPhase = "reflector";
  runtime.failedInCycle.clear();
  runtime.sizeSkippedInCycle.clear();
  runtime.resolveFailureNotified = false;
  let reflectorResult: ReflectorStageResult;
  try {
    reflectorResult = await runReflectorStage(pi, runtime, ctx, generation, resolveModel);
    if (!runtime.isGenerationActive(generation) || reflectorResult.outcome === "abort") return;
  } catch (error) {
    if (!runtime.isGenerationActive(generation)) return;
    debugLog("reflector.error", {
      errorMessage: runtime.recordConsolidationStageError(ctx, "reflector", error),
    });
    return;
  }

  runtime.consolidationPhase = "dropper";
  runtime.failedInCycle.clear();
  runtime.sizeSkippedInCycle.clear();
  runtime.resolveFailureNotified = false;
  try {
    await runDropperStage(
      pi,
      runtime,
      ctx,
      generation,
      resolveModel,
      reflectorResult.sameRunReflections,
      reflectorResult.effectiveReflectionCoverageId,
    );
  } catch (error) {
    if (!runtime.isGenerationActive(generation)) return;
    debugLog("dropper.error", {
      errorMessage: runtime.recordConsolidationStageError(ctx, "dropper", error),
    });
  }

  // Flush cursors to pending file after all stages complete (non‑blocking)
  let sessionId: string;
  try {
    sessionId = ctx.sessionManager.getSessionId();
  } catch (error) {
    if (isStaleExtensionContextError(error)) {
      debugLog("pipeline.stale_ctx", { error: String(error) });
      return;
    }
    throw error;
  }
  runtime.scheduleCursorFlush(sessionId);
  const c = runtime.cursors ?? {};
  debugLog("cursor.saved", {
    observer: c.observer ?? null,
    reflector: c.reflector ?? null,
    dropper: c.dropper ?? null,
  });
}

// ── Kept-close error handling (observer + reflector) ─────────────────────────

/**
 * Classify and record a provider failure from a turn after a valid
 * complete=true close that the worker kept.
 *
 * The close is kept, but the failure must not be silent: a deterministic
 * error (bad key, removed model) gets the same cooldown the stage catch
 * applies, so the next cycle falls back instead of reporting success forever;
 * a transient one only warns, since the model just produced a usable close.
 * The error is classified with the same framing the throw path builds
 * (`workerStreamErrorMessage`), so a bare provider code such as `401` is
 * deterministic on both paths and the two cannot drift apart.
 *
 * The toast names only the destination that was written, never the provider
 * body (issue #80): a cooldownHours-0 candidate is only skipped in-memory for
 * the stage, and a session model without provider/id never reaches the
 * cooldown file (`recordDeterministicError` keys it on both), so the
 * not-cooled branch claims no skip and no cooldown.
 */
function handleWorkerErrorAfterClose(args: {
  runtime: Runtime;
  ctx: ConsolidationCtx;
  stage: "observer" | "reflector";
  worker: ConsolidationWorker;
  keptNoun: string;
  errorText: string;
  resolved: ResolvedModel;
  stageModelForThinking: ConfiguredModel | undefined;
  coverageId: string | undefined;
}): void {
  const {
    runtime,
    ctx,
    stage,
    worker,
    keptNoun,
    errorText,
    resolved,
    stageModelForThinking,
    coverageId,
  } = args;
  const afterClose = new Error(workerStreamErrorMessage(worker, errorText));
  const deterministic = isDeterministicError(afterClose);
  // The toast must describe what was actually written: a cooldownHours-0
  // candidate cools in-memory only, and a session model whose resolved model
  // has no provider/id never reaches the cooldown file at all —
  // recordDeterministicError keys it on both.
  const sessionIdentity: { provider?: unknown; id?: unknown } | null | undefined = resolved.model;
  const cooled =
    deterministic &&
    (stageModelForThinking
      ? stageModelForThinking.cooldownHours !== 0
      : typeof sessionIdentity?.provider === "string" && typeof sessionIdentity?.id === "string");
  if (stage === "observer") {
    debugLog("observer.error_after_close", {
      error: errorText,
      deterministic,
      coversUpToId: coverageId,
    });
  } else {
    debugLog("reflector.error_after_close", {
      error: errorText,
      deterministic,
      observationCoverageId: coverageId,
    });
  }
  if (deterministic) {
    runtime.recordRetryableError(stageModelForThinking, afterClose, stage);
    if (!stageModelForThinking) {
      runtime.recordDeterministicError(resolved.model, afterClose, stage);
    }
  }
  if (ctx.hasUI) {
    // Issue #80: the error text can be a provider body; it goes to the
    // cooldown/debug log only, never into the toast. The pointer itself
    // must be true too, so it names only a destination that was written.
    ctx.ui?.notify(
      `Observational memory: ${stage} kept its ${keptNoun}, but a later turn failed (${
        deterministic
          ? cooled
            ? "deterministic error, model cooled down; details in cooldown log"
            : "deterministic error; no cooldown recorded"
          : runtime.config.debugLog === true
            ? "transient error; details in debug log"
            : "transient error; enable debugLog for details"
      })`,
      "warning",
    );
  }
}

// ── Observer stage (with fallback) ──────────────────────────────────────────

export async function runObserverStage(
  pi: ExtensionAPI,
  runtime: Runtime,
  ctx: ConsolidationCtx,
  generation: RuntimeGeneration,
  resolveModel: (stage: "observer") => Promise<ResolvedModel | undefined>,
  drain = false,
  drainRemaining: number = OBSERVER_DRAIN_MAX_BATCHES,
): Promise<StageOutcome> {
  if (!runtime.isGenerationActive(generation)) return "abort";
  let entries: Entry[];
  let sessionId: string;
  try {
    entries = ctx.sessionManager.getBranch() as Entry[];
    sessionId = ctx.sessionManager.getSessionId();
  } catch (error) {
    if (isStaleExtensionContextError(error)) {
      debugLog("observer.stale_ctx", { error: String(error) });
      return "abort";
    }
    throw error;
  }

  // Determine start index: cursor takes priority. A cursor whose entry left the
  // branch (fork, navigation, compaction during the session) falls back to the
  // same marker/compaction rule as an absent cursor, so a pruned pre-compaction
  // anchor never forces a full-history re-observation.
  const observerCursor = runtime.getCursor("observer");
  const observerFallbackStart = (): number => {
    const lastCoverageIdx = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
    return lastCoverageIdx >= 0 ? lastCoverageIdx : findLastCompactionIndex(entries);
  };
  let effectiveStart: number;
  if (observerCursor) {
    const cursorIdx = entryIndexForId(entries, observerCursor.entryId);
    effectiveStart = cursorIdx >= 0 ? cursorIdx : observerFallbackStart();
  } else {
    effectiveStart = observerFallbackStart();
  }

  // Anchor -1 (no cursor, no marker, no compaction) measures the full history:
  // rawTokensAfterIndex clamps -1 to index 0 (issue #87).
  const tokens = rawTokensAfterIndex(entries, effectiveStart);
  // A drain batch bypasses the trigger: it is the continuation of a run that
  // already fired, and the remainder of its backlog is often below the
  // threshold. Holding it back until more content arrives would re-cap the
  // same backlog instead of finishing what the first batch started.
  if (tokens < runtime.config.observeAfterTokens && !drain) {
    // Not due. Keep the anchor at the measured coverage point rather than the
    // newest entry: below-threshold content is still unobserved, so moving the
    // cursor past it would drop it permanently instead of letting it accumulate.
    const anchorId = effectiveStart >= 0 ? entries[effectiveStart]?.id : undefined;
    if (anchorId) runtime.advanceCursor("observer", anchorId, "not_due");
    return "continue";
  }

  // Full post-cursor source list, kept for the shrink-to-fit pass: the capped
  // chunk below may prove too big for every model, in which case the stage
  // re-caps this list against the largest resolved window instead of aborting.
  const allChunkEntries = sourceEntriesAfter(entries, effectiveStart);
  let chunkEntries = allChunkEntries;

  // Cap observer input to observerChunkMaxTokens (oldest prefix first)
  const maxChunkTokens = runtime.config.observerChunkMaxTokens;
  if (tokens > maxChunkTokens) {
    chunkEntries = capSourceEntriesToTokens(chunkEntries, maxChunkTokens);
  }

  let {
    text: chunk,
    sourceEntryIds,
    sourceEntryTimestamps,
  } = serializeSourceAddressedBranchEntries(chunkEntries);
  // Coverage claims only what was actually delivered: the id the serializer
  // emitted last, not the last entry of the capped slice (the serializer
  // skips entries it cannot render). With the oldest-first cap that is the
  // end of the prefix — everything from the cursor to here was sent, and
  // entries beyond it stay in the backlog.
  let coversUpToId = sourceEntryIds.at(-1);
  if (!coversUpToId || !chunk.trim()) return "continue";

  // The branch's last source entry as of this run's snapshot: the drain keeps
  // going until coverage reaches it. Entries arriving after the snapshot belong
  // to the next cycle; a trailing entry the serializer cannot render keeps the
  // cursor before it (the recursion below serializes it empty and returns
  // before resolving a model), so this condition alone terminates.
  const lastSourceEntryId = entries.filter(isSourceEntry).at(-1)?.id;
  const continueSources = (): StageOutcome | Promise<StageOutcome> => {
    if (drainRemaining <= 0) return "continue";
    if (!coversUpToId || coversUpToId === lastSourceEntryId) return "continue";
    return runObserverStage(pi, runtime, ctx, generation, resolveModel, true, drainRemaining - 1);
  };
  let chunkTokens = Math.ceil(chunk.length / 4);
  // Issue #110 follow-up: expose the post-cap size on the normal path (the
  // exceptional context_window_exceeded path already logs estimatedInput).
  // capTokens is the exact quantity capSourceEntriesToTokens enforced (the
  // same estimateEntryTokens the trigger uses), so it can confirm/rule out
  // the cap bug in a running install.
  let capTokens = chunkEntries.reduce((s: number, e) => s + estimateEntryTokens(e), 0);

  const memory = fullProjection(entries);

  // The preamble is capped via observerPreambleMaxTokens so accumulated
  // memory doesn't grow unbounded across turns. Each section gets up to the
  // full budget: observations relevance-ranked, reflections newest-first.
  // In manual mode, append accumulated batch history to whatever
  // fullProjection found in the branch (preserving pre-switch markers when
  // transitioning from autoCompact to manual mode mid-session).
  const preambleMaxTokens =
    runtime.config.observerPreambleMaxTokens > 0
      ? runtime.config.observerPreambleMaxTokens
      : Math.round(runtime.config.observerChunkMaxTokens * 0.3);
  let priorReflections = selectPriorReflections(memory.reflections, preambleMaxTokens).map(
    reflectionToSummaryLine,
  );
  let priorObservations = selectPriorObservations(memory.observations, preambleMaxTokens).map(
    observationToSummaryLine,
  );
  if (isManualMode(runtime.config)) {
    const pendingCtx = readPendingState(sessionId);
    const accumulatedReflections = (pendingCtx.reflectionBatches ?? []).flatMap(
      (b) => (b.data as any).reflections ?? [],
    );
    const accumulatedObservations = (pendingCtx.observationBatches ?? []).flatMap(
      (b) => (b.data as any).observations ?? [],
    );

    const allObservations = [...memory.observations, ...accumulatedObservations];
    priorObservations = selectPriorObservations(allObservations, preambleMaxTokens).map(
      observationToSummaryLine,
    );

    const allReflections = [...memory.reflections, ...accumulatedReflections];
    priorReflections = selectPriorReflections(allReflections, preambleMaxTokens).map(
      reflectionToSummaryLine,
    );
  }

  // Attempt-invariant prompt overhead, measured once: the rendered preamble
  // plus the observer system prompt. The per-model context guard below must
  // price the real prompt — a chunk-only estimate goes blind once accumulated
  // memory grows and every attempt 400s instead of skipping cleanly.
  const preambleTokens = estimateStringTokens(
    [...priorReflections, ...priorObservations].join("\n"),
  );
  const observerSystemTokens = estimateStringTokens(OBSERVER_SYSTEM);
  // Measured static first-turn overhead (system + the one tool schema +
  // framing), replacing the former flat 8000-token reserve guess for everything
  // the stage can price exactly. Later-turn tool traffic stays a headroom
  // estimate, and the output allowance is priced separately per model below.
  const observerStaticTokens = workerStaticPromptTokens("observer");

  // If manual mode: skip if this exact chunk was already processed
  if (isManualMode(runtime.config) && isObservationChunkPending(sessionId, coversUpToId)) {
    debugLog("observer.pending_skip", { coversUpToId, sessionId });
    return "continue";
  }

  // Largest-window model resolved so far this run, with its window: the
  // shrink-to-fit fallback sizes the chunk to it when no model fits the full
  // chunk. Tracked across attempts, including ones that fit (a later runtime
  // failure still aborts — see sawAttemptError — so this can never smuggle a
  // broken model back in).
  let bestFit: { resolved: ResolvedModel; ctx: number } | undefined;
  // Any attempt that ran a model and failed (provider error, timeout, turn
  // cap, ...). The shrink pass only triggers on a pure size-mismatch record:
  // once a fitting model has failed at runtime, error semantics own the
  // outcome and the stage aborts exactly as before.
  let sawAttemptError = false;
  let didShrink = false;

  for (let attempt = 0; attempt < MAX_STAGE_ATTEMPTS; attempt++) {
    const resolved = await resolveModel("observer");
    if (!runtime.isGenerationActive(generation)) return "abort";
    if (!resolved) {
      // Total exhaustion: every candidate was size-skipped (or unavailable)
      // and no attempt ever ran. Shrink the chunk to the largest resolved
      // window and run that instead of aborting — the F1 drain covers the
      // remainder in-run, so this degrades gracefully instead of wedging.
      // Afterwards the loop re-resolves: the shrunk input fits the best
      // model, which is re-offered below.
      if (!didShrink && bestFit && !sawAttemptError) {
        const bestModel = bestFit.resolved.model as any;
        const shrinkBudget =
          bestFit.ctx -
          observerStaticTokens -
          preambleTokens -
          WORKER_TURN_HEADROOM_TOKENS -
          workerOutputReserveTokens(bestModel) -
          WORKER_SAFETY_MARGIN_TOKENS;
        if (shrinkBudget <= 0) return "abort";
        const shrunkEntries = capSourceEntriesToTokens(allChunkEntries, shrinkBudget);
        const shrunk = serializeSourceAddressedBranchEntries(shrunkEntries);
        const shrunkCover = shrunk.sourceEntryIds.at(-1);
        if (!shrunkCover || !shrunk.text.trim()) return "abort";
        chunkEntries = shrunkEntries;
        chunk = shrunk.text;
        sourceEntryIds = shrunk.sourceEntryIds;
        sourceEntryTimestamps = shrunk.sourceEntryTimestamps;
        coversUpToId = shrunkCover;
        chunkTokens = Math.ceil(chunk.length / 4);
        capTokens = chunkEntries.reduce((s: number, e) => s + estimateEntryTokens(e), 0);
        didShrink = true;
        // The shrunk chunk has a new coverage point: re-check the manual-mode
        // pending gate before spending a model call on it. Without this, a
        // shrink could re-process an already-pending prefix (flush dedupes by
        // content-hash ids, so this is duplication rather than loss, but the
        // model call is still wasted).
        if (isManualMode(runtime.config) && isObservationChunkPending(sessionId, coversUpToId)) {
          debugLog("observer.pending_skip", { coversUpToId, sessionId });
          return "continue";
        }
        runtime.unskipOversizedForCycle(bestModel);
        runtime.tryEmitWorkerInfo(
          ctx.hasUI,
          ctx.ui,
          `Observational memory: observer shrinking chunk to fit ${bestModel.provider}/${bestModel.id} (~${shrinkBudget.toLocaleString()}-token budget)`,
        );
        debugLog("observer.shrink_to_fit", {
          shrinkBudget,
          chunkTokens,
          coversUpToId,
          model: `${bestModel.provider}/${bestModel.id}`,
        });
        continue;
      }
      return "abort";
    }

    // Adjust accumulated for pending coverage in manual mode
    let effectiveTokens = tokens;
    if (isManualMode(runtime.config)) {
      const pending = readPendingState(sessionId);
      if (pending.observation?.coversUpToId) {
        const idx = entryIndexForId(entries, pending.observation.coversUpToId);
        if (idx >= 0) effectiveTokens = rawTokensAfterIndex(entries, idx);
      }
    }
    runtime.tryEmitWorkerInfo(
      ctx.hasUI,
      ctx.ui,
      `Observational memory: observer running on ~${chunkTokens.toLocaleString()}-token chunk (of ${effectiveTokens.toLocaleString()} accumulated)`,
    );
    debugLog("observer.start", {
      tokens,
      maxChunkTokens,
      chunkTokens,
      capTokens,
      preambleTokens,
      coversUpToId,
      sourceEntryIds,
      sourceEntryCount: sourceEntryIds.length,
      priorReflections: priorReflections.length,
      priorObservations: priorObservations.length,
    });

    // Candidate provenance is captured during resolution so a settings reload
    // cannot change which model config owns this attempt.
    const stageModelForThinking =
      resolved.source === "candidate" ? resolved.candidateConfig : undefined;

    // Check if the full estimated prompt fits in the model's context window:
    // chunk + rendered preamble + measured static overhead (system, the one
    // tool schema, framing) + headroom for later tool turns, against the
    // window minus the output allowance and a safety margin. The output
    // allowance shares the window with the prompt: an input-only check admits
    // prompts the provider then rejects on generation overflow.
    const effectiveObsCtx = effectiveContextWindow(resolved.model as any, stageModelForThinking);
    if (!bestFit || effectiveObsCtx > bestFit.ctx) bestFit = { resolved, ctx: effectiveObsCtx };
    const observerEstimatedInput =
      chunkTokens + preambleTokens + observerStaticTokens + WORKER_TURN_HEADROOM_TOKENS;
    const observerInputBudget =
      effectiveObsCtx -
      workerOutputReserveTokens(resolved.model as any) -
      WORKER_SAFETY_MARGIN_TOKENS;
    if (observerEstimatedInput > observerInputBudget) {
      debugLog("observer.context_window_exceeded", {
        estimatedInput: observerEstimatedInput,
        inputBudget: observerInputBudget,
        chunkTokens,
        preambleTokens,
        systemTokens: observerSystemTokens,
        staticTokens: observerStaticTokens,
        effectiveCtx: effectiveObsCtx,
        model: `${(resolved.model as any).provider}/${(resolved.model as any).id}`,
      });
      // Size-skip only: a too-small window is not a broken model, so this
      // never writes a persisted cooldown (which would wedge later cycles
      // too). The in-cycle skip advances the fallback chain within this run.
      const resolvedIdentity = resolved.model as { provider?: unknown; id?: unknown };
      runtime.skipOversizedForCycle(
        stageModelForThinking ??
          (typeof resolvedIdentity.provider === "string" && typeof resolvedIdentity.id === "string"
            ? { provider: resolvedIdentity.provider, id: resolvedIdentity.id }
            : undefined),
      );
      runtime.tryEmitInfo(
        ctx.hasUI,
        ctx.ui,
        `Observational memory: observer skipping ${(resolved.model as any).provider}/${(resolved.model as any).id} (context window ${effectiveObsCtx.toLocaleString()} too small for ~${observerEstimatedInput.toLocaleString()}-token input)`,
      );
      continue;
    }

    try {
      const { runObserver } = await import("./agents/observer/agent.js");
      const result = await runWorkerAttempt(
        "observer",
        runtime.config.workerAttemptTimeoutMs,
        generation.signal,
        (signal) =>
          runObserver({
            model: resolved.model as any,
            apiKey: resolved.apiKey,
            headers: withProviderAttributionHeaders(
              resolved.model as any,
              resolved.headers,
              sessionId,
            ),
            env: resolved.env,
            priorReflections,
            priorObservations,
            chunk,
            allowedSourceEntryIds: sourceEntryIds,
            sourceEntryTimestamps,
            maxTurns: runtime.config.agentMaxTurns,
            thinkingLevel: stageThinkingLevel(runtime, "observer", stageModelForThinking),
            providerIdleTimeoutMs: runtime.config.providerIdleTimeoutMs,
            signal,
            modelRegistry: ctx.modelRegistry,
            sessionId,
            cacheRetention: runtime.config.cacheRetention,
          }),
      );
      if (!runtime.isGenerationActive(generation)) return "abort";

      // The run closed the chunk and then a later turn failed (a host that
      // ignores `terminate`). Shared with the reflector stage: same framing,
      // same cooldown, same toast shape.
      if (result.errorAfterClose) {
        handleWorkerErrorAfterClose({
          runtime,
          ctx,
          stage: "observer",
          worker: "Observer",
          keptNoun: "completed chunk",
          errorText: result.errorAfterClose,
          resolved,
          stageModelForThinking,
          coverageId: coversUpToId,
        });
      }

      if (result.observations && result.observations.length > 0) {
        const data = buildObservationsRecordedData(result.observations, coversUpToId);
        if (!data) {
          runtime.advanceCursor("observer", coversUpToId, "empty");
          return "continue";
        }
        debugLog("observer.records", {
          count: result.observations.length,
          observationTokens: result.observations.reduce((s: number, o: any) => s + o.tokenCount, 0),
          coversUpToId,
        });
        if (isManualMode(runtime.config)) {
          savePendingObservation(sessionId, { coversUpToId, data });
          debugLog("observer.pending", {
            count: result.observations.length,
            coversUpToId,
            sessionId,
          });
        } else {
          if (!appendEntry(pi, runtime, generation, OM_OBSERVATIONS_RECORDED, data)) return "abort";
          debugLog("observer.appended", {
            count: result.observations.length,
            coversUpToId,
          });
        }
        runtime.advanceCursor("observer", coversUpToId, "recorded");
        runtime.tryEmitWorkerInfo(
          ctx.hasUI,
          ctx.ui,
          `Observational memory: ${result.observations.length} observation${result.observations.length === 1 ? "" : "s"} recorded`,
        );
        // Recorded and covered up to the delivered point — drain the rest of
        // the backlog now instead of waiting for the next turn_end.
        return continueSources();
      }

      // No observations — diagnose the reason for the warning
      const reason = result.emptyReason;
      const reasonLabel = reason
        ? reason.kind === "tool_not_called"
          ? "model did not call the observation tool"
          : reason.kind === "all_rejected"
            ? `${reason.count} observation(s) rejected for invalid sourceEntryIds`
            : reason.kind === "all_duplicates"
              ? `${reason.count} observation(s) were duplicates of already-recorded entries`
              : reason.kind === "empty_array"
                ? "model called the tool but submitted an empty observations array"
                : "nothing new to record"
        : "unknown reason";
      const reasonLevel: "info" | "warning" = reason
        ? reason.kind === "no_new_content" || reason.kind === "all_duplicates"
          ? "info"
          : "warning"
        : "warning";
      debugLog("observer.empty", { coversUpToId, reason: reason?.kind });
      runtime.advanceCursor("observer", coversUpToId, "empty");
      if (reasonLevel === "warning") {
        if (ctx.hasUI)
          ctx.ui?.notify(`Observational memory: no observations — ${reasonLabel}`, "warning");
      } else {
        runtime.tryEmitWorkerInfo(
          ctx.hasUI,
          ctx.ui,
          `Observational memory: no observations — ${reasonLabel}`,
        );
      }
      // A clean "nothing new" close still proves coverage up to the delivered
      // point, so the rest of the backlog can drain in this same run.
      return continueSources();
    } catch (error) {
      if (!runtime.isGenerationActive(generation)) return "abort";
      if (isStaleExtensionContextError(error)) {
        debugLog("observer.stale_ctx", { error: String(error) });
        return "abort";
      }
      // Always try next fallback — don't abort pipeline for a single model failure.
      // Record cooldown so resolveModel skips this model in the next iteration.
      // Deterministic 4xx (e.g. MissingSessionID) additionally cools the
      // resolved model itself: the session model has no candidate config, so
      // without this it would retry identically on every cycle.
      // Any error reaching this point ran a model that fit: error semantics
      // own the outcome from here, so the shrink-to-fit pass stays out.
      sawAttemptError = true;
      const candidateConfig = stageModelForThinking;
      runtime.recordRetryableError(candidateConfig, error, "observer");
      if (!candidateConfig) runtime.recordDeterministicError(resolved.model, error, "observer");
      debugLog("observer.error", {
        error: String(error),
        retryable: isRetryableError(error),
        deterministic: isDeterministicError(error),
        cooldownWorthy: isCooldownWorthyError(error),
        // Records written before a stream error and discarded with the run.
        discardedCount: getDiscardedCount(error),
      });
      // A timed-out session model has no candidate config to cool down, so
      // the loop would re-resolve the same stalled model and burn the full
      // deadline on every remaining attempt. Treat the stage as exhausted.
      // A session model cut off by the agent turn cap fails the same way for
      // the same reason: `agentMaxTurns` is global config, so a retry spends
      // another whole budget on an identical outcome. Candidates differ — they
      // cool down and the fallback chain takes over.
      if (
        !candidateConfig &&
        (error instanceof WorkerAttemptTimeoutError ||
          (error instanceof WorkerStreamError && error.turnCapExhausted))
      )
        break;
      // Continue loop — resolveModel will skip the cooled-down model
      continue;
    }
  }

  // All attempts exhausted
  runtime.recordConsolidationStageError(
    ctx,
    "observer",
    new Error("Observer: all model candidates exhausted"),
  );
  return "abort";
}

/**
 * Greedy oldest-first partition of sized items into contiguous batches that
 * each fit `budget`. The first item always starts the first batch even when
 * oversized on its own (prefix-guard semantics, mirroring
 * capSourceEntriesToTokens) — the caller treats an over-budget first batch
 * as unplannable and aborts. Order is preserved; per-item wrapper overhead
 * (summary-line headers etc.) rides in the caller's fixed overhead.
 */
function planPrefixBatches<T>(
  items: readonly T[],
  tokenOf: (item: T) => number,
  budget: number,
): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let used = 0;
  for (const item of items) {
    const tokens = tokenOf(item);
    if (batch.length > 0 && used + tokens > budget) {
      batches.push(batch);
      batch = [];
      used = 0;
    }
    batch.push(item);
    used += tokens;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * Snapshot of everything one reflector run needs from the branch: computed
 * once per stage invocation (entries are fixed for the run) and shared by
 * the normal attempt loop and the shrink-to-fit batch pass.
 */
function computeReflectorInput(
  runtime: Runtime,
  entries: Entry[],
  sessionId: string,
  reflectionTokens: number,
) {
  const folded = foldLedger(entries);
  const pending = isManualMode(runtime.config) ? readPendingState(sessionId) : undefined;
  const lastReflectionIdx = pending ? -1 : latestCoverageIndex(entries, OM_REFLECTIONS_RECORDED);
  const newObservations = pending
    ? pendingObservationsCreatedAfter(pending, entries, pending.reflection?.coversUpToId)
    : observationsCreatedAfterIndex(entries, lastReflectionIdx);
  const newReflections = pending ? [] : reflectionsCreatedAfterIndex(entries, lastReflectionIdx);
  const newItemsTokens = Math.ceil(
    (newObservations.reduce((s: number, o: any) => s + o.content.length, 0) +
      newReflections.reduce((s: number, r: any) => s + r.content.length, 0)) /
      4,
  );
  const summaryBudget = Math.floor(runtime.config.reflectorInputMaxTokens * 0.15) * 2;
  const reflectorInputTokens = Math.min(
    newItemsTokens + summaryBudget,
    runtime.config.reflectorInputMaxTokens,
  );
  // Adjust accumulated for pending coverage in manual mode
  let effectiveReflectionTokens = reflectionTokens;
  if (isManualMode(runtime.config)) {
    if (pending?.reflection?.coversUpToId) {
      const idx = entryIndexForId(entries, pending.reflection.coversUpToId);
      if (idx >= 0) effectiveReflectionTokens = rawTokensAfterIndex(entries, idx);
    }
  }
  // Existing memory summaries for context (capped).
  // In manual mode, merge accumulated pending batches with
  // branch data (preserving pre-switch markers).
  const sourceReflections = pending
    ? [
        ...folded.reflections,
        ...(pending.reflectionBatches ?? []).flatMap(
          (b: any) => (b.data as any)?.reflections ?? [],
        ),
      ]
    : folded.reflections;
  const sourceObservations = pending
    ? [
        ...folded.activeObservations,
        ...(pending.observationBatches ?? []).flatMap(
          (b: any) => (b.data as any)?.observations ?? [],
        ),
      ]
    : folded.activeObservations;
  const existingReflectionsSummary = buildExistingReflectionsSummary(
    sourceReflections,
    Math.floor(runtime.config.reflectorInputMaxTokens * 0.15),
  );
  const existingObservationsSummary = buildExistingObservationsSummary(
    sourceObservations.filter((o: any) => !newObservations.some((no: any) => no.id === o.id)),
    Math.floor(runtime.config.reflectorInputMaxTokens * 0.15),
  );
  const summaryTokens = estimateStringTokens(
    `${existingReflectionsSummary}\n${existingObservationsSummary}`,
  );
  return {
    folded,
    pending,
    newObservations,
    newReflections,
    newItemsTokens,
    reflectorInputTokens,
    effectiveReflectionTokens,
    existingReflectionsSummary,
    existingObservationsSummary,
    summaryTokens,
  };
}

// ── Reflector stage (with fallback) ─────────────────────────────────────────

export async function runReflectorStage(
  pi: ExtensionAPI,
  runtime: Runtime,
  ctx: ConsolidationCtx,
  generation: RuntimeGeneration,
  resolveModel: (stage: "reflector") => Promise<ResolvedModel | undefined>,
): Promise<ReflectorStageResult> {
  if (!runtime.isGenerationActive(generation)) return { outcome: "abort", sameRunReflections: [] };
  let entries: Entry[];
  let sessionId: string;
  try {
    entries = ctx.sessionManager.getBranch() as Entry[];
    sessionId = ctx.sessionManager.getSessionId();
  } catch (error) {
    if (isStaleExtensionContextError(error)) {
      debugLog("reflector.stale_ctx", { error: String(error) });
      return { outcome: "abort", sameRunReflections: [] };
    }
    throw error;
  }
  let reflectionTokens = 0;
  let observationCoverageId: string | undefined;
  if (isManualMode(runtime.config)) {
    const pending = readPendingState(sessionId);
    // Check any accumulated batch for unprocessed observations, not just the latest
    const hasPendingObs = (pending.observationBatches ?? []).some(
      (b: any) => (b.data as any)?.observations?.length,
    );
    if (!hasPendingObs) {
      runtime.advanceCursor("reflector", entries.at(-1)?.id ?? "unknown", "skipped");
      return { outcome: "continue", sameRunReflections: [] };
    }
    observationCoverageId = pending.observation?.coversUpToId;
    if (pending.reflection?.coversUpToId) {
      const obsIdx = entryIndexForId(entries, pending.observation?.coversUpToId ?? "");
      const refIdx = entryIndexForId(entries, pending.reflection.coversUpToId);
      if (obsIdx >= 0 && refIdx >= 0 && obsIdx <= refIdx) {
        runtime.advanceCursor("reflector", pending.reflection.coversUpToId, "skipped");
        return { outcome: "continue", sameRunReflections: [] };
      }
      if (refIdx >= 0) {
        reflectionTokens = rawTokensAfterIndex(entries, refIdx);
        if (reflectionTokens < runtime.config.reflectAfterTokens) {
          runtime.advanceCursor("reflector", pending.reflection.coversUpToId, "not_due");
          return { outcome: "continue", sameRunReflections: [] };
        }
      } else {
        reflectionTokens = rawTokensSinceObservationCoverage(entries);
      }
    } else {
      reflectionTokens = rawTokensSinceObservationCoverage(entries);
    }
  } else {
    reflectionTokens = rawTokensSinceReflectionCoverage(entries);
    if (reflectionTokens < runtime.config.reflectAfterTokens) {
      runtime.advanceCursor("reflector", entries.at(-1)?.id ?? "unknown", "not_due");
      return { outcome: "continue", sameRunReflections: [] };
    }
    observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
    if (!observationCoverageId) {
      runtime.advanceCursor("reflector", entries.at(-1)?.id ?? "unknown", "skipped");
      return { outcome: "continue", sameRunReflections: [] };
    }
  }

  // Snapshot the run input once: entries are fixed for this invocation, and
  // both the attempt loop and the shrink-to-fit batch pass share it.
  const input = computeReflectorInput(runtime, entries, sessionId, reflectionTokens);
  const reflectorStaticTokens = workerStaticPromptTokens("reflector");

  // Shared commit tail: normal and batched runs both advance the cursor at
  // most once, after all work for this invocation is done.
  const commitReflectorResult = (
    reflections: Reflection[] | undefined,
    errorText: string | undefined,
    resolved: ResolvedModel,
  ): ReflectorStageResult => {
    if (errorText) {
      handleWorkerErrorAfterClose({
        runtime,
        ctx,
        stage: "reflector",
        worker: "Reflector",
        keptNoun: "completed review",
        errorText,
        resolved,
        stageModelForThinking:
          resolved.source === "candidate" ? resolved.candidateConfig : undefined,
        coverageId: observationCoverageId,
      });
    }
    if (!reflections || reflections.length === 0) {
      runtime.advanceCursor(
        "reflector",
        observationCoverageId ?? entries.at(-1)?.id ?? "unknown",
        "empty",
      );
      return { outcome: "continue", sameRunReflections: [] };
    }
    if (!observationCoverageId) {
      runtime.advanceCursor("reflector", entries.at(-1)?.id ?? "unknown", "empty");
      return { outcome: "continue", sameRunReflections: [] };
    }
    const data = buildReflectionsRecordedData(reflections, observationCoverageId);
    if (!data) {
      runtime.advanceCursor("reflector", observationCoverageId, "empty");
      return { outcome: "continue", sameRunReflections: [] };
    }
    if (isManualMode(runtime.config)) {
      savePendingReflection(sessionId, {
        coversUpToId: data.coversUpToId,
        data,
      });
    } else {
      if (!appendEntry(pi, runtime, generation, OM_REFLECTIONS_RECORDED, data)) {
        return { outcome: "abort", sameRunReflections: [] };
      }
    }
    runtime.advanceCursor("reflector", data.coversUpToId, "recorded");
    return {
      outcome: "continue",
      sameRunReflections: reflections,
      effectiveReflectionCoverageId: data.coversUpToId,
    };
  };

  // Shrink-to-fit batching: partition the new observations into contiguous
  // batches that each fit the largest resolved window, run them all with that
  // model, merge, and commit once. Any batch failure voids the whole run with
  // the cursor unmoved (a partial commit would advance coverage over
  // unreviewed observations). New reflections travel whole in every batch:
  // they are prior-cycle outputs, bounded in practice, and splitting them
  // would change review semantics.
  const runShrunkBatches = async (best: {
    resolved: ResolvedModel;
    ctx: number;
  }): Promise<ReflectorStageResult> => {
    const bestModel = best.resolved.model as any;
    const stageModelForBatch =
      best.resolved.source === "candidate" ? best.resolved.candidateConfig : undefined;
    // New reflections travel whole in every batch, so they ride in the fixed
    // per-batch overhead alongside the summaries (mirroring the normal-path
    // fit-check, which prices them inside newItemsTokens).
    const newReflectionsTokens = Math.ceil(
      input.newReflections.reduce((s: number, r: any) => s + r.content.length, 0) / 4,
    );
    const batchFixedOverhead =
      input.summaryTokens +
      newReflectionsTokens +
      reflectorStaticTokens +
      WORKER_TURN_HEADROOM_TOKENS;
    const batchBudget =
      best.ctx - workerOutputReserveTokens(bestModel) - WORKER_SAFETY_MARGIN_TOKENS;
    const itemBudget = batchBudget - batchFixedOverhead;
    if (itemBudget <= 0) return { outcome: "abort", sameRunReflections: [] };
    const batches = planPrefixBatches(
      input.newObservations,
      (o) => Math.ceil(o.content.length / 4),
      itemBudget,
    );
    if (input.newObservations.length > 0) {
      // Every batch must fit: planPrefixBatches always starts an oversized
      // item in its own batch, so a single huge observation anywhere in the
      // list — not just at the head — would otherwise send an over-window
      // batch, fail at runtime, and void the whole run into an identical
      // retry every cycle. Abort upfront when any batch overflows.
      const oversized = batches.find(
        (batch) =>
          batch.reduce((s, o) => s + Math.ceil(o.content.length / 4), 0) + batchFixedOverhead >
          batchBudget,
      );
      if (oversized) return { outcome: "abort", sameRunReflections: [] };
    }
    const planned = batches.length > 0 ? batches : [[] as Observation[]];
    // Unbounded by design (the backlog clears on commit), so log the plan
    // shape upfront: batch count × sizes is the cost multiplier for this run.
    debugLog("reflector.batch_plan", {
      batchCount: planned.length,
      batchSizes: planned.map((b) => b.length),
      newObsCount: input.newObservations.length,
      model: `${bestModel.provider}/${bestModel.id}`,
    });
    runtime.tryEmitWorkerInfo(
      ctx.hasUI,
      ctx.ui,
      `Observational memory: reflector batching ${input.newObservations.length} observations into ${planned.length} fit-to-window batches on ${bestModel.provider}/${bestModel.id}`,
    );
    let merged: Reflection[] = [];
    let firstError: string | undefined;
    for (let batchIndex = 0; batchIndex < planned.length; batchIndex++) {
      const batch = planned[batchIndex];
      if (!runtime.isGenerationActive(generation))
        return { outcome: "abort", sameRunReflections: [] };
      // Empty batches are no-ops (runReflector returns early on empty
      // observations); skip the trivial call and commit empty below.
      if (batch.length === 0) continue;
      debugLog("reflector.batch_start", {
        batchIndex,
        batchCount: planned.length,
        batchObsCount: batch.length,
        model: `${bestModel.provider}/${bestModel.id}`,
      });
      try {
        const { runReflector } = await import("./agents/reflector/agent.js");
        const result = await runWorkerAttempt(
          "reflector",
          runtime.config.workerAttemptTimeoutMs,
          generation.signal,
          (signal) =>
            runReflector({
              model: bestModel,
              apiKey: best.resolved.apiKey,
              headers: withProviderAttributionHeaders(bestModel, best.resolved.headers, sessionId),
              env: best.resolved.env,
              reflections: input.newReflections,
              observations: batch,
              existingReflectionsSummary: input.existingReflectionsSummary || undefined,
              existingObservationsSummary: input.existingObservationsSummary || undefined,
              maxTurns: runtime.config.agentMaxTurns,
              thinkingLevel: stageThinkingLevel(runtime, "reflector", stageModelForBatch),
              providerIdleTimeoutMs: runtime.config.providerIdleTimeoutMs,
              signal,
              modelRegistry: ctx.modelRegistry,
              sessionId,
              cacheRetention: runtime.config.cacheRetention,
            }),
        );
        if (!runtime.isGenerationActive(generation))
          return { outcome: "abort", sameRunReflections: [] };
        if (result.errorAfterClose !== undefined && firstError === undefined) {
          firstError = result.errorAfterClose;
        }
        merged = mergeReflections(merged, result.reflections ?? []);
      } catch (error) {
        if (!runtime.isGenerationActive(generation))
          return { outcome: "abort", sameRunReflections: [] };
        if (isStaleExtensionContextError(error)) {
          debugLog("reflector.stale_ctx", { error: String(error) });
          return { outcome: "abort", sameRunReflections: [] };
        }
        // Batch failure voids the run with the cursor unmoved; the next cycle
        // retries the whole input. Classified like a normal attempt failure so
        // cooldowns and the retry gate behave identically.
        const candidateConfig = stageModelForBatch;
        runtime.recordRetryableError(candidateConfig, error, "reflector");
        if (!candidateConfig) runtime.recordDeterministicError(bestModel, error, "reflector");
        debugLog("reflector.error", {
          error: String(error),
          retryable: isRetryableError(error),
          deterministic: isDeterministicError(error),
          cooldownWorthy: isCooldownWorthyError(error),
          discardedCount: getDiscardedCount(error),
        });
        runtime.recordConsolidationStageError(ctx, "reflector", error);
        return { outcome: "abort", sameRunReflections: [] };
      }
    }
    return commitReflectorResult(merged.length > 0 ? merged : undefined, firstError, best.resolved);
  };

  // Largest-window model resolved so far (shrink target) and whether any
  // attempt ran a model and failed (which keeps error semantics owning the
  // outcome — the shrink pass only triggers on a pure size-mismatch record).
  let bestFit: { resolved: ResolvedModel; ctx: number } | undefined;
  let sawAttemptError = false;

  for (let attempt = 0; attempt < MAX_STAGE_ATTEMPTS; attempt++) {
    const resolved = await resolveModel("reflector");
    if (!runtime.isGenerationActive(generation))
      return { outcome: "abort", sameRunReflections: [] };
    if (!resolved) {
      // Total exhaustion on a pure size-mismatch record: batch the input to
      // the largest resolved window and commit once, instead of aborting.
      if (bestFit && !sawAttemptError) return runShrunkBatches(bestFit);
      return { outcome: "abort", sameRunReflections: [] };
    }

    debugLog("reflector.start", {
      tokens: input.effectiveReflectionTokens,
      inputTokens: input.reflectorInputTokens,
      newObsCount: input.newObservations.length,
      newRefCount: input.newReflections.length,
    });
    runtime.tryEmitWorkerInfo(
      ctx.hasUI,
      ctx.ui,
      `Observational memory: reflector running (~${input.effectiveReflectionTokens.toLocaleString()} tokens accumulated, ~${input.reflectorInputTokens.toLocaleString()}-token input)`,
    );

    // Candidate provenance is captured during resolution so a settings reload
    // cannot change which model config owns this attempt.
    const stageModelForThinking =
      resolved.source === "candidate" ? resolved.candidateConfig : undefined;

    // Check if the full estimated prompt fits in the model's context window:
    // new items + actual (capped) summaries + measured static overhead
    // (system, the one tool schema, framing) + headroom for later tool turns,
    // against the window minus the output allowance and a safety margin.
    const effectiveRefCtx = effectiveContextWindow(resolved.model as any, stageModelForThinking);
    if (!bestFit || effectiveRefCtx > bestFit.ctx) bestFit = { resolved, ctx: effectiveRefCtx };
    const reflectorEstimatedInput =
      input.newItemsTokens +
      input.summaryTokens +
      reflectorStaticTokens +
      WORKER_TURN_HEADROOM_TOKENS;
    const reflectorInputBudget =
      effectiveRefCtx -
      workerOutputReserveTokens(resolved.model as any) -
      WORKER_SAFETY_MARGIN_TOKENS;
    if (reflectorEstimatedInput > reflectorInputBudget) {
      debugLog("reflector.context_window_exceeded", {
        estimatedInput: reflectorEstimatedInput,
        inputBudget: reflectorInputBudget,
        newItemsTokens: input.newItemsTokens,
        summaryTokens: input.summaryTokens,
        staticTokens: reflectorStaticTokens,
        effectiveCtx: effectiveRefCtx,
        model: `${(resolved.model as any).provider}/${(resolved.model as any).id}`,
      });
      // Size-skip only: a too-small window is not a broken model, so this
      // never writes a persisted cooldown. The in-cycle skip advances the
      // fallback chain within this run.
      const resolvedIdentity = resolved.model as { provider?: unknown; id?: unknown };
      runtime.skipOversizedForCycle(
        stageModelForThinking ??
          (typeof resolvedIdentity.provider === "string" && typeof resolvedIdentity.id === "string"
            ? { provider: resolvedIdentity.provider, id: resolvedIdentity.id }
            : undefined),
      );
      runtime.tryEmitInfo(
        ctx.hasUI,
        ctx.ui,
        `Observational memory: reflector skipping ${(resolved.model as any).provider}/${(resolved.model as any).id} (context window ${effectiveRefCtx.toLocaleString()} too small for ~${reflectorEstimatedInput.toLocaleString()}-token input)`,
      );
      continue;
    }

    try {
      const { runReflector } = await import("./agents/reflector/agent.js");
      const result = await runWorkerAttempt(
        "reflector",
        runtime.config.workerAttemptTimeoutMs,
        generation.signal,
        (signal) =>
          runReflector({
            model: resolved.model as any,
            apiKey: resolved.apiKey,
            headers: withProviderAttributionHeaders(
              resolved.model as any,
              resolved.headers,
              sessionId,
            ),
            env: resolved.env,
            reflections: input.newReflections,
            observations: input.newObservations,
            existingReflectionsSummary: input.existingReflectionsSummary || undefined,
            existingObservationsSummary: input.existingObservationsSummary || undefined,
            maxTurns: runtime.config.agentMaxTurns,
            thinkingLevel: stageThinkingLevel(runtime, "reflector", stageModelForThinking),
            providerIdleTimeoutMs: runtime.config.providerIdleTimeoutMs,
            signal,
            modelRegistry: ctx.modelRegistry,
            sessionId,
            cacheRetention: runtime.config.cacheRetention,
          }),
      );
      if (!runtime.isGenerationActive(generation))
        return { outcome: "abort", sameRunReflections: [] };

      return commitReflectorResult(result.reflections, result.errorAfterClose, resolved);
    } catch (error) {
      if (!runtime.isGenerationActive(generation))
        return { outcome: "abort", sameRunReflections: [] };
      if (isStaleExtensionContextError(error)) {
        debugLog("reflector.stale_ctx", { error: String(error) });
        return { outcome: "abort", sameRunReflections: [] };
      }
      // Any error reaching this point ran a model that fit: error semantics
      // own the outcome from here, so the shrink-to-fit pass stays out.
      sawAttemptError = true;
      const candidateConfig = stageModelForThinking;
      runtime.recordRetryableError(candidateConfig, error, "reflector");
      if (!candidateConfig) runtime.recordDeterministicError(resolved.model, error, "reflector");
      debugLog("reflector.error", {
        error: String(error),
        retryable: isRetryableError(error),
        deterministic: isDeterministicError(error),
        cooldownWorthy: isCooldownWorthyError(error),
        // Reflections recorded before the run failed and discarded with it.
        discardedCount: getDiscardedCount(error),
      });
      // A timed-out session model has no candidate config to cool down, so
      // retrying would stall on the same model for the full deadline again. A
      // session model cut off by the agent turn cap fails the same way for the
      // same reason: `agentMaxTurns` is global config, so a retry spends another
      // whole budget on an identical outcome. Candidates differ — they cool down
      // and the fallback chain takes over.
      if (
        !candidateConfig &&
        (error instanceof WorkerAttemptTimeoutError ||
          (error instanceof WorkerStreamError && error.turnCapExhausted))
      )
        break;
      continue;
    }
  }

  runtime.recordConsolidationStageError(
    ctx,
    "reflector",
    new Error("Reflector: all model candidates exhausted"),
  );
  return { outcome: "abort", sameRunReflections: [] };
}

// ── Dropper stage (with fallback) ───────────────────────────────────────────

/**
 * Snapshot of everything one dropper run needs from the branch: computed once
 * per stage invocation (entries are fixed for the run) and shared by the
 * normal attempt loop and the shrink-to-fit batch pass.
 */
function computeDropperInput(
  runtime: Runtime,
  entries: Entry[],
  sessionId: string,
  sameRunReflections: Reflection[],
  dropTokens: number,
  pressureRun: boolean,
  pendingOverride?: PendingOMState,
) {
  const folded = foldLedger(entries);
  const pending =
    pendingOverride ?? (isManualMode(runtime.config) ? readPendingState(sessionId) : undefined);
  const lastDropIdx = pending ? -1 : latestCoverageIndex(entries, OM_OBSERVATIONS_DROPPED);
  // Candidate scope: a pressure run gets the whole live pool (with an empty
  // post-drop delta there is nothing else to prune), cadence runs keep the
  // post-last-drop delta — pending batches in manual mode, branch markers
  // otherwise.
  const newObservations = pressureRun
    ? livePoolObservations(entries, pending)
    : pending
      ? pendingObservationsCreatedAfter(pending, entries, pending.dropped?.coversUpToId)
      : observationsCreatedAfterIndex(entries, lastDropIdx);
  const dropperNewObsTokens = Math.ceil(
    newObservations.reduce((s: number, o: any) => s + o.content.length, 0) / 4,
  );
  const dropperSummaryBudget = Math.floor(runtime.config.dropperInputMaxTokens * 0.2);
  // Deliberately uncapped: the prompt carries every candidate observation, so
  // this has to be the size that will actually be sent — capping it at
  // dropperInputMaxTokens would hide an oversized pressure prompt from the
  // context-window check below and hand it to a model that cannot hold it.
  const dropperInputTokens = dropperNewObsTokens + dropperSummaryBudget;
  // Adjust accumulated for pending coverage in manual mode
  let effectiveDropTokens = dropTokens;
  if (isManualMode(runtime.config)) {
    if (pending?.dropped?.coversUpToId) {
      const idx = entryIndexForId(entries, pending.dropped.coversUpToId);
      if (idx >= 0) effectiveDropTokens = rawTokensAfterIndex(entries, idx);
    }
  }
  // Existing active observations summary for context (capped).
  // In manual mode, merge accumulated pending batches with
  // branch data (preserving pre-switch markers).
  const sourceObsForDropper = pending
    ? [
        ...folded.activeObservations,
        ...(pending.observationBatches ?? []).flatMap(
          (b: any) => (b.data as any)?.observations ?? [],
        ),
      ]
    : folded.activeObservations;
  const existingObservationsSummary = buildExistingObservationsSummary(
    sourceObsForDropper.filter((o: any) => !newObservations.some((no: any) => no.id === o.id)),
    Math.floor(runtime.config.dropperInputMaxTokens * 0.2),
  );
  // In manual mode, merge accumulated reflection batches with
  // branch data (preserving pre-switch markers), matching the
  // dropper's full autoCompact context.
  const pendingReflections = pending
    ? [
        ...folded.reflections,
        ...(pending.reflectionBatches ?? []).flatMap(
          (b: any) => (b.data as any)?.reflections ?? [],
        ),
      ]
    : folded.reflections;
  const reflectionsForDropper = mergeReflections(pendingReflections, sameRunReflections);
  const summaryTokens = estimateStringTokens(existingObservationsSummary);
  return {
    folded,
    pending,
    newObservations,
    dropperNewObsTokens,
    dropperInputTokens,
    effectiveDropTokens,
    existingObservationsSummary,
    summaryTokens,
    reflectionsForDropper,
  };
}

export async function runDropperStage(
  pi: ExtensionAPI,
  runtime: Runtime,
  ctx: ConsolidationCtx,
  generation: RuntimeGeneration,
  resolveModel: (stage: "dropper") => Promise<ResolvedModel | undefined>,
  sameRunReflections: Reflection[],
  sameRunReflectionCoverageId: string | undefined,
): Promise<StageOutcome> {
  if (!runtime.isGenerationActive(generation)) return "abort";
  let entries: Entry[];
  let sessionId: string;
  try {
    entries = ctx.sessionManager.getBranch() as Entry[];
    sessionId = ctx.sessionManager.getSessionId();
  } catch (error) {
    if (isStaleExtensionContextError(error)) {
      debugLog("dropper.stale_ctx", { error: String(error) });
      return "abort";
    }
    throw error;
  }
  let dropTokens = 0;
  let observationCoverageId: string | undefined;
  // One pressure snapshot, taken before the mode-specific gates below and reused
  // by the candidate selection, so the due-check the cursor records and the pool
  // the dropper actually sees all describe the same pool. Manual mode reads the
  // pending file once here and shares it with the gate below.
  const pressurePending = isManualMode(runtime.config) ? readPendingState(sessionId) : undefined;
  const pressurePoolSignature = activePoolSignature(entries, pressurePending);
  const pressureReached = dropperPressureReached(
    runtime.config,
    observationPoolTokens(entries, pressurePending).tokens,
  );
  const pressureAlreadyChecked =
    pressureReached && matchesEmptyPressurePool(runtime, pressurePoolSignature);
  // Pressure bypasses the cadence and new-data gates only while this pool has
  // not already been evaluated under pressure and left unchanged.
  const pressureRun = pressureReached && !pressureAlreadyChecked;
  // Advancing to "skipped"/"not_due" would replace the empty cursor and its
  // signature, re-arming pressure against a pool the dropper already declined —
  // so a pending pressure binding wins over bookkeeping advances.
  const advanceDropperCursor = (entryId: string, state: "skipped" | "not_due"): void => {
    if (!pressureAlreadyChecked) runtime.advanceCursor("dropper", entryId, state);
  };
  if (isManualMode(runtime.config)) {
    const pending = pressurePending ?? readPendingState(sessionId);
    // Check any accumulated batch for unprocessed observations, not just the latest
    const hasPendingObs = (pending.observationBatches ?? []).some(
      (b: any) => (b.data as any)?.observations?.length,
    );
    if (!hasPendingObs && !pressureRun) {
      advanceDropperCursor(entries.at(-1)?.id ?? "unknown", "skipped");
      return "continue";
    }
    observationCoverageId = pending.observation?.coversUpToId;
    if (pending.dropped?.coversUpToId) {
      const obsIdx = entryIndexForId(entries, pending.observation?.coversUpToId ?? "");
      const dropIdx = entryIndexForId(entries, pending.dropped.coversUpToId);
      if (obsIdx >= 0 && dropIdx >= 0 && obsIdx <= dropIdx && !pressureRun) {
        advanceDropperCursor(pending.dropped.coversUpToId, "skipped");
        return "continue";
      }
      if (dropIdx >= 0) {
        dropTokens = rawTokensAfterIndex(entries, dropIdx);
        if (dropTokens < runtime.config.reflectAfterTokens && !pressureRun) {
          advanceDropperCursor(pending.dropped.coversUpToId, "not_due");
          return "continue";
        }
      } else {
        dropTokens = rawTokensSinceDropCoverage(entries);
      }
    } else {
      dropTokens = rawTokensSinceDropCoverage(entries);
    }
  } else {
    dropTokens = rawTokensSinceDropCoverage(entries);
    if (dropTokens < runtime.config.reflectAfterTokens && !pressureRun) {
      advanceDropperCursor(entries.at(-1)?.id ?? "unknown", "not_due");
      return "continue";
    }
    observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
    if (!observationCoverageId && !pressureRun) {
      advanceDropperCursor(entries.at(-1)?.id ?? "unknown", "skipped");
      return "continue";
    }
  }
  // A pressure run must still be able to write its drop result somewhere: with
  // the coverage gates bypassed there may be no observation marker to cover,
  // so fall back to the branch tip rather than skipping the run.
  if (!observationCoverageId) observationCoverageId = entries.at(-1)?.id ?? "unknown";

  // Snapshot the run input once: entries are fixed for this invocation, and
  // both the attempt loop and the shrink-to-fit batch pass share it. The
  // manual-mode pending snapshot is the gate's, not a fresh read.
  const input = computeDropperInput(
    runtime,
    entries,
    sessionId,
    sameRunReflections,
    dropTokens,
    pressureRun,
    pressurePending,
  );
  const dropperStaticTokens = workerStaticPromptTokens("dropper");
  // Reflections travel whole in every prompt (normal and batched), so they
  // ride in the estimated input alongside the candidates — mirroring the
  // reflector's newItemsTokens, which prices both. Content-length/4 matches
  // the existing candidate approximation (line wrappers ride in the margin).
  const dropperReflectionsTokens = Math.ceil(
    input.reflectionsForDropper.reduce((s: number, r: any) => s + r.content.length, 0) / 4,
  );

  // Shared commit tail: normal and batched runs both advance the cursor at
  // most once, after all work for this invocation is done.
  const commitDropperResult = (droppedIds: string[] | undefined): StageOutcome => {
    const latestReflectionCoverageId = isManualMode(runtime.config)
      ? input.pending?.reflection?.coversUpToId
      : latestCoverageMarkerId(entries, OM_REFLECTIONS_RECORDED);
    const effectiveReflectionCoverageId = sameRunReflectionCoverageId ?? latestReflectionCoverageId;
    const coversUpToId = earlierCoverageMarkerId(
      entries,
      observationCoverageId,
      effectiveReflectionCoverageId,
    );
    const data =
      coversUpToId && droppedIds
        ? buildObservationsDroppedData(droppedIds, coversUpToId)
        : undefined;
    if (data && coversUpToId) {
      if (isManualMode(runtime.config)) {
        savePendingDropped(sessionId, { coversUpToId, data });
      } else {
        if (!appendEntry(pi, runtime, generation, OM_OBSERVATIONS_DROPPED, data)) return "abort";
      }
      runtime.advanceCursor("dropper", coversUpToId, "recorded");
    } else {
      // No drops selected (maxDropsAllowed=0 or the model returned no
      // candidates). Under pressure, bind that empty result to the branch tip
      // and to this pool's id signature, so the next due-check skips an
      // unchanged pool instead of repeating the same model call — a pool
      // change rewrites the signature and re-arms pressure.
      runtime.advanceCursor(
        "dropper",
        pressureReached
          ? (entries.at(-1)?.id ?? "unknown")
          : (coversUpToId ?? observationCoverageId ?? entries.at(-1)?.id ?? "unknown"),
        "empty",
        pressureReached ? pressurePoolSignature : undefined,
      );
    }
    return "continue";
  };

  // Shrink-to-fit batching: partition the candidate pool into contiguous
  // batches that each fit the largest resolved window, evaluate every batch
  // with the same pool-wide pressure numbers, merge the raw proposals, and
  // apply the deterministic ranker + global cap once before the single
  // advance. A partial evaluation is never published: any batch failure
  // voids the run with the cursor unmoved.
  const runShrunkBatches = async (best: {
    resolved: ResolvedModel;
    ctx: number;
  }): Promise<StageOutcome> => {
    const bestModel = best.resolved.model as any;
    const stageModelForBatch =
      best.resolved.source === "candidate" ? best.resolved.candidateConfig : undefined;
    // Pool-wide pressure basis (stored counts, the same basis the trigger
    // and the agent use): every batch quotes these numbers.
    const poolTokens = input.newObservations.reduce(
      (s: number, o: any) => s + (typeof o.tokenCount === "number" ? o.tokenCount : 0),
      0,
    );
    const globalMaxDrops = maxDropCountForPool(
      input.newObservations,
      poolTokens,
      runtime.config.observationsPoolMaxTokens,
      runtime.config.dropperPoolFullnessThreshold,
    );
    // Fast path: nothing in the pool is droppable (all-critical, or an
    // under-target cadence delta). Commit the empty result without spending
    // model calls — batching a no-drop pool would only re-prove the cap.
    if (globalMaxDrops <= 0) return commitDropperResult(undefined);
    const batchFixedOverhead =
      input.summaryTokens +
      dropperReflectionsTokens +
      dropperStaticTokens +
      WORKER_TURN_HEADROOM_TOKENS;
    const batchBudget =
      best.ctx - workerOutputReserveTokens(bestModel) - WORKER_SAFETY_MARGIN_TOKENS;
    const itemBudget = batchBudget - batchFixedOverhead;
    if (itemBudget <= 0) return "abort";
    const batches = planPrefixBatches(
      input.newObservations,
      (o) => Math.ceil(o.content.length / 4),
      itemBudget,
    );
    if (input.newObservations.length > 0) {
      // Every batch must fit: a single huge candidate anywhere in the pool
      // would otherwise send an over-window batch, fail at runtime, and void
      // the whole run into an identical retry every cycle. Abort upfront.
      const oversized = batches.find(
        (batch) =>
          batch.reduce((s, o) => s + Math.ceil(o.content.length / 4), 0) + batchFixedOverhead >
          batchBudget,
      );
      if (oversized) return "abort";
    }
    const planned = batches.length > 0 ? batches : [[] as typeof input.newObservations];
    // Unbounded by design (the pool clears on commit), so log the plan shape
    // upfront: batch count × sizes is the cost multiplier for this run.
    debugLog("dropper.batch_plan", {
      batchCount: planned.length,
      batchSizes: planned.map((b) => b.length),
      candidateCount: input.newObservations.length,
      model: `${bestModel.provider}/${bestModel.id}`,
    });
    runtime.tryEmitWorkerInfo(
      ctx.hasUI,
      ctx.ui,
      `Observational memory: dropper batching ${input.newObservations.length} candidates into ${planned.length} fit-to-window batches on ${bestModel.provider}/${bestModel.id}`,
    );
    const seen = new Set<string>();
    const mergedProposals: string[] = [];
    for (let batchIndex = 0; batchIndex < planned.length; batchIndex++) {
      const batch = planned[batchIndex];
      if (!runtime.isGenerationActive(generation)) return "abort";
      if (batch.length === 0) continue;
      debugLog("dropper.batch_start", {
        batchIndex,
        batchCount: planned.length,
        batchCandidateCount: batch.length,
        model: `${bestModel.provider}/${bestModel.id}`,
      });
      try {
        const { runDropper } = await import("./agents/dropper/agent.js");
        const proposed = await runWorkerAttempt(
          "dropper",
          runtime.config.workerAttemptTimeoutMs,
          generation.signal,
          (signal) =>
            runDropper({
              model: bestModel,
              apiKey: best.resolved.apiKey,
              headers: withProviderAttributionHeaders(bestModel, best.resolved.headers, sessionId),
              env: best.resolved.env,
              reflections: input.reflectionsForDropper,
              observations: batch,
              existingObservationsSummary: input.existingObservationsSummary || undefined,
              budgetTokens: runtime.config.observationsPoolMaxTokens,
              skipFullness: runtime.config.dropperPoolFullnessThreshold,
              pressure: { tokens: poolTokens, maxDrops: globalMaxDrops },
              rawProposals: true,
              maxTurns: runtime.config.agentMaxTurns,
              thinkingLevel: stageThinkingLevel(runtime, "dropper", stageModelForBatch),
              providerIdleTimeoutMs: runtime.config.providerIdleTimeoutMs,
              signal,
              modelRegistry: ctx.modelRegistry,
              sessionId,
              cacheRetention: runtime.config.cacheRetention,
            }),
        );
        if (!runtime.isGenerationActive(generation)) return "abort";
        for (const id of proposed ?? []) {
          if (!seen.has(id)) {
            seen.add(id);
            mergedProposals.push(id);
          }
        }
      } catch (error) {
        if (!runtime.isGenerationActive(generation)) return "abort";
        if (isStaleExtensionContextError(error)) {
          debugLog("dropper.stale_ctx", { error: String(error) });
          return "abort";
        }
        // Batch failure voids the run with the cursor unmoved; the next cycle
        // retries the whole input. Classified like a normal attempt failure.
        const candidateConfig = stageModelForBatch;
        runtime.recordRetryableError(candidateConfig, error, "dropper");
        if (!candidateConfig) runtime.recordDeterministicError(bestModel, error, "dropper");
        debugLog("dropper.error", {
          error: String(error),
          retryable: isRetryableError(error),
          deterministic: isDeterministicError(error),
          cooldownWorthy: isCooldownWorthyError(error),
          discardedCount: getDiscardedCount(error),
        });
        runtime.recordConsolidationStageError(ctx, "dropper", error);
        return "abort";
      }
    }
    const selected = selectDropCandidates(
      mergedProposals,
      input.newObservations,
      globalMaxDrops,
      input.reflectionsForDropper,
    );
    return commitDropperResult(selected.length > 0 ? selected : undefined);
  };

  // Largest-window model resolved so far (shrink target) and whether any
  // attempt ran a model and failed (which keeps error semantics owning the
  // outcome — the shrink pass only triggers on a pure size-mismatch record).
  let bestFit: { resolved: ResolvedModel; ctx: number } | undefined;
  let sawAttemptError = false;

  for (let attempt = 0; attempt < MAX_STAGE_ATTEMPTS; attempt++) {
    const resolved = await resolveModel("dropper");
    if (!runtime.isGenerationActive(generation)) return "abort";
    if (!resolved) {
      // Total exhaustion on a pure size-mismatch record: batch the pool to
      // the largest resolved window and commit once, instead of aborting.
      if (bestFit && !sawAttemptError) return runShrunkBatches(bestFit);
      return "abort";
    }

    runtime.tryEmitWorkerInfo(
      ctx.hasUI,
      ctx.ui,
      `Observational memory: dropper running (~${input.effectiveDropTokens.toLocaleString()} tokens accumulated, ~${input.dropperInputTokens.toLocaleString()}-token input)`,
    );

    // Candidate provenance is captured during resolution so a settings reload
    // cannot change which model config owns this attempt.
    const stageModelForThinking =
      resolved.source === "candidate" ? resolved.candidateConfig : undefined;

    // Check if the full estimated prompt fits in the model's context window:
    // candidates + reflections + actual (capped) summary + measured static
    // overhead (system, the one tool schema, framing) + headroom for later
    // tool turns, against the window minus the output allowance and a safety
    // margin.
    const effectiveDropCtx = effectiveContextWindow(resolved.model as any, stageModelForThinking);
    if (!bestFit || effectiveDropCtx > bestFit.ctx) bestFit = { resolved, ctx: effectiveDropCtx };
    const dropperEstimatedInput =
      input.dropperNewObsTokens +
      dropperReflectionsTokens +
      input.summaryTokens +
      dropperStaticTokens +
      WORKER_TURN_HEADROOM_TOKENS;
    const dropperInputBudget =
      effectiveDropCtx -
      workerOutputReserveTokens(resolved.model as any) -
      WORKER_SAFETY_MARGIN_TOKENS;
    if (dropperEstimatedInput > dropperInputBudget) {
      debugLog("dropper.context_window_exceeded", {
        estimatedInput: dropperEstimatedInput,
        inputBudget: dropperInputBudget,
        newObsTokens: input.dropperNewObsTokens,
        reflectionsTokens: dropperReflectionsTokens,
        summaryTokens: input.summaryTokens,
        staticTokens: dropperStaticTokens,
        effectiveCtx: effectiveDropCtx,
        model: `${(resolved.model as any).provider}/${(resolved.model as any).id}`,
      });
      // Size-skip only: a too-small window is not a broken model, so this
      // never writes a persisted cooldown. The in-cycle skip advances the
      // fallback chain within this run.
      const resolvedIdentity = resolved.model as { provider?: unknown; id?: unknown };
      runtime.skipOversizedForCycle(
        stageModelForThinking ??
          (typeof resolvedIdentity.provider === "string" && typeof resolvedIdentity.id === "string"
            ? { provider: resolvedIdentity.provider, id: resolvedIdentity.id }
            : undefined),
      );
      runtime.tryEmitInfo(
        ctx.hasUI,
        ctx.ui,
        `Observational memory: dropper skipping ${(resolved.model as any).provider}/${(resolved.model as any).id} (context window ${effectiveDropCtx.toLocaleString()} too small for ~${dropperEstimatedInput.toLocaleString()}-token input)`,
      );
      continue;
    }

    try {
      const { runDropper } = await import("./agents/dropper/agent.js");
      const droppedIds = await runWorkerAttempt(
        "dropper",
        runtime.config.workerAttemptTimeoutMs,
        generation.signal,
        (signal) =>
          runDropper({
            model: resolved.model as any,
            apiKey: resolved.apiKey,
            headers: withProviderAttributionHeaders(
              resolved.model as any,
              resolved.headers,
              sessionId,
            ),
            env: resolved.env,
            reflections: input.reflectionsForDropper,
            observations: input.newObservations,
            existingObservationsSummary: input.existingObservationsSummary || undefined,
            budgetTokens: runtime.config.observationsPoolMaxTokens,
            skipFullness: runtime.config.dropperPoolFullnessThreshold,
            maxTurns: runtime.config.agentMaxTurns,
            thinkingLevel: stageThinkingLevel(runtime, "dropper", stageModelForThinking),
            providerIdleTimeoutMs: runtime.config.providerIdleTimeoutMs,
            signal,
            modelRegistry: ctx.modelRegistry,
            sessionId,
            cacheRetention: runtime.config.cacheRetention,
          }),
      );
      if (!runtime.isGenerationActive(generation)) return "abort";
      return commitDropperResult(droppedIds);
    } catch (error) {
      if (!runtime.isGenerationActive(generation)) return "abort";
      if (isStaleExtensionContextError(error)) {
        debugLog("dropper.stale_ctx", { error: String(error) });
        return "abort";
      }
      // Any error reaching this point ran a model that fit: error semantics
      // own the outcome from here, so the shrink-to-fit pass stays out.
      sawAttemptError = true;
      const candidateConfig = stageModelForThinking;
      runtime.recordRetryableError(candidateConfig, error, "dropper");
      if (!candidateConfig) runtime.recordDeterministicError(resolved.model, error, "dropper");
      debugLog("dropper.error", {
        error: String(error),
        retryable: isRetryableError(error),
        deterministic: isDeterministicError(error),
        cooldownWorthy: isCooldownWorthyError(error),
        // Drop candidates recorded before the run failed and discarded with it.
        discardedCount: getDiscardedCount(error),
      });
      // A timed-out session model has no candidate config to cool down, so
      // retrying would stall on the same model for the full deadline again. A
      // session model cut off by the agent turn cap fails the same way for the
      // same reason: `agentMaxTurns` is global config, so a retry spends another
      // whole budget on an identical outcome. Candidates differ — they cool down
      // and the fallback chain takes over.
      if (
        !candidateConfig &&
        (error instanceof WorkerAttemptTimeoutError ||
          (error instanceof WorkerStreamError && error.turnCapExhausted))
      )
        break;
      continue;
    }
  }

  runtime.recordConsolidationStageError(
    ctx,
    "dropper",
    new Error("Dropper: all model candidates exhausted"),
  );
  return "abort";
}
