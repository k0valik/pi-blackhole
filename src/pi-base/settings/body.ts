/**
 * `SettingsModalBody` — the renderable+inputtable component that
 * `createSettingsModal` and `openSettingsModal` mount inside an
 * overlay. Owns:
 *
 *   - Tab strip across the top (when `tabs` is non-empty).
 *   - Optional fuzzy search bar (when `enableSearch` is true).
 *   - The list of rows, with one focused at a time.
 *   - Per-row inline-edit state (string/number/secret/path).
 *   - Overlay mounting (confirm, submenu).
 *   - Auto-generated footer hint reflecting the focused row's keybindings.
 *
 * The modal is **stateless about disk** — it calls `onChange` on every
 * commit and lets the caller persist however they like. In buffered
 * mode (`options.mode === "buffered"`), the modal holds edits in
 * memory and persists only on explicit save via `options.onSave`.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
  fuzzyMatch,
} from "@earendil-works/pi-tui";
import { validateFieldValue } from "./validate-field.ts";
import type {
  Field,
  FieldKeyHint,
  FieldRenderContext,
  SettingsModalOptions,
  SettingsModalBodyComponent,
  Tab,
  VisibilityContext,
} from "./types";
import { RENDERERS } from "./fields/index";
import {
  divider,
  formatHintLine,
  frame,
  frameContentWidth,
  pad,
  responsiveInnerRows,
  wrapLine,
  type FrameOptions,
  DEFAULT_PADDING_X,
} from "./frame";
import { deleteWordBackward, type InlineEditState } from "./inline-edit";
import { notifyError, extractInitialValue } from "./helpers.ts";
import {
  totalVisibleItems,
  updateVisibleIndices,
  visibleRowIndices,
  clampSelection,
  focusedIndex,
  focusedRow,
} from "./navigation.ts";
import { buildVisibilityContext, isDirty, commitValue, allValues } from "./values.ts";
import {
  renderTabBar,
  renderSearchBar,
  renderFooter,
  renderRow,
  renderBody,
  renderFieldDesc,
  estimateDescriptionRows,
} from "./render.ts";
import { createConfirm } from "./confirm.ts";

const PREFERRED_INNER_ROWS = 45;

export interface InternalRow {
  field: Field;
  /** Live displayed value, written back through `onChange`. */
  value: unknown;
  /** Inline-edit toggle for editable types. */
  isEditing: boolean;
  /** Pre-computed lowercased search index string for fuzzy filtering. */
  searchIndex: string;
}

export interface BodyState {
  options: SettingsModalOptions<Field>;
  args: {
    tui: TUI;
    theme: Theme;
    ctx: ExtensionContext;
    close: () => void;
  };
  tabs: Tab[];
  fields: Field[];
  rows: InternalRow[];
  editStates: Map<string, InlineEditState>;
  isBuffered: boolean;
  initialValues: Map<string, unknown>;
  dirtyKeys: Set<string>;
  cachedVisibleIndices: number[];
  activeTabId: string | undefined;
  search: string;
  fieldSelected: number;
  scroll: number;
  tabActionFocus: number;
  pathNote: string;
  pathNoteRef: { current: string };
  overlay: { component: Component; title?: string } | undefined;
  confirm: Component | undefined;
}

/**
 * Build the body component. The factory is independent of overlay
 * lifecycle — `createSettingsModal` (in modal.ts) wraps it for the
 * `ctx.ui.custom` shape; advanced callers can mount the body directly.
 */
