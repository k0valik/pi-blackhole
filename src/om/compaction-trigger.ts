import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rawTokensSinceLastCompaction, type Entry } from "./ledger/index.js";
import type { Runtime } from "./runtime.js";
import { debugLog } from "./debug-log.js";
import { RETRYABLE_ERROR_RE } from "./retryable-error.js";

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

function notifySafely(hasUI: boolean, ui: any, message: string, level: "info" | "warning" | "error"): void {
	if (!hasUI) return;
	try {
		ui?.notify(message, level);
	} catch (error) {
		if (!isStaleExtensionContextError(error)) throw error;
	}
}

export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("agent_start", () => {
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
}

function handleAgentEnd(event: any, ctx: any, runtime: Runtime): void {
	runtime.ensureConfig(ctx.cwd);

		// Pass the config flag explicitly — this handler runs outside ALS context
		// (agent_end events don't flow through consolidation's withDebugLogContext),
		// and the setTimeout callback would lose ALS context anyway.
		const dbg = (ev: string, d?: Record<string, unknown>) => debugLog(ev, d, runtime.config.debugLog === true);

		dbg("compaction_trigger.agent_end", {
			passive: runtime.config.passive,
			memory: runtime.config.memory,
			noAutoCompact: runtime.config.noAutoCompact,
			overrideDefaultCompaction: runtime.config.overrideDefaultCompaction,
			compactInFlight: runtime.compactInFlight,
			compactAfterTokens: runtime.config.compactAfterTokens,
		});

		// NEW: Unified compaction guards
		if (runtime.config.compaction === "off") {
			dbg("compaction_trigger.skip", { reason: "compaction_off" });
			return;
		}
		if (runtime.config.compaction === "manual") {
			dbg("compaction_trigger.skip", { reason: "compaction_manual" });
			return;
		}
		if (runtime.config.compactionEngine === "pi-default") {
			dbg("compaction_trigger.skip", { reason: "compactionEngine_pi_default" });
			return;
		}
		// NOTE: memory no longer gates compaction — memory:false + compaction:auto = compact without OM

		// LEGACY: old config key guards — only apply when new keys are absent (unmigrated config)
		if (runtime.config.compaction === undefined && runtime.config.compactionEngine === undefined) {
			if (runtime.config.passive === true) {
				dbg("compaction_trigger.skip", { reason: "passive" });
				return;
			}
			if (runtime.config.noAutoCompact === true) {
				dbg("compaction_trigger.skip", { reason: "noAutoCompact" });
				return;
			}
			// Don't force Pi to compact unless the user explicitly opted into blackhole's pipeline.
			// When overrideDefaultCompaction is false (default), blackhole stays out of the way
			// and lets Pi handle its own compaction naturally.
			if (runtime.config.overrideDefaultCompaction === false) {
				dbg("compaction_trigger.skip", { reason: "overrideDefaultCompaction_false" });
				return;
			}
		}
		if (runtime.compactInFlight) {
			dbg("compaction_trigger.skip", { reason: "compactInFlight" });
			return;
		}

		// Don't trigger compaction if Pi will auto-retry — the agent hasn't truly finished.
		// Pi emits agent_end before its own retry check, so we must detect this ourselves.
		// The next agent_end (after retry succeeds or exhausts attempts) will re-evaluate.
		const lastAssistant = [...event.messages].reverse().find(
			(m): m is Extract<typeof m, { role: "assistant" }> => m.role === "assistant",
		);
		if (
			lastAssistant
			&& lastAssistant.stopReason === "error"
			&& lastAssistant.errorMessage
			&& RETRYABLE_ERROR_RE.test(lastAssistant.errorMessage)
		) {
			return;
		}

		const entries = ctx.sessionManager.getBranch() as Entry[];
		dbg("compaction_trigger.branch_check", { branchLength: entries.length, hasLastEntry: entries.length > 0, lastEntryType: entries.length > 0 ? entries[entries.length - 1].type : "none" });

		const tokens = rawTokensSinceLastCompaction(entries);
		dbg("compaction_trigger.tokens", { tokens, compactAfterTokens: runtime.config.compactAfterTokens, branchLength: entries.length });
		if (tokens < runtime.config.compactAfterTokens) {
			dbg("compaction_trigger.skip", { reason: "below_threshold", tokens, threshold: runtime.config.compactAfterTokens });
			return;
		}

		// Capture ctx properties synchronously — the deferred callback below
		// may outlive the extension ctx (stale after session replacement/reload).
		const hasUI = ctx.hasUI;
		const ui = ctx.ui;
		const sessionId = ctx.sessionManager.getSessionId();

		dbg("compaction_trigger.threshold_reached", { tokens, sessionId, hasUI });

		notifySafely(
			hasUI,
			ui,
			`Observational memory: compaction threshold reached (~${tokens.toLocaleString()} tokens); triggering compaction`,
			"info",
		);

	runtime.compactInFlight = true;
	const controller = new AbortController();
	runtime.autoCompactionController = controller;
	const signal = controller.signal;
	dbg("compaction_trigger.scheduled", { compactInFlight: runtime.compactInFlight });

	// Issue #31: keep waiting for the agent to become idle instead of bailing
	// after the first non-idle check. The agent may need a few hundred ms to
	// finish async work from other extension handlers (e.g. pi-rewind's
	// checkpoint I/O) before it is truly idle. The only legitimate cancellation
	// is the agent_start handler above aborting the controller.
	(async () => {
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
					dbg("compaction_trigger.microtask.bail", { reason: "aborted_agent_start" });
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
				dbg("compaction_trigger.microtask.session_check", { currentSessionId, expectedSessionId: sessionId, match: currentSessionId === sessionId });
				if (currentSessionId !== sessionId) {
					runtime.compactInFlight = false;
					runtime.autoCompactionController = null;
					dbg("compaction_trigger.microtask.bail", { reason: "session_changed" });
					notifySafely(
						hasUI,
						ui,
						"Observational memory: compaction cancelled — session changed before compaction",
						"info",
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
							dbg("compaction_trigger.microtask.bail", { reason: "aborted_agent_start" });
							return;
						}
						await new Promise((resolve) => setTimeout(resolve, sliceMs));
					}
				}
			}

			if (signal.aborted) {
				dbg("compaction_trigger.microtask.bail", { reason: "aborted_agent_start" });
				return;
			}

			const currentEntries = ctx.sessionManager.getBranch() as Entry[];
			const currentTokens = rawTokensSinceLastCompaction(currentEntries);
			dbg("compaction_trigger.microtask.recheck_tokens", { currentTokens, threshold: runtime.config.compactAfterTokens, ok: currentTokens >= runtime.config.compactAfterTokens });
			if (currentTokens < runtime.config.compactAfterTokens) {
				runtime.compactInFlight = false;
				runtime.autoCompactionController = null;
				dbg("compaction_trigger.microtask.bail", { reason: "pressure_relieved", currentTokens, threshold: runtime.config.compactAfterTokens });
				notifySafely(
					hasUI,
					ui,
					"Observational memory: compaction skipped — another compaction already ran before deferred compaction",
					"info",
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
					notifySafely(hasUI, ui, "Observational memory: compaction complete", "info");
				},
				onError: (error: { message: string }) => {
					runtime.compactInFlight = false;
					dbg("compaction_trigger.onError", { message: error?.message ?? String(error) });
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
				dbg("compaction_trigger.microtask.bail", { reason: "stale_ctx", message: msg });
				return;
			}
			dbg("compaction_trigger.microtask.error", { message: msg });
			notifySafely(hasUI, ui, `Observational memory: compact threw: ${msg}`, "error");
		}
	})();
}
