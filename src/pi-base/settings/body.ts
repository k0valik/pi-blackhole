/**
 * `SettingsModalBody` — the renderable+inputtable component that
 * `createSettingsModal` and `openSettingsModal` mount inside an
 * overlay. Owns:
 *
 *   - Tab strip across the top (when `tabs` is non-empty).
 *   - Optional fuzzy search bar (when `enableSearch` is true).
 *   - The list of rows, with one focused at a time.
 *   - Per-row inline-edit state (string/number/secret/path).
 *   - Submenu mounting (enum long-list, model widget, custom openSubmenu).
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
} from "@earendil-works/pi-tui";
import { loadConfig, getExtensionsDir } from "../config.ts";
import { validateFieldValue } from "./validate-field.ts";
import type {
  Field,
  FieldKeyHint,
  FieldRenderContext,
  SettingsModalOptions,
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
} from "./frame";
import { deleteWordBackward, type InlineEditState } from "./inline-edit";

const PREFERRED_INNER_ROWS = 30;
const LABEL_PAD_TARGET = 28;

interface InternalRow {
  field: Field;
  /** Live displayed value, written back through `onChange`. */
  value: unknown;
  globalValue?: unknown;
  projectValue?: unknown;
  /** Inline-edit toggle for editable types. */
  isEditing: boolean;
  /** Pre-computed lowercased search index string for fuzzy filtering. */
  searchIndex: string;
  /** Pre-computed truncated label text. */
  labelText: string;
  /** Pre-computed label padding. */
  labelPadding: string;
}

interface ConfirmSubmenuState {
  selectedIndex: number;
  dirtyKeys: Set<string>;
  initialValues: Map<string, unknown>;
}

interface ConfirmOption {
  label: string;
  action: "save-global" | "save-project" | "discard" | "cancel";
}

