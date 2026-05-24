/**
 * /pi-vcc command — triggers pi-vcc compaction.
 *
 * Upstream: https://github.com/sting8k/pi-vcc (src/commands/pi-vcc.ts)
 * Modified by pi-vcc-om:
 * - Flushes pending OM state (observations/reflections/dropped) when noAutoCompact is active
 *   before triggering compaction, so the compaction summary includes all accumulated memory.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../om/runtime.js";
import { PI_VCC_COMPACT_INSTRUCTION } from "../hooks/before-compact";
import { saveUnifiedConfig } from "../core/unified-config.js";
import { readPendingState, clearPendingState, hasPendingData } from "../om/pending.js";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
} from "../om/ledger/index.js";

const formatTokens = (n: number): string => {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
};

export const registerPiVccCommand = (pi: ExtensionAPI, runtime: Runtime) => {
	pi.registerCommand("blackhole", {
		description:
			"Compact conversation — structured summary (with observational memory when enabled). " +
			"Subcommands: /blackhole om-off (disable memory), /blackhole om-on (re-enable memory).",
		handler: async (args, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();

			// Handle om-off / om-on subcommands
			const trimmed = (typeof args === "string" ? args : "").trim();
			if (trimmed === "om-off") {
				const saved = saveUnifiedConfig({ memory: false });
				runtime.config.memory = false;
				ctx.ui.notify(
					saved ? "Observational memory disabled. Use /blackhole om-on to re-enable." : "Failed to save config.",
					"info",
				);
				return;
			}
			if (trimmed === "om-on") {
				const saved = saveUnifiedConfig({ memory: true });
				runtime.config.memory = true;
				ctx.ui.notify(
					saved ? "Observational memory enabled." : "Failed to save config.",
					"info",
				);
				return;
			}

			// If noAutoCompact: flush pending OM entries into the branch
			// before compacting so the summary includes accumulated memory.
			if (runtime.config.noAutoCompact && hasPendingData(sessionId)) {
				const pending = readPendingState(sessionId);
				if (pending.observation) {
					pi.appendEntry(OM_OBSERVATIONS_RECORDED, pending.observation.data);
				}
				if (pending.reflection) {
					pi.appendEntry(OM_REFLECTIONS_RECORDED, pending.reflection.data);
				}
				if (pending.dropped) {
					pi.appendEntry(OM_OBSERVATIONS_DROPPED, pending.dropped.data);
				}
				clearPendingState(sessionId);
				ctx.ui.notify("Observational memory: pending entries flushed", "info");
			}

			ctx.compact({
				customInstructions: PI_VCC_COMPACT_INSTRUCTION,
				onComplete: () => {
					const stats = runtime.compactionStats;
					if (stats) {
						ctx.ui.notify(
							`blackhole: ${stats.summarized} source entries processed; tail kept ${stats.kept} (~${formatTokens(stats.keptTokensEst)} tok).`,
							"info",
						);
					} else {
						ctx.ui.notify("Compacted with blackhole", "info");
					}
				},
				onError: (err) => {
					if (err.message === "Compaction cancelled" || err.message === "Already compacted") {
						ctx.ui.notify("Nothing to compact", "warning");
					} else {
						ctx.ui.notify(`Compaction failed: ${err.message}`, "error");
					}
				},
			});
		},
	});
};
