/**
 * Renderer for `type: "model"` — the two-axis "model + reasoning
 * effort" widget that voice and web both reinvented before this
 * package existed.
 *
 * UX:
 *   - Row collapsed: `<model>  ·  <effort>` (or just `<model>` when
 *     `hideEffort` is set).
 *   - Enter opens a submenu with:
 *       · a typeable filter row at the top — printable keystrokes
 *         narrow the model list by name (case-insensitive substring);
 *       · `↑/↓` over a `SelectList` of models;
 *       · `←/→` over the supported effort ladder for the highlighted
 *         model (skipped entirely when `hideEffort` is set).
 *     Enter saves both axes atomically; Esc abandons.
 *   - Discovery: by default, models come from
 *     `pi.modelRegistry.getAvailable()` (filtered to entries the user
 *     has authed, matching voice's old behaviour). The caller can
 *     narrow with `filter` or replace the list entirely with `models`.
 *
 * The submenu's footer reuses `formatHintLine` so the hot-keys are
 * highlighted with the same accent colour as the main modal's footer
 * — no second-class colour scheme inside submenus.
 */

import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { matchesKey, SelectList, truncateToWidth, type SelectItem } from "@earendil-works/pi-tui";
import { formatHintLine, type KeyHint } from "../frame";
import { handleInlineEditInput, type InlineEditState } from "../inline-edit";
import type {
  FieldRenderContext,
  FieldRenderer,
  ModelField,
  ModelOption,
  ModelValue,
  SubmenuFactory,
} from "../types";

const ALL_THINKING_LEVELS: ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Short display labels for pi's internal thinking levels — used as a
 *  fallback when the model's `thinkingLevelMap` doesn't override one.
 *  Mirrors `THINK_LABELS` in `packages/statusline/index.ts` so the
 *  picker and statusline never disagree on what `medium` looks like. */
