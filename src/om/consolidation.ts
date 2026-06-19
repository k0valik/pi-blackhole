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
import { runDropper } from "./agents/dropper/agent.js";
import { runObserver } from "./agents/observer/agent.js";
import { runReflector } from "./agents/reflector/agent.js";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ConfiguredModel } from "./config.js";
import { debugLog, withDebugLogContext } from "./debug-log.js";
import { type ResolveResult, type Runtime } from "./runtime.js";
import { isRetryableError } from "./retryable-error.js";
import { effectiveContextWindow } from "./model-budget.js";
import { serializeSourceAddressedBranchEntries } from "./serialize.js";

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
	observationToSummaryLine,
	rawTokensAfterIndex,
	rawTokensSinceDropCoverage,
	rawTokensSinceObservationCoverage,
	rawTokensSinceReflectionCoverage,
	reflectionToSummaryLine,
	reflectionsCreatedAfterIndex,
	selectPriorObservations,
	type Entry,
	type Observation,
	type Reflection,
} from "./ledger/index.js";

export type ResolvedModel = Extract<ResolveResult, { ok: true }>;

export type ConsolidationCtx = {
	cwd: string;
	hasUI: boolean;
	ui?: { notify: (message: string, type?: "warning" | "info" | "error") => void };
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
 * Uses a conservative chars/4 heuristic for token estimation.
 */
function capSourceEntriesToTokens(entries: Entry[], maxTokens: number): Entry[] {
	let totalTokens = 0;
	const kept: Entry[] = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		let chars = 0;
		// Tokenize all entry types, not just "message": custom_message and
		// branch_summary entries also consume observer context window.
		if (entry.type === "message" && entry.message) {
			const msg = entry.message as any;
			if (typeof msg.content === "string") chars = msg.content.length;
			else if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.text) chars += block.text.length;
				}
			}
		} else if (entry.type === "custom" && (entry.customType === OM_OBSERVATIONS_RECORDED || entry.customType === OM_REFLECTIONS_RECORDED || entry.customType === OM_OBSERVATIONS_DROPPED)) {
			// Custom entries carry structured data — estimate from JSON serialization
			chars = String(JSON.stringify(entry.data ?? {})).length;
		} else if (entry.summary) {
			chars = String(entry.summary).length;
		}
		const estTokens = Math.ceil(chars / 4);
		if (totalTokens + estTokens > maxTokens && kept.length > 0) break;
		// Remove the `kept.length > 0` guard? No — keep the guard but allow
		// the first entry to be dropped only if it exceeds maxTokens alone.
		// (The guard against empty kept list prevents dropping the first entry
		// when later entries are small; but a single oversized entry should
		// still be included to avoid losing the newest data entirely.)
		if (totalTokens + estTokens > maxTokens && kept.length === 0) {
			// First (newest) entry exceeds maxTokens alone — include it anyway
			// to avoid data loss, but don't add more.
			kept.unshift(entry);
			break;
		}
		kept.unshift(entry);
		totalTokens += estTokens;
	}
	return kept;
}

