import type { BodyState, InternalRow } from "./body.ts";
import type { Field, FieldKeyHint, FieldRenderContext } from "./types.ts";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { divider, formatHintLine, pad, wrapLine } from "./frame.ts";
import { validateFieldValue } from "./validate-field.ts";
import { visibleRowIndices, clampSelection, focusedRow } from "./navigation.ts";
import { isDirty } from "./values.ts";

export function renderTabBar(state: BodyState, width: number): string {
  if (state.tabs.length === 0) return "";
  const cells: string[] = [];
  for (const tab of state.tabs) {
    let label = tab.label;
    if (state.isBuffered) {
      const isTabDirty = Array.from(state.dirtyKeys).some((key) => {
        const row = state.rows.find((r) => r.field.key === key);
        const fallbackTab = state.tabs[0]?.id;
        const rowTab = row?.field.tab ?? fallbackTab;
        return rowTab === tab.id;
      });
      if (isTabDirty) {
        label += " ● Unsaved";
      }
    }
    if (tab.id === state.activeTabId) {
      const padded = ` ▸ ${label} `;
      cells.push(
        state.args.theme.fg(
          "accent",
          state.args.theme.inverse(state.args.theme.bold(padded)),
        ),
      );
    } else {
      const padded = `   ${label} `;
      cells.push(
        state.args.theme.bg(
          "selectedBg",
          state.args.theme.fg("accent", padded),
        ),
      );
    }
  }
  return pad(cells.join(" "), width);
}

export function renderSearchBar(
  state: BodyState,
  width: number,
  hasMatches = true,
): string {
  const cursor = state.args.theme.inverse(" ");
  let text: string;
  if (state.search === "") {
    const placeholder = state.args.theme.fg("muted", "Search settings...");
    text = ` > ${cursor}${placeholder}`;
  } else {
    if (!hasMatches) {
      text = ` > ${state.args.theme.fg("warning", state.search)}${cursor}`;
    } else {
      text = ` > ${state.search}${cursor}`;
    }
  }
  return state.args.theme.bg("toolPendingBg", pad(text, width));
}

export function renderFooter(
  state: BodyState,
  rendererFor: (field: Field) => {
    hints: (
      args: { field: Field; value: unknown },
      ctx: { isEditing: boolean },
    ) => FieldKeyHint[];
  },
  _width: number,
): string[] {
  const row = focusedRow(state);
  let rowHints: FieldKeyHint[] = [];
  if (row && row.field.type !== "section" && !state.options.readOnly) {
    const renderer = rendererFor(row.field);
    if (renderer) {
      rowHints = renderer.hints(
        { field: row.field as never, value: row.value as never },
        { isEditing: row.isEditing },
      );
    }
  }

  // Always-present hints: nav, field-reset, save, search
  const line1: FieldKeyHint[] = [];
  if (state.tabs.length > 0 || (state.options.actions?.length ?? 0) > 0) {
    line1.push({ key: "tab/shift+tab", label: "cycle" });
  }
  line1.push({ key: "↑↓", label: "move" });
  if (!state.options.readOnly && !row?.isEditing && row?.field.reorderable) {
    line1.push({ key: "alt+↑↓", label: "reorder" });
  }
  const anyFieldHasDefault = state.fields.some(
    (f) => (f as { default?: unknown }).default !== undefined,
  );
  if (anyFieldHasDefault && !state.options.readOnly && !row?.isEditing) {
    line1.push({ key: "ctrl+r", label: "reset field" });
  }
  // In readOnly mode with tabs+actions, advertise arrow navigation
  // between the tab bar and the action row so users know ←/→ reach
  // Cancel/Edit without guessing.
  if (
    state.options.readOnly &&
    state.tabs.length > 0 &&
    (state.options.actions?.length ?? 0) > 0
  ) {
    line1.push({ key: "← →", label: "navigate" });
  }
  if (state.isBuffered) {
    line1.push({ key: "ctrl+s", label: "save" });
  }
  if (state.options.enableSearch && !row?.isEditing) {
    if (state.search === "") {
      line1.push({ key: "type", label: "to search" });
    } else {
      line1.push({ key: "ctrl+u", label: "clear" });
    }
  }

  // Line 2: field-specific hints + dismiss
  const line2: FieldKeyHint[] = [];
  line2.push(...rowHints);
  if (state.confirm) {
    line2.push({ key: "↑↓", label: "select" });
    line2.push({ key: "enter/space", label: "confirm" });
    line2.push({ key: "esc", label: "cancel" });
  } else if (
    state.options.enableSearch &&
    state.search !== "" &&
    !row?.isEditing
  ) {
    line2.push({ key: "esc", label: "clear search" });
  } else if (state.isBuffered && isDirty(state)) {
    line2.push({ key: "esc", label: "confirm →" });
  } else {
    line2.push({ key: "esc", label: "close" });
  }

  const lines: string[] = [formatHintLine(line1, state.args.theme)];
  if (line2.length > 1 || (line2.length === 1 && line2[0]!.key !== "esc")) {
    lines.push(formatHintLine(line2, state.args.theme));
  }
  return lines;
}

