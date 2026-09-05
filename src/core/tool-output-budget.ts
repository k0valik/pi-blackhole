import { textOf } from "./content.js";
import { estimateStringTokens } from "../om/tokens.js";

export interface ToolOutputBudgetResult {
  messages: any[];
  retainedTokens: number;
  omittedTokens: number;
  omittedCount: number;
  pendingCount: number;
}

export interface RetainedToolOutputProjection {
  version: 1;
  retainedTokens: number;
  omittedTokens: number;
  pendingCount: number;
  omissions: Array<{ entryId: string; marker: string }>;
}

const isToolOutput = (message: any): boolean =>
  message?.role === "toolResult" || message?.role === "bashExecution";

const outputText = (message: any): string => {
  if (message.role === "bashExecution") {
    return typeof message.output === "string" ? message.output : "";
  }
  if (typeof message.content === "string" || Array.isArray(message.content)) {
    return textOf(message.content);
  }
  return "";
};

const omissionMarker = (recallIndex?: number): string =>
  `[Tool output text omitted from active context; ${recallIndex === undefined ? "use recall" : `recall #${recallIndex}`}.]`;

export const omitToolOutputText = (message: any, marker: string): any => {
  if (message.role === "bashExecution") return { ...message, output: marker };
  if (typeof message.content === "string") {
    return { ...message, content: marker };
  }
  if (Array.isArray(message.content)) {
    const nonText = message.content.filter((part: any) => part?.type !== "text");
    return {
      ...message,
      content: [{ type: "text", text: marker }, ...nonText],
    };
  }
  return { ...message, content: marker };
};

const omitOutput = (message: any, recallIndex?: number): any =>
  omitToolOutputText(message, omissionMarker(recallIndex));

export const isRetainedToolOutputProjection = (
  value: unknown,
): value is RetainedToolOutputProjection => {
  if (typeof value !== "object" || value === null) return false;
  const projection = value as Record<string, unknown>;
  return (
    projection.version === 1 &&
    typeof projection.retainedTokens === "number" &&
    Number.isFinite(projection.retainedTokens) &&
    projection.retainedTokens >= 0 &&
    typeof projection.omittedTokens === "number" &&
    Number.isFinite(projection.omittedTokens) &&
    projection.omittedTokens >= 0 &&
    typeof projection.pendingCount === "number" &&
    Number.isInteger(projection.pendingCount) &&
    projection.pendingCount >= 0 &&
    Array.isArray(projection.omissions) &&
    projection.omissions.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as any).entryId === "string" &&
        (item as any).entryId.length > 0 &&
        typeof (item as any).marker === "string" &&
        (item as any).marker.length > 0,
    )
  );
};

const markerFromOutput = (message: any): string | undefined => {
  if (message?.role === "bashExecution") {
    return typeof message.output === "string" ? message.output : undefined;
  }
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    const text = message.content.find((part: any) => part?.type === "text")?.text;
    return typeof text === "string" ? text : undefined;
  }
  return undefined;
};

/** Build the immutable provider projection for the tail selected by compaction. */
export function buildRetainedToolOutputProjection(
  retainedEntries: any[],
  allEntries: any[],
  maxTokens: number,
): RetainedToolOutputProjection {
  const messageEntries = retainedEntries.filter(
    (entry) => entry?.type === "message" && entry.message,
  );
  const globalIndexById = new Map<string, number>();
  const ambiguousIds = new Set<string>();
  let transcriptIndex = 0;
  for (const entry of allEntries) {
    if (entry?.type !== "message" || !entry.message) continue;
    if (typeof entry.id === "string") {
      if (globalIndexById.has(entry.id) || ambiguousIds.has(entry.id)) {
        globalIndexById.delete(entry.id);
        ambiguousIds.add(entry.id);
      } else {
        globalIndexById.set(entry.id, transcriptIndex);
      }
    }
    transcriptIndex++;
  }
  const recallIndexes = new Map<number, number>();
  const protectedOutputIndexes = new Set<number>();
  messageEntries.forEach((entry, index) => {
    if (ambiguousIds.has(entry.id)) protectedOutputIndexes.add(index);
    const recallIndex = globalIndexById.get(entry.id);
    if (recallIndex !== undefined) recallIndexes.set(index, recallIndex);
  });
  const messages = messageEntries.map((entry) => entry.message);
  const result = applyToolOutputBudget(messages, maxTokens, recallIndexes, protectedOutputIndexes);
  const omissions: RetainedToolOutputProjection["omissions"] = [];
  result.messages.forEach((message, index) => {
    if (message === messages[index]) return;
    const marker = markerFromOutput(message);
    const entryId = messageEntries[index]?.id;
    if (marker && typeof entryId === "string" && !ambiguousIds.has(entryId)) {
      omissions.push({ entryId, marker });
    }
  });
  return {
    version: 1,
    retainedTokens: result.retainedTokens,
    omittedTokens: result.omittedTokens,
    pendingCount: result.pendingCount,
    omissions,
  };
}

