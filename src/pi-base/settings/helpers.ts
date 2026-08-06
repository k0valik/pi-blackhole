import type { BodyState } from "./body.ts";
import type { Field } from "./types.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function notifyError(
  _state: BodyState,
  ctx: ExtensionContext,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err);
  try {
    ctx.ui.notify(message, "error");
  } catch {
    // Defensive: never let a bad notify call break the modal loop.
  }
}

export function extractInitialValue(field: Field): unknown {
  if (field.type === "action") return undefined;
  return (field as { value: unknown }).value;
}
