/**
 * Configure Overlay — editable settings overlay for pi-blackhole-config.json.
 *
 * Used by `/blackhole configure` to edit compaction, memory, and debug settings.
 * Opens as a floating overlay via ctx.ui.custom({ overlay: true }).
 * Navigation: ↑↓  Edit: Enter  Save: Ctrl+S  Cancel: Esc
 */

import { matchKey, visibleWidth } from "./key-matcher.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Field types
// ---------------------------------------------------------------------------

interface FieldDef {
	key: string;
	label: string;
	type: "number" | "boolean" | "enum";
	section: string;
	enumValues?: string[];
	helpText?: string;
}

interface FieldState {
	def: FieldDef;
	value: string;
	editing: boolean;
	cursor: number;
}

// ---------------------------------------------------------------------------
// Field definitions
// ---------------------------------------------------------------------------

const FIELDS: FieldDef[] = [
	// ── Compaction ──
	{ key: "compaction", label: "Compaction mode", type: "enum", section: "Compaction", enumValues: ["auto", "manual", "off"],
		helpText: "auto=trigger on threshold, manual=only /blackhole, off=auto:Pi handles, /blackhole:blackhole pipeline" },
	{ key: "compactionEngine", label: "Compaction engine", type: "enum", section: "Compaction", enumValues: ["blackhole", "pi-default"],
		helpText: "blackhole=structured summary+OM, pi-default=built-in Pi summarization" },
	{ key: "tailBehavior", label: "Visible tail", type: "enum", section: "Compaction", enumValues: ["pi-default", "minimal"],
		helpText: "pi-default=keep Pi's ~20k tok, minimal=keep last user message only" },
	{ key: "compactAfterTokens", label: "Auto-compact threshold", type: "number", section: "Compaction",
		helpText: "Token count that triggers auto-compaction when reached" },

	// ── Observational Memory ──
	{ key: "memory", label: "Observational memory", type: "boolean", section: "Observational Memory",
		helpText: "Enable OM workers (observer, reflector, dropper) and content injection" },
	{ key: "observeAfterTokens", label: "Observer threshold", type: "number", section: "Observational Memory",
		helpText: "Tokens accumulated since last observer run before triggering next observe" },
	{ key: "reflectAfterTokens", label: "Reflect + dropper threshold", type: "number", section: "Observational Memory",
		helpText: "Tokens accumulated since last reflect before triggering reflector and dropper" },
	{ key: "observationsPoolMaxTokens", label: "Observation pool max", type: "number", section: "Observational Memory",
		helpText: "Max tokens in observation pool before dropper prunes (fold pressure)" },
	{ key: "observationsPoolTargetTokens", label: "Observation pool target", type: "number", section: "Observational Memory",
		helpText: "Target tokens after dropper prunes (defaults to half of pool max)" },
	{ key: "reflectorInputMaxTokens", label: "Reflector input max", type: "number", section: "Observational Memory",
		helpText: "Max prompt tokens for reflector model input (rolling window cap)" },
	{ key: "dropperInputMaxTokens", label: "Dropper input max", type: "number", section: "Observational Memory",
		helpText: "Max prompt tokens for dropper model input (rolling window cap)" },
	{ key: "observerChunkMaxTokens", label: "Observer chunk max", type: "number", section: "Observational Memory",
		helpText: "Max source entry tokens sent to observer per chunk" },
	{ key: "observerPreambleMaxTokens", label: "Observer preamble max", type: "number", section: "Observational Memory",
		helpText: "Preamble budget in manual compaction mode (0=auto-compute 30% of chunk)" },
	{ key: "agentMaxTurns", label: "Max turns per agent", type: "number", section: "Observational Memory",
		helpText: "Shared turn cap for background memory agents" },
	{ key: "agentLoopReserve", label: "Agent loop reserve", type: "number", section: "Observational Memory",
		helpText: "Tokens reserved in context window for agent loop overhead" },

	// ── Debug ──
	{ key: "debug", label: "Debug snapshots", type: "boolean", section: "Debug",
		helpText: "Write detailed debug snapshots to /tmp/pi-blackhole-debug.json" },
	{ key: "debugLog", label: "Debug JSONL logging", type: "boolean", section: "Debug",
		helpText: "Write structured JSONL debug logs to agent directory" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatValue(def: FieldDef, rawValue: unknown): string {
	if (rawValue === undefined || rawValue === null) return "";
	switch (def.type) {
		case "boolean":
			return rawValue ? "on" : "off";
		default:
			return String(rawValue);
	}
}

// ---------------------------------------------------------------------------
// Theme helper — wraps a minimal theme shape
// ---------------------------------------------------------------------------

type ThemeShim = {
	fg: (style: string, text: string) => string;
};

const EMPTY_THEME: ThemeShim = {
	fg: (_s: string, t: string) => t,
};

// ---------------------------------------------------------------------------
// Overlay Component factory
// ---------------------------------------------------------------------------

export interface OverlayResult {
	saved: boolean;
	path: string;
}

/**
 * Create a ConfigureOverlay instance to pass to ctx.ui.custom().
 *
 * Usage:
 * ```ts
 * const result = await ctx.ui.custom<OverlayResult | undefined>(
 *   (tui, theme, _kb, done) => createConfigureOverlay(configPath, theme, tui, done),
 *   { overlay: true },
 * );
 * ```
 */
export function createConfigureOverlay(
	configPath: string,
	theme: unknown,
	tui: { requestRender: () => void },
	done: (result: OverlayResult | undefined) => void,
): { render(width: number): string[]; handleInput(data: string): void; invalidate(): void; dispose(): void } {
	const th: ThemeShim = (theme && typeof (theme as Record<string, unknown>).fg === "function")
		? theme as ThemeShim
		: EMPTY_THEME;

	// Parse config file
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
	} catch {
		raw = {};
	}

	const fields: FieldState[] = FIELDS.map((def) => ({
		def,
		value: formatValue(def, raw[def.key]),
		editing: false,
		cursor: 0,
	}));

	let selectedIndex = 0;
	let cachedLines: string[] | undefined;

	function invalidate(): void {
		cachedLines = undefined;
		try { tui.requestRender(); } catch { /* no-op */ }
	}

	function save(): boolean {
		try {
			const updated = { ...raw };
			for (const f of fields) {
				const val = f.value;
				if (val === "" && !(f.def.key in raw)) continue;
				switch (f.def.type) {
					case "boolean":
						updated[f.def.key] = val === "on";
						break;
					case "number": {
						const num = Number(val);
						updated[f.def.key] = (val && !isNaN(num)) ? num : raw[f.def.key];
						break;
					}
					case "enum":
						updated[f.def.key] = val;
						break;
					default:
						updated[f.def.key] = val;
						break;
				}
			}
			mkdirSync(dirname(configPath), { recursive: true });
			writeFileSync(configPath, JSON.stringify(updated, null, 2) + "\n");
			raw = updated;
			return true;
		} catch {
			return false;
		}
	}

	function handleInput(data: string): void {
		const cur = fields[selectedIndex];
		if (!cur) return;

		// While editing a number field
		if (cur.editing) {
			if (matchKey(data, "escape")) {
				cur.value = formatValue(cur.def, raw[cur.def.key]);
				cur.editing = false;
				invalidate();
				return;
			}
			if (matchKey(data, "enter") || matchKey(data, "tab")) {
				cur.editing = false;
				invalidate();
				return;
			}
			if (matchKey(data, "backspace")) {
				if (cur.cursor > 0) {
					cur.value = cur.value.slice(0, cur.cursor - 1) + cur.value.slice(cur.cursor);
					cur.cursor--;
					invalidate();
				}
				return;
			}
			if (matchKey(data, "left")) {
				cur.cursor = Math.max(0, cur.cursor - 1);
				invalidate();
				return;
			}
			if (matchKey(data, "right")) {
				cur.cursor = Math.min(cur.value.length, cur.cursor + 1);
				invalidate();
				return;
			}
			if (data.length === 1 && data >= "0" && data <= "9") {
				cur.value = cur.value.slice(0, cur.cursor) + data + cur.value.slice(cur.cursor);
				cur.cursor++;
				invalidate();
			}
			return;
		}

		// Not editing — global navigation

		// Ctrl+S → save and close
		if (matchKey(data, "ctrl+s")) {
			const saved = save();
			done({ saved, path: configPath });
			return;
		}

		// Esc → close without saving
		if (matchKey(data, "escape")) {
			done(undefined);
			return;
		}

		// Enter/space → edit/toggle
		if (matchKey(data, "enter") || matchKey(data, "space")) {
			switch (cur.def.type) {
				case "boolean":
					cur.value = cur.value === "on" ? "off" : "on";
					invalidate();
					break;
				case "enum": {
					const vals = cur.def.enumValues!;
					const idx = vals.indexOf(cur.value);
					cur.value = vals[(idx + 1) % vals.length];
					invalidate();
					break;
				}
				case "number":
					cur.editing = true;
					cur.cursor = cur.value.length;
					invalidate();
					break;
			}
			return;
		}

		// ↑↓ navigation
		if (matchKey(data, "up")) {
			selectedIndex = Math.max(0, selectedIndex - 1);
			invalidate();
			return;
		}
		if (matchKey(data, "down")) {
			selectedIndex = Math.min(fields.length - 1, selectedIndex + 1);
			invalidate();
			return;
		}
	}

	function render(width: number): string[] {
		if (cachedLines) return cachedLines;

		const w = Math.min(width - 2, 72);
		const innerW = w - 4;
		const fg = (style: string, text: string) => th.fg(style, text);

		const lines: string[] = [];

		// Top border + header
		lines.push(fg("border", `╭${"─".repeat(w - 2)}╮`));
		lines.push(fg("border", `│ ${fg("accent", "Blackhole Configuration")}${" ".repeat(innerW + 1 - 24)}│`));
		lines.push(fg("border", `├${"─".repeat(w - 2)}┤`));

		let currentSection = "";

		for (let i = 0; i < fields.length; i++) {
			const f = fields[i];
			const isSelected = i === selectedIndex;
			const isEditing = isSelected && f.editing;

			// Section header
			if (f.def.section !== currentSection) {
				currentSection = f.def.section;
				if (i > 0) {
					lines.push(fg("border", `│${" ".repeat(w - 2)}│`));
				}
				lines.push(fg("border", `│ ${fg("dim", `── ${currentSection} ──`)}${" ".repeat(Math.max(0, innerW + 1 - currentSection.length - 6))}│`));
			}

			// Field label
			const prefix = isSelected ? fg("accent", isEditing ? ">>" : " >") : "  ";
			const label = isSelected ? fg("accent", `${f.def.label}:`) : fg("text", `${f.def.label}:`);
			const labelStr = `${prefix} ${label}`;
			const labelVis = visibleWidth(labelStr);

			// Value
			let valueStr: string;
			if (isEditing) {
				const before = f.value.slice(0, f.cursor);
				const cursorChar = f.cursor < f.value.length ? f.value[f.cursor] : " ";
				const after = f.value.slice(f.cursor + 1);
				valueStr = `${before}\x1b[7m${cursorChar}\x1b[27m${after}`;
			} else {
				switch (f.def.type) {
					case "boolean":
						valueStr = f.value === "on" ? fg("success", "on") : fg("muted", "off");
						break;
					default:
						valueStr = f.value ? fg("text", f.value) : fg("dim", "(empty)");
						break;
				}
			}

			const valSpace = Math.max(10, innerW - labelVis - 1);
			const truncated = visibleWidth(valueStr) > valSpace
				? valueStr.slice(0, Math.max(0, valSpace - 3)) + "..."
				: valueStr;
			const remaining = innerW + 1 - labelVis - visibleWidth(truncated);

			lines.push(fg("border", `│ ${labelStr}${truncated}${" ".repeat(Math.max(1, remaining))}│`));

			// Help text for selected item
			if (isSelected && f.def.helpText && !isEditing) {
				const help = fg("dim", f.def.helpText);
				const helpRemaining = innerW - visibleWidth(help);
				lines.push(fg("border", `│  ${help}${" ".repeat(Math.max(1, helpRemaining))}│`));
			}
		}

		// Bottom hints
		lines.push(fg("border", `│${" ".repeat(w - 2)}│`));
		const hintText = " Ctrl+S save  \u2191\u2193 navigate  Enter toggle  Esc cancel ";
		lines.push(fg("border", `│${fg("accent", hintText)}${" ".repeat(Math.max(1, innerW + 2 - visibleWidth(hintText)))}│`));
		lines.push(fg("border", `╰${"─".repeat(w - 2)}╯`));

		cachedLines = lines;
		return lines;
	}

	return { render, handleInput, invalidate, dispose: () => {} };
}