const matchesPersistedEntry = (message: any, persisted: any): boolean => {
  if (message?.role !== persisted?.role) return false;
  if (
    typeof persisted.toolCallId === "string" &&
    persisted.toolCallId.length > 0 &&
    message.toolCallId !== persisted.toolCallId
  ) {
    return false;
  }
  return JSON.stringify(message) === JSON.stringify(persisted);
};

/** Replay omission decisions frozen in the latest Blackhole compaction entry. */
export function applyRetainedToolOutputProjection(
  messages: any[],
  branchEntries: any[],
  projection: RetainedToolOutputProjection,
): any[] {
  let output = messages;
  for (const omission of projection.omissions) {
    const entry = branchEntries.find(
      (candidate) => candidate?.type === "message" && candidate.id === omission.entryId,
    );
    if (!entry?.message || !isToolOutput(entry.message)) continue;
    let matchIndex = messages.indexOf(entry.message);
    if (matchIndex < 0) {
      const matches: number[] = [];
      messages.forEach((message, index) => {
        if (matchesPersistedEntry(message, entry.message)) matches.push(index);
      });
      if (matches.length !== 1) continue;
      matchIndex = matches[0]!;
    }
    if (output === messages) output = [...messages];
    output[matchIndex] = omitToolOutputText(output[matchIndex], omission.marker);
  }
  return output;
}

export function applyToolOutputBudget(
  messages: any[],
  maxTokens: number,
  recallIndexes: ReadonlyMap<number, number> = new Map(),
  protectedOutputIndexes: ReadonlySet<number> = new Set(),
): ToolOutputBudgetResult {
  // Opt-in feature: 0 or negative budget disables the projection entirely.
  if (maxTokens <= 0) {
    return {
      messages,
      retainedTokens: 0,
      omittedTokens: 0,
      omittedCount: 0,
      pendingCount: 0,
    };
  }

  let lastSuccessfulAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      message?.role === "assistant" &&
      message.stopReason !== "error" &&
      message.stopReason !== "aborted"
    ) {
      lastSuccessfulAssistantIndex = i;
      break;
    }
  }

  let retainedTokens = 0;
  let omittedTokens = 0;
  let omittedCount = 0;
  let pendingCount = 0;
  let exhausted = false;
  let output = messages;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isToolOutput(message)) continue;
    if (lastSuccessfulAssistantIndex < 0 || i > lastSuccessfulAssistantIndex) {
      pendingCount++;
      continue;
    }

    const tokens = estimateStringTokens(outputText(message));
    if (tokens === 0) continue;
    if (protectedOutputIndexes.has(i)) {
      retainedTokens += tokens;
      if (retainedTokens > maxTokens) exhausted = true;
      continue;
    }
    if (!exhausted && retainedTokens + tokens <= maxTokens) {
      retainedTokens += tokens;
      continue;
    }

    exhausted = true;
    omittedTokens += tokens;
    omittedCount++;
    if (output === messages) output = [...messages];
    output[i] = omitOutput(message, recallIndexes.get(i));
  }

  return {
    messages: output,
    retainedTokens,
    omittedTokens,
    omittedCount,
    pendingCount,
  };
}
