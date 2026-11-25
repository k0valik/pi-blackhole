import type { RawUiHost } from "./host.js";
import type { UiTheme } from "./theme.js";

export interface UiComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  /** Hosts clear cached render output through this; Pi's `Component` requires it. */
  invalidate(): void;
  dispose?(): void;
}

export type UiComponentFactory<T> = (
  host: RawUiHost,
  theme: UiTheme,
  keybindings: unknown,
  done: (result: T) => void,
) => UiComponent | Promise<UiComponent>;

export { asUiTerminal } from "./host.js";
export type { RawUiHost, UiSize, UiTerminal } from "./host.js";
export type { UiTheme } from "./theme.js";
