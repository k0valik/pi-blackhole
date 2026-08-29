# Settings Modal

`@k0valik/pi-base/settings` provides a reusable overlay modal for editing
extension configuration. Extensions define their config as a list of
`Field` rows and hand off rendering, dirty tracking, scope selection,
and persistence to the modal.

Two extensions already use it: `pi-cache` and `pi-statusline`.

---

## Quick start

```ts
import { openSettingsModal, type Field } from "@k0valik/pi-base/settings";

const openMySettings = async (ctx: ExtensionContext) => {
  const fields: Field[] = [
    { key: "enabled", type: "boolean", label: "Enabled", value: true },
    { key: "threshold", type: "number", label: "Threshold", value: 25, min: 1, max: 100 },
  ];

  await openSettingsModal(ctx, {
    title: "My Extension",
    fields,
    onChange: (key, value) => {
      // Persist immediately (immediate mode, the default)
      saveConfig({ [key]: value });
    },
  });
};
```

`openSettingsModal` returns a `Promise` that resolves when the user closes
the modal (Escape, Ctrl+C, or outer dismissal).

> **Deprecated for config:** use `ConfigManager` for scoped config. The
> modal/frame toolkit remains the general-purpose overlay surface for
> non-config UI (pickers, selectors, action menus).

---

## Modes

### Immediate mode (default)

Every field change is persisted through `onChange` as soon as the user
commits it. This is the legacy behavior and requires no migration.

```ts
await openSettingsModal(ctx, {
  title: "My Extension",
  fields,
  onChange: (key, value) => {
    save(key, value);
  },
});
```

### Buffered mode

The modal holds edits in memory and persists only on explicit save.
This gives the user a commit boundary, dirty awareness, and commit
actions. Scope selection is handled by the caller (e.g. ConfigManager's
pre-selector), not by the modal.

```ts
await openSettingsModal(ctx, {
  title: "My Extension",
  fields,
  mode: "buffered",
  onSave: async (values) => {
    await saveScoped(values, ctx.cwd);
  },
  onCancel: () => {
    // Discard — modal closes without writing.
  },
});
```

When `mode` is `"buffered"`:

- `onChange` is optional and serves only live preview. The extension
  is responsible for not persisting in buffered mode.
- Dirty detection is modal-owned. The modal diffs current values against
  the initial snapshot internally. Extensions do not track dirty state.
- Escape or Ctrl+S opens a confirm dialog (Discard / Cancel). The caller
  decides how to persist — the modal no longer owns scope selection.
- A dirty ` ●` indicator appears in the frame title.
- Ctrl+S when clean notifies "Nothing to save."

---

## Field types

The `Field` discriminated union covers every built-in widget:

| Type        | Shape                                                              | Notes                                                      |
| ----------- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| `"boolean"` | `{ type: "boolean", value: boolean }`                              | Enter toggles                                              |
| `"enum"`    | `{ type: "enum", value: T, options: readonly T[] }`                | Enter cycles; long lists open a submenu                    |
| `"string"`  | `{ type: "string", value: string, placeholder?: string }`          | Enter edits inline                                         |
| `"number"`  | `{ type: "number", value: number, min?, max?, integer? }`          | Enter edits inline; validates on commit                    |
| `"secret"`  | `{ type: "secret", value: string }`                                | Masked display; inline edit                                |
| `"path"`    | `{ type: "path", value: string }`                                  | Same editor as string; kept distinct for future completion |
| `"action"`  | `{ type: "action", onActivate: (ctx) => void }`                    | Enter fires the callback                                   |
| `"model"`   | `{ type: "model", value: ModelValue, ... }`                        | Submenu with model picker + reasoning-effort axis          |
| `"custom"`  | `{ type: "custom", value: T, render, handleInput?, openSubmenu? }` | Escape hatch for arbitrary widgets                         |

Every variant extends `FieldBase`:

```ts
interface FieldBase {
  key: string;
  label: string;
  description?: string;
  tab?: string;
  disabled?: boolean;
  reorderable?: boolean;
  dim?: boolean | (() => boolean);
  /**
   * Optional dim suffix rendered after the row's value cell.
   * Thunk form is re-evaluated on every render (mirrors `dim`).
   */
  valueNote?: string | (() => string | undefined);
  requiresReload?: boolean; // buffered mode only
}
```

