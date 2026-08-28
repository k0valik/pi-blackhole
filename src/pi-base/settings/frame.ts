/**
 * Rounded-light frame helpers for the settings modal — and for any
 * future overlay in this package that wants the same look.
 *
 * Visual:
 *
 *     ╭── Title ──────────────────────╮
 *     │                                │
 *     │   Muted              off       │
 *     │   Voice              Umbriel   │
 *     │                                │
 *     ╰────────────────────────────────╯
 *
 * The frame draws:
 *   - A single-line top border with an inline title pill (`╭── Title ──╮`).
 *     Title text is coloured via the host theme's `accent` foreground.
 *   - A bottom border closing with `╰─╯`.
 *   - Vertical sides as `│` separators.
 *   - `paddingY` blank rows above and below the body, plus `paddingX`
 *     spaces left and right of every body row.
 *   - Optional row-count cap (`fixedInnerRows`) so a too-tall body is
 *     truncated with a `↓ N more line(s)` indicator instead of overflowing
 *     the popup.
 *
 * All helpers are width-aware: every output line is right-truncated to
 * `width` columns using pi-tui's `truncateToWidth` so they never escape
 * the overlay rectangle.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Default horizontal padding inside the frame, in columns. */
export const DEFAULT_PADDING_X = 1;
/** Default vertical padding inside the frame, in rows. */
export const DEFAULT_PADDING_Y = 1;
/** Total vertical rows consumed by the frame chrome (top + bottom + 2× padY). */
export const FRAME_VERTICAL_CHROME = 2 + DEFAULT_PADDING_Y * 2;

export interface FrameOptions {
  /** Inline title in the top border. Truncated with `…` when too wide. */
  title?: string;
  /** Inner padding columns (left and right). Defaults to {@link DEFAULT_PADDING_X}. */
  paddingX?: number;
  /** Inner padding rows (top and bottom). Defaults to {@link DEFAULT_PADDING_Y}. */
  paddingY?: number;
  /**
   * Optional dim subtitle line(s) rendered directly under the top border,
   * above the usual `paddingY` blank rows. Accepts `\n` for multi-line
   * subtitles; each line is ANSI-aware truncated to fit `contentWidth`.
   */
  subtitle?: string;
  /**
   * If set, the body is forced to exactly this many inner rows. Excess
   * lines are replaced with a `↓ N more` indicator at the bottom; missing
   * lines are padded with blank rows so the overlay never visually shrinks
   * mid-session.
   */
  fixedInnerRows?: number;
}

/** Width available to body content, given a frame's outer `width`. */
export function frameContentWidth(width: number, paddingX: number = DEFAULT_PADDING_X): number {
  return Math.max(1, width - 2 - paddingX * 2);
}

