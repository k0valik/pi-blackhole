/** *
 * The modal accepts a flat array of `Field`s (or, when `tabs` is set,
 * one such array per tab) and a single `onChange` callback. Every
 * built-in field is a discriminated-union variant of `Field`. Callers
 * needing more exotic widgets can drop down to the `custom` variant and
 * implement a `FieldRenderer` directly.
 *
 * Persistence is intentionally out of scope here — the caller passes
 * each field's current value at open time and decides what to do in
 * `onChange`. Re-opening the modal re-reads the values.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
  Component,
  KeybindingsManager,
  OverlayOptions,
  TUI,
} from "@earendil-works/pi-tui";

// ─────────────────────────────────────────────────────────────────────
// Visibility context for visibleWhen
// ─────────────────────────────────────────────────────────────────────

export interface VisibilityContext {
  get(key: string): unknown;
  scope: string;
}

// ─────────────────────────────────────────────────────────────────────
// Field discriminated union
// ─────────────────────────────────────────────────────────────────────

/** Common shape for every field variant. */
export interface FieldBase {
  /** Stable id; passed back as the first argument to `onChange`. */
  key: string;
  /** Left-hand label shown in the row. */
  label: string;
  /** Optional help text rendered under the row when it's focused. */
  description?: string;
  /** Optional tab id this field belongs to (when the modal uses tabs). */
  tab?: string;
  /** Disable interactions; the row still renders but Enter is a no-op. */
  disabled?: boolean;
  /** Optional default value used when resetting the field. */
  default?: unknown;
  /**
   * Opt-in to alt+↑ / alt+↓ reorder. When set, the modal swaps this
   * row with the immediate neighbour (in `visibleRowIndices` order)
   * if and only if that neighbour is also reorderable. The caller's
   * `SettingsModalOptions.onReorder` is invoked after the swap so it
   * can mirror the change into persistent state. Non-reorderable
   * neighbours block the move (no skip-and-swap), so callers should
   * group reorderable rows contiguously inside a tab.
   */
  reorderable?: boolean;
  /**
   * Visual nesting level. Rows with `depth > 0` are indented by
   * `depth * 2` spaces. Useful for grouping related fields under a
   * parent concept without a nested schema.
   */
  depth?: number;
  /**
   * Conditionally hide this field in the settings editor. The callback
   * receives a context object that allows reading sibling values and
   * the current scope.
   *
   * Hidden values persist in the config file until explicitly cleared
   * — this is purely a UI affordance, not a data filter.
   */
  visibleWhen?: (ctx: VisibilityContext) => boolean;
  /**
   * Override the row's label color. The default behaviour is
   * `selected ? "text" : "muted"` — fields opt-in here to express
   * "this row is active" (always rendered with the bright `text`
   * color) or "this row is disabled" (always muted, even when
   * focused) regardless of focus state.
   *
   * Accepts a boolean (`true` ⇒ muted, `false` ⇒ active) or a
   * thunk re-evaluated on every render so the color can track live
   * external state (e.g. a per-block visibility toggle that updates
   * via `onChange`).
   *
   * Unset means "follow default".
   */
  dim?: boolean | (() => boolean);
  /**
   * When true, changes to this field require the user to run `/reload`
   * for the new value to take effect. The modal aggregates dirty
   * `requiresReload` fields and shows a hint in the confirm prompt.
   */
  requiresReload?: boolean;
  /**
   * Optional dim suffix rendered after the row's value cell.
   * Thunk form is re-evaluated on every render (mirrors `dim`).
   */
  valueNote?: string | (() => string | undefined);
}

export interface BooleanField extends FieldBase {
  type: "boolean";
  value: boolean;
  default?: boolean;
  /** Per-value help text, keyed by "on" or "off". */
  valueDescriptions?: Partial<Record<"on" | "off", string>>;
}

export interface EnumField<T extends string = string> extends FieldBase {
  type: "enum";
  value: T;
  options: readonly T[];
  /** Long label shown in the cycle / submenu (defaults to `value`). */
  optionLabels?: Partial<Record<T, string>>;
  /**
   * When `options.length` is greater than this, Enter opens a
   * `SelectList` submenu instead of cycling. Default `4`.
   */
  cycleThreshold?: number;
  /**
   * Per-value help text shown in the description area when this
   * row is focused. Keyed by option value.
   */
  valueDescriptions?: Partial<Record<T, string>>;
  /**
   * When true, Enter always opens a filterable list submenu (even
   * for short option lists). The user can type to fuzzy-search
   * options instead of cycling through them one by one.
   * Default `false`.
   */
  search?: boolean;
  default?: T;
}

