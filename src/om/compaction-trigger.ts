import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rawTokensSinceLastCompaction, type Entry } from "./ledger/index.js";
import type { Runtime } from "./runtime.js";
import { debugLog } from "./debug-log.js";

/**
 * Regex matching Pi's internal retryable error detection.
 * When the last assistant message in agent_end has stopReason "error" matching this pattern,
 * Pi will auto-retry — we must not trigger compaction between attempts.
 */
const RETRYABLE_ERROR_RE =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("agent_end", (event: any, ctx: any) => {
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

		if (hasUI) ui?.notify(
			`Observational memory: compaction threshold reached (~${tokens.toLocaleString()} tokens); triggering compaction`,
			"info",
		);

		runtime.compactInFlight = true;
		dbg("compaction_trigger.scheduled", { compactInFlight: runtime.compactInFlight });

		setTimeout(() => {
			dbg("compaction_trigger.microtask.enter", {});
			try {
				// Validate session identity — bail if the session was replaced/reloaded.
				const currentSessionId = ctx.sessionManager.getSessionId();
				dbg("compaction_trigger.microtask.session_check", { currentSessionId, expectedSessionId: sessionId, match: currentSessionId === sessionId });
				if (currentSessionId !== sessionId) {
					runtime.compactInFlight = false;
					dbg("compaction_trigger.microtask.bail", { reason: "session_changed" });
					if (hasUI) ui?.notify(
						"Observational memory: compaction cancelled — session changed before compaction",
						"info",
					);
					return;
				}

				const isIdle = ctx.isIdle();
				dbg("compaction_trigger.microtask.idle_check", { isIdle });
				if (!isIdle) {
					runtime.compactInFlight = false;
					dbg("compaction_trigger.microtask.bail", { reason: "not_idle" });
					if (hasUI) ui?.notify(
						"Observational memory: compaction deferred — agent became busy before compaction",
						"info",
					);
					return;
				}
				const currentEntries = ctx.sessionManager.getBranch() as Entry[];
				const currentTokens = rawTokensSinceLastCompaction(currentEntries);
				dbg("compaction_trigger.microtask.recheck_tokens", { currentTokens, threshold: runtime.config.compactAfterTokens, ok: currentTokens >= runtime.config.compactAfterTokens });
				if (currentTokens < runtime.config.compactAfterTokens) {
					runtime.compactInFlight = false;
					dbg("compaction_trigger.microtask.bail", { reason: "pressure_relieved", currentTokens, threshold: runtime.config.compactAfterTokens });
					if (hasUI) ui?.notify(
						"Observational memory: compaction skipped — another compaction already ran before deferred compaction",
						"info",
					);
					return;
				}

				dbg("compaction_trigger.microtask.calling_compact", {});
				ctx.compact({
					onComplete: (result: any) => {
						runtime.compactInFlight = false;
						dbg("compaction_trigger.onComplete", { result: !!result });
						if (hasUI) ui?.notify("Observational memory: compaction complete", "info");
					},
					onError: (error: { message: string }) => {
						runtime.compactInFlight = false;
						dbg("compaction_trigger.onError", { message: error?.message ?? String(error) });
						if (error.message === "Compaction cancelled") {
							// We already notified the user with the real reason before returning { cancel: true }.
							return;
						}
						if (hasUI) ui?.notify(`Observational memory: ${error.message}`, "error");
					},
				});
			} catch (error) {
				runtime.compactInFlight = false;
				const msg = error instanceof Error ? error.message : String(error);
				dbg("compaction_trigger.microtask.error", { message: msg });
				if (hasUI) ui?.notify(`Observational memory: compact threw: ${msg}`, "error");
			}
		}, 0);
	});
}