export function renderRow(
  state: BodyState,
  rendererFor: (field: Field) => {
    renderValue: (
      args: { field: Field; value: unknown },
      ctx: {
        width: number;
        selected: boolean;
        isEditing: boolean;
        ctx: FieldRenderContext & { editStates: Map<string, unknown> };
      },
    ) => string;
  },
  fieldRenderContext: FieldRenderContext & { editStates: Map<string, unknown> },
  row: InternalRow,
  width: number,
  isSelected: boolean,
): string {
  // Section rows: full-width dim heading — no label/value split.
  if (row.field.type === "section") {
    const title = (row.field as { value: string }).value;
    const prefix = isSelected ? state.args.theme.fg("accent", "▌ ") : "  ";
    const composed = `${prefix}${state.args.theme.fg("dim", title)}`;
    if (isSelected)
      return state.args.theme.bg("selectedBg", pad(composed, width));
    return truncateToWidth(composed, width, "…");
  }

  // Responsive label width: grow with terminal width so labels and
  // value cells both expand on wide terminals instead of being
  // stuck at a fixed 28-col budget. Narrow terminals still get a
  // usable 28-col floor so long names truncate gracefully.
  const labelAlloc = Math.min(55, Math.max(28, Math.floor(width * 0.5)));
  const labelText = truncateToWidth(row.field.label, labelAlloc, "…");
  const labelPadding = " ".repeat(
    Math.max(1, labelAlloc - visibleWidth(labelText)),
  );
  const valueWidth = Math.max(1, width - labelAlloc - 4);

  const dimRaw = row.field.disabled ? true : row.field.dim;
  const dimFlag = typeof dimRaw === "function" ? dimRaw() : dimRaw;
  const labelColor =
    dimFlag === true
      ? "muted"
      : dimFlag === false
        ? "text"
        : isSelected
          ? "text"
          : "muted";
  const label = state.args.theme.fg(labelColor, labelText);
  const renderer = rendererFor(row.field);
  const valueText = renderer.renderValue(
    { field: row.field as never, value: row.value as never },
    {
      width: valueWidth,
      selected: isSelected,
      isEditing: row.isEditing,
      ctx: fieldRenderContext,
    },
  );
  const padding = labelPadding;
  const depthIndent = "  ".repeat(row.field.depth ?? 0);
  const prefix = isSelected
    ? state.args.theme.fg("accent", `${depthIndent}▌ `)
    : `${depthIndent}  `;

  // Provenance note: show the resolved value's origin when the
  // field is not the current layer's winner. E.g. "(from default)".
  let note = "";
  const rawValueNote = row.field.valueNote;
  if (rawValueNote) {
    const resolved =
      typeof rawValueNote === "function" ? rawValueNote() : rawValueNote;
    if (resolved) note += ` ${state.args.theme.fg("dim", resolved)}`;
  }

  const composed = `${prefix}${label}${padding}${valueText}${note}`;
  if (isSelected)
    return state.args.theme.bg("selectedBg", pad(composed, width));
  return truncateToWidth(composed, width, "…");
}

