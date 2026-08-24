import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { projectAppendOnlyContext } from "../core/compaction-chain.js";
import { debugLog } from "../om/debug-log.js";
import type { Runtime } from "../om/runtime.js";

/** Project persisted version-2 checkpoints into immutable provider messages. */
export function registerCompactionContextHook(
  pi: ExtensionAPI,
  runtime: Runtime,
): void {
  pi.on("context", (event: any, ctx: any) => {
    runtime.ensureConfig(ctx.cwd ?? process.cwd());
    const dbg = (ev: string, data?: Record<string, unknown>) =>
      debugLog(ev, data, runtime.config.debugLog === true);
    try {
      const branchEntries = ctx.sessionManager.getBranch();
      const messages = projectAppendOnlyContext(event.messages, branchEntries);
      if (messages === event.messages) return;
      return { messages };
    } catch (error) {
      // Keep Pi's complete fallback summary if the projection cannot be built.
      dbg("compaction_context.projection_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  });
}
