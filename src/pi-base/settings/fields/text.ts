/**
 * Renderer for `type: "text"` rows — multiline string values.
 *
 * Editing opens a submenu with a full multiline `Editor`.
 * - Ctrl+S saves and closes.
 * - Escape cancels and closes.
 * - All other input (Enter, Shift+Enter, arrows, typing) is handled by
 *   the Editor directly.
 */

import { Editor, type Component } from "@earendil-works/pi-tui";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import type { EditorTheme } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type {
  FieldRenderer,
  SubmenuFactory,
  TextField,
  FieldRenderContext,
  FieldKeyHint,
} from "../types";
import { formatHintLine } from "../frame";

export const textRenderer: FieldRenderer<TextField, string> = {
  type: "text",
  renderValue(row, { selected, ctx }) {
    const display = formatTextPreview(row.value);
    if (row.field.disabled) {
      return ctx.theme.fg("muted", display);
    }
    return ctx.theme.fg(selected ? "accent" : "muted", display);
  },
  hints(row): FieldKeyHint[] {
    if (row.field.disabled) return [];
    return [{ key: "enter", label: "open editor" }];
  },
  handleKey(row, data, { ctx }) {
    if (row.field.disabled) return {};
    if (data === "\r" || data === "\n") {
      return {
        consumed: true,
        submenu: makeTextSubmenu(row.value, ctx),
      };
    }
    return {};
  },
};

function formatTextPreview(value: string): string {
  const lineCount = value.split("\n").length;
  const preview = value.replace(/\s+/g, " ").trim();
  const quoted = preview ? JSON.stringify(preview) : '""';
  const suffix = lineCount > 1 ? ` (${lineCount} lines)` : "";
  return `${truncateToWidth(quoted, 48, "...")}${suffix}`;
}

function makeTextSubmenu(current: string, ctx: FieldRenderContext): SubmenuFactory<string> {
  return (done) => {
    const editor = new Editor(
      ctx.tui,
      {
        borderColor: (s: string) => ctx.theme.fg("muted", s),
        selectList: getSelectListTheme(),
      } as EditorTheme,
      {
        paddingX: 0,
      },
    );
    editor.setText(current);
    editor.focused = true;
    editor.disableSubmit = true;
    editor.onChange = () => ctx.tui.requestRender();

    const component: Component = {
      render(_width: number): string[] {
        const lines = editor.render(80);
        lines.push("");
        lines.push(
          ctx.theme.fg(
            "dim",
            formatHintLine(
              [
                { key: "ctrl+s", label: "save" },
                { key: "esc", label: "cancel" },
              ],
              ctx.theme,
            ),
          ),
        );
        return lines;
      },
      invalidate(): void {
        editor.invalidate();
      },
      handleInput(data: string): void {
        if (data === "\x13") {
          // Ctrl+S
          done(editor.getExpandedText());
          return;
        }
        if (data === "\x1b") {
          // Escape
          done();
          return;
        }
        editor.handleInput(data);
        ctx.tui.requestRender();
      },
    };
    return component;
  };
}
