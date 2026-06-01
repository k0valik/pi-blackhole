/**
 * Status Overlay — shows current compaction config, OM state, and pipeline status.
 *
 * Used by `/blackhole-memory` to display runtime state.
 * Opens as a floating overlay via ctx.ui.custom({ overlay: true }).
 * Press Enter/Space on "Open configure overlay" to open config overlay.
 * Esc to close.
 */

import { matchKey, visibleWidth } from "./key-matcher.js";

// ---------------------------------------------------------------------------
// Theme shape (duck-typed from what pi provides)
// ---------------------------------------------------------------------------

type ThemeShim = {
	fg: (style: string, text: string) => string;
};

const EMPTY_THEME: ThemeShim = {
	fg: (_s: string, t: string) => t,
};

// ---------------------------------------------------------------------------
// Status display
// ---------------------------------------------------------------------------

export interface StatusInfo {
	compaction: "auto" | "manual" | "off";
	compactionEngine: "blackhole" | "pi-default";
	tailBehavior: "pi-default" | "minimal";
	memory: boolean;
	compactAfterTokens: number;
	consolidationInFlight: boolean;
	compactInFlight: boolean;
	lastObserverError?: string;
	lastReflectorError?: string;
	lastDropperError?: string;
}

export interface StatusResult {
	action: "configure" | "close";
}

/**
 * Create a StatusOverlay instance to pass to ctx.ui.custom().
 *
 * Usage:
 * ```ts
 * const result = await ctx.ui.custom<StatusResult | undefined>(
 *   (tui, theme, _kb, done) => createStatusOverlay(info, theme, tui, done),
 *   { overlay: true },
 * );
 * if (result?.action === "configure") {
 *   // open configure overlay
 * }
 * ```
 */
