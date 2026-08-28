import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rawTokensSinceLastCompaction, type Entry } from "./ledger/index.js";
import type { Runtime } from "./runtime.js";
import { debugLog } from "./debug-log.js";
import { RETRYABLE_ERROR_RE } from "./retryable-error.js";
import {
  compactInlineAtTurnBoundary,
  InlineCompactionUnavailableError,
  type InlineCompaction,
} from "./inline-compaction.js";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function isStaleExtensionContextError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return message.includes("extension ctx is stale") || message.includes("ctx is stale");
}

function notifySafely(
  hasUI: boolean,
  ui: any,
  message: string,
  level: "info" | "warning" | "error",
): void {
  if (!hasUI) return;
  try {
    ui?.notify(message, level);
  } catch (error) {
    if (!isStaleExtensionContextError(error)) throw error;
  }
}

/**
 * Shared config gating for auto-compaction (agent_end and turn_end paths).
 * Returns null when compaction may proceed, or a skip reason string.
 */
function autoCompactionSkipReason(runtime: Runtime): string | null {
  if (runtime.config.compaction === "off") return "compaction_off";
  if (runtime.config.compaction === "manual") return "compaction_manual";
  if (runtime.config.compactionEngine === "pi-default") return "compactionEngine_pi_default";
  // NOTE: memory does not gate compaction — memory:false + compaction:auto = compact without OM

  // LEGACY: old config key guards — only apply when new keys are absent (unmigrated config)
  if (runtime.config.compaction === undefined && runtime.config.compactionEngine === undefined) {
    if (runtime.config.passive === true) return "passive";
    if (runtime.config.noAutoCompact === true) return "manual";
    // Don't force Pi to compact unless the user explicitly opted into blackhole's pipeline.
    if (runtime.config.overrideDefaultCompaction === false)
      return "overrideDefaultCompaction_false";
  }
  return null;
}

export const MID_RUN_RETRY_MAX_DELAY_MS = 30_000;

type RetryRuntime = {
  midRunCompactionRetry: { failures: number; retryAfter: number };
};

/** Clear backoff state after a successful compaction or pressure relief. */
export function resetMidRunRetry(runtime: RetryRuntime): void {
  runtime.midRunCompactionRetry = { failures: 0, retryAfter: 0 };
}

/** Arm the next retry after `delay` ms (1s, 2s, … capped at 30s). Returns the delay. */
export function recordMidRunFailure(runtime: RetryRuntime): number {
  const failures = runtime.midRunCompactionRetry.failures + 1;
  const delay = Math.min(MID_RUN_RETRY_MAX_DELAY_MS, 1000 * 2 ** (failures - 1));
  runtime.midRunCompactionRetry = {
    failures,
    retryAfter: Date.now() + delay,
  };
  return delay;
}

const retryInSeconds = (delayMs: number) => `; retrying in ${Math.ceil(delayMs / 1000)}s`;

