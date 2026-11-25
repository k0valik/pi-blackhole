import { describe, expect, it, vi } from "vitest";
import { SelectList, type SelectItem } from "../src/ui/select-list.js";
import { selectListTheme } from "../src/ui/select-theme.js";
import { visibleWidth } from "../src/ui/ansi-text.js";

const passthrough = (_role: string, text: string): string => text;
const theme = selectListTheme({
  fg: passthrough,
  bg: (_role: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
});

function items(count: number): SelectItem[] {
  return Array.from({ length: count }, (_, i) => ({
    value: `v${i}`,
    label: `label ${i}`,
    description: i % 2 === 0 ? `desc ${i}` : undefined,
  }));
}

const UP = "\x1b[A";
const DOWN = "\x1b[B";

describe("ui/select-list — selection", () => {
  it("starts on the first item", () => {
    const list = new SelectList(items(3), 3, theme);
    expect(list.getSelectedItem()?.value).toBe("v0");
  });

  it("wraps upward from the first item to the last", () => {
    const list = new SelectList(items(3), 3, theme);
    list.handleInput(UP);
    expect(list.getSelectedItem()?.value).toBe("v2");
  });

  it("wraps downward from the last item to the first", () => {
    const list = new SelectList(items(3), 3, theme);
    list.handleInput(DOWN);
    list.handleInput(DOWN);
    list.handleInput(DOWN);
    expect(list.getSelectedItem()?.value).toBe("v0");
  });

  it("clamps setSelectedIndex into range and drops it when empty", () => {
    const list = new SelectList(items(3), 3, theme);
    list.setSelectedIndex(99);
    expect(list.getSelectedItem()?.value).toBe("v2");
    const empty = new SelectList([], 3, theme);
    empty.setSelectedIndex(0);
    expect(empty.getSelectedItem()).toBeNull();
  });

  it("pages by maxVisible and clamps at both ends", () => {
    const list = new SelectList(items(20), 5, theme);
    list.handleInput("\x1b[6~"); // pageDown
    expect(list.getSelectedItem()?.value).toBe("v5");
    list.setSelectedIndex(1);
    list.handleInput("\x1b[5~"); // pageUp
    expect(list.getSelectedItem()?.value).toBe("v0");
  });

  it("reports selection changes and stays quiet when the index does not move", () => {
    const list = new SelectList(items(4), 3, theme);
    const onSelectionChange = vi.fn();
    list.onSelectionChange = onSelectionChange;
    list.handleInput(DOWN);
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    list.setSelectedIndex(0);
    list.handleInput("\x1b[5~"); // pageUp while already at 0
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
  });
});

describe("ui/select-list — commit callbacks", () => {
  it("commits the highlighted item on enter", () => {
    const list = new SelectList(items(3), 3, theme);
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    list.onSelect = onSelect;
    list.onCancel = onCancel;
    list.handleInput(DOWN);
    list.handleInput("\r");
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ value: "v1" }));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels on escape and on ctrl+c", () => {
    const list = new SelectList(items(2), 2, theme);
    const onCancel = vi.fn();
    list.onCancel = onCancel;
    list.handleInput("\x1b");
    list.handleInput("\x03");
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});

describe("ui/select-list — filtering", () => {
  it("filters by value prefix and resets the highlight", () => {
    const list = new SelectList(items(12), 5, theme);
    list.setSelectedIndex(7);
    list.setFilter("v1");
    expect(list.render(60).map((line) => line.match(/label \d+/)?.[0] ?? "")).toEqual([
      "label 1",
      "label 10",
      "label 11",
    ]);
    expect(list.getSelectedItem()?.value).toBe("v1");
  });

  it("renders the no-match row when the filter excludes everything", () => {
    const list = new SelectList(items(3), 3, theme);
    list.setFilter("zzz");
    expect(list.render(60)).toEqual(["  No matching commands"]);
  });
});

describe("ui/select-list — rendering", () => {
  it("renders every item when they fit, and no scroll row", () => {
    const list = new SelectList(items(3), 5, theme);
    const lines = list.render(60);
    expect(lines).toHaveLength(3);
    expect(lines.some((line) => line.includes("(1/3)"))).toBe(false);
  });

  it("adds a scroll row and keeps the highlight visible when items overflow", () => {
    const list = new SelectList(items(20), 5, theme);
    list.setSelectedIndex(12);
    const lines = list.render(60);
    expect(lines.filter((line) => line.includes("label")).length).toBeLessThanOrEqual(5);
    expect(lines.at(-1)).toContain("(13/20)");
    expect(lines.some((line) => line.includes("label 12"))).toBe(true);
  });

  it("never exceeds the requested width", () => {
    const list = new SelectList(items(8), 8, theme);
    for (const width of [12, 24, 40, 80]) {
      for (const line of list.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("collapses multi-line descriptions onto one row", () => {
    const list = new SelectList([{ value: "x", label: "X", description: "a\nb" }], 3, theme);
    const lines = list.render(80);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("a b");
  });

  it("honours a custom truncatePrimary layout hook", () => {
    const truncatePrimary = vi.fn(({ text }: { text: string }) => text.slice(0, 3));
    const list = new SelectList(items(2), 2, theme, { truncatePrimary });
    const lines = list.render(60);
    expect(truncatePrimary).toHaveBeenCalled();
    expect(lines[0]).toContain("lab");
    expect(lines[0]).not.toContain("label 0");
  });
});
