/**
 * Terminal utilities shared by blackhole overlay components.
 *
 * Key matcher — standalone replacement for pi-tui's `matchesKey`
 * to keep overlay components free of that dependency.
 *
 * visibleWidth — CJK-aware visible width for terminal columns,
 * extracted from pi-tui to avoid import resolution issues.
 *
 * Ported from voice-type extension's key-matcher.ts.
 */

// ---------------------------------------------------------------------------
// Key matching
// ---------------------------------------------------------------------------

export function matchKey(data: string, key: string): boolean {
	// Escape
	if (key === "escape") return data === "\x1b";
	// Enter
	if (key === "enter") return data === "\r" || data === "\n";
	// Tab
	if (key === "tab") return data === "\t";
	// Space
	if (key === "space") return data === " ";
	// Backspace
	if (key === "backspace") return data === "\x7f" || data === "\b";
	// Arrows
	if (key === "up") return data === "\x1b[A" || data === "\x1bOA";
	if (key === "down") return data === "\x1b[B" || data === "\x1bOB";
	if (key === "left") return data === "\x1b[D" || data === "\x1bOD";
	if (key === "right") return data === "\x1b[C" || data === "\x1bOC";
	// Ctrl+letter (must be exactly 6 chars: "ctrl+" + one lowercase letter)
	if (key.startsWith("ctrl+") && key.length === 6) {
		const letter = key[5];
		if (letter && letter >= "a" && letter <= "z") {
			const code = letter.charCodeAt(0) - 96; // ctrl+a = 1, ctrl+z = 26
			return data.length === 1 && data.charCodeAt(0) === code;
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Visible width (CJK-aware)
// ---------------------------------------------------------------------------

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Calculate the visible width of a string in terminal columns.
 * Strips ANSI codes and counts CJK characters as width 2.
 */
export function visibleWidth(s: string): number {
	const stripped = stripAnsi(s);
	let w = 0;
	for (const ch of stripped) {
		const code = ch.codePointAt(0)!;
		if (code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a ||
			(code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff01 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ||
			(code >= 0x1b000 && code <= 0x1b0ff) || (code >= 0x20000 && code <= 0x2fa1f))) {
			w += 2;
		} else {
			w += 1;
		}
	}
	return w;
}
