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
import type { EnumField, FieldRenderContext, FieldRenderer, SubmenuFactory } from "../types";

const DEFAULT_CYCLE_THRESHOLD = 4;
const MAX_VISIBLE_ROWS = 12;

function labelFor(field: EnumField, value: string): string {
  return field.optionLabels?.[value] ?? value;
}

function nextCycleValue(field: EnumField, _current: string): string {
  if (field.options.length === 0) return _current;
  const idx = field.options.indexOf(_current as never);
  const nextIdx = (idx + 1 + field.options.length) % field.options.length;
  return field.options[nextIdx]!;
}

function prevCycleValue(field: EnumField, _current: string): string {
  if (field.options.length === 0) return _current;
  const idx = field.options.indexOf(_current as never);
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
    const items: SelectItem[] = field.options.map((value, idx) => ({
      value,
      label: `${idx + 1}. ${labelFor(field, value)}`,
    }));
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
  _current: string,
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
      if (!search.trim()) return allItems;
      const q = search.toLowerCase();
      return allItems.filter(
        (item) => item.label.toLowerCase().includes(q) || item.value.toLowerCase().includes(q),
      );
    }

    const component: Component = {
      render(width: number): string[] {
        const lines: string[] = [];
        const items = filteredItems();
        const searchPrompt = `Search: ${search}${ctx.theme.inverse(" ")}`;
        lines.push(ctx.theme.bg("toolPendingBg", truncateToWidth(searchPrompt, width, "…", true)));
        lines.push("");

        if (items.length === 0) {
          lines.push(ctx.theme.fg("muted", "  No matching options."));
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
            const display = isSelected
              ? ctx.theme.fg("accent", slice[i]!.label)
              : ctx.theme.fg("muted", slice[i]!.label);
            const line = `${prefix}${display}`;
            lines.push(
              isSelected
                ? ctx.theme.bg("selectedBg", truncateToWidth(line, width, "…", true))
                : truncateToWidth(line, width, "…", true),
            );
          }
        }

        lines.push("");
        const hints = [
          { key: "↑↓", label: "select" },
          { key: "enter", label: "save" },
          { key: "esc", label: "cancel" },
        ];
        if (search) hints.unshift({ key: "type", label: "to filter" });
        lines.push(`  ${formatHintLine(hints, ctx.theme)}`);
        return lines;
      },
      invalidate(): void {
        // no external state to invalidate
      },
      handleInput(data: string): void {
        if (matchesKey(data, "up")) {
          selected = Math.max(0, selected - 1);
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey(data, "down")) {
          const items = filteredItems();
          selected = Math.min(selected + 1, Math.max(0, items.length - 1));
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey(data, "enter") || matchesKey(data, "return")) {
          const items = filteredItems();
          if (items.length > 0) {
            done(items[Math.min(selected, items.length - 1)]!.value);
          }
          return;
        }
        if (matchesKey(data, "escape")) {
          done();
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
      return ctx.theme.fg("muted", text);
    }
    return ctx.theme.fg(selected ? "accent" : "muted", text);
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
