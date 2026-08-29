/**
 * Cleanup handler — TUI picker for orphaned pending files.
 *
 * Called from /blackhole cleanup subcommand.
 * Scans pi-blackhole pending files, cross-references against session JSONL
 * files, and lets the user delete orphaned ones interactively.
 *
 * TUI picker (overlay) provides:
 *   ↑↓  navigate
 *   Enter  delete selected file
 *   D      delete all orphaned (with inline confirmation)
 *   Esc    cancel / close
 *
 * Non-TUI fallback (RPC / JSON / print modes): lists orphaned files as text
 * notification. Use TUI mode to actually delete.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, decodeKittyPrintable } from "@earendil-works/pi-tui";
import { visibleWidth } from "../om/key-matcher.js";
import {
  analyzeOrphaned,
  deletePendingFiles,
  deleteOrphanedBatch,
  describeFile,
  type PendingFile,
} from "../om/cleanup.js";

// ── TUI Picker Component ────────────────────────────────────────────────────

const LIST_ROWS = 10;

/** Clamp a list index to [0, length-1]. */
function clampIndex(idx: number, length: number): number {
  if (length === 0) return 0;
  return Math.max(0, Math.min(idx, length - 1));
}

/** Build the framed top border with optional title and right-aligned info. */
function buildTopBorder(
  width: number,
  border: (s: string) => string,
  dim: (s: string) => string,
  title?: string,
  right?: string,
): string {
  const innerW = Math.max(1, width - 2);
  if (!title && !right) {
    return border(`┏${"━".repeat(innerW)}┓`);
  }
  const rightText = right ? ` ${right} ` : "";
  const titleBudget = Math.max(1, innerW - visibleWidth(rightText) - 1);
  const titleFitted = title
    ? ` ${title.slice(0, Math.max(1, titleBudget - 2))}${title.length > titleBudget - 2 ? "…" : ""} `
    : "";
  const fill = Math.max(1, innerW - visibleWidth(titleFitted) - visibleWidth(rightText));
  return border(`┏${titleFitted}${"━".repeat(fill)}${right ? dim(rightText) : ""}┓`);
}

// ── Component ───────────────────────────────────────────────────────────────

/**
 * Create the orphaned-files picker component for ctx.ui.custom().
 *
 * The component mutates the `orphaned` array in-place when single items are
 * deleted (immediate feedback). The caller creates a copy if needed.
 */
