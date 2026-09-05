/**
 * Renderer for `type: "text"` rows — multiline string values.
 *
 * Editing opens a submenu with a full multiline `Editor`.
 * - Ctrl+S saves and closes.
 * - Escape cancels and closes.
 * - All other input (Enter, Shift+Enter, arrows, typing) is handled by
 *   the Editor directly.
 */

import { Editor, type Component, matchesKey } from "@earendil-works/pi-tui";
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
      render(width: number): string[] {
        const lines = editor.render(width);
        lines.push("");
        const hints = [
          { key: "ctrl+s", label: "save" },
          { key: "esc", label: "cancel" },
          { key: "ctrl+w", label: "delete word" },
          { key: "ctrl+u", label: "clear" },
          { key: "alt+r", label: "reset" },
        ];
        const hintLine = ctx.theme.fg("dim", formatHintLine(hints, ctx.theme));
        lines.push(truncateToWidth(hintLine, width, "…", true));
        return lines;
      },
      invalidate(): void {
        editor.invalidate();
      },
      handleInput(data: string): void {
        if (matchesKey(data, "ctrl+s")) {
          done(editor.getExpandedText());
          return;
        }
        if (matchesKey(data, "escape")) {
          done();
          return;
        }
        if (matchesKey(data, "ctrl+u")) {
          editor.setText("");
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey(data, "alt+r")) {
          editor.setText(current);
          ctx.tui.requestRender();
          return;
        }

        let inputData = data;
        if (
          matchesKey(data, "backspace") ||
          matchesKey(data, "ctrl+h") ||
          data === "\x7f" ||
          data === "\x08"
        ) {
          inputData = "\x7f";
        }
        editor.handleInput(inputData);
        ctx.tui.requestRender();
      },
    };
    return component;
  };
}
