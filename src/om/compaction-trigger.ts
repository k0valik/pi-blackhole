import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rawTokensSinceLastCompaction, type Entry } from "./ledger/index.js";
import type { Runtime } from "./runtime.js";

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
		if (runtime.config.passive === true) return;
		if (runtime.config.memory === false) return;
		if (runtime.config.noAutoCompact === true) return;
		if (runtime.compactInFlight) return;

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
		const tokens = rawTokensSinceLastCompaction(entries);
		if (tokens < runtime.config.compactAfterTokens) return;

		// Capture ctx properties synchronously — the deferred callback below
		// may outlive the extension ctx (stale after session replacement/reload).
		const hasUI = ctx.hasUI;
		const ui = ctx.ui;
		const sessionId = ctx.sessionManager.getSessionId();

		if (hasUI) ui?.notify(
			`Observational memory: compaction threshold reached (~${tokens.toLocaleString()} tokens); triggering compaction`,
			"info",
		);

		runtime.compactInFlight = true;
		queueMicrotask(() => {
			try {
				// Validate session identity — bail if the session was replaced/reloaded.
				const currentSessionId = ctx.sessionManager.getSessionId();
				if (currentSessionId !== sessionId) {
					runtime.compactInFlight = false;
					if (hasUI) ui?.notify(
						"Observational memory: compaction cancelled — session changed before compaction",
						"info",
					);
					return;
				}

				if (!ctx.isIdle()) {
					runtime.compactInFlight = false;
					if (hasUI) ui?.notify(
						"Observational memory: compaction deferred — agent became busy before compaction",
						"info",
					);
					return;
				}
				const currentEntries = ctx.sessionManager.getBranch() as Entry[];
				const currentTokens = rawTokensSinceLastCompaction(currentEntries);
				if (currentTokens < runtime.config.compactAfterTokens) {
					runtime.compactInFlight = false;
					if (hasUI) ui?.notify(
						"Observational memory: compaction skipped — another compaction already ran before deferred compaction",
						"info",
					);
					return;
				}
				ctx.compact({
					onComplete: () => {
						runtime.compactInFlight = false;
						if (hasUI) ui?.notify("Observational memory: compaction complete", "info");
					},
					onError: (error: { message: string }) => {
						runtime.compactInFlight = false;
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
				if (hasUI) ui?.notify(`Observational memory: compact threw: ${msg}`, "error");
			}
		});
	});
}
