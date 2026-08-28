/**
 * Renderer for `type: "boolean"` rows. Enter / Space toggles between
 * `on` and `off`; the value is committed immediately.
 */

import { matchesKey } from "@earendil-works/pi-tui";
import type { BooleanField, FieldRenderer } from "../types";

export const booleanRenderer: FieldRenderer<BooleanField, boolean> = {
  type: "boolean",
  renderValue(row, { selected, ctx }) {
    const text = row.value ? "on" : "off";
    if (row.field.disabled) {
      return ctx.theme.fg("muted", text);
    }
    return ctx.theme.fg(selected ? "accent" : row.value ? "success" : "muted", text);
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
