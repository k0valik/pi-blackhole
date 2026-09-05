/**
 * Unit tests for the pure-logic inline-editor helpers. No TUI access,
 * matchesKey is exercised through real escape-sequence inputs that the
 * production keybindings module actually emits.
 */

import { describe, expect, it } from "vitest";
import {
  clampInlineCursor,
  codeUnitToCharIndex,
  deleteInlineRange,
  handleInlineEditInput,
  inlineCharKind,
  inlineEditChars,
  insertInlineText,
  moveInlineCursorByChars,
  moveInlineCursorWordLeft,
  moveInlineCursorWordRight,
  renderInlineEditValue,
  getInlineYankBuffer,
  setInlineYankBuffer,
  isPlainSearchInput,
  type InlineEditState,
} from "./inline-edit.ts";

const make = (buffer: string, cursor: number = buffer.length): InlineEditState => ({
  buffer,
  cursor,
});

describe("inlineEditChars", () => {
  it("decomposes ASCII", () => {
    expect(inlineEditChars("abc")).toEqual([
      { ch: "a", start: 0, end: 1 },
      { ch: "b", start: 1, end: 2 },
      { ch: "c", start: 2, end: 3 },
    ]);
  });

  it("treats surrogate pairs as one char", () => {
    // 🌍 is two code units (0xD83C 0xDF0D)
    const chars = inlineEditChars("a🌍b");
    expect(chars.length).toBe(3);
    expect(chars[1]!.ch).toBe("🌍");
    expect(chars[1]!.start).toBe(1);
    expect(chars[1]!.end).toBe(3);
  });
});

describe("clampInlineCursor", () => {
  it("clamps low", () => {
    const s = make("abc", -5);
    clampInlineCursor(s);
    expect(s.cursor).toBe(0);
  });

  it("clamps high", () => {
    const s = make("abc", 99);
    clampInlineCursor(s);
    expect(s.cursor).toBe(3);
  });
});

describe("codeUnitToCharIndex", () => {
  it("maps to the char to the right of the cursor", () => {
    const chars = inlineEditChars("a🌍b");
    expect(codeUnitToCharIndex(chars, 0)).toBe(0);
    expect(codeUnitToCharIndex(chars, 1)).toBe(1); // before 🌍
    expect(codeUnitToCharIndex(chars, 3)).toBe(2); // after 🌍, before b
    expect(codeUnitToCharIndex(chars, 4)).toBe(3);
  });
});

describe("inlineCharKind", () => {
  it("classifies whitespace, word, and punctuation", () => {
    expect(inlineCharKind(" ")).toBe("space");
    expect(inlineCharKind("\t")).toBe("space");
    expect(inlineCharKind("a")).toBe("word");
    expect(inlineCharKind("Z")).toBe("word");
    expect(inlineCharKind("9")).toBe("word");
    expect(inlineCharKind("_")).toBe("word");
    expect(inlineCharKind("-")).toBe("punct");
    expect(inlineCharKind(".")).toBe("punct");
  });
});

