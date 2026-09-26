/**
 * Recall response budget — bounds the total text of a single recall tool
 * response so one huge stored message cannot flood the agent's context
 * (issue #83).
 *
 * The single user-facing knob is `recallResponseMaxChars` (config + env
 * PI_BLACKHOLE_RECALL_RESPONSE_MAX_CHARS). Per-entry allocations are derived
 * from it here; keeping the derived ratios internal means only the one number
 * needs to stay in sync across config/docs.
 */

import { clip } from "./content.js";
import { DRILLDOWN_PAGE_LINES, type DrillDownPaging } from "./drill-down.js";

/** Fallback used when a recall tool is registered without a runtime/config. */
export const DEFAULT_RECALL_RESPONSE_MAX_CHARS = 48_000;

/** Readability floor for a single expanded entry inside a shared budget. */
export const EXPAND_FLOOR_CHARS = 2_000;

/**
 * Fixed per-entry overhead of an expanded block beyond the body text: the
 * `#N [role]` header, the truncation marker, and the `\n\n` join. Reserved so
 * `count` allocations sum to at most `budget` even after formatting overhead.
 * Generous on purpose: the worst-case overhead (assistant entry with a files
 * suffix + truncation marker) is ~150 chars, and the reservation must never
 * let an explicit single-entry expand drop its only block.
 */
export const EXPAND_ENTRY_OVERHEAD = 200;

/**
 * Per-entry character allocation when rendering `count` expanded entries
 * within a `budget`-character response.
 *
 * - count = 1 → the whole budget (still bounded — never verbatim unbounded).
 * - count ≤ budget / floor → the even share, but never below the floor.
 * - count > budget / floor → the bare even share (floor would blow the total).
 *
 * Reserved per-entry overhead means `count` allocations stay under `budget`
 * even after headers/markers/joins, so every requested index is returned as a
 * bounded excerpt instead of trailing entries being dropped.
 */
export function expandAllocation(count: number, budget: number): number {
  if (count <= 0 || budget <= 0) return 0;
  const usable = Math.max(0, budget - count * EXPAND_ENTRY_OVERHEAD);
  const share = Math.floor(usable / count);
  return count * EXPAND_FLOOR_CHARS <= usable ? Math.max(share, EXPAND_FLOOR_CHARS) : share;
}

export interface CapRecallBlocksInput {
  /** First block, always kept (e.g. "Page 1/10 (50 matches) for ...:"). */
  header: string;
  /** One pre-formatted block per rendered entry. */
  entryBlocks: string[];
  /** Optional trailing blocks (related observations, page footer). */
  tailBlocks?: string[];
  /** Total character budget. 0/negative = unbounded. */
  budget: number;
  /** Short hint for how to reach the omitted content (e.g. "Use page:2"). */
  continuation?: string;
}

export interface CapRecallBlocksResult {
  text: string;
  /** Rendered entries dropped by the budget (kept entries printed). */
  omittedEntries: number;
  totalEntries: number;
  /** True when the budget actually cut anything. */
  capped: boolean;
}

/**
 * Entry-aware total budget for a recall response: never slices mid-entry or
 * drops the header — trailing entries are dropped first, then trailing
 * non-entry blocks (observations / footer), and a continuation footer is
 * appended naming how many were omitted.
 *
 * Note: the capping footer is appended after budgeting, so a capped response
 * can exceed `budget` by the footer's length (~150 chars). Deliberate — the
 * footer (with continuation refs) must survive. Assert on `capped`/markers,
 * not on a hard length bound.
 */
export function capRecallBlocks(input: CapRecallBlocksInput): CapRecallBlocksResult {
  const { header, entryBlocks, tailBlocks = [], budget, continuation = "" } = input;
  const totalEntries = entryBlocks.length;
  const unbounded = budget <= 0;

  if (unbounded || (entryBlocks.length === 0 && tailBlocks.length === 0)) {
    const text = [header, ...entryBlocks, ...tailBlocks].filter(Boolean).join("\n\n");
    return { text, omittedEntries: 0, totalEntries, capped: false };
  }

  let total = header.length;
  const kept: string[] = [];
  for (const block of entryBlocks) {
    const cost = block.length + (kept.length > 0 ? 2 : 0); // "\n\n" join
    if (total + cost > budget) break;
    kept.push(block);
    total += cost;
  }
  const omittedEntries = totalEntries - kept.length;

  const keptTail: string[] = [];
  for (const block of tailBlocks) {
    const cost = block.length + (kept.length + keptTail.length > 0 ? 2 : 0);
    if (total + cost > budget) break;
    keptTail.push(block);
    total += cost;
  }

  const text = [header, ...kept, ...keptTail].filter(Boolean).join("\n\n");
  const droppedTail = tailBlocks.length - keptTail.length;

  if (omittedEntries > 0) {
    const note = `\n\n--- recall response capped at ${budget} characters; ${omittedEntries} of ${totalEntries} entries omitted.${continuation ? ` ${continuation}` : ""} ---`;
    return { text: text + note, omittedEntries, totalEntries, capped: true };
  }
  if (droppedTail > 0) {
    const note = `\n\n--- recall response capped at ${budget} characters; related content omitted.${continuation ? ` ${continuation}` : ""} ---`;
    return { text: text + note, omittedEntries: 0, totalEntries, capped: true };
  }
  return { text, omittedEntries: 0, totalEntries, capped: false };
}

