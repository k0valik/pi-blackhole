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
  isCooldownWorthyError,
  isDeterministicError,
  isRetryableError,
  isStaleExtensionContextError,
} from "./retryable-error.js";
import { effectiveContextWindow } from "./model-budget.js";
import { estimateEntryTokens, estimateStringTokens } from "./tokens.js";
import { serializeSourceAddressedBranchEntries } from "./serialize.js";
import { OBSERVER_SYSTEM } from "./agents/observer/prompts.js";

/** Fixed overhead for system prompt, tool definitions, and turn scaffold in context window pre-check. */
const AGENT_LOOP_RESERVE = 8_000;
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

function sourceEntriesAfter(entries: Entry[], index: number): Entry[] {
  return entries.slice(index + 1).filter(isSourceEntry);
}

/**
 * Cap source entries to maxTokens by keeping newest entries first,
 * walking backwards until the token budget is exceeded.
 * Reuses estimateEntryTokens (the same estimator rawTokensAfterIndex uses for
 * the trigger) so the cap and the trigger never drift apart (#110).
 */
export function capSourceEntriesToTokens(entries: Entry[], maxTokens: number): Entry[] {
  let totalTokens = 0;
  const kept: Entry[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const estTokens = estimateEntryTokens(entry);
    if (totalTokens + estTokens > maxTokens) {
      // Newest-first walk stops as soon as the budget is exceeded — except
      // for the newest entry itself: a single oversized entry is still
      // included (kept.length === 0) so the newest data is never lost.
      if (kept.length > 0) break;
      kept.unshift(entry);
      break;
    }
    kept.unshift(entry);
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

          // Pressure check: pool ≥ threshold × reflectorInputMaxTokens
          const pressure =
            poolTokens >= config.dropperPressureThreshold * config.reflectorInputMaxTokens;
          if (pressure) return true;

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

// ── Observer stage (with fallback) ──────────────────────────────────────────

export async function runObserverStage(
  pi: ExtensionAPI,
  runtime: Runtime,
  ctx: ConsolidationCtx,
  generation: RuntimeGeneration,
  resolveModel: (stage: "observer") => Promise<ResolvedModel | undefined>,
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
  if (tokens < runtime.config.observeAfterTokens) {
    // Not due. Keep the anchor at the measured coverage point rather than the
    // newest entry: below-threshold content is still unobserved, so moving the
    // cursor past it would drop it permanently instead of letting it accumulate.
    const anchorId = effectiveStart >= 0 ? entries[effectiveStart]?.id : undefined;
    if (anchorId) runtime.advanceCursor("observer", anchorId, "not_due");
    return "continue";
  }

  let chunkEntries = sourceEntriesAfter(entries, effectiveStart);

  // Cap observer input to observerChunkMaxTokens (newest-to-oldest)
  const maxChunkTokens = runtime.config.observerChunkMaxTokens;
  if (tokens > maxChunkTokens) {
    chunkEntries = capSourceEntriesToTokens(chunkEntries, maxChunkTokens);
  }

  // coversUpToId must point to the LAST entry AFTER capping, not before
  const coversUpToId = chunkEntries.at(-1)?.id;
  if (!coversUpToId) return "continue";

  const {
    text: chunk,
    sourceEntryIds,
    sourceEntryTimestamps,
  } = serializeSourceAddressedBranchEntries(chunkEntries);
  if (!chunk.trim() || sourceEntryIds.length === 0) return "continue";
  const chunkTokens = Math.ceil(chunk.length / 4);
  // Issue #110 follow-up: expose the post-cap size on the normal path (the
  // exceptional context_window_exceeded path already logs estimatedInput).
  // capTokens is the exact quantity capSourceEntriesToTokens enforced (the
  // same estimateEntryTokens the trigger uses), so it can confirm/rule out
  // the cap bug in a running install.
  const capTokens = chunkEntries.reduce((s: number, e) => s + estimateEntryTokens(e), 0);

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

  // If manual mode: skip if this exact chunk was already processed
  if (isManualMode(runtime.config) && isObservationChunkPending(sessionId, coversUpToId)) {
    debugLog("observer.pending_skip", { coversUpToId, sessionId });
    return "continue";
  }

  for (let attempt = 0; attempt < MAX_STAGE_ATTEMPTS; attempt++) {
    const resolved = await resolveModel("observer");
    if (!runtime.isGenerationActive(generation) || !resolved) return "abort";

    // Adjust accumulated for pending coverage in manual mode
    let effectiveTokens = tokens;
    if (isManualMode(runtime.config)) {
      const pending = readPendingState(sessionId);
      if (pending.observation?.coversUpToId) {
        const idx = entryIndexForId(entries, pending.observation.coversUpToId);
        if (idx >= 0) effectiveTokens = rawTokensAfterIndex(entries, idx);
      }
    }
    runtime.tryEmitInfo(
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
    // chunk + rendered preamble + system prompt, plus the agent-loop reserve
    // for tool definitions and turn scaffold. (The reserve also names the
    // system prompt, so this slightly over-counts — safe direction for a
    // pre-flight guard.)
    const effectiveObsCtx = effectiveContextWindow(resolved.model as any, stageModelForThinking);
    const observerEstimatedInput =
      chunkTokens + preambleTokens + observerSystemTokens + AGENT_LOOP_RESERVE;
    if (observerEstimatedInput > effectiveObsCtx) {
      debugLog("observer.context_window_exceeded", {
        estimatedInput: observerEstimatedInput,
        chunkTokens,
        preambleTokens,
        systemTokens: observerSystemTokens,
        effectiveCtx: effectiveObsCtx,
        model: `${(resolved.model as any).provider}/${(resolved.model as any).id}`,
      });
      runtime.recordRetryableError(
        stageModelForThinking,
        new Error(
          `context window ${effectiveObsCtx} too small for estimated input ${observerEstimatedInput}`,
        ),
        "observer",
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
          }),
      );
      if (!runtime.isGenerationActive(generation)) return "abort";

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
        runtime.tryEmitInfo(
          ctx.hasUI,
          ctx.ui,
          `Observational memory: ${result.observations.length} observation${result.observations.length === 1 ? "" : "s"} recorded`,
        );
        return "continue";
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
        runtime.tryEmitInfo(
          ctx.hasUI,
          ctx.ui,
          `Observational memory: no observations — ${reasonLabel}`,
        );
      }
      return "continue";
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
      const candidateConfig = stageModelForThinking;
      runtime.recordRetryableError(candidateConfig, error, "observer");
      if (!candidateConfig) runtime.recordDeterministicError(resolved.model, error, "observer");
      debugLog("observer.error", {
        error: String(error),
        retryable: isRetryableError(error),
        deterministic: isDeterministicError(error),
        cooldownWorthy: isCooldownWorthyError(error),
      });
      // A timed-out session model has no candidate config to cool down, so
      // the loop would re-resolve the same stalled model and burn the full
      // deadline on every remaining attempt. Treat the stage as exhausted.
      if (!candidateConfig && error instanceof WorkerAttemptTimeoutError) break;
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

// ── Reflector stage (with fallback) ─────────────────────────────────────────

async function runReflectorStage(
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

  for (let attempt = 0; attempt < MAX_STAGE_ATTEMPTS; attempt++) {
    const resolved = await resolveModel("reflector");
    if (!runtime.isGenerationActive(generation) || !resolved)
      return { outcome: "abort", sameRunReflections: [] };

    // Compute ahead for an accurate notification
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
    debugLog("reflector.start", {
      tokens: effectiveReflectionTokens,
      inputTokens: reflectorInputTokens,
      newObsCount: newObservations.length,
      newRefCount: newReflections.length,
    });
    runtime.tryEmitInfo(
      ctx.hasUI,
      ctx.ui,
      `Observational memory: reflector running (~${effectiveReflectionTokens.toLocaleString()} tokens accumulated, ~${reflectorInputTokens.toLocaleString()}-token input)`,
    );

    // Candidate provenance is captured during resolution so a settings reload
    // cannot change which model config owns this attempt.
    const stageModelForThinking =
      resolved.source === "candidate" ? resolved.candidateConfig : undefined;

    // Check if estimated input fits in model's context window
    // Use actual computed input size (new items + summary budget) instead of cap
    const effectiveRefCtx = effectiveContextWindow(resolved.model as any, stageModelForThinking);
    const reflectorEstimatedInput = reflectorInputTokens + AGENT_LOOP_RESERVE;
    if (reflectorEstimatedInput > effectiveRefCtx) {
      debugLog("reflector.context_window_exceeded", {
        estimatedInput: reflectorEstimatedInput,
        effectiveCtx: effectiveRefCtx,
        model: `${(resolved.model as any).provider}/${(resolved.model as any).id}`,
      });
      runtime.recordRetryableError(
        stageModelForThinking,
        new Error(
          `context window ${effectiveRefCtx} too small for estimated input ${reflectorEstimatedInput}`,
        ),
        "reflector",
      );
      runtime.tryEmitInfo(
        ctx.hasUI,
        ctx.ui,
        `Observational memory: reflector skipping ${(resolved.model as any).provider}/${(resolved.model as any).id} (context window ${effectiveRefCtx.toLocaleString()} too small for ~${reflectorEstimatedInput.toLocaleString()}-token input)`,
      );
      continue;
    }

    try {
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

      const { runReflector } = await import("./agents/reflector/agent.js");
      const reflections = await runWorkerAttempt(
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
            reflections: newReflections,
            observations: newObservations,
            existingReflectionsSummary: existingReflectionsSummary || undefined,
            existingObservationsSummary: existingObservationsSummary || undefined,
            maxTurns: runtime.config.agentMaxTurns,
            thinkingLevel: stageThinkingLevel(runtime, "reflector", stageModelForThinking),
            providerIdleTimeoutMs: runtime.config.providerIdleTimeoutMs,
            signal,
            modelRegistry: ctx.modelRegistry,
            sessionId,
          }),
      );
      if (!runtime.isGenerationActive(generation))
        return { outcome: "abort", sameRunReflections: [] };

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
    } catch (error) {
      if (!runtime.isGenerationActive(generation))
        return { outcome: "abort", sameRunReflections: [] };
      if (isStaleExtensionContextError(error)) {
        debugLog("reflector.stale_ctx", { error: String(error) });
        return { outcome: "abort", sameRunReflections: [] };
      }
      const candidateConfig = stageModelForThinking;
      runtime.recordRetryableError(candidateConfig, error, "reflector");
      if (!candidateConfig) runtime.recordDeterministicError(resolved.model, error, "reflector");
      debugLog("reflector.error", {
        error: String(error),
        retryable: isRetryableError(error),
        deterministic: isDeterministicError(error),
        cooldownWorthy: isCooldownWorthyError(error),
      });
      // A timed-out session model has no candidate config to cool down, so
      // retrying would stall on the same model for the full deadline again.
      if (!candidateConfig && error instanceof WorkerAttemptTimeoutError) break;
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

async function runDropperStage(
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
  if (isManualMode(runtime.config)) {
    const pending = readPendingState(sessionId);
    // Check any accumulated batch for unprocessed observations, not just the latest
    const hasPendingObs = (pending.observationBatches ?? []).some(
      (b: any) => (b.data as any)?.observations?.length,
    );
    if (!hasPendingObs) {
      runtime.advanceCursor("dropper", entries.at(-1)?.id ?? "unknown", "skipped");
      return "continue";
    }
    observationCoverageId = pending.observation?.coversUpToId;
    if (pending.dropped?.coversUpToId) {
      const obsIdx = entryIndexForId(entries, pending.observation?.coversUpToId ?? "");
      const dropIdx = entryIndexForId(entries, pending.dropped.coversUpToId);
      if (obsIdx >= 0 && dropIdx >= 0 && obsIdx <= dropIdx) {
        runtime.advanceCursor("dropper", pending.dropped.coversUpToId, "skipped");
        return "continue";
      }
      if (dropIdx >= 0) {
        dropTokens = rawTokensAfterIndex(entries, dropIdx);
        if (dropTokens < runtime.config.reflectAfterTokens) {
          runtime.advanceCursor("dropper", pending.dropped.coversUpToId, "not_due");
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
    if (dropTokens < runtime.config.reflectAfterTokens) {
      runtime.advanceCursor("dropper", entries.at(-1)?.id ?? "unknown", "not_due");
      return "continue";
    }
    observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
    if (!observationCoverageId) {
      runtime.advanceCursor("dropper", entries.at(-1)?.id ?? "unknown", "skipped");
      return "continue";
    }
  }

  for (let attempt = 0; attempt < MAX_STAGE_ATTEMPTS; attempt++) {
    const resolved = await resolveModel("dropper");
    if (!runtime.isGenerationActive(generation) || !resolved) return "abort";

    // Compute ahead for an accurate notification
    const folded = foldLedger(entries);
    const pending = isManualMode(runtime.config) ? readPendingState(sessionId) : undefined;
    const lastDropIdx = pending ? -1 : latestCoverageIndex(entries, OM_OBSERVATIONS_DROPPED);
    const newObservations = pending
      ? pendingObservationsCreatedAfter(pending, entries, pending.dropped?.coversUpToId)
      : observationsCreatedAfterIndex(entries, lastDropIdx);
    const dropperNewObsTokens = Math.ceil(
      newObservations.reduce((s: number, o: any) => s + o.content.length, 0) / 4,
    );
    const dropperSummaryBudget = Math.floor(runtime.config.dropperInputMaxTokens * 0.2);
    const dropperInputTokens = Math.min(
      dropperNewObsTokens + dropperSummaryBudget,
      runtime.config.dropperInputMaxTokens,
    );
    // Adjust accumulated for pending coverage in manual mode
    let effectiveDropTokens = dropTokens;
    if (isManualMode(runtime.config)) {
      if (pending?.dropped?.coversUpToId) {
        const idx = entryIndexForId(entries, pending.dropped.coversUpToId);
        if (idx >= 0) effectiveDropTokens = rawTokensAfterIndex(entries, idx);
      }
    }
    runtime.tryEmitInfo(
      ctx.hasUI,
      ctx.ui,
      `Observational memory: dropper running (~${effectiveDropTokens.toLocaleString()} tokens accumulated, ~${dropperInputTokens.toLocaleString()}-token input)`,
    );

    // Candidate provenance is captured during resolution so a settings reload
    // cannot change which model config owns this attempt.
    const stageModelForThinking =
      resolved.source === "candidate" ? resolved.candidateConfig : undefined;

    try {
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

      // Check if estimated input fits in model's context window
      // Use actual computed input size (new observations + summary budget) instead of cap
      const effectiveDropCtx = effectiveContextWindow(resolved.model as any, stageModelForThinking);
      const dropperEstimatedInput = dropperInputTokens + AGENT_LOOP_RESERVE;
      if (dropperEstimatedInput > effectiveDropCtx) {
        debugLog("dropper.context_window_exceeded", {
          estimatedInput: dropperEstimatedInput,
          effectiveCtx: effectiveDropCtx,
          model: `${(resolved.model as any).provider}/${(resolved.model as any).id}`,
        });
        runtime.recordRetryableError(
          stageModelForThinking,
          new Error(
            `context window ${effectiveDropCtx} too small for estimated input ${dropperEstimatedInput}`,
          ),
          "dropper",
        );
        runtime.tryEmitInfo(
          ctx.hasUI,
          ctx.ui,
          `Observational memory: dropper skipping ${(resolved.model as any).provider}/${(resolved.model as any).id} (context window ${effectiveDropCtx.toLocaleString()} too small for ~${dropperEstimatedInput.toLocaleString()}-token input)`,
        );
        continue;
      }

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
            reflections: reflectionsForDropper,
            observations: newObservations,
            existingObservationsSummary: existingObservationsSummary || undefined,
            budgetTokens: runtime.config.observationsPoolMaxTokens,
            skipFullness: runtime.config.dropperPoolFullnessThreshold,
            maxTurns: runtime.config.agentMaxTurns,
            thinkingLevel: stageThinkingLevel(runtime, "dropper", stageModelForThinking),
            providerIdleTimeoutMs: runtime.config.providerIdleTimeoutMs,
            signal,
            modelRegistry: ctx.modelRegistry,
            sessionId,
          }),
      );
      if (!runtime.isGenerationActive(generation)) return "abort";
      const latestReflectionCoverageId = isManualMode(runtime.config)
        ? pending?.reflection?.coversUpToId
        : latestCoverageMarkerId(entries, OM_REFLECTIONS_RECORDED);
      const effectiveReflectionCoverageId =
        sameRunReflectionCoverageId ?? latestReflectionCoverageId;
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
        // No drops selected (maxDropsAllowed=0 or LLM returned no candidates)
        runtime.advanceCursor(
          "dropper",
          coversUpToId ?? observationCoverageId ?? entries.at(-1)?.id ?? "unknown",
          "empty",
        );
      }
      return "continue";
    } catch (error) {
      if (!runtime.isGenerationActive(generation)) return "abort";
      if (isStaleExtensionContextError(error)) {
        debugLog("dropper.stale_ctx", { error: String(error) });
        return "abort";
      }
      const candidateConfig = stageModelForThinking;
      runtime.recordRetryableError(candidateConfig, error, "dropper");
      if (!candidateConfig) runtime.recordDeterministicError(resolved.model, error, "dropper");
      debugLog("dropper.error", {
        error: String(error),
        retryable: isRetryableError(error),
        deterministic: isDeterministicError(error),
        cooldownWorthy: isCooldownWorthyError(error),
      });
      // A timed-out session model has no candidate config to cool down, so
      // retrying would stall on the same model for the full deadline again.
      if (!candidateConfig && error instanceof WorkerAttemptTimeoutError) break;
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