function createCleanupPicker(
  orphaned: PendingFile[],
  theme: {
    fg: (s: string, t: string) => string;
    bg: (s: string, t: string) => string;
  },
  done: (result: "deleteAll" | "cancel") => void,
): {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
} {
  let selectedIndex = 0;
  let scrollOffset = 0;
  let confirmDeleteAll = false;

  function clampScroll(): void {
    const count = orphaned.length;
    selectedIndex = clampIndex(selectedIndex, count);
    const maxOffset = Math.max(0, count - LIST_ROWS);
    scrollOffset = Math.max(0, Math.min(scrollOffset, maxOffset));
    if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
    if (selectedIndex >= scrollOffset + LIST_ROWS && count > 0) {
      scrollOffset = selectedIndex - LIST_ROWS + 1;
    }
  }

  const bdr = (t: string) => theme.fg("border", t);
  const dim = (t: string) => theme.fg("dim", t);
  const accent = (t: string) => theme.fg("accent", t);
  const err = (t: string) => theme.fg("error", t);
  const now = Date.now();

  function itemLine(pf: PendingFile, isSel: boolean, cw: number): string {
    const desc = describeFile(pf, now);
    const prefix = isSel ? accent(" ▶") : "  ";
    const main = isSel ? accent(desc) : desc;
    const line = `${prefix} ${main}`;
    return ` ${line}${" ".repeat(Math.max(0, cw - visibleWidth(line)))} `;
  }

  return {
    invalidate(): void {
      // No cache — render is always fresh
    },

    render(width: number): string[] {
      const w = Math.max(40, width);
      const innerW = Math.max(1, w - 2);
      const PX = 1;
      const cw = Math.max(1, innerW - PX * 2);
      const lines: string[] = [];

      // ── Confirm-delete-all ──
      if (confirmDeleteAll) {
        const title = `Delete ${orphaned.length} orphaned file${orphaned.length === 1 ? "" : "s"}?`;
        lines.push(buildTopBorder(w, bdr, dim, "Cleanup Pending Files"));
        lines.push(bdr(`┃${" ".repeat(innerW)}┃`));
        lines.push(bdr(`┃ ${err(title)}${" ".repeat(Math.max(0, cw - visibleWidth(title)))} ┃`));
        lines.push(bdr(`┃${" ".repeat(innerW)}┃`));
        const hint = "Enter confirm · Esc cancel";
        lines.push(bdr(`┃ ${dim(hint)}${" ".repeat(Math.max(0, cw - visibleWidth(hint)))} ┃`));
        lines.push(bdr(`┗${"━".repeat(innerW)}┛`));
        return lines;
      }

      // ── List ──
      clampScroll();

      const sizeLabel = `${orphaned.length} file${orphaned.length === 1 ? "" : "s"}`;
      lines.push(buildTopBorder(w, bdr, dim, "Orphaned Pending Files", sizeLabel));
      lines.push(bdr(`┃${" ".repeat(innerW)}┃`));

      if (orphaned.length === 0) {
        lines.push(
          bdr(`┃ ${dim("No orphaned pending files found")}${" ".repeat(Math.max(0, cw - 29))} ┃`),
        );
      } else {
        const visible = orphaned.slice(scrollOffset, scrollOffset + LIST_ROWS);
        for (let vi = 0; vi < visible.length; vi++) {
          const idx = scrollOffset + vi;
          const pf = visible[vi];
          if (!pf) continue;
          const isSel = idx === selectedIndex;
          const row = itemLine(pf, isSel, cw);
          lines.push(isSel ? theme.bg("selectedBg", bdr(`┃${row}┃`)) : bdr(`┃${row}┃`));
        }
      }

      // Filler rows
      for (let i = Math.min(orphaned.length, LIST_ROWS); i < LIST_ROWS; i++) {
        lines.push(bdr(`┃${" ".repeat(innerW)}┃`));
      }

      lines.push(bdr(`┃${" ".repeat(innerW)}┃`));

      if (orphaned.length > 0) {
        const totalBytes = orphaned.reduce((s, pf) => s + pf.sizeBytes, 0);
        const kb = totalBytes > 0 ? (totalBytes / 1024).toFixed(1) : "0.0";
        const totalStr = `Total: ${kb} KB`;
        const hint = "↑↓ navigate  Enter delete  D delete all  Esc cancel";
        lines.push(
          bdr(`┃ ${dim(totalStr)}${" ".repeat(Math.max(0, cw - visibleWidth(totalStr)))} ┃`),
        );
        lines.push(bdr(`┃ ${dim(hint)}${" ".repeat(Math.max(0, cw - visibleWidth(hint)))} ┃`));
      } else {
        const hint = "Esc close";
        lines.push(bdr(`┃ ${dim(hint)}${" ".repeat(Math.max(0, cw - visibleWidth(hint)))} ┃`));
      }
      lines.push(bdr(`┗${"━".repeat(innerW)}┛`));
      return lines;
    },

    handleInput(data: string): void {
      const key = decodeKittyPrintable(data) ?? data;

      if (confirmDeleteAll) {
        if (matchesKey(data, "enter") || matchesKey(data, "return")) {
          done("deleteAll");
          return;
        }
        if (matchesKey(data, "escape")) {
          confirmDeleteAll = false;
          return;
        }
        return;
      }

      if (orphaned.length === 0) {
        if (matchesKey(data, "escape")) done("cancel");
        return;
      }

      if (matchesKey(data, "up")) {
        selectedIndex = clampIndex(selectedIndex - 1, orphaned.length);
        clampScroll();
        return;
      }
      if (matchesKey(data, "down")) {
        selectedIndex = clampIndex(selectedIndex + 1, orphaned.length);
        clampScroll();
        return;
      }
      if (matchesKey(data, "pageUp") || key === "-") {
        selectedIndex = clampIndex(selectedIndex - LIST_ROWS, orphaned.length);
        clampScroll();
        return;
      }
      if (matchesKey(data, "pageDown") || key === "=") {
        selectedIndex = clampIndex(selectedIndex + LIST_ROWS, orphaned.length);
        clampScroll();
        return;
      }
      if (matchesKey(data, "home")) {
        selectedIndex = 0;
        scrollOffset = 0;
        return;
      }
      if (matchesKey(data, "end")) {
        selectedIndex = Math.max(0, orphaned.length - 1);
        clampScroll();
        return;
      }
      if (matchesKey(data, "enter") || matchesKey(data, "return")) {
        const pf = orphaned[selectedIndex];
        if (pf) {
          deletePendingFiles(pf.sessionId);
          orphaned.splice(selectedIndex, 1);
          if (orphaned.length === 0) {
            done("cancel");
            return;
          }
          selectedIndex = clampIndex(selectedIndex, orphaned.length);
          clampScroll();
        }
        return;
      }
      if (key === "d" || key === "D") {
        confirmDeleteAll = true;
        return;
      }
      if (matchesKey(data, "escape")) {
        done("cancel");
        return;
      }
    },
  };
}

