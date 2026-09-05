/**
 * Renderer for `type: "enum"` rows.
 *
 * Short option lists (≤ `cycleThreshold`, default 4) cycle in place via
 * Enter / Space; longer lists open a `SelectList` submenu so users
 * don't have to mash Enter to scroll through 20+ entries.
 */

import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  SelectList,
  truncateToWidth,
  type Component,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { formatHintLine } from "../frame";
import { deleteWordBackward } from "../inline-edit";
import type { EnumField, FieldRenderContext, FieldRenderer, SubmenuFactory } from "../types";

const DEFAULT_CYCLE_THRESHOLD = 4;
const MAX_VISIBLE_ROWS = 12;

function labelFor(field: EnumField, value: string): string {
  return field.optionLabels?.[value] ?? value;
}

function nextCycleValue(field: EnumField, current: string): string {
  if (field.options.length === 0) return current;
  const idx = field.options.indexOf(current as never);
  const nextIdx = (idx + 1 + field.options.length) % field.options.length;
  return field.options[nextIdx]!;
}

function prevCycleValue(field: EnumField, current: string): string {
  if (field.options.length === 0) return current;
  const idx = field.options.indexOf(current as never);
  const prevIdx = (idx - 1 + field.options.length) % field.options.length;
  return field.options[prevIdx]!;
}

/** Build a submenu factory the modal can mount with its own `done`. */
function makeEnumSubmenu(
  field: EnumField,
  current: string,
  ctx: FieldRenderContext,
): SubmenuFactory<string> {
  if (field.search) {
    return makeSearchableEnumSubmenu(field, current, ctx);
  }

  return (done) => {
    const items: SelectItem[] = field.options.map((value, idx) => {
      const isActive = value === current;
      const activeSuffix = isActive ? `  ${ctx.theme.fg("success", "✔")}` : "";
      return {
        value,
        label: `${idx + 1}. ${labelFor(field, value)}${activeSuffix}`,
      };
    });
    const list = new SelectList(
      items,
      Math.min(items.length, MAX_VISIBLE_ROWS),
      getSelectListTheme(),
    );
    const idx = field.options.indexOf(current);
    list.setSelectedIndex(idx >= 0 ? idx : 0);
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done();

    const component: Component = {
      render(width: number): string[] {
        const lines = [...list.render(width)];
        lines.push("");
        const hints = [
          { key: "↑↓", label: "select" },
          ...(items.length > 1 ? [{ key: `1-${Math.min(9, items.length)}`, label: "choose" }] : []),
          { key: "enter/space", label: "save" },
          ...(field.default !== undefined ? [{ key: "alt+r", label: "reset" }] : []),
          { key: "esc", label: "cancel" },
        ];
        const hintText = `  ${formatHintLine(hints, ctx.theme)}`;
        lines.push(truncateToWidth(hintText, width, "…", true));
        return lines;
      },
      invalidate(): void {
        list.invalidate();
      },
      handleInput(data: string): void {
        if (matchesKey(data, "alt+r") && field.default !== undefined) {
          const defaultIdx = field.options.indexOf(field.default);
          if (defaultIdx >= 0) {
            list.setSelectedIndex(defaultIdx);
            ctx.tui.requestRender();
          }
          return;
        }
        if (data === " ") {
          const item = list.getSelectedItem();
          if (item) {
            done(item.value);
            return;
          }
        }
        const num = parseInt(data, 10);
        if (data.length === 1 && !isNaN(num) && num >= 1 && num <= Math.min(9, items.length)) {
          const item = items[num - 1];
          if (item) {
            done(item.value);
            return;
          }
        }
        list.handleInput(data);
        ctx.tui.requestRender();
      },
    };
    return component;
  };
}

/**
 * Build a searchable enum submenu with a filter bar at the top.
 * Used when `field.search === true`.
 */
