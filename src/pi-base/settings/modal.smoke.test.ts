/**
 * Smoke test for the settings modal: walks the public `Field[]` API
 * end-to-end with a hand-rolled `tui`/`theme`/`ctx` triple. Verifies:
 *
 *   - The body renders without throwing for every built-in field type.
 *   - Enter on a boolean toggles its value.
 *   - Enter on a short enum cycles to the next option.
 *   - Enter on a long enum opens a submenu.
 *   - Esc closes the modal (calls the supplied `close()`).
 *
 * The test stubs the host pi APIs to the absolute minimum the modal
 * touches; nothing in this file imports the real Pi runtime.
 */

import { describe, expect, it, vi, beforeAll } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

// SelectList renders via getSelectListTheme(), which requires the host
// theme to be initialized. We call this once globally so submenu render
// paths don't blow up in isolation.
beforeAll(() => {
  initTheme();
});
import { createSettingsModal } from "./modal.ts";
import { createSettingsModalBody } from "./body.ts";
import type { Field, SettingsModalOptions } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────
// Stubs
// ─────────────────────────────────────────────────────────────────────

function fakeTheme(): Theme {
  // We only call the colour helpers, all of which are passthroughs in
  // the test (the modal never inspects the wrapped string).
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
  // The modal touches `tui.terminal.rows` and `tui.requestRender()`.
  // Anything else trips the test on purpose.
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
      find: () => undefined,
    },
  } as unknown as ExtensionContext;
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe("createSettingsModalBody — happy paths", () => {
  it("renders every built-in field type without throwing", () => {
    const fields: Field[] = [
      { key: "bool", type: "boolean", label: "Bool", value: false },
      {
        key: "short_enum",
        type: "enum",
        label: "Short",
        value: "a",
        options: ["a", "b", "c"],
      },
      {
        key: "long_enum",
        type: "enum",
        label: "Long",
        value: "1",
        options: ["1", "2", "3", "4", "5", "6", "7", "8"],
      },
      { key: "str", type: "string", label: "Str", value: "hello" },
      { key: "num", type: "number", label: "Num", value: 42 },
      { key: "secret", type: "secret", label: "Sec", value: "shh" },
      { key: "path", type: "path", label: "Path", value: "/tmp" },
      {
        key: "model",
        type: "model",
        label: "Model",
        value: { id: "", thinking: "medium" },
      },
      {
        key: "action",
        type: "action",
        label: "Run",
        onActivate: () => {},
      },
      {
        key: "custom",
        type: "custom",
        label: "Custom",
        value: 7,
        render: (a) => `value=${String(a.value)}`,
      },
    ];

    const close = vi.fn();
    const body = createSettingsModalBody(
      { title: "test", fields },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    const lines = body.render(80);
    expect(lines.length).toBeGreaterThan(0);
    // Frame top line includes the rounded corner glyphs.
    expect(lines[0]).toContain("╭");
    expect(lines[0]).toContain("test");
    expect(lines[lines.length - 1]).toContain("╰");
  });

  it("Enter on a boolean field toggles its value via onChange", () => {
    const onChange = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [
      { key: "muted", type: "boolean", label: "Muted", value: false },
    ];
    const body = createSettingsModalBody(
      { fields, onChange },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80); // mount
    body.handleInput?.("\r"); // Enter

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      "muted",
      true,
      expect.objectContaining({ key: "muted" }),
    );
  });

  it("left/right arrow keys on a boolean field set its value absolutely via onChange", () => {
    const onChange = vi.fn();
    const fields: Field[] = [
      { key: "muted", type: "boolean", label: "Muted", value: false },
    ];
    const body = createSettingsModalBody(
      { fields, onChange },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80); // mount

    // Press right -> turns on (true)
    body.handleInput?.("\x1b[C"); // Right
    expect(onChange).toHaveBeenCalledWith(
      "muted",
      true,
      expect.objectContaining({ key: "muted" }),
    );

    onChange.mockClear();

    // Now starting with true
    const fieldsTrue: Field[] = [
      { key: "muted", type: "boolean", label: "Muted", value: true },
    ];
    const bodyTrue = createSettingsModalBody(
      { fields: fieldsTrue, onChange },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );
    bodyTrue.render(80);

    // Press left -> turns off (false)
    bodyTrue.handleInput?.("\x1b[D"); // Left
    expect(onChange).toHaveBeenCalledWith(
      "muted",
      false,
      expect.objectContaining({ key: "muted" }),
    );
  });

  it("Enter on a short enum cycles to the next option", () => {
    const onChange = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [
      {
        key: "scope",
        type: "enum",
        label: "Scope",
        value: "last",
        options: ["last", "sinceUser"],
      },
    ];
    const body = createSettingsModalBody(
      { fields, onChange },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    body.handleInput?.("\r");

    expect(onChange).toHaveBeenCalledWith(
      "scope",
      "sinceUser",
      expect.objectContaining({ key: "scope" }),
    );
  });

  it("left/right arrow keys on a short enum cycle backward and forward via onChange", () => {
    const onChange = vi.fn();
    const fields: Field[] = [
      {
        key: "scope",
        type: "enum",
        label: "Scope",
        value: "last",
        options: ["last", "sinceUser", "all"],
      },
    ];
    const body = createSettingsModalBody(
      { fields, onChange },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);

    // Starting at "last"
    // Press right -> goes to "sinceUser"
    body.handleInput?.("\x1b[C"); // Right
    expect(onChange).toHaveBeenCalledWith(
      "scope",
      "sinceUser",
      expect.objectContaining({ key: "scope" }),
    );

    // Reset and test Left from "last"
    const onChangeLeft = vi.fn();
    const bodyLeft = createSettingsModalBody(
      { fields, onChange: onChangeLeft },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );
    bodyLeft.render(80);

    // Press left from "last" -> goes to "all" (wrap backward)
    bodyLeft.handleInput?.("\x1b[D"); // Left
    expect(onChangeLeft).toHaveBeenCalledWith(
      "scope",
      "all",
      expect.objectContaining({ key: "scope" }),
    );
  });

  it("Esc closes the modal (no value commit)", () => {
    const onChange = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [
      { key: "x", type: "boolean", label: "X", value: false },
    ];
    const body = createSettingsModalBody(
      { fields, onChange },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    body.handleInput?.("\x1b"); // ESC

    expect(close).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Model field with hideEffort renders without an effort row", () => {
    const onChange = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [
      {
        key: "searchModel",
        type: "model",
        label: "Search model",
        value: { id: "" },
        hideSession: true,
        hideEffort: true,
        // Skip registry discovery so the test stays self-contained.
        models: [
          { value: "anthropic/claude-haiku-4-5", label: "Haiku" },
          { value: "anthropic/claude-sonnet-4-7", label: "Sonnet" },
        ],
      },
    ];
    const body = createSettingsModalBody(
      { fields, onChange },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    body.handleInput?.("\r"); // open submenu
    const lines = body.render(80).join("\n");
    // The effortless variant's submenu footer drops the `←→ effort` hint
    // and the in-row effort indicator.
    expect(lines).toContain("↑↓ model");
    expect(lines).not.toContain("←→ effort");
  });

  it("footer hints survive cursor overshoot past the last row", () => {
    // Regression: pressing down on the last row used to leave
    // `selected` out of bounds for one render, dropping the
    // row-specific footer hint until the next render clamped it.
    const fields: Field[] = [
      { key: "a", type: "boolean", label: "A", value: false },
      { key: "b", type: "boolean", label: "B", value: true },
    ];
    const body = createSettingsModalBody(
      { fields },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);
    body.handleInput?.("\x1b[B"); // Down
    body.handleInput?.("\x1b[B"); // Down (would overshoot — only 2 rows)
    body.handleInput?.("\x1b[B"); // Down (more overshoot)
    const lines = body.render(80).join("\n");
    // Footer must still contain the focused row's Enter hint.
    expect(lines).toMatch(/enter\/space/);
  });

  it("model effort row uses thinkingLevelMap overrides when present", () => {
    // Regression: the picker used to show the canonical pi level name
    // (`xhigh`) where statusline shows the model-supplied override
    // (e.g. `60000` token budget for Anthropic xhigh).
    const fakeModel = {
      id: "claude-fake",
      name: "Fake",
      provider: "anthropic",
      thinkingLevelMap: { xhigh: "60000", high: "30000" },
    } as unknown as import("@earendil-works/pi-ai").Model<
      import("@earendil-works/pi-ai").Api
    >;
    const fields: Field[] = [
      {
        key: "m",
        type: "model",
        label: "M",
        value: { id: "anthropic/claude-fake", thinking: "xhigh" },
        models: [
          {
            value: "anthropic/claude-fake",
            label: "Fake",
            model: fakeModel,
          },
        ],
      },
    ];
    const body = createSettingsModalBody(
      { fields },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    // Main-window row label honours the override (e.g. `·  60000`).
    expect(body.render(80).join("\n")).toMatch(/60000/);

    body.handleInput?.("\r"); // open submenu
    const submenu = body.render(80).join("\n");
    // Submenu effort row shows the override + the canonical name in
    // dim parens for power users.
    expect(submenu).toMatch(/60000/);
    expect(submenu).toMatch(/\(xhigh\)/);
  });

  it("Enter on a long enum mounts a submenu instead of cycling", () => {
    const onChange = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [
      {
        key: "voice",
        type: "enum",
        label: "Voice",
        value: "Zephyr",
        options: ["Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda"],
      },
    ];
    const body = createSettingsModalBody(
      { fields, onChange },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    body.handleInput?.("\r"); // open submenu

    // No commit yet — submenu was opened.
    expect(onChange).not.toHaveBeenCalled();

    // Re-render: the submenu is now mounted, so the body's frame title
    // changes to `<key> →`.
    const lines = body.render(80);
    const titleLine = lines[0] ?? "";
    expect(titleLine).toContain("voice");
  });

  it("enum selection submenu displays standard selection and cancellation hints", () => {
    const fields: Field[] = [
      {
        key: "voice",
        type: "enum",
        label: "Voice",
        value: "Zephyr",
        options: ["Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda"],
      },
    ];
    const body = createSettingsModalBody(
      { fields },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);
    body.handleInput?.("\r"); // open submenu

    const lines = body.render(80).join("\n");
    expect(lines).toContain("↑↓ select");
    expect(lines).toContain("enter/space save");
    expect(lines).toContain("esc cancel");
  });

  it("alt+↓ on a reorderable row swaps it with the next reorderable peer", () => {
    // Three reorderable rows + one non-reorderable separator at the
    // tail — mirrors the statusline Layout tab's structure.
    const onReorder = vi.fn();
    const fields: Field[] = [
      { key: "a", type: "boolean", label: "A", value: true, reorderable: true },
      {
        key: "b",
        type: "boolean",
        label: "B",
        value: false,
        reorderable: true,
      },
      { key: "c", type: "boolean", label: "C", value: true, reorderable: true },
      { key: "sep", type: "boolean", label: "Sep", value: false },
    ];
    const body = createSettingsModalBody(
      { fields, onReorder },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);
    // Selected starts at row 0 ("a"). Press alt+↓ to swap with "b".
    body.handleInput?.("\x1b[1;3B"); // alt+down (kitty/xterm sequence)
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith({
      fieldKey: "a",
      fromIndex: 0,
      toIndex: 1,
    });

    // The render now shows the swapped order; "b" is at visible row 0.
    const lines = body.render(80).join("\n");
    // Row 0 label should be "B" (just swapped from row 1), row 1
    // should be "A" (the moved row, focus followed).
    const firstRow = lines.split("\n").find((l) => l.includes("B "));
    const secondRow = lines.split("\n").find((l) => l.includes("A "));
    expect(firstRow).toBeTruthy();
    expect(secondRow).toBeTruthy();
    // "A" line must appear AFTER "B" line in render output.
    expect(lines.indexOf("B ")).toBeLessThan(lines.indexOf("A "));
  });

  it("alt+↑ at the head of a reorderable group is a no-op (but consumes the keystroke)", () => {
    const onReorder = vi.fn();
    const fields: Field[] = [
      { key: "a", type: "boolean", label: "A", value: true, reorderable: true },
      {
        key: "b",
        type: "boolean",
        label: "B",
        value: false,
        reorderable: true,
      },
    ];
    const body = createSettingsModalBody(
      { fields, onReorder },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);
    body.handleInput?.("\x1b[1;3A"); // alt+up at row 0
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("field.dim=true forces a muted label even when focused", () => {
    // Sanity: a focused row normally renders its label with the
    // `text` colour. `dim: true` overrides that to `muted`.
    const seen: string[] = [];
    const captureTheme: Theme = {
      ...fakeTheme(),
      fg: (color: string, text: string) => {
        if (text === "Disabled") seen.push(color);
        return text;
      },
    } as Theme;
    const fields: Field[] = [
      { key: "x", type: "boolean", label: "Disabled", value: false, dim: true },
    ];
    const body = createSettingsModalBody(
      { fields },
      { tui: fakeTui(), theme: captureTheme, ctx: fakeCtx(), close: vi.fn() },
    );
    body.render(80);
    expect(seen).toContain("muted");
    expect(seen).not.toContain("text");
  });

  it("field.dim=false forces an active label even when NOT focused", () => {
    // Second row starts unselected. Without `dim: false` the label
    // would render with `muted`; the override flips it to `text`.
    const seen: string[] = [];
    const captureTheme: Theme = {
      ...fakeTheme(),
      fg: (color: string, text: string) => {
        if (text === "Active") seen.push(color);
        return text;
      },
    } as Theme;
    const fields: Field[] = [
      { key: "a", type: "boolean", label: "Focused", value: true },
      { key: "b", type: "boolean", label: "Active", value: false, dim: false },
    ];
    const body = createSettingsModalBody(
      { fields },
      { tui: fakeTui(), theme: captureTheme, ctx: fakeCtx(), close: vi.fn() },
    );
    body.render(80);
    expect(seen).toContain("text");
    expect(seen).not.toContain("muted");
  });

  it("field.dim=fn re-evaluates on every render so live state drives the color", () => {
    let isDisabled = false;
    const seen: string[] = [];
    const captureTheme: Theme = {
      ...fakeTheme(),
      fg: (color: string, text: string) => {
        if (text === "Block") seen.push(color);
        return text;
      },
    } as Theme;
    const fields: Field[] = [
      {
        key: "b",
        type: "boolean",
        label: "Block",
        value: true,
        dim: () => isDisabled,
      },
    ];
    const body = createSettingsModalBody(
      { fields },
      { tui: fakeTui(), theme: captureTheme, ctx: fakeCtx(), close: vi.fn() },
    );
    body.render(80);
    // First render: not disabled → text (because focused) or text
    // (because dim() returned false). Either way: text.
    expect(seen).toEqual(["text"]);

    isDisabled = true;
    seen.length = 0;
    body.render(80);
    // Second render: dim() now returns true → muted regardless of
    // focus.
    expect(seen).toEqual(["muted"]);
  });

  it("CustomField.hints override replaces the default 'enter open/edit' heuristic", () => {
    // A custom field with no `openSubmenu` and a `handleInput` would
    // normally advertise `enter edit`. The `hints` override replaces
    // that with whatever the caller wants.
    const fields: Field[] = [
      {
        key: "x",
        type: "custom",
        label: "Custom",
        value: false,
        render: () => "[ ]",
        handleInput: () => false,
        hints: [{ key: "space", label: "toggle" }],
      },
    ];
    const body = createSettingsModalBody(
      { fields },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );
    const out = body.render(80).join("\n");
    expect(out).toContain("space toggle");
    expect(out).not.toContain("enter edit");
    expect(out).not.toContain("enter open");
  });

  it("alt+↓ next to a non-reorderable neighbour does NOT swap", () => {
    // The reorderable "a" sits directly above a non-reorderable
    // "sep". Pressing alt+↓ must NOT swap them — the contract is that
    // the immediate neighbour must also be reorderable.
    const onReorder = vi.fn();
    const fields: Field[] = [
      { key: "a", type: "boolean", label: "A", value: true, reorderable: true },
      { key: "sep", type: "boolean", label: "Sep", value: false }, // not reorderable
      {
        key: "b",
        type: "boolean",
        label: "B",
        value: false,
        reorderable: true,
      },
    ];
    const body = createSettingsModalBody(
      { fields, onReorder },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);
    body.handleInput?.("\x1b[1;3B"); // alt+down at row 0
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("renders search bar placeholder and footer hints when search is enabled", () => {
    const fields: Field[] = [
      { key: "bool", type: "boolean", label: "Bool", value: false },
    ];
    const body = createSettingsModalBody(
      { title: "test", fields, enableSearch: true },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    let output = body.render(80).join("\n");
    // Should render the placeholder when search query is empty
    expect(output).toContain("Search settings...");
    // Should show "type to search" hint in the footer
    expect(output).toContain("type to search");

    // Simulate user typing a search query 'b'
    body.handleInput?.("b");
    output = body.render(80).join("\n");
    // Should render the search query, not placeholder
    expect(output).not.toContain("Search settings...");
    expect(output).toContain("> b");
    // Should show "ctrl+u clear" hint in the footer
    expect(output).toContain("ctrl+u clear");
  });

  it("allows search bar input typing even when there are zero search matches", () => {
    const fields: Field[] = [
      { key: "bool", type: "boolean", label: "Bool", value: false },
    ];
    const body = createSettingsModalBody(
      { title: "test", fields, enableSearch: true },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);
    // User types 'x' which doesn't match 'Bool'
    body.handleInput?.("x");
    let output = body.render(80).join("\n");
    expect(output).toContain("> x");
    expect(output).toContain("No matching settings.");

    // User can still continue typing 'y' even though there are zero matches (row is undefined)
    body.handleInput?.("y");
    output = body.render(80).join("\n");
    expect(output).toContain("> xy");
    expect(output).toContain("No matching settings.");
  });

  it("pressing escape when search has active text clears the search query and resets selection instead of closing the modal", () => {
    const fields: Field[] = [
      { key: "bool", type: "boolean", label: "Bool", value: false },
    ];
    const close = vi.fn();
    const body = createSettingsModalBody(
      { title: "test", fields, enableSearch: true },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    body.handleInput?.("b");
    let output = body.render(80).join("\n");
    expect(output).toContain("> b");
    expect(output).toContain("esc clear");
    expect(output).toContain("search");

    // Press escape
    body.handleInput?.("\x1b");

    output = body.render(80).join("\n");
    // Search query is cleared (placeholder shown)
    expect(output).toContain("Search settings...");
    expect(output).not.toContain("esc clear");
    expect(close).not.toHaveBeenCalled();
  });

  it("pressing escape when search is already empty closes the modal", () => {
    const fields: Field[] = [
      { key: "bool", type: "boolean", label: "Bool", value: false },
    ];
    const close = vi.fn();
    const body = createSettingsModalBody(
      { title: "test", fields, enableSearch: true },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    // Press escape on empty search
    body.handleInput?.("\x1b");

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("search uses fuzzy matching so non-consecutive queries still match", () => {
    // "Bool" contains "b", "o", "l" in order but not consecutively
    // as the substring "bol". Fuzzy matching should still find it.
    const fields: Field[] = [
      { key: "bool", type: "boolean", label: "Bool", value: false },
    ];
    const body = createSettingsModalBody(
      { title: "test", fields, enableSearch: true },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);
    // Type "bol" — not a substring of "bool" (lowercase)
    body.handleInput?.("b");
    body.handleInput?.("o");
    body.handleInput?.("l");
    const output = body.render(80).join("\n");
    // Should still match "Bool" via fuzzy matching, not show "No matching settings."
    expect(output).not.toContain("No matching settings.");
    expect(output).toContain("> bol");
  });

  it("search matches across label, description, and key", () => {
    const fields: Field[] = [
      {
        key: "voice_model",
        type: "string",
        label: "Voice Model",
        value: "",
        description: "The model used for voice synthesis",
      },
    ];
    const body = createSettingsModalBody(
      { title: "test", fields, enableSearch: true },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);
    // Query matches the key but not the label
    body.handleInput?.("voice_model");
    let output = body.render(80).join("\n");
    expect(output).not.toContain("No matching settings.");

    // Reset and query matches description only
    body.handleInput?.("\x1b"); // clear
    body.handleInput?.("synthesis");
    output = body.render(80).join("\n");
    expect(output).not.toContain("No matching settings.");
  });

  it("properly honors disabled state for string and other fields", () => {
    const onChange = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [
      {
        key: "disabled_str",
        type: "string",
        label: "Disabled Str",
        value: "cant_touch_this",
        disabled: true,
      },
      {
        key: "disabled_bool",
        type: "boolean",
        label: "Disabled Bool",
        value: false,
        disabled: true,
      },
    ];
    const body = createSettingsModalBody(
      { fields, onChange },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    const initialRender = body.render(80).join("\n");
    // Ensure "Disabled Str" renderer does not display the edit hints
    expect(initialRender).not.toMatch(/enter edit/);

    // Try to edit the first row (disabled string)
    body.handleInput?.("\r"); // Enter
    const afterEnterRender = body.render(80).join("\n");

    // Check that we are NOT in editing mode (i.e. hints don't change to inline-editing ones, no cursor/save hints)
    expect(afterEnterRender).not.toMatch(/save/);
    expect(afterEnterRender).not.toMatch(/cancel/);
    expect(onChange).not.toHaveBeenCalled();

    // Try to move to the second row (disabled bool) and activate it
    body.handleInput?.("\x1b[B"); // Down
    body.handleInput?.("\r"); // Enter/Space
    expect(onChange).not.toHaveBeenCalled();
  });

  it("properly honors disabled state for custom fields by muting their rendered value", () => {
    // Capture theme calls so we can check color wrapping
    const seenColors: string[] = [];
    const captureTheme: Theme = {
      ...fakeTheme(),
      fg: (color: string, text: string) => {
        if (text === "custom_val") {
          seenColors.push(color);
        }
        return text;
      },
    } as Theme;

    const fields: Field[] = [
      {
        key: "disabled_custom",
        type: "custom",
        label: "Disabled Custom",
        value: "custom_val",
        disabled: true,
        render: (a) => String(a.value),
      },
    ];

    const body = createSettingsModalBody(
      { fields },
      { tui: fakeTui(), theme: captureTheme, ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);
    // Since it's disabled, the custom renderer's value should be wrapped in "muted"
    expect(seenColors).toContain("muted");
  });

  it("colors the search query with warning color when there are zero search matches", () => {
    const fields: Field[] = [
      { key: "bool", type: "boolean", label: "Bool", value: false },
    ];
    const seenColors: { color: string; text: string }[] = [];
    const captureTheme: Theme = {
      ...fakeTheme(),
      fg: (color: string, text: string) => {
        seenColors.push({ color, text });
        return text;
      },
    } as Theme;

    const body = createSettingsModalBody(
      { title: "test", fields, enableSearch: true },
      { tui: fakeTui(), theme: captureTheme, ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);
    // User types 'x' which doesn't match 'Bool'
    body.handleInput?.("x");
    body.render(80);

    // Find if 'x' was colored with 'warning'
    const warningMatch = seenColors.find(
      (c) => c.text === "x" && c.color === "warning",
    );
    expect(warningMatch).toBeDefined();

    // Now user types 'b' (part of 'Bool'), which matches, so the warning color should NOT be used
    body.handleInput?.("\x7f"); // Clear 'x'
    body.handleInput?.("b");
    seenColors.length = 0; // Clear recorded colors
    body.render(80);

    const hasWarning = seenColors.some((c) => c.color === "warning");
    expect(hasWarning).toBe(false);
  });

  it("model selection filter submenu supports escape to clear, dynamic hints, and empty states", () => {
    const fields: Field[] = [
      {
        key: "model_field",
        type: "model",
        label: "Model Field",
        value: { id: "openai/gpt-4" },
        models: [
          { value: "openai/gpt-4", label: "GPT-4" },
          { value: "anthropic/claude-3", label: "Claude 3" },
        ],
      },
    ];
    const body = createSettingsModalBody(
      { fields },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    // 1. Open submenu
    body.render(80);
    body.handleInput?.("\r"); // enter to open submenu
    let output = body.render(80).join("\n");
    expect(output).toContain("esc cancel");

    // 2. Type filter query 'c' to match Claude
    body.handleInput?.("c");
    output = body.render(80).join("\n");
    expect(output).toContain("esc clear filter");

    // 3. Press escape to clear filter query
    body.handleInput?.("\x1b");
    output = body.render(80).join("\n");
    expect(output).toContain("esc cancel");

    // 4. Type non-matching filter query 'xyz'
    body.handleInput?.("x");
    body.handleInput?.("y");
    body.handleInput?.("z");
    output = body.render(80).join("\n");
    expect(output).toContain("No matching models. (press esc to clear)");

    // 5. Clear again
    body.handleInput?.("\x1b");
    output = body.render(80).join("\n");
    expect(output).not.toContain("No matching models. (press esc to clear)");
    expect(output).toContain("esc cancel");
  });

  it("displays tab/shift+tab cycle hint when multiple tabs are configured", () => {
    const fields: Field[] = [
      { key: "a", type: "boolean", label: "A", value: true, tab: "tab1" },
      { key: "b", type: "boolean", label: "B", value: false, tab: "tab2" },
    ];
    const tabs = [
      { id: "tab1", label: "Tab 1" },
      { id: "tab2", label: "Tab 2" },
    ];
    const body = createSettingsModalBody(
      { fields, tabs },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    const output = body.render(80).join("\n");
    expect(output).toContain("tab/shift+tab");
    expect(output).toContain("cycle");
  });

  it("appends boundaries and integer constraints to NumberField descriptions", () => {
    const fields: Field[] = [
      {
        key: "num",
        type: "number",
        label: "Number Setting",
        value: 10,
        min: 1,
        max: 100,
        integer: true,
        description: "Set the timeout value.",
      },
    ];
    const body = createSettingsModalBody(
      { fields },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    const output = body.render(80).join("\n");
    expect(output).toContain(
      "Set the timeout value. (range: 1 to 100, integer only)",
    );
  });

  it("appends min or max and integer constraints to NumberField descriptions", () => {
    const fields1: Field[] = [
      {
        key: "num1",
        type: "number",
        label: "Number Setting 1",
        value: 10,
        min: 5,
        description: "Set minimum.",
      },
    ];
    const body1 = createSettingsModalBody(
      { fields: fields1 },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );
    expect(body1.render(80).join("\n")).toContain("Set minimum. (min: 5)");

    const fields2: Field[] = [
      {
        key: "num2",
        type: "number",
        label: "Number Setting 2",
        value: 10,
        max: 50,
        integer: true,
      },
    ];
    const body2 = createSettingsModalBody(
      { fields: fields2 },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );
    expect(body2.render(80).join("\n")).toContain("(max: 50, integer only)");
  });

  it("displays ctrl+r reset field hint when a field has a default value defined and is not disabled or editing", () => {
    const fields: Field[] = [
      {
        key: "num",
        type: "number",
        label: "Number Setting",
        value: 10,
        default: 5,
      },
    ];
    const body = createSettingsModalBody(
      { fields },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    const output = body.render(80).join("\n");
    expect(output).toContain("ctrl+r");
    expect(output).toContain("reset field");
  });

  it("pressing alt+r resets the field value to default and calls onChange", () => {
    const onChange = vi.fn();
    const fields: Field[] = [
      {
        key: "num",
        type: "number",
        label: "Number Setting",
        value: 10,
        default: 5,
      },
    ];
    const body = createSettingsModalBody(
      { fields, onChange },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80); // mount
    body.handleInput?.("\x1br"); // alt+r

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      "num",
      5,
      expect.objectContaining({ key: "num" }),
    );
  });

  it("pressing alt+r does not reset the value if the field is disabled or currently editing", () => {
    const onChange = vi.fn();
    const fields: Field[] = [
      {
        key: "num",
        type: "number",
        label: "Number Setting",
        value: 10,
        default: 5,
        disabled: true,
      },
    ];
    const body = createSettingsModalBody(
      { fields, onChange },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80); // mount
    body.handleInput?.("\x1br"); // alt+r

    expect(onChange).not.toHaveBeenCalled();
  });

  // ── NumberField step-based UX (ported from blackhole) ──
  it("number with step: Enter starts inline edit instead of stepping", () => {
    const onChange = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [
      {
        key: "num",
        type: "number",
        label: "Num",
        value: 10,
        min: 0,
        max: 100,
        step: 5,
      },
    ];
    const body = createSettingsModalBody(
      { fields, onChange },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    body.handleInput?.("\r"); // Enter

    // Should start editing, not step
    expect(onChange).not.toHaveBeenCalled();
    // Re-render should show editing state
    const lines = body.render(80).join("\n");
    expect(lines).toContain("█"); // cursor block from inline edit
  });

  it("number with step: left/right arrows step when not editing", () => {
    const onChange = vi.fn();
    const fields: Field[] = [
      {
        key: "num",
        type: "number",
        label: "Num",
        value: 10,
        min: 0,
        max: 100,
        step: 5,
      },
    ];
    const body = createSettingsModalBody(
      { fields, onChange },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);

    // Right -> step up to 15
    body.handleInput?.("\x1b[C");
    expect(onChange).toHaveBeenCalledWith(
      "num",
      15,
      expect.objectContaining({ key: "num" }),
    );

    onChange.mockClear();

    // Left from 15 -> step down to 10
    body.handleInput?.("\x1b[D");
    expect(onChange).toHaveBeenCalledWith(
      "num",
      10,
      expect.objectContaining({ key: "num" }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// New generic body APIs
// ─────────────────────────────────────────────────────────────────────

describe("generic body APIs", () => {
  it("actions render as pill strip and Tab cycles through them", () => {
    const onAction = vi.fn();
    const fields: Field[] = [
      { key: "x", type: "boolean", label: "X", value: false },
    ];
    const tabs = [{ id: "t1", label: "Tab 1" }];
    const actions = [
      { id: "save", label: "Save" },
      { id: "cancel", label: "Cancel", danger: true },
    ];
    const body = createSettingsModalBody(
      { fields, tabs, actions, onAction },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);
    // Focus starts on the tab
    expect(body.render(80).join("\n")).toContain("▸ Tab 1");
    // Tab → Save action
    body.handleInput?.("\t");
    expect(body.render(80).join("\n")).toContain("Save");
    // Tab → Cancel action
    body.handleInput?.("\t");
    expect(body.render(80).join("\n")).toContain("Cancel");
    // Tab → back to Tab 1
    body.handleInput?.("\t");
    expect(body.render(80).join("\n")).toContain("▸ Tab 1");
  });

  it("Enter on enabled action calls onAction", () => {
    const onAction = vi.fn();
    const fields: Field[] = [
      { key: "x", type: "boolean", label: "X", value: false },
    ];
    const actions = [{ id: "save", label: "Save" }];
    const body = createSettingsModalBody(
      { fields, actions, onAction },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);
    body.handleInput?.("\t"); // focus action
    body.handleInput?.("\r"); // Enter

    expect(onAction).toHaveBeenCalledWith("save");
  });

  it("disabled action is a no-op on Enter and remains a Tab stop", () => {
    const onAction = vi.fn();
    const isDisabled = true;
    const fields: Field[] = [
      { key: "x", type: "boolean", label: "X", value: false },
    ];
    const actions = [{ id: "save", label: "Save", disabled: () => isDisabled }];
    const body = createSettingsModalBody(
      { fields, actions, onAction },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);
    body.handleInput?.("\t"); // focus action
    body.handleInput?.("\r"); // Enter

    expect(onAction).not.toHaveBeenCalled();
  });

  it("onRequestExit defers dirty Esc instead of mounting built-in confirm", () => {
    const onRequestExit = vi.fn();
    const fields: Field[] = [
      { key: "x", type: "boolean", label: "X", value: false },
    ];
    const body = createSettingsModalBody(
      { fields, mode: "buffered", onSave: vi.fn(), onRequestExit },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);
    body.handleInput?.("\r"); // toggle → dirty
    body.handleInput?.("\x1b"); // Escape

    expect(onRequestExit).toHaveBeenCalledTimes(1);
    expect(body.render(80).join("\n")).not.toContain(
      "You have unsaved changes.",
    );
  });

  it("readOnly blocks edits but renders rows normally", () => {
    const onChange = vi.fn();
    const fields: Field[] = [
      { key: "x", type: "boolean", label: "X", value: false },
    ];
    const body = createSettingsModalBody(
      { fields, readOnly: true, onChange },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);
    expect(body.render(80).join("\n")).toContain("X");
    body.handleInput?.("\r");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("readOnly suppresses row-specific footer hints", () => {
    const fields: Field[] = [
      { key: "x", type: "boolean", label: "X", value: false },
    ];
    const body = createSettingsModalBody(
      { fields, readOnly: true },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    const out = body.render(80).join("\n");
    expect(out).not.toMatch(/enter\/space/);
  });

  it("setValues updates matching rows, clears dirty, and re-snapshots", () => {
    const onSave = vi.fn();
    const fields: Field[] = [
      { key: "a", type: "boolean", label: "A", value: false },
      { key: "b", type: "boolean", label: "B", value: false },
    ];
    const body = createSettingsModalBody(
      { title: "test", fields, mode: "buffered", onSave },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);
    body.handleInput?.("\r"); // toggle a → dirty
    expect(body.render(80).join("\n")).toContain("●");

    body.setValues({ a: true, b: true });
    expect(body.render(80).join("\n")).not.toContain("●");
    expect(body.render(80).join("\n")).toContain("on");
  });

  it("mountOverlay and dismissOverlay control the overlay slot", () => {
    const fields: Field[] = [
      { key: "x", type: "boolean", label: "X", value: false },
    ];
    const body = createSettingsModalBody(
      { fields },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    const overlay = {
      render: () => ["overlay content"],
      handleInput: () => {},
      invalidate: () => {},
    };
    body.mountOverlay(overlay as any, "Test overlay");
    expect(body.render(80).join("\n")).toContain("Test overlay");

    body.dismissOverlay();
    expect(body.render(80).join("\n")).not.toContain("Test overlay");
  });

  it("onActiveTabChange fires after every active tab change, not on mount", () => {
    const onActiveTabChange = vi.fn();
    const fields: Field[] = [
      { key: "x", type: "boolean", label: "X", value: false },
    ];
    const tabs = [
      { id: "tab1", label: "Tab 1" },
      { id: "tab2", label: "Tab 2" },
    ];
    const body = createSettingsModalBody(
      { fields, tabs, onActiveTabChange },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    expect(onActiveTabChange).not.toHaveBeenCalled();

    body.handleInput?.("\t");
    expect(onActiveTabChange).toHaveBeenCalledWith("tab2");

    body.handleInput?.("\t");
    expect(onActiveTabChange).toHaveBeenCalledWith("tab1");
  });

  it("left/right arrow keys cycle through tabs and actions when tabActionFocus is active", () => {
    const onAction = vi.fn();
    const onActiveTabChange = vi.fn();
    const fields: Field[] = [
      { key: "x", type: "boolean", label: "X", value: false },
    ];
    const tabs = [
      { id: "t1", label: "Tab 1" },
      { id: "t2", label: "Tab 2" },
    ];
    const actions = [
      { id: "save", label: "Save" },
      { id: "cancel", label: "Cancel", danger: true },
    ];
    const body = createSettingsModalBody(
      { fields, tabs, actions, onAction, onActiveTabChange },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);
    // Focus starts on Tab 1; Tab to enter ring on Tab 2
    body.handleInput?.("\t");
    expect(body.render(80).join("\n")).toContain("▸ Tab 2");

    // → moves to Save action
    body.handleInput?.("\x1b[C");
    expect(body.render(80).join("\n")).toContain("Save");

    // → moves to Cancel action
    body.handleInput?.("\x1b[C");
    expect(body.render(80).join("\n")).toContain("Cancel");

    // → wraps to Tab 1
    body.handleInput?.("\x1b[C");
    expect(body.render(80).join("\n")).toContain("▸ Tab 1");

    // ← from Tab 1 wraps to Cancel
    body.handleInput?.("\x1b[D");
    expect(body.render(80).join("\n")).toContain("Cancel");

    // ← from Cancel moves to Save
    body.handleInput?.("\x1b[D");
    expect(body.render(80).join("\n")).toContain("Save");

    // ← from Save moves to Tab 2 (switches tab)
    body.handleInput?.("\x1b[D");
    expect(body.render(80).join("\n")).toContain("▸ Tab 2");
  });

  it("left/right in readOnly field zone enters the action row", () => {
    const fields: Field[] = [
      { key: "x", type: "boolean", label: "X", value: false },
    ];
    const tabs = [{ id: "t1", label: "Tab 1" }];
    const actions = [
      { id: "save", label: "Save" },
      { id: "cancel", label: "Cancel" },
    ];
    const body = createSettingsModalBody(
      { fields, tabs, actions, readOnly: true },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);
    // Field zone: tabActionFocus === -1
    expect(body.render(80).join("\n")).toContain("X");

    // → enters at first action
    body.handleInput?.("\x1b[C");
    expect(body.render(80).join("\n")).toContain("Save");

    // → from first action wraps to last action (action row only)
    body.handleInput?.("\x1b[C");
    expect(body.render(80).join("\n")).toContain("Cancel");

    // ← from last action wraps to first action (action row only)
    body.handleInput?.("\x1b[D");
    expect(body.render(80).join("\n")).toContain("Save");
  });

  it("left/right from readOnly tab focus enters the action row", () => {
    const fields: Field[] = [
      { key: "x", type: "boolean", label: "X", value: false },
    ];
    const tabs = [{ id: "t1", label: "Tab 1" }];
    const actions = [
      { id: "save", label: "Save" },
      { id: "cancel", label: "Cancel" },
    ];
    const body = createSettingsModalBody(
      { fields, tabs, actions, readOnly: true },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);
    // Tab to focus the tab
    body.handleInput?.("\t");
    expect(body.render(80).join("\n")).toContain("▸ Tab 1");

    // → from tab focus enters at first action
    body.handleInput?.("\x1b[C");
    expect(body.render(80).join("\n")).toContain("Save");

    // ← from tab focus enters at last action
    body.handleInput?.("\x1b[D");
    expect(body.render(80).join("\n")).toContain("Cancel");
  });

  it("Tab in readOnly cycles through tabs; Shift+Tab cycles backward", () => {
    const onActiveTabChange = vi.fn();
    const fields: Field[] = [
      { key: "x", type: "boolean", label: "X", value: false },
    ];
    const tabs = [
      { id: "t1", label: "Tab 1" },
      { id: "t2", label: "Tab 2" },
      { id: "t3", label: "Tab 3" },
    ];
    const actions = [
      { id: "save", label: "Save" },
      { id: "cancel", label: "Cancel" },
    ];
    const body = createSettingsModalBody(
      { fields, tabs, actions, readOnly: true, onActiveTabChange },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    // On mount, first tab is pre-focused in readOnly mode
    expect(body.render(80).join("\n")).toContain("▸ Tab 1");

    // Tab: focus moves to tab 2 (activeTabId switches because tab 2 ≠ tab 1)
    body.handleInput?.("\t");
    expect(body.render(80).join("\n")).toContain("▸ Tab 2");
    expect(onActiveTabChange).toHaveBeenCalledWith("t2");

    // Tab from tab 2 → tab 3
    body.handleInput?.("\t");
    expect(body.render(80).join("\n")).toContain("▸ Tab 3");
    expect(onActiveTabChange).toHaveBeenCalledWith("t3");

    // Shift+Tab from tab 3 → back to tab 2
    body.handleInput?.("\x1b[Z");
    expect(body.render(80).join("\n")).toContain("▸ Tab 2");
    expect(onActiveTabChange).toHaveBeenCalledWith("t2");
  });

  it("left/right in non-readOnly field zone with tabs still delegates to field renderer", () => {
    const onChange = vi.fn();
    const fields: Field[] = [
      { key: "x", type: "boolean", label: "X", value: false },
    ];
    const tabs = [{ id: "t1", label: "Tab 1" }];
    const actions = [{ id: "save", label: "Save" }];
    const body = createSettingsModalBody(
      { fields, tabs, actions, onChange },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);
    // Field zone with non-readOnly: → toggles boolean, does NOT enter action ring
    body.handleInput?.("\x1b[C");
    expect(onChange).toHaveBeenCalledWith(
      "x",
      true,
      expect.objectContaining({ key: "x" }),
    );
    // Focus stays in field zone (no action pill highlighted)
    expect(body.render(80).join("\n")).not.toContain("Save" + "\x1b[7m"); // not inverse-highlighted
  });

  it("closeOnSave: false keeps modal open after successful onSave", () => {
    const onSave = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [
      { key: "x", type: "boolean", label: "X", value: false },
    ];
    const body = createSettingsModalBody(
      { title: "test", fields, mode: "buffered", onSave, closeOnSave: false },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    body.handleInput?.("\r"); // toggle → dirty
    body.handleInput?.("\x13"); // ctrl+s → save

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });
});