export interface CapDrillDownTextInput {
  /** Rendered drill-down output, before the budget cap. */
  text: string;
  /** Paging coordinates of the rendered body, when the expansion produced one. */
  paging?: DrillDownPaging;
  /** Entry index the drill-down query targeted. */
  index: number;
  /** Path pattern the query targeted, echoed back verbatim in the hint. */
  pathPattern: string;
  /** Response budget in characters. 0/negative = unbounded. */
  maxChars: number;
}

const countNewlines = (text: string): number => {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
};

/** First body character: just past the header's last newline. */
function bodyStartIndex(text: string, headerNewlines: number): number {
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      seen++;
      if (seen === headerNewlines) return i + 1;
    }
  }
  return text.length;
}

/**
 * Clip `text` to `max` characters, stopping only at a line boundary: the cut
 * ends right after a newline, so every shown body line is whole and the
 * continuation resumes at exactly the next line — nothing skipped, nothing
 * re-read. Falls back to {@link clip} only when the window contains no newline
 * at all (a header that alone exceeds the budget).
 */
function clipAtLineBoundary(text: string, max: number): string {
  if (max <= 0) return "";
  const nl = text.lastIndexOf("\n", max - 1);
  if (nl < 0) return clip(text, max);
  return text.slice(0, nl + 1);
}

/**
 * Body lines the cut left fully visible. `cut` always ends at a line boundary
 * (or inside the header), so complete lines are the newlines it contains minus
 * the header's; footer newlines can inflate the count, hence the clamp to
 * `shownLines`.
 */
function visibleBodyLines(paging: DrillDownPaging, cut: string): number {
  const complete = countNewlines(cut) - paging.headerNewlines;
  const shown = Math.max(0, Math.min(paging.shownLines, paging.totalLines - paging.startLine));
  return Math.max(0, Math.min(shown, complete));
}

function drillDownCapNote(input: CapDrillDownTextInput, cut: string): string {
  const { paging, index, pathPattern, maxChars } = input;
  const head = `--- recall response capped at ${maxChars} characters; `;
  if (!paging) {
    return `\n\n${head}re-request a narrower range with #${index}:${pathPattern}:offset:limit ---`;
  }
  const visible = visibleBodyLines(paging, cut);
  if (visible === 0) {
    // The cut never left a whole body line: either the header alone ate the
    // budget, or the first body line is longer than what is left of it.
    if (cut.length < bodyStartIndex(input.text, paging.headerNewlines)) {
      return `\n\n${head}no content fit the budget — request one line with #${index}:${pathPattern}:${paging.startLine}:1 ---`;
    }
    const next = paging.startLine + 1;
    if (next >= paging.totalLines) {
      return `\n\n${head}no further lines to page — use a regex query to target a region ---`;
    }
    const limit = Math.min(DRILLDOWN_PAGE_LINES, paging.totalLines - next);
    return `\n\n${head}the line at offset ${paging.startLine} does not fit the budget; continue at #${index}:${pathPattern}:${next}:${limit} ---`;
  }
  const nextOffset = paging.startLine + visible;
  const remaining = paging.totalLines - nextOffset;
  if (remaining <= 0) {
    return `\n\n${head}no further lines to page — use a regex query to target a region ---`;
  }
  const limit = Math.min(DRILLDOWN_PAGE_LINES, remaining);
  return `\n\n${head}continue at #${index}:${pathPattern}:${nextOffset}:${limit} ---`;
}

/**
 * Cap a drill-down response to `maxChars` and append a hint the caller can act
 * on directly: with paging coordinates it names the exact line the cap did not
 * show (`#3:src/a.ts:412:30`), so the next call continues there. The cut only
 * ever lands on a line boundary, so following the hint neither skips nor
 * re-reads content. The hint and the clip reserve each other's space, so the
 * result never exceeds `maxChars`.
 */
export function capDrillDownText(input: CapDrillDownTextInput): string {
  const { text, maxChars } = input;
  if (maxChars <= 0 || text.length <= maxChars) return text;

  // The hint's length depends on the resume numbers, and the resume numbers
  // depend on where the cut lands — which depends on the reserved hint length.
  // Iterate to a fixed point; each round can only shift the cut by the hint's
  // own length, so this settles immediately in practice.
  let note = "";
  for (let round = 0; round < 8; round++) {
    const allowed = maxChars - note.length;
    if (allowed <= 0) return clip(note.trim(), maxChars);
    const next = drillDownCapNote(input, clipAtLineBoundary(text, allowed));
    if (next === note) break;
    note = next;
  }
  const allowed = Math.max(0, maxChars - note.length);
  return allowed > 0 ? clipAtLineBoundary(text, allowed) + note : clip(note.trim(), maxChars);
}