export function registerCompactionTrigger(
  pi: ExtensionAPI,
  runtime: Runtime,
  inlineCompact: InlineCompaction = compactInlineAtTurnBoundary,
): void {
  pi.on("agent_start", (_event: any, ctx: any) => {
    // Reset the info gate — allow one info notification during the new turn.
    runtime.resetInfoGate();

    // A new turn is starting — abort any pending auto-compaction wait.
    // The new turn's own agent_end will re-evaluate the threshold and
    // schedule a fresh wait if compaction is still needed.
    if (runtime.autoCompactionController) {
      runtime.autoCompactionController.abort();
      runtime.autoCompactionController = null;
      runtime.compactInFlight = false;
    }

    // Resume mode was configured but the adapter is known-permanently
    // unavailable — surface that once so the setting isn't silently inert.
    if (
      runtime.config.midRunCompaction === "resume" &&
      runtime.inlineCompactionAdapterStatus?.supported === false &&
      !runtime.inlineCompactionWarningEmitted
    ) {
      runtime.inlineCompactionWarningEmitted = true;
      notifySafely(
        ctx?.hasUI ?? false,
        ctx?.ui,
        `Observational memory: mid-run compaction (resume) unavailable: ${runtime.inlineCompactionAdapterStatus.reason}; using settled compaction fallback`,
        "warning",
      );
    }
  });

  pi.on("agent_end", (event: any, ctx: any) => {
    try {
      handleAgentEnd(event, ctx, runtime);
    } catch (error) {
      if (isStaleExtensionContextError(error)) return;
      throw error;
    }
  });

  // Mid-run trigger: turn_end fires after every assistant-message + tool-execution
  // cycle while the agent is still working. agent_end only fires when the run
  // exits, so during long tool loops the threshold would otherwise never be
  // evaluated (the configured compactAfterTokens could be exceeded many times
  // over before compaction had a chance to run).
  pi.on("turn_end", async (_event: any, ctx: any) => {
    try {
      await handleTurnEnd(ctx, runtime, inlineCompact);
    } catch (error) {
      if (isStaleExtensionContextError(error)) return;
      throw error;
    }
  });
}