// ── Public handler ──────────────────────────────────────────────────────────

/**
 * Handle the /blackhole cleanup subcommand.
 *
 * Runs the full analysis pipeline (scan pending → scan sessions → cross-ref),
 * then opens the TUI picker if there are orphaned files.
 *
 * In non-TUI modes (RPC/JSON/print): lists orphaned files as a notification
 * without deleting anything.
 */
export async function handleCleanup(ctx: ExtensionContext): Promise<void> {
  const { orphaned } = analyzeOrphaned();

  if (orphaned.length === 0) {
    ctx.ui.notify("pi-blackhole: No orphaned pending files found.", "info");
    return;
  }

  const isRpc = ctx.mode === "rpc" || ctx.mode === "json" || ctx.mode === "print";
  if (isRpc) {
    // Non-TUI: list only
    const totalSize = orphaned.reduce((s, pf) => s + pf.sizeBytes, 0);
    const lines = [
      `Orphaned pending files: ${orphaned.length} (${(totalSize / 1024).toFixed(1)} KB)`,
      "",
      ...orphaned.map((pf) => `  ${describeFile(pf)}`),
      "",
      "Use /blackhole cleanup in TUI mode to delete these files.",
    ];
    ctx.ui.notify(lines.join("\n"), "warning");
    return;
  }

  // Work on a copy — the picker mutates the array for inline deletes.
  const items = [...orphaned];
  const result = await ctx.ui.custom<"deleteAll" | "cancel" | null>(
    (_tui, theme, _kb, done) => {
      return createCleanupPicker(items, theme as any, done);
    },
    { overlay: true },
  );

  if (result === "deleteAll") {
    const deleted = deleteOrphanedBatch(items);
    const intended = items.length;
    if (deleted === intended) {
      ctx.ui.notify(
        `pi-blackhole: Deleted ${intended} orphaned pending file${intended === 1 ? "" : "s"}.`,
        "info",
      );
    } else {
      ctx.ui.notify(
        `pi-blackhole: Deleted ${deleted}/${intended} orphaned pending file${intended === 1 ? "" : "s"} (${intended - deleted} failed).`,
        "warning",
      );
    }
  } else if (items.length > 0 && items.length < orphaned.length) {
    // Some were deleted inline, some remain
    const remainingSize = items.reduce((s, pf) => s + pf.sizeBytes, 0);
    ctx.ui.notify(
      `pi-blackhole: ${orphaned.length - items.length} deleted, ${items.length} remain (${(remainingSize / 1024).toFixed(1)} KB).`,
      "info",
    );
  } else if (items.length === 0 && orphaned.length > 0) {
    // All were deleted inline
    ctx.ui.notify(
      `pi-blackhole: All ${orphaned.length} orphaned pending file${orphaned.length === 1 ? "" : "s"} removed.`,
      "info",
    );
  }
  // If nothing was deleted (user just pressed Esc), stay silent
}
