import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rawTokensSinceLastCompaction, type Entry } from "./ledger/index.js";
import type { Runtime } from "./runtime.js";
import { debugLog } from "./debug-log.js";
import { RETRYABLE_ERROR_RE } from "./retryable-error.js";
import { effectiveContextWindow } from "./model-budget.js";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function isStaleExtensionContextError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return (
    message.includes("extension ctx is stale") ||
    message.includes("ctx is stale")
  );
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
 * Message injected after a mid-run compaction so the agent resumes the task
 * instead of stopping (ctx.compact() aborts the in-flight run and Pi does not
 * auto-continue).
 */
export const MID_RUN_RESUME_CUSTOM_TYPE = "blackhole-resume";
export const MID_RUN_RESUME_MESSAGE =
  "Context was auto-compacted mid-task to stay under the token threshold. " +
  "The summary above preserves prior progress. Continue the task from where you left off.";

/**
 * Resolve the auto-compaction threshold in tokens.
 *
 * When compactAfterPercent is configured and the active model's context
 * window is known, the threshold is percent × contextWindow — so one config
 * value adapts across models with very different windows. Otherwise the
 * absolute compactAfterTokens applies unchanged.
 */
export function resolveCompactThreshold(
  runtime: Runtime,
  model: { contextWindow?: unknown } | undefined,
): number {
  const percent = runtime.config.compactAfterPercent;
  if (
    percent !== undefined &&
    model &&
    typeof model.contextWindow === "number" &&
    model.contextWindow > 0
  ) {
    return Math.floor(effectiveContextWindow(model as any) * percent);
  }
  return runtime.config.compactAfterTokens;
}

/**
 * Shared config gating for auto-compaction (agent_end and turn_end paths).
 * Returns null when compaction may proceed, or a skip reason string.
 */
function autoCompactionSkipReason(runtime: Runtime): string | null {
  if (runtime.config.compaction === "off") return "compaction_off";
  if (runtime.config.compaction === "manual") return "compaction_manual";
  if (runtime.config.compactionEngine === "pi-default")
    return "compactionEngine_pi_default";
  // NOTE: memory does not gate compaction — memory:false + compaction:auto = compact without OM

  // LEGACY: old config key guards — only apply when new keys are absent (unmigrated config)
  if (
    runtime.config.compaction === undefined &&
    runtime.config.compactionEngine === undefined
  ) {
    if (runtime.config.passive === true) return "passive";
    if (runtime.config.noAutoCompact === true) return "manual";
    // Don't force Pi to compact unless the user explicitly opted into blackhole's pipeline.
    if (runtime.config.overrideDefaultCompaction === false)
      return "overrideDefaultCompaction_false";
  }
  return null;
}