async function handleTurnEnd(
  ctx: any,
  runtime: Runtime,
  inlineCompact: InlineCompaction,
): Promise<void> {
  runtime.ensureConfig(ctx.cwd, (msg) => ctx.ui?.notify?.(msg, "warning"));
  const dbg = (ev: string, d?: Record<string, unknown>) =>
    debugLog(ev, d, runtime.config.debugLog === true);

  const mode = runtime.config.midRunCompaction ?? "off";
  if (mode === "off") {
    dbg("compaction_trigger.turn_end.skip", { reason: "midRunCompaction_off" });
    return;
  }
  const skipReason = autoCompactionSkipReason(runtime);
  if (skipReason) {
    dbg("compaction_trigger.turn_end.skip", { reason: skipReason });
    return;
  }
  if (runtime.compactInFlight) {
    dbg("compaction_trigger.turn_end.skip", { reason: "compactInFlight" });
    return;
  }
  if (ctx.signal?.aborted === true) {
    dbg("compaction_trigger.turn_end.skip", { reason: "active_run_aborted" });
    return;
  }

  const entries = ctx.sessionManager.getBranch() as Entry[];
  const tokens = rawTokensSinceLastCompaction(entries);
  if (tokens < runtime.config.compactAfterTokens) {
    // Pressure relieved (a compaction ran) — clear any failure backoff.
    resetMidRunRetry(runtime);
    return;
  }
  if (Date.now() < runtime.midRunCompactionRetry.retryAfter) {
    // A previous mid-run attempt failed recently; retrying every turn would
    // thrash the same failure. Backoff self-heals: retries resume shortly.
    dbg("compaction_trigger.turn_end.skip", {
      reason: "inline_retry_backoff",
      tokens,
      failures: runtime.midRunCompactionRetry.failures,
      retryAfter: runtime.midRunCompactionRetry.retryAfter,
    });
    return;
  }
  if (mode === "resume" && runtime.inlineCompactionAdapterStatus?.supported === false) {
    // The adapter already reported permanent unavailability — don't retry
    // a condition that cannot change mid-session.
    dbg("compaction_trigger.turn_end.skip", {
      reason: "inline_adapter_unsupported",
      tokens,
      reason_detail: runtime.inlineCompactionAdapterStatus.reason,
    });
    return;
  }

  const hasUI = ctx.hasUI;
  const ui = ctx.ui;
  dbg("compaction_trigger.turn_end.threshold_reached", {
    tokens,
    threshold: runtime.config.compactAfterTokens,
    mode,
  });
  runtime.tryEmitInfo(
    hasUI,
    ui,
    `Observational memory: compaction threshold reached mid-run (~${tokens.toLocaleString()} tokens); compacting${mode === "resume" ? " inline" : " and pausing"}`,
  );

  runtime.compactInFlight = true;

  if (mode === "resume") {
    try {
      await inlineCompact(ctx.sessionManager);
      resetMidRunRetry(runtime);
      dbg("compaction_trigger.turn_end.inline_complete");
      runtime.tryEmitInfo(
        hasUI,
        ui,
        "Observational memory: transparent mid-run compaction complete",
      );
    } catch (error) {
      if (isStaleExtensionContextError(error)) throw error;
      const message = getErrorMessage(error);
      if (error instanceof InlineCompactionUnavailableError) {
        // Permanent: this pi version doesn't expose the inline adapter API.
        // Classify once instead of cycling through the retry/backoff path.
        runtime.inlineCompactionAdapterStatus = {
          supported: false,
          reason: message,
        };
        dbg("compaction_trigger.turn_end.inline_adapter_unavailable", {
          message,
        });
        if (!runtime.inlineCompactionWarningEmitted) {
          runtime.inlineCompactionWarningEmitted = true;
          notifySafely(
            hasUI,
            ui,
            `Observational memory: ${message}; using settled compaction fallback`,
            "warning",
          );
        }
        return;
      }
      const delay = recordMidRunFailure(runtime);
      dbg("compaction_trigger.turn_end.inline_error", {
        message,
        failures: runtime.midRunCompactionRetry.failures,
        retryAfter: runtime.midRunCompactionRetry.retryAfter,
      });
      if (message !== "Compaction cancelled") {
        notifySafely(
          hasUI,
          ui,
          `Observational memory: transparent mid-run compaction failed: ${message}${retryInSeconds(delay)}`,
          "error",
        );
      }
    } finally {
      runtime.compactInFlight = false;

      if (hasUI && ctx.signal?.aborted !== true) {
        ui?.setWorkingVisible?.(true);
      }
    }
    return;
  }

  // pause is explicitly interrupting: native ctx.compact() aborts the current
  // run and leaves continuation to the user.
  ctx.compact({
    onComplete: () => {
      runtime.compactInFlight = false;
      resetMidRunRetry(runtime);
      dbg("compaction_trigger.turn_end.pause_complete");
      runtime.tryEmitInfo(
        hasUI,
        ui,
        "Observational memory: mid-run compaction complete; agent paused",
      );
    },
    onError: (error: { message: string }) => {
      runtime.compactInFlight = false;
      const delay = recordMidRunFailure(runtime);
      const message = error?.message ?? String(error);
      dbg("compaction_trigger.turn_end.pause_error", {
        message,
        failures: runtime.midRunCompactionRetry.failures,
        retryAfter: runtime.midRunCompactionRetry.retryAfter,
      });
      if (message !== "Compaction cancelled") {
        notifySafely(
          hasUI,
          ui,
          `Observational memory: mid-run compaction failed: ${message}${retryInSeconds(delay)}`,
          "error",
        );
      }
    },
  });
}