export interface StringField extends FieldBase {
  type: "string";
  value: string;
  /** Optional placeholder shown when the value is empty. */
  placeholder?: string;
  default?: string;
}

export interface TextField extends FieldBase {
  type: "text";
  value: string;
  /** Optional placeholder shown when the value is empty. */
  placeholder?: string;
  default?: string;
}

export interface NumberField extends FieldBase {
  type: "number";
  value: number;
  /** Inclusive bounds; values outside are rejected with a notify(). */
  min?: number;
  max?: number;
  /** When true, rejects non-integers. */
  integer?: boolean;
  /**
   * Step size for arrow-key cycling within the range.
   * When set, up-arrow / down-arrow increment/decrement the value by `step`
   * clamped to `[min, max]`. Mutually exclusive with `values`.
   */
  step?: number;
  /** Discrete list of valid values (mutually exclusive with min/max/integer/step). */
  values?: readonly number[];
  /** Per-value help text, keyed by stringified number. */
  valueDescriptions?: Record<string, string>;
  default?: number;
}

export interface SecretField extends FieldBase {
  type: "secret";
  value: string;
  default?: string;
}

export interface PathField extends FieldBase {
  type: "path";
  value: string;
  default?: string;
}

/**
 * Non-interactive display row. Renders a label + value cell with no edit
 * affordance — Enter does nothing, no hints, no inline editing. Used for
 * read-only telemetry/stats views and informational rows inside the modal.
 */
export interface ReadonlyField extends FieldBase {
  type: "readonly";
  /** Right-hand value cell shown on the row. */
  value: string;
  /** Optional muted hint under the row when focused. */
  hint?: string;
  /** Optional accent emphasis for the value cell (default: muted when unselected). */
  emphasis?: boolean;
}

/**
 * Non-interactive section header row. Renders a full-width dim heading with
 * no interaction — used to group consecutive read-only telemetry rows.
 */
export interface SectionField extends FieldBase {
  type: "section";
  /** Full-width heading text. */
  value: string;
}

export interface ActionField extends FieldBase {
  type: "action";
  /** Right-hand display value (defaults to `(run)`). */
  display?: string;
  /** Fired on Enter. */
  onActivate: (ctx: ExtensionContext) => void | Promise<void>;
}

/** Composite value for a model + reasoning-effort field. */
export interface ModelValue {
  /** Canonical `<provider>/<id>` string, or `""` for "session model". */
  id: string;
  /** One of pi-ai's six levels (`off|minimal|low|medium|high|xhigh`). */
  thinking?: ModelThinkingLevel;
}

/** Pre-resolved model option (skips registry discovery when provided). */
export interface ModelOption {
  /** Canonical `<provider>/<id>`, or `""` for the "session model" sentinel. */
  value: string;
  /** Human-readable label shown in the SelectList. */
  label: string;
  /** Optional concrete model — used to compute supported effort levels. */
  model?: Model<Api>;
}

export interface ModelField extends FieldBase {
  type: "model";
  value: ModelValue;
  /** Default sentinel label. Defaults to `"(session model)"`. */
  sessionLabel?: string;
  /** Override the auto-discovered list of models. */
  models?: ModelOption[];
  /** Filter the auto-discovered list (ignored when `models` is set). */
  filter?: (model: Model<Api>) => boolean;
  /** Hide the `(session model)` sentinel. Defaults to `false`. */
  hideSession?: boolean;
  /**
   * Hide the reasoning-effort axis. Useful for tools that don't have
   * a thinking concept at all (e.g. Anthropic server-side `web_search`,
   * which only takes a model id). When `true`:
   *   - the submenu only renders the model `SelectList` (no effort row);
   *   - `←/→` are not consumed;
   *   - the saved value's `thinking` is always `undefined`;
   *   - the row label drops the `· effort` suffix.
   * Defaults to `false`.
   */
  hideEffort?: boolean;
  default?: ModelValue;
}

/**
 * Escape hatch for arbitrary widgets. The modal calls `render(args)` to
 * draw the row; `handleInput(data, args)` consumes terminal input when
 * the row is focused. If `openSubmenu` is provided, Enter on the row
 * mounts the returned component full-screen-inside-the-frame; the
 * submenu calls `done(value)` to commit (or `done()` to cancel).
 */
