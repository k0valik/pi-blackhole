/**
 * Inline string-editor state machine for single-line value editing inside
 * settings rows.
 *
 * This file is
 * **pure logic** — no terminal access, no theme, no rendering — so it can
 * be exercised in `bun test` / `vitest` without a TUI.
 *
 * Key shape: a tiny `{ buffer, cursor }` struct mutated in place by the
 * helper functions. `cursor` is a **code-unit** index into `buffer` (so
 * `buffer.slice(0, cursor)` is always safe), but every cursor-moving
 * helper internally walks **code points** so multi-unit characters
 * (CJK, emoji, regional indicators) move atomically — pressing `←` once
 * over a 🌍 jumps two code units, not one.
 *
 * Word-jump uses the same three-class scheme as most readline-derived
 * editors:
 *   - `space`: `\s` (whitespace);
 *   - `word`:  `[A-Za-z0-9_]` (identifier-ish);
 *   - `punct`: everything else.
 *
 * Tabs / hard-newlines are intentionally not special-cased — settings
 * values are single-line strings, and any `\n` arriving from terminal
 * input would be the wrong kind of input to this editor anyway.
 */

import { matchesKey, decodeKittyPrintable } from "@earendil-works/pi-tui";

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Shared yank buffer for storing killed text. */
let yankBuffer = "";

/** Retrieve the current content of the yank buffer. */
export function getInlineYankBuffer(): string {
  return yankBuffer;
}

/** Set the content of the yank buffer. */
export function setInlineYankBuffer(val: string): void {
  yankBuffer = val;
}

/** Mutable cursor state. `cursor` is a code-unit offset into `buffer`. */
export interface InlineEditState {
  buffer: string;
  cursor: number;
}

interface InlineEditChar {
  ch: string;
  /** Inclusive code-unit start of this char in the source buffer. */
  start: number;
  /** Exclusive code-unit end (==start of the next char). */
  end: number;
}

/**
 * Decompose `text` into its sequence of grapheme clusters with their
 * code-unit ranges. Uses `Intl.Segmenter` so multi-code-unit clusters
 * (ZWJ emoji, combining-mark sequences, etc.) move as a single unit.
 */
export function inlineEditChars(text: string): InlineEditChar[] {
  const out: InlineEditChar[] = [];
  for (const { segment, index } of GRAPHEME_SEGMENTER.segment(text)) {
    out.push({ ch: segment, start: index, end: index + segment.length });
  }
  return out;
}

/** Force `cursor` back into `[0, buffer.length]` after a buffer mutation. */
export function clampInlineCursor(editing: InlineEditState): void {
  editing.cursor = Math.max(0, Math.min(editing.cursor, editing.buffer.length));
}

/**
 * Convert a code-unit offset into the index of the char immediately to
 * the right of the cursor. A cursor sitting on a char boundary returns
 * the index of the char it is just before. A cursor past the end returns
 * `chars.length`.
 */
export function codeUnitToCharIndex(chars: InlineEditChar[], cursor: number): number {
  let index = 0;
  while (index < chars.length && chars[index]!.end <= cursor) index += 1;
  return index;
}

/** Inverse of `codeUnitToCharIndex`. */
export function charIndexToCodeUnit(
  chars: InlineEditChar[],
  index: number,
  textLength: number,
): number {
  if (index <= 0) return 0;
  if (index >= chars.length) return textLength;
  return chars[index]!.start;
}

/** Three-class word/word-boundary classifier used by word-jump helpers. */
export function inlineCharKind(ch: string): "space" | "word" | "punct" {
  if (/\s/u.test(ch)) return "space";
  if (/[A-Za-z0-9_]/.test(ch)) return "word";
  return "punct";
}

/** Move the cursor by `delta` code-points (negative = left). */
export function moveInlineCursorByChars(editing: InlineEditState, delta: number): void {
  const chars = inlineEditChars(editing.buffer);
  const index = codeUnitToCharIndex(chars, editing.cursor);
  editing.cursor = charIndexToCodeUnit(chars, index + delta, editing.buffer.length);
}

/** Skip whitespace then a contiguous run of the same char-kind to the left. */
export function moveInlineCursorWordLeft(editing: InlineEditState): void {
  const chars = inlineEditChars(editing.buffer);
  let index = codeUnitToCharIndex(chars, editing.cursor);
  while (index > 0 && inlineCharKind(chars[index - 1]!.ch) === "space") index -= 1;
  if (index <= 0) {
    editing.cursor = 0;
    return;
  }
  const kind = inlineCharKind(chars[index - 1]!.ch);
  while (index > 0 && inlineCharKind(chars[index - 1]!.ch) === kind) index -= 1;
  editing.cursor = charIndexToCodeUnit(chars, index, editing.buffer.length);
}

/** Skip whitespace then a contiguous run of the same char-kind to the right. */
export function moveInlineCursorWordRight(editing: InlineEditState): void {
  const chars = inlineEditChars(editing.buffer);
  let index = codeUnitToCharIndex(chars, editing.cursor);
  while (index < chars.length && inlineCharKind(chars[index]!.ch) === "space") index += 1;
  if (index >= chars.length) {
    editing.cursor = editing.buffer.length;
    return;
  }
  const kind = inlineCharKind(chars[index]!.ch);
  while (index < chars.length && inlineCharKind(chars[index]!.ch) === kind) index += 1;
  editing.cursor = charIndexToCodeUnit(chars, index, editing.buffer.length);
}