export function renderBody(
  state: BodyState,
  rendererFor: (field: Field) => {
    renderValue: (
      args: { field: Field; value: unknown },
      ctx: {
        width: number;
        selected: boolean;
        isEditing: boolean;
        ctx: FieldRenderContext & { editStates: Map<string, unknown> };
      },
    ) => string;
  },
  fieldRenderContext: FieldRenderContext & { editStates: Map<string, unknown> },
  width: number,
  innerRows: number,
): string[] {
  const lines: string[] = [];
  if (state.tabs.length > 0) {
    lines.push(renderTabBar(state, width));
  }
  const indices = visibleRowIndices(state);
  if (state.options.enableSearch) {
    if (lines.length > 0) lines.push("");
    lines.push(renderSearchBar(state, width, indices.length > 0));
  }
  if (lines.length > 0) {
    lines.push("");
    lines.push(divider(width, state.args.theme));
  }

  // Static path/location note between header and field rows
  const pathNote = state.pathNoteRef.current ?? state.pathNote;
  if (pathNote) {
    lines.push(
      state.args.theme.fg("dim", truncateToWidth(pathNote, width, "…")),
    );
  }

  const visibleListRows = Math.max(
    3,
    innerRows - lines.length - 2 - estimateDescriptionRows(state),
  );
  clampSelection(state, visibleListRows);

  const fieldCount = indices.length;
  const slice = indices.slice(state.scroll, state.scroll + visibleListRows);
  if (slice.length === 0) {
    lines.push(
      state.args.theme.fg(
        "muted",
        "  No matching settings. (press esc to clear)",
      ),
    );
  } else {
    if (state.scroll > 0)
      lines.push(state.args.theme.fg("dim", `  ↑ ${state.scroll} earlier`));
    for (const [visIdx, idx] of slice.entries()) {
      const realIdx = state.scroll + visIdx;
      const row = state.rows[idx]!;
      lines.push(
        renderRow(
          state,
          rendererFor,
          fieldRenderContext,
          row,
          width,
          realIdx === state.fieldSelected,
        ),
      );
    }
    const hidden = Math.max(0, fieldCount - (state.scroll + visibleListRows));
    if (hidden > 0)
      lines.push(state.args.theme.fg("dim", `  ↓ ${hidden} more`));
  }

  // Description for the focused field
  const focused = focusedRow(state);
  if (focused) {
    renderFieldDesc(state, lines, width, focused);
  }

  // Pad to fill remaining space (footer and actions are added at frame level)
  while (lines.length < innerRows) lines.push("");
  return lines;
}

export function renderFieldDesc(
  state: BodyState,
  lines: string[],
  width: number,
  focused: InternalRow,
): void {
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
      lines.push(state.args.theme.fg("muted", `  ${line}`));
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
    for (const line of wrapLine(
      state.args.theme.fg("accent", vdText),
      Math.max(1, width - 4),
    )) {
      lines.push(`  ${line}`);
    }
  }

  // Validation warning: show when the focused row's current value
  // violates its type constraints (enum membership, number range, etc.).
  const warning = validateFieldValue(focused.field, focused.value);
  if (warning) {
    lines.push("");
    for (const line of wrapLine(warning, Math.max(1, width - 4))) {
      lines.push(state.args.theme.fg("warning", `  ${line}`));
    }
  }
}

/** Tiny heuristic so renderBody knows roughly how much room the
 *  description block will eat. Real content is recomputed per render
 *  but we want the list to start scrolling before that math kicks in. */
export function estimateDescriptionRows(state: BodyState): number {
  const focused = focusedRow(state);
  if (!focused) return 0;
  let estimate = 0;
  if (focused.field.description) estimate = 2;
  const field = focused.field;
  if (field.type === "number") {
    if (
      typeof field.min === "number" ||
      typeof field.max === "number" ||
      field.integer
    ) {
      estimate = Math.max(estimate, 2);
    }
  }
  // Validation warning
  const warning = validateFieldValue(focused.field, focused.value);
  if (warning) estimate = Math.max(estimate, 1);
  return estimate;
}
