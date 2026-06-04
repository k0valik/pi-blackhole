/**
 * Observational memory runtime — model resolution, consolidation lifecycle,
 * cooldown integration, error tracking.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (src/runtime.ts)
 * Modified by pi-vcc-om:
 * - resolveModel iterates fallback chain (stage → fallbacks → base → session).
 * - Skips cooled-down models (cooldown.ts).
 * - recordRetryableError persists cooldown on API errors.
 * - markConsolidationError sets 30s retry gate for failed runs.
 */
import { type Config, type ConfiguredModel, DEFAULTS, loadConfig } from "./config.js";
import { isCooldownActive, getCooldownEntry, recordCooldown, expireCooldowns, modelKey } from "./cooldown.js";

export type ResolveResult =
	| { ok: true; model: any; apiKey: string; headers?: Record<string, string>; cooldownApplied?: boolean }
	| { ok: false; reason: string };

type NotifyLevel = "warning" | "info" | "error";
type Notify = (message: string, type?: NotifyLevel) => void;
export type ConsolidationPhase = "observer" | "reflector" | "dropper";

export interface ResolveCtx {
	model: unknown;
	modelRegistry: any;
	hasUI: boolean;
	ui?: { notify: Notify };
	/** Primary stage model (from config). */
	stageModel?: ConfiguredModel;
	/** Fallback models for this stage (from config). */
	stageFallbacks?: ConfiguredModel[];
}

export interface LaunchCtx {
	hasUI: boolean;
	ui?: { notify: Notify };
}

/** Default cooldown interval between failed consolidation runs (ms). */
const CONSOLIDATION_RETRY_COOLDOWN_MS = 30_000;

export class Runtime {
	config: Config = { ...DEFAULTS };
	configLoaded = false;
	consolidationInFlight = false;
	consolidationPromise: Promise<void> | null = null;
	consolidationPhase: ConsolidationPhase | undefined;
	/**
	 * Models that failed in the current consolidation stage (in-memory only).
	 * Used when cooldownHours is 0 — avoids disk writes while still letting
	 * the retry loop advance past the failed model within this stage.
	 * Cleared between stages at the pipeline level.
	 */
	failedInCycle: Set<string> = new Set();
	compactInFlight = false;
	compactHookInFlight = false;
	resolveFailureNotified = false;
	lastObserverError: string | undefined;
	lastReflectorError: string | undefined;
	lastDropperError: string | undefined;
	/** Epoch ms of the last failed consolidation run (any stage). */
	lastConsolidationErrorAt: number | undefined;
	/** Stats from the most recent compaction run (session-scoped via handler closure). */
	compactionStats: { summarized: number; kept: number; keptTokensEst: number } | null = null;
	/** Whether the most recent compaction was triggered by /blackhole (vs auto-compact). */
	compactWasPiVcc = false;

	ensureConfig(cwd: string): void {
		if (this.configLoaded) return;
		this.config = loadConfig(cwd);
		this.configLoaded = true;
		expireCooldowns();
	}

	/**
	 * Build the ordered model candidate list for a stage:
	 * 1. Primary stage model (observerModel, reflectorModel, dropperModel)
	 * 2. Stage fallbacks (observerFallbackModels, etc.)
	 * 3. Base config.model
	 *
	 * Session model (ctx.model) is only used as the last resort inside resolveModel.
	 */
	private buildCandidateList(stageModel?: ConfiguredModel, stageFallbacks?: ConfiguredModel[]): ConfiguredModel[] {
		const candidates: ConfiguredModel[] = [];
		if (stageModel) candidates.push(stageModel);
		if (stageFallbacks) candidates.push(...stageFallbacks);
		if (this.config.model) candidates.push(this.config.model);
		return candidates;
	}