/** Insert `text` at the cursor and advance past it. */
export function insertInlineText(editing: InlineEditState, text: string): void {
  clampInlineCursor(editing);
  editing.buffer = `${editing.buffer.slice(0, editing.cursor)}${text}${editing.buffer.slice(editing.cursor)}`;
  editing.cursor += text.length;
}

/** Delete the half-open `[start, end)` code-unit range; cursor lands at `start`. */
export function deleteInlineRange(editing: InlineEditState, start: number, end: number): void {
  const safeStart = Math.max(0, Math.min(start, editing.buffer.length));
  const safeEnd = Math.max(safeStart, Math.min(end, editing.buffer.length));
  editing.buffer = `${editing.buffer.slice(0, safeStart)}${editing.buffer.slice(safeEnd)}`;
  editing.cursor = safeStart;
}

/** Heuristic: is `data` a single, plain printable input character? */
export function isPlainSearchInput(data: string): boolean {
  // Kitty terminals report printable characters as CSI-u sequences
  // (e.g. "5" arrives as \x1b[53u). Decode them so typing works there.
  const decoded = decodeKittyPrintable(data) ?? data;
  return decoded.length === 1 && decoded >= " " && decoded !== "\x7f";
}

/**
 * Dispatch a raw terminal input string to the editor. Returns true when
 * the input was consumed (caller should re-render); false when it didn't
 * match any inline-edit shortcut (caller may handle it as a hot-key).
 */
export function handleInlineEditInput(editing: InlineEditState, data: string): boolean {
  clampInlineCursor(editing);
  if (matchesKey(data, "left") || matchesKey(data, "ctrl+b")) {
    moveInlineCursorByChars(editing, -1);
    return true;
  }
  if (matchesKey(data, "right") || matchesKey(data, "ctrl+f")) {
    moveInlineCursorByChars(editing, 1);
    return true;
  }
  if (matchesKey(data, "alt+left") || matchesKey(data, "ctrl+left") || matchesKey(data, "alt+b")) {
    moveInlineCursorWordLeft(editing);
    return true;
  }
  if (
    matchesKey(data, "alt+right") ||
    matchesKey(data, "ctrl+right") ||
    matchesKey(data, "alt+f")
  ) {
    moveInlineCursorWordRight(editing);
    return true;
  }
  if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) {
    editing.cursor = 0;
    return true;
  }
  if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) {
    editing.cursor = editing.buffer.length;
    return true;
  }
  if (matchesKey(data, "backspace") || matchesKey(data, "ctrl+h")) {
    const before = editing.cursor;
    moveInlineCursorByChars(editing, -1);
    deleteInlineRange(editing, editing.cursor, before);
    return true;
  }
  if (matchesKey(data, "delete")) {
    const start = editing.cursor;
    moveInlineCursorByChars(editing, 1);
    deleteInlineRange(editing, start, editing.cursor);
    return true;
  }
  if (matchesKey(data, "ctrl+u")) {
    editing.buffer = "";
    editing.cursor = 0;
    return true;
  }
  if (matchesKey(data, "ctrl+w")) {
    const current = editing.cursor;
    moveInlineCursorWordLeft(editing);
    const target = editing.cursor;
    const killedText = editing.buffer.slice(target, current);
    if (killedText) {
      yankBuffer = killedText;
    }
    deleteInlineRange(editing, target, current);
    return true;
  }
  if (matchesKey(data, "alt+d")) {
    const current = editing.cursor;
    moveInlineCursorWordRight(editing);
    const target = editing.cursor;
    const killedText = editing.buffer.slice(current, target);
    if (killedText) {
      yankBuffer = killedText;
    }
    deleteInlineRange(editing, current, target);
    return true;
  }
  if (matchesKey(data, "ctrl+k")) {
    const killedText = editing.buffer.slice(editing.cursor);
    if (killedText) {
      yankBuffer = killedText;
    }
    deleteInlineRange(editing, editing.cursor, editing.buffer.length);
    return true;
  }
  if (matchesKey(data, "ctrl+y")) {
    if (yankBuffer) {
      insertInlineText(editing, yankBuffer);
    }
    return true;
  }
  if (isPlainSearchInput(data)) {
    // Kitty terminals deliver printable chars as CSI-u sequences —
    // decode them so the decoded char (not the raw escape bytes) is
    // inserted into the buffer.
    const decoded = decodeKittyPrintable(data) ?? data;
    insertInlineText(editing, decoded);
    return true;
  }
  return false;
}

/**
 * Render the buffer with a `█` block at the cursor position. Suitable
 * for embedding in a one-line settings row.
 */
export function renderInlineEditValue(editing: InlineEditState): string {
  clampInlineCursor(editing);
  return `${editing.buffer.slice(0, editing.cursor)}█${editing.buffer.slice(editing.cursor)}`;
}

/**
 * Word-deletion helper to delete a word backward from the end of a string.
 */
export function deleteWordBackward(text: string): string {
  let i = text.length;
  while (i > 0 && /\s/.test(text[i - 1]!)) {
    i--;
  }
  if (i === 0) return "";
  const charKind = (ch: string) => {
    if (/\s/.test(ch)) return "space";
    if (/[A-Za-z0-9_]/.test(ch)) return "word";
    return "punct";
  };
  const kind = charKind(text[i - 1]!);
  while (i > 0 && charKind(text[i - 1]!) === kind) {
    i--;
  }
  return text.slice(0, i);
}