const LEVEL_FALLBACK_LABELS: Record<ModelThinkingLevel, string> = {
  off: "off",
  minimal: "min",
  low: "low",
  medium: "med",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

const DEFAULT_SESSION_LABEL = "(session model)";
const MAX_VISIBLE_MODELS = 12;

/**
 * Resolve the human-readable label for a thinking level.
 *
 * Models may override per-level display strings via
 * `thinkingLevelMap` (e.g. Anthropic models map `xhigh` to a token
 * budget like `"60000"`); we honour those overrides exactly the
 * same way `packages/statusline/index.ts` does. Missing keys and
 * non-string values fall back to the short label. Pure presentation
 * — callers still pass / store the canonical level name (`"xhigh"`).
 */
function effortDisplayLabel(
  level: ModelThinkingLevel,
  thinkingLevelMap: ThinkingLevelMap | undefined,
): string {
  const mapped = thinkingLevelMap?.[level];
  if (typeof mapped === "string" && mapped.length > 0) return mapped;
  return LEVEL_FALLBACK_LABELS[level] ?? level;
}

function listModelOptions(field: ModelField, ctx: FieldRenderContext): ModelOption[] {
  if (field.models) return field.models;
  const sessionLabel = field.sessionLabel ?? DEFAULT_SESSION_LABEL;
  const available = ctx.ctx.modelRegistry.getAvailable();
  const filtered = field.filter ? available.filter(field.filter) : available;
  const live: ModelOption[] = filtered.map((m) => ({
    value: `${m.provider}/${m.id}`,
    label: `${m.name}  [${m.provider}]`,
    model: m,
  }));
  return field.hideSession ? live : [{ value: "", label: sessionLabel }, ...live];
}

/**
 * Find the live `Model<Api>` for a stored value.
 *
 * Looks at the caller-provided `field.models` first (so `web` and
 * other extensions that pre-build their option list still get rich
 * label resolution), then falls back to the host model registry.
 * Returns undefined for the `(session model)` sentinel and for any
 * value that no longer matches a registered model.
 */
function resolveModelForValue(
  field: ModelField,
  value: ModelValue,
  ctx: FieldRenderContext,
): Model<Api> | undefined {
  if (!value.id) return undefined;
  if (field.models) {
    const opt = field.models.find((o) => o.value === value.id);
    if (opt?.model) return opt.model;
    // Pre-built option without a backing `Model<Api>` — we can't
    // resolve thinkingLevelMap from here. Fall through to the registry.
  }
  const slash = value.id.indexOf("/");
  if (slash <= 0) return undefined;
  const provider = value.id.slice(0, slash);
  const id = value.id.slice(slash + 1);
  return ctx.ctx.modelRegistry.find(provider, id);
}

function supportedEfforts(model: Model<Api> | undefined): ModelThinkingLevel[] {
  if (!model || !model.thinkingLevelMap) return ALL_THINKING_LEVELS;
  const map = model.thinkingLevelMap;
  return ALL_THINKING_LEVELS.filter((lvl) => !(lvl in map && map[lvl] === null));
}

function clampEffort(
  desired: ModelThinkingLevel | undefined,
  supported: ModelThinkingLevel[],
): ModelThinkingLevel {
  if (desired && supported.includes(desired)) return desired;
  return supported.includes("medium") ? "medium" : (supported[0] ?? "off");
}

function modelDisplay(field: ModelField, value: ModelValue): string {
  if (value.id === "") return field.sessionLabel ?? DEFAULT_SESSION_LABEL;
  return value.id;
}

function rowLabel(field: ModelField, value: ModelValue, ctx: FieldRenderContext): string {
  const left = modelDisplay(field, value);
  if (field.hideEffort) return left;
  if (!value.thinking) return left;
  // Honour the model's `thinkingLevelMap` overrides so the row
  // displays the same label statusline shows (e.g. token-budget
  // numbers for Anthropic) instead of pi's internal level name.
  const model = resolveModelForValue(field, value, ctx);
  const label = effortDisplayLabel(value.thinking, model?.thinkingLevelMap);
  return `${left}  ·  ${label}`;
}

/**
 * Build the submenu component. The submenu owns three pieces of state:
 *
 *   1. `filter`     — the typeable name-filter buffer.
 *   2. `effortIndex` / `supported` — current effort axis (only when
 *      `hideEffort` is unset).
 *   3. The currently-mounted SelectList. We rebuild it whenever the
 *      filter changes so SelectList's internal selectedIndex stays
 *      coherent with the visible items.
 */
function makeSubmenu(
  field: ModelField,
  current: ModelValue,
  ctx: FieldRenderContext,
): SubmenuFactory<ModelValue> {
  return (done) => {
    const allOptions = listModelOptions(field, ctx);
    const showEffort = !field.hideEffort;

    const filter: InlineEditState = { buffer: "", cursor: 0 };

    let list!: SelectList;
    let visibleOptions: ModelOption[] = [];

    let effortIndex = 0;
    let supported: ModelThinkingLevel[] = [];

    const refreshEffort = (preferred: ModelThinkingLevel | undefined): void => {
      if (!showEffort) return;
      const item = list.getSelectedItem();
      const opt = visibleOptions.find((m) => m.value === item?.value);
      supported = supportedEfforts(opt?.model);
      if (supported.length === 0) supported = ["off"];
      const clamped = clampEffort(preferred, supported);
      effortIndex = Math.max(0, supported.indexOf(clamped));
    };

    /** Build / rebuild the SelectList from the current filter. Tries
     *  to keep the highlight on `preserveValue` when possible so
     *  cursor focus doesn't jump around on every keystroke. */
    const buildList = (preserveValue: string | undefined): void => {
      const query = filter.buffer.trim().toLowerCase();
      visibleOptions = query
        ? allOptions.filter(
            (o) => o.label.toLowerCase().includes(query) || o.value.toLowerCase().includes(query),
          )
        : allOptions;

      const items: SelectItem[] = visibleOptions.map((m) => ({
        value: m.value,
        label: m.label,
        description: m.value || undefined,
      }));
      list = new SelectList(
        items,
        Math.min(Math.max(items.length, 1), MAX_VISIBLE_MODELS),
        getSelectListTheme(),
      );
      const idx =
        preserveValue !== undefined ? items.findIndex((i) => i.value === preserveValue) : -1;
      list.setSelectedIndex(idx >= 0 ? idx : 0);

      list.onSelect = (item) => {
        if (showEffort) {
          const effort = supported[effortIndex] ?? "off";
          done({ id: item.value, thinking: effort });
        } else {
          done({ id: item.value });
        }
      };
      list.onCancel = () => done();
      list.onSelectionChange = () => {
        if (showEffort) {
          const previous = supported[effortIndex];
          refreshEffort(previous);
        }
        ctx.tui.requestRender();
      };
    };

    buildList(current.id);
    refreshEffort(current.thinking);

    const renderEffortRow = (width: number): string => {
      const currentLevel = supported[effortIndex] ?? "off";
      // Resolve the override label from the highlighted model's
      // thinkingLevelMap so the user sees what statusline shows
      // (token budget for Anthropic, etc.) rather than pi's
      // internal level name.
      const item = list.getSelectedItem();
      const opt = visibleOptions.find((m) => m.value === item?.value);
      const displayLabel = effortDisplayLabel(currentLevel, opt?.model?.thinkingLevelMap);
      const left = effortIndex > 0 ? ctx.theme.fg("accent", "‹") : ctx.theme.fg("dim", "‹");
      const right =
        effortIndex < supported.length - 1 ? ctx.theme.fg("accent", "›") : ctx.theme.fg("dim", "›");
      const label = ctx.theme.fg("muted", "  effort: ");
      // Show the canonical level name in dim parentheses next to the
      // override so power-users still know which pi level they're
      // selecting (e.g. `60000 (xhigh)`).
      const valueText =
        displayLabel === currentLevel
          ? displayLabel
          : `${displayLabel} ${ctx.theme.fg("dim", `(${currentLevel})`)}`;
      const value = ctx.theme.fg("accent", ctx.theme.bold(valueText));
      const counter = ctx.theme.fg("dim", `  (${effortIndex + 1}/${supported.length})`);
      return truncateToWidth(`${label}${left} ${value} ${right}${counter}`, width, "…", true);
    };

    const renderFilterRow = (width: number): string => {
      const cursorBlock = ctx.theme.inverse(" ");
      const buf = filter.buffer;
      const before = buf.slice(0, filter.cursor);
      const after = buf.slice(filter.cursor);
      const placeholder = !buf ? ctx.theme.fg("dim", "  type to filter…") : "";
      const hasMatches = visibleOptions.length > 0;
      const colorKey = hasMatches ? "accent" : "warning";
      const text = buf
        ? `  ${ctx.theme.fg("muted", "filter:")} ${ctx.theme.fg(colorKey, before)}${cursorBlock}${ctx.theme.fg(colorKey, after)}`
        : `  ${ctx.theme.fg("muted", "filter:")} ${cursorBlock}${placeholder}`;
      return truncateToWidth(text, width, "…", true);
    };

    const renderHints = (width: number): string => {
      const hints: KeyHint[] = [{ key: "↑↓", label: "model" }];
      if (showEffort) hints.push({ key: "←→", label: "effort" });
      hints.push({ key: "type", label: "filter" }, { key: "enter", label: "save" });
      if (filter.buffer !== "") {
        hints.push({ key: "esc", label: "clear filter" });
      } else {
        hints.push({ key: "esc", label: "cancel" });
      }
      return truncateToWidth(`  ${formatHintLine(hints, ctx.theme)}`, width, "…", true);
    };

    return {
      render(width: number): string[] {
        const lines: string[] = [];
        lines.push(renderFilterRow(width));
        lines.push("");
        if (visibleOptions.length === 0) {
          lines.push(ctx.theme.fg("muted", "  No matching models. (press esc to clear)"));
        } else {
          for (const line of list.render(width)) lines.push(line);
        }
        lines.push("");
        if (showEffort) {
          lines.push(renderEffortRow(width));
          lines.push("");
        }
        lines.push(renderHints(width));
        return lines;
      },
      invalidate(): void {
        list.invalidate();
      },
      handleInput(data: string): void {
        // Effort axis (only when not hidden) — must run before the
        // filter handler so ←/→ aren't typed into the search buffer.
        if (showEffort) {
          if (matchesKey(data, "left")) {
            if (effortIndex > 0) {
              effortIndex -= 1;
              ctx.tui.requestRender();
            }
            return;
          }
          if (matchesKey(data, "right")) {
            if (effortIndex < supported.length - 1) {
              effortIndex += 1;
              ctx.tui.requestRender();
            }
            return;
          }
        }
        // Intercept escape key to clear filter first
        if (matchesKey(data, "escape") && filter.buffer !== "") {
          const previousValue = list.getSelectedItem()?.value;
          filter.buffer = "";
          filter.cursor = 0;
          buildList(previousValue);
          refreshEffort(supported[effortIndex]);
          ctx.tui.requestRender();
          return;
        }
        // Up / Down / Enter / Esc go to the SelectList first so the
        // user can still drive the list while typing.
        if (
          matchesKey(data, "up") ||
          matchesKey(data, "down") ||
          matchesKey(data, "enter") ||
          matchesKey(data, "return") ||
          matchesKey(data, "escape") ||
          matchesKey(data, "ctrl+c")
        ) {
          list.handleInput(data);
          ctx.tui.requestRender();
          return;
        }
        // Everything else (printable chars, backspace, ctrl+u, …) is
        // routed to the inline-edit state machine.
        const previousValue = list.getSelectedItem()?.value;
        const consumed = handleInlineEditInput(filter, data);
        if (consumed) {
          buildList(previousValue);
          refreshEffort(supported[effortIndex]);
          ctx.tui.requestRender();
        }
      },
    };
  };
}

export const modelRenderer: FieldRenderer<ModelField, ModelValue> = {
  type: "model",
  renderValue(row, { selected, ctx }) {
    const text = rowLabel(row.field, row.value, ctx);
    if (row.field.disabled) {
      return ctx.theme.fg("muted", text);
    }
    return ctx.theme.fg(selected ? "accent" : "muted", text);
  },
  hints(row) {
    if (row.field.disabled) return [];
    // The main-window hint advertises only what the row itself does
    // there: opening the submenu. `↑↓` and `←→` only fire **inside**
    // the submenu — emitting them at row level would mislead the
    // user about what the keys do. The submenu has its own footer.
    return [{ key: "enter/space", label: "open" }];
  },
  handleKey(row, data, { ctx }) {
    if (row.field.disabled) return {};
    if (matchesKey(data, "enter") || matchesKey(data, "return") || data === " ") {
      return {
        consumed: true,
        submenu: makeSubmenu(row.field, row.value, ctx),
      };
    }
    return {};
  },
};
