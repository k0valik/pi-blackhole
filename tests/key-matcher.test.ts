import { describe, test, expect } from "vitest";
import { matchesKey } from "@earendil-works/pi-tui";
import { visibleWidth } from "../src/om/key-matcher.js";

describe("matchesKey (pi-tui)", () => {
  // ── Legacy terminal sequences ──

  test("escape (legacy)", () => {
    expect(matchesKey("\x1b", "escape")).toBe(true);
    expect(matchesKey("x", "escape")).toBe(false);
  });

  test("enter (legacy)", () => {
    expect(matchesKey("\r", "enter")).toBe(true);
    expect(matchesKey(" ", "enter")).toBe(false);
  });

  test("tab (legacy)", () => {
    expect(matchesKey("\t", "tab")).toBe(true);
  });

  test("space (legacy)", () => {
    expect(matchesKey(" ", "space")).toBe(true);
  });

  test("backspace (legacy)", () => {
    expect(matchesKey("\x7f", "backspace")).toBe(true);
  });

  test("arrows (legacy)", () => {
    expect(matchesKey("\x1b[A", "up")).toBe(true);
    expect(matchesKey("\x1bOA", "up")).toBe(true);
    expect(matchesKey("\x1b[B", "up")).toBe(false);
    expect(matchesKey("\x1b[B", "down")).toBe(true);
    expect(matchesKey("\x1bOB", "down")).toBe(true);
    expect(matchesKey("\x1b[D", "left")).toBe(true);
    expect(matchesKey("\x1bOD", "left")).toBe(true);
    expect(matchesKey("\x1b[C", "right")).toBe(true);
    expect(matchesKey("\x1bOC", "right")).toBe(true);
  });

  test("ctrl+s (legacy)", () => {
    expect(matchesKey("\x13", "ctrl+s")).toBe(true);
    expect(matchesKey("\x03", "ctrl+s")).toBe(false); // ctrl+c
  });

  test("ctrl+c (legacy)", () => {
    expect(matchesKey("\x03", "ctrl+c")).toBe(true);
  });

  test("ctrl+a (legacy)", () => {
    expect(matchesKey("\x01", "ctrl+a")).toBe(true);
  });

  // ── Kitty CSI-u sequences ──

  test("escape (Kitty CSI-u)", () => {
    expect(matchesKey("\x1b[27u", "escape")).toBe(true);
    expect(matchesKey("\x1b[27;1u", "escape")).toBe(true);
  });

  test("enter (Kitty CSI-u)", () => {
    expect(matchesKey("\x1b[13u", "enter")).toBe(true);
    expect(matchesKey("\x1b[13;1u", "enter")).toBe(true);
  });

  test("tab (Kitty CSI-u)", () => {
    expect(matchesKey("\x1b[9u", "tab")).toBe(true);
  });

  test("space (Kitty CSI-u)", () => {
    expect(matchesKey("\x1b[32u", "space")).toBe(true);
  });

  test("backspace (Kitty CSI-u)", () => {
    expect(matchesKey("\x1b[127u", "backspace")).toBe(true);
  });

  test("arrows (Kitty CSI-u arrow format)", () => {
    expect(matchesKey("\x1b[1;1A", "up")).toBe(true);
    expect(matchesKey("\x1b[1;1B", "down")).toBe(true);
    expect(matchesKey("\x1b[1;1D", "left")).toBe(true);
    expect(matchesKey("\x1b[1;1C", "right")).toBe(true);
  });

  test("ctrl+s (Kitty CSI-u)", () => {
    expect(matchesKey("\x1b[115;5u", "ctrl+s")).toBe(true);
  });

  test("ctrl+c (Kitty CSI-u)", () => {
    expect(matchesKey("\x1b[99;5u", "ctrl+c")).toBe(true);
  });

  // ── Edge cases ──

  test("unknown key returns false", () => {
    expect(matchesKey("x", "unknown")).toBe(false);
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
    expect(visibleWidth(String(null))).toBe(4);
  });
});
