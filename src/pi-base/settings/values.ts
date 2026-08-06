import { notifyError } from "./helpers.ts";
import { updateVisibleIndices } from "./navigation.ts";
import type { BodyState, InternalRow } from "./body.ts";
import type { Field, VisibilityContext } from "./types.ts";

export interface BuildVisibilityContextReturn extends VisibilityContext {}

export function buildVisibilityContext(
  _state: BodyState,
  _field: Field,
  scope: string,
): BuildVisibilityContextReturn {
  return {
    get: (key: string) => {
      const r = _state.rows.find((rr: InternalRow) => rr.field.key === key);
      return r?.value;
    },
    scope,
  };
}

export function isDirty(state: BodyState): boolean {
  if (!state.isBuffered) return false;
  return state.dirtyKeys.size > 0;
}

export function syncDirtyState(state: BodyState, key: string): void {
  if (!state.isBuffered) return;
  const initial = state.initialValues.get(key);
  const current = state.rows.find(
    (r: InternalRow) => r.field.key === key,
  )?.value;
  const isClean =
    typeof initial === "object" && initial !== null
      ? JSON.stringify(current) === JSON.stringify(initial)
      : current === initial;
  if (isClean) {
    state.dirtyKeys.delete(key);
  } else {
    state.dirtyKeys.add(key);
  }
}

export function commitValue(
  state: BodyState,
  row: InternalRow,
  value: unknown,
): void {
  const previous = row.value;
  const key = row.field.key;

  row.value = value;
  if (state.isBuffered) {
    syncDirtyState(state, key);
  }
  updateVisibleIndices(state, buildVisibilityContext);

  try {
    const ret = state.options.onChange?.(
      row.field.key as never,
      value as never,
      row.field as never,
    );
    if (ret && typeof (ret as Promise<void>).then === "function") {
      (ret as Promise<void>)
        .then(() => {
          if (state.isBuffered) {
            state.args.tui.requestRender();
          }
        })
        .catch((err: unknown) => {
          if (row.value === value) {
            row.value = previous;
          }
          if (state.isBuffered) {
            syncDirtyState(state, key);
          }
          notifyError(state, state.args.ctx, err);
          state.args.tui.requestRender();
        });
    }
  } catch (err) {
    row.value = previous;
    if (state.isBuffered) {
      syncDirtyState(state, key);
    }
    notifyError(state, state.args.ctx, err);
    state.args.tui.requestRender();
  }
}

export function allValues(state: BodyState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of state.rows) {
    out[row.field.key] = row.value;
  }
  return out;
}