export function createSettingsModalBody<F extends Field>(
  options: SettingsModalOptions<F>,
  args: {
    tui: TUI;
    theme: Theme;
    ctx: ExtensionContext;
    /** Called when the user closes (Esc / ctrl+c / outer dismissal). */
    close: () => void;
  },
): SettingsModalBodyComponent {
  const tabs: Tab[] = options.tabs ?? [];
  const fields: Field[] = options.fields as Field[];
  const mode = options.mode ?? "immediate";
  const isBuffered = mode === "buffered";
  const readOnly = options.readOnly ?? false;

  let activeTabId: string | undefined = options.initialTab ?? tabs[0]?.id;

  const rows: InternalRow[] = fields.map((field) => ({
    field,
    value: extractInitialValue(field),
    isEditing: false,
    searchIndex: `${field.label}\n${field.description ?? ""}\n${field.key}`.toLowerCase(),
  }));

  const editStates: Map<string, InlineEditState> = new Map();

  const initialValues = new Map<string, unknown>();
  const dirtyKeys = new Set<string>();

  if (isBuffered) {
    for (const row of rows) {
      const val = row.value;
      initialValues.set(
        row.field.key,
        typeof val === "object" && val !== null ? structuredClone(val) : val,
      );
    }
  }

  let overlay: { component: Component; title?: string } | undefined;
  let confirm: Component | undefined;

  const fieldRenderContext: FieldRenderContext & {
    editStates: Map<string, InlineEditState>;
  } = {
    theme: args.theme,
    tui: args.tui,
    ctx: args.ctx,
    requestRender: () => args.tui.requestRender(),
    editStates,
  };

  const state: BodyState = {
    options: options as unknown as SettingsModalOptions<Field>,
    args,
    tabs,
    fields,
    rows,
    editStates,
    isBuffered,
    initialValues,
    dirtyKeys,
    cachedVisibleIndices: [],
    activeTabId,
    search: "",
    fieldSelected: 0,
    scroll: 0,
    tabActionFocus:
      readOnly && tabs.length > 0 && (options.actions?.length ?? 0) > 0 ? tabs.length : -1,
    pathNote: options.pathNote ?? "",
    pathNoteRef: { current: options.pathNote ?? "" },
    overlay,
    confirm,
  };

  updateVisibleIndices(state, buildVisibilityContext);

  function mountOverlay(c: Component, title?: string): void {
    state.overlay = { component: c, title };
    state.args.tui.requestRender();
  }

  function dismissOverlay(): void {
    state.overlay = undefined;
    state.args.tui.requestRender();
  }

  function getActiveTabId(): string | undefined {
    return state.activeTabId;
  }

  function setValues(values: Record<string, unknown>): void {
    for (const row of state.rows) {
      if (values[row.field.key] !== undefined) {
        row.value = values[row.field.key];
      }
    }
    state.dirtyKeys.clear();
    state.initialValues.clear();
    for (const row of state.rows) {
      const val = row.value;
      state.initialValues.set(
        row.field.key,
        typeof val === "object" && val !== null ? structuredClone(val) : val,
      );
    }
    state.args.tui.requestRender();
  }

  function mountDirtyConfirm(): void {
    state.confirm = createConfirm(
      {
        message: ["You have unsaved changes."],
        confirmLabel: "Discard",
        cancelLabel: "Cancel",
        danger: true,
      },
      (confirmed) => {
        state.confirm = undefined;
        if (confirmed) {
          state.options.onCancel?.();
          state.args.close();
        }
        state.args.tui.requestRender();
      },
      { tui: state.args.tui, theme: state.args.theme },
    );
    state.args.tui.requestRender();
  }

  function setEditing(row: InternalRow, value: boolean): void {
    row.isEditing = value;
  }

  function rendererFor(field: Field) {
    return RENDERERS[field.type as keyof typeof RENDERERS];
  }

  function actionLabel(action: {
    label: string;
    danger?: boolean;
    disabled?: boolean | (() => boolean);
  }): string {
    if (typeof action.disabled === "function") {
      return action.disabled() ? `${action.label} (disabled)` : action.label;
    }
    if (action.disabled) return `${action.label} (disabled)`;
    return action.label;
  }

  function dispatchKey(data: string): void {
    if (readOnly) return;
    const row = focusedRow(state);
    if (!row) return;
    const renderer = rendererFor(row.field);
    try {
      if (renderer) {
        const result = renderer.handleKey(
          { field: row.field as never, value: row.value as never },
          data,
          {
            isEditing: row.isEditing,
            ctx: fieldRenderContext,
            setEditing: (v) => setEditing(row, v),
          },
        );
        if (result.commit !== undefined) commitValue(state, row, result.commit);
        if (result.submenu) {
          mountOverlay(
            result.submenu((value) => {
              dismissOverlay();
              if (value !== undefined) commitValue(state, row, value);
            }),
            `${row.field.key} →`,
          );
        }
      }
    } catch (err) {
      notifyError(state, state.args.ctx, err);
    }
  }

  function handleReorder(direction: -1 | 1): boolean {
    if (readOnly) return true;
    const focusedIdx = focusedIndex(state);
    if (focusedIdx === undefined) return false;
    const focusedRowInternal = state.rows[focusedIdx];
    if (!focusedRowInternal?.field.reorderable) return false;

    const indices = visibleRowIndices(state);
    const visiblePos = indices.indexOf(focusedIdx);
    const targetVisiblePos = visiblePos + direction;
    if (targetVisiblePos < 0 || targetVisiblePos >= indices.length) {
      return true;
    }
    const targetIdx = indices[targetVisiblePos];
    const targetRow = state.rows[targetIdx];
    if (!targetRow?.field.reorderable) {
      return true;
    }

    const reorderablePeerIdxs = indices.filter((i) => state.rows[i]?.field.reorderable);
    const fromPeerPos = reorderablePeerIdxs.indexOf(focusedIdx);
    const toPeerPos = reorderablePeerIdxs.indexOf(targetIdx);

    state.rows[focusedIdx] = targetRow;
    state.rows[targetIdx] = focusedRowInternal;

    state.fieldSelected = targetVisiblePos;

    updateVisibleIndices(state, buildVisibilityContext);

    try {
      state.options.onReorder?.({
        fieldKey: focusedRowInternal.field.key,
        fromIndex: fromPeerPos,
        toIndex: toPeerPos,
      });
    } catch (err) {
      notifyError(state, state.args.ctx, err);
    }

    state.args.tui.requestRender();
    return true;
  }

  async function performSave(): Promise<void> {
    if (!state.options.onSave) return;
    try {
      const values = allValues(state);
      const result = state.options.onSave(values);
      if (result && typeof (result as Promise<void>).then === "function") {
        await (result as Promise<void>);
      }
      if (state.options.closeOnSave !== false) {
        state.args.close();
      }
    } catch (err) {
      notifyError(state, state.args.ctx, err);
    }
  }

  function handleInput(data: string): void {
    if (state.confirm) {
      state.confirm.handleInput?.(data);
      return;
    }
    if (state.overlay) {
      state.overlay.component.handleInput?.(data);
      return;
    }

    const row = focusedRow(state);

    if (matchesKey(data, "ctrl+s")) {
      if (state.isBuffered && state.options.onSave) {
        void performSave();
      }
      return;
    }

    if (matchesKey(data, "ctrl+r") || matchesKey(data, "alt+r")) {
      if (readOnly) return;
      const row = focusedRow(state);
      if (row && !row.field.disabled && !row.isEditing) {
        const def = row.field.default;
        if (def !== undefined) {
          const clonedDef = typeof def === "object" && def !== null ? structuredClone(def) : def;
          commitValue(state, row, clonedDef);
          state.args.tui.requestRender();
          return;
        }
      }
      state.args.tui.requestRender();
      return;
    }

    if (matchesKey(data, "alt+up")) {
      if (handleReorder(-1)) return;
    }
    if (matchesKey(data, "alt+down")) {
      if (handleReorder(1)) return;
    }

    if (row?.isEditing && matchesKey(data, "ctrl+c")) {
      if (state.isBuffered && isDirty(state)) {
        mountDirtyConfirm();
      } else {
        state.args.close();
      }
      return;
    }

    if (row?.isEditing) {
      dispatchKey(data);
      state.args.tui.requestRender();
      return;
    }

    if (matchesKey(data, "escape")) {
      if (state.tabActionFocus >= 0) {
        state.tabActionFocus = -1;
        state.args.tui.requestRender();
        return;
      }
      if (state.options.enableSearch && state.search !== "") {
        state.search = "";
        state.fieldSelected = 0;
        updateVisibleIndices(state, buildVisibilityContext);
        state.args.tui.requestRender();
        return;
      }
      if (state.isBuffered && isDirty(state)) {
        if (state.options.onRequestExit) {
          state.options.onRequestExit();
        } else {
          mountDirtyConfirm();
        }
      } else {
        state.args.close();
      }
      return;
    }

    if (matchesKey(data, "ctrl+c")) {
      if (state.isBuffered && isDirty(state)) {
        if (state.options.onRequestExit) {
          state.options.onRequestExit();
        } else {
          mountDirtyConfirm();
        }
      } else {
        state.args.close();
      }
      return;
    }

    // Tab/Shift+Tab: cycle through tabs + actions
    const actions = state.options.actions ?? [];
    const stopCount = readOnly ? state.tabs.length : state.tabs.length + actions.length;
    if (matchesKey(data, "tab")) {
      if (stopCount === 0) {
        state.args.tui.requestRender();
        return;
      }
      if (state.tabActionFocus === -1) {
        const currentTabIdx = state.tabs.findIndex((t) => t.id === state.activeTabId);
        if (currentTabIdx >= 0) {
          state.tabActionFocus = (currentTabIdx + 1) % stopCount;
        } else {
          state.tabActionFocus = 0;
        }
      } else if (state.tabActionFocus < state.tabs.length) {
        state.tabActionFocus = (state.tabActionFocus + 1) % stopCount;
      } else if (readOnly) {
        // Stay in action zone, advance the active tab
        const currentTabIdx = state.tabs.findIndex((t) => t.id === state.activeTabId);
        const nextTabIdx = currentTabIdx >= 0 ? (currentTabIdx + 1) % state.tabs.length : 0;
        const nextTab = state.tabs[nextTabIdx];
        if (nextTab && nextTab.id !== state.activeTabId) {
          state.activeTabId = nextTab.id;
          state.fieldSelected = 0;
          state.scroll = 0;
          updateVisibleIndices(state, buildVisibilityContext);
          state.options.onActiveTabChange?.(nextTab.id);
        }
        state.args.tui.requestRender();
        return;
      } else {
        state.tabActionFocus = (state.tabActionFocus + 1) % stopCount;
      }
      if (state.tabActionFocus < state.tabs.length) {
        const tab = state.tabs[state.tabActionFocus];
        if (tab && tab.id !== state.activeTabId) {
          state.activeTabId = tab.id;
          state.fieldSelected = 0;
          state.scroll = 0;
          updateVisibleIndices(state, buildVisibilityContext);
          state.options.onActiveTabChange?.(tab.id);
        }
      }
      state.args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "shift+tab")) {
      if (stopCount === 0) {
        state.args.tui.requestRender();
        return;
      }
      if (state.tabActionFocus === -1) {
        const currentTabIdx = state.tabs.findIndex((t) => t.id === state.activeTabId);
        if (currentTabIdx >= 0) {
          state.tabActionFocus = (currentTabIdx - 1 + stopCount) % stopCount;
        } else {
          state.tabActionFocus = stopCount - 1;
        }
      } else if (state.tabActionFocus < state.tabs.length) {
        state.tabActionFocus = (state.tabActionFocus - 1 + stopCount) % stopCount;
      } else if (readOnly) {
        // Stay in action zone, go to previous tab
        const currentTabIdx = state.tabs.findIndex((t) => t.id === state.activeTabId);
        const prevTabIdx =
          currentTabIdx >= 0
            ? (currentTabIdx - 1 + state.tabs.length) % state.tabs.length
            : state.tabs.length - 1;
        const prevTab = state.tabs[prevTabIdx];
        if (prevTab && prevTab.id !== state.activeTabId) {
          state.activeTabId = prevTab.id;
          state.fieldSelected = 0;
          state.scroll = 0;
          updateVisibleIndices(state, buildVisibilityContext);
          state.options.onActiveTabChange?.(prevTab.id);
        }
        state.args.tui.requestRender();
        return;
      } else {
        state.tabActionFocus = (state.tabActionFocus - 1 + stopCount) % stopCount;
      }
      if (state.tabActionFocus < state.tabs.length) {
        const tab = state.tabs[state.tabActionFocus];
        if (tab && tab.id !== state.activeTabId) {
          state.activeTabId = tab.id;
          state.fieldSelected = 0;
          state.scroll = 0;
          updateVisibleIndices(state, buildVisibilityContext);
          state.options.onActiveTabChange?.(tab.id);
        }
      }
      state.args.tui.requestRender();
      return;
    }

    // ←/→ navigate the tab/action ring when focused there, or enter
    // it from a readOnly field zone.
    const ringActions = state.options.actions ?? [];
    const ringStopCount = state.tabs.length + ringActions.length;
    if ((matchesKey(data, "left") || matchesKey(data, "right")) && ringStopCount > 0) {
      if (state.tabActionFocus >= 0) {
        const forward = matchesKey(data, "right");
        if (readOnly && state.tabs.length > 0 && ringActions.length > 0) {
          // Split navigation in readOnly: action row only, wrap within actions.
          if (state.tabActionFocus < state.tabs.length) {
            // From tab focus: enter action row.
            if (forward) {
              state.tabActionFocus = state.tabs.length; // first action
            } else {
              state.tabActionFocus = state.tabs.length + ringActions.length - 1; // last action
            }
          } else {
            // From action focus: wrap within actions only.
            const actionCount = ringActions.length;
            const currentActionIdx = state.tabActionFocus - state.tabs.length;
            state.tabActionFocus =
              state.tabs.length +
              (forward
                ? (currentActionIdx + 1) % actionCount
                : (currentActionIdx - 1 + actionCount) % actionCount);
          }
        } else {
          state.tabActionFocus = forward
            ? (state.tabActionFocus + 1) % ringStopCount
            : (state.tabActionFocus - 1 + ringStopCount) % ringStopCount;
          if (state.tabActionFocus < state.tabs.length) {
            const tab = state.tabs[state.tabActionFocus];
            if (tab && tab.id !== state.activeTabId) {
              state.activeTabId = tab.id;
              state.fieldSelected = 0;
              state.scroll = 0;
              updateVisibleIndices(state, buildVisibilityContext);
              state.options.onActiveTabChange?.(tab.id);
            }
          }
        }
        state.args.tui.requestRender();
        return;
      }
      if (state.tabActionFocus === -1 && readOnly && ringActions.length > 0) {
        if (matchesKey(data, "right")) {
          state.tabActionFocus = state.tabs.length; // first action
        } else {
          state.tabActionFocus = state.tabs.length + ringActions.length - 1; // last action
        }
        state.args.tui.requestRender();
        return;
      }
    }

    // Arrow keys navigate fields only (field zone). They also switch
    // Tab focus back to the field zone.
    const totalCount = totalVisibleItems(state);
    const lastIndex = Math.max(0, totalCount - 1);
    if (
      matchesKey(data, "up") ||
      matchesKey(data, "down") ||
      matchesKey(data, "pageUp") ||
      matchesKey(data, "pageDown")
    ) {
      state.tabActionFocus = -1;
    }
    if (matchesKey(data, "up")) {
      state.fieldSelected = Math.max(0, state.fieldSelected - 1);
      state.args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      state.fieldSelected = Math.min(lastIndex, state.fieldSelected + 1);
      state.args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageUp")) {
      state.fieldSelected = Math.max(0, state.fieldSelected - 5);
      state.args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageDown")) {
      state.fieldSelected = Math.min(lastIndex, state.fieldSelected + 5);
      state.args.tui.requestRender();
      return;
    }

    // Enter on a tab switches focus to field zone (tab already auto-switched).
    // Then lets Enter fall through to dispatchKey for field toggling/editing.
    // Enter on an action fires onAction if enabled.
    if ((matchesKey(data, "enter") || matchesKey(data, "return")) && state.tabActionFocus >= 0) {
      if (state.tabActionFocus < state.tabs.length) {
        state.tabActionFocus = -1;
        // Fall through to dispatchKey below
      } else if (actions.length > 0) {
        const actionIdx = state.tabActionFocus - state.tabs.length;
        const action = actions[actionIdx];
        if (action) {
          const disabled =
            typeof action.disabled === "function" ? action.disabled() : action.disabled;
          if (!disabled) {
            state.options.onAction?.(action.id);
          }
        }
        state.args.tui.requestRender();
        return;
      }
    }

    if (state.options.enableSearch) {
      if (matchesKey(data, "backspace") || matchesKey(data, "ctrl+h")) {
        state.search = state.search.slice(0, -1);
        state.fieldSelected = 0;
        updateVisibleIndices(state, buildVisibilityContext);
        state.args.tui.requestRender();
        return;
      }
      if (matchesKey(data, "ctrl+u")) {
        state.search = "";
        state.fieldSelected = 0;
        updateVisibleIndices(state, buildVisibilityContext);
        state.args.tui.requestRender();
        return;
      }
      if (matchesKey(data, "ctrl+w")) {
        state.search = deleteWordBackward(state.search);
        state.fieldSelected = 0;
        updateVisibleIndices(state, buildVisibilityContext);
        state.args.tui.requestRender();
        return;
      }
    }

    dispatchKey(data);
    if (
      state.options.enableSearch &&
      data.length === 1 &&
      data >= " " &&
      data !== "\x7f" &&
      !row?.isEditing
    ) {
      if (!row || !row.isEditing) {
        state.search += data;
        state.fieldSelected = 0;
        updateVisibleIndices(state, buildVisibilityContext);
      }
    }
    state.args.tui.requestRender();
  }

  return {
    render(width: number): string[] {
      const inner = responsiveInnerRows(
        state.args.tui.terminal.rows ?? 24,
        PREFERRED_INNER_ROWS,
        14,
      );
      if (state.confirm) {
        const lines = state.confirm.render(frameContentWidth(width));
        const title = state.options.title
          ? `${state.options.title} — Discard changes?`
          : "Discard changes?";
        const opts: FrameOptions = {
          title,
          fixedInnerRows: inner,
        };
        return frame(lines, width, state.args.theme, opts);
      }
      if (state.overlay) {
        const lines = state.overlay.component.render(frameContentWidth(width));
        const title = state.overlay.title ?? state.options.title;
        const opts: FrameOptions = {
          title,
          fixedInnerRows: inner,
        };
        return frame(lines, width, state.args.theme, opts);
      }

      const contentWidth = frameContentWidth(width);
      const footerRows = renderFooter(state, rendererFor, contentWidth);
      const footerSectionHeight = 1 + footerRows.length; // divider + hints
      const actions = state.options.actions ?? [];
      const actionSectionHeight = actions.length > 0 ? 2 : 0;
      const bottomSectionHeight = footerSectionHeight + actionSectionHeight;
      const bodyInnerRows = inner - bottomSectionHeight;
      const bodyLines = renderBody(
        state,
        rendererFor,
        fieldRenderContext,
        contentWidth,
        bodyInnerRows,
      );

      const dirtyDot =
        state.isBuffered && isDirty(state) ? ` ${state.args.theme.fg("accent", "● Unsaved")}` : "";
      const title = state.options.title ? `${state.options.title}${dirtyDot}` : state.options.title;

      const frameLines = frame(bodyLines, width, state.args.theme, {
        title,
        fixedInnerRows: bodyInnerRows,
      });

      const bottomBorder = frameLines.pop()!;
      const bottomPadding = frameLines.pop()!;
      const borderAccent = (s: string) => state.args.theme.fg("borderAccent", s);

      const paddingX = DEFAULT_PADDING_X;
      const footDiv = `${borderAccent("│")}${" ".repeat(paddingX)}${state.args.theme.fg("dim", "─".repeat(Math.max(1, contentWidth)))}${" ".repeat(paddingX)}${borderAccent("│")}`;
      frameLines.push(footDiv);
      for (const line of footerRows) {
        const paddedLine = `  ${line}`;
        frameLines.push(
          `${borderAccent("│")}${" ".repeat(paddingX)}${pad(paddedLine, contentWidth)}${" ".repeat(paddingX)}${borderAccent("│")}`,
        );
      }

      if (actions.length > 0) {
        const actDiv = `${borderAccent("│")}${" ".repeat(paddingX)}${state.args.theme.fg("dim", "─".repeat(Math.max(1, contentWidth)))}${" ".repeat(paddingX)}${borderAccent("│")}`;
        frameLines.push(actDiv);

        const cells: string[] = [];
        for (let ai = 0; ai < actions.length; ai++) {
          const action = actions[ai]!;
          const isFocused =
            state.tabActionFocus >= state.tabs.length &&
            state.tabActionFocus - state.tabs.length === ai;
          const rawLabel = actionLabel(action);
          const padded = ` ${rawLabel} `;
          if (isFocused) {
            cells.push(
              state.args.theme.fg(
                "accent",
                state.args.theme.inverse(state.args.theme.bold(padded)),
              ),
            );
          } else if (action.danger) {
            cells.push(state.args.theme.bg("selectedBg", state.args.theme.fg("warning", padded)));
          } else {
            cells.push(state.args.theme.bg("selectedBg", state.args.theme.fg("accent", padded)));
          }
        }
        const line = pad(cells.join(" "), contentWidth);
        frameLines.push(
          `${borderAccent("│")}${" ".repeat(paddingX)}${line}${" ".repeat(paddingX)}${borderAccent("│")}`,
        );
      }

      frameLines.push(bottomPadding);
      frameLines.push(bottomBorder);

      return frameLines;
    },
    invalidate(): void {
      state.overlay?.component.invalidate?.();
      state.confirm?.invalidate?.();
    },
    handleInput,
    mountOverlay,
    dismissOverlay,
    getActiveTabId,
    setValues,
  } as SettingsModalBodyComponent;
}
