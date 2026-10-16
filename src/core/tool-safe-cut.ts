import type { Entry } from "../om/ledger/types.js";

/** Reject a cut when any retained result's call lies before it. Missing calls
 * are conservatively unsafe too; the fallback must not create an orphan. */
export function isToolSafeCut(entries: Entry[], index: number): boolean {
  const retainedCalls = new Set<string>();
  for (const entry of entries.slice(index)) {
    const message = entry.message;
    if (!message || typeof message !== "object" || !("role" in message)) continue;
    if (message.role === "assistant" && "content" in message && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (
          block &&
          typeof block === "object" &&
          block.type === "toolCall" &&
          typeof block.id === "string"
        )
          retainedCalls.add(block.id);
      }
    }
    if (
      message.role === "toolResult" &&
      "toolCallId" in message &&
      (typeof message.toolCallId !== "string" || !retainedCalls.has(message.toolCallId))
    )
      return false;
  }
  return true;
}