`requiresReload` is a per-field hint. When any dirty field has it set,
the confirm submenu shows "Some changes require `/reload` to take effect."

`valueNote` renders a dim suffix after the value cell — used by the config
flow for provenance annotations like `(from Global)` or `▸ effective`.

---

## Options

```ts
interface SettingsModalOptions<F extends Field = Field> {
  title?: string;
  fields: F[];
  tabs?: Tab[];
  initialTab?: string;
  enableSearch?: boolean;
  theme?: SettingsTheme;
  overlayOptions?: OverlayOptions | (() => OverlayOptions);

  // Immediate mode
  onChange?: <K extends F["key"]>(
    key: K,
    value: ValueOfField<F, K>,
    field: F,
  ) => void | Promise<void>;

  // Buffered mode
  mode?: "immediate" | "buffered";
  onSave?: (values: Record<string, unknown>) => void | Promise<void>;
  onCancel?: () => void;
  closeOnSave?: boolean;

  // Actions
  actions?: Array<{
    id: string;
    label: string;
    description?: string;
    danger?: boolean;
    disabled?: boolean | (() => boolean);
  }>;
  onAction?: (id: string) => void;
  onActiveTabChange?: (tabId: string) => void;
  onRequestExit?: () => void;

  // Reordering
  onReorder?: (info: { fieldKey: string; fromIndex: number; toIndex: number }) => void;

  // Lifecycle
  onClose?: () => void;

  /** @internal Read-only mode: no edits, no dirty tracking. */
  readOnly?: boolean;
}
```

### Buffered-mode options

| Option              | Required       | Description                                                                                                                     |
| ------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `mode`              | no             | `"buffered"` to enable. Defaults to `"immediate"`.                                                                              |
| `onSave`            | yes (buffered) | Receives the full buffer (all field values). Called only on explicit save. Scope is no longer passed here — the caller owns it. |
| `onCancel`          | no             | Called when the user selects Discard in the confirm submenu. Modal closes immediately after.                                    |
| `closeOnSave`       | no             | Close the modal automatically after a successful `onSave`. Defaults to `true`. Set to `false` when the caller wants to run      |
|                     |                | additional UI (e.g. a confirm dialog) inside `onSave`.                                                                          |
| `actions`           | no             | Footer action pills. Tab / Shift+Tab cycle through tabs then actions. Enter on an enabled action fires `onAction`.              |
| `onAction`          | no             | Called when the user presses Enter on an enabled action row.                                                                    |
| `onActiveTabChange` | no             | Called after every `activeTabId` change (not on mount).                                                                         |
| `onRequestExit`     | no             | Called when the user requests exit while dirty (Esc/Ctrl+C in buffered mode with unsaved changes). If absent, a built-in        |
|                     |                | 2-choice confirm is mounted instead.                                                                                            |

### Lifecycle callbacks

| Callback                      | When it fires                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `onChange(key, value, field)` | After every field commit (both modes). In buffered mode, this is for live preview only — do not persist.                        |
| `onSave(values)`              | After the user confirms a buffered save. Receives the full buffer. Scope is no longer passed — the caller controls persistence. |
| `onCancel()`                  | After the user selects Discard in the confirm submenu.                                                                          |
| `onClose()`                   | After the modal closes for any reason (save, discard, Escape when clean, outer dismissal). Useful for fire-and-forget cleanup.  |
| `onAction(id)`                | After the user presses Enter on an enabled action row.                                                                          |
| `onActiveTabChange(tabId)`    | After the user switches tabs (not on mount).                                                                                    |
| `onRequestExit()`             | When the user presses Esc/Ctrl+C while dirty in buffered mode. If absent, a built-in 2-choice confirm is shown.                 |

---

## Tabs

When `tabs` is non-empty, fields without an explicit `tab` id surface on
the first tab. The tab strip is rendered above the field list. Tab
switching is via Shift+Tab / Tab.

```ts
await openSettingsModal(ctx, {
  title: "My Extension",
  tabs: [
    { id: "general", label: "General" },
    { id: "advanced", label: "Advanced" },
  ],
  initialTab: "advanced",
  fields: [
    { key: "enabled", type: "boolean", label: "Enabled", tab: "general", value: true },
    { key: "timeout", type: "number", label: "Timeout", tab: "advanced", value: 30 },
  ],
  onChange: (key, value) => {
    save(key, value);
  },
});
```

