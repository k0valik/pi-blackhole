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
import type { CompactionStats } from "../hooks/before-compact.js";
import {
  isCooldownActive,
  recordCooldown,
  expireCooldowns,
  modelKey,
  sanitizeCooldownReason,
} from "./cooldown.js";
import { readPendingCursors, writePendingCursors } from "./pending.js";
import type { PendingOMState } from "./pending.js";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AuthResult } from "@earendil-works/pi-ai";
import { debugLog } from "./debug-log.js";

export type ResolveResult =
  | {
      ok: true;
      model: any;
      apiKey: string;
      headers?: Record<string, string>;
      env?: Record<string, string>;
      cooldownApplied?: boolean;
    }
  | { ok: false; reason: string };

type NotifyLevel = "warning" | "info" | "error";
type Notify = (message: string, type?: NotifyLevel) => void;
export type ConsolidationPhase = "observer" | "reflector" | "dropper";

/** Captures the extension/session generation that owns a unit of deferred work. */
export interface RuntimeGeneration {
  readonly generation: number;
  readonly sessionIdentity: string | undefined;
  readonly signal: AbortSignal;
}

export type CursorState = "initial" | "recorded" | "empty" | "error" | "skipped" | "not_due";

export interface PipelineCursor {
  entryId: string;
  state: CursorState;
}

export interface PipelineCursors {
  observer?: PipelineCursor;
  reflector?: PipelineCursor;
  dropper?: PipelineCursor;
}

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

type AuthWithBaseUrl = {
  baseUrl?: string;
};

/**
 * Preserve the endpoint selected by Pi's credential resolver.
 *
 * Pi's `getApiKeyAndHeaders()` returns `ResolvedRequestAuth`, which carries
 * `apiKey`, `headers`, and `env` but NOT `baseUrl` in supported pi versions
 * (>=0.81.1).  The only working source for the credential-resolved endpoint
 * is `getProviderAuth()` (via Pi's `getAuth`), whose `AuthResult.auth.baseUrl`
 * is populated for OAuth providers like GitHub Copilot.
 *
 * The `directBaseUrl` check below is future-proofing: no supported pi
 * version currently populates it, but if a future version does, we pick
 * it up without an extra `getProviderAuth` round-trip.
 */
async function resolveAuthBaseUrl(
  modelRegistry: ModelRegistry,
  model: { provider: string; baseUrl?: string },
  auth: AuthWithBaseUrl,
): Promise<string | undefined> {
  // Future-proofing: if pi ever adds baseUrl to getApiKeyAndHeaders(),
  // use it directly. No supported version currently does.
  const directBaseUrl = typeof auth.baseUrl === "string" ? auth.baseUrl.trim() : "";
  if (directBaseUrl) return directBaseUrl;

  if (typeof modelRegistry.getProviderAuth !== "function") return undefined;

  try {
    const resolved: AuthResult | undefined = await modelRegistry.getProviderAuth(model.provider);
    const baseUrl = resolved?.auth?.baseUrl;
    return typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : undefined;
  } catch {
    // Older registries may not expose provider auth resolution.
    return undefined;
  }
}

async function withResolvedAuthEndpoint(
  modelRegistry: any,
  model: any,
  auth: AuthWithBaseUrl,
): Promise<any> {
  const baseUrl = await resolveAuthBaseUrl(modelRegistry, model, auth);
  return baseUrl && baseUrl !== model.baseUrl ? { ...model, baseUrl } : model;
}

export interface LaunchCtx {
  hasUI: boolean;
  ui?: { notify: Notify };
}

/** Default cooldown interval between failed consolidation runs (ms). */
const CONSOLIDATION_RETRY_COOLDOWN_MS = 30_000;
const AVAILABILITY_RECHECK_TIMEOUT_MS = 5_000;
const AVAILABILITY_RECHECK_REARM_MS = 60_000;

