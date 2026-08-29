import { notifyError } from "./helpers.ts";
import { updateVisibleIndices } from "./navigation.ts";
import type { BodyState, InternalRow } from "./body.ts";
import type { Field, VisibilityContext } from "./types.ts";

export interface BuildVisibilityContextReturn extends VisibilityContext {}

const INITIAL_JSON_CACHE = new WeakMap<object, string>();
const KEY_TO_ROW_CACHE = new WeakMap<
  BodyState,
  { rows: InternalRow[]; map: Map<string, InternalRow> }
>();

export function buildVisibilityContext(
  _state: BodyState,
  _field: Field,
  scope: string,
): BuildVisibilityContextReturn {
  let cache = KEY_TO_ROW_CACHE.get(_state);
  if (!cache || cache.rows !== _state.rows || cache.rows.length !== _state.rows.length) {
    const map = new Map<string, InternalRow>();
    for (let i = 0; i < _state.rows.length; i += 1) {
      const r = _state.rows[i]!;
      map.set(r.field.key, r);
    }
    cache = { rows: _state.rows, map };
    KEY_TO_ROW_CACHE.set(_state, cache);
  }
  const rowsMap: Map<string, InternalRow> = cache.map;
  return {
    get: (key: string) => rowsMap.get(key)?.value,
    scope,
  };
}

export function isDirty(state: BodyState): boolean {
  if (!state.isBuffered) return false;
  return state.dirtyKeys.size > 0;
}

export function syncDirtyState(state: BodyState, key: string, row?: InternalRow): void {
  if (!state.isBuffered) return;
  const initial = state.initialValues.get(key);
  const targetRow = row ?? state.rows.find((r: InternalRow) => r.field.key === key);
  const current = targetRow?.value;
  let isClean: boolean;
  if (typeof initial === "object" && initial !== null) {
    let initialJson = INITIAL_JSON_CACHE.get(initial);
    if (initialJson === undefined) {
      initialJson = JSON.stringify(initial);
      INITIAL_JSON_CACHE.set(initial, initialJson);
    }
    if (current === undefined) {
      isClean = initial === undefined;
    } else {
      const currentJson = JSON.stringify(current);
      isClean = currentJson === initialJson;
    }
  } else {
    isClean = current === initial;
  }
  if (isClean) {
    state.dirtyKeys.delete(key);
  } else {
    state.dirtyKeys.add(key);
  }
}

export function commitValue(state: BodyState, row: InternalRow, value: unknown): void {
  const previous = row.value;
  const key = row.field.key;

  row.value = value;
  if (state.isBuffered) {
    syncDirtyState(state, key, row);
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
            syncDirtyState(state, key, row);
          }
          notifyError(state, state.args.ctx, err);
          state.args.tui.requestRender();
        });
    }
  } catch (err) {
    row.value = previous;
    if (state.isBuffered) {
      syncDirtyState(state, key, row);
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
