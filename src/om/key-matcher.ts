/**
 * Terminal utilities shared by blackhole overlay components.
 *
 * Re-exports visibleWidth from pi-tui.
 *
 * Previously had a local CJK-width implementation extracted from pi-tui
 * to avoid import resolution issues in the overlay TUI context.
 * If this re-export causes runtime resolution failures, restore the
 * local copy (see git history for the original implementation).
 */

export { visibleWidth } from "@earendil-works/pi-tui";