describe("moveInlineCursorByChars", () => {
  it("moves left and right by code-points", () => {
    const s = make("a🌍b", 4);
    moveInlineCursorByChars(s, -1);
    expect(s.cursor).toBe(3); // after 🌍
    moveInlineCursorByChars(s, -1);
    expect(s.cursor).toBe(1); // skipped the surrogate pair atomically
    moveInlineCursorByChars(s, -1);
    expect(s.cursor).toBe(0);
    moveInlineCursorByChars(s, -1);
    expect(s.cursor).toBe(0); // clamped
    moveInlineCursorByChars(s, 5);
    expect(s.cursor).toBe(4); // clamped to end
  });

  it("skips over ZWJ family emoji as a single grapheme cluster", () => {
    // 👨‍👩‍👧‍👦 is 7 code units but one grapheme cluster
    const family = "\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67\u200D\uD83D\uDC66";
    const text = `a${family}b`;
    const s = make(text, text.length);
    // cursor at end (13); press left once → should land before 'b' (12)
    moveInlineCursorByChars(s, -1);
    expect(s.cursor).toBe(12);
    // press left again → should land after 'a', before family (1)
    moveInlineCursorByChars(s, -1);
    expect(s.cursor).toBe(1);
    // press left again → should land before 'a' (0)
    moveInlineCursorByChars(s, -1);
    expect(s.cursor).toBe(0);
    // press right three times → back to end
    moveInlineCursorByChars(s, 1);
    expect(s.cursor).toBe(1);
    moveInlineCursorByChars(s, 1);
    expect(s.cursor).toBe(12);
    moveInlineCursorByChars(s, 1);
    expect(s.cursor).toBe(text.length);
  });

  it("skips over combining-mark sequences as a single grapheme cluster", () => {
    // "e\u0301" is "e" + combining acute accent (2 code units, 1 grapheme)
    const text = "e\u0301a";
    const s = make(text, text.length);
    // cursor at end (3); press left once → should land before 'a' (2)
    moveInlineCursorByChars(s, -1);
    expect(s.cursor).toBe(2);
    // press left again → should land before 'é' (0)
    moveInlineCursorByChars(s, -1);
    expect(s.cursor).toBe(0);
    // press right twice → back to end
    moveInlineCursorByChars(s, 1);
    expect(s.cursor).toBe(2);
    moveInlineCursorByChars(s, 1);
    expect(s.cursor).toBe(text.length);
  });
});

describe("word-jump", () => {
  it("jumps over identifier runs left", () => {
    const s = make("foo  bar baz", 12);
    moveInlineCursorWordLeft(s);
    expect(s.buffer.slice(s.cursor)).toBe("baz");
    moveInlineCursorWordLeft(s);
    expect(s.buffer.slice(s.cursor)).toBe("bar baz");
    moveInlineCursorWordLeft(s);
    expect(s.cursor).toBe(0);
  });

  it("jumps right past trailing whitespace", () => {
    const s = make("foo  bar", 0);
    moveInlineCursorWordRight(s);
    expect(s.cursor).toBe(3); // end of foo
    moveInlineCursorWordRight(s);
    expect(s.cursor).toBe(8); // end of bar
    moveInlineCursorWordRight(s);
    expect(s.cursor).toBe(8); // clamped
  });

  it("treats punctuation as its own class", () => {
    const s = make("a-b", 0);
    moveInlineCursorWordRight(s);
    expect(s.cursor).toBe(1); // stopped before -
    moveInlineCursorWordRight(s);
    expect(s.cursor).toBe(2); // crossed -
    moveInlineCursorWordRight(s);
    expect(s.cursor).toBe(3); // end
  });
});

describe("insertInlineText / deleteInlineRange", () => {
  it("inserts and advances", () => {
    const s = make("ac", 1);
    insertInlineText(s, "b");
    expect(s.buffer).toBe("abc");
    expect(s.cursor).toBe(2);
  });

  it("inserts past EOL is clamped", () => {
    const s = make("abc", 99);
    insertInlineText(s, "!");
    expect(s.buffer).toBe("abc!");
    expect(s.cursor).toBe(4);
  });

  it("deletes a range and lands the cursor at start", () => {
    const s = make("abcdef", 5);
    deleteInlineRange(s, 1, 4);
    expect(s.buffer).toBe("aef");
    expect(s.cursor).toBe(1);
  });

  it("clamps deletion bounds", () => {
    const s = make("abc", 0);
    deleteInlineRange(s, -10, 99);
    expect(s.buffer).toBe("");
    expect(s.cursor).toBe(0);
  });
});

