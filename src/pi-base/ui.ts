/**
 * Common theme overlays for TUI components.
 */
export function overlaySelectListTheme(theme: { fg: (color: string, text: string) => string }) {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("dim", text),
    noMatch: (text: string) => theme.fg("warning", text),
  };
}

/**
 * ANSI escape code constants.
 */
export const ESC = "\x1b";
export const BEL = "\x07";
export const ST = "\x1b\\"; // String Terminator for OSC 99 and tmux DCS
export const RESET = "\x1b[0m";

export type RGB = readonly [number, number, number];

export function fgRGB(c: RGB): string {
  return `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
}

export function bgRGB(c: RGB): string {
  return `\x1b[48;2;${c[0]};${c[1]};${c[2]}m`;
}
