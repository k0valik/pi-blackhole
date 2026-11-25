export interface UiTheme {
  fg(token: string, text: string): string;
  bg(token: string, text: string): string;
  bold(text: string): string;
  italic?(text: string): string;
  underline?(text: string): string;
  strikethrough?(text: string): string;
  inverse(text: string): string;
}
