import { describe, expect, it, vi, beforeAll } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { createConfirm } from "./confirm.ts";

beforeAll(() => {
  initTheme();
});

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

function fakeTui(): TUI {
  return {
    terminal: { rows: 40, columns: 100 },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

describe("createConfirm", () => {
  const width = 60;

  it("pre-selects Confirm when danger is false/absent", () => {
    const done = vi.fn();
    const comp = createConfirm({ message: ["Save?"] }, done, {
      tui: fakeTui(),
      theme: fakeTheme(),
    });

    const lines = comp.render(width).join("\n");
    expect(lines).toContain("Confirm");
    expect(lines).toContain("▌ Confirm");
    expect(lines).toContain("  Cancel");
  });

  it("pre-selects Cancel when danger is true", () => {
    const done = vi.fn();
    const comp = createConfirm({ message: ["Delete?"], danger: true }, done, {
      tui: fakeTui(),
      theme: fakeTheme(),
    });

    const lines = comp.render(width).join("\n");
    expect(lines).toContain("▌ Cancel");
    expect(lines).toContain("  Confirm");
  });

  it("Enter on Confirm calls done(true)", () => {
    const done = vi.fn();
    const comp = createConfirm({ message: ["Save?"] }, done, {
      tui: fakeTui(),
      theme: fakeTheme(),
    });

    comp.render(width);
    comp.handleInput?.("\r");
    expect(done).toHaveBeenCalledWith(true);
  });

  it("Enter on Cancel calls done(false)", () => {
    const done = vi.fn();
    const comp = createConfirm({ message: ["Save?"] }, done, {
      tui: fakeTui(),
      theme: fakeTheme(),
    });

    comp.render(width);
    comp.handleInput?.("\x1b[B"); // down to Cancel
    comp.handleInput?.("\r");
    expect(done).toHaveBeenCalledWith(false);
  });

  it("Esc always calls done(false)", () => {
    const done = vi.fn();
    const comp = createConfirm({ message: ["Save?"] }, done, {
      tui: fakeTui(),
      theme: fakeTheme(),
    });

    comp.render(width);
    comp.handleInput?.("\x1b");
    expect(done).toHaveBeenCalledWith(false);
  });

  it("↑/↓ moves selection and requests a render", () => {
    const done = vi.fn();
    const tui = fakeTui();
    const comp = createConfirm({ message: ["Save?"] }, done, {
      tui,
      theme: fakeTheme(),
    });

    comp.render(width);
    comp.handleInput?.("\x1b[B"); // down
    expect(tui.requestRender).toHaveBeenCalledTimes(1);

    comp.handleInput?.("\x1b[A"); // up
    expect(tui.requestRender).toHaveBeenCalledTimes(2);
  });

  it("←/→ also move selection", () => {
    const done = vi.fn();
    const tui = fakeTui();
    const comp = createConfirm({ message: ["Save?"] }, done, {
      tui,
      theme: fakeTheme(),
    });

    comp.render(width);
    comp.handleInput?.("\x1b[D"); // left
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("wraps long message lines via wrapLine", () => {
    const done = vi.fn();
    const comp = createConfirm(
      {
        message: [
          "This is a very long message that should wrap across multiple lines in the confirm dialog.",
        ],
      },
      done,
      { tui: fakeTui(), theme: fakeTheme() },
    );

    const lines = comp.render(width);
    // There should be multiple message lines (wrapped) plus blank lines and options
    const messageLines = lines.filter(
      (l) => l.trim().length > 0 && !l.includes("▌") && !l.includes("↑↓"),
    );
    expect(messageLines.length).toBeGreaterThan(1);
  });

  it("renders message in warning color when danger is true", () => {
    const seen: string[] = [];
    const captureTheme: Theme = {
      ...fakeTheme(),
      fg: (color: string, text: string) => {
        if (text.startsWith("This")) seen.push(color);
        return text;
      },
    } as Theme;

    const done = vi.fn();
    const comp = createConfirm(
      { message: ["This is dangerous."], danger: true },
      done,
      {
        tui: fakeTui(),
        theme: captureTheme,
      },
    );

    comp.render(width);
    expect(seen).toContain("warning");
  });
});
