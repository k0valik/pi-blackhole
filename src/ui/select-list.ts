import { truncateToWidth, visibleWidth } from "./ansi-text.js";
import { matchesKey } from "./keys.js";

export interface SelectItem {
  value: string;
  label: string;
  description?: string;
}

export interface SelectListTheme {
  selectedPrefix: (text: string) => string;
  selectedText: (text: string) => string;
  description: (text: string) => string;
  scrollInfo: (text: string) => string;
  noMatch: (text: string) => string;
}

export interface SelectListTruncatePrimaryContext {
  text: string;
  maxWidth: number;
  columnWidth: number;
  item: SelectItem;
  isSelected: boolean;
}

export interface SelectListLayoutOptions {
  minPrimaryColumnWidth?: number;
  maxPrimaryColumnWidth?: number;
  truncatePrimary?: (context: SelectListTruncatePrimaryContext) => string;
}

const DEFAULT_PRIMARY_COLUMN_WIDTH = 32;
const PRIMARY_COLUMN_GAP = 2;
const MIN_DESCRIPTION_WIDTH = 10;

const normalizeToSingleLine = (text: string) => text.replace(/[\r\n]+/g, " ").trim();
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

export class SelectList {
  readonly capturesViewportInput = true;
  private items: SelectItem[];
  private filteredItems: SelectItem[];
  private selectedIndex = 0;
  private maxVisible: number;
  private theme: SelectListTheme;
  private layout: SelectListLayoutOptions;

  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
  onSelectionChange?: (item: SelectItem) => void;

  constructor(
    items: SelectItem[],
    maxVisible: number,
    theme: SelectListTheme,
    layout: SelectListLayoutOptions = {},
  ) {
    this.items = items;
    this.filteredItems = items;
    this.maxVisible = maxVisible;
    this.theme = theme;
    this.layout = layout;
  }

  setFilter(filter: string): void {
    this.filteredItems = this.items.filter((item) =>
      item.value.toLowerCase().startsWith(filter.toLowerCase()),
    );
    this.selectedIndex = 0;
  }

  setSelectedIndex(index: number): void {
    this.selectedIndex = Math.max(0, Math.min(index, this.filteredItems.length - 1));
  }

  invalidate(): void {
    // No cached state to invalidate currently
  }

  render(width: number): string[] {
    const lines: string[] = [];

    if (this.filteredItems.length === 0) {
      lines.push(this.theme.noMatch("  No matching commands"));
      return lines;
    }

    const primaryColumnWidth = this.getPrimaryColumnWidth();
    const { startIndex, endIndex } = this.getVisibleRange();

    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filteredItems[i];
      if (!item) continue;
      const isSelected = i === this.selectedIndex;
      const descriptionSingleLine = item.description
        ? normalizeToSingleLine(item.description)
        : undefined;
      lines.push(
        this.renderItem(item, isSelected, width, descriptionSingleLine, primaryColumnWidth),
      );
    }

    if (startIndex > 0 || endIndex < this.filteredItems.length) {
      const scrollText = `  (${this.selectedIndex + 1}/${this.filteredItems.length})`;
      lines.push(this.theme.scrollInfo(truncateToWidth(scrollText, width - 2, "")));
    }

