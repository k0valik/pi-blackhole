import { decodeKittyPrintable, matchesKey } from "./keys.js";
import { visibleWidth } from "./ansi-text.js";

export interface EditorTheme {
  borderColor(text: string): string;
}

export interface EditorOptions {
  paddingX?: number;
}

interface GraphemeChunk {
  text: string;
  start: number;
  end: number;
}

interface VisualLine {
  logicalLine: number;
  graphemeStart: number;
  graphemeEnd: number;
  text: string;
  hasCursor: boolean;
  cursorOffset: number;
}

const TAB_WIDTH = 4;

function graphemes(text: string): string[] {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(
    (part) => part.segment,
  );
}

function isWhitespaceGrapheme(grapheme: string): boolean {
  return /^\s$/u.test(grapheme);
}

function isCjkGrapheme(grapheme: string): boolean {
  return /\p{Script_Extensions=Han}|\p{Script_Extensions=Hiragana}|\p{Script_Extensions=Katakana}|\p{Script_Extensions=Hangul}|\p{Script_Extensions=Bopomofo}/u.test(
    grapheme,
  );
}

function wrapLogicalLine(parts: readonly string[], maxWidth: number): GraphemeChunk[] {
  if (maxWidth <= 0) return [{ text: "", start: 0, end: parts.length }];
  if (parts.length === 0) return [{ text: "", start: 0, end: 0 }];

  const chunks: GraphemeChunk[] = [];
  let start = 0;
  let width = 0;
  let opportunity = -1;
  let opportunityWidth = 0;

  const push = (end: number): void => {
    if (end <= start) return;
    chunks.push({ text: parts.slice(start, end).join(""), start, end });
  };

  for (let index = 0; index < parts.length; index++) {
    const grapheme = parts[index]!;
    const graphemeWidth = visibleWidth(grapheme);

    if (width + graphemeWidth > maxWidth) {
      if (opportunity >= 0 && width - opportunityWidth + graphemeWidth <= maxWidth) {
        push(opportunity);
        width -= opportunityWidth;
        start = opportunity;
      } else if (start < index) {
        push(index);
        start = index;
        width = 0;
      }

      if (graphemeWidth > maxWidth) {
        chunks.push({ text: grapheme, start: index, end: index + 1 });
        start = index + 1;
        width = 0;
        opportunity = -1;
        continue;
      }
      opportunity = -1;
    }

    width += graphemeWidth;

    const next = parts[index + 1];
    if (isWhitespaceGrapheme(grapheme) && next && !isWhitespaceGrapheme(next)) {
      opportunity = index + 1;
      opportunityWidth = width;
    } else if (
      !isWhitespaceGrapheme(grapheme) &&
      next &&
      !isWhitespaceGrapheme(next) &&
      (isCjkGrapheme(grapheme) || isCjkGrapheme(next))
    ) {
      opportunity = index + 1;
      opportunityWidth = width;
    }
  }

  push(parts.length);
  return chunks.length > 0 ? chunks : [{ text: "", start: 0, end: parts.length }];
}

export class Editor {
  focused = false;
  disableSubmit = false;
  onChange?: (text: string) => void;
  onEscape?: () => void;
  onSubmit?: () => void;

  private lines: string[][];
  private cursorLine = 0;
  private cursorCol = 0;
  private preferredCol: number | undefined;
  private scrollOffset = 0;
  private lastWidth = 80;

  constructor(
    private readonly tui: { terminal: { rows: number; columns: number }; requestRender(): void },
    private readonly theme: EditorTheme,
    private readonly options: EditorOptions = {},
  ) {
    this.lines = [[""]];
  }

  setText(text: string): void {
    const normalized = text.replace(/\r\n?/g, "\n");
    this.lines = normalized.split("\n").map(graphemes);
    if (this.lines.length === 0) this.lines = [[""]];
    this.cursorLine = this.lines.length - 1;
    this.cursorCol = this.lines[this.cursorLine]!.length;
    this.preferredCol = undefined;
    this.scrollOffset = 0;
  }

  getText(): string {
    return this.lines.map((line) => line.join("")).join("\n");
  }

