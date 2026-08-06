import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  divider,
  formatHintLine,
  frame,
  frameContentWidth,
  type KeyHint,
} from "./frame.ts";

export interface ScopeSelectorEntry {
  id: string;
  label: string;
  available: boolean;
  note?: string;
}

export type ScopeSelectorResult =
  { kind: "select"; id: string } | { kind: "cancel" };

export interface ScopeSelectorArgs {
  title: string;
  subtitle?: string;
  entries: ScopeSelectorEntry[];
  tui: TUI;
  theme: Theme;
  done: (r: ScopeSelectorResult) => void;
  frame?: boolean;
}

/** Horizontal chrome consumed by the unframed selector layout (left + right gutters). */
const UNFRAMED_CHROME_COLUMNS = 2;

export function createScopeSelector(args: ScopeSelectorArgs): Component {
  const availableEntries = args.entries.filter((e) => e.available);
  // selectedIndex tracks position within the *available* subset.
  let selectedAvailableIndex = 0;

  const render = (width: number): string[] => {
    if (args.frame !== false) {
      const innerWidth = frameContentWidth(width);
      const bodyLines: string[] = [];

      bodyLines.push(divider(innerWidth, args.theme));

      for (let i = 0; i < args.entries.length; i += 1) {
        const entry = args.entries[i]!;
        const availableIndex = availableEntries.indexOf(entry);
        const isSelected =
          entry.available && availableIndex === selectedAvailableIndex;

        if (i > 0) bodyLines.push("");

        const prefix = isSelected ? args.theme.fg("accent", "▌ ") : "  ";
        let label = entry.label;
        if (!entry.available) {
          label = args.theme.fg("dim", label);
        } else if (isSelected) {
          label = args.theme.fg("text", label);
        } else {
          label = args.theme.fg("muted", label);
        }

        const note = entry.note ? ` ${args.theme.fg("dim", entry.note)}` : "";
        bodyLines.push(`${prefix}${label}${note}`);
      }

      bodyLines.push("");

      const hints: KeyHint[] = [
        { key: "↑↓", label: "select" },
        { key: "enter", label: "confirm" },
        { key: "esc", label: "cancel" },
      ];
      bodyLines.push(
        args.theme.fg("muted", `  ${formatHintLine(hints, args.theme)}`),
      );

      return frame(bodyLines, width, args.theme, {
        title: args.title,
        subtitle: args.subtitle,
      });
    }

    const contentWidth = Math.max(1, width - UNFRAMED_CHROME_COLUMNS);
    const lines: string[] = [];
    lines.push("");
    if (args.subtitle) {
      for (const raw of args.subtitle.split(/\r?\n/)) {
        const text = args.theme.fg("dim", raw);
        lines.push(`  ${text}`);
      }
    }
    lines.push("");
    lines.push(divider(contentWidth, args.theme));

    for (let i = 0; i < args.entries.length; i += 1) {
      const entry = args.entries[i]!;
      const availableIndex = availableEntries.indexOf(entry);
      const isSelected =
        entry.available && availableIndex === selectedAvailableIndex;

      if (i > 0) lines.push("");

      const prefix = isSelected ? args.theme.fg("accent", "▌ ") : "  ";
      let label = entry.label;
      if (!entry.available) {
        label = args.theme.fg("dim", label);
      } else if (isSelected) {
        label = args.theme.fg("text", label);
      } else {
        label = args.theme.fg("muted", label);
      }

      const note = entry.note ? ` ${args.theme.fg("dim", entry.note)}` : "";
      lines.push(`${prefix}${label}${note}`);
    }

    lines.push("");
    const hints: KeyHint[] = [
      { key: "↑↓", label: "select" },
      { key: "enter", label: "confirm" },
      { key: "esc", label: "cancel" },
    ];
    lines.push(
      args.theme.fg("muted", `  ${formatHintLine(hints, args.theme)}`),
    );
    return lines;
  };

  const handleInput = (data: string): void => {
    if (availableEntries.length === 0) {
      // Only Esc works when nothing is available.
      if (matchesKey(data, "escape")) {
        args.done({ kind: "cancel" });
      }
      return;
    }

    if (matchesKey(data, "up")) {
      selectedAvailableIndex =
        (selectedAvailableIndex - 1 + availableEntries.length) %
        availableEntries.length;
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      selectedAvailableIndex =
        (selectedAvailableIndex + 1) % availableEntries.length;
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      const selected = availableEntries[selectedAvailableIndex]!;
      args.done({ kind: "select", id: selected.id });
      return;
    }
    if (matchesKey(data, "escape")) {
      args.done({ kind: "cancel" });
      return;
    }
  };

  return { render, handleInput, invalidate: () => {} };
}