export interface CustomField<T = unknown> extends FieldBase {
  type: "custom";
  value: T;
  /** Render the row's right-hand value cell (left part is the label). */
  render: (args: CustomFieldRenderArgs<T>) => string;
  /** Optional inline-edit input handler. Return true to consume. */
  handleInput?: (data: string, args: CustomFieldRenderArgs<T>) => boolean;
  /**
   * Optional submenu mounted on Enter. The factory receives a `done`
   * callback that commits (`done(value)`) or cancels (`done()`).
   */
  openSubmenu?: (args: CustomFieldSubmenuArgs<T>) => Component;
  /**
   * Override the auto-generated footer hints for this row. The default
   * heuristic in `customRenderer.hints` shows `enter open` when an
   * `openSubmenu` is provided and `enter edit` when only `handleInput`
   * is. Set this to advertise a different set (e.g. `space toggle`
   * when `handleInput` consumes space but Enter is a no-op) without
   * sub-classing the field renderer.
   */
  hints?: FieldKeyHint[];
}

export interface CustomFieldRenderArgs<T> {
  value: T;
  width: number;
  selected: boolean;
  theme: Theme;
}

export interface CustomFieldSubmenuArgs<T> {
  value: T;
  theme: Theme;
  tui: TUI;
  done: (newValue?: T) => void;
}

/** Discriminated union of every field variant. */
export type Field =
  | BooleanField
  | EnumField
  | StringField
  | TextField
  | NumberField
  | SecretField
  | PathField
  | ReadonlyField
  | SectionField
  | ActionField
  | ModelField
  | CustomField;

// ─────────────────────────────────────────────────────────────────────
// Renderer interface (internal, but exported for advanced callers)
// ─────────────────────────────────────────────────────────────────────

export interface FieldRenderContext {
  theme: Theme;
  tui: TUI;
  ctx: ExtensionContext;
  requestRender: () => void;
}

export interface FieldKeyHint {
  key: string;
  label: string;
}

/** Live state of a row — passed to renderers and input handlers. */
export interface FieldRow<F extends Field = Field, V = unknown> {
  field: F;
  /** Current displayed value (may be ahead of disk if onChange is async). */
  value: V;
}

/**
 * A `FieldRenderer` knows how to draw, focus, and edit one variant of
 * `Field`. Built-in renderers live in `./fields/*.ts`; custom callers
 * should use `type: "custom"` instead of implementing this interface
 * directly.
 */
export interface FieldRenderer<F extends Field = Field, V = unknown> {
  /** The discriminator this renderer handles. */
  type: F["type"];
  /** Render the right-hand value cell for one row. */
  renderValue(
    row: FieldRow<F, V>,
    args: {
      width: number;
      selected: boolean;
      isEditing: boolean;
      ctx: FieldRenderContext;
    },
  ): string;
  /** Footer-hint pieces shown when this row is focused. */
  hints(row: FieldRow<F, V>, args: { isEditing: boolean }): FieldKeyHint[];
  /**
   * Handle a key event. Return `consumed` to suppress default handling
   * (navigation, esc-close); return a `commit` value to persist; return
   * a `submenu` to mount one. Called only when the row is focused.
   */
  handleKey(
    row: FieldRow<F, V>,
    data: string,
    args: {
      isEditing: boolean;
      ctx: FieldRenderContext;
      setEditing: (v: boolean) => void;
    },
  ): FieldKeyResult<V>;
}

/**
 * Submenu factory passed back from a renderer's `handleKey`. The modal
 * supplies the `done` callback when mounting; calling `done(value)`
 * commits and unmounts, calling `done()` cancels and unmounts.
 */
export type SubmenuFactory<V> = (done: (value?: V) => void) => Component;

export interface FieldKeyResult<V> {
  consumed?: boolean;
  /** A new value to commit (modal calls onChange). */
  commit?: V;
  /** Submenu factory to mount; modal supplies the `done` callback. */
  submenu?: SubmenuFactory<V>;
}

// ─────────────────────────────────────────────────────────────────────
// Tabs and modal options
// ─────────────────────────────────────────────────────────────────────

export interface Tab {
  /** Stable id; `field.tab` matches against this. */
  id: string;
  /** Pill label shown in the tab strip. */
  label: string;
}

export interface SettingsTheme {
  /** Override the default frame title colour. Optional. */
  titleColor?: (text: string) => string;
  /** Override the focused-row background. Optional. */
  rowSelected?: (text: string) => string;
  /** Override the inline-edit value colour. Optional. */
  editingValue?: (text: string) => string;
}

