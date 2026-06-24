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
		if (runtime.autoCompactionController) {
			const dbg = (ev: string, d?: Record<string, unknown>) => debugLog(ev, d, runtime.config.debugLog === true);
			dbg("compaction_trigger.cancel_on_agent_start", { compactInFlight: runtime.compactInFlight });
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
		if (runtime.config.overrideDefaultCompaction === false) {
			dbg("compaction_trigger.skip", { reason: "overrideDefaultCompaction_false" });
			return;
		}
	}
	if (runtime.compactInFlight) {
		dbg("compaction_trigger.skip", { reason: "compactInFlight" });
		return;
	}

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

	// Retry config: check every 200ms for up to 5 minutes (1500 retries).
	// Robust idle detection handles races where async agent_end handlers
	// (e.g. pi-rewind checkpointing) delay ctx.isIdle() or session changes.
	const MAX_RETRIES = 1500;
	const RETRY_INTERVAL_MS = 200;

	(async () => {
		try {
			// Yield to the event loop first to allow other agent_end listeners to run
			// and to match the historical deferral behavior that tests expect.
			await new Promise((resolve) => setTimeout(resolve, 0));

			for (let retryCount = 0; retryCount <= MAX_RETRIES; retryCount++) {
				if (signal.aborted) {
					dbg("compaction_trigger.microtask.bail", { reason: "aborted", retryCount });
					return;
				}

				dbg("compaction_trigger.microtask.enter", { retryCount });

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

				const isIdle = ctx.isIdle();
				dbg("compaction_trigger.microtask.idle_check", { isIdle, retryCount });
				if (isIdle) {
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
					runtime.autoCompactionController = null; // Successfully starting compaction, clear controller
					ctx.compact({
						onComplete: (result: any) => {
							runtime.compactInFlight = false;
							dbg("compaction_trigger.onComplete", { result: !!result });
							notifySafely(hasUI, ui, "Observational memory: compaction complete", "info");
						},
						onError: (error: { message: string }) => {
							runtime.compactInFlight = false;
							dbg("compaction_trigger.onError", { message: error?.message ?? String(error) });
							if (error.message === "Compaction cancelled") return;
							notifySafely(hasUI, ui, `Observational memory: ${error.message}`, "error");
						},
					});
					return;
				}

				if (retryCount < MAX_RETRIES) {
					dbg("compaction_trigger.microtask.retry", { retryCount, nextDelay: RETRY_INTERVAL_MS });
					await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
				} else {
					runtime.compactInFlight = false;
					runtime.autoCompactionController = null;
					dbg("compaction_trigger.microtask.bail", { reason: "not_idle_max_retries", retryCount });
					notifySafely(
						hasUI,
						ui,
						"Observational memory: compaction deferred — agent busy; will retry at next agent_end",
						"info",
					);
				}
			}
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
