/**
 * Renderer for `type: "action"` rows. Non-storing — Enter triggers the
 * caller-supplied `onActivate(ctx)` and never changes a value.
 */

import { matchesKey } from "@earendil-works/pi-tui";
import type { ActionField, FieldRenderer } from "../types";

export const actionRenderer: FieldRenderer<ActionField, void> = {
  type: "action",
  renderValue(row, { selected, ctx }) {
    const text = row.field.display ?? "(run)";
    if (row.field.disabled) {
      return ctx.theme.fg("muted", `${text} (unavailable)`);
    }
    return ctx.theme.fg(selected ? "accent" : "muted", text);
  },
  hints(row) {
    if (row.field.disabled) return [];
    return [{ key: "enter/space", label: "run" }];
  },
  handleKey(row, data, { ctx }) {
    if (row.field.disabled) return {};
    if (matchesKey(data, "enter") || matchesKey(data, "return") || data === " ") {
      // Fire and forget — actions are deliberately fire-and-go so the
      // modal stays responsive even when `onActivate` is async.
      try {
        const ret = row.field.onActivate(ctx.ctx);
        if (ret && typeof (ret as Promise<void>).then === "function") {
          (ret as Promise<void>).catch(() => {});
        }
      } catch {
        // Swallow — actions must never break the modal loop.
      }
      return { consumed: true };
    }
    return {};
  },
};
