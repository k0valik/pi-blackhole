/**
 * Serialize branch entries and render source-addressed chunks.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (src/serialize.ts)
 * Unmodified.
 */
import type {
  Message,
  TextContent,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { estimateStringTokens } from "./tokens.js";

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function fmtLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatTimestamp(v: number | string | undefined): string {
  if (v === undefined) return "????-??-?? ??:??";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "????-??-?? ??:??" : fmtLocal(d);
}

function formatRecallTimestamp(
  ...values: Array<number | string | undefined>
): string {
  for (const v of values) {
    if (v === undefined) continue;
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return fmtLocal(d);
  }
  return "Unknown time";
}

function textAndPlaceholders(
  content: unknown,
  options: {
    omitRedactedThinking?: boolean;
    includeThinking?: boolean;
    trim?: boolean;
  } = {},
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "[non-text content omitted]";

  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block || typeof block !== "object") {
      parts.push("[non-text content omitted]");
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    if (block.type === "thinking") {
      if (options.omitRedactedThinking && block.redacted === true) continue;
      if (options.includeThinking && typeof block.thinking === "string") {
        const thinking = options.trim
          ? trimLongThinkingBlock(block.thinking)
          : block.thinking;
        parts.push(`[thinking: ${thinking}]`);
        continue;
      }
      parts.push("[non-text content omitted]");
      continue;
    }
    if (block.type === "toolCall" && typeof block.name === "string") {
      parts.push(`[${block.name}(${JSON.stringify(block.arguments ?? {})})]`);
      continue;
    }
    parts.push("[non-text content omitted]");
  }
  return parts.join("\n");
}

function textOnly(content: unknown, trim = false): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is TextContent => b?.type === "text" && typeof b.text === "string",
    )
    .map((b) => (trim ? trimLongTextBlock(b.text) : b.text))
    .join("\n");
}

export function serializeConversation(
  messages: Message[],
  options: { trim?: boolean } = {},
): string {
  return messages
    .map((msg): string | null => {
      const time = formatTimestamp(msg.timestamp);
      if (msg.role === "user") {
        const text = textOnly(msg.content);
        return `[User @ ${time}]: ${text}`;
      }
      if (msg.role === "assistant") {
        const body = textAndPlaceholders(msg.content, {
          includeThinking: true,
          omitRedactedThinking: true,
          trim: options.trim,
        })
          .split("\n")
          .filter(Boolean)
          .join("\n");
        if (!body) return null;
        return `[Assistant @ ${time}]: ${body}`;
      }
      const text = textOnly(msg.content, options.trim);
      return `[Tool result for ${(msg as ToolResultMessage).toolName} @ ${time}]: ${text}`;
    })
    .filter((line): line is string => line !== null)
    .join("\n\n");
}

export function nowTimestamp(): string {
  return fmtLocal(new Date());
}

export const MAX_RECORD_CONTENT_CHARS = 10_000;

export function truncateRecordContent(content: string): string {
  if (content.length <= MAX_RECORD_CONTENT_CHARS) return content;
  const head = content.slice(0, MAX_RECORD_CONTENT_CHARS);
  const dropped = content.length - MAX_RECORD_CONTENT_CHARS;
  return `${head} … [truncated ${dropped} chars]`;
}

/** Marker replacing the middle of an oversized source entry in observer chunks. */
export const SOURCE_OMISSION_MARKER =
  "[… middle omitted: source exceeds observer input budget; original source remains in the session ledger …]";

const LONG_BLOCK_TRIM_CHARS = 4_096;
const TEXT_HEAD_TAIL_CHARS = 1_000;
const THINKING_HEAD_TAIL_RATIO = 0.2;
const THINKING_HEAD_CAP_CHARS = 4_000;

function trimLongTextBlock(text: string): string {
  if (text.length <= LONG_BLOCK_TRIM_CHARS) return text;
  const head = text.slice(0, TEXT_HEAD_TAIL_CHARS);
  const tail = text.slice(-TEXT_HEAD_TAIL_CHARS);
  const dropped = text.length - head.length - tail.length;
  return `${head}\n[… ${dropped} chars omitted …]\n${tail}`;
}

function trimLongThinkingBlock(text: string): string {
  if (text.length <= LONG_BLOCK_TRIM_CHARS) return text;
  const headLen = Math.min(
    Math.ceil(text.length * THINKING_HEAD_TAIL_RATIO),
    THINKING_HEAD_CAP_CHARS,
  );
  const tailLen = Math.min(
    Math.ceil(text.length * THINKING_HEAD_TAIL_RATIO),
    THINKING_HEAD_CAP_CHARS,
  );
  const head = text.slice(0, headLen);
  const tail = text.slice(-tailLen);
  const dropped = text.length - head.length - tail.length;
  return `${head}\n[… ${dropped} chars omitted …]\n${tail}`;
}

export type RenderableEntry = {
  type: string;
  id?: string;
  timestamp?: string;
  message?: unknown;
  customType?: string;
  content?: unknown;
  summary?: unknown;
};

function renderCustomMessage(
  entry: RenderableEntry,
  options: { recallFormat: boolean },
): string {
  const time = options.recallFormat
    ? formatRecallTimestamp(entry.timestamp)
    : formatTimestamp(entry.timestamp);
  const text = options.recallFormat
    ? textAndPlaceholders(entry.content)
    : typeof entry.content === "string"
      ? entry.content
      : Array.isArray(entry.content)
        ? (entry.content as Array<{ type?: string; text?: string }>)
            .filter((b) => b?.type === "text" && typeof b.text === "string")
            .map((b) => b.text as string)
            .join("\n")
        : "";
  if (options.recallFormat) {
    const origin = entry.customType
      ? `Custom message (${entry.customType})`
      : "Custom message";
    return `[${origin} @ ${time}]: ${text}`;
  }
  const tag = entry.customType ? `Custom (${entry.customType})` : "Custom";
  return `[${tag} @ ${time}]: ${text}`;
}

