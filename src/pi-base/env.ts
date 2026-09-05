import { execFileSync } from "node:child_process";

export function isTmux(): boolean {
  return Boolean(process.env.TMUX);
}

export function isKitty(): boolean {
  return Boolean(process.env.KITTY_WINDOW_ID);
}

export function isGhostty(): boolean {
  return process.env.TERM_PROGRAM === "ghostty";
}

export function isIterm(): boolean {
  return process.env.TERM_PROGRAM === "iTerm.app" || Boolean(process.env.ITERM_SESSION_ID);
}

export function isWindowsTerminal(): boolean {
  return Boolean(process.env.WT_SESSION) || process.platform === "win32";
}

export function isWSL(): boolean {
  return Boolean(process.env.WSL_DISTRO_NAME);
}

export function isAlacritty(): boolean {
  return (process.env.TERM ?? "").toLowerCase().includes("alacritty");
}

export function getClientTty(): string {
  if (!isTmux()) return "/dev/tty";
  try {
    return execFileSync("tmux", ["display-message", "-p", "#{client_tty}"], {
      encoding: "utf-8",
    }).trim();
  } catch {
    return "/dev/tty";
  }
}
