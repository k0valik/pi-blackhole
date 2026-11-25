import { describe, expect, it, vi } from "vitest";
import { Editor, type EditorTheme } from "../src/ui/editor.js";
import { visibleWidth } from "../src/ui/ansi-text.js";

const theme: EditorTheme = { borderColor: (text) => text };

function makeEditor(rows = 24, columns = 80): Editor {
  const editor = new Editor({ terminal: { rows, columns }, requestRender: () => {} }, theme);
  editor.focused = true;
  return editor;
}

/** Visual lines the editor paints for the current content. */
function painted(editor: Editor, width = 60): string[] {
  return editor.render(width);
}

describe("ui/editor — text model", () => {
  it("round-trips setText/getText and places the cursor at the end", () => {
    const editor = makeEditor();
    editor.setText("hello");
    expect(editor.getText()).toBe("hello");
    editor.handleInput("x");
    expect(editor.getText()).toBe("hellox");
  });

  it("normalizes CRLF and lone CR to newlines when setting text", () => {
    const editor = makeEditor();
    editor.setText("a\r\nb\rc");
    expect(editor.getText()).toBe("a\nb\nc");
  });

  it("keeps the text after the cursor when inserting mid-line", () => {
    const editor = makeEditor();
    editor.setText("ac");
    editor.handleInput("\x1b[D"); // left
    editor.handleInput("b");
    expect(editor.getText()).toBe("abc");
  });

  it("keeps the tail of the original line when a newline is inserted mid-line", () => {
    const editor = makeEditor();
    editor.setText("ab");
    editor.handleInput("\x1b[D"); // left, cursor between a and b
    editor.disableSubmit = true;
    editor.handleInput("\r");
    expect(editor.getText()).toBe("a\nb");
  });

  it("joins the current line into the previous one on backspace at column 0", () => {
    const editor = makeEditor();
    editor.setText("ab\ncd");
    editor.handleInput("\x1b[D"); // left (col 1 of "cd")
    editor.handleInput("\x1b[D"); // left (col 0 of "cd")
    editor.handleInput("\x7f"); // backspace
    expect(editor.getText()).toBe("abcd");
  });

  it("deletes the word before the cursor on ctrl+w", () => {
    const editor = makeEditor();
    editor.setText("hello world");
    editor.handleInput("\x17"); // ctrl+w
    expect(editor.getText()).toBe("hello ");
  });

  it("inserts a hard break instead of submitting when disableSubmit is set", () => {
    const editor = makeEditor();
    const onSubmit = vi.fn();
    editor.onSubmit = onSubmit;
    editor.disableSubmit = true;
    editor.setText("one");
    editor.handleInput("\r");
    expect(editor.getText()).toBe("one\n");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onSubmit without mutating the text when submit is allowed", () => {
    const editor = makeEditor();
    const onSubmit = vi.fn();
    editor.onSubmit = onSubmit;
    editor.setText("one");
    editor.handleInput("\r");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(editor.getText()).toBe("one");
  });

  it("reports the current text through onChange on every edit", () => {
    const editor = makeEditor();
    const onChange = vi.fn();
    editor.onChange = onChange;
    editor.setText("seed");
    expect(onChange).not.toHaveBeenCalled();
    editor.handleInput("!");
    expect(onChange).toHaveBeenLastCalledWith("seed!");
  });
});

describe("ui/editor — cursor movement", () => {
  it("wraps left past column 0 onto the end of the previous line", () => {
    const editor = makeEditor();
    editor.setText("ab\ncd");
    editor.handleInput("\x1b[D"); // left -> col 1 of "cd"
    editor.handleInput("\x1b[D"); // left -> col 0 of "cd"
    editor.handleInput("\x1b[D"); // left -> end of "ab"
    editor.handleInput("X");
    expect(editor.getText()).toBe("abX\ncd");
  });

  it("wraps right past the end of a line onto the next line", () => {
    const editor = makeEditor();
    editor.setText("ab\ncd");
    editor.handleInput("\x1b[D"); // left -> col 1 of "cd"
    editor.handleInput("\x1b[D"); // left -> col 0 of "cd"
    editor.handleInput("\x1b[D"); // left -> end of "ab"
    editor.handleInput("\x1b[C"); // right -> col 0 of "cd"
    editor.handleInput("X");
    expect(editor.getText()).toBe("ab\nXcd");
  });

  it("keeps the preferred column when moving vertically across lines of different length", () => {
    const editor = makeEditor();
    editor.setText("abcdef\nx\nabcdef");
    editor.handleInput("\x1bOA"); // up from end of last line -> end of middle line
    editor.handleInput("\x1bOA"); // up -> end of first line keeps preferred column
    editor.handleInput("Y");
    expect(editor.getText()).toContain("Y");
    expect(editor.getText().split("\n")[0]).toBe("abcdefY");
  });

  it("ignores control sequences it does not understand", () => {
    const editor = makeEditor();
    editor.setText("keep");
    editor.handleInput("\x1b[99;5u");
    expect(editor.getText()).toBe("keep");
  });
});

describe("ui/editor — rendering", () => {
  it("paints every visible line within the requested width", () => {
    const editor = makeEditor();
    editor.setText("the quick brown fox jumps over the lazy dog and keeps running further on");
    for (const line of painted(editor, 40)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  it("renders one line per logical line when the content fits", () => {
    const editor = makeEditor();
    editor.setText("one\ntwo");
    const body = painted(editor, 60).filter((line) => line.trim().length > 0);
    expect(body.some((line) => line.includes("one"))).toBe(true);
    expect(body.some((line) => line.includes("two"))).toBe(true);
  });

  it("marks hidden scroll overflow instead of dropping the border row", () => {
    const editor = makeEditor(8, 40);
    editor.setText(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"));
    const lines = editor.render(40);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toContain("─");
  });
});
