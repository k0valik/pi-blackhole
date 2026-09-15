/**
 * Cosmetic pre-compaction output — display-only copy of the newest assistant
 * text that a successful Blackhole compaction removed from view.
 *
 * Design constraints (see vault plan 202609142207-plan-cosmetic-compaction-output.md):
 *  - Display only. A plain Pi `custom` entry is rendered by the host but never
 *    projected into provider context (`sessionEntryToContextMessages` returns
 *    nothing for it) and never treated as a memory source by Blackhole's own
 *    scanners, which require message/custom_message/branch_summary.
 *  - No cut-policy change: `firstKeptEntryId`, summary text and model retention
 *    are untouched. The copy only fills screen space the rebuild dropped.
 *  - Bounded: a fixed cap keeps the added disk/redraw cost per compaction small.
 */
import { Container, Markdown, Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  getMarkdownTheme,
  type ExtensionAPI,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { debugLog } from "../om/debug-log.js";
import type { Runtime } from "../om/runtime.js";

/** Plain custom-entry type. Never a `custom_message` — those enter context. */
export const PRE_COMPACTION_OUTPUT_TYPE = "blackhole-pre-compaction-output";

/** Copied-text cap in UTF-8 bytes. Fixed by design; not a user setting. */
export const PRE_COMPACTION_MAX_BYTES = 16 * 1024;

/** Bound on the backwards walk over summarized entries. */
const MAX_SCAN_ENTRIES = 600;

export interface PreCompactionOutputData {
  /** Copied assistant text (possibly truncated). */
  text: string;
  /** Session entry the text came from. */
  sourceEntryId: string;
  /** Compaction entry this copy belongs to (idempotency key). */
  compactionEntryId: string;
  /** True when the original text exceeded the byte cap. */
  truncated: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Fail-closed validator for persisted data (hand-edited or older sessions). */
export function isPreCompactionOutputData(value: unknown): value is PreCompactionOutputData {
  if (!isRecord(value)) return false;
  return (
    typeof value.text === "string" &&
    value.text.trim().length > 0 &&
    typeof value.sourceEntryId === "string" &&
    value.sourceEntryId.length > 0 &&
    typeof value.compactionEntryId === "string" &&
    value.compactionEntryId.length > 0 &&
    typeof value.truncated === "boolean"
  );
}

/** Plain text of an assistant message: text blocks only, no thinking, no tools. */
export function assistantText(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const content = message.content;
  if (typeof content === "string") {
    return content.trim().length > 0 ? content : undefined;
  }
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      if (block.text.trim().length > 0) parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Truncate to a UTF-8 byte budget without splitting a code point. */
export function truncateToBytes(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  let bytes = 0;
  let out = "";
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += char;
  }
  return { text: out, truncated: true };
}

/**
 * Newest assistant text omitted by this compaction.
 *
 * Walks the session path backwards from the compaction entry and skips every
 * entry that survives into context (`buildContextEntries()` = compaction plus
 * retained tail). The first assistant message with ordinary text that is not
 * retained is the copy candidate; `undefined` means nothing worth copying.
 */
export function selectOmittedAssistantText(opts: {
  /** Session path, newest first (host `getBranch()`). */
  branch: readonly SessionEntry[];
  /** Entry ids that remain in provider context (host `buildContextEntries()`). */
  retainedIds: ReadonlySet<string>;
  /** The compaction entry that just succeeded. */
  compactionEntryId: string;
  maxScan?: number;
}): { entryId: string; text: string } | undefined {
  const { branch, retainedIds, compactionEntryId } = opts;
  const maxScan = opts.maxScan ?? MAX_SCAN_ENTRIES;
  const start = branch.findIndex((entry) => entry?.id === compactionEntryId);
  if (start < 0) return undefined;
  const limit = Math.min(branch.length, start + 1 + maxScan);
  for (let i = start + 1; i < limit; i++) {
    const entry = branch[i];
    if (!entry?.id || retainedIds.has(entry.id)) continue;
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!isRecord(message) || message.role !== "assistant") continue;
    if (message.stopReason === "aborted") continue;
    const text = assistantText(message);
    if (text) return { entryId: entry.id, text };
  }
  return undefined;
}

/** Build the stored payload for one compaction, or undefined when nothing to show. */
export function buildPreCompactionOutputData(opts: {
  branch: readonly SessionEntry[];
  retainedIds: ReadonlySet<string>;
  compactionEntry: { id: string };
}): PreCompactionOutputData | undefined {
  const selected = selectOmittedAssistantText({
    branch: opts.branch,
    retainedIds: opts.retainedIds,
    compactionEntryId: opts.compactionEntry.id,
  });
  if (!selected) return undefined;
  // Copied text is data, never terminal control: drop escape sequences before
  // they are stored (and before the byte cap is applied).
  const bounded = truncateToBytes(stripTerminalSequences(selected.text), PRE_COMPACTION_MAX_BYTES);
  return {
    text: bounded.text,
    sourceEntryId: selected.entryId,
    compactionEntryId: opts.compactionEntry.id,
    truncated: bounded.truncated,
  };
}

/** True when this compaction already has a cosmetic copy on the branch. */
export function hasPreCompactionOutput(
  branch: readonly SessionEntry[],
  compactionEntryId: string,
): boolean {
  return branch.some(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === PRE_COMPACTION_OUTPUT_TYPE &&
      isPreCompactionOutputData(entry.data) &&
      entry.data.compactionEntryId === compactionEntryId,
  );
}

export function registerPreCompactionOutput(pi: ExtensionAPI, runtime: Runtime): void {
  // Plain custom entries need the renderer API. Older supported Pi hosts may
  // lack it; without one the copy would be invisible, so register nothing.
  if (typeof pi.registerEntryRenderer !== "function") return;

  pi.registerEntryRenderer<PreCompactionOutputData>(
    PRE_COMPACTION_OUTPUT_TYPE,
    (entry, _options, theme) => {
      if (!isPreCompactionOutputData(entry?.data)) return undefined;
      const data = entry.data;
      const container = new Container();
      container.addChild(new Text(theme.fg("dim", "[Previous output — display only]"), 0, 0));
      // Copied text is data, never terminal control: strip escape sequences
      // before the Markdown component can pass them to the terminal.
      container.addChild(new Markdown(stripTerminalSequences(data.text), 0, 0, getMarkdownTheme()));
      if (data.truncated) {
        container.addChild(new Text(theme.fg("dim", "[Copy truncated]"), 0, 0));
      }
      return container;
    },
  );

  pi.on("session_compact", (event, ctx) => {
    try {
      runtime.ensureConfig(ctx.cwd ?? process.cwd());
      const log = (ev: string, data?: Record<string, unknown>) =>
        debugLog(ev, data, runtime.config.debugLog === true);
      if (runtime.config.showPreCompactionMessage !== true) return;
      if (event?.fromExtension !== true) return;
      const compactionEntry = event.compactionEntry;
      const details = compactionEntry?.details;
      if (!isRecord(details) || details.compactor !== "blackhole") return;
      if (typeof compactionEntry?.id !== "string") return;

      const branch = ctx.sessionManager.getBranch();
      if (hasPreCompactionOutput(branch, compactionEntry.id)) {
        log("pre_compaction_message.skip", { reason: "already_copied" });
        return;
      }
      const retainedIds = new Set<string>(
        ctx.sessionManager.buildContextEntries().map((entry) => entry.id),
      );
      const data = buildPreCompactionOutputData({ branch, retainedIds, compactionEntry });
      if (!data) {
        log("pre_compaction_message.skip", { reason: "no_omitted_assistant_text" });
        return;
      }
      pi.appendEntry(PRE_COMPACTION_OUTPUT_TYPE, data);
      log("pre_compaction_message.append", {
        sourceEntryId: data.sourceEntryId,
        compactionEntryId: data.compactionEntryId,
        bytes: Buffer.byteLength(data.text, "utf8"),
        truncated: data.truncated,
      });
    } catch (error) {
      // Cosmetic only: never let a display nicety break compaction handling.
      debugLog(
        "pre_compaction_message.failed",
        { error: error instanceof Error ? error.message : String(error) },
        runtime.config?.debugLog === true,
      );
    }
  });
}
