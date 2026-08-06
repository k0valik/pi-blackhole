import { describe, expect, it, beforeAll } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { createSettingsModalBody } from "./body.ts";
import type { Field } from "./types.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

beforeAll(() => {
  initTheme();
});

function fakeTheme(): Theme {
  const passthrough = (_color: string, text: string): string => text;
  return {
    fg: passthrough,
    bg: passthrough,
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
    requestRender: () => {},
  } as unknown as TUI;
}

function fakeCtx(): ExtensionContext {
  return {
    ui: { notify: () => {} },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
  } as unknown as ExtensionContext;
}

describe("FieldBase.valueNote", () => {
  it("renders a string valueNote as a dim suffix after the value cell", () => {
    const fields: Field[] = [
      {
        key: "x",
        type: "boolean",
        label: "X",
        value: true,
        valueNote: "(from default)",
      },
    ];
    const body = createSettingsModalBody(
      { fields },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: () => {} },
    );

    const output = body.render(80).join("\n");
    expect(output).toContain("(from default)");
  });

  it("re-evaluates a thunk valueNote on every render", () => {
    let note = "first";
    const fields: Field[] = [
      {
        key: "x",
        type: "boolean",
        label: "X",
        value: true,
        valueNote: () => note,
      },
    ];
    const body = createSettingsModalBody(
      { fields },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: () => {} },
    );

    let output = body.render(80).join("\n");
    expect(output).toContain("first");

    note = "second";
    output = body.render(80).join("\n");
    expect(output).toContain("second");
  });

  it("does not render a note when valueNote resolves to undefined", () => {
    const fields: Field[] = [
      {
        key: "x",
        type: "boolean",
        label: "X",
        value: true,
        valueNote: () => undefined,
      },
    ];
    const body = createSettingsModalBody(
      { fields },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: () => {} },
    );

    const output = body.render(80).join("\n");
    expect(output).not.toMatch(/\(from default\)|undefined/);
  });

  it("truncates long valueNote text to fit the row width", () => {
    const longNote = "n".repeat(100);
    const fields: Field[] = [
      {
        key: "x",
        type: "boolean",
        label: "X",
        value: true,
        valueNote: longNote,
      },
    ];
    const body = createSettingsModalBody(
      { fields },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: () => {} },
    );

    const lines = body.render(80);
    const rowLine = lines.find((l) => l.includes("X"));
    expect(rowLine).toBeDefined();
    if (rowLine) {
      expect(visibleWidth(rowLine)).toBeLessThanOrEqual(80);
    }
  });
});
