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
import { isRetryableError } from "./cooldown.js";
import { serializeSourceAddressedBranchEntries } from "./serialize.js";
import {
	readPendingState,
	savePendingObservation,
	savePendingReflection,
	savePendingDropped,
	isObservationChunkPending,
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
	type Entry,
	type Observation,
	type Reflection,
} from "./ledger/index.js";

type ResolvedModel = Extract<ResolveResult, { ok: true }>;

type ConsolidationCtx = {
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
		if (entry.type === "message" && entry.message) {
			const msg = entry.message as any;
			if (typeof msg.content === "string") chars = msg.content.length;
			else if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.text) chars += block.text.length;
				}
			}
		}
		const estTokens = Math.ceil(chars / 4);
		if (totalTokens + estTokens > maxTokens && kept.length > 0) break;
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

/** Score an observation for preamble cap selection.
 *  Relevance tier dominates: medium (5+) always outranks low (max 2).
 *  Recency is based on position in the flat-mapped array (0 = oldest, N-1 = newest),
 *  avoiding wall-clock dependency that punishes sessions spanning days or weeks. */
function scoreObservation(obs: Observation, index: number, total: number): number {
	const base = obs.relevance === "high" || obs.relevance === "critical" ? 10
		: obs.relevance === "medium" ? 5 : 1;
	const recency = total > 1 ? index / (total - 1) : 1;
	return base + recency;
}

/** Select observations for the observer preamble, keeping all high-relevance items
 *  unconditionally and filling the remaining token budget with the best-scoring
 *  medium and low observations (relevance-tiered + recency).
 *
 *  Reflections are never trimmed — they are inherently rare and always stay. */
function selectPriorObservations(observations: Observation[], maxTokens: number): Observation[] {
	const high: Observation[] = [];
	const rest: Observation[] = [];
	for (const obs of observations) {
		if (obs.relevance === "high" || obs.relevance === "critical") {
			high.push(obs);
		} else {
			rest.push(obs);
		}
	}

	// High always kept — consume budget first
	let budget = maxTokens;
	const kept: Observation[] = [];
	for (const obs of high) {
		const lineTokens = Math.ceil(observationToSummaryLine(obs).length / 4);
		kept.push(obs);
		budget -= lineTokens;
	}

	// Score medium + low and select best within remaining budget
	if (rest.length > 0 && budget > 0) {
		const scored = rest.map((obs, i) => ({ obs, score: scoreObservation(obs, i, rest.length) }));
		scored.sort((a, b) => b.score - a.score); // highest score first
		for (const { obs } of scored) {
			const lineTokens = Math.ceil(observationToSummaryLine(obs).length / 4);
			if (budget - lineTokens < 0) break;
			kept.push(obs);
			budget -= lineTokens;
		}
	}

	return kept;
}

