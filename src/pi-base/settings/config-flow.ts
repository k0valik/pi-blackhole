/**
 * Config flow — pre-selector → edit mode | display-all.
 *
 * The flow owns all config-knowledge: selector routing, scope-locked
 * buffered edit mode, read-only display-all with provenance notes,
 * and all yes/no confirms. The generic toolkit (body/frame/confirm)
 * knows nothing about config scopes.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { createConfirm } from "./confirm.ts";
import {
  createScopeSelector,
  type ScopeSelectorResult,
} from "./scope-selector.ts";
import { createSettingsModalBody } from "./body.ts";
import type { SettingsModalBodyComponent } from "./types.ts";

// ── Types ──────────────────────────────────────────────────────────────

export interface ConfigFlowParams {
  label: string;
  ctx: ExtensionContext;
  cwd: string;
  scopes: { global: boolean; project: boolean; session: boolean };
  sessionInitialized: boolean;
  sessionNote: string;
  defaults: Record<string, unknown>;
  env?: Record<string, string | EnvParser>;
  buildFields: (values: Record<string, unknown>) => Field[];
  layerValues: (
    scope: "global" | "project" | "env" | "session",
  ) => Record<string, unknown>;
  inspect: () => ConfigInspection<Record<string, unknown>>;
  scopeSources: () => ScopeSource[];
  save: (
    values: Record<string, unknown>,
    scope: "global" | "project" | "session",
  ) =>
    | { path: string; created: boolean; changed: boolean }
    | Promise<{ path: string; created: boolean; changed: boolean }>;
  resetScope: (scope: "global" | "project" | "session") => void | Promise<void>;
  deleteScope: (
    scope: "global" | "project" | "session",
  ) => void | Promise<void>;
  onSaved: (values: Record<string, unknown>) => void;
  onChange?: (key: string, value: unknown) => void;
}

// Re-export engine types the flow references directly.
export type { ConfigInspection, ScopeSource } from "../config-manager.js";
import type { ConfigInspection } from "../config-manager.js";
import type { ScopeSource } from "../config-manager.js";
import type { Field } from "../settings/types.js";
import type { EnvParser } from "../config-manager.js";

// ── Constants ──────────────────────────────────────────────────────────

const SCOPE_IDS = ["global", "project", "session"] as const;

const SCOPE_LABELS: Record<string, string> = {
  global: "Global",
  project: "Project Local",
  env: "env",
  session: "Session",
  defaults: "default",
};

const EDIT_MODE_TITLES: Record<string, string> = {
  global: "Global",
  project: "Project Local",
  session: "Session",
};

const SELECTOR_ENTRY_LABELS: Record<string, string> = {
  global: "Configure Global settings",
  project: "Configure Project local settings",
  session: "Configure Session settings",
};

// ── Helpers ────────────────────────────────────────────────────────────

function buildSelectorEntries(
  params: ConfigFlowParams,
  includeDisplayAll = true,
): Array<{ id: string; label: string; available: boolean; note?: string }> {
  const available: Record<string, boolean> = {
    global: params.scopes.global,
    project: params.scopes.project,
    session: params.scopes.session && params.sessionInitialized,
  };

  const entries = SCOPE_IDS.map((id) => {
    const ok = available[id];
    const entry: {
      id: string;
      label: string;
      available: boolean;
      note?: string;
    } = {
      id: id as string,
      label: SELECTOR_ENTRY_LABELS[id],
      available: ok,
      note: !ok
        ? id === "session"
          ? params.scopes.session
            ? "(session not initialized)"
            : "(disabled by extension)"
          : "(disabled by extension)"
        : undefined,
    };
    return entry;
  });

  if (includeDisplayAll) {
    entries.push({
      id: "display-all",
      label: "Display all settings",
      available: true,
    });
  }

  return entries;
}

function winnerLabel(winner: string): string {
  return SCOPE_LABELS[winner] ?? winner;
}

// ── Entry point ────────────────────────────────────────────────────────

export async function openConfigFlow(params: ConfigFlowParams): Promise<void> {
  const result = await openSelector(params);
  if (result.kind === "cancel") return;

  if (result.id === "display-all") {
    await openDisplayAll(params);
  } else {
    await openEditMode(params, result.id);
  }
}

// ── Selector ───────────────────────────────────────────────────────────

function openSelector(
  params: ConfigFlowParams,
  includeDisplayAll = true,
): Promise<ScopeSelectorResult> {
  const entries = buildSelectorEntries(params, includeDisplayAll);
  const { ctx } = params;

  return new Promise<ScopeSelectorResult>((resolve) => {
    // Wrap in a factory matching ctx.ui.custom<T>'s expected signature.
    const factory = (
      tui: TUI,
      theme: Theme,
      _keybindings: unknown,
      done: (result: void) => void,
    ): Component => {
      const component = createScopeSelector({
        title: params.label,
        subtitle: `Configure settings for ${params.label}`,
        entries,
        tui,
        theme,
        done(result: ScopeSelectorResult) {
          done(undefined); // signal overlay teardown to pi
          resolve(result);
        },
      });
      return component;
    };
    void ctx.ui.custom<void>(factory, {
      overlay: true,
      overlayOptions: modalOverlay(),
    });
  });
}

// ── Edit mode ──────────────────────────────────────────────────────────

interface EditHandlers {
  onChange: (key: string, value: unknown) => void;
  onSave: (
    tui: TUI,
    theme: Theme,
    done: (result: void) => void,
  ) => Promise<void> | void;
  onRequestExit: (
    tui: TUI,
    theme: Theme,
    done: (result: void) => void,
  ) => Promise<void> | void;
  onAction: (
    id: string,
    tui: TUI,
    theme: Theme,
    done: (result: void) => void,
  ) => void;
}

async function openEditMode(
  params: ConfigFlowParams,
  scope: string,
): Promise<void> {
  const values = params.layerValues(
    scope as "global" | "project" | "env" | "session",
  );
  let inspection = params.inspect();
  const fields = params.buildFields(values);

  // Shared mutable state so onChange and onSave agree on latest values.
  const currentValues: Record<string, unknown> = { ...values };
  const dirtyKeys = new Set<string>();

  function valueNote(field: Field): string | undefined {
    const key = String(field.key);
    const winner = inspection.winners[key];
    if (!winner || winner === scope) return undefined;
    if (!dirtyKeys.has(key)) return `(from ${winnerLabel(winner)})`;
    return undefined;
  }

  const scopeLabel = EDIT_MODE_TITLES[scope] ?? scope;
  const sources = params.scopeSources();
  const sourceEntry = sources.find((s) => s.scope === scope);
  // Path note for edit mode: static label for env/defaults, resolved
  // path (or pending note) for file-based scopes.
  const editPathNote =
    scope === "env"
      ? "environment variables (read-only)"
      : scope === "defaults"
        ? "built-in defaults"
        : scope === "session"
          ? (sourceEntry?.path ?? sourceEntry?.note ?? "")
          : sourceEntry?.exists && sourceEntry.path
            ? sourceEntry.path
            : (sourceEntry?.note ?? "");

  const wrappedFields = fields.map((f) => ({
    ...f,
    valueNote: () => valueNote(f),
  }));

  // Per-flow body ref so nested async confirm handlers can mount overlays.
  let activeEditBody: SettingsModalBodyComponent | undefined;

  async function saveEdit(
    tui: TUI,
    theme: Theme,
    done: (result: void) => void,
  ): Promise<void> {
    const confirmed = await new Promise<boolean>((resolve) => {
      const c = createConfirm(
        {
          message: [`Really save to ${scopeLabel}?`],
          confirmLabel: "Save",
          danger: false,
        },
        resolve,
        { tui, theme },
      );
      (activeEditBody ?? ({} as SettingsModalBodyComponent)).mountOverlay(
        c,
        `Save to ${scopeLabel}`,
      );
    });

    if (!confirmed) {
      activeEditBody?.dismissOverlay();
      return;
    }

    try {
      const res = await params.save(
        { ...currentValues },
        scope as "global" | "project" | "session",
      );
      if (res.created && scope === "project") {
        params.ctx.ui.notify(`Project config written to ${res.path}`, "info");
      }
      params.onSaved(currentValues);
      dirtyKeys.clear();
      done(undefined);
    } catch (err) {
      params.ctx.ui.notify(
        err instanceof Error ? err.message : String(err),
        "error",
      );
    }
  }

  async function discardEdit(
    tui: TUI,
    theme: Theme,
    done: (result: void) => void,
  ): Promise<void> {
    const confirmed = await new Promise<boolean>((resolve) => {
      const c = createConfirm(
        {
          message: ["Discard changes?"],
          confirmLabel: "Discard",
          danger: true,
        },
        resolve,
        { tui, theme },
      );
      (activeEditBody ?? ({} as SettingsModalBodyComponent)).mountOverlay(c);
    });

    if (confirmed) {
      done(undefined);
    } else {
      activeEditBody?.dismissOverlay();
    }
  }

  async function resetEdit(tui: TUI, theme: Theme): Promise<void> {
    const scopeLabel = EDIT_MODE_TITLES[scope] ?? scope;
    const confirmed = await new Promise<boolean>((resolve) => {
      const c = createConfirm(
        {
          message: [`Really reset ${scopeLabel} to defaults?`],
          confirmLabel: "Reset",
          danger: true,
        },
        resolve,
        { tui, theme },
      );
      (activeEditBody ?? ({} as SettingsModalBodyComponent)).mountOverlay(c);
    });

    if (!confirmed) {
      activeEditBody?.dismissOverlay();
      return;
    }

    try {
      await params.resetScope(scope as "global" | "project" | "session");
      const fresh = params.layerValues(
        scope as "global" | "project" | "env" | "session",
      );
      activeEditBody?.setValues(fresh);
      dirtyKeys.clear();
      inspection = params.inspect();
      activeEditBody?.dismissOverlay();
    } catch (err) {
      params.ctx.ui.notify(
        err instanceof Error ? err.message : String(err),
        "error",
      );
    }
  }

  async function deleteEdit(tui: TUI, theme: Theme): Promise<void> {
    const scopeLabel = EDIT_MODE_TITLES[scope] ?? scope;
    const confirmed = await new Promise<boolean>((resolve) => {
      const c = createConfirm(
        {
          message: [`Really delete the ${scopeLabel} config file?`],
          confirmLabel: "Delete",
          danger: true,
        },
        resolve,
        { tui, theme },
      );
      (activeEditBody ?? ({} as SettingsModalBodyComponent)).mountOverlay(c);
    });

    if (!confirmed) {
      activeEditBody?.dismissOverlay();
      return;
    }

    try {
      await params.deleteScope(scope as "global" | "project" | "session");
      const fresh = params.layerValues(
        scope as "global" | "project" | "env" | "session",
      );
      activeEditBody?.setValues(fresh);
      dirtyKeys.clear();
      inspection = params.inspect();
      activeEditBody?.dismissOverlay();
    } catch (err) {
      params.ctx.ui.notify(
        err instanceof Error ? err.message : String(err),
        "error",
      );
    }
  }

  const handlers: EditHandlers = {
    onChange(key, value) {
      currentValues[key] = value;
      dirtyKeys.add(key);
      params.onChange?.(key, value);
    },
    onSave(tui, theme, done) {
      return saveEdit(tui, theme, done);
    },
    onRequestExit(tui, theme, done) {
      return discardEdit(tui, theme, done);
    },
    onAction(id: string, tui: TUI, theme: Theme, done: (result: void) => void) {
      switch (id) {
        case "save":
          void saveEdit(tui, theme, done).catch((err) =>
            params.ctx.ui.notify(
              err instanceof Error ? err.message : String(err),
              "error",
            ),
          );
          break;
        case "discard":
          void discardEdit(tui, theme, done).catch((err) =>
            params.ctx.ui.notify(
              err instanceof Error ? err.message : String(err),
              "error",
            ),
          );
          break;
        case "reset":
          void resetEdit(tui, theme).catch((err) =>
            params.ctx.ui.notify(
              err instanceof Error ? err.message : String(err),
              "error",
            ),
          );
          break;
        case "delete":
          void deleteEdit(tui, theme).catch((err) =>
            params.ctx.ui.notify(
              err instanceof Error ? err.message : String(err),
              "error",
            ),
          );
          break;
      }
    },
  };

  // Use a factory wrapper so tui/theme are available to nested confirm
  // handlers and the body's close callback.
  await params.ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      const body = createSettingsModalBody(
        {
          title: `${params.label} — ${scopeLabel}`,
          fields: wrappedFields,
          mode: "buffered",
          closeOnSave: false,
          enableSearch: true,
          pathNote: editPathNote,
          actions:
            scope === "session"
              ? [
                  { id: "save", label: "Save" },
                  { id: "discard", label: "Discard" },
                  { id: "reset", label: "Reset", danger: true },
                ]
              : [
                  { id: "save", label: "Save" },
                  { id: "discard", label: "Discard" },
                  { id: "reset", label: "Reset", danger: true },
                  { id: "delete", label: "Delete", danger: true },
                ],
          onSave: () => handlers.onSave(tui, theme, done),
          onChange: handlers.onChange,
          // eslint-disable-next-line @typescript-eslint/no-misused-promises
          onRequestExit: () => handlers.onRequestExit(tui, theme, done),
          onAction: (id) => {
            void handlers.onAction(id, tui, theme, done);
          },
        },
        {
          tui,
          theme,
          ctx: params.ctx,
          close: () => done(undefined),
        },
      ) as SettingsModalBodyComponent;

      activeEditBody = body;
      return body;
    },
    { overlay: true, overlayOptions: modalOverlay() },
  );
}

async function openDisplayAll(params: ConfigFlowParams): Promise<void> {
  const inspection = params.inspect();
  const sources = params.scopeSources();

  // Tab scopes in precedence order.
  const tabDefs: Array<{ id: string; scope: string; label: string }> = [];
  if (params.scopes.global !== false) {
    tabDefs.push({ id: "global", scope: "global", label: "Global" });
  }
  if (params.scopes.project !== false) {
    tabDefs.push({ id: "project", scope: "project", label: "Project Local" });
  }

  if (params.env && Object.keys(params.env).length > 0) {
    tabDefs.push({ id: "env", scope: "env", label: "Env" });
  }
  if (params.scopes.session && params.sessionInitialized) {
    tabDefs.push({ id: "session", scope: "session", label: "Session" });
  }
  tabDefs.push({ id: "defaults", scope: "defaults", label: "Defaults" });

  // Per-tab path/location notes rendered under the subtitle.
  const tabPathNotes: Record<string, string> = {};
  for (const source of sources) {
    if (source.scope === "session") {
      tabPathNotes["session"] = source.path ?? source.note;
    } else {
      // global / project: use the resolved path when it exists, otherwise the note text
      tabPathNotes[source.scope] =
        source.exists && source.path ? source.path : source.note;
    }
  }
  // Static labels for scopes not covered by scopeSources().
  tabPathNotes["env"] = "environment variables (read-only)";
  tabPathNotes["defaults"] = "built-in defaults";

  // Pre-build field arrays per tab (same field keys, different values + notes).
  const tabFields: Record<string, Field[]> = {};
  for (const tab of tabDefs) {
    let layerVals: Record<string, unknown>;
    if (tab.scope === "defaults") {
      layerVals = { ...params.defaults };
    } else {
      layerVals = params.layerValues(
        tab.scope as "global" | "project" | "env" | "session",
      );
    }
    const raw = params.buildFields(layerVals);
    tabFields[tab.id] = raw.map((f) => ({
      ...f,
      tab: tab.id,
      valueNote: displayValueNote(f, tab.id, inspection, params.env),
    }));
  }

  let currentTabId = tabDefs[0]!.id;

  // Flatten all tab fields so the body can filter by tab id on render.
  const allFields = tabDefs.flatMap((tab) => tabFields[tab.id] ?? []);

  // Use a factory wrapper so tui/theme flow through to the body's close
  // callback and nested edit-mode open calls.
  await params.ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      // Mutable path note so onActiveTabChange can update it after mount.
      const pathNoteRef: { current: string } = {
        current: tabPathNotes[currentTabId],
      };
      const body = createSettingsModalBody(
        {
          title: params.label,
          tabs: tabDefs.map((t) => ({ id: t.id, label: t.label })),
          initialTab: currentTabId,
          fields: allFields,
          readOnly: true,
          pathNote: pathNoteRef.current,
          actions: [
            { id: "cancel", label: "Cancel" },
            { id: "edit", label: "Edit" },
          ],
          onAction(id: string) {
            switch (id) {
              case "cancel":
                queueMicrotask(() => done(undefined));
                break;
              case "edit":
                queueMicrotask(() => done(undefined));
                const isEditableScope =
                  (currentTabId === "global" && params.scopes.global) ||
                  (currentTabId === "project" && params.scopes.project) ||
                  (currentTabId === "session" && params.scopes.session);
                if (isEditableScope) {
                  void openEditMode(params, currentTabId).catch((err) =>
                    params.ctx.ui.notify(
                      err instanceof Error ? err.message : String(err),
                      "error",
                    ),
                  );
                } else {
                  void openSelector(params, false)
                    .then((result) => {
                      if (result.kind === "cancel") {
                        return openDisplayAll(params);
                      }
                      if (result.id !== "display-all") {
                        return openEditMode(params, result.id);
                      }
                      return undefined;
                    })
                    .catch((err) =>
                      params.ctx.ui.notify(
                        err instanceof Error ? err.message : String(err),
                        "error",
                      ),
                    );
                }
                break;
            }
            return undefined;
          },
          onActiveTabChange(tabId: string) {
            currentTabId = tabId;
            // Values are pre-computed per tab on each field; no setValues needed.
            // Update the path note to reflect the newly active tab.
            pathNoteRef.current = tabPathNotes[tabId] ?? "";
          },
        },
        {
          tui,
          theme,
          ctx: params.ctx,
          close: () => done(undefined),
        },
      ) as SettingsModalBodyComponent;

      return body;
    },
    {
      overlay: true,
      overlayOptions: modalOverlay(),
    },
  );
}

function displayValueNote(
  field: Field,
  tabId: string,
  inspection: ConfigInspection<Record<string, unknown>>,
  env?: Record<string, string | EnvParser>,
): string | undefined {
  const key = String(field.key);
  const winner = inspection.winners[key];

  if (tabId === "env" && env?.[key]) {
    const def = env[key];
    const envWins = winner === "env";
    if (typeof def === "string") {
      const isSet = !!process.env[def]?.trim();
      if (!isSet) return `(${def}: unset)`;
      return envWins ? `(${def}) ▸ effective` : `(${def})`;
    }
    const isSet = !!process.env[def.var]?.trim();
    if (!isSet) return `(${def.var}: unset)`;
    return envWins ? `(${def.var}) ▸ effective` : `(${def.var})`;
  }

  if (winner === tabId) return "▸ effective";

  if (winner) return `(from ${winnerLabel(winner)})`;
  return undefined;
}

// ── Overlay defaults ───────────────────────────────────────────────────

function modalOverlay(): OverlayOptions {
  return { anchor: "center", width: "92%", maxHeight: "95%" };
}