function appendEntry(pi: ExtensionAPI, customType: string, data: unknown): void {
	pi.appendEntry(customType, data);
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
 * This is needed in noAutoCompact mode because the reflector/dropper may skip
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
		const tokensSince = idx >= 0
			? rawTokensAfterIndex(entries, idx)
			: rawTokensSinceObservationCoverage(entries);
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
				return true;
			}
		}
		// In manual mode, also check pending observation batches that arrived
		// after the cursor (since branch has no OM markers).
		if (pending && cursor.state !== "initial") {
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
	const dropperDue = observerDue || reflectorDue ? false : (() => {
		// Compute active observation pool tokens (branch + pending in manual mode)
		const folded = foldLedger(entries);
		let poolTokens = folded.activeObservations.reduce(
			(s: number, o: Observation) => s + (o.tokenCount ?? 0),
			0,
		);
		// In manual mode, include pending observation batches
		if (pending) {
			const pendingBatches = pending.observationBatches ?? [];
			for (const batch of pendingBatches) {
				poolTokens += ((batch.data as any)?.observations ?? []).reduce(
					(s: number, o: any) => s + (o.tokenCount ?? 0), 0,
				);
			}
		}
		const fullnessVsPool = config.observationsPoolMaxTokens > 0
			? poolTokens / config.observationsPoolMaxTokens
			: 0;

		// Must have at least 10% fullness to consider dropper
		if (fullnessVsPool < 0.10) return false;

		// Pressure check: pool ≥ threshold × reflectorInputMaxTokens
		const pressure = poolTokens >= config.dropperPressureThreshold * config.reflectorInputMaxTokens;
		if (pressure) return true;

		// New data check: new obs or ref batches after dropper cursor
		const cursor = cursors.dropper;
		if (!cursor) {
			// In manual mode, pending batches are the only source of new‑data
			// visibility (branch has no OM markers).
			const hasPendingNewData = pending
				? (pending.observationBatches?.length ?? 0) > 0 || (pending.reflectionBatches?.length ?? 0) > 0
				: false;
			if (hasPendingNewData) return true;
			return rawTokensSinceDropCoverage(entries) >= config.reflectAfterTokens;
		}
		const idx = entryIndexForId(entries, cursor.entryId);
		if (idx < 0) {
			return rawTokensSinceDropCoverage(entries) >= config.reflectAfterTokens;
		}
		for (let i = idx + 1; i < entries.length; i++) {
			const e = entries[i];
			if (e.type === "custom" && (e.customType === OM_OBSERVATIONS_RECORDED || e.customType === OM_REFLECTIONS_RECORDED)) {
				return true;
			}
		}
		// In manual mode, also check pending batches after the cursor
		if (pending && cursor.state !== "initial") {
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

function stageModelConfig(runtime: Runtime, stage: "observer" | "reflector" | "dropper"): ConfiguredModel | undefined {
	if (stage === "observer") return runtime.config.observerModel;
	if (stage === "reflector") return runtime.config.reflectorModel;
	return runtime.config.dropperModel;
}

function stageFallbackModels(runtime: Runtime, stage: "observer" | "reflector" | "dropper"): ConfiguredModel[] {
	if (stage === "observer") return runtime.config.observerFallbackModels ?? [];
	if (stage === "reflector") return runtime.config.reflectorFallbackModels ?? [];
	return runtime.config.dropperFallbackModels ?? [];
}

function stageThinkingLevel(runtime: Runtime, stage: "observer" | "reflector" | "dropper", modelConfig?: ConfiguredModel): ModelThinkingLevel {
	const stageModel = modelConfig ?? stageModelConfig(runtime, stage);
	return stageModel?.thinking ?? runtime.config.model?.thinking ?? "low";
}

export function makeModelResolver(runtime: Runtime, ctx: ConsolidationCtx): (stage: "observer" | "reflector" | "dropper") => Promise<ResolvedModel | undefined> {
	return async (stage) => {
		const stageFallbacks = stageFallbackModels(runtime, stage);
		const resolved = await runtime.resolveModel({
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			hasUI: ctx.hasUI,
			ui: ctx.ui,
			stageModel: stageModelConfig(runtime, stage),
			stageFallbacks,
		});
		if (resolved.ok) {
			runtime.resolveFailureNotified = false;
			return resolved;
		}
		debugLog(`${stage}.model_unavailable`, { reason: resolved.reason });
		if (!runtime.resolveFailureNotified && ctx.hasUI && ctx.ui) {
			if (runtime.failedInCycle.size > 0 && resolved.reason.includes("all candidates exhausted")) {
				const fallbackMsg = stageFallbacks.length === 0
					? "no fallbacks configured"
					: "no available fallbacks";
				ctx.ui.notify(
					`Observational memory: ${stage} skipped — model unavailable (cooldown set to 0, ${fallbackMsg}, will retry next run)`,
					"info",
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

export function registerConsolidationTrigger(pi: ExtensionAPI, runtime: Runtime): void {
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
	runtime.ensureConfig(ctx.cwd);
	if (runtime.config.memory === false) return;

	// LEGACY: passive check — only applies when new keys are absent (unmigrated config)
	if (runtime.config.compaction === undefined && runtime.config.compactionEngine === undefined) {
		if (runtime.config.passive === true) return;
	}
	if (runtime.consolidationInFlight) return;
	if (runtime.isConsolidationRetryGated()) return;

	// Load and validate cursors from pending file (once per session; re-load on fork)
	const sessionId = ctx.sessionManager.getSessionId();
	if (runtime.cursorsLoadedSessionId !== sessionId) {
		if (typeof runtime.loadCursorsFromPending === "function") {
			runtime.loadCursorsFromPending(sessionId);
		}
		const entries = ctx.sessionManager.getBranch() as Entry[];
		validateCursors(entries, runtime);
		runtime.cursorsLoadedSessionId = sessionId;
		const c = runtime.cursors ?? {};
		debugLog("cursor.loaded", {
			observer: c.observer ?? null,
			reflector: c.reflector ?? null,
			dropper: c.dropper ?? null,
		});
	}

	const entries = ctx.sessionManager.getBranch() as Entry[];
	// In manual mode, the branch has no OM markers — pending state provides
	// pool fullness and new‑data visibility for reflector/dropper checks.
	const pending = runtime.config.noAutoCompact ? readPendingState(sessionId) : undefined;
	if (!anyStageDue(entries, runtime, pending)) return;

	const runId = `consolidation-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
	const consolidationCtx: ConsolidationCtx = {
		cwd: ctx.cwd,
		hasUI: ctx.hasUI,
		ui: ctx.ui,
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
		sessionManager: ctx.sessionManager,
	};

	void runtime.launchConsolidationTask(ctx, async () => withDebugLogContext({ enabled: runtime.config.debugLog === true, cwd: ctx.cwd, runId }, async () => {
		await runConsolidationPipeline(pi, runtime, consolidationCtx);
	}));
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

export async function runConsolidationPipeline(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
): Promise<void> {
	const resolveModel = makeModelResolver(runtime, ctx);

	runtime.consolidationPhase = "observer";
	runtime.failedInCycle.clear();
	runtime.resolveFailureNotified = false;
	try {
		const observerOutcome = await runObserverStage(pi, runtime, ctx, resolveModel);
		if (observerOutcome === "abort") return;
	} catch (error) {
		debugLog("observer.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "observer", error) });
		return;
	}

	runtime.consolidationPhase = "reflector";
	runtime.failedInCycle.clear();
	runtime.resolveFailureNotified = false;
	let reflectorResult: ReflectorStageResult;
	try {
		reflectorResult = await runReflectorStage(pi, runtime, ctx, resolveModel);
		if (reflectorResult.outcome === "abort") return;
	} catch (error) {
		debugLog("reflector.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "reflector", error) });
		return;
	}

	runtime.consolidationPhase = "dropper";
	runtime.failedInCycle.clear();
	runtime.resolveFailureNotified = false;
	try {
		await runDropperStage(pi, runtime, ctx, resolveModel, reflectorResult.sameRunReflections, reflectorResult.effectiveReflectionCoverageId);
	} catch (error) {
		debugLog("dropper.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "dropper", error) });
	}

	// Flush cursors to pending file after all stages complete (non‑blocking)
	const sessionId = ctx.sessionManager.getSessionId();
	runtime.scheduleCursorFlush(sessionId);
	const c = runtime.cursors ?? {};
	debugLog("cursor.saved", {
		observer: c.observer ?? null,
		reflector: c.reflector ?? null,
		dropper: c.dropper ?? null,
	});
}

// ── Observer stage (with fallback) ──────────────────────────────────────────

async function runObserverStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "observer") => Promise<ResolvedModel | undefined>,
): Promise<StageOutcome> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const sessionId = ctx.sessionManager.getSessionId();

	// Determine start index: cursor takes priority, fall back to coverage markers
	const observerCursor = runtime.getCursor("observer");
	let effectiveStart: number;
	if (observerCursor) {
		const cursorIdx = entryIndexForId(entries, observerCursor.entryId);
		effectiveStart = cursorIdx >= 0 ? cursorIdx : latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	} else {
		const lastCoverageIdx = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
		effectiveStart = lastCoverageIdx >= 0 ? lastCoverageIdx : findLastCompactionIndex(entries);
	}

	const tokens = effectiveStart >= 0 ? rawTokensAfterIndex(entries, effectiveStart) : 0;
	if (tokens < runtime.config.observeAfterTokens) {
		// Not due — advance cursor to last source entry so we don't re-check immediately
		const lastSourceId = entries.findLast((e: Entry) => isSourceEntry(e))?.id;
		if (lastSourceId) runtime.advanceCursor("observer", lastSourceId, "not_due");
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

	const { text: chunk, sourceEntryIds } = serializeSourceAddressedBranchEntries(chunkEntries);
	if (!chunk.trim() || sourceEntryIds.length === 0) return "continue";
	const chunkTokens = Math.ceil(chunk.length / 4);

	const memory = fullProjection(entries);
	let priorReflections = memory.reflections.map(reflectionToSummaryLine);
	let priorObservations = memory.observations.map(observationToSummaryLine);

	// In noAutoCompact, append accumulated batch history to whatever
	// fullProjection found in the branch (preserving pre-switch markers
	// when transitioning from autoCompact to noAutoCompact mid-session).
	// The preamble is capped via observerPreambleMaxTokens so accumulated
	// observations don't grow unbounded across turns.
	if (runtime.config.noAutoCompact) {
		const pendingCtx = readPendingState(sessionId);
		const accumulatedReflections = (pendingCtx.reflectionBatches ?? [])
			.flatMap(b => (b.data as any).reflections ?? []);
		const accumulatedObservations = (pendingCtx.observationBatches ?? [])
			.flatMap(b => (b.data as any).observations ?? []);

		// Capped preamble: high always kept, medium/low scored by relevance + recency
		const preambleMaxTokens = runtime.config.observerPreambleMaxTokens > 0
			? runtime.config.observerPreambleMaxTokens
			: Math.round(runtime.config.observerChunkMaxTokens * 0.3);
		const allObservations = [...memory.observations, ...accumulatedObservations];
		priorObservations = selectPriorObservations(allObservations, preambleMaxTokens)
			.map(observationToSummaryLine);

		// Reflections are never trimmed — rare and always kept
		priorReflections = [
			...priorReflections,
			...accumulatedReflections.map(reflectionToSummaryLine),
		];
	}

	// If noAutoCompact: skip if this exact chunk was already processed
	if (runtime.config.noAutoCompact && isObservationChunkPending(sessionId, coversUpToId)) {
		debugLog("observer.pending_skip", { coversUpToId, sessionId });
		return "continue";
	}

	for (let attempt = 0; attempt < MAX_STAGE_ATTEMPTS; attempt++) {
		const resolved = await resolveModel("observer");
		if (!resolved) return "abort";

		// Adjust accumulated for pending coverage in noAutoCompact mode
		let effectiveTokens = tokens;
		if (runtime.config.noAutoCompact) {
			const pending = readPendingState(sessionId);
			if (pending.observation?.coversUpToId) {
				const idx = entryIndexForId(entries, pending.observation.coversUpToId);
				if (idx >= 0) effectiveTokens = rawTokensAfterIndex(entries, idx);
			}
		}
		if (ctx.hasUI) ctx.ui?.notify(
			`Observational memory: observer running on ~${chunkTokens.toLocaleString()}-token chunk (of ${effectiveTokens.toLocaleString()} accumulated)`,
			"info",
		);
		debugLog("observer.start", { tokens, coversUpToId, sourceEntryIds, sourceEntryCount: sourceEntryIds.length, priorReflections: priorReflections.length, priorObservations: priorObservations.length });

		// Resolve thinking level for the specific model (fallbacks may have their own thinking config)
		const stageModelForThinking = runtime.findCandidateConfig(resolved.model, { model: ctx.model, modelRegistry: ctx.modelRegistry, hasUI: ctx.hasUI, ui: ctx.ui, stageModel: stageModelConfig(runtime, "observer"), stageFallbacks: stageFallbackModels(runtime, "observer") });

		// Check if estimated input fits in model's context window
		// Use actual chunk tokens (already computed) instead of the configured cap
		const effectiveObsCtx = effectiveContextWindow(resolved.model as any, stageModelForThinking);
		const observerEstimatedInput = chunkTokens + AGENT_LOOP_RESERVE;
		if (observerEstimatedInput > effectiveObsCtx) {
			debugLog("observer.context_window_exceeded", { estimatedInput: observerEstimatedInput, effectiveCtx: effectiveObsCtx, model: `${(resolved.model as any).provider}/${(resolved.model as any).id}` });
			runtime.recordRetryableError(stageModelForThinking, new Error(`context window ${effectiveObsCtx} too small for estimated input ${observerEstimatedInput}`), "observer");
			if (ctx.hasUI && ctx.ui) ctx.ui.notify(`Observational memory: observer skipping ${(resolved.model as any).provider}/${(resolved.model as any).id} (context window ${effectiveObsCtx.toLocaleString()} too small for ~${observerEstimatedInput.toLocaleString()}-token input)`, "info");
			continue;
		}

		try {
			const result = await runObserver({
				model: resolved.model as any,
				apiKey: resolved.apiKey,
				headers: resolved.headers,
				priorReflections,
				priorObservations,
				chunk,
				allowedSourceEntryIds: sourceEntryIds,
				maxTurns: runtime.config.agentMaxTurns,
				thinkingLevel: stageThinkingLevel(runtime, "observer", stageModelForThinking),
			});

			if (result.observations && result.observations.length > 0) {
				const data = buildObservationsRecordedData(result.observations, coversUpToId);
				if (!data) { runtime.advanceCursor("observer", coversUpToId, "empty"); return "continue"; }
				debugLog("observer.records", { count: result.observations.length, observationTokens: result.observations.reduce((s: number, o: any) => s + o.tokenCount, 0), coversUpToId });
				if (runtime.config.noAutoCompact) {
					savePendingObservation(sessionId, { coversUpToId, data });
					debugLog("observer.pending", { count: result.observations.length, coversUpToId, sessionId });
				} else {
					appendEntry(pi, OM_OBSERVATIONS_RECORDED, data);
					debugLog("observer.appended", { count: result.observations.length, coversUpToId });
				}
				runtime.advanceCursor("observer", coversUpToId, "recorded");
				if (ctx.hasUI) ctx.ui?.notify(`Observational memory: ${result.observations.length} observation${result.observations.length === 1 ? "" : "s"} recorded`, "info");
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
			if (ctx.hasUI) ctx.ui?.notify(`Observational memory: no observations — ${reasonLabel}`, reasonLevel);
			return "continue";
		} catch (error) {
			// Always try next fallback — don't abort pipeline for a single model failure.
			// Record cooldown so resolveModel skips this model in the next iteration.
			const candidateConfig = runtime.findCandidateConfig(resolved.model, { model: ctx.model, modelRegistry: ctx.modelRegistry, hasUI: ctx.hasUI, ui: ctx.ui, stageModel: stageModelConfig(runtime, "observer"), stageFallbacks: stageFallbackModels(runtime, "observer") });
			runtime.recordRetryableError(candidateConfig, error, "observer");
			debugLog("observer.error", { error: String(error), retryable: isRetryableError(error) });
			// Continue loop — resolveModel will skip the cooled-down model
			continue;
		}
	}

	// All attempts exhausted
	runtime.recordConsolidationStageError(ctx, "observer", new Error("Observer: all model candidates exhausted"));
	return "abort";
}

// ── Reflector stage (with fallback) ─────────────────────────────────────────

async function runReflectorStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "reflector") => Promise<ResolvedModel | undefined>,
): Promise<ReflectorStageResult> {
	const sessionId = ctx.sessionManager.getSessionId();
	const entries = ctx.sessionManager.getBranch() as Entry[];
	let reflectionTokens = 0;
	let observationCoverageId: string | undefined;
	if (runtime.config.noAutoCompact) {
		const pending = readPendingState(sessionId);
		// Check any accumulated batch for unprocessed observations, not just the latest
		const hasPendingObs = (pending.observationBatches ?? []).some((b: any) => (b.data as any)?.observations?.length);
		if (!hasPendingObs) { runtime.advanceCursor("reflector", entries.at(-1)?.id ?? "unknown", "skipped"); return { outcome: "continue", sameRunReflections: [] }; }
		observationCoverageId = pending.observation?.coversUpToId;
		if (pending.reflection?.coversUpToId) {
			const obsIdx = entryIndexForId(entries, pending.observation?.coversUpToId ?? "");
			const refIdx = entryIndexForId(entries, pending.reflection.coversUpToId);
			if (obsIdx >= 0 && refIdx >= 0 && obsIdx <= refIdx) { runtime.advanceCursor("reflector", pending.reflection.coversUpToId, "skipped"); return { outcome: "continue", sameRunReflections: [] }; }
			if (refIdx >= 0) {
				reflectionTokens = rawTokensAfterIndex(entries, refIdx);
				if (reflectionTokens < runtime.config.reflectAfterTokens) { runtime.advanceCursor("reflector", pending.reflection.coversUpToId, "not_due"); return { outcome: "continue", sameRunReflections: [] }; }
			} else {
				reflectionTokens = rawTokensSinceObservationCoverage(entries);
			}
		} else {
			reflectionTokens = rawTokensSinceObservationCoverage(entries);
		}
	} else {
		reflectionTokens = rawTokensSinceReflectionCoverage(entries);
		if (reflectionTokens < runtime.config.reflectAfterTokens) { runtime.advanceCursor("reflector", entries.at(-1)?.id ?? "unknown", "not_due"); return { outcome: "continue", sameRunReflections: [] }; }
		observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
		if (!observationCoverageId) { runtime.advanceCursor("reflector", entries.at(-1)?.id ?? "unknown", "skipped"); return { outcome: "continue", sameRunReflections: [] }; }
	}

	for (let attempt = 0; attempt < MAX_STAGE_ATTEMPTS; attempt++) {
		const resolved = await resolveModel("reflector");
		if (!resolved) return { outcome: "abort", sameRunReflections: [] };

		// Compute ahead for an accurate notification
		const folded = foldLedger(entries);
		const pending = runtime.config.noAutoCompact ? readPendingState(sessionId) : undefined;
		const lastReflectionIdx = pending ? -1 : latestCoverageIndex(entries, OM_REFLECTIONS_RECORDED);
		const newObservations = pending
			? pendingObservationsCreatedAfter(pending, entries, pending.reflection?.coversUpToId)
			: observationsCreatedAfterIndex(entries, lastReflectionIdx);
		const newReflections = pending ? [] : reflectionsCreatedAfterIndex(entries, lastReflectionIdx);
		const newItemsTokens = Math.ceil(
			(newObservations.reduce((s: number, o: any) => s + o.content.length, 0) +
				newReflections.reduce((s: number, r: any) => s + r.content.length, 0)) / 4
		);
		const summaryBudget = Math.floor(runtime.config.reflectorInputMaxTokens * 0.15) * 2;
		const reflectorInputTokens = Math.min(newItemsTokens + summaryBudget, runtime.config.reflectorInputMaxTokens);
		// Adjust accumulated for pending coverage in noAutoCompact mode
		let effectiveReflectionTokens = reflectionTokens;
		if (runtime.config.noAutoCompact) {
			if (pending?.reflection?.coversUpToId) {
				const idx = entryIndexForId(entries, pending.reflection.coversUpToId);
				if (idx >= 0) effectiveReflectionTokens = rawTokensAfterIndex(entries, idx);
			}
		}
		debugLog("reflector.start", { tokens: effectiveReflectionTokens, inputTokens: reflectorInputTokens, newObsCount: newObservations.length, newRefCount: newReflections.length });
		if (ctx.hasUI) ctx.ui?.notify(`Observational memory: reflector running (~${effectiveReflectionTokens.toLocaleString()} tokens accumulated, ~${reflectorInputTokens.toLocaleString()}-token input)`, "info");

		// Resolve thinking level for the specific model (fallbacks may have their own thinking config)
		const stageModelForThinking = runtime.findCandidateConfig(resolved.model, { model: ctx.model, modelRegistry: ctx.modelRegistry, hasUI: ctx.hasUI, ui: ctx.ui, stageModel: stageModelConfig(runtime, "reflector"), stageFallbacks: stageFallbackModels(runtime, "reflector") });

		// Check if estimated input fits in model's context window
		// Use actual computed input size (new items + summary budget) instead of cap
		const effectiveRefCtx = effectiveContextWindow(resolved.model as any, stageModelForThinking);
		const reflectorEstimatedInput = reflectorInputTokens + AGENT_LOOP_RESERVE;
		if (reflectorEstimatedInput > effectiveRefCtx) {
			debugLog("reflector.context_window_exceeded", { estimatedInput: reflectorEstimatedInput, effectiveCtx: effectiveRefCtx, model: `${(resolved.model as any).provider}/${(resolved.model as any).id}` });
			runtime.recordRetryableError(stageModelForThinking, new Error(`context window ${effectiveRefCtx} too small for estimated input ${reflectorEstimatedInput}`), "reflector");
			if (ctx.hasUI && ctx.ui) ctx.ui.notify(`Observational memory: reflector skipping ${(resolved.model as any).provider}/${(resolved.model as any).id} (context window ${effectiveRefCtx.toLocaleString()} too small for ~${reflectorEstimatedInput.toLocaleString()}-token input)`, "info");
			continue;
		}

		try {
			// Existing memory summaries for context (capped).
			// In noAutoCompact, merge accumulated pending batches with
			// branch data (preserving pre-switch markers).
			const sourceReflections = pending
				? [...folded.reflections, ...(pending.reflectionBatches ?? []).flatMap((b: any) => (b.data as any)?.reflections ?? [])]
				: folded.reflections;
			const sourceObservations = pending
				? [...folded.activeObservations, ...(pending.observationBatches ?? []).flatMap((b: any) => (b.data as any)?.observations ?? [])]
				: folded.activeObservations;
			const existingReflectionsSummary = buildExistingReflectionsSummary(
				sourceReflections,
				Math.floor(runtime.config.reflectorInputMaxTokens * 0.15),
			);
			const existingObservationsSummary = buildExistingObservationsSummary(
				sourceObservations.filter((o: any) => !newObservations.some((no: any) => no.id === o.id)),
				Math.floor(runtime.config.reflectorInputMaxTokens * 0.15),
			);

			const reflections = await runReflector({
				model: resolved.model as any,
				apiKey: resolved.apiKey,
				headers: resolved.headers,
				reflections: newReflections,
				observations: newObservations,
				existingReflectionsSummary: existingReflectionsSummary || undefined,
				existingObservationsSummary: existingObservationsSummary || undefined,
				maxTurns: runtime.config.agentMaxTurns,
				thinkingLevel: stageThinkingLevel(runtime, "reflector", stageModelForThinking),
			});

			if (!reflections || reflections.length === 0) {
				runtime.advanceCursor("reflector", observationCoverageId ?? entries.at(-1)?.id ?? "unknown", "empty");
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
			if (runtime.config.noAutoCompact) {
				savePendingReflection(sessionId, { coversUpToId: data.coversUpToId, data });
			} else {
				appendEntry(pi, OM_REFLECTIONS_RECORDED, data);
			}
			runtime.advanceCursor("reflector", data.coversUpToId, "recorded");
			return {
				outcome: "continue",
				sameRunReflections: reflections,
				effectiveReflectionCoverageId: data.coversUpToId,
			};
		} catch (error) {
			const candidateConfig = runtime.findCandidateConfig(resolved.model, { model: ctx.model, modelRegistry: ctx.modelRegistry, hasUI: ctx.hasUI, ui: ctx.ui, stageModel: stageModelConfig(runtime, "reflector"), stageFallbacks: stageFallbackModels(runtime, "reflector") });
			runtime.recordRetryableError(candidateConfig, error, "reflector");
			debugLog("reflector.error", { error: String(error), retryable: isRetryableError(error) });
			continue;
		}
	}

	runtime.recordConsolidationStageError(ctx, "reflector", new Error("Reflector: all model candidates exhausted"));
	return { outcome: "abort", sameRunReflections: [] };
}

// ── Dropper stage (with fallback) ───────────────────────────────────────────

async function runDropperStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "dropper") => Promise<ResolvedModel | undefined>,
	sameRunReflections: Reflection[],
	sameRunReflectionCoverageId: string | undefined,
): Promise<StageOutcome> {
	const sessionId = ctx.sessionManager.getSessionId();
	const entries = ctx.sessionManager.getBranch() as Entry[];
	let dropTokens = 0;
	let observationCoverageId: string | undefined;
	if (runtime.config.noAutoCompact) {
		const pending = readPendingState(sessionId);
		// Check any accumulated batch for unprocessed observations, not just the latest
		const hasPendingObs = (pending.observationBatches ?? []).some((b: any) => (b.data as any)?.observations?.length);
		if (!hasPendingObs) { runtime.advanceCursor("dropper", entries.at(-1)?.id ?? "unknown", "skipped"); return "continue"; }
		observationCoverageId = pending.observation?.coversUpToId;
		if (pending.dropped?.coversUpToId) {
			const obsIdx = entryIndexForId(entries, pending.observation?.coversUpToId ?? "");
			const dropIdx = entryIndexForId(entries, pending.dropped.coversUpToId);
			if (obsIdx >= 0 && dropIdx >= 0 && obsIdx <= dropIdx) { runtime.advanceCursor("dropper", pending.dropped.coversUpToId, "skipped"); return "continue"; }
			if (dropIdx >= 0) {
				dropTokens = rawTokensAfterIndex(entries, dropIdx);
				if (dropTokens < runtime.config.reflectAfterTokens) { runtime.advanceCursor("dropper", pending.dropped.coversUpToId, "not_due"); return "continue"; }
			} else {
				dropTokens = rawTokensSinceDropCoverage(entries);
			}
		} else {
			dropTokens = rawTokensSinceDropCoverage(entries);
		}
	} else {
		dropTokens = rawTokensSinceDropCoverage(entries);
		if (dropTokens < runtime.config.reflectAfterTokens) { runtime.advanceCursor("dropper", entries.at(-1)?.id ?? "unknown", "not_due"); return "continue"; }
		observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
		if (!observationCoverageId) { runtime.advanceCursor("dropper", entries.at(-1)?.id ?? "unknown", "skipped"); return "continue"; }
	}

	for (let attempt = 0; attempt < MAX_STAGE_ATTEMPTS; attempt++) {
		const resolved = await resolveModel("dropper");
		if (!resolved) return "abort";

		// Compute ahead for an accurate notification
		const folded = foldLedger(entries);
		const pending = runtime.config.noAutoCompact ? readPendingState(sessionId) : undefined;
		const lastDropIdx = pending ? -1 : latestCoverageIndex(entries, OM_OBSERVATIONS_DROPPED);
		const newObservations = pending
			? pendingObservationsCreatedAfter(pending, entries, pending.dropped?.coversUpToId)
			: observationsCreatedAfterIndex(entries, lastDropIdx);
		const dropperNewObsTokens = Math.ceil(
			newObservations.reduce((s: number, o: any) => s + o.content.length, 0) / 4
		);
		const dropperSummaryBudget = Math.floor(runtime.config.dropperInputMaxTokens * 0.2);
		const dropperInputTokens = Math.min(dropperNewObsTokens + dropperSummaryBudget, runtime.config.dropperInputMaxTokens);
		// Adjust accumulated for pending coverage in noAutoCompact mode
		let effectiveDropTokens = dropTokens;
		if (runtime.config.noAutoCompact) {
			if (pending?.dropped?.coversUpToId) {
				const idx = entryIndexForId(entries, pending.dropped.coversUpToId);
				if (idx >= 0) effectiveDropTokens = rawTokensAfterIndex(entries, idx);
			}
		}
		if (ctx.hasUI) ctx.ui?.notify(`Observational memory: dropper running (~${effectiveDropTokens.toLocaleString()} tokens accumulated, ~${dropperInputTokens.toLocaleString()}-token input)`, "info");

		try {
			// Existing active observations summary for context (capped).
			// In noAutoCompact, merge accumulated pending batches with
			// branch data (preserving pre-switch markers).
			const sourceObsForDropper = pending
				? [...folded.activeObservations, ...(pending.observationBatches ?? []).flatMap((b: any) => (b.data as any)?.observations ?? [])]
				: folded.activeObservations;
			const existingObservationsSummary = buildExistingObservationsSummary(
				sourceObsForDropper.filter((o: any) => !newObservations.some((no: any) => no.id === o.id)),
				Math.floor(runtime.config.dropperInputMaxTokens * 0.2),
			);
			// In noAutoCompact, merge accumulated reflection batches with
			// branch data (preserving pre-switch markers), matching the
			// dropper's full autoCompact context.
			const pendingReflections = pending
				? [...folded.reflections, ...(pending.reflectionBatches ?? []).flatMap((b: any) => (b.data as any)?.reflections ?? [])]
				: folded.reflections;
			const reflectionsForDropper = mergeReflections(pendingReflections, sameRunReflections);

			// Resolve thinking level for the specific model (fallbacks may have their own thinking config)
			const stageModelForThinking = runtime.findCandidateConfig(resolved.model, { model: ctx.model, modelRegistry: ctx.modelRegistry, hasUI: ctx.hasUI, ui: ctx.ui, stageModel: stageModelConfig(runtime, "dropper"), stageFallbacks: stageFallbackModels(runtime, "dropper") });

			// Check if estimated input fits in model's context window
			// Use actual computed input size (new observations + summary budget) instead of cap
			const effectiveDropCtx = effectiveContextWindow(resolved.model as any, stageModelForThinking);
			const dropperEstimatedInput = dropperInputTokens + AGENT_LOOP_RESERVE;
			if (dropperEstimatedInput > effectiveDropCtx) {
				debugLog("dropper.context_window_exceeded", { estimatedInput: dropperEstimatedInput, effectiveCtx: effectiveDropCtx, model: `${(resolved.model as any).provider}/${(resolved.model as any).id}` });
				runtime.recordRetryableError(stageModelForThinking, new Error(`context window ${effectiveDropCtx} too small for estimated input ${dropperEstimatedInput}`), "dropper");
				if (ctx.hasUI && ctx.ui) ctx.ui.notify(`Observational memory: dropper skipping ${(resolved.model as any).provider}/${(resolved.model as any).id} (context window ${effectiveDropCtx.toLocaleString()} too small for ~${dropperEstimatedInput.toLocaleString()}-token input)`, "info");
				continue;
			}

			const droppedIds = await runDropper({
				model: resolved.model as any,
				apiKey: resolved.apiKey,
				headers: resolved.headers,
				reflections: reflectionsForDropper,
				observations: newObservations,
				existingObservationsSummary: existingObservationsSummary || undefined,
				budgetTokens: runtime.config.observationsPoolMaxTokens,
				maxTurns: runtime.config.agentMaxTurns,
				thinkingLevel: stageThinkingLevel(runtime, "dropper", stageModelForThinking),
			});
			const latestReflectionCoverageId = runtime.config.noAutoCompact
				? pending?.reflection?.coversUpToId
				: latestCoverageMarkerId(entries, OM_REFLECTIONS_RECORDED);
			const effectiveReflectionCoverageId = sameRunReflectionCoverageId ?? latestReflectionCoverageId;
			const coversUpToId = earlierCoverageMarkerId(entries, observationCoverageId, effectiveReflectionCoverageId);
			const data = coversUpToId && droppedIds ? buildObservationsDroppedData(droppedIds, coversUpToId) : undefined;
			if (data && coversUpToId) {
				if (runtime.config.noAutoCompact) {
					savePendingDropped(sessionId, { coversUpToId, data });
				} else {
					appendEntry(pi, OM_OBSERVATIONS_DROPPED, data);
				}
				runtime.advanceCursor("dropper", coversUpToId, "recorded");
			} else {
				// No drops selected (maxDropsAllowed=0 or LLM returned no candidates)
				runtime.advanceCursor("dropper", coversUpToId ?? observationCoverageId ?? entries.at(-1)?.id ?? "unknown", "empty");
			}
			return "continue";
		} catch (error) {
			const candidateConfig = runtime.findCandidateConfig(resolved.model, { model: ctx.model, modelRegistry: ctx.modelRegistry, hasUI: ctx.hasUI, ui: ctx.ui, stageModel: stageModelConfig(runtime, "dropper"), stageFallbacks: stageFallbackModels(runtime, "dropper") });
			runtime.recordRetryableError(candidateConfig, error, "dropper");
			debugLog("dropper.error", { error: String(error), retryable: isRetryableError(error) });
			continue;
		}
	}

	runtime.recordConsolidationStageError(ctx, "dropper", new Error("Dropper: all model candidates exhausted"));
	return "abort";
}