describe("handleInlineEditInput", () => {
  it("inserts plain printable input", () => {
    const s = make("", 0);
    expect(handleInlineEditInput(s, "h")).toBe(true);
    expect(handleInlineEditInput(s, "i")).toBe(true);
    expect(s.buffer).toBe("hi");
    expect(s.cursor).toBe(2);
  });

  it("backspace removes the char to the left, even multi-unit", () => {
    const s = make("a🌍", 3);
    expect(handleInlineEditInput(s, "\x7f")).toBe(true); // DEL = backspace in most terminals
    expect(s.buffer).toBe("a");
    expect(s.cursor).toBe(1);
  });

  it("ctrl+h acts as backspace and removes the char to the left", () => {
    const s = make("a🌍", 3);
    expect(handleInlineEditInput(s, "\x08")).toBe(true); // ctrl+h / backspace synonym
    expect(s.buffer).toBe("a");
    expect(s.cursor).toBe(1);
  });

  it("delete removes the char to the right", () => {
    const s = make("abc", 1);
    expect(handleInlineEditInput(s, "\x1b[3~")).toBe(true); // CSI 3 ~ = delete
    expect(s.buffer).toBe("ac");
    expect(s.cursor).toBe(1);
  });

  it("ctrl+u clears the buffer", () => {
    const s = make("hello", 5);
    expect(handleInlineEditInput(s, "\x15")).toBe(true);
    expect(s.buffer).toBe("");
    expect(s.cursor).toBe(0);
  });

  it("ctrl+h acts as backspace", () => {
    const s = make("hello", 5);
    expect(handleInlineEditInput(s, "\x08")).toBe(true); // ctrl+h
    expect(s.buffer).toBe("hell");
    expect(s.cursor).toBe(4);
  });

  it("ctrl+w deletes word left/backward", () => {
    const s = make("foo bar baz", 11);
    expect(handleInlineEditInput(s, "\x17")).toBe(true); // ctrl+w
    expect(s.buffer).toBe("foo bar ");
    expect(s.cursor).toBe(8);

    const s2 = make("foo  bar", 8);
    expect(handleInlineEditInput(s2, "\x17")).toBe(true);
    expect(s2.buffer).toBe("foo  ");
    expect(s2.cursor).toBe(5);

    const s3 = make("foo", 0);
    expect(handleInlineEditInput(s3, "\x17")).toBe(true);
    expect(s3.buffer).toBe("foo");
    expect(s3.cursor).toBe(0);
  });

  it("alt+d deletes word forward/right", () => {
    const s = make("foo bar baz", 0);
    expect(handleInlineEditInput(s, "\x1bd")).toBe(true); // alt+d (ESC d)
    expect(s.buffer).toBe(" bar baz");
    expect(s.cursor).toBe(0);

    const s2 = make("foo  bar", 3);
    expect(handleInlineEditInput(s2, "\x1bd")).toBe(true);
    expect(s2.buffer).toBe("foo");
    expect(s2.cursor).toBe(3);

    const s3 = make("foo", 3);
    expect(handleInlineEditInput(s3, "\x1bd")).toBe(true);
    expect(s3.buffer).toBe("foo");
    expect(s3.cursor).toBe(3);
  });

  it("ctrl+k kills line to the end", () => {
    const s = make("hello world", 5);
    expect(handleInlineEditInput(s, "\x0b")).toBe(true); // ctrl+k
    expect(s.buffer).toBe("hello");
    expect(s.cursor).toBe(5);

    const s2 = make("hello world", 11);
    expect(handleInlineEditInput(s2, "\x0b")).toBe(true);
    expect(s2.buffer).toBe("hello world");
    expect(s2.cursor).toBe(11);
  });

  it("alt+d deletes the word forward", () => {
    const s = make("foo bar baz", 0);
    expect(handleInlineEditInput(s, "\x1bd")).toBe(true); // alt+d
    expect(s.buffer).toBe(" bar baz");
    expect(s.cursor).toBe(0);

    const s2 = make("foo bar baz", 3); // before the space of " bar baz"
    expect(handleInlineEditInput(s2, "\x1bd")).toBe(true); // skips space, deletes "bar"
    expect(s2.buffer).toBe("foo baz");
    expect(s2.cursor).toBe(3);

    const s3 = make("foo", 3);
    expect(handleInlineEditInput(s3, "\x1bd")).toBe(true); // nothing to the right
    expect(s3.buffer).toBe("foo");
    expect(s3.cursor).toBe(3);
  });

  it("home/end via ctrl+a / ctrl+e", () => {
    const s = make("abc", 1);
    expect(handleInlineEditInput(s, "\x01")).toBe(true);
    expect(s.cursor).toBe(0);
    expect(handleInlineEditInput(s, "\x05")).toBe(true);
    expect(s.cursor).toBe(3);
  });

  it("returns false for unknown sequences", () => {
    const s = make("abc", 0);
    // a non-printable ANSI sequence we don't bind
    expect(handleInlineEditInput(s, "\x1b[Z")).toBe(false);
    expect(s.buffer).toBe("abc");
    expect(s.cursor).toBe(0);
  });

  it("yank and paste with ctrl+k and ctrl+y", () => {
    const s = make("hello world", 5);
    // kill to end
    expect(handleInlineEditInput(s, "\x0b")).toBe(true); // ctrl+k
    expect(s.buffer).toBe("hello");
    expect(s.cursor).toBe(5);

    // move to start
    expect(handleInlineEditInput(s, "\x01")).toBe(true); // ctrl+a
    expect(s.cursor).toBe(0);

    // yank/paste at start
    expect(handleInlineEditInput(s, "\x19")).toBe(true); // ctrl+y
    expect(s.buffer).toBe(" worldhello");
    expect(s.cursor).toBe(6);
  });

  it("yank and paste with ctrl+w and ctrl+y", () => {
    const s = make("foo bar baz", 11);
    // kill word left ("baz")
    expect(handleInlineEditInput(s, "\x17")).toBe(true); // ctrl+w
    expect(s.buffer).toBe("foo bar ");
    expect(s.cursor).toBe(8);

    // move to start
    expect(handleInlineEditInput(s, "\x01")).toBe(true); // ctrl+a

    // yank/paste at start
    expect(handleInlineEditInput(s, "\x19")).toBe(true); // ctrl+y
    expect(s.buffer).toBe("bazfoo bar ");
    expect(s.cursor).toBe(3);
  });

  it("yank and paste with alt+d and ctrl+y", () => {
    const s = make("foo bar baz", 0);
    // kill word right ("foo")
    expect(handleInlineEditInput(s, "\x1bd")).toBe(true); // alt+d
    expect(s.buffer).toBe(" bar baz");
    expect(s.cursor).toBe(0);

    // move to end
    expect(handleInlineEditInput(s, "\x05")).toBe(true); // ctrl+e

    // yank/paste at end
    expect(handleInlineEditInput(s, "\x19")).toBe(true); // ctrl+y
    expect(s.buffer).toBe(" bar bazfoo");
    expect(s.cursor).toBe(11);
  });
});

