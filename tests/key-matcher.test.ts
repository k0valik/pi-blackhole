import { describe, test, expect } from "vitest";
import { matchKey, visibleWidth } from "../src/om/key-matcher.js";

describe("matchKey", () => {
  test("escape", () => {
    expect(matchKey("\x1b", "escape")).toBe(true);
    expect(matchKey("x", "escape")).toBe(false);
  });

  test("enter", () => {
    expect(matchKey("\r", "enter")).toBe(true);
    expect(matchKey("\n", "enter")).toBe(true);
    expect(matchKey(" ", "enter")).toBe(false);
  });

  test("tab", () => {
    expect(matchKey("\t", "tab")).toBe(true);
  });

  test("space", () => {
    expect(matchKey(" ", "space")).toBe(true);
  });

  test("backspace", () => {
    expect(matchKey("\x7f", "backspace")).toBe(true);
    expect(matchKey("\b", "backspace")).toBe(true);
  });

  test("up arrow", () => {
    expect(matchKey("\x1b[A", "up")).toBe(true);
    expect(matchKey("\x1bOA", "up")).toBe(true);
    expect(matchKey("\x1b[B", "up")).toBe(false);
  });

  test("down arrow", () => {
    expect(matchKey("\x1b[B", "down")).toBe(true);
    expect(matchKey("\x1bOB", "down")).toBe(true);
  });

  test("left arrow", () => {
    expect(matchKey("\x1b[D", "left")).toBe(true);
    expect(matchKey("\x1bOD", "left")).toBe(true);
  });

  test("right arrow", () => {
    expect(matchKey("\x1b[C", "right")).toBe(true);
    expect(matchKey("\x1bOC", "right")).toBe(true);
  });

  test("ctrl+s", () => {
    expect(matchKey("\x13", "ctrl+s")).toBe(true);  // s is 19th letter
    expect(matchKey("\x03", "ctrl+s")).toBe(false); // ctrl+c
  });

  test("ctrl+c", () => {
    expect(matchKey("\x03", "ctrl+c")).toBe(true);
  });

  test("ctrl+a", () => {
    expect(matchKey("\x01", "ctrl+a")).toBe(true);
  });

  test("invalid ctrl+ sequence with non-letter", () => {
    expect(matchKey("\x00", "ctrl+1")).toBe(false);
  });

  test("unknown key returns false", () => {
    expect(matchKey("x", "unknown")).toBe(false);
  });

  test("empty data returns false", () => {
    expect(matchKey("", "enter")).toBe(false);
  });
});

describe("visibleWidth", () => {
  test("plain ASCII", () => {
    expect(visibleWidth("hello")).toBe(5);
  });

  test("ANSI codes stripped", () => {
    expect(visibleWidth("\x1b[31mred\x1b[0m")).toBe(3);
  });

  test("CJK characters count as 2", () => {
    expect(visibleWidth("你好")).toBe(4);
    expect(visibleWidth("a你b")).toBe(4); // 1 + 2 + 1
  });

  test("empty string", () => {
    expect(visibleWidth("")).toBe(0);
  });

  test("mixed ANSI and CJK", () => {
    expect(visibleWidth("\x1b[1m中文\x1b[0m")).toBe(4);
  });

  test("nullish input", () => {
    // visibleWidth is called with strings in practice
    expect(visibleWidth(String(null))).toBe(4);
  });
});