/** Right-pad a (possibly ANSI-coloured) string to exactly `width` columns. */
export function pad(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

/**
 * Wrap `line` to fit `width` columns. Hard newlines split the line first;
 * each segment is then word-wrapped (ANSI-aware via pi-tui's helper) and
 * finally truncated as a defence-in-depth against pathological cases.
 */
export function wrapLine(line: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const normalized = String(line ?? "").replace(/\t/g, "  ");
  const wrapped = normalized.split(/\r?\n/).flatMap((part) => {
    const rows = wrapTextWithAnsi(part, safeWidth);
    return rows.length > 0 ? rows : [""];
  });
  return wrapped.map((part) => truncateToWidth(part, safeWidth, ""));
}

/** Render a single horizontal divider line, themed in `dim`. */
export function divider(width: number, theme: Theme): string {
  return theme.fg("dim", "─".repeat(Math.max(1, width)));
}

/** One key-hint pair as rendered in the modal's footer. */
export interface KeyHint {
  key: string;
  label: string;
}

/**
 * Format a list of key hints as a single line: each `key` rendered in
 * the host theme's `accent` colour and each `label` in `dim`, joined
 * by a dim middle-dot (`·`). Used by both the main settings modal
 * footer and any submenu that wants matching highlighting.
 *
 * Returns the raw composed string — caller is responsible for
 * truncating / wrapping if needed.
 */
export function formatHintLine(hints: KeyHint[], theme: Theme): string {
  return hints
    .map((h) => `${theme.fg("accent", h.key)} ${theme.fg("dim", h.label)}`)
    .join(theme.fg("dim", " · "));
}

/**
 * Wrap `lines` in a rounded-light frame. The top border embeds an
 * optional title pill rendered in the host theme's `accent` colour; the
 * border itself is themed in `borderAccent` so it stands out from chat
 * but blends with the user's chosen palette.
 *
 * The output is exactly the right shape to hand to `ctx.ui.custom`'s
 * overlay component — every line is exactly `width` columns wide.
 */
export function frame(
  lines: string[],
  width: number,
  theme: Theme,
  options: FrameOptions = {},
): string[] {
  const paddingX = options.paddingX ?? DEFAULT_PADDING_X;
  const paddingY = options.paddingY ?? DEFAULT_PADDING_Y;
  const inner = Math.max(1, width - 2);
  const contentWidth = frameContentWidth(width, paddingX);
  const border = (s: string) => theme.fg("borderAccent", s);

  let body = lines;
  if (options.fixedInnerRows !== undefined && body.length > options.fixedInnerRows) {
    const hidden = body.length - options.fixedInnerRows + 1;
    body = [
      ...body.slice(0, Math.max(0, options.fixedInnerRows - 1)),
      theme.fg("dim", `↓ ${hidden} more line(s)`),
    ].slice(0, options.fixedInnerRows);
  }

  const blank = `${border("│")}${" ".repeat(inner)}${border("│")}`;
  const top = (): string => {
    if (!options.title) return `${border("╭")}${border("─".repeat(inner))}${border("╮")}`;
    // Title pill: `── <title> ──`, truncated to fit; surrounded by border
    // dashes on both sides so the pill always reaches the corners.
    const titlePlain = ` ${truncateToWidth(options.title, Math.max(1, inner - 4), "…")} `;
    const titleVisible = visibleWidth(titlePlain);
    const leftDash = 2;
    const rightDash = Math.max(1, inner - leftDash - titleVisible);
    return (
      `${border("╭")}${border("─".repeat(leftDash))}` +
      `${theme.fg("accent", theme.bold(titlePlain))}` +
      `${border("─".repeat(rightDash))}${border("╮")}`
    );
  };

  const out: string[] = [top()];
  if (options.subtitle) {
    for (const line of options.subtitle.split(/\r?\n/)) {
      const text = theme.fg("dim", pad(truncateToWidth(line, contentWidth, "…"), contentWidth));
      out.push(`${border("│")}${" ".repeat(paddingX)}${text}${" ".repeat(paddingX)}${border("│")}`);
    }
  }
  for (let i = 0; i < paddingY; i += 1) out.push(blank);
  for (const line of body) {
    out.push(
      `${border("│")}${" ".repeat(paddingX)}${pad(line, contentWidth)}${" ".repeat(paddingX)}${border("│")}`,
    );
  }
  for (let i = 0; i < paddingY; i += 1) out.push(blank);
  out.push(`${border("╰")}${border("─".repeat(inner))}${border("╯")}`);
  return out.map((line) => truncateToWidth(line, width, ""));
}

/**
 * Compute a sensible inner-row count given the terminal height and a
 * preferred maximum. Mirrors the `responsiveInnerRows` math from
 * `extension-manager.ts` so popups shrink gracefully on short terminals
 * instead of clipping past the bottom edge.
 */
export function responsiveInnerRows(
  terminalRows: number,
  preferred: number,
  minimum = 12,
  ratio = 0.85,
): number {
  const available = Math.max(
    minimum + FRAME_VERTICAL_CHROME,
    Math.floor(Math.max(1, terminalRows) * ratio),
  );
  return Math.max(minimum, Math.min(preferred, available - FRAME_VERTICAL_CHROME));
}
