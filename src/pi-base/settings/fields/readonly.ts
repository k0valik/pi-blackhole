/**
 * Renderer for non-interactive display rows: `readonly` and `section`.
 *
 *   - `readonly` renders a label + value cell (right-aligned like the other
 *     editable fields) with no edit affordance. Enter does nothing, no
 *     hints, no inline editing. Used for telemetry/stats views and
 *     informational rows inside the modal.
 *   - `section` renders a full-width dim heading, used to group consecutive
 *     read-only telemetry rows under a title.
 *
 * Both types are pure display: `handleKey` always returns `{}` so the
 * modal's default navigation (↑/↓ move, Esc close) is never suppressed.
 */

import type { FieldRenderer, ReadonlyField } from "../types";

export const readonlyRenderer: FieldRenderer<ReadonlyField, string> = {
  type: "readonly",
  renderValue(row, args) {
    const value = row.value;
    if (row.field.emphasis) {
      return args.ctx.theme.fg("accent", value);
    }
    return args.selected ? args.ctx.theme.fg("text", value) : args.ctx.theme.fg("muted", value);
  },
  hints(row) {
    if (row.field.hint) {
      return [{ key: "info", label: row.field.hint }];
    }
    return [];
  },
  handleKey() {
    // Read-only: never consume, never commit. Navigation and Esc still work.
    return {};
  },
};