---

## Search

Set `enableSearch: true` to add a fuzzy-search bar. Typing filters the
field list in real time. Backspace deletes, Ctrl+U clears.

```ts
await openSettingsModal(ctx, {
  title: "My Extension",
  fields,
  enableSearch: true,
  onChange: (key, value) => {
    save(key, value);
  },
});
```

---

## Reordering

Mark rows with `reorderable: true` to let the user reorder them with
Alt+Up / Alt+Down. The modal swaps adjacent reorderable peers and calls
`onReorder` so the extension can mirror the change into persistent state.

```ts
const fields: Field[] = [
  { key: "a", type: "boolean", label: "A", reorderable: true, value: true },
  { key: "b", type: "boolean", label: "B", reorderable: true, value: false },
];

await openSettingsModal(ctx, {
  title: "My Extension",
  fields,
  onReorder: ({ fieldKey, fromIndex, toIndex }) => {
    // Mirror the reorder into your layout array or similar
  },
});
```

Non-reorderable neighbours block the move (no skip-and-swap), so group
reorderable rows contiguously inside a tab.

---

## Scope selection

Scope selection is now handled by `ConfigManager`'s pre-selector, not by the
modal itself. The generic modal no longer has `configFilename`, `inferDefaultScope`,
`onResetScope`, `onDeleteScope`, or `scopes` options. Those are engine/flow concerns.

If the consumer wants scope context during editing, show a non-interactive
indicator in the header — the modal itself does not do this automatically.

## Tab-cycle constraint

The generic modal keeps one Tab cycle over `[tabs…, actions…]`. The **action
count must be constant across tabs** — the caller is responsible for satisfying
this. The ConfigFlow satisfies it by construction (edit mode has 0 tabs;
Display All has 2 constant actions).

## Returned component

`createSettingsModalBody` returns a `SettingsModalBodyComponent` with additional
imperative methods:

```ts
const body = createSettingsModalBody(options, { tui, theme, ctx, close });

// Mount a confirm/submenu overlay inside the frame.
body.mountOverlay(confirmComponent, "Confirm");

// Dismiss the mounted overlay.
body.dismissOverlay();

// Current active tab id (undefined when no tabs are configured).
const tabId = body.getActiveTabId();

// Replace row values in place, clear dirty state, re-snapshot initial values.
// Keys not present are left alone. No onChange fires.
body.setValues({ enabled: true });
```

## Keybindings

| Key               | Action                                                        |
| ----------------- | ------------------------------------------------------------- |
| ↑ / ↓             | Move selection                                                |
| PageUp / PageDown | Scroll by 5                                                   |
| Enter             | Commit field / Open submenu / Toggle                          |
| Esc               | Close (clean) or open confirm submenu (dirty)                 |
| Ctrl+S            | Open confirm submenu (buffered mode)                          |
| Ctrl+C            | Same as Esc                                                   |
| Tab / Shift+Tab   | Cycle tabs then actions (non-readOnly); tabs only in readOnly |
| ← / →             | In tab/action zone: step through ring (wrap);                 |
|                   | in readOnly field zone: enter action row at                   |
|                   | last/first action; from tab focus: enter action               |
|                   | row (→ first, ← last); wrap within actions only               |
| Alt+Up / Alt+Down | Reorder adjacent `reorderable` rows                           |
| Backspace         | Delete char while editing / clear search                      |
| Ctrl+U            | Clear search                                                  |

> **Removed:** the old scope-confirm submenu keybinding (`Ctrl+Shift+R/D`)
> no longer exists. Scope selection is no longer a modal-level action.

---

## Dirty tracking

In buffered mode, the modal owns dirty tracking. It diffs current field
values against the initial snapshot internally. Extensions do not track
dirty state.

- A field is dirty if its current value differs from the value at modal open.
- Dirty state clears when the user reverts a field to its original value.
- A colored ` ●` appears in the frame title when any field is dirty.
- The footer shows `ctrl+s save` when dirty, `esc close` when clean.

`onChange` in buffered mode is optional and serves only live preview.
Dirty detection does not depend on `onChange` being present.

---

## Error handling

If `onSave` throws, the modal catches the error, shows a notification
via `ctx.ui.notify`, and keeps the modal open so the user can retry or
cancel. The confirm submenu's `done()` is not called on error.

