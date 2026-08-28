/**
 * Renderer for inline-edit text fields: `string`, `number`, `secret`,
 * `path`. They share a single state machine — the only differences are:
 *
 *   - `number`  parses + validates in `commitFromBuffer`.
 *   - `secret`  masks the displayed value when not editing.
 *   - `path`    is identical to `string` today (kept distinct so future
 *               completion / validation can hang off the type without
 *               another flag).
 *
 * Editing flow:
 *   1. User presses Enter on the row → `setEditing(true)` and seed the
 *      buffer from the current value.
 *   2. Subsequent keystrokes are routed to `handleInlineEditInput`.
 *   3. Enter commits, Esc cancels, both call `setEditing(false)`.
 *   4. The modal re-reads the buffer on every render, so the user sees
 *      live feedback as they type.
 *
 * The buffer state is stored on the modal side (one InlineEditState per
 * row keyed by `field.key`) so renderers stay stateless.
 */

import { matchesKey, type Component, type SelectItem } from "@earendil-works/pi-tui";
import { SelectList } from "@earendil-works/pi-tui";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { handleInlineEditInput, renderInlineEditValue, type InlineEditState } from "../inline-edit";
import type {
  FieldKeyResult,
  FieldRenderer,
  FieldRenderContext,
  NumberField,
  PathField,
  SecretField,
  StringField,
  SubmenuFactory,
} from "../types";

/**
 * The modal stores one InlineEditState per editable row. Renderers
 * access it through this lookup, set by the modal in `FieldRenderContext`.
 *
 * We intentionally don't bake the lookup into `FieldRenderContext` to
 * keep the public type surface clean — instead, the modal mutates a
 * weak-keyed registry passed via `(ctx as any).editStates`. The
 * renderers below pull it out in a single helper to keep the cast
 * isolated.
 */
function getEditState(args: { ctx: unknown }, key: string): InlineEditState | undefined {
  const registry = (args.ctx as { editStates?: Map<string, InlineEditState> }).editStates;
  return registry?.get(key);
}

function setEditState(
  args: { ctx: unknown },
  key: string,
  state: InlineEditState | undefined,
): void {
  const registry = (args.ctx as { editStates?: Map<string, InlineEditState> }).editStates;
  if (!registry) return;
  if (state === undefined) registry.delete(key);
  else registry.set(key, state);
}

function maskedSecret(value: string): string {
  if (!value) return "(unset)";
  return "••••••";
}

function placeholderOrEmpty(
  field: StringField | PathField,
  value: string,
  dim: (s: string) => string,
): string {
  if (value) return value;
  const placeholder = (field as StringField).placeholder;
  if (placeholder) return dim(placeholder);
  return dim("(unset)");
}

// ─────────────────────────────────────────────────────────────────────
// String
// ─────────────────────────────────────────────────────────────────────

export const stringRenderer: FieldRenderer<StringField, string> = {
  type: "string",
  renderValue(row, args) {
    const dim = (s: string) => args.ctx.theme.fg("dim", s);
    if (row.field.disabled) {
      const text = placeholderOrEmpty(row.field, row.value, dim);
      return args.ctx.theme.fg("muted", text);
    }
    if (args.isEditing) {
      const state = getEditState(args, row.field.key);
      if (state) {
        return args.ctx.theme.fg("accent", renderInlineEditValue(state));
      }
    }
    const text = placeholderOrEmpty(row.field, row.value, dim);
    return args.selected ? args.ctx.theme.fg("text", text) : args.ctx.theme.fg("muted", text);
  },
  hints(row, { isEditing }) {
    if (row.field.disabled) return [];
    if (isEditing) {
      return [
        { key: "enter", label: "save" },
        { key: "esc", label: "cancel" },
        { key: "←/→", label: "move" },
      ];
    }
    return [{ key: "enter", label: "edit" }];
  },
  handleKey(row, data, args) {
    if (row.field.disabled) return {};
    return handleStringLikeKey<string>(row.field.key, row.value, data, args, (buf) => buf);
  },
};

// ─────────────────────────────────────────────────────────────────────
// Path
// ─────────────────────────────────────────────────────────────────────

export const pathRenderer: FieldRenderer<PathField, string> = {
  type: "path",
  renderValue(row, args) {
    // Reuse the string renderer's body — `StringField` and `PathField`
    // share identical render shape today; we cross the variant boundary
    // via an `unknown` cast to satisfy TS's nominal discriminator.
    return (
      stringRenderer.renderValue as unknown as FieldRenderer<PathField, string>["renderValue"]
    )(row, args);
  },
  hints(row, args) {
    return (stringRenderer.hints as unknown as FieldRenderer<PathField, string>["hints"])(
      row,
      args,
    );
  },
  handleKey(row, data, args) {
    if (row.field.disabled) return {};
    return handleStringLikeKey<string>(row.field.key, row.value, data, args, (buf) => buf);
  },
};