	/**
	 * Resolve a model for a consolidation stage.
	 *
	 * Tries the candidate list in order:
	 * 1. Primary stage model → 2. Stage fallbacks → 3. Base config.model → 4. Session model.
	 *
	 * Session model fallback can be disabled via config.sessionFallback: false.
	 * When disabled, returns { ok: false } instead of using the session model,
	 * allowing the stage to be skipped entirely when all configured OM models fail.
	 *
	 * Skips models that are currently in a cooldown window.
	 * On retryable error (after the agent runs), the model that failed is cooled down
	 * and the next candidate is tried.  The caller must call `recordRetryableError`
	 * after the API attempt to mark the failed model.
	 *
	 * Returns `ok: true` with the resolved model, or `ok: false` with a reason
	 * if all candidates (including session model, if enabled) are exhausted or unavailable.
	 */
	async resolveModel(ctx: ResolveCtx): Promise<ResolveResult> {
		const candidates = this.buildCandidateList(ctx.stageModel, ctx.stageFallbacks);
		const stageName = this.consolidationPhase ?? "unknown";

		// Try configured candidates
		for (const candidate of candidates) {
			const key = modelKey(candidate);

			// In-memory skip: model failed earlier in this stage with cooldownHours 0
			if (this.failedInCycle.has(key)) {
				if (ctx.hasUI && ctx.ui) {
					ctx.ui.notify(
						`Observational memory: ${stageName} skipping ${key} (failed this cycle, cooldown disabled)`,
						"info",
					);
				}
				continue;
			}

			if (isCooldownActive(candidate)) {
				if (ctx.hasUI && ctx.ui) {
					const entry = getCooldownEntry(candidate);
					const reason = entry ? `: ${entry.reason}` : "";
					ctx.ui.notify(
						`Observational memory: ${stageName} skipping ${key} (cooldown${reason})`,
						"info",
					);
				}
				continue;
			}

			const configured = ctx.modelRegistry.find(candidate.provider, candidate.id);
			if (!configured) {
				if (ctx.hasUI && ctx.ui) {
					ctx.ui.notify(
						`Observational memory: ${stageName} model ${candidate.provider}/${candidate.id} not found`,
						"warning",
					);
				}
				continue;
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(configured);
			if (!auth.ok || !auth.apiKey) {
				if (ctx.hasUI && ctx.ui) {
					ctx.ui.notify(
						`Observational memory: ${stageName} no auth for ${candidate.provider}`,
						"warning",
					);
				}
				continue;
			}

			return {
				ok: true,
				model: configured,
				apiKey: auth.apiKey as string,
				headers: auth.headers as Record<string, string> | undefined,
				cooldownApplied: false,
			};
		}

		// Fall back to session model (if enabled)
		if (this.config.sessionFallback !== false) {
			const sessionModel = ctx.model;
			if (!sessionModel) {
				return { ok: false, reason: `no model available for ${stageName} (all candidates exhausted, no session model)` };
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(sessionModel);
			if (!auth.ok || !auth.apiKey) {
				const provider = (sessionModel as { provider?: string }).provider ?? "unknown";
				return { ok: false, reason: `no API key for session model provider "${provider}"` };
			}

			return {
				ok: true,
				model: sessionModel,
				apiKey: auth.apiKey as string,
				headers: auth.headers as Record<string, string> | undefined,
				cooldownApplied: false,
			};
		}

		// All configured candidates exhausted and session fallback disabled —
		// skip the stage entirely.  Info-level to match cooldown-disabled pattern.
		// Set resolveFailureNotified so the consolidation layer doesn't duplicate.
		if (ctx.hasUI && ctx.ui) {
			ctx.ui.notify(
				`Observational memory: ${stageName} skipped — all candidates failed (sessionFallback disabled, won't use main model)`,
				"info",
			);
		}
		this.resolveFailureNotified = true;

		return { ok: false, reason: `no model available for ${stageName} (all candidates exhausted, sessionFallback disabled)` };
	}

	/**
	 * Get the model config for the currently resolved model (used for cooldown recording).
	 * Returns the candidate config if the model was from the candidate list,
	 * or undefined if it's the session model.
	 */
	findCandidateConfig(resolvedModel: unknown, ctx: ResolveCtx): ConfiguredModel | undefined {
		const candidates = this.buildCandidateList(ctx.stageModel, ctx.stageFallbacks);
		const model = resolvedModel as { provider?: string; id?: string };
		if (!model.provider || !model.id) return undefined;
		return candidates.find((c) => c.provider === model.provider && c.id === model.id)
			?? (this.config.model?.provider === model.provider && this.config.model?.id === model.id ? this.config.model : undefined);
	}

	/**
	 * Record a retryable error for a model.  The model must be one of the candidates
	 * (not the session model).  If it's the session model we don't cool it down.
	 *
	 * When cooldownHours is explicitly 0, the model is tracked in-memory for the
	 * current consolidation stage (no disk writes). Otherwise a persisted cooldown
	 * is recorded.
	 */
	recordRetryableError(modelConfig: ConfiguredModel | undefined, error: unknown, stage: ConsolidationPhase): void {
		if (!modelConfig) return;
		if (modelConfig.cooldownHours === 0) {
			// In-memory only: skip this model for the rest of this stage.
			// No disk writes, no persistent cooldown.
			this.failedInCycle.add(modelKey(modelConfig));
			return;
		}
		const reason = error instanceof Error ? error.message : String(error || "unknown error");
		recordCooldown(modelConfig, reason, stage);
	}

	/**
	 * Record that a consolidation stage error occurred.
	 * Sets the retry-gate timestamp so the next trigger is delayed.
	 */
	markConsolidationError(): void {
		this.lastConsolidationErrorAt = Date.now();
	}

	/** Check if the consolidation retry gate is active (too soon after last error). */
	isConsolidationRetryGated(): boolean {
		if (!this.lastConsolidationErrorAt) return false;
		return Date.now() - this.lastConsolidationErrorAt < CONSOLIDATION_RETRY_COOLDOWN_MS;
	}

	launchConsolidationTask(ctx: LaunchCtx, work: () => Promise<void>): Promise<void> {
		this.consolidationInFlight = true;
		this.consolidationPhase = undefined;
		const promise = this.launchTrackedTask(ctx, "consolidation", work, () => {
			this.consolidationInFlight = false;
			this.consolidationPhase = undefined;
			if (this.consolidationPromise === promise) this.consolidationPromise = null;
		});
		this.consolidationPromise = promise;
		return promise;
	}

	recordConsolidationStageError(ctx: LaunchCtx, phase: ConsolidationPhase, error: unknown): string {
		const message = error instanceof Error ? error.message : String(error);
		if (phase === "observer") this.lastObserverError = message;
		if (phase === "reflector") this.lastReflectorError = message;
		if (phase === "dropper") this.lastDropperError = message;
		if (ctx.hasUI && ctx.ui) ctx.ui.notify(`Observational memory: ${phase} failed: ${message}`, "warning");
		this.markConsolidationError();
		return message;
	}

	private launchTrackedTask(
		ctx: LaunchCtx,
		label: string,
		work: () => Promise<void>,
		onFinally: (error: string | undefined) => void,
	): Promise<void> {
		const hasUI = ctx.hasUI;
		const ui = ctx.ui;
		return (async () => {
			let errorMessage: string | undefined;
			try {
				await work();
			} catch (error) {
				errorMessage = error instanceof Error ? error.message : String(error);
				if (hasUI && ui) ui.notify(`Observational memory: ${label} failed: ${errorMessage}`, "warning");
			} finally {
				onFinally(errorMessage);
			}
		})();
	}
}
