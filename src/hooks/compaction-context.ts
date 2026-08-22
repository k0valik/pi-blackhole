import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { projectAppendOnlyContext } from "../core/compaction-chain.js";

/** Project persisted version-2 checkpoints into immutable provider messages. */
export function registerCompactionContextHook(pi: ExtensionAPI): void {
  pi.on("context", (event: any, ctx: any) => {
    try {
      const branchEntries = ctx.sessionManager.getBranch();
      const messages = projectAppendOnlyContext(event.messages, branchEntries);
      if (messages === event.messages) return;
      return { messages };
    } catch {
      // Keep Pi's complete fallback summary if the projection cannot be built.
      return;
    }
  });
}
