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
import { PI_VCC_COMPACT_INSTRUCTION, notifyMigrationReminder } from "../hooks/before-compact";
import { saveUnifiedConfig, configPath } from "../core/unified-config.js";
import { readPendingState, clearPendingState, hasPendingData } from "../om/pending.js";
import { createConfigureOverlay } from "../om/configure-overlay.js";
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
	const fuzzyMatch = (value: string, prefix: string): boolean => {
		const q = prefix.toLowerCase();
		let qi = 0;
		for (const ch of value) {
			if (qi < q.length && ch === q[qi]) qi++;
			if (qi === q.length) return true;
		}
		return false;
	};

	pi.registerCommand("blackhole", {
		description:
			"Compact conversation — structured summary (with observational memory when enabled). " +
			"Subcommands: /blackhole configure (open settings overlay), " +
			"/blackhole om-off (disable memory), /blackhole om-on (re-enable memory).",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = [
				{ value: "configure", label: "Open configuration overlay to edit settings [configure]" },
				{ value: "om-off", label: "Disable observational memory [om-off]" },
				{ value: "om-on", label: "Enable observational memory [om-on]" },
			];
			if (!prefix) return subcommands;
			return subcommands.filter((s) => fuzzyMatch(s.value, prefix));
		},
		handler: async (args, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();

			// Handle subcommands
			const trimmed = (typeof args === "string" ? args : "").trim();
			if (trimmed === "configure") {
				// Open the config overlay
				const result = await ctx.ui.custom<{ saved: boolean; path: string } | undefined>(
					(tui, theme, _kb, done) => createConfigureOverlay(configPath(), theme, tui, done),
					{ overlay: true },
				);
				if (result) {
					if (result.saved) {
						ctx.ui.notify("Configuration saved.", "info");
					} else {
						ctx.ui.notify("Failed to save configuration — the config file may be read-only (e.g., managed by Nix).", "warning");
					}
				}
				return;
			}
			if (trimmed === "om-off") {
				const saved = saveUnifiedConfig({ memory: false });
				runtime.config.memory = false;
				if (saved) {
					ctx.ui.notify("Observational memory disabled. Use /blackhole om-on to re-enable.", "info");
				} else {
					ctx.ui.notify(
						"Failed to save config — the config file may be read-only (e.g., managed by Nix). " +
						"Runtime state updated for this session only.",
						"warning",
					);
				}
				return;
			}
			if (trimmed === "om-on") {
				const saved = saveUnifiedConfig({ memory: true });
				runtime.config.memory = true;
				if (saved) {
					ctx.ui.notify("Observational memory enabled.", "info");
				} else {
					ctx.ui.notify(
						"Failed to save config — the config file may be read-only (e.g., managed by Nix). " +
						"Runtime state updated for this session only.",
						"warning",
					);
				}
				return;
			}

			// If compaction is manual (or legacy noAutoCompact): flush pending OM entries
			// into the branch before compacting so the summary includes accumulated memory.
			if (runtime.config.compaction === "manual" && hasPendingData(sessionId)) {
				const pending = readPendingState(sessionId);
				// Write all accumulated observation batches (or latest single batch
				// as fallback for legacy pending.json without batch arrays).
				const obsBatches = pending.observationBatches?.length
					? pending.observationBatches
					: (pending.observation ? [pending.observation] : []);
				for (const batch of obsBatches) {
					pi.appendEntry(OM_OBSERVATIONS_RECORDED, batch.data);
				}
				// Write all accumulated reflection batches (or latest single batch
				// as fallback for legacy pending.json without batch arrays).
				const reflBatches = pending.reflectionBatches?.length
					? pending.reflectionBatches
					: (pending.reflection ? [pending.reflection] : []);
				for (const batch of reflBatches) {
					pi.appendEntry(OM_REFLECTIONS_RECORDED, batch.data);
				}
				// Write all accumulated dropper batches (or latest single batch
				// as fallback for legacy pending.json without batch arrays).
				const dropBatches = pending.droppedBatches?.length
					? pending.droppedBatches
					: (pending.dropped ? [pending.dropped] : []);
				for (const batch of dropBatches) {
					pi.appendEntry(OM_OBSERVATIONS_DROPPED, batch.data);
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
					notifyMigrationReminder(sessionId, (msg, level) => ctx.ui.notify(msg, level as any));
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
