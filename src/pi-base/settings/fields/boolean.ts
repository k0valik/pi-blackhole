/**
 * Renderer for `type: "boolean"` rows. Enter / Space toggles between
 * `on` and `off`; the value is committed immediately.
 */

import { matchesKey } from "@earendil-works/pi-tui";
import type { BooleanField, FieldRenderer } from "../types";

export const booleanRenderer: FieldRenderer<BooleanField, boolean> = {
  type: "boolean",
  renderValue(row, { selected, ctx }) {
    if (row.field.disabled) {
      const text = row.value ? "[✓] on" : "[ ] off";
      return ctx.theme.fg("muted", text);
    }
    if (row.value) {
      const indicator = ctx.theme.fg(selected ? "accent" : "success", "✓");
      const label = ctx.theme.fg(selected ? "accent" : "success", "on");
      return `[${indicator}] ${label}`;
    } else {
      const indicator = ctx.theme.fg(selected ? "accent" : "muted", " ");
      const label = ctx.theme.fg(selected ? "accent" : "muted", "off");
      return `[${indicator}] ${label}`;
    }
  },
  hints(row) {
    if (row.field.disabled) return [];
    return [
      { key: "enter/space", label: row.value ? "turn off" : "turn on" },
      { key: "←/→", label: "toggle" },
    ];
  },
  handleKey(row, data) {
    if (row.field.disabled) return {};
    if (matchesKey(data, "enter") || matchesKey(data, "return") || data === " ") {
      return { consumed: true, commit: !row.value };
    }
    if (matchesKey(data, "left")) {
      if (row.value === false) return { consumed: true };
      return { consumed: true, commit: false };
    }
    if (matchesKey(data, "right")) {
      if (row.value === true) return { consumed: true };
      return { consumed: true, commit: true };
    }
    return {};
  },
};