describe("yank buffer helpers", () => {
  it("gets and sets the yank buffer directly", () => {
    setInlineYankBuffer("test-yank");
    expect(getInlineYankBuffer()).toBe("test-yank");
  });
});

describe("isPlainSearchInput", () => {
  it("accepts plain ASCII printable", () => {
    expect(isPlainSearchInput("a")).toBe(true);
    expect(isPlainSearchInput("Z")).toBe(true);
    expect(isPlainSearchInput("5")).toBe(true);
  });

  it("rejects control characters and DEL", () => {
    expect(isPlainSearchInput("\x00")).toBe(false);
    expect(isPlainSearchInput("\x1b")).toBe(false);
    expect(isPlainSearchInput("\x7f")).toBe(false);
  });

  it("rejects multi-character strings", () => {
    expect(isPlainSearchInput("ab")).toBe(false);
    expect(isPlainSearchInput("\x1b[A")).toBe(false);
  });

  it("decodes Kitty CSI-u printable sequences", () => {
    expect(isPlainSearchInput("\x1b[97u")).toBe(true);
    expect(isPlainSearchInput("\x1b[53u")).toBe(true);
  });

  it("returns false for non-printable Kitty sequences", () => {
    expect(isPlainSearchInput("\x1b")).toBe(false);
  });
});

describe("renderInlineEditValue", () => {
  it("renders the cursor as a block at the right offset", () => {
    expect(renderInlineEditValue(make("abc", 0))).toBe("█abc");
    expect(renderInlineEditValue(make("abc", 1))).toBe("a█bc");
    expect(renderInlineEditValue(make("abc", 3))).toBe("abc█");
  });

  it("clamps before rendering", () => {
    expect(renderInlineEditValue(make("abc", 99))).toBe("abc█");
  });
});
