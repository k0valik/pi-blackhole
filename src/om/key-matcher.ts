/**
 * Terminal utilities shared by blackhole overlay components.
 *
 * visibleWidth — CJK-aware visible width for terminal columns,
 * extracted from pi-tui to avoid import resolution issues.
 *
 * Ported from voice-type extension's key-matcher.ts.
 */

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
