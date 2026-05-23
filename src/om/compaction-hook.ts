/**
 * Observational memory compaction hook — injects OM content into pi-vcc summaries.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (src/hooks/compaction-hook.ts)
 * NOTE: This hook is intentionally NOT registered in index.ts.
 * The joining point is in src/hooks/before-compact.ts which handles both
 * pi-vcc compilation AND OM projection in a single pass.
 * Kept as reference for the original standalone behavior.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { Runtime } from "./runtime.js";
import { buildCompactionProjection, renderSummary, type Entry } from "./ledger/index.js";

const DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS = 20_000;

function observationsPoolMaxTokens(runtime: Runtime): number {
	const value = (runtime.config as { observationsPoolMaxTokens?: unknown }).observationsPoolMaxTokens;
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS;
}

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_before_compact", async (event: any, ctx: any) => {
		// Dead code — this hook is intentionally not registered in index.ts.
		// Kept as reference for the original observational-memory behavior.
		if ((runtime.config as any).disableCompactionHook) return;
		if (runtime.compactHookInFlight) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Observational memory: another compaction is already in progress; cancelling duplicate",
					"warning",
				);
			}
			return { cancel: true };
		}

		runtime.compactHookInFlight = true;
		try {
			runtime.ensureConfig(ctx.cwd);
			const { preparation, branchEntries } = event;
			const { firstKeptEntryId, tokensBefore } = preparation;
			const projection = buildCompactionProjection(
				branchEntries as Entry[],
				firstKeptEntryId,
				{ observationsPoolMaxTokens: observationsPoolMaxTokens(runtime) },
			);
			const summary = renderSummary(projection.reflections, projection.observations);

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
					details: projection.details,
				},
			};
		} finally {
			runtime.compactHookInFlight = false;
		}
	});
}