function anyStageDue(entries: Entry[], runtime: Runtime): boolean {
	return rawTokensSinceObservationCoverage(entries) >= runtime.config.observeAfterTokens
		|| rawTokensSinceReflectionCoverage(entries) >= runtime.config.reflectAfterTokens
		|| rawTokensSinceDropCoverage(entries) >= runtime.config.reflectAfterTokens;
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

function makeModelResolver(runtime: Runtime, ctx: ConsolidationCtx): (stage: "observer" | "reflector" | "dropper") => Promise<ResolvedModel | undefined> {
	return async (stage) => {
		const resolved = await runtime.resolveModel({
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			hasUI: ctx.hasUI,
			ui: ctx.ui,
			stageModel: stageModelConfig(runtime, stage),
			stageFallbacks: stageFallbackModels(runtime, stage),
		});
		if (resolved.ok) {
			runtime.resolveFailureNotified = false;
			return resolved;
		}
		debugLog(`${stage}.model_unavailable`, { reason: resolved.reason });
		if (!runtime.resolveFailureNotified && ctx.hasUI && ctx.ui) {
			ctx.ui.notify(`Observational memory: ${stage} skipped — ${resolved.reason}`, "warning");
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

function maybeLaunchConsolidation(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx): void {
	runtime.ensureConfig(ctx.cwd);
	if (runtime.config.passive === true) return;
	if (runtime.config.memory === false) return;
	if (runtime.consolidationInFlight) return;
	if (runtime.isConsolidationRetryGated()) return;

	const entries = ctx.sessionManager.getBranch() as Entry[];
	if (!anyStageDue(entries, runtime)) return;

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
	try {
		const observerOutcome = await runObserverStage(pi, runtime, ctx, resolveModel);
		if (observerOutcome === "abort") return;
	} catch (error) {
		debugLog("observer.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "observer", error) });
		return;
	}

	runtime.consolidationPhase = "reflector";
	let reflectorResult: ReflectorStageResult;
	try {
		reflectorResult = await runReflectorStage(pi, runtime, ctx, resolveModel);
		if (reflectorResult.outcome === "abort") return;
	} catch (error) {
		debugLog("reflector.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "reflector", error) });
		return;
	}

	runtime.consolidationPhase = "dropper";
	try {
		await runDropperStage(pi, runtime, ctx, resolveModel, reflectorResult.sameRunReflections, reflectorResult.effectiveReflectionCoverageId);
	} catch (error) {
		debugLog("dropper.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "dropper", error) });
	}
}

// ── Observer stage (with fallback) ──────────────────────────────────────────

async function runObserverStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "observer") => Promise<ResolvedModel | undefined>,
): Promise<StageOutcome> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const tokens = rawTokensSinceObservationCoverage(entries);
	if (tokens < runtime.config.observeAfterTokens) return "continue";

	const lastCoverageIdx = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	// Mid-session cold start: when no coverage marker exists (e.g., after compaction
	// consumed the markers), fall back to the last compaction as the cutoff instead
	// of processing everything including the compaction summary.
	const effectiveStart = lastCoverageIdx >= 0 ? lastCoverageIdx : findLastCompactionIndex(entries);
	let chunkEntries = sourceEntriesAfter(entries, effectiveStart);
	const coversUpToId = chunkEntries.at(-1)?.id;
	if (!coversUpToId) return "continue";

	// Cap observer input to observerChunkMaxTokens (newest-to-oldest)
	const maxChunkTokens = runtime.config.observerChunkMaxTokens;
	if (tokens > maxChunkTokens) {
		chunkEntries = capSourceEntriesToTokens(chunkEntries, maxChunkTokens);
	}

	const { text: chunk, sourceEntryIds } = serializeSourceAddressedBranchEntries(chunkEntries);
	if (!chunk.trim() || sourceEntryIds.length === 0) return "continue";
	const chunkTokens = Math.ceil(chunk.length / 4);

	const sessionId = ctx.sessionManager.getSessionId();

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
				if (!data) return "continue";
				debugLog("observer.records", { count: result.observations.length, observationTokens: result.observations.reduce((s: number, o: any) => s + o.tokenCount, 0), coversUpToId });
				if (runtime.config.noAutoCompact) {
					savePendingObservation(sessionId, { coversUpToId, data });
					debugLog("observer.pending", { count: result.observations.length, coversUpToId, sessionId });
				} else {
					appendEntry(pi, OM_OBSERVATIONS_RECORDED, data);
					debugLog("observer.appended", { count: result.observations.length, coversUpToId });
				}
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
	let reflectionTokens: number;
	let observationCoverageId: string | undefined;
	if (runtime.config.noAutoCompact) {
		const pending = readPendingState(sessionId);
		const pendingObs = (pending.observation?.data as any)?.observations;
		if (!pendingObs?.length) return { outcome: "continue", sameRunReflections: [] };
		observationCoverageId = pending.observation?.coversUpToId;
		if (pending.reflection?.coversUpToId) {
			const obsIdx = entryIndexForId(entries, pending.observation?.coversUpToId ?? "");
			const refIdx = entryIndexForId(entries, pending.reflection.coversUpToId);
			if (obsIdx >= 0 && refIdx >= 0 && obsIdx <= refIdx) return { outcome: "continue", sameRunReflections: [] };
			if (refIdx >= 0) {
				reflectionTokens = rawTokensAfterIndex(entries, refIdx);
				if (reflectionTokens < runtime.config.reflectAfterTokens) return { outcome: "continue", sameRunReflections: [] };
			} else {
				reflectionTokens = rawTokensSinceObservationCoverage(entries);
			}
		} else {
			reflectionTokens = rawTokensSinceObservationCoverage(entries);
		}
	} else {
		reflectionTokens = rawTokensSinceReflectionCoverage(entries);
		if (reflectionTokens < runtime.config.reflectAfterTokens) return { outcome: "continue", sameRunReflections: [] };
		observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
		if (!observationCoverageId) return { outcome: "continue", sameRunReflections: [] };
	}

	for (let attempt = 0; attempt < MAX_STAGE_ATTEMPTS; attempt++) {
		const resolved = await resolveModel("reflector");
		if (!resolved) return { outcome: "abort", sameRunReflections: [] };

		// Compute ahead for an accurate notification
		const folded = foldLedger(entries);
		const pending = runtime.config.noAutoCompact ? readPendingState(sessionId) : undefined;
		const lastReflectionIdx = pending ? -1 : latestCoverageIndex(entries, OM_REFLECTIONS_RECORDED);
		const newObservations = pending ? ((pending.observation?.data as any)?.observations ?? []) : observationsCreatedAfterIndex(entries, lastReflectionIdx);
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
			const pending = readPendingState(sessionId);
			if (pending.reflection?.coversUpToId) {
				const idx = entryIndexForId(entries, pending.reflection.coversUpToId);
				if (idx >= 0) effectiveReflectionTokens = rawTokensAfterIndex(entries, idx);
			}
		}
		if (ctx.hasUI) ctx.ui?.notify(`Observational memory: reflector running (~${effectiveReflectionTokens.toLocaleString()} tokens accumulated, ~${reflectorInputTokens.toLocaleString()}-token input)`, "info");

		// Resolve thinking level for the specific model (fallbacks may have their own thinking config)
		const stageModelForThinking = runtime.findCandidateConfig(resolved.model, { model: ctx.model, modelRegistry: ctx.modelRegistry, hasUI: ctx.hasUI, ui: ctx.ui, stageModel: stageModelConfig(runtime, "reflector"), stageFallbacks: stageFallbackModels(runtime, "reflector") });
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

			if (!reflections || reflections.length === 0) return { outcome: "continue", sameRunReflections: [] };
			if (!observationCoverageId) return { outcome: "continue", sameRunReflections: [] };

			const data = buildReflectionsRecordedData(reflections, observationCoverageId);
			if (!data) return { outcome: "continue", sameRunReflections: [] };
			if (runtime.config.noAutoCompact) {
				savePendingReflection(sessionId, { coversUpToId: data.coversUpToId, data });
			} else {
				appendEntry(pi, OM_REFLECTIONS_RECORDED, data);
			}
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
	let dropTokens: number;
	let observationCoverageId: string | undefined;
	if (runtime.config.noAutoCompact) {
		const pending = readPendingState(sessionId);
		const pendingObs = (pending.observation?.data as any)?.observations;
		if (!pendingObs?.length) return "continue";
		observationCoverageId = pending.observation?.coversUpToId;
		if (pending.dropped?.coversUpToId) {
			const obsIdx = entryIndexForId(entries, pending.observation?.coversUpToId ?? "");
			const dropIdx = entryIndexForId(entries, pending.dropped.coversUpToId);
			if (obsIdx >= 0 && dropIdx >= 0 && obsIdx <= dropIdx) return "continue";
			if (dropIdx >= 0) {
				dropTokens = rawTokensAfterIndex(entries, dropIdx);
				if (dropTokens < runtime.config.reflectAfterTokens) return "continue";
			} else {
				dropTokens = rawTokensSinceDropCoverage(entries);
			}
		} else {
			dropTokens = rawTokensSinceDropCoverage(entries);
		}
	} else {
		dropTokens = rawTokensSinceDropCoverage(entries);
		if (dropTokens < runtime.config.reflectAfterTokens) return "continue";
		observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
		if (!observationCoverageId) return "continue";
	}

	for (let attempt = 0; attempt < MAX_STAGE_ATTEMPTS; attempt++) {
		const resolved = await resolveModel("dropper");
		if (!resolved) return "abort";

		// Compute ahead for an accurate notification
		const folded = foldLedger(entries);
		const pending = runtime.config.noAutoCompact ? readPendingState(sessionId) : undefined;
		const lastDropIdx = pending ? -1 : latestCoverageIndex(entries, OM_OBSERVATIONS_DROPPED);
		const newObservations = pending ? ((pending.observation?.data as any)?.observations ?? []) : observationsCreatedAfterIndex(entries, lastDropIdx);
		const dropperNewObsTokens = Math.ceil(
			newObservations.reduce((s: number, o: any) => s + o.content.length, 0) / 4
		);
		const dropperSummaryBudget = Math.floor(runtime.config.dropperInputMaxTokens * 0.2);
		const dropperInputTokens = Math.min(dropperNewObsTokens + dropperSummaryBudget, runtime.config.dropperInputMaxTokens);
		// Adjust accumulated for pending coverage in noAutoCompact mode
		let effectiveDropTokens = dropTokens;
		if (runtime.config.noAutoCompact) {
			const pending = readPendingState(sessionId);
			if (pending.dropped?.coversUpToId) {
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
