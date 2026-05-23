/**
 * Normalized block types shared across pi-vcc pipeline.
 *
 * Upstream: https://github.com/sting8k/pi-vcc (src/types.ts)
 * Unmodified.
 */
export interface FileOps {
  readFiles?: string[];
  modifiedFiles?: string[];
  createdFiles?: string[];
}

export type NormalizedBlock =
  | { kind: "user"; text: string; sourceIndex?: number }
  | { kind: "assistant"; text: string; sourceIndex?: number }
  | { kind: "tool_call"; name: string; args: Record<string, unknown>; sourceIndex?: number }
  | { kind: "tool_result"; name: string; text: string; isError: boolean; sourceIndex?: number }
  | { kind: "bash"; command: string; output: string; exitCode: number | undefined; sourceIndex?: number }
  | { kind: "thinking"; text: string; redacted: boolean; sourceIndex?: number };
