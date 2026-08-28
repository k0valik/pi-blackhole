import { describe, expect, it, vi, beforeAll } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createScopeSelector } from "./scope-selector.ts";

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

describe("createScopeSelector", () => {
  const width = 60;

  const baseEntries = [
    { id: "global", label: "Global", available: true as const },
    { id: "project", label: "Project", available: true as const },
    { id: "session", label: "Session", available: true as const },
  ];

  it("renders entries and their notes with numeric prefixes and footer hint", () => {
    const done = vi.fn();
    const comp = createScopeSelector({
      title: "Test",
      entries: [
        ...baseEntries,
        { id: "env", label: "Env", available: true, note: "(disabled by extension)" },
      ],
      tui: fakeTui(),
      theme: fakeTheme(),
      done,
    });

    const output = comp.render(width).join("\n");
    expect(output).toContain("1. Global");
    expect(output).toContain("2. Project");
    expect(output).toContain("3. Session");
    expect(output).toContain("4. Env");
    expect(output).toContain("(disabled by extension)");
    expect(output).toContain("1-4 choose");
  });

  it("supports single-keypress numeric shortcuts", () => {
    const done = vi.fn();
    const comp = createScopeSelector({
      title: "Test",
      entries: baseEntries,
      tui: fakeTui(),
      theme: fakeTheme(),
      done,
    });

    comp.render(width);
    comp.handleInput?.("2");
    expect(done).toHaveBeenCalledWith({ kind: "select", id: "project" });
  });

  it("renders unavailable entries dimmed", () => {
    const seen: string[] = [];
    const captureTheme: Theme = {
      ...fakeTheme(),
      fg: (color: string, text: string) => {
        if (text === "Session") seen.push(color);
        return text;
      },
    } as Theme;

    const done = vi.fn();
    const comp = createScopeSelector({
      title: "Test",
      entries: [
        ...baseEntries,
        { id: "session", label: "Session", available: false, note: "not initialized" },
      ],
      tui: fakeTui(),
      theme: captureTheme,
      done,
    });

    comp.render(width);
    expect(seen).toContain("dim");
  });

  it("navigation skips unavailable entries and wraps", () => {
    const done = vi.fn();
    const tui = fakeTui();
    const comp = createScopeSelector({
      title: "Test",
      entries: [
        { id: "a", label: "A", available: true },
        { id: "b", label: "B", available: false },
        { id: "c", label: "C", available: true },
      ],
      tui,
      theme: fakeTheme(),
      done,
    });

    comp.render(width);
    // Starts at A (index 0 among available)
    comp.handleInput?.("\x1b[B"); // down -> should skip B and go to C
    expect(tui.requestRender).toHaveBeenCalledTimes(1);

    comp.handleInput?.("\x1b[B"); // down from C -> wraps to A
    expect(tui.requestRender).toHaveBeenCalledTimes(2);
  });

  it("supports home and end key navigation", () => {
    const done = vi.fn();
    const tui = fakeTui();
    const comp = createScopeSelector({
      title: "Test",
      entries: baseEntries,
      tui,
      theme: fakeTheme(),
      done,
    });

    comp.render(width);
    comp.handleInput?.("\x1b[F"); // end key sequence -> jumps to Session (last available)
    comp.handleInput?.("\r"); // enter
    expect(done).toHaveBeenCalledWith({ kind: "select", id: "session" });

    const doneHome = vi.fn();
    const compHome = createScopeSelector({
      title: "Test",
      entries: baseEntries,
      tui: fakeTui(),
      theme: fakeTheme(),
      done: doneHome,
    });

    compHome.render(width);
    compHome.handleInput?.("\x1b[B"); // down to Project
    compHome.handleInput?.("\x1b[H"); // home key sequence -> jumps back to Global
    compHome.handleInput?.("\r"); // enter
    expect(doneHome).toHaveBeenCalledWith({ kind: "select", id: "global" });
  });

  it("Enter returns the selected id", () => {
    const done = vi.fn();
    const comp = createScopeSelector({
      title: "Test",
      entries: baseEntries,
      tui: fakeTui(),
      theme: fakeTheme(),
      done,
    });

    comp.render(width);
    comp.handleInput?.("\x1b[B"); // down to Project
    comp.handleInput?.("\x1b[B"); // down to Session
    comp.handleInput?.("\r");
    expect(done).toHaveBeenCalledWith({ kind: "select", id: "session" });
  });

  it("Esc cancels", () => {
    const done = vi.fn();
    const comp = createScopeSelector({
      title: "Test",
      entries: baseEntries,
      tui: fakeTui(),
      theme: fakeTheme(),
      done,
    });

    comp.render(width);
    comp.handleInput?.("\x1b");
    expect(done).toHaveBeenCalledWith({ kind: "cancel" });
  });

  it("all-unavailable edge case: only Esc works", () => {
    const done = vi.fn();
    const tui = fakeTui();
    const comp = createScopeSelector({
      title: "Test",
      entries: [
        { id: "a", label: "A", available: false },
        { id: "b", label: "B", available: false },
      ],
      tui,
      theme: fakeTheme(),
      done,
    });

    comp.render(width);
    comp.handleInput?.("\x1b[B"); // down - no-op
    comp.handleInput?.("\r"); // enter - no-op
    expect(done).not.toHaveBeenCalled();

    comp.handleInput?.("\x1b"); // esc - cancels
    expect(done).toHaveBeenCalledWith({ kind: "cancel" });
  });

  describe("frame wrapping", () => {
    it("renders frame borders by default", () => {
      const done = vi.fn();
      const comp = createScopeSelector({
        title: "Framed",
        entries: baseEntries,
        tui: fakeTui(),
        theme: fakeTheme(),
        done,
      });

      const out = comp.render(60).join("\n");
      expect(out).toContain("╭");
      expect(out).toContain("╮");
      expect(out).toContain("│");
      expect(out).toContain("╰");
      expect(out).toContain("╯");
    });

    it("title pill contains the title", () => {
      const done = vi.fn();
      const comp = createScopeSelector({
        title: "My Title",
        entries: baseEntries,
        tui: fakeTui(),
        theme: fakeTheme(),
        done,
      });

      const out = comp.render(60).join("\n");
      expect(out).toContain("My Title");
    });

    it("every line is exactly width visible columns at 80 cols", () => {
      const done = vi.fn();
      const comp = createScopeSelector({
        title: "Width Test",
        entries: baseEntries,
        tui: fakeTui(),
        theme: fakeTheme(),
        done,
      });

      const w = 80;
      const lines = comp.render(w);
      for (let i = 0; i < lines.length; i++) {
        expect(visibleWidth(lines[i]!), `line ${i} visibleWidth`).toBe(w);
      }
    });

    it("every line is exactly width visible columns at 40 cols", () => {
      const done = vi.fn();
      const comp = createScopeSelector({
        title: "Width Test",
        entries: baseEntries,
        tui: fakeTui(),
        theme: fakeTheme(),
        done,
      });

      const w = 40;
      const lines = comp.render(w);
      for (let i = 0; i < lines.length; i++) {
        expect(visibleWidth(lines[i]!), `line ${i} visibleWidth`).toBe(w);
      }
    });

    it("unframed opt-out has no borders", () => {
      const done = vi.fn();
      const comp = createScopeSelector({
        title: "Unframed",
        entries: baseEntries,
        tui: fakeTui(),
        theme: fakeTheme(),
        done,
        frame: false,
      });

      const out = comp.render(60).join("\n");
      expect(out).not.toContain("╭");
      expect(out).not.toContain("╮");
      expect(out).not.toContain("│");
      expect(out).not.toContain("╰");
      expect(out).not.toContain("╯");
    });
  });
});