If `onChange` throws, the row value is rolled back and the error is
surfaced via notify. The modal stays open.

`onClose`, `onCancel`, and `render` errors are also caught defensively
so the modal cannot leave the terminal in a broken state.

---

## Singleton guard

`openSettingsModal` tracks whether a modal is already mounted on the
context. If a second call arrives while the first is still mounted, the
existing modal is closed before opening the new one. This prevents two
in-memory buffers racing to write.

---

## Extension wiring recipe

### 1. Config module

```ts
// config.ts
export const CONFIG_FILENAME = "my-extension-config.json";

export interface MyConfig {
  enabled: boolean;
  threshold: number;
}

export const DEFAULTS: MyConfig = {
  enabled: true,
  threshold: 25,
};

export function loadMyConfig(cwd?: string): MyConfig {
  const raw = readConfig<Record<string, unknown>>(CONFIG_FILENAME, cwd);
  return raw ? { ...DEFAULTS, ...raw } : { ...DEFAULTS };
}

export function saveMyConfig(config: MyConfig): boolean {
  return writeConfig(CONFIG_FILENAME, config);
}

export function saveMyConfigScoped(
  config: MyConfig,
  scope: "global" | "project",
  cwd: string,
): boolean {
  const dir = scope === "global" ? getExtensionsDir() : join(cwd, ".pi");
  return writeConfig(CONFIG_FILENAME, config, dir);
}
```

### 2. Entry point

```ts
// index.ts
import { openSettingsModal, type Field } from "@k0valik/pi-base/settings";
import { loadMyConfig, saveMyConfigScoped } from "./config.js";

const openMySettings = async (ctx: ExtensionContext) => {
  const current = loadMyConfig(ctx.cwd);
  const fields: Field[] = [
    { key: "enabled", type: "boolean", label: "Enabled", value: current.enabled },
    {
      key: "threshold",
      type: "number",
      label: "Threshold",
      value: current.threshold,
      min: 1,
      max: 100,
    },
  ];

  await openSettingsModal(ctx, {
    title: "@my-org/my-extension",
    fields,
    mode: "buffered",
    onSave: async (values) => {
      await saveMyConfig(values as MyConfig);
    },
  });
};

pi.registerCommand("my-extension:config", {
  description: "Open settings",
  handler: async (_args, ctx) => await openMySettings(ctx),
});
```

### 3. Config-to-Field mapping

Map each config key to a `Field` row. Primitive config types map directly:

| Config type                 | Field type  | Extra keys                |
| --------------------------- | ----------- | ------------------------- |
| `boolean`                   | `"boolean"` | —                         |
| `number`                    | `"number"`  | `min`, `max`, `integer`   |
| `string`                    | `"string"`  | `placeholder`             |
| `string` with fixed options | `"enum"`    | `options: readonly [...]` |

Every field needs: `key` (matches config property name), `type`, `label`, `value`.

---

## Diff-based save

ConfigManager uses diff-based save: only fields whose value differs from
the existing file contents are written. `DEFAULTS` define the known-key
set, not the diff baseline. On first save, all known fields are written
because the file does not yet exist. A value already present in the file
is not rewritten if it is unchanged, even if that value differs from
`DEFAULTS`. Unknown keys in the file are preserved automatically.

Example:

- Project file already exists with: `{ enabled: true, threshold: 25, extra: "hand-edited" }`
- User changes `threshold → 30` and saves
- Only `threshold` is written; `enabled` and `extra` are untouched in the project file
- If the file didn't exist yet, all known fields would be written

If no field differs from the existing file contents, no file is written at all.

When saving programmatically (e.g. toggle commands), pass the full config
object — ConfigManager computes the diff internally.

---

## Backward compatibility

`mode` defaults to `"immediate"`. Existing extensions are unaffected.
`onSave` and `onCancel` are ignored in immediate mode.

`actions`, `onAction`, `onActiveTabChange`, `onRequestExit`, `closeOnSave`,
and `readOnly` are additive — existing callers that don't use them see no
behavior change.

`onSave` no longer receives a `scope` parameter. Extensions that migrate
from the old `(values, scope)` signature should update their callbacks.

---

## Reference

- Source: `packages/pi-base/src/settings/`
- Tests: `packages/pi-base/src/settings/buffered-mode.test.ts`
- Spec: `docs/config-rework/01-architecture.md`