function handleAgentEnd(event: any, ctx: any, runtime: Runtime): void {
  runtime.ensureConfig(ctx.cwd, (msg) => ctx.ui?.notify?.(msg, "warning"));
  // Reset the info gate — allow one notification during agent_end.
  runtime.resetInfoGate();

  // Pass the config flag explicitly — this handler runs outside ALS context
  // (agent_end events don't flow through consolidation's withDebugLogContext),
  // and the setTimeout callback would lose ALS context anyway.
  const dbg = (ev: string, d?: Record<string, unknown>) =>
    debugLog(ev, d, runtime.config.debugLog === true);

  dbg("compaction_trigger.agent_end", {
    passive: runtime.config.passive,
    memory: runtime.config.memory,
    manualMode: runtime.config.compaction === "manual" || runtime.config.noAutoCompact === true,
    overrideDefaultCompaction: runtime.config.overrideDefaultCompaction,
    compactInFlight: runtime.compactInFlight,
    compactAfterTokens: runtime.config.compactAfterTokens,
  });

  // Unified + legacy compaction guards (shared with the turn_end path)
  const skipReason = autoCompactionSkipReason(runtime);
  if (skipReason) {
    dbg("compaction_trigger.skip", { reason: skipReason });
    return;
  }
  if (runtime.compactInFlight) {
    dbg("compaction_trigger.skip", { reason: "compactInFlight" });
    return;
  }

  // Don't trigger compaction if Pi will auto-retry — the agent hasn't truly finished.
  // Pi emits agent_end before its own retry check, so we must detect this ourselves.
  // The next agent_end (after retry succeeds or exhausts attempts) will re-evaluate.
  const lastAssistant = [...event.messages]
    .reverse()
    .find((m): m is Extract<typeof m, { role: "assistant" }> => m.role === "assistant");
  if (
    lastAssistant &&
    lastAssistant.stopReason === "error" &&
    lastAssistant.errorMessage &&
    RETRYABLE_ERROR_RE.test(lastAssistant.errorMessage)
  ) {
    return;
  }

  const entries = ctx.sessionManager.getBranch() as Entry[];
  dbg("compaction_trigger.branch_check", {
    branchLength: entries.length,
    hasLastEntry: entries.length > 0,
    lastEntryType: entries.length > 0 ? entries[entries.length - 1].type : "none",
  });

  const tokens = rawTokensSinceLastCompaction(entries);
  dbg("compaction_trigger.tokens", {
    tokens,
    compactAfterTokens: runtime.config.compactAfterTokens,
    branchLength: entries.length,
  });
  if (tokens < runtime.config.compactAfterTokens) {
    dbg("compaction_trigger.skip", {
      reason: "below_threshold",
      tokens,
      threshold: runtime.config.compactAfterTokens,
    });
    return;
  }
  if (Date.now() < runtime.midRunCompactionRetry.retryAfter) {
    dbg("compaction_trigger.skip", {
      reason: "mid_run_retry_backoff",
      tokens,
      failures: runtime.midRunCompactionRetry.failures,
      retryAfter: runtime.midRunCompactionRetry.retryAfter,
    });
    return;
  }

  // Capture ctx properties synchronously — the deferred callback below
  // may outlive the extension ctx (stale after session replacement/reload).
  const hasUI = ctx.hasUI;
  const ui = ctx.ui;
  const sessionId = ctx.sessionManager.getSessionId();

  dbg("compaction_trigger.threshold_reached", { tokens, sessionId, hasUI });

  runtime.tryEmitInfo(
    hasUI,
    ui,
    `Observational memory: compaction threshold reached (~${tokens.toLocaleString()} tokens); triggering compaction`,
  );

  runtime.compactInFlight = true;
  const controller = new AbortController();
  runtime.autoCompactionController = controller;
  const signal = controller.signal;
  dbg("compaction_trigger.scheduled", {
    compactInFlight: runtime.compactInFlight,
  });

  // Issue #31: keep waiting for the agent to become idle instead of bailing
  // after the first non-idle check. The agent may need a few hundred ms to
  // finish async work from other extension handlers (e.g. pi-rewind's
  // checkpoint I/O) before it is truly idle. The only legitimate cancellation
  // is the agent_start handler above aborting the controller.
  void (async () => {
    try {
      // Yield to the event loop first — matches the historical
      // setTimeout(0) deferral that lets other agent_end listeners run.
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Poll isIdle() every 200ms until it returns true. No max-retries
      // cap: the user can be reading the response for arbitrarily long.
      // ctx.compact() itself aborts any in-flight agent operation, so we
      // must wait until the agent is truly idle.
      let isIdle = false;
      while (!isIdle) {
        if (signal.aborted) {
          dbg("compaction_trigger.microtask.bail", {
            reason: "aborted_agent_start",
          });
          return;
        }

        // Validate session identity — bail if the session was replaced/reloaded.
        let currentSessionId: string;
        try {
          currentSessionId = ctx.sessionManager.getSessionId();
        } catch (error) {
          if (isStaleExtensionContextError(error)) {
            runtime.compactInFlight = false;
            runtime.autoCompactionController = null;
            dbg("compaction_trigger.microtask.bail", { reason: "stale_ctx" });
            return;
          }
          throw error;
        }
        dbg("compaction_trigger.microtask.session_check", {
          currentSessionId,
          expectedSessionId: sessionId,
          match: currentSessionId === sessionId,
        });
        if (currentSessionId !== sessionId) {
          runtime.compactInFlight = false;
          runtime.autoCompactionController = null;
          dbg("compaction_trigger.microtask.bail", {
            reason: "session_changed",
          });
          runtime.tryEmitInfo(
            hasUI,
            ui,
            "Observational memory: compaction cancelled — session changed before compaction",
          );
          return;
        }

        isIdle = ctx.isIdle();
        dbg("compaction_trigger.microtask.idle_check", { isIdle });
        if (!isIdle) {
          // Sleep in 50ms slices so agent_start aborts are noticed quickly.
          // A single 200ms await would let the loop run for 200ms after
          // the user typed — too long, since we want compaction to wait
          // only for the agent to settle, not for a full tick.
          const sliceMs = 50;
          const end = Date.now() + 200;
          while (Date.now() < end) {
            if (signal.aborted) {
              dbg("compaction_trigger.microtask.bail", {
                reason: "aborted_agent_start",
              });
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, sliceMs));
          }
        }
      }

      if (signal.aborted) {
        dbg("compaction_trigger.microtask.bail", {
          reason: "aborted_agent_start",
        });
        return;
      }

      const currentEntries = ctx.sessionManager.getBranch() as Entry[];
      const currentTokens = rawTokensSinceLastCompaction(currentEntries);
      dbg("compaction_trigger.microtask.recheck_tokens", {
        currentTokens,
        threshold: runtime.config.compactAfterTokens,
        ok: currentTokens >= runtime.config.compactAfterTokens,
      });
      if (currentTokens < runtime.config.compactAfterTokens) {
        runtime.compactInFlight = false;
        runtime.autoCompactionController = null;
        dbg("compaction_trigger.microtask.bail", {
          reason: "pressure_relieved",
          currentTokens,
          threshold: runtime.config.compactAfterTokens,
        });
        runtime.tryEmitInfo(
          hasUI,
          ui,
          "Observational memory: compaction skipped — another compaction already ran before deferred compaction",
        );
        return;
      }

      dbg("compaction_trigger.microtask.calling_compact", {});
      // Compaction is now actually starting — clear the controller so
      // agent_start doesn't abort an in-progress compact.
      runtime.autoCompactionController = null;
      ctx.compact({
        onComplete: (result: any) => {
          runtime.compactInFlight = false;
          dbg("compaction_trigger.onComplete", { result: !!result });
          runtime.tryEmitInfo(hasUI, ui, "Observational memory: compaction complete");
        },
        onError: (error: { message: string }) => {
          runtime.compactInFlight = false;
          dbg("compaction_trigger.onError", {
            message: error?.message ?? String(error),
          });
          if (error.message === "Compaction cancelled") {
            // We already notified the user with the real reason before returning { cancel: true }.
            return;
          }
          notifySafely(hasUI, ui, `Observational memory: ${error.message}`, "error");
        },
      });
    } catch (error) {
      runtime.compactInFlight = false;
      runtime.autoCompactionController = null;
      const msg = getErrorMessage(error);
      if (isStaleExtensionContextError(error)) {
        dbg("compaction_trigger.microtask.bail", {
          reason: "stale_ctx",
          message: msg,
        });
        return;
      }
      dbg("compaction_trigger.microtask.error", { message: msg });
      notifySafely(hasUI, ui, `Observational memory: compact threw: ${msg}`, "error");
    }
  })();
}
