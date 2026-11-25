import type { UiTheme } from "./theme.js";

export interface SelectListTheme {
  selectedPrefix(text: string): string;
  selectedText(text: string): string;
  description(text: string): string;
  scrollInfo(text: string): string;
  noMatch(text: string): string;
}

export function selectListTheme(theme: UiTheme): SelectListTheme {
  return {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("muted", text),
    noMatch: (text) => theme.fg("muted", text),
  };
}