export function serializeBranchEntries(
  entries: RenderableEntry[],
  options: { trim?: boolean } = {},
): string {
  const blocks: string[] = [];
  for (const entry of entries) {
    if (entry.type === "message" && entry.message) {
      const part = serializeConversation([entry.message as Message], options);
      if (part) blocks.push(part);
      continue;
    }
    if (entry.type === "custom_message") {
      blocks.push(renderCustomMessage(entry, { recallFormat: false }));
      continue;
    }
    if (entry.type === "branch_summary" && typeof entry.summary === "string") {
      const time = formatTimestamp(entry.timestamp);
      blocks.push(`[Branch summary @ ${time}]: ${entry.summary}`);
    }
  }
  return blocks.join("\n\n");
}

export type SourceAddressedOptions = {
  /** Token budget for the assembled chunk (chars/4 estimate). Entries are
   *  walked oldest-first and the walk stops once the budget is exhausted. */
  maxTokens?: number;
  /** Trim oversized tool-result text and thinking blocks (chunk path only;
   *  the recall path stays untrimmed). */
  trim?: boolean;
};

export type SourceAddressedSerialization = {
  text: string;
  sourceEntryIds: string[];
  /** chars/4 estimate of the assembled chunk, using the same accounting as
   *  the maxTokens budget (separator + block per entry). */
  estimatedTokens: number;
  /** Ids of entries included only as head/tail excerpts (the middle is
   *  replaced by SOURCE_OMISSION_MARKER). */
  truncatedSourceEntryIds: string[];
};

function isSourceRenderableEntry(entry: RenderableEntry): boolean {
  return (
    entry.type === "message" ||
    entry.type === "custom_message" ||
    entry.type === "branch_summary"
  );
}

export function serializeSourceAddressedBranchEntries(
  entries: RenderableEntry[],
  options: SourceAddressedOptions = {},
): SourceAddressedSerialization {
  const { maxTokens, trim } = options;
  const blocks: string[] = [];
  const sourceEntryIds: string[] = [];
  const truncatedSourceEntryIds: string[] = [];
  let estimatedTokens = 0;

  const withinBudget = (separatorAndBlock: string): boolean =>
    maxTokens === undefined ||
    estimatedTokens + estimateStringTokens(separatorAndBlock) <= maxTokens;

  for (const entry of entries) {
    if (!entry.id || !isSourceRenderableEntry(entry)) continue;
    const rendered = serializeBranchEntries([entry], { trim });
    if (!rendered.trim()) continue;
    const block = `[Source entry id: ${entry.id}]\n${rendered}`;
    const separator = blocks.length > 0 ? "\n\n" : "";
    const separatorAndBlock = separator + block;

    if (!withinBudget(separatorAndBlock)) {
      if (blocks.length > 0) break;
      // The oldest entry alone exceeds the budget — include a head/tail
      // excerpt so the observer still sees the start and end of the source.
      const fixed = `[Source entry id: ${entry.id}]\n`;
      const marker = `\n${SOURCE_OMISSION_MARKER}\n`;
      const fixedTokens = estimateStringTokens(fixed + marker);
      if (maxTokens === undefined || maxTokens - fixedTokens <= 0) break;
      const availChars = (maxTokens - fixedTokens) * 4;
      if (availChars < 32) break;
      const headChars = Math.floor(availChars / 2);
      const excerpt =
        fixed +
        rendered.slice(0, headChars) +
        marker +
        rendered.slice(-(availChars - headChars));
      blocks.push(excerpt);
      sourceEntryIds.push(entry.id);
      truncatedSourceEntryIds.push(entry.id);
      estimatedTokens += estimateStringTokens(excerpt);
      break;
    }

    blocks.push(block);
    sourceEntryIds.push(entry.id);
    estimatedTokens += estimateStringTokens(separatorAndBlock);
  }

  return {
    text: blocks.join("\n\n"),
    sourceEntryIds,
    estimatedTokens,
    truncatedSourceEntryIds,
  };
}

function renderRecallMessage(entry: RenderableEntry): string | null {
  if (!entry.message || typeof entry.message !== "object") return null;
  const msg = entry.message as Message;
  const time = formatRecallTimestamp(msg.timestamp, entry.timestamp);
  if (msg.role === "user") {
    return `[User @ ${time}]: ${textAndPlaceholders(msg.content)}`;
  }
  if (msg.role === "assistant") {
    const body = textAndPlaceholders(msg.content, {
      includeThinking: true,
      omitRedactedThinking: true,
    })
      .split("\n")
      .filter(Boolean)
      .join("\n");
    if (!body) return null;
    return `[Assistant @ ${time}]: ${body}`;
  }
  return `[Tool result: ${(msg as ToolResultMessage).toolName} @ ${time}]: ${textAndPlaceholders(msg.content)}`;
}

export function renderRecallSourceEntry(entry: RenderableEntry): string | null {
  if (entry.type === "message") return renderRecallMessage(entry);
  if (entry.type === "custom_message")
    return renderCustomMessage(entry, { recallFormat: true });
  if (entry.type === "branch_summary" && typeof entry.summary === "string") {
    const time = formatRecallTimestamp(entry.timestamp);
    return `[Branch summary @ ${time}]: ${entry.summary}`;
  }
  return null;
}

export function renderRecallSourceEntries(entries: RenderableEntry[]): string {
  return entries
    .map(renderRecallSourceEntry)
    .filter(
      (block): block is string => block !== null && block.trim().length > 0,
    )
    .join("\n\n");
}