export interface SettingsModalOptions<F extends Field = Field> {
  /** Title rendered in the frame's top border (e.g. `"@k0valik/pi-voice"`). */
  title?: string;
  /** Field rows. May span multiple tabs via each field's optional `tab` id. */
  fields: F[];
  /** Optional tab strip; rendered only when length ≥ 1. */
  tabs?: Tab[];
  /** Initial tab id (defaults to the first tab). */
  initialTab?: string;
  /** Show a fuzzy-search bar above the list. */
  enableSearch?: boolean;
  /** Theme overrides (mostly used for callers with fixed-palette aesthetics). */
  theme?: SettingsTheme;
  /** Override the overlay positioning (defaults: anchor center, 92% × 85%). */
  overlayOptions?: OverlayOptions | (() => OverlayOptions);
  /**
   * Called whenever a field's value changes. The modal calls this
   * synchronously after updating its own row state, so any throw here
   * is surfaced via `ctx.ui.notify` and does NOT roll back the row.
   */
  onChange?: <K extends F["key"]>(
    key: K,
    value: ValueOfField<F, K>,
    field: F,
  ) => void | Promise<void>;
  /**
   * Buffered mode: persist all edits at once on explicit save.
   * When `mode` is `"buffered"`, the modal holds edits in memory and
   * calls `onSave` only when the user confirms. `onChange` is optional
   * and serves only live preview; dirty detection is modal-owned.
   */
  mode?: "immediate" | "buffered";
  /**
   * Called when the user confirms a buffered save. Receives the
   * full buffer (all field values, including untouched defaults).
   * May be async.
   */
  onSave?: (values: Record<string, unknown>) => void | Promise<void>;
  /**
   * Called when the user discards buffered edits. The modal closes
   * immediately after.
   */
  onCancel?: () => void;
  /**
   * Close the modal automatically after a successful `onSave`.
   * Defaults to `true`. Set to `false` when the caller wants to
   * run additional UI (e.g. a confirm dialog) inside `onSave`.
   */
  closeOnSave?: boolean;
  /**
   * Called when the user presses alt+↑ / alt+↓ on a `reorderable: true`
   * row. The modal has already swapped its internal `rows` array and
   * moved focus to follow the row by the time this fires; the caller
   * just needs to mirror the change into persistent state.
   *
   * Indices are 0-based positions **within the active tab's visible
   * rows** (so they map directly to e.g. `layout.order` positions for
   * statusline-style use cases). Both `fromIndex` and `toIndex` count
   * only `reorderable: true` peers — non-reorderable rows interleaved
   * with the reorderable ones do NOT participate and do NOT shift the
   * peer index.
   */
  onReorder?: (info: {
    fieldKey: string;
    fromIndex: number;
    toIndex: number;
  }) => void;
  /**
   * Optional footer actions rendered as a pill strip below the rows.
   * Tab/Shift+Tab cycle through tabs then actions. Enter on an enabled
   * action fires `onAction`.
   */
  actions?: Array<{
    id: string;
    label: string;
    description?: string;
    danger?: boolean;
    disabled?: boolean | (() => boolean);
  }>;
  /**
   * Called when the user presses Enter on an enabled action.
   */
  onAction?: (id: string) => void;
  /**
   * Called after every `activeTabId` change (not on mount).
   */
  onActiveTabChange?: (tabId: string) => void;
  /**
   * Called when the user requests exit while dirty (Esc/Ctrl+C in
   * buffered mode with unsaved changes). If absent, a built-in
   * 2-choice confirm is mounted instead.
   */
  onRequestExit?: () => void;
  /**
   * @internal Optional dim path/location note rendered above the
   * search/fields area (e.g. resolved config file path).
   */
  pathNote?: string;
  /**
   * @internal Read-only mode: no edits, no dirty tracking, reorder
   * is a no-op. Rows render normally.
   */
  readOnly?: boolean;
  /**
   * Called once when the modal closes. Useful for fire-and-forget
   * cleanup (e.g. saving a debounced config).
   */
  onClose?: () => void;
}

/** Value type of the field with key `K` inside a union `F`. */
export type ValueOfField<F extends Field, K extends string> =
  Extract<F, { key: K }> extends { value: infer V } ? V : never;

/** Component factory shape required by `ctx.ui.custom`. */
export type SettingsModalFactory<T = void> = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: T) => void,
) => Component;

/**
 * Return type of `createSettingsModalBody`.
 */
export interface SettingsModalBodyComponent extends Component {
  /** Mount a submenu/confirm overlay inside the frame. */
  mountOverlay(c: Component, title?: string): void;
  /** Dismiss any mounted overlay. */
  dismissOverlay(): void;
  /** Current active tab id, if tabs are configured. */
  getActiveTabId(): string | undefined;
  /** Replace row values in place, clear dirty state, re-snapshot. */
  setValues(values: Record<string, unknown>): void;
}
