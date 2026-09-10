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
