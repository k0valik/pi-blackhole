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
import {
  type Config,
  type ConfiguredModel,
  DEFAULTS,
  loadConfig,
} from "./config.js";
import type { CompactionStats } from "../hooks/before-compact.js";
import {
  isCooldownActive,
  getCooldownEntry,
  recordCooldown,
  expireCooldowns,
  modelKey,
} from "./cooldown.js";
import { readPendingCursors, writePendingCursors } from "./pending.js";
import type { PendingOMState } from "./pending.js";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AuthResult } from "@earendil-works/pi-ai";

export type ResolveResult =
  | {
      ok: true;
      model: any;
      apiKey: string;
      headers?: Record<string, string>;
      cooldownApplied?: boolean;
    }
  | { ok: false; reason: string };

type NotifyLevel = "warning" | "info" | "error";
type Notify = (message: string, type?: NotifyLevel) => void;
export type ConsolidationPhase = "observer" | "reflector" | "dropper";

export type CursorState =
  "initial" | "recorded" | "empty" | "error" | "skipped" | "not_due";

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
  const directBaseUrl =
    typeof auth.baseUrl === "string" ? auth.baseUrl.trim() : "";
  if (directBaseUrl) return directBaseUrl;

  if (typeof modelRegistry.getProviderAuth !== "function") return undefined;

  try {
    const resolved: AuthResult | undefined =
      await modelRegistry.getProviderAuth(model.provider);
    const baseUrl = resolved?.auth?.baseUrl;
    return typeof baseUrl === "string" && baseUrl.trim()
      ? baseUrl.trim()
      : undefined;
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

  /**
   * Emit an info-level notification if none has been emitted this turn/phase yet.
   * Returns true if emitted, false if suppressed (already emitted earlier).
   */
  tryEmitInfo(
    hasUI: boolean,
    ui: { notify: Notify } | undefined,
    message: string,
  ): boolean {
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
  async resolveModel(ctx: ResolveCtx): Promise<ResolveResult> {
    const candidates = this.buildCandidateList(
      ctx.stageModel,
      ctx.stageFallbacks,
    );
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
        const entry = getCooldownEntry(candidate);
        const reason = entry ? `: ${entry.reason}` : "";
        this.tryEmitInfo(
          ctx.hasUI,
          ctx.ui,
          `Observational memory: ${stageName} skipping ${key} (cooldown${reason} — details in cooldown log)`,
        );
        continue;
      }

      const configured = ctx.modelRegistry.find(
        candidate.provider,
        candidate.id,
      );
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
      const hasAuth = ctx.modelRegistry.hasConfiguredAuth?.(configured) ?? true;
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
      const resolvedModel = await withResolvedAuthEndpoint(
        ctx.modelRegistry,
        configured,
        auth,
      );

      return {
        ok: true,
        model: resolvedModel,
        apiKey: (auth.apiKey as string) ?? "",
        headers: auth.headers as Record<string, string> | undefined,
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
      const hasAuth =
        ctx.modelRegistry.hasConfiguredAuth?.(sessionModel) ?? true;
      if (!auth.ok || !hasAuth) {
        const provider =
          (sessionModel as { provider?: string }).provider ?? "unknown";
        return {
          ok: false,
          reason: `no auth for session model provider "${provider}"`,
        };
      }

      // NOTE: getProviderAuth is called again inside withResolvedAuthEndpoint
      // to recover the credential-resolved baseUrl (only GitHub Copilot's
      // OAuth emits one; other providers pay the call cost but are unaffected).
      const resolvedModel = await withResolvedAuthEndpoint(
        ctx.modelRegistry,
        sessionModel,
        auth,
      );

      return {
        ok: true,
        model: resolvedModel,
        apiKey: (auth.apiKey as string) ?? "",
        headers: auth.headers as Record<string, string> | undefined,
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
   * Get the model config for the currently resolved model (used for cooldown recording).
   * Returns the candidate config if the model was from the candidate list,
   * or undefined if it's the session model.
   */
  findCandidateConfig(
    resolvedModel: unknown,
    ctx: ResolveCtx,
  ): ConfiguredModel | undefined {
    const candidates = this.buildCandidateList(
      ctx.stageModel,
      ctx.stageFallbacks,
    );
    const model = resolvedModel as { provider?: string; id?: string };
    if (!model.provider || !model.id) return undefined;
    return (
      candidates.find(
        (c) => c.provider === model.provider && c.id === model.id,
      ) ??
      (this.config.model?.provider === model.provider &&
      this.config.model?.id === model.id
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
    const rawReason =
      error instanceof Error ? error.message : String(error || "unknown error");
    // Strip trailing JSON body from API error messages for display cleanliness.
    // To avoid stripping non-JSON braces like "{host}", only strip if the text
    // after the brace pair consists solely of whitespace (i.e. JSON is at end).
    // The full rawReason is NOT stored in the cooldown log — only this brief form.
    const brief = rawReason.replace(/\s*\{[\s\S]*?\}\s*$/, "").trim();
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
    return (
      Date.now() - this.lastConsolidationErrorAt <
      CONSOLIDATION_RETRY_COOLDOWN_MS
    );
  }

  /** Get the current cursor for a pipeline stage. */
  getCursor(stage: ConsolidationPhase): PipelineCursor | undefined {
    return this.cursors[stage];
  }

  /** Advance a stage's cursor to a new entry ID with the given state. */
  advanceCursor(
    stage: ConsolidationPhase,
    entryId: string,
    state: CursorState,
  ): void {
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

  launchConsolidationTask(
    ctx: LaunchCtx,
    work: () => Promise<void>,
  ): Promise<void> {
    this.consolidationInFlight = true;
    this.consolidationPhase = undefined;
    const promise = this.launchTrackedTask(ctx, "consolidation", work, () => {
      this.consolidationInFlight = false;
      this.consolidationPhase = undefined;
      if (this.consolidationPromise === promise)
        this.consolidationPromise = null;
    });
    this.consolidationPromise = promise;
    return promise;
  }

  recordConsolidationStageError(
    ctx: LaunchCtx,
    phase: ConsolidationPhase,
    error: unknown,
  ): string {
    const message = error instanceof Error ? error.message : String(error);
    if (phase === "observer") this.lastObserverError = message;
    if (phase === "reflector") this.lastReflectorError = message;
    if (phase === "dropper") this.lastDropperError = message;
    if (ctx.hasUI && ctx.ui) {
      try {
        ctx.ui.notify(
          `Observational memory: ${phase} failed: ${message}`,
          "warning",
        );
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
        if (hasUI && ui) {
          try {
            ui.notify(
              `Observational memory: ${label} failed: ${errorMessage}`,
              "warning",
            );
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
