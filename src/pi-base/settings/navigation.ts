import type { BodyState, InternalRow } from "./body.ts";
import type { Field, VisibilityContext } from "./types.ts";
import { fuzzyMatch } from "@earendil-works/pi-tui";

export function totalVisibleItems(state: BodyState): number {
  return state.cachedVisibleIndices.length;
}

export function updateVisibleIndices(
  state: BodyState,
  buildCtx: (state: BodyState, field: Field, scope: string) => VisibilityContext,
): void {
  const query = state.search.trim().toLowerCase();
  const out: number[] = [];
  for (let i = 0; i < state.rows.length; i += 1) {
    const row = state.rows[i]!;
    if (state.activeTabId !== undefined && state.tabs.length > 0) {
      const fallbackTab = state.tabs[0]!.id;
      const rowTab = row.field.tab ?? fallbackTab;
      if (rowTab !== state.activeTabId) continue;
    }
    if (row.field.visibleWhen) {
      const scope = state.activeTabId ?? "global";
      if (!row.field.visibleWhen(buildCtx(state, row.field, scope))) continue;
    }
    if (!query) {
      out.push(i);
      continue;
    }
    const fuzzy = fuzzyMatch(query, row.searchIndex);
    if (fuzzy.matches) out.push(i);
  }
  state.cachedVisibleIndices = out;
}

export function visibleRowIndices(state: BodyState): number[] {
  return state.cachedVisibleIndices;
}

export function clampSelection(state: BodyState, visibleRows: number): void {
  const count = totalVisibleItems(state);
  state.fieldSelected = Math.max(0, Math.min(state.fieldSelected, Math.max(0, count - 1)));
  if (state.fieldSelected < state.scroll) state.scroll = state.fieldSelected;
  else if (state.fieldSelected >= state.scroll + visibleRows)
    state.scroll = state.fieldSelected - visibleRows + 1;
  state.scroll = Math.max(0, Math.min(state.scroll, Math.max(0, count - visibleRows)));
}

export function focusedIndex(state: BodyState): number | undefined {
  const indices = visibleRowIndices(state);
  if (indices.length === 0) return undefined;
  const safe = Math.max(0, Math.min(state.fieldSelected, indices.length - 1));
  return indices[safe];
}

export function focusedRow(state: BodyState): InternalRow | undefined {
  const idx = focusedIndex(state);
  return idx === undefined ? undefined : state.rows[idx];
}
