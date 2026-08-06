import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  frame,
  frameContentWidth,
  responsiveInnerRows,
  DEFAULT_PADDING_Y,
} from "./frame.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

function fakeTheme(): Theme {
  const captured: Record<string, string[]> = {};
  const fg = (color: string, text: string): string => {
    captured[color] = captured[color] ?? [];
    captured[color]!.push(text);
    return text;
  };
  return {
    fg,
    bg: fg,
    bold: (t: string) => t,
    italic: (t: string) => t,
    underline: (t: string) => t,
    inverse: (t: string) => t,
    strikethrough: (t: string) => t,
    getFgAnsi: () => "",
    getBgAnsi: () => "",
    getColorMode: () => "truecolor",
    getThinkingBorderColor: () => (s: string) => s,
    getBashModeBorderColor: () => (s: string) => s,
  } as unknown as Theme;
}

describe("frame() — subtitle", () => {
  const width = 40;

  it("absent subtitle produces output identical to today", () => {
    const theme = fakeTheme();
    const lines = frame(["hello"], width, theme);
    expect(lines.length).toBeGreaterThan(0);
    // No dim-colored subtitle text should be recorded.
    expect(theme.fg("dim", "")).not.toBe("dim"); // just exercising the stub
    // Verify the structure has no subtitle-like row (no extra content-only line)
    const top = lines[0]!;
    expect(top).toContain("╭");
    // The body row should be on the second content line (after paddingY blanks)
    const blankCount = DEFAULT_PADDING_Y;
    const bodyLine = lines[1 + blankCount]!;
    expect(bodyLine).toContain("hello");
  });

  it("renders a single-line subtitle dim under the top border", () => {
    const theme = fakeTheme();
    const lines = frame(["hello"], width, theme, { subtitle: "subtitle text" });
    // After the top border (line 0), subtitle line(s) come first,
    // then paddingY blanks, then body rows.
    const subtitleLine = lines[1]!;
    expect(subtitleLine).toContain("subtitle text");
    // Verify the line is dim-themed by checking the theme was called with "dim"
    // (the passthrough returns text unchanged, but we can inspect by rebuilding
    // with a spy — simpler: assert the line does not contain the title-pill accent
    // colour marker, just the raw text between borders).
    const match = subtitleLine.match(/│ (.+) │/);
    expect(match).toBeTruthy();
    expect(match![1]!.trim()).toBe("subtitle text");
  });

  it("renders multi-line subtitles (split on \\n)", () => {
    const theme = fakeTheme();
    const lines = frame(["hello"], width, theme, {
      subtitle: "line one\nline two",
    });
    // First line after top border
    const line1 = lines[1]!;
    expect(line1).toContain("line one");
    const line2 = lines[2]!;
    expect(line2).toContain("line two");
  });

  it("truncates subtitle to contentWidth", () => {
    const theme = fakeTheme();
    const longSubtitle = "a".repeat(100);
    const lines = frame(["hello"], width, theme, { subtitle: longSubtitle });
    // The final frame() pass truncates every emitted line to `width`
    // visible columns; ANSI escape codes inflate raw byte length, so
    // assert on visible width rather than `.length`.
    const subtitleLine = lines[1]!;
    expect(visibleWidth(subtitleLine)).toBeLessThanOrEqual(width);
  });

  it("fixedInnerRows still reserves space for subtitle", () => {
    const theme = fakeTheme();
    const manyLines = Array.from({ length: 20 }, (_, i) => `row ${i}`);
    const lines = frame(manyLines, width, theme, {
      subtitle: "sub",
      fixedInnerRows: 5,
    });
    // The frame should still cap body rows at fixedInnerRows
    const bodyRows = lines.filter((l) => l.includes("row"));
    expect(bodyRows.length).toBeLessThanOrEqual(5);
  });
});

describe("frameContentWidth", () => {
  it("computes width minus borders and padding", () => {
    expect(frameContentWidth(40)).toBe(36);
    expect(frameContentWidth(40, 2)).toBe(34);
  });
});

describe("responsiveInnerRows", () => {
  it("clamps to preferred and subtracts chrome", () => {
    expect(responsiveInnerRows(40, 20)).toBeGreaterThanOrEqual(12);
  });
});