    return lines;
  }

  handleInput(keyData: string): void {
    const pageIndex = this.getPageIndex(keyData);

    if (matchesKey(keyData, "up")) {
      this.selectedIndex =
        this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
      this.notifySelectionChange();
    } else if (matchesKey(keyData, "down")) {
      this.selectedIndex =
        this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
      this.notifySelectionChange();
    } else if (pageIndex !== undefined) {
      if (this.filteredItems.length === 0 || pageIndex === this.selectedIndex) return;
      this.selectedIndex = pageIndex;
      this.notifySelectionChange();
    } else if (matchesKey(keyData, "enter")) {
      const selectedItem = this.filteredItems[this.selectedIndex];
      if (selectedItem && this.onSelect) {
        this.onSelect(selectedItem);
      }
    } else if (matchesKey(keyData, "escape") || matchesKey(keyData, "ctrl+c")) {
      this.onCancel?.();
    }
  }

  getSelectedItem(): SelectItem | null {
    const item = this.filteredItems[this.selectedIndex];
    return item || null;
  }

  private getPageIndex(keyData: string): number | undefined {
    let direction: number;
    if (matchesKey(keyData, "pageUp")) direction = -1;
    else if (matchesKey(keyData, "pageDown")) direction = 1;
    else return undefined;

    return Math.max(
      0,
      Math.min(this.filteredItems.length - 1, this.selectedIndex + direction * this.maxVisible),
    );
  }

  private getVisibleRange(): { startIndex: number; endIndex: number } {
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisible / 2),
        this.filteredItems.length - this.maxVisible,
      ),
    );
    return {
      startIndex,
      endIndex: Math.min(startIndex + this.maxVisible, this.filteredItems.length),
    };
  }

  private renderItem(
    item: SelectItem,
    isSelected: boolean,
    width: number,
    descriptionSingleLine: string | undefined,
    primaryColumnWidth: number,
  ): string {
    const prefix = isSelected ? "→ " : "  ";
    const prefixWidth = visibleWidth(prefix);

    if (descriptionSingleLine && width > 40) {
      const effectivePrimaryColumnWidth = Math.max(
        1,
        Math.min(primaryColumnWidth, width - prefixWidth - 4),
      );
      const maxPrimaryWidth = Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP);
      const truncatedValue = this.truncatePrimary(
        item,
        isSelected,
        maxPrimaryWidth,
        effectivePrimaryColumnWidth,
      );
      const truncatedValueWidth = visibleWidth(truncatedValue);
      const spacing = " ".repeat(Math.max(1, effectivePrimaryColumnWidth - truncatedValueWidth));
      const descriptionStart = prefixWidth + truncatedValueWidth + spacing.length;
      const remainingWidth = width - descriptionStart - 2;
      if (remainingWidth > MIN_DESCRIPTION_WIDTH) {
        const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, "");
        if (isSelected) {
          return this.theme.selectedText(`${prefix}${truncatedValue}${spacing}${truncatedDesc}`);
        }
        const descText = this.theme.description(spacing + truncatedDesc);
        return prefix + truncatedValue + descText;
      }
    }

    const maxWidth = width - prefixWidth - 2;
    const truncatedValue = this.truncatePrimary(item, isSelected, maxWidth, maxWidth);
    if (isSelected) {
      return this.theme.selectedText(`${prefix}${truncatedValue}`);
    }
    return prefix + truncatedValue;
  }

  private getPrimaryColumnWidth(): number {
    const { min, max } = this.getPrimaryColumnBounds();
    const widestPrimary = this.filteredItems.reduce((widest, item) => {
      return Math.max(widest, visibleWidth(this.getDisplayValue(item)) + PRIMARY_COLUMN_GAP);
    }, 0);
    return clamp(widestPrimary, min, max);
  }

  private getPrimaryColumnBounds(): { min: number; max: number } {
    const rawMin =
      this.layout.minPrimaryColumnWidth ??
      this.layout.maxPrimaryColumnWidth ??
      DEFAULT_PRIMARY_COLUMN_WIDTH;
    const rawMax =
      this.layout.maxPrimaryColumnWidth ??
      this.layout.minPrimaryColumnWidth ??
      DEFAULT_PRIMARY_COLUMN_WIDTH;
    return {
      min: Math.max(1, Math.min(rawMin, rawMax)),
      max: Math.max(1, Math.max(rawMin, rawMax)),
    };
  }

  private truncatePrimary(
    item: SelectItem,
    isSelected: boolean,
    maxWidth: number,
    columnWidth: number,
  ): string {
    const displayValue = this.getDisplayValue(item);
    const truncatedValue = this.layout.truncatePrimary
      ? this.layout.truncatePrimary({
          text: displayValue,
          maxWidth,
          columnWidth,
          item,
          isSelected,
        })
      : truncateToWidth(displayValue, maxWidth, "");
    return truncateToWidth(truncatedValue, maxWidth, "");
  }

  private getDisplayValue(item: SelectItem): string {
    return item.label || item.value;
  }

  private notifySelectionChange(): void {
    const selectedItem = this.filteredItems[this.selectedIndex];
    if (selectedItem && this.onSelectionChange) {
      this.onSelectionChange(selectedItem);
    }
  }
}