function makeSearchableEnumSubmenu(
  field: EnumField,
  current: string,
  ctx: FieldRenderContext,
): SubmenuFactory<string> {
  return (done) => {
    const allItems: SelectItem[] = field.options.map((value) => ({
      value,
      label: labelFor(field, value),
    }));

    let search = "";
    let selected = 0;

    function filteredItems(): SelectItem[] {
      if (!search.trim()) {
        return allItems.map((item, idx) => ({
          ...item,
          label: `${idx + 1}. ${item.label}`,
        }));
      }
      const q = search.toLowerCase();
      return allItems.filter(
        (item) => item.label.toLowerCase().includes(q) || item.value.toLowerCase().includes(q),
      );
    }

    function clampSelected(): void {
      const items = filteredItems();
      if (selected >= items.length) selected = Math.max(0, items.length - 1);
    }

    const component: Component = {
      render(width: number): string[] {
        const lines: string[] = [];
        const items = filteredItems();
        const cursor = ctx.theme.inverse(" ");
        const hasMatches = items.length > 0;

        let searchPrompt: string;
        if (!search) {
          searchPrompt = `Search: ${cursor}${ctx.theme.fg("muted", "type to filter…")}`;
        } else {
          const queryColor = hasMatches ? "accent" : "warning";
          searchPrompt = `Search: ${ctx.theme.fg(queryColor, search)}${cursor}`;
        }

        lines.push(ctx.theme.bg("toolPendingBg", truncateToWidth(searchPrompt, width, "…", true)));
        lines.push("");

        if (items.length === 0) {
          if (search) {
            const prefix = ctx.theme.fg("muted", "  No matching options for '");
            const q = ctx.theme.fg("warning", search);
            const suffix = ctx.theme.fg("muted", "'. (press esc or ctrl+u to clear)");
            lines.push(`${prefix}${q}${suffix}`);
          } else {
            lines.push(ctx.theme.fg("muted", "  No options available. (press esc to cancel)"));
          }
        } else {
          const maxVisible = MAX_VISIBLE_ROWS;
          const scroll = Math.max(
            0,
            Math.min(selected - Math.floor(maxVisible / 2), Math.max(0, items.length - maxVisible)),
          );
          const slice = items.slice(scroll, scroll + maxVisible);
          for (let i = 0; i < slice.length; i++) {
            const isSelected = scroll + i === selected;
            const prefix = isSelected ? ctx.theme.fg("accent", "▌ ") : "  ";
            const item = slice[i]!;
            const isActive = item.value === current;
            const activeSuffix = isActive ? `  ${ctx.theme.fg("success", "✔")}` : "";
            const display = isSelected
              ? ctx.theme.fg("accent", item.label)
              : ctx.theme.fg("muted", item.label);
            const line = `${prefix}${display}${activeSuffix}`;
            lines.push(
              isSelected
                ? ctx.theme.bg("selectedBg", truncateToWidth(line, width, "…", true))
                : truncateToWidth(line, width, "…", true),
            );
          }
        }

        lines.push("");
        const hints = [{ key: "↑↓", label: "select" }];

        if (!search && items.length > 1) {
          hints.push({ key: `1-${Math.min(9, items.length)}`, label: "choose" });
        }

        hints.push({ key: "enter", label: "save" });

        if (field.default !== undefined) {
          hints.push({ key: "alt+r", label: "reset" });
        }

        if (search) {
          hints.push({ key: "ctrl+w", label: "delete word" });
          hints.push({ key: "ctrl+u", label: "clear" });
          hints.push({ key: "esc", label: "clear filter" });
        } else {
          hints.push({ key: "esc", label: "cancel" });
        }

        const hintText = formatHintLine(hints, ctx.theme);
        lines.push(`  ${truncateToWidth(hintText, width, "…", true)}`);
        return lines;
      },
      invalidate(): void {
        // no external state to invalidate
      },
      handleInput(data: string): void {
        const items = filteredItems();

        if (matchesKey(data, "alt+r") && field.default !== undefined) {
          search = "";
          const newItems = filteredItems();
          const defaultIdx = newItems.findIndex((item) => item.value === field.default);
          if (defaultIdx >= 0) {
            selected = defaultIdx;
          }
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey(data, "home")) {
          selected = 0;
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey(data, "end")) {
          selected = Math.max(0, items.length - 1);
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey(data, "pageUp")) {
          selected = Math.max(0, selected - MAX_VISIBLE_ROWS);
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey(data, "pageDown")) {
          selected = Math.min(Math.max(0, items.length - 1), selected + MAX_VISIBLE_ROWS);
          ctx.tui.requestRender();
          return;
        }

        if (!search.trim()) {
          const num = parseInt(data, 10);
          if (data.length === 1 && !isNaN(num) && num >= 1 && num <= Math.min(9, items.length)) {
            const item = items[num - 1];
            if (item) {
              done(item.value);
              return;
            }
          }
        }

        if (matchesKey(data, "up")) {
          selected = Math.max(0, selected - 1);
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey(data, "down")) {
          selected = Math.min(selected + 1, Math.max(0, items.length - 1));
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey(data, "enter") || matchesKey(data, "return")) {
          if (items.length > 0) {
            done(items[Math.min(selected, items.length - 1)]!.value);
          }
          return;
        }
        if (matchesKey(data, "escape")) {
          if (search !== "") {
            const selectedValue = items[selected]?.value;
            search = "";
            const newItems = filteredItems();
            const newIndex = selectedValue
              ? newItems.findIndex((item) => item.value === selectedValue)
              : -1;
            selected = newIndex >= 0 ? newIndex : 0;
            ctx.tui.requestRender();
          } else {
            done();
          }
          return;
        }
        if (matchesKey(data, "ctrl+u")) {
          search = "";
          selected = 0;
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey(data, "ctrl+w")) {
          search = deleteWordBackward(search);
          selected = 0;
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey(data, "backspace") || matchesKey(data, "ctrl+h")) {
          search = search.slice(0, -1);
          selected = 0;
          ctx.tui.requestRender();
          return;
        }
        if (data.length === 1 && data >= " " && data !== "\x7f") {
          search += data;
          selected = 0;
          ctx.tui.requestRender();
        }
      },
    };
    return component;
  };
}

