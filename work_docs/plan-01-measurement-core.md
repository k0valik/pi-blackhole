# Plan 01 — Measurement core (usage-aware counters)

**Phase:** 1 of 4 — foundation. **Behavior change: NONE** (add-only; nothing calls the new code until Phase 3).
**Master doc:** `plan-00-overview.md` (decisions D1–D4).
**Depends on:** nothing. **Blocks:** Phase 3.

---

## 1. Goal

Build the single measurement core every later phase consumes: usage-data helpers, entries-only real-token counters with anchor semantics, basis-tagged results, and an extended effective-window resolver. Land it with full unit tests and zero call-site changes — a safe, reviewable, revertable foundation.

## 2. Scope

**In:** `src/om/tokens.ts`, `src/om/ledger/progress.ts`, `src/om/model-budget.ts`, `src/om/ledger/index.ts` (re-exports), `tests/session-ledger-progress.test.ts`, new `tests/tokens-usage.test.ts`, `tests/model-budget.test.ts` (extend).

**Out:** any caller changes (compaction-trigger, consolidation, memory.ts) — Phase 3. Config changes — Phase 3. `observationLineTokenCount` adoption at call sites — Phase 4 (the helper itself lands here in `tokens.ts` so Phase 2's serializer work can share the module cleanly... actually it is not needed until Phase 4; include it here anyway — it is a pure helper with tests, zero risk).

## 3. File-by-file spec

### 3.1 `src/om/tokens.ts` — usage helpers (additive)

Keep the file's upstream-tracking header note but amend it ("Modified: usage helpers added — see work_docs/plan-01").

```ts
import { calculateContextTokens } from "@earendil-works/pi-coding-agent";

/** True when `msg` is an assistant message carrying positive provider usage. */
export function hasUsageData(msg: unknown): boolean;

/** Provider-reported context tokens for a message, or undefined when absent/invalid.
 *  Wraps pi's calculateContextTokens (totalTokens first, components fallback);
 *  returns undefined for non-assistant roles, error/aborted stopReasons, and
 *  zero/NaN totals. Never reads ToolResultMessage.usage (pi: "not part of main
 *  LLM context accounting"). */
export function getUsageTokens(msg: unknown): number | undefined;

/** Rendered-footprint token count of one observation line:
 *  `[id] timestamp [relevance] content` (estimate basis). */
export function observationLineTokenCount(observation: {
  id: string;
  timestamp: string;
  relevance: string;
  content: string;
}): number;
```

Implementation notes:

- `getUsageTokens` checks `role === "assistant"`, `stopReason !== "error" && stopReason !== "aborted"`, then `calculateContextTokens(usage)` with a `> 0 && Number.isFinite` guard, wrapped so a malformed `usage` object yields `undefined`, never a throw.
- Attribute the approach in a comment: tavasti@360f24a (fork) + upstream PR #40 (`contextTokensFromUsage`/`validAssistantContextTokens`).
- `calculateContextTokens` is runtime-verified public on pi 0.83.0 (peer floor 0.81.1 has it too).

### 3.2 `src/om/ledger/progress.ts` — real counters (additive)

New exported types and functions; existing raw counters untouched (they become the fallback path in Phase 3).

```ts
export type CountBasis = "usage" | "estimate";

/** Last index <= beforeIndex of an assistant message with valid usage, or -1. */
export function lastValidUsageIndex(entries: Entry[], beforeIndex: number): number;

/** First index >= afterIndex of an assistant message with valid usage, or -1. */
export function firstValidUsageIndex(entries: Entry[], afterIndex: number): number;

/** chars/4 estimate over source entries strictly after `index`
 *  (existing rawTokensAfterIndex — reused, not duplicated). */

/** Real current context tokens: last valid assistant usage STRICTLY AFTER the
 *  last compaction entry + trailing estimate of source entries after it.
 *  undefined when no valid post-compaction usage exists (fresh session without
 *  assistant turns, right after compaction, error storms, providers without usage).
 *
 *  D3: usage at/before the compaction entry reflects PRE-compaction context and
 *  the compaction entry's own usage is the summary call — both excluded. */
export function realContextTokens(entries: Entry[]): number | undefined;

/** Baseline real tokens at a coverage/cursor anchor: last valid usage at or
 *  before `anchorIndex`. undefined when none exists. */
export function realTokensAtAnchor(entries: Entry[], anchorIndex: number): number | undefined;

/** Real growth since an anchor (coverage marker, cursor, or compaction).
 *  Anchor precedence (upstream PR #40): if the last compaction is NEWER than the
 *  anchor, the baseline is the first valid usage after the compaction; otherwise
 *  the last valid usage at/before the anchor. Negative deltas (mid-session model
 *  switch / usage-basis change) → undefined. No anchor at all (-1) → current
 *  real context. undefined → caller falls back to the raw estimate (D4). */
export function realTokensSinceAnchor(entries: Entry[], anchorIndex: number): number | undefined;

/** Basis-tagged measurement: real when computable, raw-estimate fallback otherwise. */
export function measureSinceAnchor(
  entries: Entry[],
  anchorIndex: number,
): { tokens: number; basis: CountBasis };
```

Semantics details (encode these as tests, §5):

- `realContextTokens` = `usage(lastValidUsageIndex(entries, len-1, strictly after lastCompaction))` + `rawTokensAfterIndex(entries, thatIndex)`; `undefined` if no such index. When there is **no compaction** in the branch, the scan is over the whole branch.
- "Strictly after the compaction entry": index must be `> findLastCompactionIndex(entries)`. Note our `rawTokensSinceLastCompaction` anchors at `firstKeptEntryId − 1` for the _estimate_; the usage scan instead keys off the compaction entry index — the two coexist (estimate fallback keeps its semantics).
- `realTokensSinceAnchor(entries, anchorIndex)`:
  - `compactionIdx = findLastCompactionIndex(entries)`; if `compactionIdx > anchorIndex` → baseline = usage at `firstValidUsageIndex(entries, compactionIdx + 1)` (undefined → `undefined`).
  - else if `anchorIndex >= 0` → baseline = `realTokensAtAnchor(entries, anchorIndex)` (undefined → `undefined`).
  - else → return `realContextTokens(entries)`.
  - delta = `realContextTokens(entries) − baseline`; `delta < 0` → `undefined`. Note `realContextTokens` undefined → `undefined`.
- `measureSinceAnchor` = `{ tokens: real, basis: "usage" }` when defined, else `{ tokens: rawTokensAfterIndex(entries, anchorIndex), basis: "estimate" }`.

### 3.3 `src/om/model-budget.ts` — window resolution (additive)

```ts
/** Resolve the session model's effective context window.
 *  Order: getContextUsage().contextWindow (provider-reported, guarded — the
 *  extension ctx can be stale in deferred paths) → model.contextWindow → 128k.
 *  `getContextUsage` is passed as an optional thunk so callers decide how to
 *  source it (direct ctx capture, or undefined in tests/stale paths). */
export function resolveSessionContextWindow(
  model: { contextWindow?: number } | undefined,
  getContextUsage?: () => { contextWindow?: number } | undefined,
): number;
```

- Guard the thunk call in try/catch (stale ctx throws "extension ctx is stale"); any failure → next source.
- `effectiveContextWindow` (worker windows, config-override chain) stays as-is — used per stage in Phase 3.

### 3.4 `src/om/ledger/index.ts`

Re-export the new progress functions (follow existing re-export pattern).

## 4. Steps

1. `tokens.ts`: add the three helpers → verify: `npx tsc --noEmit`
2. `progress.ts`: add basis type + five functions + reuse `rawTokensAfterIndex` → verify: `npx tsc --noEmit`
3. `model-budget.ts`: add `resolveSessionContextWindow` → verify: `npx tsc --noEmit`
4. `ledger/index.ts`: re-exports → verify: `npx tsc --noEmit`
5. Tests (§5) → verify: `npx vitest run tests/session-ledger-progress.test.ts tests/tokens-usage.test.ts tests/model-budget.test.ts`
6. Full suite → verify: `npx vitest run` (no regressions; nothing calls the new code)
7. Commit: "feat(om): usage-aware measurement core (plan-01; tavasti@360f24a approach, upstream PR#40 anchor semantics)" → verify: git log shows single commit, diff is add-only except header note

## 5. Test plan

**`tests/tokens-usage.test.ts` (new):**

- `hasUsageData`/`getUsageTokens`: assistant with `totalTokens` → value; components-only (`input+output+cacheRead+cacheWrite`) → sum; zero/NaN/missing usage → undefined; `stopReason: "error"|"aborted"` → undefined; user/toolResult roles → undefined (even if a `usage` field is present on the toolResult).
- `observationLineTokenCount`: matches `estimateStringTokens(`[id] ts [rel] content`)` exactly.

**`tests/session-ledger-progress.test.ts` (extend — follow existing fixture patterns in `tests/fixtures/session.ts`):**

- `realContextTokens`: no compaction → last usage + trailing est; compaction then new assistant → post-compaction usage + trailing; compaction with **no** post-compaction assistant → `undefined` (not stale pre-compaction usage!); error-storm (only error/aborted assistants after compaction) → `undefined`; entries with usage on kept pre-compaction assistants only → `undefined`.
- `realTokensAtAnchor`: usage before anchor → nearest-at/before value; none → `undefined`; usage exactly at anchor index → used.
- `realTokensSinceAnchor`: coverage anchor after compaction → delta vs at-anchor baseline; anchor before compaction → baseline = first usage after compaction; negative delta (baseline > current — simulate model switch by shrinking totals) → `undefined`; anchor `-1` with no compaction → current real; `realContextTokens` undefined → `undefined`.
- `measureSinceAnchor`: usage path → `{ basis: "usage" }`; fallback path (no usage anywhere) → `{ basis: "estimate" }` and equals `rawTokensAfterIndex`.
- Regression: existing raw-counter tests unchanged and green.

**`tests/model-budget.test.ts` (extend):**

- `resolveSessionContextWindow`: thunk value wins → model value next → 128k floor; throwing thunk → falls through; non-positive/NaN values → falls through.

## 6. Edge cases checklist (from the semantic diff, §7.2 anchor taxonomy)

- [ ] Fresh session, zero assistant messages → all real counters undefined → estimate basis
- [ ] Right after compaction, before next response → undefined (matches pi's `getContextUsage().tokens === null`)
- [ ] Compaction entry's own `usage` field present in data → never used as baseline
- [ ] Anchor entry removed by a later compaction → callers pass freshly-resolved indices (Phase 3 resolves `entryIndexForId` at call time); `anchorIndex = -1` handled
- [ ] Trailing after last usage includes user messages + tool results (they are source entries) — matches pi's `estimateContextTokens` trailing semantics
- [ ] `custom` (OM marker) entries are NOT source entries → excluded from trailing (they never reach the LLM context)

## 7. Rollback

Single revert commit; no call sites, no config, no state files touched.
