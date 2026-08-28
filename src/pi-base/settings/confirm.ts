import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatHintLine, wrapLine, type KeyHint } from "./frame.ts";

export interface ConfirmOptions {
  /** Lines of message body (component word-wraps via wrapLine). */
  message: string[];
  confirmLabel?: string; // default "Confirm"
  cancelLabel?: string; // default "Cancel"
  danger?: boolean; // cancel pre-selected + message in warning color
}

export interface ConfirmArgs {
  tui: TUI;
  theme: Theme;
}

export function createConfirm(
  options: ConfirmOptions,
  done: (confirmed: boolean) => void,
  args: ConfirmArgs,
): Component {
  const confirmLabel = options.confirmLabel ?? "Confirm";
  const cancelLabel = options.cancelLabel ?? "Cancel";
  const isDanger = options.danger ?? false;

  // Order + pre-selection:
  //   normal → [Confirm, Cancel] with Confirm selected
  //   danger → [Cancel, Confirm] with Cancel selected
  const items = isDanger
    ? [
        { label: cancelLabel, confirmed: false },
        { label: confirmLabel, confirmed: true },
      ]
    : [
        { label: confirmLabel, confirmed: true },
        { label: cancelLabel, confirmed: false },
      ];

  let selectedIndex = 0;

  const render = (width: number): string[] => {
    const contentWidth = Math.max(1, width - 2);
    const lines: string[] = [];
    lines.push("");
    for (const raw of options.message) {
      for (const wrapped of wrapLine(raw, contentWidth)) {
        const text = isDanger ? args.theme.fg("warning", wrapped) : wrapped;
        lines.push(`  ${text}`);
      }
    }
    lines.push("");

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]!;
      const isSelected = i === selectedIndex;
      const prefix = isSelected ? args.theme.fg("accent", "▌ ") : "  ";
      const label = isSelected
        ? args.theme.fg("text", item.label)
        : args.theme.fg("muted", item.label);
      lines.push(`${prefix}${label}`);
    }

    lines.push("");
    const hints: KeyHint[] = [
      { key: "↑↓", label: "select" },
      { key: "enter", label: "confirm" },
      { key: "esc", label: "cancel" },
    ];
    lines.push(args.theme.fg("muted", `  ${formatHintLine(hints, args.theme)}`));
    return lines;
  };

  const handleInput = (data: string): void => {
    if (matchesKey(data, "up") || matchesKey(data, "left")) {
      selectedIndex = (selectedIndex - 1 + items.length) % items.length;
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "right")) {
      selectedIndex = (selectedIndex + 1) % items.length;
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      done(items[selectedIndex]!.confirmed);
      return;
    }
    if (matchesKey(data, "escape")) {
      done(false);
      return;
    }
  };

  return { render, handleInput, invalidate: () => {} };
}