export function createStatusOverlay(
	info: StatusInfo,
	theme: unknown,
	tui: { requestRender: () => void },
	done: (result: StatusResult | undefined) => void,
): { render(width: number): string[]; handleInput(data: string): void; invalidate(): void; dispose(): void } {
	const th: ThemeShim = (theme && typeof (theme as Record<string, unknown>).fg === "function")
		? theme as ThemeShim
		: EMPTY_THEME;

	const fg = (style: string, text: string) => th.fg(style, text);
	const dim = (s: string) => fg("dim", s);
	const accent = (s: string) => fg("accent", s);
	const success = (s: string) => fg("success", s);
	const warning = (s: string) => fg("warning", s);
	const error = (s: string) => fg("error", s);
	const muted = (s: string) => fg("muted", s);

	const configItems: { label: string; value: string }[] = [
		{ label: "Compaction", value: info.compaction },
		{ label: "Engine", value: info.compactionEngine },
		{ label: "Tail behavior", value: info.tailBehavior },
		{ label: "Memory", value: info.memory ? "Enabled" : "Disabled" },
		{ label: "Threshold", value: `${info.compactAfterTokens.toLocaleString()} tok` },
	];

	const pipelineItems: { label: string; value: string }[] = [
		{ label: "Compaction in flight", value: info.compactInFlight ? "yes" : "no" },
		{ label: "Consolidation in flight", value: info.consolidationInFlight ? "yes" : "no" },
	];

	const errorItems: { label: string; value: string }[] = [];
	if (info.lastObserverError) errorItems.push({ label: "Observer", value: info.lastObserverError });
	if (info.lastReflectorError) errorItems.push({ label: "Reflector", value: info.lastReflectorError });
	if (info.lastDropperError) errorItems.push({ label: "Dropper", value: info.lastDropperError });

	const actionItems = [
		{ label: "Open configure overlay", value: "configure" as const },
		{ label: "Close", value: "close" as const },
	];

	// Contiguous selectable item model: no section headers in nav indices
	const selectableConfigCount = configItems.length;
	const selectablePipelineCount = pipelineItems.length;
	const selectableErrorCount = errorItems.length;
	const selectableActionCount = actionItems.length;
	const totalSelectable = selectableConfigCount + selectablePipelineCount + selectableErrorCount + selectableActionCount;

	// Render helpers: map a contiguous nav index to the display positions
	// (section headers are inserted at render time, not in the nav model)
	const navIsAction = (idx: number) => idx >= selectableConfigCount + selectablePipelineCount + selectableErrorCount;

	let selectedIndex = 0;
	let cachedLines: string[] | undefined;

	function invalidate(): void {
		cachedLines = undefined;
		try { tui.requestRender(); } catch { /* no-op */ }
	}

	function handleInput(data: string): void {
		if (matchKey(data, "escape")) {
			done({ action: "close" });
			return;
		}

		if (matchKey(data, "enter") || matchKey(data, "space")) {
			if (navIsAction(selectedIndex)) {
				const actionIdx = selectedIndex - selectableConfigCount - selectablePipelineCount - selectableErrorCount;
				const action = actionItems[actionIdx]!;
				done({ action: action.value });
				return;
			}
			return;
		}

		if (matchKey(data, "up")) {
			selectedIndex = Math.max(0, selectedIndex - 1);
			invalidate();
			return;
		}
		if (matchKey(data, "down")) {
			selectedIndex = Math.min(totalSelectable - 1, selectedIndex + 1);
			invalidate();
			return;
		}
	}

	function render(width: number): string[] {
		if (cachedLines) return cachedLines;

		const w = Math.max(2, Math.min(width - 2, 74));
		const innerW = w - 4;

		const pad = (s: string, len: number) => {
			const vis = visibleWidth(s);
			return s + " ".repeat(Math.max(0, len - vis));
		};

		const line = (content: string) => `│ ${pad(content, innerW)} │`;
		const border = (s: string) => fg("border", s);

		const lines: string[] = [];

		// Top border + header
		lines.push(fg("border", `╭${"─".repeat(w - 2)}╮`));
		lines.push(fg("border", `│ ${accent("Blackhole Status")}${" ".repeat(Math.max(0, innerW + 1 - 16))}│`));
		lines.push(fg("border", `├${"─".repeat(w - 2)}┤`));

		// Config section
		lines.push(border(line(` ${dim("─── Compaction Config ───")}`)));
		for (let i = 0; i < configItems.length; i++) {
			const item = configItems[i]!;
			const isSelected = selectedIndex === i;
			const prefix = isSelected ? accent(" ›") : "  ";
			const label = isSelected ? accent(`${item.label}:`) : `${item.label}:`;
			let value: string;
			switch (item.label) {
				case "Compaction":
					value = item.value === "auto" ? accent(item.value) : item.value === "off" ? muted(item.value) : dim(item.value);
					break;
				case "Engine":
					value = item.value === "blackhole" ? success(item.value) : dim(item.value);
					break;
				case "Memory":
					value = item.value === "Enabled" ? success("Enabled") : muted("Disabled");
					break;
				default:
					value = dim(item.value);
			}
			lines.push(border(line(`${prefix} ${pad(label, 16)} ${value}`)));
		}

		// Pipeline section
		if (pipelineItems.length > 0) {
			lines.push(border(line(` ${dim("─── Pipeline ───")}`)));
			for (let i = 0; i < pipelineItems.length; i++) {
				const item = pipelineItems[i]!;
				const isSelected = selectedIndex === selectableConfigCount + i;
				const prefix = isSelected ? accent(" ›") : "  ";
				const label = isSelected ? accent(`${item.label}:`) : `${item.label}:`;
				const value = item.value === "yes" ? warning("yes") : dim("no");
				lines.push(border(line(`${prefix} ${pad(label, 16)} ${value}`)));
			}
		}

		// Errors section
		if (errorItems.length > 0) {
			lines.push(border(line(` ${dim("─── Last Errors ───")}`)));
			for (let i = 0; i < errorItems.length; i++) {
				const item = errorItems[i]!;
				const isSelected = selectedIndex === selectableConfigCount + selectablePipelineCount + i;
				const prefix = isSelected ? accent(" ›") : "  ";
				const label = isSelected ? accent(`${item.label}:`) : `${item.label}:`;
				const truncated = item.value.length > 40
					? item.value.slice(0, 37) + "..."
					: item.value;
				lines.push(border(line(`${prefix} ${pad(label, 16)} ${error(truncated)}`)));
			}
		}

		// Separator
		lines.push(border(line(` ${dim("─── Actions ───")}`)));

		// Action items
		for (let i = 0; i < actionItems.length; i++) {
			const item = actionItems[i]!;
			const isSelected = selectedIndex === selectableConfigCount + selectablePipelineCount + selectableErrorCount + i;
			const prefix = isSelected ? accent(" ▶") : "   ";
			const text = isSelected ? accent(item.label) : dim(item.label);
			lines.push(border(line(`${prefix} ${text}`)));
		}

		// Bottom hints
		lines.push(border(line("")));
		lines.push(border(dim(" ↑↓ navigate  Enter/Space select  Esc close ")));
		lines.push(fg("border", `╰${"─".repeat(w - 2)}╯`));

		cachedLines = lines;
		return lines;
	}

	return { render, handleInput, invalidate, dispose: () => {} };
}
