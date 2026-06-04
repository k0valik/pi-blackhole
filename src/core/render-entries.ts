import type { Message } from "@earendil-works/pi-ai";
import { clip, textOf } from "./content";
import { summarizeToolArgs } from "./tool-args";
import { extractPath } from "./tool-args";

// Mirrors @earendil-works/pi-coding-agent's BashExecutionMessage (not re-exported from index)
interface LocalBashExec {
  role: "bashExecution";
  command: string;
  output: string;
}

export interface RenderedEntry {
  index: number;
  id: string;
  role: string;
  summary: string;
  files?: string[];
}

const toolCalls = (content: Message["content"]): string => {
  if (!content || typeof content === "string") return "";
  return content
    .filter((c) => c.type === "toolCall")
    .map((c) => `${c.name}(${summarizeToolArgs(c.arguments)})`)
    .join(", ");
};

const extractFilesFromContent = (content: Message["content"]): string[] => {
  if (!content || typeof content === "string") return [];
  return content
    .filter((c) => c.type === "toolCall")
    .map((c) => extractPath(c.arguments))
    .filter((p): p is string => p !== null);
};

export const renderMessage = (msg: Message, index: number, id: string, full = false): RenderedEntry => {
  if (msg.role === "user") {
    return { index, id, role: "user", summary: full ? textOf(msg.content) : clip(textOf(msg.content), 300) };
  }
  if (msg.role === "toolResult") {
    const prefix = msg.isError ? "ERROR " : "";
    const text = full ? textOf(msg.content) : clip(textOf(msg.content), 200);
    return {
      index, id, role: "tool_result",
      summary: `${prefix}[${msg.toolName}] ${text}`,
    };
  }
  // bashExecution has command+output instead of content
  if ((msg as any).role === "bashExecution") {
    const bashMsg = msg as unknown as LocalBashExec;
    const cmd = bashMsg.command ?? "";
    const out = bashMsg.output ?? "";
    const text = full ? `$ ${cmd}\n${out}` : clip(`$ ${cmd}\n${out}`, 300);
    return { index, id, role: "bash", summary: text };
  }
  const text = full ? textOf(msg.content) : clip(textOf(msg.content), 300);
  const tools = toolCalls(msg.content);
  const files = extractFilesFromContent(msg.content);
  const summary = tools ? `${tools}\n${text}` : text;
  return { index, id, role: "assistant", summary, ...(files.length > 0 && { files }) };
};