// ─────────────────────────────────────────────────────────────────────
// Secret
// ─────────────────────────────────────────────────────────────────────

export const secretRenderer: FieldRenderer<SecretField, string> = {
  type: "secret",
  renderValue(row, args) {
    if (row.field.disabled) {
      const display = maskedSecret(row.value);
      return args.ctx.theme.fg("muted", display);
    }
    if (args.isEditing) {
      const state = getEditState(args, row.field.key);
      if (state) {
        // Mask in place: render the buffer through the cursor block but
        // replace every non-cursor char with `•` so over-the-shoulder
        // viewers can't see the secret as it's being typed.
        const masked = "•".repeat(state.buffer.length);
        const view: { buffer: string; cursor: number } = {
          buffer: masked,
          cursor: state.cursor,
        };
        return args.ctx.theme.fg("accent", renderInlineEditValue(view as InlineEditState));
      }
    }
    const display = maskedSecret(row.value);
    return args.selected
      ? args.ctx.theme.fg("text", display)
      : args.ctx.theme.fg(row.value ? "success" : "muted", display);
  },
  hints(row, args) {
    return (stringRenderer.hints as unknown as FieldRenderer<SecretField, string>["hints"])(
      row,
      args,
    );
  },
  handleKey(row, data, args) {
    if (row.field.disabled) return {};
    return handleStringLikeKey<string>(row.field.key, row.value, data, args, (buf) => buf);
  },
};

// ─────────────────────────────────────────────────────────────────────
// Number — helpers
// ─────────────────────────────────────────────────────────────────────

function nextValue(values: readonly number[], current: number): number {
  if (values.length === 0) return current;
  const idx = values.indexOf(current);
  return values[(idx + 1 + values.length) % values.length]!;
}

function prevValue(values: readonly number[], current: number): number {
  if (values.length === 0) return current;
  const idx = values.indexOf(current);
  return values[(idx - 1 + values.length) % values.length]!;
}

function stepUp(value: number, step: number, min?: number, max?: number): number {
  const next = value + step;
  if (max !== undefined && next > max) return min ?? value;
  return next;
}

function stepDown(value: number, step: number, min?: number, max?: number): number {
  const prev = value - step;
  if (min !== undefined && prev < min) return max ?? value;
  return prev;
}

function getValueDesc(field: NumberField): string | undefined {
  return field.valueDescriptions?.[String(field.value)];
}

function makeNumberValuesSubmenu(
  values: readonly number[],
  current: number,
  _valueDesc: string | undefined,
  ctx: FieldRenderContext,
): SubmenuFactory<number> {
  return (done) => {
    const items: SelectItem[] = values.map((v) => ({
      value: String(v),
      label: String(v),
    }));
    const list = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());
    const idx = items.findIndex((i) => Number(i.value) === current);
    list.setSelectedIndex(idx >= 0 ? idx : 0);
    list.onSelect = (item) => done(Number(item.value));
    list.onCancel = () => done();

    const component: Component = {
      render(width: number): string[] {
        const lines = [...list.render(width)];
        lines.push("");
        return lines;
      },
      invalidate(): void {
        list.invalidate();
      },
      handleInput(data: string): void {
        list.handleInput(data);
        ctx.tui.requestRender();
      },
    };
    return component;
  };
}

// ─────────────────────────────────────────────────────────────────────
// Number
// ─────────────────────────────────────────────────────────────────────