const confirmOptions: ConfirmOption[] = [
  { label: "Save to Global", action: "save-global" },
  { label: "Save to Project Local", action: "save-project" },
  { label: "Discard", action: "discard" },
  { label: "Cancel", action: "cancel" },
];

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
): Component {
  const useScopeTabs = options.configFilename !== undefined;
  const tabs: Tab[] = useScopeTabs
    ? [
        { id: "global", label: "Global" },
        { id: "project", label: "Project Local" },
      ]
    : (options.tabs ?? []);
  const fields: Field[] = options.fields as Field[];
  const mode = options.mode ?? "immediate";
  const isBuffered = mode === "buffered";

  let globalConfig: Record<string, unknown> = {};
  let projectConfig: Record<string, unknown> = {};
  if (useScopeTabs && options.configFilename) {
    const fn = options.configFilename;
    const defs = options.defaults ?? {};
    const globalDir = options.globalConfigDir ?? getExtensionsDir();
    globalConfig = loadConfig(fn, defs, { configDir: globalDir });
    projectConfig = loadConfig(fn, defs, { cwd: args.ctx.cwd, configDir: globalDir });
  }

  let activeTabId: string | undefined = options.initialTab ?? tabs[0]?.id;

  // Per-row state lives in this array, indexed parallel to a snapshot
  // of `fields`. We never reorder it — search filters use a separate
  // `filteredIndices` view.
  const rows: InternalRow[] = fields.map((field) => {
    let globalVal: unknown;
    let projectVal: unknown;

    if (useScopeTabs) {
      globalVal = getNestedValue(globalConfig, field.key);
      if (globalVal === undefined) {
        globalVal = getNestedValue(options.defaults ?? {}, field.key);
      }
      if (globalVal === undefined) {
        globalVal = extractInitialValue(field);
      }

      projectVal = getNestedValue(projectConfig, field.key);
      if (projectVal === undefined) {
        projectVal = globalVal;
      }
    } else {
      globalVal = extractInitialValue(field);
      projectVal = globalVal;
    }

    const labelText = truncateToWidth(field.label, LABEL_PAD_TARGET, "…");
    const labelPadding = " ".repeat(Math.max(1, LABEL_PAD_TARGET - visibleWidth(labelText)));

    return {
      field,
      get globalValue() {
        return globalVal;
      },
      set globalValue(v) {
        globalVal = v;
      },
      get projectValue() {
        return projectVal;
      },
      set projectValue(v) {
        projectVal = v;
      },
      get value() {
        return activeTabId === "project" ? projectVal : globalVal;
      },
      set value(v) {
        if (activeTabId === "project") {
          projectVal = v;
        } else {
          globalVal = v;
        }
      },
      isEditing: false,
      searchIndex: `${field.label}\n${field.description ?? ""}\n${field.key}`.toLowerCase(),
      labelText,
      labelPadding,
    };
  }) as unknown as InternalRow[];

  // Inline-edit state registry: keyed by field.key. Renderers reach
  // into this through `ctx.editStates` (see fields/string.ts).
  const editStates: Map<string, InlineEditState> = new Map();

  // Buffered mode: snapshot initial values and track dirty keys.
  const initialGlobalValues = new Map<string, unknown>();
  const initialProjectValues = new Map<string, unknown>();
  const dirtyGlobalKeys = new Set<string>();
  const dirtyProjectKeys = new Set<string>();

  if (isBuffered) {
    for (const row of rows) {
      const gVal = row.globalValue;
      initialGlobalValues.set(
        row.field.key,
        typeof gVal === "object" && gVal !== null ? JSON.parse(JSON.stringify(gVal)) : gVal,
      );
      const pVal = row.projectValue;
      initialProjectValues.set(
        row.field.key,
        typeof pVal === "object" && pVal !== null ? JSON.parse(JSON.stringify(pVal)) : pVal,
      );
    }
  }

  function getInitialValues() {
    return activeTabId === "project" ? initialProjectValues : initialGlobalValues;
  }

  function getDirtyKeys() {
    return activeTabId === "project" ? dirtyProjectKeys : dirtyGlobalKeys;
  }
  let search = "";
  let fieldSelected = 0;
  let scroll = 0;
  let tabActionFocus = -1;
  let submenu: Component | undefined;
  let submenuKey: string | undefined;
  let confirmState: ConfirmSubmenuState | undefined;
  let scopeActionConfirm: { action: "reset" | "delete"; selectedIndex: number } | undefined;
  // Scope default inferred once at mount via the extension's callback.
  const defaultScope: "global" | "project" = (options.inferDefaultScope?.() ?? "global") as
    | "global"
    | "project";

  const fieldRenderContext: FieldRenderContext & {
    editStates: Map<string, InlineEditState>;
  } = {
    theme: args.theme,
    tui: args.tui,
    ctx: args.ctx,
    requestRender: () => args.tui.requestRender(),
    editStates,
  };

  // Action rows (only visible at the bottom of scope tabs when callbacks are provided)
  const actionRows: { id: string; label: string; description: string }[] = [];
  if (useScopeTabs && (options.onResetScope || options.onDeleteScope)) {
    if (options.onResetScope) {
      actionRows.push({
        id: "reset",
        label: "Reset to defaults",
        description: "Remove all config keys for this scope — values fall back to defaults.",
      });
    }
    if (options.onDeleteScope) {
      actionRows.push({
        id: "delete",
        label: "Delete config",
        description: "Remove the entire config file for this scope.",
      });
    }
  }

  // Optimization: Cache the visible row indices list to avoid redundant array
  // allocations, lowercase conversions, and substring checks inside hot rendering
  // and search filtering loops.
  let cachedVisibleIndices: number[] = [];

  function buildVisibilityContext(_field: Field, scope: string): VisibilityContext {
    return {
      get: (key: string) => {
        const r = rows.find((rr) => rr.field.key === key);
        return r?.value;
      },
      getScoped: (key: string, targetScope?: string) => {
        const r = rows.find((rr) => rr.field.key === key);
        if (!r) return undefined;
        if (!targetScope || targetScope === scope) return r.value;
        return targetScope === "project" ? r.projectValue : r.globalValue;
      },
      scope,
    };
  }

  function totalVisibleItems(): number {
    return cachedVisibleIndices.length;
  }

  function updateVisibleIndices(): void {
    const query = search.trim().toLowerCase();
    const out: number[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      if (activeTabId !== undefined && tabs.length > 0 && !useScopeTabs) {
        // When tabs are configured, fields without an explicit `tab` id
        // surface only on the first tab — same convention as a default
        // landing tab in browser-style chrome.
        const fallbackTab = tabs[0]!.id;
        const rowTab = row.field.tab ?? fallbackTab;
        if (rowTab !== activeTabId) continue;
      }
      // visibleWhen: fields can conditionally hide based on sibling values
      if (row.field.visibleWhen) {
        const scope = activeTabId ?? "global";
        if (!row.field.visibleWhen(buildVisibilityContext(row.field, scope))) continue;
      }
      if (!query) {
        out.push(i);
        continue;
      }
      if (row.searchIndex.includes(query)) out.push(i);
    }
    cachedVisibleIndices = out;
  }

  // Compute the initial visible indices.
  updateVisibleIndices();

  function visibleRowIndices(): number[] {
    return cachedVisibleIndices;
  }

  function clampSelection(visibleRows: number): void {
    const count = totalVisibleItems();
    fieldSelected = Math.max(0, Math.min(fieldSelected, Math.max(0, count - 1)));
    if (fieldSelected < scroll) scroll = fieldSelected;
    else if (fieldSelected >= scroll + visibleRows) scroll = fieldSelected - visibleRows + 1;
    scroll = Math.max(0, Math.min(scroll, Math.max(0, count - visibleRows)));
  }

  function focusedIndex(): number | undefined {
    const indices = visibleRowIndices();
    if (indices.length === 0) return undefined;
    const safe = Math.max(0, Math.min(fieldSelected, indices.length - 1));
    return indices[safe];
  }

  function focusedRow(): InternalRow | undefined {
    const idx = focusedIndex();
    return idx === undefined ? undefined : rows[idx];
  }

  function isDirty(): boolean {
    if (!isBuffered) return false;
    return dirtyGlobalKeys.size > 0 || dirtyProjectKeys.size > 0;
  }

  /** Update dirty state for a key by comparing current value against
   *  the initial snapshot. Removes the key if the value has reverted
   *  to its original; adds it otherwise. */
  function syncDirtyState(key: string): void {
    if (!isBuffered) return;
    const initial = getInitialValues().get(key);
    const current = rows.find((r) => r.field.key === key)?.value;
    const isClean =
      typeof initial === "object" && initial !== null
        ? JSON.stringify(current) === JSON.stringify(initial)
        : current === initial;
    if (isClean) {
      getDirtyKeys().delete(key);
    } else {
      getDirtyKeys().add(key);
    }
  }

  function commitValue(row: InternalRow, value: unknown): void {
    const previous = row.value;
    const key = row.field.key;

    row.value = value;
    if (isBuffered) {
      syncDirtyState(key);
    }

    try {
      const ret = options.onChange?.(row.field.key as never, value as never, row.field as never);
      if (ret && typeof (ret as Promise<void>).then === "function") {
        // Async onChange: dirty state is already set above. On
        // rejection, roll the row back and re-sync dirty state.
        (ret as Promise<void>)
          .then(() => {
            if (isBuffered) {
              args.tui.requestRender();
            }
          })
          .catch((err) => {
            if (row.value === value) {
              row.value = previous;
            }
            if (isBuffered) {
              syncDirtyState(key);
            }
            notifyError(args.ctx, err);
            args.tui.requestRender();
          });
      }
    } catch (err) {
      row.value = previous;
      if (isBuffered) {
        syncDirtyState(key);
      }
      notifyError(args.ctx, err);
      args.tui.requestRender();
    }
  }

  function mountSubmenu(
    factory: NonNullable<ReturnType<(typeof RENDERERS)[Field["type"]]["handleKey"]>["submenu"]>,
    row: InternalRow,
  ): void {
    submenu = factory((value) => {
      submenu = undefined;
      submenuKey = undefined;
      if (value !== undefined) commitValue(row, value);
      args.tui.requestRender();
    });
    submenuKey = row.field.key;
    args.tui.requestRender();
  }

  function mountConfirmSubmenu(): void {
    const scopeToUse = useScopeTabs ? activeTabId : defaultScope;
    confirmState = {
      selectedIndex: scopeToUse === "project" ? 1 : 0,
      dirtyKeys: new Set(getDirtyKeys()),
      initialValues: new Map(getInitialValues()),
    };
    args.tui.requestRender();
  }

  function mountScopeActionConfirm(action: "reset" | "delete"): void {
    scopeActionConfirm = { action, selectedIndex: 0 };
    args.tui.requestRender();
  }

  function setEditing(row: InternalRow, value: boolean): void {
    row.isEditing = value;
  }

  function rendererFor(field: Field) {
    return RENDERERS[field.type];
  }

  function dispatchKey(data: string): void {
    const row = focusedRow();
    if (!row) return;
    const renderer = rendererFor(row.field);
    try {
      const result = renderer.handleKey(
        { field: row.field as never, value: row.value as never },
        data,
        {
          isEditing: row.isEditing,
          ctx: fieldRenderContext,
          setEditing: (v) => setEditing(row, v),
        },
      );
      if (result.commit !== undefined) commitValue(row, result.commit);
      if (result.submenu) mountSubmenu(result.submenu, row);
    } catch (err) {
      notifyError(args.ctx, err);
    }
  }

  /**
   * Apply an alt+↑ / alt+↓ reorder request originating from `handleInput`.
   *
   * Returns `true` when the reorder consumed the keystroke (success
   * or graceful no-op at an edge); `false` when the focused row isn't
   * `reorderable` and the modal should fall through to the default
   * alt-arrow handling (which is currently nothing — alt-arrows are
   * inert in non-reorderable contexts).
   *
   * Reorder is restricted to swaps with the immediate `reorderable`
   * neighbour in `visibleRowIndices` order. We do NOT skip over
   * intervening non-reorderable rows: callers are expected to group
   * reorderable rows contiguously, which keeps the visual behaviour
   * predictable.
   */
  function handleReorder(direction: -1 | 1): boolean {
    const focusedIdx = focusedIndex();
    if (focusedIdx === undefined) return false;
    const focusedRowInternal = rows[focusedIdx];
    if (!focusedRowInternal?.field.reorderable) return false;

    const indices = visibleRowIndices();
    const visiblePos = indices.indexOf(focusedIdx);
    const targetVisiblePos = visiblePos + direction;
    if (targetVisiblePos < 0 || targetVisiblePos >= indices.length) {
      // At the edge — still consume the keystroke so it doesn't bleed
      // into the bare up/down handler below.
      return true;
    }
    const targetIdx = indices[targetVisiblePos]!;
    const targetRow = rows[targetIdx];
    if (!targetRow?.field.reorderable) {
      // Adjacent neighbour isn't reorderable — treat as edge.
      return true;
    }

    // Compute the from/to indices counting ONLY reorderable peers so
    // callers that interleave non-reorderable rows (e.g. a Separator
    // field at the bottom of a Layout tab) still receive contiguous
    // 0..N-1 positions matching their own data structure.
    const reorderablePeerIdxs = indices.filter((i) => rows[i]?.field.reorderable);
    const fromPeerPos = reorderablePeerIdxs.indexOf(focusedIdx);
    const toPeerPos = reorderablePeerIdxs.indexOf(targetIdx);

    // Swap the two rows in-place.
    rows[focusedIdx] = targetRow;
    rows[targetIdx] = focusedRowInternal;

    // Update `fieldSelected` so focus follows the moved row.
    // `fieldSelected` indexes into the visible-rows view; the row
    // we swapped to `targetIdx` is at visible position
    // `targetVisiblePos`.
    fieldSelected = targetVisiblePos;

    // Recompute cached visible indices as the internal rows order has changed
    updateVisibleIndices();

    try {
      options.onReorder?.({
        fieldKey: focusedRowInternal.field.key,
        fromIndex: fromPeerPos,
        toIndex: toPeerPos,
      });
    } catch (err) {
      notifyError(args.ctx, err);
    }

    args.tui.requestRender();
    return true;
  }

  function allValues(scope?: "global" | "project"): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      if (useScopeTabs) {
        out[row.field.key] = scope === "project" ? row.projectValue : row.globalValue;
      } else {
        out[row.field.key] = row.value;
      }
    }
    return out;
  }

  async function performSave(scope: "global" | "project"): Promise<void> {
    if (!options.onSave) return;
    try {
      const result = options.onSave(allValues(scope), scope);
      // If onSave returned a thenable, await it; otherwise close
      // synchronously so synchronous callers (e.g. tests) don't need
      // to flush microtasks.
      const maybeThenable = result as unknown;
      if (maybeThenable && typeof (maybeThenable as Promise<void>).then === "function") {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        (await maybeThenable) as Promise<void>;
      }
      args.close();
    } catch (err) {
      notifyError(args.ctx, err);
      // Keep modal open on error — user can retry or cancel.
    }
  }

  function handleConfirmInput(data: string): void {
    if (!confirmState) return;
    if (matchesKey(data, "up")) {
      confirmState.selectedIndex = Math.max(0, confirmState.selectedIndex - 1);
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      const count = confirmOptions.length;
      confirmState.selectedIndex = Math.min(count - 1, confirmState.selectedIndex + 1);
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "escape")) {
      // Cancel: unmount submenu, preserve edits.
      confirmState = undefined;
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      const choice = confirmOptions[confirmState.selectedIndex];
      if (!choice) return;
      if (choice.action === "save-global") {
        void performSave("global");
      } else if (choice.action === "save-project") {
        void performSave("project");
      } else if (choice.action === "discard") {
        try {
          options.onCancel?.();
        } catch {
          // Caller-supplied onCancel must not break the confirm teardown.
        }
        args.close();
      } else {
        // cancel
        confirmState = undefined;
        args.tui.requestRender();
      }
    }
  }

  function renderConfirmSubmenu(_width: number): string[] {
    const lines: string[] = [];
    lines.push("");
    lines.push("  You have unsaved changes:");
    lines.push("");

    for (let i = 0; i < confirmOptions.length; i++) {
      const opt = confirmOptions[i]!;
      const isSelected = i === confirmState!.selectedIndex;
      const prefix = isSelected ? args.theme.fg("accent", "▌ ") : "  ";
      const label = isSelected
        ? args.theme.fg("text", opt.label)
        : args.theme.fg("muted", opt.label);
      lines.push(`${prefix}${label}`);
    }

    lines.push("");
    const needsReload = Array.from(confirmState!.dirtyKeys).some((key) => {
      const row = rows.find((r) => r.field.key === key);
      return (row?.field as { requiresReload?: boolean } | undefined)?.requiresReload === true;
    });
    if (needsReload) {
      lines.push(args.theme.fg("muted", "  Some changes require /reload to take effect."));
    }
    lines.push(args.theme.fg("muted", "  ↑↓ select  enter confirm  esc cancel"));

    return lines;
  }

  function handleScopeActionConfirmInput(data: string): void {
    if (!scopeActionConfirm) return;
    if (matchesKey(data, "up")) {
      scopeActionConfirm.selectedIndex = Math.max(0, scopeActionConfirm.selectedIndex - 1);
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      const max = 2; // global, project, cancel
      scopeActionConfirm.selectedIndex = Math.min(max, scopeActionConfirm.selectedIndex + 1);
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "escape")) {
      scopeActionConfirm = undefined;
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      const act = scopeActionConfirm.action;
      const options = getScopeActionOptions(act);
      const choice = options[scopeActionConfirm.selectedIndex];
      scopeActionConfirm = undefined;
      if (choice && choice.scope !== null) {
        void handleScopeAction(act, choice.scope);
      } else {
        args.tui.requestRender();
      }
    }
  }

  function getScopeActionOptions(
    action: "reset" | "delete",
  ): Array<{ label: string; scope: "global" | "project" | null }> {
    const verb = action === "reset" ? "Reset to defaults" : "Delete config";
    return [
      { label: `${verb} (global)`, scope: "global" },
      { label: `${verb} (project-local)`, scope: "project" },
      { label: "Cancel", scope: null },
    ];
  }

  function renderScopeActionConfirm(_width: number): string[] {
    const lines: string[] = [];
    const isReset = scopeActionConfirm!.action === "reset";
    const options = getScopeActionOptions(scopeActionConfirm!.action);
    lines.push("");
    lines.push(isReset ? "  Reset config to defaults" : "  Delete config file");
    lines.push("");
    lines.push(args.theme.fg("muted", "  Select scope:"));
    lines.push("");

    for (let i = 0; i < options.length; i++) {
      const isSelected = i === scopeActionConfirm!.selectedIndex;
      const prefix = isSelected ? args.theme.fg("accent", "▌ ") : "  ";
      const label = isSelected
        ? args.theme.fg("text", options[i]!.label)
        : args.theme.fg("muted", options[i]!.label);
      lines.push(`${prefix}${label}`);
    }

    lines.push("");
    lines.push(args.theme.fg("muted", "  ↑↓ select  enter confirm  esc cancel"));
    return lines;
  }

  function handleInput(data: string): void {
    if (submenu) {
      submenu.handleInput?.(data);
      return;
    }
    if (confirmState) {
      handleConfirmInput(data);
      return;
    }
    if (scopeActionConfirm) {
      handleScopeActionConfirmInput(data);
      return;
    }
    const row = focusedRow();

    if (row?.isEditing) {
      // While editing, only the renderer (and esc/enter) gets to see
      // input — cursor & nav keys are reserved for the inline editor.
      dispatchKey(data);
      args.tui.requestRender();
      return;
    }

    if (matchesKey(data, "ctrl+s")) {
      if (isBuffered && isDirty()) {
        mountConfirmSubmenu();
      } else if (isBuffered) {
        // No changes — save directly to the inferred default scope.
        // This lets users deploy a fresh config without editing anything.
        const scope: "global" | "project" = useScopeTabs
          ? ((activeTabId ?? defaultScope) as "global" | "project")
          : defaultScope;
        void performSave(scope);
      }
      return;
    }
    // ctrl+r: contextual — field-level reset when on field, scope reset when on action row
    if (matchesKey(data, "ctrl+r")) {
      if (tabActionFocus >= tabs.length && actionRows.length > 0) {
        // Action row focused → scope reset
        if (options.onResetScope) {
          mountScopeActionConfirm("reset");
        }
      } else {
        // Field focused → field-level reset
        const row = focusedRow();
        if (row && !row.field.disabled && !row.isEditing) {
          const def = row.field.default;
          if (def !== undefined) {
            const clonedDef =
              typeof def === "object" && def !== null ? JSON.parse(JSON.stringify(def)) : def;
            commitValue(row, clonedDef);
          }
        }
      }
      args.tui.requestRender();
      return;
    }
    // ctrl+d: field-level reset when on field, scope delete when on action row
    if (matchesKey(data, "ctrl+d")) {
      if (tabActionFocus >= tabs.length && actionRows.length > 0) {
        // Action row focused → scope delete
        if (options.onDeleteScope) {
          mountScopeActionConfirm("delete");
        }
      } else {
        // Field focused → field-level reset (same as ctrl+r)
        const row = focusedRow();
        if (row && !row.field.disabled && !row.isEditing) {
          const def = row.field.default;
          if (def !== undefined) {
            const clonedDef =
              typeof def === "object" && def !== null ? JSON.parse(JSON.stringify(def)) : def;
            commitValue(row, clonedDef);
          }
        }
      }
      args.tui.requestRender();
      return;
    }
    // ctrl+shift+r: always scope reset (from anywhere)
    if (matchesKey(data, "ctrl+shift+r")) {
      if (options.onResetScope) {
        mountScopeActionConfirm("reset");
      }
      args.tui.requestRender();
      return;
    }
    // ctrl+shift+d: always scope delete (from anywhere)
    if (matchesKey(data, "ctrl+shift+d")) {
      if (options.onDeleteScope) {
        mountScopeActionConfirm("delete");
      }
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "escape")) {
      // If Tab focus is on action row/tab, first escape returns to field zone
      if (tabActionFocus >= 0) {
        tabActionFocus = -1;
        args.tui.requestRender();
        return;
      }
      if (options.enableSearch && search !== "") {
        search = "";
        fieldSelected = 0;
        updateVisibleIndices();
        args.tui.requestRender();
        return;
      }
      if (isBuffered && isDirty()) {
        mountConfirmSubmenu();
      } else {
        args.close();
      }
      return;
    }
    if (matchesKey(data, "ctrl+c")) {
      if (isBuffered && isDirty()) {
        mountConfirmSubmenu();
      } else {
        args.close();
      }
      return;
    }
    // Tab/Shift+Tab: cycle through tabs + action row
    if (matchesKey(data, "tab")) {
      const stopCount = tabs.length + actionRows.length;
      if (stopCount === 0) {
        args.tui.requestRender();
        return;
      }
      if (tabActionFocus === -1) {
        // Start from the next stop after the current active tab,
        // so Tab never "rewinds" to the first stop.
        const currentTabIdx = tabs.findIndex((t) => t.id === activeTabId);
        if (currentTabIdx >= 0) {
          tabActionFocus = (currentTabIdx + 1) % stopCount;
        } else {
          tabActionFocus = 0;
        }
      } else {
        tabActionFocus = (tabActionFocus + 1) % stopCount;
      }
      // Auto-switch active tab when a tab is focused
      if (tabActionFocus < tabs.length) {
        const tab = tabs[tabActionFocus];
        if (tab && tab.id !== activeTabId) {
          activeTabId = tab.id;
          fieldSelected = 0;
          scroll = 0;
          updateVisibleIndices();
        }
      }
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "shift+tab")) {
      const stopCount = tabs.length + actionRows.length;
      if (stopCount === 0) {
        args.tui.requestRender();
        return;
      }
      if (tabActionFocus === -1) {
        // Start from the previous stop before the current active tab.
        const currentTabIdx = tabs.findIndex((t) => t.id === activeTabId);
        if (currentTabIdx >= 0) {
          tabActionFocus = (currentTabIdx - 1 + stopCount) % stopCount;
        } else {
          tabActionFocus = stopCount - 1;
        }
      } else {
        tabActionFocus = (tabActionFocus - 1 + stopCount) % stopCount;
      }
      if (tabActionFocus < tabs.length) {
        const tab = tabs[tabActionFocus];
        if (tab && tab.id !== activeTabId) {
          activeTabId = tab.id;
          fieldSelected = 0;
          scroll = 0;
          updateVisibleIndices();
        }
      }
      args.tui.requestRender();
      return;
    }
    // Alt+↑ / Alt+↓ reorders the focused row among its `reorderable`
    // peers. Has to run before the bare up/down handlers so the
    // modifier prefix is what dispatches — otherwise `matchesKey(data,
    // "up")` could match the alt-modified variant first depending on
    // the terminal's escape sequence.
    if (matchesKey(data, "alt+up")) {
      if (handleReorder(-1)) return;
    }
    if (matchesKey(data, "alt+down")) {
      if (handleReorder(1)) return;
    }
    if (matchesKey(data, "alt+r")) {
      const row = focusedRow();
      if (row && !row.field.disabled && !row.isEditing) {
        const def = row.field.default;
        if (def !== undefined) {
          const clonedDef =
            typeof def === "object" && def !== null ? JSON.parse(JSON.stringify(def)) : def;
          commitValue(row, clonedDef);
          args.tui.requestRender();
          return;
        }
      }
    }
    // Arrow keys navigate fields only (field zone). They also switch
    // Tab focus back to the field zone.
    const totalCount = totalVisibleItems();
    const lastIndex = Math.max(0, totalCount - 1);
    if (
      matchesKey(data, "up") ||
      matchesKey(data, "down") ||
      matchesKey(data, "pageUp") ||
      matchesKey(data, "pageDown")
    ) {
      tabActionFocus = -1;
    }
    if (matchesKey(data, "up")) {
      fieldSelected = Math.max(0, fieldSelected - 1);
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      fieldSelected = Math.min(lastIndex, fieldSelected + 1);
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageUp")) {
      fieldSelected = Math.max(0, fieldSelected - 5);
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageDown")) {
      fieldSelected = Math.min(lastIndex, fieldSelected + 5);
      args.tui.requestRender();
      return;
    }
    // Enter on a tab switches focus to field zone (tab already auto-switched).
    // Then lets Enter fall through to dispatchKey for field toggling/editing.
    // Enter on action row activates the focused action with confirmation.
    if ((matchesKey(data, "enter") || matchesKey(data, "return")) && tabActionFocus >= 0) {
      if (tabActionFocus < tabs.length) {
        // Tab focused — return to field zone, then let Enter fall through
        // to dispatchKey for field toggling/editing.
        tabActionFocus = -1;
        // Do NOT return — fall through to dispatchKey below
      } else if (actionRows.length > 0) {
        // Action row focused — determine which action by index
        const actionIdx = tabActionFocus - tabs.length;
        const action = actionRows[actionIdx];
        if (action) {
          const act = action.id === "reset" ? "reset" : "delete";
          const cb = act === "reset" ? options.onResetScope : options.onDeleteScope;
          if (cb) {
            mountScopeActionConfirm(act);
          }
        }
        args.tui.requestRender();
        return;
      }
    }

    if (options.enableSearch) {
      if (matchesKey(data, "backspace") || matchesKey(data, "ctrl+h")) {
        search = search.slice(0, -1);
        fieldSelected = 0;
        updateVisibleIndices();
        args.tui.requestRender();
        return;
      }
      if (matchesKey(data, "ctrl+u")) {
        search = "";
        fieldSelected = 0;
        updateVisibleIndices();
        args.tui.requestRender();
        return;
      }
      if (matchesKey(data, "ctrl+w")) {
        search = deleteWordBackward(search);
        fieldSelected = 0;
        updateVisibleIndices();
        args.tui.requestRender();
        return;
      }
    }

    // Enter / value-key falls through to the renderer.
    dispatchKey(data);
    if (
      options.enableSearch &&
      data.length === 1 &&
      data >= " " &&
      data !== "\x7f" &&
      !row?.isEditing
    ) {
      // Plain printable input that the renderer didn't claim joins the
      // search query. Booleans / enums never claim it (their
      // handleKey returns `consumed:false` for non-Enter), so users
      // can still type to filter.
      // We detect "renderer didn't claim it" by checking the row state
      // didn't change to editing — a heuristic that works for every
      // built-in. Custom renderers that want to swallow letters should
      // mark the row as editing first.
      if (!row || !row.isEditing) {
        search += data;
        fieldSelected = 0;
        updateVisibleIndices();
      }
    }
    args.tui.requestRender();
  }


  function renderTabBar(width: number): string {
    if (tabs.length === 0) return "";
    const cells: string[] = [];
    for (const tab of tabs) {
      let label = tab.label;
      if (isBuffered) {
        const isTabDirty = useScopeTabs
          ? tab.id === "project"
            ? dirtyProjectKeys.size > 0
            : dirtyGlobalKeys.size > 0
          : Array.from(getDirtyKeys()).some((key) => {
              const row = rows.find((r) => r.field.key === key);
              const fallbackTab = tabs[0]?.id;
              const rowTab = row?.field.tab ?? fallbackTab;
              return rowTab === tab.id;
            });
        if (isTabDirty) {
          label += " ● Unsaved";
        }
      }
      if (tab.id === activeTabId) {
        const padded = ` ▸ ${label} `;
        cells.push(args.theme.fg("accent", args.theme.inverse(args.theme.bold(padded))));
      } else {
        const padded = `   ${label} `;
        cells.push(args.theme.bg("selectedBg", args.theme.fg("accent", padded)));
      }
    }
    return pad(cells.join(" "), width);
  }

  function renderSearchBar(width: number, hasMatches = true): string {
    const cursor = args.theme.inverse(" ");
    let text: string;
    if (search === "") {
      const placeholder = args.theme.fg("muted", "Search settings...");
      text = ` > ${cursor}${placeholder}`;
    } else {
      if (!hasMatches) {
        text = ` > ${args.theme.fg("warning", search)}${cursor}`;
      } else {
        text = ` > ${search}${cursor}`;
      }
    }
    return args.theme.bg("toolPendingBg", pad(text, width));
  }

  function renderFooter(_width: number): string[] {
    const row = focusedRow();
    let rowHints: FieldKeyHint[] = [];
    if (row) {
      const renderer = rendererFor(row.field);
      rowHints = renderer.hints(
        { field: row.field as never, value: row.value as never },
        { isEditing: row.isEditing },
      );
    }

    // Always-present hints: nav, field-reset, save, search
    const line1: FieldKeyHint[] = [];
    if (tabs.length > 0 || actionRows.length > 0) {
      line1.push({ key: "tab/shift+tab", label: "cycle" });
    }
    line1.push({ key: "↑↓", label: "move" });
    if (!row?.isEditing && row?.field.reorderable) {
      line1.push({ key: "alt+↑↓", label: "reorder" });
    }
    const anyFieldHasDefault = fields.some(
      (f) => (f as { default?: unknown }).default !== undefined,
    );
    if (anyFieldHasDefault && !row?.isEditing) {
      line1.push({ key: "ctrl+r", label: "reset field" });
      line1.push({ key: "ctrl+d", label: "reset field" });
    }
    if (isBuffered) {
      line1.push({ key: "ctrl+s", label: "save" });
    }
    if (options.enableSearch && !row?.isEditing) {
      if (search === "") {
        line1.push({ key: "type", label: "to search" });
      } else {
        line1.push({ key: "ctrl+u", label: "clear" });
      }
    }

    // Line 2: field-specific hints + dismiss
    const line2: FieldKeyHint[] = [];
    line2.push(...rowHints);
    if (confirmState) {
      line2.push({ key: "↑↓", label: "select" });
      line2.push({ key: "enter", label: "confirm" });
      line2.push({ key: "esc", label: "cancel" });
    } else if (options.enableSearch && search !== "" && !row?.isEditing) {
      line2.push({ key: "esc", label: "clear search" });
    } else if (isBuffered && isDirty()) {
      line2.push({ key: "esc", label: "confirm →" });
    } else {
      line2.push({ key: "esc", label: "close" });
    }

    const lines: string[] = [formatHintLine(line1, args.theme)];
    if (line2.length > 1 || (line2.length === 1 && line2[0]!.key !== "esc")) {
      lines.push(formatHintLine(line2, args.theme));
    }
    return lines;
  }

  function renderRow(row: InternalRow, width: number, isSelected: boolean): string {
    const labelText = row.labelText;
    // Per-field `dim` overrides the default focus-based coloring. The
    // override is binary — fields that opt in are saying "this row is
    // semantically active / inactive, color me regardless of focus".
    // Selection background still applies on top either way, so a
    // focused dimmed row stays visibly highlighted via the prefix
    // chip + selectedBg, just with a muted label.
    const dimRaw = row.field.disabled ? true : row.field.dim;
    const dimFlag = typeof dimRaw === "function" ? dimRaw() : dimRaw;
    const labelColor =
      dimFlag === true ? "muted" : dimFlag === false ? "text" : isSelected ? "text" : "muted";
    const label = args.theme.fg(labelColor, labelText);
    const renderer = rendererFor(row.field);
    const valueText = renderer.renderValue(
      { field: row.field as never, value: row.value as never },
      {
        width: Math.max(1, width - LABEL_PAD_TARGET - 4),
        selected: isSelected,
        isEditing: row.isEditing,
        ctx: fieldRenderContext,
      },
    );
    const padding = row.labelPadding;
    const depthIndent = "  ".repeat(row.field.depth ?? 0);
    const prefix = isSelected ? args.theme.fg("accent", `${depthIndent}▌ `) : `${depthIndent}  `;

    // Scope note: when in a scope tab, show where the value originates
    // from (other scope or default). E.g. "(Global: on)" or "(default: 10)".
    let note = "";
    if (useScopeTabs && activeTabId) {
      const sn = scopeNoteFor(row, activeTabId);
      if (sn) note = ` ${args.theme.fg("dim", sn)}`;
    }

    const composed = `${prefix}${label}${padding}${valueText}${note}`;
    if (isSelected) return args.theme.bg("selectedBg", pad(composed, width));
    return truncateToWidth(composed, width, "…");
  }

  function scopeNoteFor(row: InternalRow, scope: string): string | undefined {
    if (!useScopeTabs || !options.defaults) return undefined;
    const defaultValue = (options.defaults as Record<string, unknown>)[row.field.key];
    const gv = row.globalValue;
    const pv = row.projectValue;
    const format = (v: unknown): string => {
      if (v === undefined || v === null) return "unset";
      if (row.field.type === "boolean") return v ? "on" : "off";
      if (row.field.type === "number") return String(v);
      if (row.field.type === "string" || row.field.type === "text")
        return JSON.stringify(String(v));
      if (row.field.type === "enum") return String(v);
      return String(v);
    };
    if (scope === "project") {
      if (pv !== undefined) return undefined; // project has explicit value — no note needed
      if (gv !== undefined) return `(Global: ${format(gv)})`;
      return `(default: ${format(defaultValue)})`;
    }
    // Global tab
    if (gv !== undefined) return undefined; // global has explicit value
    return `(default: ${format(defaultValue)})`;
  }

  function renderBody(width: number, innerRows: number): string[] {
    const lines: string[] = [];
    if (tabs.length > 0) {
      lines.push(renderTabBar(width));
    }
    const indices = visibleRowIndices();
    if (options.enableSearch) {
      if (lines.length > 0) lines.push("");
      lines.push(renderSearchBar(width, indices.length > 0));
    }
    if (lines.length > 0) {
      lines.push("");
      lines.push(divider(width, args.theme));
    }
    const visibleListRows = Math.max(3, innerRows - lines.length - 2 - estimateDescriptionRows());
    clampSelection(visibleListRows);

    const fieldCount = indices.length;
    const slice = indices.slice(scroll, scroll + visibleListRows);
    if (slice.length === 0) {
      lines.push(args.theme.fg("muted", "  No matching settings. (press esc to clear)"));
    } else {
      if (scroll > 0) lines.push(args.theme.fg("dim", `  ↑ ${scroll} earlier`));
      for (const [visIdx, idx] of slice.entries()) {
        const realIdx = scroll + visIdx;
        const row = rows[idx]!;
        lines.push(renderRow(row, width, realIdx === fieldSelected));
      }
      const hidden = Math.max(0, fieldCount - (scroll + visibleListRows));
      if (hidden > 0) lines.push(args.theme.fg("dim", `  ↓ ${hidden} more`));
    }

    // Description for the focused field
    const focused = focusedRow();
    if (focused) {
      renderFieldDesc(lines, width, focused);
    }

    // Pad to fill remaining space (footer and actions are added at frame level)
    while (lines.length < innerRows) lines.push("");
    return lines;
  }

  function renderFieldDesc(lines: string[], width: number, focused: InternalRow): void {
    let desc = focused.field.description ?? "";
    const field = focused.field;
    if (field.type === "number") {
      const parts: string[] = [];
      if (field.values) {
        parts.push(`values: ${field.values.join(", ")}`);
      } else {
        if (typeof field.min === "number" && typeof field.max === "number") {
          parts.push(`range: ${field.min} to ${field.max}`);
        } else if (typeof field.min === "number") {
          parts.push(`min: ${field.min}`);
        } else if (typeof field.max === "number") {
          parts.push(`max: ${field.max}`);
        }
        if (field.integer) parts.push("integer only");
      }
      if (parts.length > 0) {
        const suffix = `(${parts.join(", ")})`;
        desc = desc ? `${desc} ${suffix}` : suffix;
      }
    }

    if (desc) {
      lines.push("");
      for (const line of wrapLine(desc, Math.max(1, width - 4))) {
        lines.push(args.theme.fg("muted", `  ${line}`));
      }
    }

    // valueDescriptions: per-value help text for boolean/enum/number
    let vdText: string | undefined;
    if (field.type === "boolean") {
      const vd = field.valueDescriptions;
      if (vd) {
        const key = field.value ? "on" : "off";
        vdText = vd[key as "on" | "off"];
      }
    } else if (field.type === "enum") {
      const vd = field.valueDescriptions;
      if (vd) {
        vdText = vd[field.value];
      }
    } else if (field.type === "number") {
      const vd = field.valueDescriptions;
      if (vd) {
        vdText = vd[String(field.value)];
      }
    }
    if (vdText) {
      lines.push("");
      for (const line of wrapLine(args.theme.fg("accent", vdText), Math.max(1, width - 4))) {
        lines.push(`  ${line}`);
      }
    }

    // Validation warning: show when the focused row's current value
    // violates its type constraints (enum membership, number range, etc.).
    const warning = validateFieldValue(focused.field, focused.value);
    if (warning) {
      lines.push("");
      for (const line of wrapLine(warning, Math.max(1, width - 4))) {
        lines.push(args.theme.fg("warning", `  ${line}`));
      }
    }
  }

  /** Tiny heuristic so renderBody knows roughly how much room the
   *  description block will eat. Real content is recomputed per render
   *  but we want the list to start scrolling before that math kicks in. */
  function estimateDescriptionRows(): number {
    const focused = focusedRow();
    if (!focused) return 0;
    let estimate = 0;
    if (focused.field.description) estimate = 2;
    const field = focused.field;
    if (field.type === "number") {
      if (typeof field.min === "number" || typeof field.max === "number" || field.integer) {
        estimate = Math.max(estimate, 2);
      }
    }
    // Validation warning
    const warning = validateFieldValue(focused.field, focused.value);
    if (warning) estimate = Math.max(estimate, 1);
    return estimate;
  }

  /** Handle reset/delete scope actions: call the callback and reload configs. */
  async function handleScopeAction(
    action: "reset" | "delete",
    scope: "global" | "project",
  ): Promise<void> {
    const cb = action === "reset" ? options.onResetScope : options.onDeleteScope;
    if (!cb) return;
    try {
      await cb(scope);
    } catch (err) {
      notifyError(args.ctx, err);
      return;
    }
    // Reload configs and update rows with fresh values
    if (useScopeTabs && options.configFilename) {
      const fn = options.configFilename;
      const defs = options.defaults ?? {};
      const freshGlobal = loadConfig<Record<string, unknown>>(fn, defs, {
        configDir: options.globalConfigDir ?? getExtensionsDir(),
      });
      const freshProject = loadConfig<Record<string, unknown>>(fn, defs, {
        cwd: args.ctx.cwd,
        configDir: options.globalConfigDir ?? getExtensionsDir(),
      });
      for (const rr of rows) {
        const gv = getNestedValue(freshGlobal, rr.field.key);
        rr.globalValue =
          gv !== undefined
            ? gv
            : (extractInitialValue(rr.field) ??
              (options.defaults as Record<string, unknown>)?.[rr.field.key]);
        const pv = getNestedValue(freshProject, rr.field.key);
        rr.projectValue = pv !== undefined ? pv : rr.globalValue;
      }
    }
    // Clear dirty state for the affected scope
    if (isBuffered) {
      const dk = scope === "project" ? dirtyProjectKeys : dirtyGlobalKeys;
      dk.clear();
      const iv = scope === "project" ? initialProjectValues : initialGlobalValues;
      for (const rr of rows) {
        const initVal = scope === "project" ? rr.projectValue : rr.globalValue;
        iv.set(
          rr.field.key,
          typeof initVal === "object" && initVal !== null
            ? JSON.parse(JSON.stringify(initVal))
            : initVal,
        );
      }
    }
    args.tui.requestRender();
  }

  return {
    render(width: number): string[] {
      const inner = responsiveInnerRows(args.tui.terminal.rows ?? 24, PREFERRED_INNER_ROWS, 14);
      if (submenu) {
        // Render the submenu inside the same frame so the popup chrome
        // doesn't change shape mid-flow.
        const lines = submenu.render(frameContentWidth(width));
        const opts: FrameOptions = {
          title: submenuTitle(submenuKey),
          fixedInnerRows: inner,
        };
        return frame(lines, width, args.theme, opts);
      }
      if (confirmState) {
        const lines = renderConfirmSubmenu(frameContentWidth(width));
        const title = options.title
          ? `${options.title}${isBuffered && isDirty() ? " " + args.theme.fg("accent", "● Unsaved") : ""} — Save changes?`
          : "Save changes?";
        const opts: FrameOptions = {
          title,
          fixedInnerRows: inner,
        };
        return frame(lines, width, args.theme, opts);
      }
      if (scopeActionConfirm) {
        const lines = renderScopeActionConfirm(frameContentWidth(width));
        const dialogTitle =
          scopeActionConfirm.action === "reset" ? "Reset scope?" : "Delete config?";
        const opts: FrameOptions = {
          title: options.title ? `${options.title} — ${dialogTitle}` : dialogTitle,
          fixedInnerRows: inner,
        };
        return frame(lines, width, args.theme, opts);
      }

      // Footer hints + action buttons are rendered OUTSIDE the frame
      // body truncation so they are ALWAYS visible at the bottom.
      const contentWidth = frameContentWidth(width);
      const footerRows = renderFooter(contentWidth);
      const footerSectionHeight = 1 + footerRows.length; // divider + hints
      const actionSectionHeight = actionRows.length > 0 ? 2 : 0;
      const bottomSectionHeight = footerSectionHeight + actionSectionHeight;
      const bodyInnerRows = inner - bottomSectionHeight;
      const bodyLines = renderBody(contentWidth, bodyInnerRows);

      const dirtyDot = isBuffered && isDirty() ? ` ${args.theme.fg("accent", "● Unsaved")}` : "";
      const title = options.title ? `${options.title}${dirtyDot}` : options.title;

      const frameLines = frame(bodyLines, width, args.theme, {
        title,
        fixedInnerRows: bodyInnerRows,
      });

      // Replace the bottom padding + border with the fixed sections
      const bottomBorder = frameLines.pop()!;
      const bottomPadding = frameLines.pop()!;
      const borderAccent = (s: string) => args.theme.fg("borderAccent", s);

      // Footer hint line
      const footDiv = `${borderAccent("│")}  ${args.theme.fg("dim", "─".repeat(Math.max(1, contentWidth)))}  ${borderAccent("│")}`;
      frameLines.push(footDiv);
      for (const line of footerRows) {
        const paddedLine = `  ${line}`;
        frameLines.push(
          `${borderAccent("│")}${pad(paddedLine, contentWidth + 4)}${borderAccent("│")}`,
        );
      }

      // Action buttons — side by side on one line, styled like tabs.
      // Tab/Shift+Tab cycles through them as individual stops.
      if (actionRows.length > 0) {
        const actDiv = `${borderAccent("│")}  ${args.theme.fg("dim", "─".repeat(Math.max(1, contentWidth)))}  ${borderAccent("│")}`;
        frameLines.push(actDiv);

        const cells: string[] = [];
        for (let ai = 0; ai < actionRows.length; ai++) {
          const isFocused = tabActionFocus >= tabs.length && tabActionFocus - tabs.length === ai;
          const keyHint = ai === 0 ? " [ctrl+shift+r]" : " [ctrl+shift+d]";
          const padded = ` ${actionRows[ai]!.label}${keyHint} `;
          if (isFocused) {
            cells.push(args.theme.fg("accent", args.theme.inverse(args.theme.bold(padded))));
          } else {
            cells.push(args.theme.bg("selectedBg", args.theme.fg("accent", padded)));
          }
        }
        const line = pad(cells.join(" "), contentWidth);
        frameLines.push(`${borderAccent("│")}  ${line}  ${borderAccent("│")}`);
      }

      // Restore bottom padding and border
      frameLines.push(bottomPadding);
      frameLines.push(bottomBorder);

      return frameLines;
    },
    invalidate(): void {
      submenu?.invalidate();
    },
    handleInput,
  };
}

function submenuTitle(key: string | undefined): string | undefined {
  return key ? `${key} →` : undefined;
}

function notifyError(ctx: ExtensionContext, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  try {
    ctx.ui.notify(message, "error");
  } catch {
    // Defensive: never let a bad notify call break the modal loop.
  }
}

function extractInitialValue(field: Field): unknown {
  if (field.type === "action") return undefined;
  return (field as { value: unknown }).value;
}

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
