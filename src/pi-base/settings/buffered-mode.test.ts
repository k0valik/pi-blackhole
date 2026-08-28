/**
 * TDD tests for buffered modal mode.
 *
 * Vertical slices — one test → one implementation → repeat.
 */

import { describe, expect, it, vi, beforeAll } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

beforeAll(() => {
  initTheme();
});
import { createSettingsModalBody } from "./body.ts";
import { createSettingsModal } from "./modal.ts";
import type { Field } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────
// Stubs
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
// Tests
// ─────────────────────────────────────────────────────────────────────

describe("createSettingsModalBody — buffered mode", () => {
  // Slice 1: Dirty tracking + Escape interception
  it("buffered mode: Escape on dirty opens built-in confirm instead of closing", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [{ key: "enabled", type: "boolean", label: "Enabled", value: false }];

    const body = createSettingsModalBody<Field>(
      { title: "test", fields, mode: "buffered", onSave, onCancel },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    // Toggle the boolean → dirty
    body.handleInput?.("\r");
    // Press Escape — should NOT close, should open built-in confirm
    body.handleInput?.("\x1b");

    expect(close).not.toHaveBeenCalled();
    const lines = body.render(80);
    expect(lines.join("\n")).toContain("You have unsaved changes.");
  });

  // Slice 2: Confirm — Discard
  it("buffered mode: Discard in confirm calls onCancel and closes", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [{ key: "enabled", type: "boolean", label: "Enabled", value: false }];

    const body = createSettingsModalBody<Field>(
      { title: "test", fields, mode: "buffered", onSave, onCancel },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    body.handleInput?.("\r"); // toggle → dirty
    body.handleInput?.("\x1b"); // Escape → confirm
    // In danger confirm, Cancel is pre-selected (index 0), Discard is index 1
    body.handleInput?.("\x1b[B"); // Down to Discard
    body.handleInput?.("\r"); // Enter on Discard

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  // Slice 3: Confirm — Cancel
  it("buffered mode: Cancel in confirm returns to modal with edits intact", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [{ key: "enabled", type: "boolean", label: "Enabled", value: false }];

    const body = createSettingsModalBody<Field>(
      { title: "test", fields, mode: "buffered", onSave, onCancel },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    body.handleInput?.("\r"); // toggle → dirty
    body.handleInput?.("\x1b"); // Escape → confirm

    // Cancel is pre-selected, Enter to cancel
    body.handleInput?.("\r");

    expect(onCancel).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    // Confirm dismissed
    expect(body.render(80).join("\n")).not.toContain("You have unsaved changes.");
  });

  // Slice 4: onSave error handling
  it("buffered mode: onSave error keeps modal open and notifies", async () => {
    const ctx = fakeCtx();
    const onSave = vi.fn().mockRejectedValueOnce(new Error("disk full"));
    const close = vi.fn();
    const fields: Field[] = [{ key: "enabled", type: "boolean", label: "Enabled", value: false }];

    const body = createSettingsModalBody<Field>(
      { title: "test", fields, mode: "buffered", onSave },
      { tui: fakeTui(), theme: fakeTheme(), ctx, close },
    );

    body.render(80);
    body.handleInput?.("\r"); // toggle enabled → dirty
    body.handleInput?.("\x13"); // Ctrl+S

    // Flush microtasks so the async error path completes.
    await new Promise((r) => setTimeout(r, 0));

    // Modal stays open
    expect(close).not.toHaveBeenCalled();
    // Error was surfaced via the same ctx
    expect(ctx.ui.notify).toHaveBeenCalledWith("disk full", "error");
  });

  // Slice 5: Ctrl+S shortcut
  it("buffered mode: Ctrl+S calls onSave with values and closes on success", async () => {
    const onSave = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [
      { key: "enabled", type: "boolean", label: "Enabled", value: false },
      {
        key: "threshold",
        type: "number",
        label: "Threshold",
        value: 25,
        min: 1,
        max: 100,
        integer: true,
      },
    ];

    const body = createSettingsModalBody<Field>(
      { title: "test", fields, mode: "buffered", onSave },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    body.handleInput?.("\r"); // toggle enabled → dirty
    body.handleInput?.("\x13"); // Ctrl+S

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ enabled: true, threshold: 25 });
    expect(close).toHaveBeenCalledTimes(1);
  });

  // Slice 6: Ctrl+S when clean still saves
  it("buffered mode: Ctrl+S when clean saves defaults directly", () => {
    const onSave = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [{ key: "enabled", type: "boolean", label: "Enabled", value: false }];

    const body = createSettingsModalBody<Field>(
      { title: "test", fields, mode: "buffered", onSave },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    // No edits made — clean
    body.handleInput?.("\x13"); // Ctrl+S

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ enabled: false });
    expect(close).toHaveBeenCalledTimes(1);
  });

  // Slice 7: onRequestExit defers to caller
  it("buffered mode: onRequestExit is called instead of built-in confirm when dirty Esc", () => {
    const onSave = vi.fn();
    const onRequestExit = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [{ key: "enabled", type: "boolean", label: "Enabled", value: false }];

    const body = createSettingsModalBody<Field>(
      { title: "test", fields, mode: "buffered", onSave, onRequestExit },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    body.handleInput?.("\r"); // toggle → dirty
    body.handleInput?.("\x1b"); // Escape

    expect(onRequestExit).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    // No built-in confirm mounted
    expect(body.render(80).join("\n")).not.toContain("You have unsaved changes.");
  });

  // Slice 8: Dirty indicator
  it("buffered mode: dirty indicator ● appears in title when dirty", () => {
    const onSave = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [{ key: "enabled", type: "boolean", label: "Enabled", value: false }];

    const body = createSettingsModalBody<Field>(
      { title: "@k0valik/pi-cache", fields, mode: "buffered", onSave },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    // Initially clean — no dot
    expect(body.render(80).join("\n")).not.toContain("●");

    body.handleInput?.("\r"); // toggle → dirty
    // Now dirty — dot appears in title
    expect(body.render(80).join("\n")).toContain("@k0valik/pi-cache ●");
  });

  // Bug fix: reverting a value to its initial state clears dirty
  it("buffered mode: reverting a value to its initial state clears dirty", () => {
    const onSave = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [{ key: "enabled", type: "boolean", label: "Enabled", value: false }];

    const body = createSettingsModalBody<Field>(
      { title: "test", fields, mode: "buffered", onSave },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    // false → true: dirty
    body.handleInput?.("\r");
    expect(body.render(80).join("\n")).toContain("test ●");

    // true → false: reverted to initial, should clear dirty
    body.handleInput?.("\r");
    expect(body.render(80).join("\n")).not.toContain("●");
    expect(onSave).not.toHaveBeenCalled();
  });

  // Bug fix: onChange throw should not mark field dirty
  it("buffered mode: onChange throw does not mark field dirty", () => {
    const onChange = vi.fn().mockImplementation(() => {
      throw new Error("onChange rejected");
    });
    const onSave = vi.fn();
    const close = vi.fn();
    const ctx = fakeCtx();
    const fields: Field[] = [{ key: "enabled", type: "boolean", label: "Enabled", value: false }];

    const body = createSettingsModalBody<Field>(
      { title: "test", fields, mode: "buffered", onChange, onSave },
      { tui: fakeTui(), theme: fakeTheme(), ctx, close },
    );

    body.render(80);
    body.handleInput?.("\r"); // toggle attempts to commit, onChange throws

    // Value rolled back, not dirty
    expect(body.render(80).join("\n")).not.toContain("●");
    // Error surfaced
    expect(ctx.ui.notify).toHaveBeenCalledWith("onChange rejected", "error");
  });

  // ── Ctrl+C mid-edit (ported from blackhole) ──
  it("buffered mode: ctrl+c mid-string-edit opens confirm submenu when dirty", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [
      { key: "enabled", type: "boolean", label: "Enabled", value: false },
      { key: "name", type: "string", label: "Name", value: "hello" },
    ];

    const body = createSettingsModalBody<Field>(
      { title: "test", fields, mode: "buffered", onSave, onCancel },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    body.handleInput?.("\x1b[B"); // Down to string field
    body.handleInput?.("\r"); // Enter to start editing
    body.handleInput?.("a"); // type 'a' in editor

    // Now move back to boolean and toggle it to make dirty
    body.handleInput?.("\x1b[A"); // Up to boolean
    body.handleInput?.("\r"); // Toggle boolean → dirty

    // Move back to string field (still editing state is separate per field)
    body.handleInput?.("\x1b[B"); // Down to string
    body.handleInput?.("\r"); // Enter to start editing string again

    // ctrl+c mid-edit should open confirm submenu (dirty)
    body.handleInput?.("\x03"); // Ctrl+C

    expect(close).not.toHaveBeenCalled();
    expect(body.render(80).join("\n")).toContain("You have unsaved changes.");
  });

  it("buffered mode: ctrl+c mid-string-edit closes when not dirty", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [{ key: "name", type: "string", label: "Name", value: "hello" }];

    const body = createSettingsModalBody<Field>(
      { title: "test", fields, mode: "buffered", onSave, onCancel },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    body.handleInput?.("\r"); // Enter to start editing
    // Don't type anything — still clean

    // ctrl+c mid-edit should close directly (not dirty)
    body.handleInput?.("\x03"); // Ctrl+C

    expect(close).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  // Slice 7: Singleton guard
  it("modal.ts: opening a second modal closes the first", () => {
    const ctx = fakeCtx();
    const fields: Field[] = [{ key: "x", type: "boolean", label: "X", value: false }];

    const firstDone = vi.fn();
    const secondDone = vi.fn();

    const factory1 = createSettingsModal(ctx, { fields });
    const factory2 = createSettingsModal(ctx, { fields });

    const comp1 = factory1(fakeTui(), fakeTheme(), null!, firstDone);
    const comp2 = factory2(fakeTui(), fakeTheme(), null!, secondDone);

    // Opening the second should have closed the first.
    expect(firstDone).toHaveBeenCalledTimes(1);
    expect(secondDone).not.toHaveBeenCalled();
  });
});
