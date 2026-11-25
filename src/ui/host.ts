export interface UiSize {
  rows: number;
  columns: number;
}

export interface UiTerminal {
  requestRender(): void;
  terminal: UiSize;
}

interface RawUiSizeProvider {
  size?(): { rows?: number; columns?: number };
}

interface RawUiTerminalProvider {
  terminal?: { rows?: number; columns?: number };
}

export type RawUiHost = {
  requestRender?(): void;
} & RawUiSizeProvider &
  RawUiTerminalProvider;

function fallbackSize(size: { rows?: number; columns?: number } | undefined): UiSize {
  return {
    rows: size?.rows ?? 24,
    columns: size?.columns ?? 80,
  };
}

export function asUiTerminal(host: RawUiHost): UiTerminal {
  return {
    requestRender() {
      host.requestRender?.();
    },
    terminal: {
      get rows() {
        return fallbackSize(host.size?.() ?? host.terminal).rows;
      },
      get columns() {
        return fallbackSize(host.size?.() ?? host.terminal).columns;
      },
    },
  };
}