export const numberRenderer: FieldRenderer<NumberField, number> = {
  type: "number",
  renderValue(row, args) {
    if (row.field.disabled) {
      const text = String(row.value);
      return args.ctx.theme.fg("muted", text);
    }
    if (args.isEditing) {
      const state = getEditState(args, row.field.key);
      if (state) {
        return args.ctx.theme.fg("accent", renderInlineEditValue(state));
      }
    }
    const text = String(row.value);
    return args.selected ? args.ctx.theme.fg("text", text) : args.ctx.theme.fg("muted", text);
  },
  hints(row, args) {
    if (row.field.disabled) return [];
    const { values, step } = row.field;
    if (values && values.length > 4) return [{ key: "enter", label: "open list" }];
    if (values && values.length > 0) {
      return [
        { key: "enter/space", label: "cycle" },
        { key: "←/→", label: "prev/next" },
      ];
    }
    if (step !== undefined) {
      return [
        { key: "enter/space", label: "edit" },
        { key: "←/→", label: "step" },
      ];
    }
    return (stringRenderer.hints as unknown as FieldRenderer<NumberField, number>["hints"])(
      row,
      args,
    );
  },
  handleKey(row, data, args) {
    if (row.field.disabled) return {};
    const { values, step } = row.field;

    // Discrete values: cycle through (like enum) or open submenu
    if (values && values.length > 0) {
      if (matchesKey(data, "enter") || matchesKey(data, "return") || data === " ") {
        if (values.length > 4) {
          return {
            consumed: true,
            submenu: makeNumberValuesSubmenu(values, row.value, getValueDesc(row.field), args.ctx),
          };
        }
        return { consumed: true, commit: nextValue(values, row.value) };
      }
      if (matchesKey(data, "left")) {
        return { consumed: true, commit: prevValue(values, row.value) };
      }
      if (matchesKey(data, "right")) {
        return { consumed: true, commit: nextValue(values, row.value) };
      }
      return {};
    }

    // Step-based: ←/→ fine-tune by step (only when not editing — while
    // editing those keys move the cursor). Everything else — Enter to
    // start editing, typing, backspace, escape — goes to the inline
    // string editor so editing mode is never a dead end.
    if (step !== undefined) {
      if (!args.isEditing) {
        if (matchesKey(data, "left")) {
          return {
            consumed: true,
            commit: stepDown(row.value, step, row.field.min, row.field.max),
          };
        }
        if (matchesKey(data, "right")) {
          return {
            consumed: true,
            commit: stepUp(row.value, step, row.field.min, row.field.max),
          };
        }
      }
      return handleStringLikeKey<number>(row.field.key, String(row.value), data, args, (buffer) => {
        const trimmed = buffer.trim();
        if (trimmed === "") throw new Error("Expected a number");
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed)) throw new Error(`Not a number: '${buffer}'`);
        if (row.field.integer && !Number.isInteger(parsed)) throw new Error("Expected an integer");
        if (typeof row.field.min === "number" && parsed < row.field.min)
          throw new Error(`Must be ≥ ${row.field.min}`);
        if (typeof row.field.max === "number" && parsed > row.field.max)
          throw new Error(`Must be ≤ ${row.field.max}`);
        return parsed;
      });
    }

    // Plain number: inline edit (current behavior)
    return handleStringLikeKey<number>(row.field.key, String(row.value), data, args, (buffer) => {
      const trimmed = buffer.trim();
      if (trimmed === "") throw new Error("Expected a number");
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) throw new Error(`Not a number: '${buffer}'`);
      if (row.field.integer && !Number.isInteger(parsed)) throw new Error("Expected an integer");
      if (typeof row.field.min === "number" && parsed < row.field.min)
        throw new Error(`Must be ≥ ${row.field.min}`);
      if (typeof row.field.max === "number" && parsed > row.field.max)
        throw new Error(`Must be ≤ ${row.field.max}`);
      if (values && !values.includes(parsed))
        throw new Error(`Must be one of: ${values.join(", ")}`);
      return parsed;
    });
  },
};

// ─────────────────────────────────────────────────────────────────────
// Shared edit-key state machine
// ─────────────────────────────────────────────────────────────────────

interface StringLikeArgs {
  isEditing: boolean;
  ctx: unknown;
  setEditing: (v: boolean) => void;
}

function handleStringLikeKey<V>(
  key: string,
  initialBuffer: string,
  data: string,
  args: StringLikeArgs,
  parse: (buffer: string) => V,
): FieldKeyResult<V> {
  // Defensive coercion: the caller may pass a non-string value (e.g.
  // an array-backed value). We coerce here so cursor/buffer arithmetic
  // always works on a plain string.
  const initialStr = String(initialBuffer);

  if (!args.isEditing) {
    if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      // Begin editing — seed the buffer from the current value.
      setEditState(args, key, {
        buffer: initialStr,
        cursor: initialStr.length,
      });
      args.setEditing(true);
      return { consumed: true };
    }
    return {};
  }

  // Editing mode: Enter commits, Esc cancels.
  if (matchesKey(data, "enter") || matchesKey(data, "return")) {
    const state = getEditState(args, key);
    if (!state) {
      args.setEditing(false);
      return { consumed: true };
    }
    try {
      const value = parse(state.buffer);
      setEditState(args, key, undefined);
      args.setEditing(false);
      return { consumed: true, commit: value };
    } catch (error) {
      // Re-throw so the modal can surface via ctx.ui.notify; keep
      // editing mode active so the user can correct the value.
      throw error;
    }
  }
  if (matchesKey(data, "escape")) {
    setEditState(args, key, undefined);
    args.setEditing(false);
    return { consumed: true };
  }

  const state = getEditState(args, key);
  if (!state) {
    // Defensive: if the registry got out of sync, fall back to a
    // fresh buffer so the user isn't stuck in editing mode with no
    // way to type.
    setEditState(args, key, { buffer: initialStr, cursor: initialStr.length });
    return { consumed: true };
  }
  if (handleInlineEditInput(state, data)) {
    return { consumed: true };
  }
  return { consumed: true }; // swallow stray keys while editing
}
