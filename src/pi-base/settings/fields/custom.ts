/**
 * Renderer for `type: "custom"` rows. The caller supplies:
 *
 *   - `render(args)` — returns the right-hand value cell as a string.
 *   - `handleInput?(data, args)` — optional inline-edit handler; return
 *     true to consume the key.
 *   - `openSubmenu?(args)` — optional submenu mounted on Enter; the
 *     factory receives a `done(value?)` callback the modal supplies.
 *
 * Anything more exotic than the built-in `model` widget belongs here.
 */

import { matchesKey } from "@earendil-works/pi-tui";
import type { CustomField, FieldRenderer, SubmenuFactory } from "../types";

export const customRenderer: FieldRenderer<CustomField, unknown> = {
  type: "custom",
  renderValue(row, args) {
    const text = row.field.render({
      value: row.value,
      width: args.width,
      selected: args.selected && !row.field.disabled,
      theme: args.ctx.theme,
    });
    if (row.field.disabled) {
      return args.ctx.theme.fg("muted", text);
    }
    return text;
  },
  hints(row) {
    if (row.field.disabled) return [];
    // Caller-supplied override wins outright — useful when
    // `handleInput` consumes a specific key (e.g. space) but Enter
    // is a no-op, in which case the default "enter edit" heuristic
    // would be misleading.
    if (row.field.hints) return row.field.hints;
    if (row.field.openSubmenu) return [{ key: "enter/space", label: "open" }];
    if (row.field.handleInput) return [{ key: "enter/space", label: "edit" }];
    return [];
  },
  handleKey(row, data, args) {
    if (row.field.disabled) return {};
    // Caller-supplied inline-edit handler runs first so it can intercept
    // arrow keys etc. before we treat Enter as "open submenu".
    if (row.field.handleInput) {
      const consumed = row.field.handleInput(data, {
        value: row.value,
        width: 0,
        selected: true,
        theme: args.ctx.theme,
      });
      if (consumed) return { consumed: true };
    }
    if (
      matchesKey(data, "enter") ||
      matchesKey(data, "return") ||
      data === " "
    ) {
      if (row.field.openSubmenu) {
        const factory: SubmenuFactory<unknown> = (done) =>
          row.field.openSubmenu!({
            value: row.value,
            theme: args.ctx.theme,
            tui: args.ctx.tui,
            done,
          });
        return { consumed: true, submenu: factory };
      }
    }
    return {};
  },
};