function hasUsableAuth(auth: { apiKey?: unknown; headers?: unknown }): boolean {
  if (typeof auth.apiKey === "string" && auth.apiKey.length > 0) return true;
  if (!auth.headers || typeof auth.headers !== "object") return false;
  return Object.values(auth.headers as Record<string, unknown>).some(
    (value) => typeof value === "string" && value.length > 0,
  );
}

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
  /** AbortController for the pending auto-compaction wait loop, or null if none.
   * Set when handleAgentEnd schedules a wait; cleared on abort, success, or terminal bail.
   * agent_start handlers read this to abort the pending wait when a new turn starts. */
  autoCompactionController: AbortController | null = null;
  /** Exponential backoff state for failed/cancelled mid-run compaction attempts.
   * `retryAfter` gates re-triggering; failures reset when a compaction succeeds,
   * pressure drops below the threshold, or an auto-compaction completes.
   * Replaces the earlier permanent-suspension latch (PR #38) so transient
   * failures self-heal instead of wedging compaction until pressure drops. */
  midRunCompactionRetry: { failures: number; retryAfter: number } = {
    failures: 0,
    retryAfter: 0,
  };
  /** Set when the host inline-compaction adapter reports permanent
   * unavailability (pi version lacks the API). Mirrors the structural
   * shape of InlineCompactionAdapterStatus without importing it. */
  inlineCompactionAdapterStatus?: { supported: boolean; reason?: string };
  /** One-shot guard for the settled-fallback user notification. */
  inlineCompactionWarningEmitted = false;
  resolveFailureNotified = false;
  lastObserverError: string | undefined;
  lastReflectorError: string | undefined;
  lastDropperError: string | undefined;
  /** Provider -> epoch ms of the last stale availability re-check. */
  availabilityRecheckedAt = new Map<string, number>();
  /** Epoch ms of the last failed consolidation run (any stage). */
  lastConsolidationErrorAt: number | undefined;
  /** Stats from the most recent compaction run (session-scoped via handler closure). */
  compactionStats: CompactionStats | null = null;
  /** Whether the current compaction attempt was triggered by /blackhole.
   *  Overwritten at every session_before_compact and consumed by either the
   *  session_compact or session_compact_failed handler, preventing stale
   *  attribution from leaking into a later pi-default attempt. */
  compactWasPiVcc = false;
  /** True when the current session_before_compact returned { cancel: true } from
   *  blackhole's own-cut guards. Set immediately before the cancel return and reset
   *  at the start of every session_before_compact; consumed by the
   *  session_compact_failed handler to attribute aborted compactions that pi
   *  mislabels as fromExtension: false (pi only flags content-bearing compactions). */
  lastCompactCancelled = false;
  /** Set after the first append-mode fallback warning; one signal per session. */
  appendFallbackNotified = false;
  /** In‑memory pipeline cursors — authoritative copy for gating decisions. */
  cursors: PipelineCursors = {};
  /** Session ID for which cursors have been loaded/validated.  Undefined until first load. */
  cursorsLoadedSessionId: string | undefined = undefined;
  /** Info-notification gate: only the first info-level notification per turn/phase is emitted. */
  hasEmittedInfoThisTurn = false;

  // ── Session generation lifecycle (PR #58: stale-runtime append protection) ──
  private generation = 0;
  private sessionIdentity: string | undefined;
  private disposed = false;
  private lifecycleController = new AbortController();
  private compactionTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Called on session_start. Increments the generation counter and aborts the
   * lifecycle signal when the session identity changes.  Cancels any pending
   * deferred compaction timer.  The old extension's deferred work is thereby
   * invalidated.
   */
  startSession(sessionIdentity: string | undefined): void {
    if (this.disposed) return;
    if (this.sessionIdentity !== undefined && this.sessionIdentity !== sessionIdentity) {
      this.lifecycleController.abort();
      this.lifecycleController = new AbortController();
      this.generation += 1;
      this.clearCompactionTimer();
      this.compactInFlight = false;
    }
    this.sessionIdentity = sessionIdentity;
  }

  /**
   * Captures the current generation for use in deferred work.
   * The returned RuntimeGeneration carries a generation number,
   * session identity, and an AbortSignal that fires on session change.
   */
  captureGeneration(sessionIdentity: string | undefined): RuntimeGeneration {
    return {
      generation: this.generation,
      sessionIdentity,
      signal: this.lifecycleController.signal,
    };
  }

  /**
   * Checks whether a captured generation is still active.
   * Returns false when the runtime is disposed, the signal is aborted,
   * the generation counter has advanced, or the session identity changed.
   *
   * When `startSession` was never called (`this.sessionIdentity` is undefined),
   * the identity check is skipped — this allows tests and direct pipeline
   * calls to work without explicitly calling `startSession` first.
   */
  isGenerationActive(captured: RuntimeGeneration): boolean {
    return (
      !this.disposed &&
      !captured.signal.aborted &&
      captured.generation === this.generation &&
      (this.sessionIdentity === undefined || captured.sessionIdentity === this.sessionIdentity)
    );
  }

  /**
   * Stores the compaction timer handle so dispose() can cancel it.
   */
  setCompactionTimer(timer: ReturnType<typeof setTimeout>): void {
    if (this.disposed) {
      clearTimeout(timer);
      return;
    }
    this.compactionTimer = timer;
  }

  /**
   * Clears the stored compaction timer.  If `timer` is provided and differs
   * from the stored timer, this is a no-op (defensive: prevents clearing a
   * timer that was already replaced by a newer one).
   */
  clearCompactionTimer(timer?: ReturnType<typeof setTimeout>): void {
    if (timer !== undefined && this.compactionTimer !== timer) return;
    if (this.compactionTimer !== undefined) clearTimeout(this.compactionTimer);
    this.compactionTimer = undefined;
  }

  /**
   * Called on session_shutdown.  Aborts the lifecycle signal, increments
   * the generation counter, and clears the compaction timer.  All deferred
   * work is thereby invalidated.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.lifecycleController.abort();
    this.clearCompactionTimer();
    this.compactInFlight = false;
  }

  /**
   * Emit an info-level notification if none has been emitted this turn/phase yet.
   * Returns true if emitted, false if suppressed (already emitted earlier).
   */
  tryEmitInfo(hasUI: boolean, ui: { notify: Notify } | undefined, message: string): boolean {
    if (!hasUI || !ui || typeof ui.notify !== "function") return false;
    if (this.hasEmittedInfoThisTurn) return false;
    this.hasEmittedInfoThisTurn = true;
    try {
      ui.notify(message, "info");
    } catch {
      // Stale extension context — harmless.
    }
    return true;
  }

  /** Reset the info gate — call at agent_start and agent_end to allow one
   *  notification per phase. */
  resetInfoGate(): void {
    this.hasEmittedInfoThisTurn = false;
  }

  ensureConfig(cwd: string, warn?: (message: string) => void): void {
    if (this.configLoaded) return;
    this.config = loadConfig(cwd, warn);
    this.configLoaded = true;
    expireCooldowns();
  }

  /**
   * Force reload config from disk, discarding cached values.
   * Call this after external config changes (e.g., overlay save, manual edit).
   */
  reloadConfig(cwd: string, warn?: (message: string) => void): void {
    this.configLoaded = false;
    this.ensureConfig(cwd, warn);
  }

  /**
   * Build the ordered model candidate list for a stage:
   * 1. Primary stage model (observerModel, reflectorModel, dropperModel)
   * 2. Stage fallbacks (observerFallbackModels, etc.)
   * 3. Base config.model
   *
   * Session model (ctx.model) is only used as the last resort inside resolveModel.
   */
  private buildCandidateList(
    stageModel?: ConfiguredModel,
    stageFallbacks?: ConfiguredModel[],
  ): ConfiguredModel[] {
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
  async resolveModel(ctx: ResolveCtx, signal?: AbortSignal): Promise<ResolveResult> {
    signal?.throwIfAborted();
    const candidates = this.buildCandidateList(ctx.stageModel, ctx.stageFallbacks);
    const stageName = this.consolidationPhase ?? "unknown";

    // Try configured candidates
    for (const candidate of candidates) {
      const key = modelKey(candidate);

      // In-memory skip: model failed earlier in this stage with cooldownHours 0
      if (this.failedInCycle.has(key)) {
        this.tryEmitInfo(
          ctx.hasUI,
          ctx.ui,
          `Observational memory: ${stageName} skipping ${key} (failed this cycle, cooldown disabled)`,
        );
        continue;
      }

      if (isCooldownActive(candidate)) {
        // Issue #80: the cooldown reason can be an error body — keep it in
        // the log file only, never interpolate it into the toast.
        this.tryEmitInfo(
          ctx.hasUI,
          ctx.ui,
          `Observational memory: ${stageName} skipping ${key} (cooldown — details in cooldown log)`,
        );
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
      let hasAuth = ctx.modelRegistry.hasConfiguredAuth?.(configured) ?? true;
      const authProvider = candidate.provider;
      const isOAuth = ctx.modelRegistry.isUsingOAuth?.(configured) === true;
      const emptyApiKey = typeof auth.apiKey === "string" && auth.apiKey.length === 0;
      if (auth.ok && !hasUsableAuth(auth) && !isOAuth && !emptyApiKey && !hasAuth) {
        hasAuth = await this.recheckProviderCredential(ctx.modelRegistry, configured, authProvider);
      }
      if (!auth.ok || !hasAuth) {
        if (ctx.hasUI && ctx.ui) {
          ctx.ui.notify(
            `Observational memory: ${stageName} no auth for ${candidate.provider}`,
            "warning",
          );
        }
        continue;
      }

      // NOTE: getProviderAuth is called again inside withResolvedAuthEndpoint
      // to recover the credential-resolved baseUrl (only GitHub Copilot's
      // OAuth emits one; other providers pay the call cost but are unaffected).
      const resolvedModel = await withResolvedAuthEndpoint(ctx.modelRegistry, configured, auth);

      return {
        ok: true,
        model: resolvedModel,
        apiKey: (auth.apiKey as string) ?? "",
        headers: auth.headers as Record<string, string> | undefined,
        env: (auth as any).env as Record<string, string> | undefined,
        cooldownApplied: false,
      };
    }

    // Fall back to session model (if enabled)
    if (this.config.sessionFallback !== false) {
      const sessionModel = ctx.model;
      if (!sessionModel) {
        return {
          ok: false,
          reason: `no model available for ${stageName} (all candidates exhausted, no session model)`,
        };
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(sessionModel);
      signal?.throwIfAborted();
      let hasAuth = ctx.modelRegistry.hasConfiguredAuth?.(sessionModel) ?? true;
      const sessionProvider = (sessionModel as { provider?: string }).provider ?? "unknown";
      const isOAuth = ctx.modelRegistry.isUsingOAuth?.(sessionModel) === true;
      const emptyApiKey = typeof auth.apiKey === "string" && auth.apiKey.length === 0;
      if (auth.ok && !hasUsableAuth(auth) && !isOAuth && !emptyApiKey && !hasAuth) {
        hasAuth = await this.recheckProviderCredential(
          ctx.modelRegistry,
          sessionModel,
          sessionProvider,
          signal,
        );
        signal?.throwIfAborted();
      }
      if (!auth.ok || !hasAuth) {
        return {
          ok: false,
          reason: `no auth for session model provider "${sessionProvider}"`,
        };
      }

      // NOTE: getProviderAuth is called again inside withResolvedAuthEndpoint
      // to recover the credential-resolved baseUrl (only GitHub Copilot's
      // OAuth emits one; other providers pay the call cost but are unaffected).
      const resolvedModel = await withResolvedAuthEndpoint(ctx.modelRegistry, sessionModel, auth);

      return {
        ok: true,
        model: resolvedModel,
        apiKey: (auth.apiKey as string) ?? "",
        headers: auth.headers as Record<string, string> | undefined,
        env: (auth as any).env as Record<string, string> | undefined,
        cooldownApplied: false,
      };
    }

    // All configured candidates exhausted and session fallback disabled —
    // skip the stage entirely.
    this.tryEmitInfo(
      ctx.hasUI,
      ctx.ui,
      `Observational memory: ${stageName} skipped — all candidates failed (sessionFallback disabled, won't use main model)`,
    );
    this.resolveFailureNotified = true;

    return {
      ok: false,
      reason: `no model available for ${stageName} (all candidates exhausted, sessionFallback disabled)`,
    };
  }

  /**
   * Refresh one provider's availability snapshot when an otherwise ambient
   * request-time credential looks stale.  Bounded and rate-limited; only
   * lifecycle cancellation is propagated to the caller.
   */
  private async recheckProviderCredential(
    registry: any,
    model: any,
    provider: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    signal?.throwIfAborted();
    const now = Date.now();
    const last = this.availabilityRecheckedAt.get(provider);
    if (last !== undefined && now - last < AVAILABILITY_RECHECK_REARM_MS) return false;
    this.availabilityRecheckedAt.set(provider, now);

    const refresh = registry?.refresh;
    if (typeof refresh !== "function") return false;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, AVAILABILITY_RECHECK_TIMEOUT_MS);
    const abortFromLifecycle = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abortFromLifecycle, { once: true });
    let refreshError: string | undefined;
    try {
      await Promise.race([
        refresh.call(registry, {
          allowNetwork: false,
          providers: [provider],
          signal: controller.signal,
        }),
        new Promise<void>((resolve) =>
          controller.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        ),
      ]);
    } catch (error) {
      refreshError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromLifecycle);
    }
    signal?.throwIfAborted();

    const recovered = registry.hasConfiguredAuth?.(model) === true && !timedOut;
    debugLog("resolve.availability_recheck", {
      provider,
      recovered,
      timedOut,
      ...(refreshError ? { refreshError } : {}),
    });
    return recovered;
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
    return (
      candidates.find((c) => c.provider === model.provider && c.id === model.id) ??
      (this.config.model?.provider === model.provider && this.config.model?.id === model.id
        ? this.config.model
        : undefined)
    );
  }

  /**
   * Record a retryable error for a model.  The model must be one of the candidates
   * (not the session model).  If it's the session model we don't cool it down.
   *
   * When cooldownHours is explicitly 0, the model is tracked in-memory for the
   * current consolidation stage (no disk writes). Otherwise a persisted cooldown
   * is recorded.
   */
  recordRetryableError(
    modelConfig: ConfiguredModel | undefined,
    error: unknown,
    stage: ConsolidationPhase,
  ): void {
    if (!modelConfig) return;
    if (modelConfig.cooldownHours === 0) {
      // In-memory only: skip this model for the rest of this stage.
      // No disk writes, no persistent cooldown.
      this.failedInCycle.add(modelKey(modelConfig));
      return;
    }
    const rawReason = error instanceof Error ? error.message : String(error || "unknown error");
    // Issue #80: strip trailing JSON bodies AND HTML error pages (WAF blocks)
    // down to a short `HTTP <status>` line, capped at ~200 chars, so the
    // cooldown log never stores a full page and the skip toast stays short.
    // recordCooldown re-sanitizes as defense-in-depth.
    const brief = sanitizeCooldownReason(rawReason);
    recordCooldown(modelConfig, brief, stage);
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

  /** Get the current cursor for a pipeline stage. */
  getCursor(stage: ConsolidationPhase): PipelineCursor | undefined {
    return this.cursors[stage];
  }

  /** Advance a stage's cursor to a new entry ID with the given state. */
  advanceCursor(stage: ConsolidationPhase, entryId: string, state: CursorState): void {
    this.cursors[stage] = { entryId, state };
  }

  /** Load cursors from the per‑session pending file into the in‑memory map. */
  loadCursorsFromPending(sessionId: string): void {
    try {
      const stored = readPendingCursors(sessionId);
      if (!stored) return;
      if (stored.observer?.entryId && stored.observer?.state) {
        this.cursors.observer = {
          entryId: stored.observer.entryId,
          state: stored.observer.state as CursorState,
        };
      }
      if (stored.reflector?.entryId && stored.reflector?.state) {
        this.cursors.reflector = {
          entryId: stored.reflector.entryId,
          state: stored.reflector.state as CursorState,
        };
      }
      if (stored.dropper?.entryId && stored.dropper?.state) {
        this.cursors.dropper = {
          entryId: stored.dropper.entryId,
          state: stored.dropper.state as CursorState,
        };
      }
    } catch {
      // Best‑effort: missing or corrupt files are harmless.
    }
  }

  /** Save in‑memory cursors to the per‑session pending file (synchronous, for tests). */
  saveCursorsToPending(sessionId: string): void {
    try {
      writePendingCursors(sessionId, this.cursors as PendingOMState["cursors"]);
    } catch {
      // Best‑effort: graceful degradation on read‑only filesystems.
    }
  }

  /** Schedule an async flush of cursors to the pending file.
   *  Uses a micro‑task to avoid blocking the pipeline. */
  scheduleCursorFlush(sessionId: string): void {
    const cursors = { ...this.cursors };
    queueMicrotask(() => {
      try {
        writePendingCursors(sessionId, cursors as PendingOMState["cursors"]);
      } catch {
        // Best‑effort: graceful degradation.
      }
    });
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
    if (ctx.hasUI && ctx.ui) {
      try {
        ctx.ui.notify(`Observational memory: ${phase} failed: ${message}`, "warning");
      } catch {
        // Stale extension context — harmless.
      }
    }
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
        if (!this.disposed && hasUI && ui) {
          try {
            ui.notify(`Observational memory: ${label} failed: ${errorMessage}`, "warning");
          } catch {
            // Stale extension context — harmless.
          }
        }
      } finally {
        onFinally(errorMessage);
      }
    })();
  }
}
