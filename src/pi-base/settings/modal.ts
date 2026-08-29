/**
 * `createSettingsModal` and `openSettingsModal` — the public modal
 * entry points. Both wrap `createSettingsModalBody` and shape it for
 * `ctx.ui.custom`.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { createSettingsModalBody } from "./body";
import type { Field, SettingsModalFactory, SettingsModalOptions } from "./types";

const DEFAULT_OVERLAY: OverlayOptions = {
  anchor: "center",
  width: "92%",
  maxHeight: "95%",
};

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
    tui: TUI,
    theme: Theme,
    _keybindings: KeybindingsManager,
    done: (result: void) => void,
  ): Component => {
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

    return createSettingsModalBody<F>(options, { tui, theme, ctx, close });
  };
}

/**
 * Convenience: open a settings modal as a centered overlay and resolve
 * when the user closes it. This is the **happy-path** entry point most
 * callers want.
 *
 * Defaults: anchor center, width 92%, maxHeight 95%. Override via
 * `options.overlayOptions`.
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
  const overlayOptions = options.overlayOptions ?? DEFAULT_OVERLAY;
  await ctx.ui.custom<void>(createSettingsModal(ctx, options), {
    overlay: true,
    overlayOptions,
  });
}
