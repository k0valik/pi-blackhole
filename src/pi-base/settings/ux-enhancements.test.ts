import { describe, expect, it, vi, beforeAll } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { numberRenderer, stringRenderer } from "./fields/string";
import { enumRenderer } from "./fields/enum";
import { modelRenderer } from "./fields/model";
import { textRenderer } from "./fields/text";
import { actionRenderer } from "./fields/action";
import { booleanRenderer } from "./fields/boolean";
import { readonlyRenderer } from "./fields/readonly";
import { createScopeSelector } from "./scope-selector";
import { renderFooter, renderFieldDesc, renderTabBar } from "./render";
import type {
  NumberField,
  EnumField,
  StringField,
  TextField,
  ModelField,
  FieldRow,
  FieldRenderContext,
} from "./types";
import type { BodyState } from "./body";

const mockTheme: any = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
};

const mockTui: any = {
  requestRender: vi.fn(),
};

const mockContext: FieldRenderContext = {
  theme: mockTheme,
  tui: mockTui,
  ctx: {} as any,
  requestRender: mockTui.requestRender,
};

describe("UX Enhancements - Submenus and Hints", () => {
  beforeAll(() => {
    initTheme();
  });
  it("makeNumberValuesSubmenu supports 1-9 keypad selection", () => {
    const field: NumberField = {
      key: "ports",
      type: "number",
      label: "Port",
      value: 8080,
      values: [80, 443, 3000, 8080, 9000],
    };
    const row: FieldRow<NumberField, number> = { field, value: 8080 };

    const handleKeyResult = numberRenderer.handleKey(row, " ", {
      isEditing: false,
      ctx: mockContext,
      setEditing: () => {},
    });

    expect(handleKeyResult.consumed).toBe(true);
    expect(handleKeyResult.submenu).toBeDefined();

    let committedValue: number | undefined;
    const submenuComponent = handleKeyResult.submenu!((val) => {
      committedValue = val;
    });

    // Send '2' to select the 2nd option (443)
    submenuComponent.handleInput?.("2");
    expect(committedValue).toBe(443);
  });

  it("makeSearchableEnumSubmenu includes ctrl+u clear hint and supports ctrl+h backspace alias", () => {
    const field: EnumField = {
      key: "theme",
      type: "enum",
      label: "Theme",
      value: "dark",
      options: ["dark", "light", "system"],
      search: true,
    };
    const row: FieldRow<EnumField, string> = { field, value: "dark" };

    const handleKeyResult = enumRenderer.handleKey(row, " ", {
      isEditing: false,
      ctx: mockContext,
      setEditing: () => {},
    });

    expect(handleKeyResult.submenu).toBeDefined();

    const submenuComponent = handleKeyResult.submenu!(() => {});

    // Type 'da' to activate search query
    submenuComponent.handleInput?.("d");
    submenuComponent.handleInput?.("a");

    let lines = submenuComponent.render(80);
    let textOutput = lines.join("\n");
    expect(textOutput).toContain("Search: da");

    // Press ctrl+h to backspace 'a'
    submenuComponent.handleInput?.("\x08"); // ctrl+h / backspace
    lines = submenuComponent.render(80);
    textOutput = lines.join("\n");
    expect(textOutput).toContain("Search: d");

    const hintLine = lines[lines.length - 1];
    expect(hintLine).toContain("ctrl+u clear");
    expect(hintLine).toContain("esc clear filter");
  });

  it("textRenderer submenu includes ctrl+w delete word hint", () => {
    const field: TextField = {
      key: "notes",
      type: "text",
      label: "Notes",
      value: "line1\nline2",
    };
    const row: FieldRow<TextField, string> = { field, value: "line1\nline2" };

    const ctxWithTerminal: FieldRenderContext = {
      ...mockContext,
      tui: {
        ...mockTui,
        terminal: { rows: 24, columns: 80 },
      } as any,
    };

    const handleKeyResult = textRenderer.handleKey(row, "\r", {
      isEditing: false,
      ctx: ctxWithTerminal,
      setEditing: () => {},
    });

    expect(handleKeyResult.submenu).toBeDefined();

    const submenuComponent = handleKeyResult.submenu!(() => {});
    const lines = submenuComponent.render(80);
    const textOutput = lines.join("\n");

    expect(textOutput).toContain("ctrl+w delete word");
    expect(textOutput).toContain("ctrl+u clear");
  });

  it("createScopeSelector renders only esc hint when no available entries exist", () => {
    const done = vi.fn();
    const selector = createScopeSelector({
      title: "Scope",
      entries: [{ id: "global", label: "Global", available: false }],
      tui: mockTui,
      theme: mockTheme,
      done,
    });

    const lines = selector.render(80);
    const hintLine = lines.find((l) => l.includes("esc cancel"));

    expect(hintLine).toBeDefined();
    expect(hintLine).not.toContain("↑↓ select");
    expect(hintLine).not.toContain("confirm");
  });

  it("renderFooter suppresses edit and reset hints for disabled fields", () => {
    const mockState: any = {
      options: { readOnly: false, enableSearch: false },
      args: { theme: mockTheme },
      tabs: [],
      fields: [],
      rows: [
        {
          field: { key: "foo", label: "Foo", type: "boolean", disabled: true, default: false },
          value: false,
          isEditing: false,
        },
      ],
      cachedVisibleIndices: [0],
      fieldSelected: 0,
      scroll: 0,
    };

    const mockRendererFor = () => ({
      hints: () => [{ key: "space", label: "toggle" }],
    });

    const lines = renderFooter(mockState, mockRendererFor as any, 80);
    const joined = lines.join(" ");

    expect(joined).not.toContain("toggle");
    expect(joined).not.toContain("alt+r");
    expect(joined).not.toContain("reset");
  });

  it("renderFooter includes ctrl+w delete word hint when search is active", () => {
    const mockState: any = {
      options: { readOnly: false, enableSearch: true },
      args: { theme: mockTheme },
      tabs: [],
      fields: [],
      search: "test",
      rows: [
        {
          field: { key: "foo", label: "Foo", type: "boolean" },
          value: false,
          isEditing: false,
        },
      ],
      cachedVisibleIndices: [0],
      fieldSelected: 0,
      scroll: 0,
    };

    const mockRendererFor = () => ({
      hints: () => [{ key: "enter", label: "edit" }],
    });

    const lines = renderFooter(mockState, mockRendererFor as any, 80);
    const joined = lines.join(" ");

    expect(joined).toContain("ctrl+w delete word");
    expect(joined).toContain("ctrl+u clear");
    expect(joined).toContain("esc clear search");
  });

  it("stringRenderer advertises ctrl+w and ctrl+u hints during inline editing", () => {
    const field: StringField = {
      key: "name",
      type: "string",
      label: "Name",
      value: "hello",
    };
    const row: FieldRow<StringField, string> = { field, value: "hello" };

    const editingHints = stringRenderer.hints(row, { isEditing: true });
    const keys = editingHints.map((h) => h.key);

    expect(keys).toContain("ctrl+w");
    expect(keys).toContain("ctrl+u");

    const nonEditingHints = stringRenderer.hints(row, { isEditing: false });
    const nonEditingKeys = nonEditingHints.map((h) => h.key);

    expect(nonEditingKeys).not.toContain("ctrl+w");
    expect(nonEditingKeys).not.toContain("ctrl+u");
  });

  it("renderFieldDesc includes disabled note when field is disabled", () => {
    const lines: string[] = [];
    const mockState: any = {
      args: { theme: mockTheme },
    };
    const focusedRow: any = {
      field: {
        key: "foo",
        label: "Foo",
        type: "boolean",
        disabled: true,
        description: "Foo description",
      },
      value: false,
    };

    renderFieldDesc(mockState, lines, 80, focusedRow);
    const joined = lines.join("\n");

    expect(joined).toContain("Foo description (This setting is currently disabled.)");
  });

  it("renderFieldDesc shows disabled note even when field has no existing description", () => {
    const lines: string[] = [];
    const mockState: any = {
      args: { theme: mockTheme },
    };
    const focusedRow: any = {
      field: { key: "foo", label: "Foo", type: "boolean", disabled: true },
      value: false,
    };

    renderFieldDesc(mockState, lines, 80, focusedRow);
    const joined = lines.join("\n");

    expect(joined).toContain("This setting is currently disabled.");
  });

  it("renderFieldDesc uses muted color for valueDescriptions when field is disabled", () => {
    const colors: Record<string, string[]> = {};
    const testTheme: any = {
      ...mockTheme,
      fg: (color: string, text: string) => {
        colors[color] = colors[color] ?? [];
        colors[color]!.push(text);
        return text;
      },
    };
    const mockState: any = { args: { theme: testTheme } };
    const focusedRow: any = {
      field: {
        key: "foo",
        label: "Foo",
        type: "boolean",
        disabled: true,
        valueDescriptions: { on: "Enabled", off: "Disabled" },
      },
      value: true,
    };

    const lines: string[] = [];
    renderFieldDesc(mockState, lines, 80, focusedRow);

    expect(colors["muted"]).toEqual(
      expect.arrayContaining(["  This setting is currently disabled.", "Enabled"]),
    );
    expect(colors["accent"] ?? []).not.toContain("Enabled");
  });

  it("modelRenderer submenu formats zero-match empty state and includes ctrl+w hint when filter is active", () => {
    const field: ModelField = {
      key: "model",
      type: "model",
      label: "Model",
      value: { id: "openai/gpt-4o" },
      models: [{ value: "openai/gpt-4o", label: "GPT-4o" }],
    };
    const row: FieldRow<ModelField, any> = { field, value: { id: "openai/gpt-4o" } };

    const handleKeyResult = modelRenderer.handleKey(row, " ", {
      isEditing: false,
      ctx: mockContext,
      setEditing: () => {},
    });

    expect(handleKeyResult.submenu).toBeDefined();

    const submenuComponent = handleKeyResult.submenu!(() => {});

    // Filter by non-existent model name 'nonexistent'
    submenuComponent.handleInput?.("n");
    submenuComponent.handleInput?.("o");
    submenuComponent.handleInput?.("n");

    const lines = submenuComponent.render(80);
    const textOutput = lines.join("\n");

    expect(textOutput).toContain("No matching models for 'non'");
    expect(textOutput).toContain(". (press esc or ctrl+u to clear)");
    expect(textOutput).toContain("ctrl+w delete word");
  });

  it("searchable enum and model submenus advertise choose keypad hints when multiple items exist", () => {
    const enumField: EnumField = {
      key: "theme",
      type: "enum",
      label: "Theme",
      value: "dark",
      options: ["dark", "light", "system"],
      search: true,
    };
    const enumRow: FieldRow<EnumField, string> = { field: enumField, value: "dark" };

    const enumResult = enumRenderer.handleKey(enumRow, " ", {
      isEditing: false,
      ctx: mockContext,
      setEditing: () => {},
    });
    const enumSubmenu = enumResult.submenu!(() => {});
    const enumLines = enumSubmenu.render(80);
    const enumHintLine = enumLines[enumLines.length - 1]!;
    expect(enumHintLine).toContain("1-3 choose");

    const modelField: ModelField = {
      key: "model",
      type: "model",
      label: "Model",
      value: { id: "openai/gpt-4o" },
      models: [
        { value: "openai/gpt-4o", label: "GPT-4o" },
        { value: "anthropic/claude-3-5-sonnet", label: "Claude 3.5 Sonnet" },
      ],
    };
    const modelRow: FieldRow<ModelField, any> = {
      field: modelField,
      value: { id: "openai/gpt-4o" },
    };

    const modelResult = modelRenderer.handleKey(modelRow, " ", {
      isEditing: false,
      ctx: mockContext,
      setEditing: () => {},
    });
    const modelSubmenu = modelResult.submenu!(() => {});
    const modelLines = modelSubmenu.render(80);
    const modelHintLine = modelLines[modelLines.length - 1]!;
    expect(modelHintLine).toContain("1-2 choose");
  });

  it("searchable enum and model submenus display clear empty states when zero options exist and search is empty", () => {
    const enumField: EnumField = {
      key: "theme",
      type: "enum",
      label: "Theme",
      value: "",
      options: [],
      search: true,
    };
    const enumRow: FieldRow<EnumField, string> = { field: enumField, value: "" };

    const enumResult = enumRenderer.handleKey(enumRow, " ", {
      isEditing: false,
      ctx: mockContext,
      setEditing: () => {},
    });
    const enumSubmenu = enumResult.submenu!(() => {});
    const enumOutput = enumSubmenu.render(80).join("\n");
    expect(enumOutput).toContain("No options available. (press esc to cancel)");

    const modelField: ModelField = {
      key: "model",
      type: "model",
      label: "Model",
      value: { id: "" },
      models: [],
    };
    const modelRow: FieldRow<ModelField, any> = { field: modelField, value: { id: "" } };

    const modelResult = modelRenderer.handleKey(modelRow, " ", {
      isEditing: false,
      ctx: mockContext,
      setEditing: () => {},
    });
    const modelSubmenu = modelResult.submenu!(() => {});
    const modelOutput = modelSubmenu.render(80).join("\n");
    expect(modelOutput).toContain("No models available. (press esc to cancel)");
  });

  it("renderers strictly enforce disabled field guards for hints and handleKey", () => {
    const actionField: any = { key: "act", type: "action", label: "Action", disabled: true };
    expect(
      actionRenderer.hints({ field: actionField, value: undefined }, { isEditing: false }),
    ).toEqual([]);
    expect(
      actionRenderer.handleKey({ field: actionField, value: undefined }, "enter", {
        ctx: mockContext,
      } as any),
    ).toEqual({});

    const boolField: any = { key: "bool", type: "boolean", label: "Bool", disabled: true };
    expect(booleanRenderer.hints({ field: boolField, value: true }, { isEditing: false })).toEqual(
      [],
    );
    expect(
      booleanRenderer.handleKey({ field: boolField, value: true }, "enter", {
        ctx: mockContext,
      } as any),
    ).toEqual({});

    const enumField: any = {
      key: "en",
      type: "enum",
      label: "Enum",
      options: ["a", "b"],
      disabled: true,
    };
    expect(enumRenderer.hints({ field: enumField, value: "a" }, { isEditing: false })).toEqual([]);
    expect(
      enumRenderer.handleKey({ field: enumField, value: "a" }, "enter", {
        ctx: mockContext,
      } as any),
    ).toEqual({});

    const readonlyField: any = { key: "ro", type: "readonly", label: "Readonly", disabled: true };
    expect(
      readonlyRenderer.hints({ field: readonlyField, value: "val" }, { isEditing: false }),
    ).toEqual([]);
    expect(
      readonlyRenderer.handleKey({ field: readonlyField, value: "val" }, "enter", {
        ctx: mockContext,
      } as any),
    ).toEqual({});
  });

  it("renderTabBar renders focused inactive tabs with ▶ prefix and bold styling", () => {
    const mockState: any = {
      args: { theme: mockTheme },
      tabs: [
        { id: "tab1", label: "General" },
        { id: "tab2", label: "Advanced" },
      ],
      rows: [],
      activeTabId: "tab1",
      tabActionFocus: 1, // Focused on inactive tab2
    };

    const rendered = renderTabBar(mockState, 80);
    expect(rendered).toContain("▶ Advanced");
    expect(rendered).toContain("▸ General");
  });

  it("renderFooter includes navigate and trigger action hints when tabActionFocus is active", () => {
    const mockState: any = {
      options: { readOnly: false, enableSearch: false, actions: [{ id: "reset", label: "Reset" }] },
      args: { theme: mockTheme },
      tabs: [{ id: "tab1", label: "General" }],
      fields: [],
      rows: [
        {
          field: { key: "foo", label: "Foo", type: "boolean" },
          value: false,
          isEditing: false,
        },
      ],
      cachedVisibleIndices: [0],
      fieldSelected: 0,
      scroll: 0,
      tabActionFocus: 1, // Focused on action "Reset"
    };

    const mockRendererFor = () => ({
      hints: () => [],
    });

    const lines = renderFooter(mockState, mockRendererFor as any, 80);
    const joined = lines.join(" ");

    expect(joined).toContain("←/→ navigate");
    expect(joined).toContain("enter trigger action");
  });
});