export function registerCompactionTrigger(
  pi: ExtensionAPI,
  runtime: Runtime,
): void {
  pi.on("agent_start", () => {
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
  pi.on("turn_end", (_event: any, ctx: any) => {
    try {
      handleTurnEnd(ctx, runtime, pi);
    } catch (error) {
      if (isStaleExtensionContextError(error)) return;
      throw error;
    }
  });
}

function handleTurnEnd(ctx: any, runtime: Runtime, pi: ExtensionAPI): void {
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

  const entries = ctx.sessionManager.getBranch() as Entry[];
  const tokens = rawTokensSinceLastCompaction(entries);
  const threshold = resolveCompactThreshold(runtime, ctx.model);
  if (tokens < threshold) {
    // Pressure relieved (a compaction ran) — lift any failure suspension.
    runtime.midRunCompactionSuspended = false;
    return;
  }
  if (runtime.midRunCompactionSuspended) {
    // A previous mid-run attempt failed/cancelled at this pressure level.
    // Re-triggering every turn would thrash (each attempt aborts the run).
    // Stay suspended until a compaction lowers pressure below the threshold.
    dbg("compaction_trigger.turn_end.skip", {
      reason: "suspended_after_failure",
      tokens,
    });
    return;
  }

  const hasUI = ctx.hasUI;
  const ui = ctx.ui;
  dbg("compaction_trigger.turn_end.threshold_reached", {
    tokens,
    threshold,
    mode,
  });
  runtime.tryEmitInfo(
    hasUI,
    ui,
    `Observational memory: compaction threshold reached mid-run (~${tokens.toLocaleString()} tokens); compacting${mode === "resume" ? " and resuming" : ""}`,
  );

  // ctx.compact() aborts the in-flight agent run before compacting — that is
  // the intended trade: turn_end is a clean boundary (tool results are already
  // persisted; at most one just-started LLM call is wasted).
  runtime.compactInFlight = true;
  ctx.compact({
    onComplete: (_result: any) => {
      runtime.compactInFlight = false;
      dbg("compaction_trigger.turn_end.onComplete", { mode });
      if (mode === "resume") {
        try {
          pi.sendMessage(
            {
              customType: MID_RUN_RESUME_CUSTOM_TYPE,
              content: MID_RUN_RESUME_MESSAGE,
              display: true,
            },
            { triggerTurn: true },
          );
        } catch (error) {
          if (!isStaleExtensionContextError(error)) throw error;
        }
      }
      runtime.tryEmitInfo(
        hasUI,
        ui,
        "Observational memory: mid-run compaction complete",
      );
    },
    onError: (error: { message: string }) => {
      runtime.compactInFlight = false;
      // Don't retry at this pressure level — the next attempt would abort the
      // run again just to fail the same way. Cleared when pressure drops.
      runtime.midRunCompactionSuspended = true;
      dbg("compaction_trigger.turn_end.onError", {
        message: error?.message ?? String(error),
      });
      if (error.message !== "Compaction cancelled") {
        notifySafely(
          hasUI,
          ui,
          `Observational memory: mid-run compaction failed: ${error.message}`,
          "error",
        );
      }
      // ctx.compact() already aborted the run. In resume mode the agent must
      // continue regardless of the failed compaction — otherwise it stalls
      // mid-task with no one at the wheel.
      if (mode === "resume") {
        try {
          pi.sendMessage(
            {
              customType: MID_RUN_RESUME_CUSTOM_TYPE,
              content: MID_RUN_RESUME_MESSAGE,
              display: true,
            },
            { triggerTurn: true },
          );
        } catch (sendError) {
          if (!isStaleExtensionContextError(sendError)) throw sendError;
        }
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
    manualMode:
      runtime.config.compaction === "manual" ||
      runtime.config.noAutoCompact === true,
    overrideDefaultCompaction: runtime.config.overrideDefaultCompaction,
    compactInFlight: runtime.compactInFlight,
    compactAfterTokens: runtime.config.compactAfterTokens,
    compactAfterPercent: runtime.config.compactAfterPercent,
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
    .find(
      (m): m is Extract<typeof m, { role: "assistant" }> =>
        m.role === "assistant",
    );
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
    lastEntryType:
      entries.length > 0 ? entries[entries.length - 1].type : "none",
  });

  const tokens = rawTokensSinceLastCompaction(entries);
  const threshold = resolveCompactThreshold(runtime, ctx.model);
  dbg("compaction_trigger.tokens", {
    tokens,
    threshold,
    branchLength: entries.length,
  });
  if (tokens < threshold) {
    dbg("compaction_trigger.skip", {
      reason: "below_threshold",
      tokens,
      threshold,
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
        threshold,
        ok: currentTokens >= threshold,
      });
      if (currentTokens < threshold) {
        runtime.compactInFlight = false;
        runtime.autoCompactionController = null;
        dbg("compaction_trigger.microtask.bail", {
          reason: "pressure_relieved",
          currentTokens,
          threshold,
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
          runtime.tryEmitInfo(
            hasUI,
            ui,
            "Observational memory: compaction complete",
          );
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
          notifySafely(
            hasUI,
            ui,
            `Observational memory: ${error.message}`,
            "error",
          );
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
      notifySafely(
        hasUI,
        ui,
        `Observational memory: compact threw: ${msg}`,
        "error",
      );
    }
  })();
}
