import { buildSessionContext, loadEntriesFromFile } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import type { Message } from "@earendil-works/pi-ai";

export interface LoadedSession {
  messageCount: number;
  skippedCount: number;
  messages: Message[];
}

export const loadSessionMessages = (file: string): LoadedSession => {
  const entries = loadEntriesFromFile(file);
  const sessionEntries = entries.filter((entry) => entry.type !== "header");
  const context = buildSessionContext(sessionEntries as any);
  const messages = (context.messages as any[]).filter(
    (msg): msg is Message =>
      msg && typeof msg.role === "string" && "content" in msg,
  );
  return {
    messageCount: messages.length,
    skippedCount: context.messages.length - messages.length,
    messages,
  };
};
