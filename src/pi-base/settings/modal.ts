/**
 * `createSettingsModal` and `openSettingsModal` — the public modal
 * entry points. Both wrap `createSettingsModalBody` and shape it for
 * `ctx.ui.custom`.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { asUiTerminal, type RawUiHost, type UiComponent } from "../../ui/rows.js";
import { createSettingsModalBody } from "./body";
import type { Field, SettingsModalFactory, SettingsModalOptions } from "./types";

// Singleton guard: track one open modal per ExtensionContext.
// WeakMap so entries are GC'd when the context is no longer referenced.
const openModals = new WeakMap<ExtensionContext, (result: void) => void>();

/**
 * Build a `ctx.ui.custom`-compatible factory for the settings modal.
 * Useful for callers that already manage their own overlay lifecycle.
 *
 * The returned factory captures `ctx` from `openSettingsModal`'s call
 * site — when used standalone, the caller is expected to invoke it via
 * `ctx.ui.custom(createSettingsModal(opts), …)`, and pi will pass the
 * tui/theme/keybindings/done arguments at mount time.
 */
export function createSettingsModal<F extends Field>(
  ctx: ExtensionContext,
  options: SettingsModalOptions<F>,
): SettingsModalFactory<void> {
  return (
    host: RawUiHost,
    theme: Parameters<typeof createSettingsModalBody>[1]["theme"],
    _keybindings: unknown,
    done: (result: void) => void,
  ): UiComponent => {
    const close = (): void => {
      try {
        options.onClose?.();
      } catch {
        // Caller-supplied onClose must not break the modal teardown.
      }
      openModals.delete(ctx);
      done();
    };

    // Singleton guard: if a modal is already open on this ctx, close
    // it before opening the new one. This prevents two in-memory
    // buffers racing to write.
    const existing = openModals.get(ctx);
    if (existing) {
      try {
        existing(void 0);
      } catch {
        // Defensive: existing modal's close must not break the new one.
      }
    }
    openModals.set(ctx, close);

    return createSettingsModalBody<F>(options, {
      tui: asUiTerminal(host),
      theme,
      ctx,
      close,
    });
  };
}

/**
 * Convenience: open a settings modal as an overlay and resolve when the
 * user closes it. This is the **happy-path** entry point most callers want.
 *
 * @deprecated Config flows must use ConfigManager.openSettings(). This entry
 * point remains for config-agnostic overlays (lists, pickers, custom UI).
 *
 * @example
 * ```ts
 * await openSettingsModal(ctx, {
 *   title: "@k0valik/pi-voice",
 *   fields: [
 *     { key: "muted", type: "boolean", label: "Muted", value: cfg.muted },
 *   ],
 *   onChange: (key, value) => { cfg[key] = value; saveConfig(cfg); },
 * });
 * ```
 */
export async function openSettingsModal<F extends Field>(
  ctx: ExtensionContext,
  options: SettingsModalOptions<F>,
): Promise<void> {
  await ctx.ui.custom<void>(createSettingsModal(ctx, options), { overlay: true });
}