export const enumRenderer: FieldRenderer<EnumField, string> = {
  type: "enum",
  renderValue(row, { selected, ctx }) {
    const text = labelFor(row.field, row.value);
    if (row.field.disabled) {
      const desc = row.field.valueDescriptions?.[row.value];
      const suffix = desc ? ` (${desc})` : "";
      return ctx.theme.fg("muted", text + suffix);
    }
    const desc = row.field.valueDescriptions?.[row.value];
    const suffix = desc ? ` ${ctx.theme.fg("dim", `(${desc})`)}` : "";
    return ctx.theme.fg(selected ? "accent" : "muted", text) + suffix;
  },
  hints(row) {
    if (row.field.disabled) return [];
    // Searchable enums always open a list submenu
    if (row.field.search) {
      return [{ key: "enter/space", label: "open list" }];
    }
    const threshold = row.field.cycleThreshold ?? DEFAULT_CYCLE_THRESHOLD;
    if (row.field.options.length > threshold) {
      return [{ key: "enter/space", label: "open list" }];
    }
    return [
      { key: "enter/space", label: "cycle" },
      { key: "←/→", label: "prev/next" },
    ];
  },
  handleKey(row, data, { ctx }) {
    if (row.field.disabled) return {};
    // Searchable enums always open a submenu on Enter/Space
    if (row.field.search) {
      if (matchesKey(data, "enter") || matchesKey(data, "return") || data === " ") {
        return {
          consumed: true,
          submenu: makeEnumSubmenu(row.field, row.value, ctx),
        };
      }
      // No cycling for searchable enums — all navigation is in the submenu
      return {};
    }

    const threshold = row.field.cycleThreshold ?? DEFAULT_CYCLE_THRESHOLD;
    const isLongList = row.field.options.length > threshold;

    if (matchesKey(data, "enter") || matchesKey(data, "return") || data === " ") {
      if (isLongList) {
        return {
          consumed: true,
          submenu: makeEnumSubmenu(row.field, row.value, ctx),
        };
      }
      return { consumed: true, commit: nextCycleValue(row.field, row.value) };
    }

    if (!isLongList) {
      if (matchesKey(data, "left")) {
        const prev = prevCycleValue(row.field, row.value);
        if (prev === row.value) return { consumed: true };
        return { consumed: true, commit: prev };
      }
      if (matchesKey(data, "right")) {
        const next = nextCycleValue(row.field, row.value);
        if (next === row.value) return { consumed: true };
        return { consumed: true, commit: next };
      }
    }

    return {};
  },
};