  getExpandedText(): string {
    return this.getText();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const paddingX = Math.max(
      0,
      Math.min(this.options.paddingX ?? 0, Math.floor(Math.max(0, width - 1) / 2)),
    );
    const contentWidth = Math.max(1, width - paddingX * 2);
    const layoutWidth = Math.max(1, contentWidth - (paddingX > 0 ? 0 : 1));
    this.lastWidth = layoutWidth;

    const visual = this.layout(layoutWidth);
    const cursorIndex = Math.max(
      0,
      visual.findIndex((line) => line.hasCursor),
    );
    const maxVisible = Math.max(5, Math.floor((this.tui.terminal.rows ?? 24) * 0.3));
    if (cursorIndex < this.scrollOffset) this.scrollOffset = cursorIndex;
    else if (cursorIndex >= this.scrollOffset + maxVisible) {
      this.scrollOffset = cursorIndex - maxVisible + 1;
    }
    this.scrollOffset = Math.max(
      0,
      Math.min(this.scrollOffset, Math.max(0, visual.length - maxVisible)),
    );

    const visible = visual.slice(this.scrollOffset, this.scrollOffset + maxVisible);
    const above = this.scrollOffset;
    const below = visual.length - (this.scrollOffset + visible.length);
    const left = " ".repeat(paddingX);
    const right = " ".repeat(paddingX);
    const result = [this.theme.borderColor(scrollBorder("↑", above, width))];

    for (const line of visible) {
      const parts = graphemes(line.text);
      let display = line.text;
      let displayWidth = visibleWidth(display);
      if (this.focused && line.hasCursor) {
        const before = parts.slice(0, line.cursorOffset).join("");
        const at = parts[line.cursorOffset];
        const after = parts.slice(line.cursorOffset + 1).join("");
        if (at === undefined) {
          display = `${before}\x1b[7m \x1b[27m`;
          displayWidth += 1;
        } else {
          const atWidth = Math.max(1, visibleWidth(at));
          display = `${before}\x1b[7m${at}\x1b[27m${after}`;
          displayWidth += 1 - atWidth;
        }
      }
      const padding = " ".repeat(Math.max(0, contentWidth - displayWidth));
      result.push(`${left}${display}${padding}${right}`);
    }

    result.push(this.theme.borderColor(scrollBorder("↓", below, width)));
    return result;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\r" || data === "\n") {
      if (this.disableSubmit) this.insertText("\n");
      else this.onSubmit?.();
      return;
    }
    if (matchesKey(data, "escape")) {
      this.onEscape?.();
      return;
    }
    if (matchesKey(data, "left") || matchesKey(data, "ctrl+b")) {
      this.move(-1);
      return;
    }
    if (matchesKey(data, "right") || matchesKey(data, "ctrl+f")) {
      this.move(1);
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
      this.moveVertical(-1);
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
      this.moveVertical(1);
      return;
    }
    if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) {
      this.setCursor(0);
      return;
    }
    if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) {
      this.setCursor(this.lines[this.cursorLine]!.length);
      return;
    }
    if (matchesKey(data, "delete") || matchesKey(data, "ctrl+d")) {
      this.deleteNext();
      return;
    }
    if (
      matchesKey(data, "backspace") ||
      matchesKey(data, "ctrl+h") ||
      data === "\x7f" ||
      data === "\x08"
    ) {
      this.deletePrevious();
      return;
    }
    if (matchesKey(data, "ctrl+w") || matchesKey(data, "alt+backspace")) {
      this.deleteWordBackward();
      return;
    }
    if (matchesKey(data, "alt+left")) {
      this.moveWord(-1);
      return;
    }
    if (matchesKey(data, "alt+right")) {
      this.moveWord(1);
      return;
    }
    if (data === "\t") {
      this.insertText(" ".repeat(TAB_WIDTH));
      return;
    }

    const decoded = decodeKittyPrintable(data);
    if (decoded !== undefined) {
      this.insertText(decoded);
      return;
    }
    if (!data.includes("\x1b") && data.length > 0) {
      const printable = [...data].every(
        (char) => char.codePointAt(0)! >= 0x20 || char === "\n" || char === "\t",
      );
      if (printable) this.insertText(data);
    }
  }

  private layout(width: number): VisualLine[] {
    const result: VisualLine[] = [];
    for (let lineIndex = 0; lineIndex < this.lines.length; lineIndex++) {
      const parts = this.lines[lineIndex]!;
      const chunks = wrapLogicalLine(parts, width);
      for (const chunk of chunks) {
        const hasCursor =
          lineIndex === this.cursorLine &&
          this.cursorCol >= chunk.start &&
          this.cursorCol <= chunk.end;
        result.push({
          logicalLine: lineIndex,
          graphemeStart: chunk.start,
          graphemeEnd: chunk.end,
          text: chunk.text,
          hasCursor,
          cursorOffset: hasCursor ? this.cursorCol - chunk.start : 0,
        });
      }
    }
    return result;
  }

  private insertText(text: string): void {
    const normalized = text.replace(/\r\n?/g, "\n");
    const chunks = normalized.split("\n").map(graphemes);
    const line = this.lines[this.cursorLine]!;
    const tail = line.splice(this.cursorCol);
    const first = chunks[0]!;

    if (chunks.length === 1) {
      line.push(...first, ...tail);
      this.cursorCol = line.length - tail.length;
    } else {
      line.push(...first);
      const last = chunks[chunks.length - 1]!;
      last.push(...tail);
      this.lines.splice(this.cursorLine + 1, 0, ...chunks.slice(1));
      this.cursorLine += chunks.length - 1;
      this.cursorCol = last.length - tail.length;
    }
    this.preferredCol = undefined;
    this.notify();
  }

  private deletePrevious(): void {
    if (this.cursorCol > 0) {
      this.lines[this.cursorLine]!.splice(this.cursorCol - 1, 1);
      this.cursorCol -= 1;
      this.preferredCol = undefined;
      this.notify();
      return;
    }
    if (this.cursorLine === 0) return;
    const previous = this.lines[this.cursorLine - 1]!;
    const current = this.lines[this.cursorLine]!;
    this.cursorCol = previous.length;
    previous.push(...current);
    this.lines.splice(this.cursorLine, 1);
    this.cursorLine -= 1;
    this.preferredCol = undefined;
    this.notify();
  }

  private deleteNext(): void {
    const line = this.lines[this.cursorLine]!;
    if (this.cursorCol < line.length) {
      line.splice(this.cursorCol, 1);
      this.preferredCol = undefined;
      this.notify();
      return;
    }
    const next = this.lines[this.cursorLine + 1];
    if (!next) return;
    line.push(...next);
    this.lines.splice(this.cursorLine + 1, 1);
    this.preferredCol = undefined;
    this.notify();
  }

  private deleteWordBackward(): void {
    if (this.cursorCol === 0) {
      this.deletePrevious();
      return;
    }
    const start = this.findWordBoundary(this.cursorLine, this.cursorCol, -1);
    this.lines[this.cursorLine]!.splice(start, this.cursorCol - start);
    this.cursorCol = start;
    this.preferredCol = undefined;
    this.notify();
  }

  private move(direction: -1 | 1): void {
    if (direction === -1) {
      if (this.cursorCol > 0) {
        this.setCursor(this.cursorCol - 1);
        return;
      }
      if (this.cursorLine > 0) {
        this.cursorLine -= 1;
        this.setCursor(this.lines[this.cursorLine]!.length);
      }
      return;
    }
    const line = this.lines[this.cursorLine]!;
    if (this.cursorCol < line.length) {
      this.setCursor(this.cursorCol + 1);
      return;
    }
    if (this.cursorLine < this.lines.length - 1) {
      this.cursorLine += 1;
      this.setCursor(0);
    }
  }

  private moveVertical(direction: -1 | 1): void {
    const visual = this.layout(this.lastWidth);
    const current = visual.findIndex(
      (line) =>
        line.logicalLine === this.cursorLine &&
        this.cursorCol >= line.graphemeStart &&
        this.cursorCol <= line.graphemeEnd,
    );
    const target = visual[current + direction];
    if (!target || current < 0) {
      const line = this.lines[this.cursorLine + direction];
      if (!line) return;
      this.cursorLine += direction;
      this.setCursor(Math.min(this.cursorCol, line.length));
      return;
    }
    const desired = this.preferredCol ?? this.cursorCol - visual[current]!.graphemeStart;
    this.preferredCol = desired;
    this.cursorLine = target.logicalLine;
    this.setCursor(Math.min(target.graphemeStart + desired, target.graphemeEnd));
  }

  private moveWord(direction: -1 | 1): void {
    this.setCursor(this.findWordBoundary(this.cursorLine, this.cursorCol, direction));
  }

  private findWordBoundary(line: number, column: number, direction: -1 | 1): number {
    const parts = this.lines[line]!;
    if (direction === -1) {
      let index = Math.min(column, parts.length);
      while (index > 0 && isWhitespaceGrapheme(parts[index - 1]!)) index--;
      while (index > 0 && !isWhitespaceGrapheme(parts[index - 1]!)) index--;
      return index;
    }
    let index = Math.max(0, column);
    while (index < parts.length && isWhitespaceGrapheme(parts[index]!)) index++;
    while (index < parts.length && !isWhitespaceGrapheme(parts[index]!)) index++;
    return index;
  }

  private setCursor(column: number): void {
    this.cursorCol = Math.max(0, Math.min(column, this.lines[this.cursorLine]!.length));
  }

  private notify(): void {
    this.onChange?.(this.getText());
  }
}

function scrollBorder(symbol: string, hidden: number, width: number): string {
  if (hidden <= 0) return "─".repeat(width);
  const label = `${symbol} ${hidden} ${symbol}`;
  const labelWidth = visibleWidth(label);
  const fill = Math.max(0, width - labelWidth);
  const left = Math.floor(fill / 2);
  return "─".repeat(left) + label + "─".repeat(fill - left);
}
