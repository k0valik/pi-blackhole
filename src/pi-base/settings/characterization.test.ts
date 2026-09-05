import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

beforeAll(() => {
  initTheme();
});

import { createSettingsModalBody } from "./body.ts";
import type { Field } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────
// Stubs (copy from buffered-mode.test.ts)
// ─────────────────────────────────────────────────────────────────────

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
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function fakeCtx(): ExtensionContext {
  return {
    ui: {
      notify: vi.fn(),
    },
    modelRegistry: {
      getAvailable: () => [],
    },
  } as unknown as ExtensionContext;
}

// ─────────────────────────────────────────────────────────────────────
// Temp-config helpers for scope-tab tests
// ─────────────────────────────────────────────────────────────────────

let tmpDir: string;
let globalDir: string;
let projectDir: string;
let origAgentDir: string | undefined;

beforeAll(() => {
  origAgentDir = process.env.PI_CODING_AGENT_DIR;
  tmpDir = mkdtempSync("/tmp/pi-modal-test-");
  globalDir = join(tmpDir, "extensions");
  projectDir = join(tmpDir, "project");
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = tmpDir;
});

afterAll(() => {
  if (origAgentDir !== undefined) {
    process.env.PI_CODING_AGENT_DIR = origAgentDir;
  } else {
    delete process.env.PI_CODING_AGENT_DIR;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

const FILENAME = "test-scope-config.json";

// ─────────────────────────────────────────────────────────────────────
// §2.1 Tab / action-row cycling (C1–C3)
// ─────────────────────────────────────────────────────────────────────

describe("§2.1 Tab / action-row cycling", () => {
  it("C1: shift+tab reverses the cycle and wraps", () => {
    const fields: Field[] = [{ key: "enabled", type: "boolean", label: "Enabled", value: false }];
    const tabs = [
      { id: "global", label: "Global" },
      { id: "project", label: "Project Local" },
      { id: "session", label: "Session" },
    ];
    const actions = [
      { id: "reset", label: "Reset" },
      { id: "delete", label: "Delete" },
    ];
    const body = createSettingsModalBody<Field>(
      { title: "test", fields, tabs, actions },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );
    body.render(80);
    // Start on Global tab
    expect(body.render(80).join("\n")).toContain("▸ Global");
    // Shift+Tab from Global → last action (Delete)
    body.handleInput?.("\x1b[Z");
    expect(body.render(80).join("\n")).toContain("▸ Global");
    // Shift+Tab → Reset
    body.handleInput?.("\x1b[Z");
    expect(body.render(80).join("\n")).toContain("▸ Global");
    // Shift+Tab → Session tab
    body.handleInput?.("\x1b[Z");
    expect(body.render(80).join("\n")).toContain("▶ Session");
    // Shift+Tab → Project Local tab
    body.handleInput?.("\x1b[Z");
    expect(body.render(80).join("\n")).toContain("▶ Project Local");
    // Shift+Tab → Global tab (wrap)
    body.handleInput?.("\x1b[Z");
    expect(body.render(80).join("\n")).toContain("▶ Global");
  });

  it("C2: Enter on a focused tab returns focus to field zone and toggles the field", () => {
    const onChange = vi.fn();
    const fields: Field[] = [
      { key: "enabled", type: "boolean", label: "Enabled", value: false, tab: "tab2" },
    ];
    const tabs = [
      { id: "tab1", label: "Tab 1" },
      { id: "tab2", label: "Tab 2" },
    ];
    const body = createSettingsModalBody<Field>(
      { fields, tabs, onChange },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );
    body.render(80);
    // Tab once: focus lands on Tab 2
    body.handleInput?.("\t");
    expect(body.render(80).join("\n")).toContain("▶ Tab 2");
    // Press Enter — returns focus to field zone, does NOT toggle yet
    body.handleInput?.("\r");
    // Focus returned to field zone — active tab is still Tab 2
    expect(body.render(80).join("\n")).toContain("▸ Tab 2");
    // Subsequent Enter toggles the boolean
    body.handleInput?.("\r");
    expect(onChange).toHaveBeenCalledWith(
      "enabled",
      true,
      expect.objectContaining({ key: "enabled" }),
    );
  });

  it("C3: Esc while a tab/action row is focused returns to field zone without closing", () => {
    const close = vi.fn();
    const onChange = vi.fn();
    const fields: Field[] = [
      { key: "enabled", type: "boolean", label: "Enabled", value: false, tab: "tab2" },
    ];
    const tabs = [
      { id: "tab1", label: "Tab 1" },
      { id: "tab2", label: "Tab 2" },
    ];
    const actions = [{ id: "a", label: "Action" }];
    const body = createSettingsModalBody<Field>(
      { fields, tabs, actions, onChange },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );
    body.render(80);
    // Tab twice to focus Tab 2
    body.handleInput?.("\t");
    body.handleInput?.("\t");
    // Press Esc
    body.handleInput?.("\x1b");
    // Modal did NOT close
    expect(close).not.toHaveBeenCalled();
    // Subsequent Enter toggles the field
    body.handleInput?.("\r");
    expect(onChange).toHaveBeenCalledWith(
      "enabled",
      true,
      expect.objectContaining({ key: "enabled" }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// §2.2 visibleWhen (C10)
// ─────────────────────────────────────────────────────────────────────

describe("§2.2 visibleWhen", () => {
  it("C10: visibleWhen via ctx.get only", () => {
    const fields: Field[] = [
      { key: "first", type: "boolean", label: "First", value: false },
      {
        key: "second",
        type: "boolean",
        label: "Second",
        value: false,
        visibleWhen: (ctx) => ctx.get("first") === true,
      },
    ];
    const body = createSettingsModalBody<Field>(
      {
        title: "test",
        fields,
      },
      {
        tui: fakeTui(),
        theme: fakeTheme(),
        ctx: fakeCtx(),
        close: vi.fn(),
      },
    );
    body.render(80);
    // Initially first=false, so second is hidden
    expect(body.render(80).join("\n")).not.toContain("Second");
    // Toggle first to true
    body.handleInput?.("\r");
    // Now second is visible
    expect(body.render(80).join("\n")).toContain("Second");
  });
});

// ─────────────────────────────────────────────────────────────────────
// §2.4 Misc gaps (C16, C18)
// ─────────────────────────────────────────────────────────────────────

describe("§2.4 Misc gaps", () => {
  it("C16: pageDown moves selection by 5, pageUp moves back by 5", () => {
    const fields: Field[] = Array.from({ length: 12 }, (_, i) => ({
      key: `f${i}`,
      type: "boolean",
      label: `Field ${i + 1}`,
      value: false,
    }));
    const body = createSettingsModalBody<Field>(
      { title: "test", fields },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );
    body.render(80);
    // Initial selection at row 0
    const initial = body.render(80).join("\n");
    const initialSelected = initial.split("\n").findIndex((l) => l.includes("▌"));
    expect(initialSelected).toBeGreaterThanOrEqual(0);
    // PageDown
    body.handleInput?.("\x1b[6~");
    const afterDown = body.render(80).join("\n");
    const downSelected = afterDown.split("\n").findIndex((l) => l.includes("▌"));
    expect(downSelected).toBe(initialSelected + 5);
    // PageUp
    body.handleInput?.("\x1b[5~");
    const afterUp = body.render(80).join("\n");
    const upSelected = afterUp.split("\n").findIndex((l) => l.includes("▌"));
    expect(upSelected).toBe(initialSelected);
  });

  it("C18: ctrl+r on a field with default resets value and calls onChange", () => {
    const onChange = vi.fn();
    const fields: Field[] = [{ key: "num", type: "number", label: "Num", value: 10, default: 5 }];
    const body = createSettingsModalBody<Field>(
      { fields, onChange },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );
    body.render(80);
    // ctrl+r
    body.handleInput?.("\x12");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("num", 5, expect.objectContaining({ key: "num" }));
  });
});
