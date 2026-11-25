import { describe, expect, it } from "vitest";
import {
  cjkBreakRegex,
  extractAnsiCode,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "../src/ui/ansi-text.js";

describe("visibleWidth", () => {
  it("counts printable ASCII one per char", () => {
    expect(visibleWidth("hello")).toBe(5);
  });

  it("ignores ANSI styling sequences", () => {
    expect(visibleWidth("\x1b[31mred\x1b[0m")).toBe(3);
  });

  it("counts CJK graphemes as width 2", () => {
    expect(visibleWidth("你好")).toBe(4);
    expect(visibleWidth("a你b")).toBe(4);
  });

  it("counts a tab as width 3", () => {
    expect(visibleWidth("\t")).toBe(3);
    expect(visibleWidth("a\tb")).toBe(5);
  });

  it("counts RGI emoji as width 2", () => {
    expect(visibleWidth("😀")).toBe(2);
  });

  it("treats variation selector as zero width attached to base", () => {
    expect(visibleWidth("❤️")).toBe(2);
    expect(visibleWidth("❤")).toBe(1);
  });

  it("returns 0 for empty string", () => {
    expect(visibleWidth("")).toBe(0);
  });

  it("handles combining marks as zero width", () => {
    expect(visibleWidth("é")).toBe(1);
  });
});

describe("stripTerminalSequences", () => {
  it("removes CSI styling codes", () => {
    expect(stripTerminalSequences("\x1b[31mred\x1b[0m")).toBe("red");
  });

  it("removes OSC 8 hyperlinks but keeps link text", () => {
    expect(stripTerminalSequences("\x1b]8;;https://example.com\x07click\x1b]8;;\x07")).toBe(
      "click",
    );
  });

  it("removes APC sequences", () => {
    expect(stripTerminalSequences("\x1b_CURSOR_MARKER\x07text")).toBe("text");
  });

  it("returns plain strings unchanged", () => {
    expect(stripTerminalSequences("plain")).toBe("plain");
  });
});

describe("truncateToWidth", () => {
  it("returns text unchanged when it fits", () => {
    expect(truncateToWidth("short", 10)).toBe("short");
  });

  it("truncates ASCII with default ellipsis", () => {
    expect(truncateToWidth("abcdefghij", 7)).toBe("abcd\x1b[0m...\x1b[0m");
  });

  it("uses a custom ellipsis", () => {
    expect(truncateToWidth("abcdefghij", 7, "…")).toBe("abcdef\x1b[0m…\x1b[0m");
  });

  it("pads to exactly maxWidth when pad is true", () => {
    const result = truncateToWidth("abc", 10, "…", true);
    expect(result).toBe("abc       ");
    expect(visibleWidth(result)).toBe(10);
  });

  it("pads truncated output to exactly maxWidth", () => {
    const result = truncateToWidth("abcdefghij", 7, "…", true);
    expect(visibleWidth(result)).toBe(7);
  });

  it("does not count ANSI codes toward width", () => {
    const result = truncateToWidth("\x1b[31mabcdefghij\x1b[0m", 7);
    expect(visibleWidth(result)).toBe(7);
    expect(result).toContain("abcd");
  });

  it("respects CJK widths when truncating", () => {
    const result = truncateToWidth("你好世界", 5, "");
    expect(visibleWidth(result)).toBe(4);
  });

  it("returns empty string for non-positive maxWidth", () => {
    expect(truncateToWidth("abc", 0)).toBe("");
  });

  it("closes an active OSC 8 hyperlink when truncating", () => {
    const result = truncateToWidth("\x1b]8;;https://example.com\x07abcdefghij", 7);
    expect(result).toContain("\x1b]8;;\x07");
  });
});

describe("wrapTextWithAnsi", () => {
  it("wraps ASCII words at the width boundary", () => {
    expect(wrapTextWithAnsi("aa bb cc", 5)).toEqual(["aa bb", "cc"]);
  });

  it("preserves SGR state across wrapped lines", () => {
    const lines = wrapTextWithAnsi("\x1b[31maaa bbb ccc", 5);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[1]).toContain("\x1b[31m");
    expect(lines.every((line) => visibleWidth(line) <= 5)).toBe(true);
  });

  it("splits long words that exceed the width", () => {
    const lines = wrapTextWithAnsi("abcdefghijkl", 5);
    expect(lines).toEqual(["abcde", "fghij", "kl"]);
  });

  it("splits long styled words and reopens style on continuation lines", () => {
    const lines = wrapTextWithAnsi("\x1b[1mabcdefghijkl\x1b[0m", 5);
    expect(lines.length).toBe(3);
    expect(lines.map((l) => visibleWidth(l))).toEqual([5, 5, 2]);
    expect(lines[1]).toContain("\x1b[1m");
  });

  it("keeps literal newlines as line breaks", () => {
    expect(wrapTextWithAnsi("aa\nbb", 10)).toEqual(["aa", "bb"]);
  });

  it("carries an open style across a literal newline", () => {
    const lines = wrapTextWithAnsi("\x1b[31mfirst\nsecond", 40);
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain("\x1b[31m");
  });

  it("closes and reopens OSC 8 hyperlinks across wraps", () => {
    const lines = wrapTextWithAnsi("\x1b]8;;https://example.com\x07aaa bbb \x1b]8;;\x07", 5);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toContain("\x1b]8;;\x07");
    expect(lines[1]).toContain("\x1b]8;;https://example.com\x07");
  });

  it("breaks between CJK characters", () => {
    const lines = wrapTextWithAnsi("你好你好你好", 4);
    expect(lines).toEqual(["你好", "你好", "你好"]);
  });

  it("returns a single empty line for empty input", () => {
    expect(wrapTextWithAnsi("", 10)).toEqual([""]);
  });

  it("does not start wrapped lines with whitespace", () => {
    const lines = wrapTextWithAnsi("aaa    bbb", 5);
    for (const line of lines) {
      expect(stripTerminalSequences(line)).not.toMatch(/^\s/);
    }
  });
});

describe("extractAnsiCode", () => {
  it("extracts a CSI sequence", () => {
    expect(extractAnsiCode("\x1b[31mrest", 0)).toEqual({ code: "\x1b[31m", length: 5 });
  });

  it("extracts a BEL-terminated OSC sequence", () => {
    const seq = "\x1b]8;;https://example.com\x07";
    expect(extractAnsiCode(seq, 0)).toEqual({ code: seq, length: seq.length });
  });

  it("returns null for a non-escape position", () => {
    expect(extractAnsiCode("abc", 0)).toBeNull();
  });
});

describe("cjkBreakRegex", () => {
  it("matches Han characters", () => {
    expect(cjkBreakRegex.test("中")).toBe(true);
  });

  it("does not match ASCII", () => {
    expect(cjkBreakRegex.test("a")).toBe(false);
  });
});
