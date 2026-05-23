/**
 * /memory command — shows memory pipeline status and content.
 *
 * Created by pi-vcc-om. Replaces OM's standalone /om-status and /om-view.
 * Usage: /memory (status), /memory view, /memory full.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyTextToClipboard } from "../om/clipboard.js";
import type { Runtime } from "../om/runtime.js";
import {
	diffProjection,
	foldLedger,
	fullProjection,
	observationToSummaryLine,
	rawTokensSinceDropCoverage,
	rawTokensSinceLastCompaction,
	rawTokensSinceObservationCoverage,
	rawTokensSinceReflectionCoverage,
	reflectionToSummaryLine,
	visibleProjection,
	type Entry,
	type Projection,
} from "../om/ledger/index.js";
import { readPendingState } from "../om/pending.js";

function firstArg(args: unknown): string | undefined {
	if (Array.isArray(args)) return typeof args[0] === "string" ? args[0] : undefined;
	if (typeof args === "string") return args.trim().split(/\s+/)[0];
	if (args && typeof args === "object" && "mode" in args) {
		const mode = (args as { mode?: unknown }).mode;
		return typeof mode === "string" ? mode : undefined;
	}
	return undefined;
}

function pct(current: number, total: number): number {
	return total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
}

function tokenSum(items: { tokenCount: number }[]): number {
	return items.reduce((sum, item) => sum + item.tokenCount, 0);
}

function addedSuffix(count: number): string | undefined {
	return count > 0 ? `+${count.toLocaleString()}` : undefined;
}

function removedSuffix(count: number): string | undefined {
	return count > 0 ? `-${count.toLocaleString()}` : undefined;
}

function appendSuffixes(line: string, suffixes: (string | undefined)[]): string {
	const rendered = suffixes.filter((s): s is string => s !== undefined);
	return rendered.length > 0 ? `${line} ${rendered.join(" ")}` : line;
}

function renderList<T>(items: T[], render: (item: T) => string, empty: string): string {
	return items.length > 0 ? items.map(render).join("\n") : empty;
}

function renderContentOnlyProjection(projection: Projection, emptyScope: "visible" | "recorded"): string {
	return [
		"── Reflections ──",
		renderList(projection.reflections, reflectionToSummaryLine, `No ${emptyScope} reflections.`),
		"",
		"── Observations ──",
		renderList(projection.observations, observationToSummaryLine, `No ${emptyScope} observations.`),
	].join("\n");
}

export function registerMemoryCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("blackhole-recall", {
		description: "Show memory pipeline status & token counters. /blackhole-recall for overview, /blackhole-recall view for visible observations & reflections, /blackhole-recall full for complete recorded memory (copies to clipboard).",
		handler: async (args, ctx) => {
			runtime.ensureConfig(ctx.cwd);
			const entries = ctx.sessionManager.getBranch() as Entry[];
			const sessionId = ctx.sessionManager.getSessionId();
			const mode = firstArg(args);

			// /memory full — show full recorded memory + copy to clipboard
			if (mode === "full") {
				const projection = fullProjection(entries);
				const output = renderContentOnlyProjection(projection, "recorded");
				const copied = await copyTextToClipboard(output).catch(() => false);
				ctx.ui.notify(
					copied ? `${output}\n\nCopied to clipboard.` : `${output}\n\nFailed to copy to clipboard.`,
					"info",
				);
				return;
			}

			// /memory view — show visible memory + copy to clipboard
			if (mode === "view") {
				const projection = visibleProjection(entries);
				const output = renderContentOnlyProjection(projection, "visible");
				const copied = await copyTextToClipboard(output).catch(() => false);
				ctx.ui.notify(
					copied ? `${output}\n\nCopied to clipboard.` : `${output}\n\nFailed to copy to clipboard.`,
					"info",
				);
				return;
			}

			// /memory (no args) — show status
			if (mode && mode !== "status") {
				ctx.ui.notify("Usage: /blackhole-recall [status|view|full]", "info");
				return;
			}

			const folded = foldLedger(entries);
			const visible = visibleProjection(entries);
			const full = fullProjection(entries);
			const drift = diffProjection(visible, full);

			const visibleObservationTokens = tokenSum(visible.observations);
			const visibleReflectionTokens = tokenSum(visible.reflections);
			const observationLine = appendSuffixes(
				`Observations: ${folded.observations.length} recorded / ${folded.droppedObservationIds.size} dropped / ${visible.observations.length} visible`,
				[
					addedSuffix(drift.observationsOnlyInFull.length),
					removedSuffix(drift.droppedOnlyInFull.length),
				],
			);
			const reflectionLine = appendSuffixes(
				`Reflections:  ${folded.reflections.length} recorded / ${visible.reflections.length} visible`,
				[addedSuffix(drift.reflectionsOnlyInFull.length)],
			);
			const obsProgress = rawTokensSinceObservationCoverage(entries);
			const reflectionProgress = rawTokensSinceReflectionCoverage(entries);
			const dropProgress = rawTokensSinceDropCoverage(entries);
			const compactionProgress = rawTokensSinceLastCompaction(entries);

			const passiveLines = runtime.config.passive === true
				? [
					"── Mode ──",
					"Passive: automatic memory workers and auto-compaction disabled",
					"",
				]
				: [];

			const lines = [
				...passiveLines,
				"── Memory ──",
				observationLine,
				reflectionLine,
				"",
				"── Activity ──",
				`Observer:       ~${obsProgress.toLocaleString()} / ${runtime.config.observeAfterTokens.toLocaleString()} tokens (${pct(obsProgress, runtime.config.observeAfterTokens)}%)`,
				`Reflector:      ~${reflectionProgress.toLocaleString()} / ${runtime.config.reflectAfterTokens.toLocaleString()} tokens (${pct(reflectionProgress, runtime.config.reflectAfterTokens)}%)`,
				`Dropper:        ~${dropProgress.toLocaleString()} / ${runtime.config.reflectAfterTokens.toLocaleString()} tokens (${pct(dropProgress, runtime.config.reflectAfterTokens)}%)`,
				`Compaction:     ~${compactionProgress.toLocaleString()} / ${runtime.config.compactAfterTokens.toLocaleString()} tokens (${pct(compactionProgress, runtime.config.compactAfterTokens)}%)`,
				`Obs pool:       ~${visibleObservationTokens.toLocaleString()} / ${runtime.config.observationsPoolMaxTokens.toLocaleString()} tokens (${pct(visibleObservationTokens, runtime.config.observationsPoolMaxTokens)}%)`,
				`Reflect pool:   ~${visibleReflectionTokens.toLocaleString()} tokens`,
			];

			// Show pending data when noAutoCompact is active
			if (runtime.config.noAutoCompact) {
				const pending = readPendingState(sessionId);
				const hasObs = !!pending.observation;
				const hasRef = !!pending.reflection;
				const hasDrop = !!pending.dropped;
				if (hasObs || hasRef || hasDrop) {
					lines.push("", "── Pending (noAutoCompact) ──");
					if (hasObs) lines.push("Observation:  waiting in pending.json");
					if (hasRef) lines.push("Reflection:   waiting in pending.json");
					if (hasDrop) lines.push("Dropper:      waiting in pending.json");
					lines.push("Run /blackhole to flush and compact.");
				}
			}

			if (runtime.consolidationInFlight || runtime.compactInFlight || runtime.compactHookInFlight) {
				lines.push("", "── In flight ──");
				if (runtime.consolidationInFlight) {
					const phase = runtime.consolidationPhase ? ` (${runtime.consolidationPhase})` : "";
					lines.push(`Consolidation: running${phase}`);
				}
				if (runtime.compactInFlight) lines.push("Auto-compaction: running");
				if (runtime.compactHookInFlight) lines.push("Compaction hook: running");
			}

			if (runtime.lastObserverError || runtime.lastReflectorError || runtime.lastDropperError) {
				lines.push("", "── Last error ──");
				if (runtime.lastObserverError) lines.push(`Observer: ${runtime.lastObserverError}`);
				if (runtime.lastReflectorError) lines.push(`Reflector: ${runtime.lastReflectorError}`);
				if (runtime.lastDropperError) lines.push(`Dropper: ${runtime.lastDropperError}`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
