# Plan 02 — Chunk integrity & failure visibility

**Phase:** 2 of 4 — correctness fixes. **Behavior change: YES** (fixes silent data loss; oversized entries become marked excerpts; new debug events).
**Master doc:** `plan-00-overview.md` (decisions D8, D9).
**Depends on:** nothing hard (Phase 1's `tokens.ts` module is convenient but not required). **Blocks:** nothing (Phase 3 benefits from honest `chunkTokens` but doesn't require it).

---

## 1. Goal

Fix the two halves of upstream issue #32 in our tree:

1. **Make the observer chunk structurally incapable of (a) losing data silently and (b) overflowing the worker window** — replace `capSourceEntriesToTokens` with serializer-level budgeting: oldest-first, honest budget, head/tail excerpt for single oversized entries, coverage advances only through ids the serializer actually returned (upstream PR #34 semantics).
2. **Land the content-trimming layer of the Worker Safety Invariant** (promoted from deferred — see plan-00 D13): head+tail trimming of tool results and thinking blocks in the observer-bound serializer, so a ~128k worker can always ingest what a 1M session accumulates.
3. **Make stream-level LLM failures visible** — port upstream PR #33's `logAgentStreamError` into all three agent drain loops and surface the last error into the runtime status fields.

## 2. Why these two together

They are one failure story (#32): the livelock existed because the chunk could outgrow the window **and** the failure was invisible. Upstream shipped their halves as separate PRs (#34 merged, #33 merged); we land them as one coherent phase — plus the trimming layer that turns "the worker can ingest the backlog" from an assumption into a tested guarantee.

**Correction surfaced while planning:** chunk-content trimming does **not** exist in our tree today. `truncateRecordContent` (`serialize.ts` L117, 10k chars, head-only) only truncates what agents _write_ (their own observation/reflection records). The observer's _input_ — source tool results and thinking blocks — is serialized untrimmed; pi's own tool-output truncation happens at capture time and still lets giants through (the 1.7M-char case). The author believed trimming already protected small workers; it does not. This phase adds it (§4.5).

## 3. Current-state bugs being fixed (evidence)

- `capSourceEntriesToTokens` (`src/om/consolidation.ts` L102) walks **newest-to-oldest**: when the backlog exceeds the cap, the _oldest_ uncovered entries are dropped and `coversUpToId` jumps past them → that conversation is **permanently never observed**. The function carries an unresolved internal debate comment ("Remove the `kept.length > 0` guard? No — …").
- A single oversized entry is included **whole** ("include it anyway to avoid data loss") — upstream shipped exactly this in PR #34 v1 and immediately hit the real **1.7M-char tool result** that still blew the window; their merged fix is the marked head/tail excerpt.
- The cap budget counts message-content chars (+ JSON for custom OM entries) — **not** the actual sent text: no `[Source entry id: …]` labels, no separators, no `branch_summary` rendering. Actual sent text can exceed the cap.
- Agent drain loops (`observer/agent.ts` L273, `reflector/agent.ts` L204, `dropper/agent.ts` L393) ignore every event — a `stopReason: "error"` final message is indistinguishable from "no observations".

## 4. File-by-file spec

### 4.1 `src/om/serialize.ts` — budget-aware source serialization (rewrite of one function)

Extend `SourceAddressedSerialization` and `serializeSourceAddressedBranchEntries` to upstream PR #34's semantics, adapted to our style:

```ts
export type SourceAddressedSerialization = {
  text: string;
  sourceEntryIds: string[];
  estimatedTokens: number; // NEW — estimateStringTokens(text), the honest sent size
  truncatedSourceEntryIds: string[]; // NEW — ids sent as head/tail excerpts
};

export type SourceAddressedSerializationOptions = {
  maxTokens?: number; // NEW — estimate-basis budget over the ACTUAL rendered text
};
```

Rules (upstream invariants, verbatim intent):

- Walk entries **oldest-first**; render each via existing `serializeBranchEntries([entry])`; block = `[Source entry id: <id>]\n<rendered>`; separator `\n\n`; budget counts `estimateStringTokens(separator + block)` — labels and separators included.
- Adding a block that would exceed `maxTokens` with blocks already present → **break** (remaining entries stay eligible next run).
- First (oldest) entry alone exceeding the budget → **head/tail excerpt**: fixed parts = label + `SOURCE_OMISSION_MARKER`; if fixed parts alone exceed the budget → return **no chunk at all** (empty result; coverage cannot advance without a complete source label — the min-budget guard). Else split remaining char budget evenly head/tail:
  ```
  [… middle omitted: source exceeds observer input budget; original source remains in the session ledger …]
  ```
  The ledger entry is never modified; `renderRecallSourceEntry` still resolves the full source.
- Return `estimatedTokens` (of the final text) and `truncatedSourceEntryIds`.
- No `maxTokens` → today's behavior exactly (all blocks), plus the two new fields filled.

### 4.2 `src/om/consolidation.ts` — `runObserverStage` rewire

- **Delete `capSourceEntriesToTokens`** (and its internal debate comment) — no other caller exists (verify with `rg`).
- **Move `resolveModel("observer")` before chunk construction** (the derived cap needs the resolved worker window — same move upstream made; a resolution failure now aborts before the "observer running" notification). Note: our resolution lives inside the `MAX_STAGE_ATTEMPTS` loop today because it participates in the fallback chain; restructure so the _first_ resolution happens up front for budgeting, and the retry loop re-resolves on failure as today. If this proves awkward, alternative: compute the cap from the best synchronously-known worker window (stage config model → session model → 128k) and keep the loop as-is. Decide at implementation; document the choice.
- Chunk construction:
  ```ts
  const workerWindow = effectiveContextWindow(
    resolved.model,
    stageModelConfig(runtime, "observer"),
  );
  const maxChunkTokens = resolveObserverChunkMaxTokens(runtime.config, workerWindow); // §4.4
  const backlog = sourceEntriesAfter(entries, effectiveStart);
  const {
    text: chunk,
    sourceEntryIds,
    estimatedTokens: chunkTokens,
    truncatedSourceEntryIds,
  } = serializeSourceAddressedBranchEntries(backlog, { maxTokens: maxChunkTokens });
  const coversUpToId = sourceEntryIds.at(-1); // LAST ID THE SERIALIZER RETURNED — not backlog tail
  ```
- `observer.chunk_capped` debug event when `sourceEntryIds.length < backlog.length || truncatedSourceEntryIds.length > 0` with `{ maxChunkTokens, backlogEntries, backlogTokens: tokens, chunkEntries, chunkTokens, truncatedSourceEntryIds }`.
- Notification: keep our richer form but make both numbers honest: `observer running on ~<chunkTokens>-token chunk (of <tokens> accumulated)`.
- `observer.start` debug event gains `chunkTokens`.
- The existing `observer.context_window_exceeded` pre-check now uses serializer-honest `chunkTokens` — keep as-is otherwise.
- Cursor/coverage advance paths (`not_due`, `empty`, success) unchanged — they already key off `coversUpToId`.

### 4.3 `src/om/agents/stream-errors.ts` (new) + three drain loops

Port upstream PR #33 nearly verbatim:

```ts
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { debugLog } from "../debug-log.js";

export function logAgentStreamError(
  stage: "observer" | "reflector" | "dropper",
  event: AgentEvent,
): void {
  if (event.type !== "message_end") return;
  const message = event.message;
  if (message.role !== "assistant") return;
  if (message.stopReason !== "error" && message.stopReason !== "aborted") return;
  debugLog(`${stage}.stream_error`, {
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
  });
}
```

- Wire one line into each drain loop (`observer/agent.ts` L273, `reflector/agent.ts` L204, `dropper/agent.ts` L393) — our loops already iterate `event`, so it's import + call.
- **Surfacing:** in `consolidation.ts`, the agents return empty/undefined on swallowed errors — additionally record `runtime.lastObserverError` / `lastReflectorError` / `lastDropperError` (fields exist, `runtime.ts` L100/L467) when a stage ends empty _and_ a stream error was seen. Cleanest: have `logAgentStreamError` also return/record the error so the stage can capture it (e.g. a small per-run collector the agent exposes, or the stage passes a callback). Keep it simple: the helper takes an optional `onError?: (msg: string) => void` the agent forwards from its args; the stage passes a setter. Status overlay shows the fields already.

### 4.4 `src/om/serialize.ts` — content trimming (Worker Safety Invariant, layer a)

**Policy (validated on the 674-window archive simulation):**

- Tool-result text blocks > 4096 chars → first **1000** + last **1000** chars, joined by a marked omission note. (1000/1000 chosen over 500/500: median 31% vs 34% total savings — not worth the extra loss.)
- Thinking blocks > 4096 chars → first **20%** + last **20%**, marked. (Rationale validated on 620 real blocks: head restates the task, tail concludes, middle is least valuable. Median thinking save only 1%, but p90 48% / max 60% — this is a long-session tail guard.)
- **Open implementation decision (record at execution):** extreme blocks (largest observed: 90,516 chars) — pure 20% still keeps ~18k chars of head; consider an absolute head/tail cap (~2–4k chars each): `head = min(20%, 4000)`. Default: implement the cap; the simulation numbers barely move and worst cases become bounded.
- Trims are **visible markers in the text** (like the excerpt marker), so the observer knows content was elided; the full source entry stays in the ledger for `recall`.

**Composition order inside the serializer:** trim content while rendering each entry → measure the trimmed block against the budget → excerpt only if the (already-trimmed) single oldest entry still exceeds the budget. Trim-then-budget means the excerpt path is the last resort, not the norm.

**Scope:** applied in the observer-bound source serialization only (`serializeBranchEntries` is also used by recall — verify call sites; if recall uses the same function, add a `{ trim: boolean }` option, default off, enabled only from the observer chunk path). Reflector/dropper inputs are LLM-written summaries (already small, and `truncateRecordContent` guards records) — no trimming there.

### 4.5 `src/om/model-budget.ts` — `resolveObserverChunkMaxTokens`

New helper (home: `src/om/model-budget.ts` next to `effectiveContextWindow` — it is a budget, not a trigger):

```ts
export const OBSERVER_CHUNK_CONTEXT_RATIO = 0.2;
export const OBSERVER_CHUNK_MIN_TOKENS = 256;
export const OBSERVER_CHUNK_FALLBACK_WINDOW = 128_000;

/** 0/undefined/invalid config → floor(window × 0.2) clamped ≥ 256.
 *  Explicit >0 → clamped ≥ 256. Window comes from effectiveContextWindow
 *  (config override → model metadata → 128k). */
export function resolveObserverChunkMaxTokens(
  configValue: number | undefined,
  workerWindow: number,
): number;
```

- Config plumbing: `observerChunkMaxTokens` gains `0 = auto` semantics — normalize with `nonNegativeInt` (same pattern as `observerPreambleMaxTokens`); **default changes 40000 → 0** in `unified-config.ts`. (This is the one Phase-2 config change; it is backward compatible since 0 previously meant "absent → default".)
- **0.2 rationale (upstream):** chars/4 undercounts non-ASCII up to ~4×, so worst case lands ~80% of the window with room for system prompt + prior memory + response.

## 5. Steps

1. `serialize.ts`: trimming policy (§4.5) + budget options + excerpt + new fields → verify: `npx tsc --noEmit` + new serializer tests green
2. `model-budget.ts`: `resolveObserverChunkMaxTokens` → verify: tsc + unit tests green
3. `unified-config.ts`: `observerChunkMaxTokens` nonNegative + default 0 → verify: tsc + `tests/config.test.ts` update green
4. `consolidation.ts`: delete `capSourceEntriesToTokens`, rewire `runObserverStage` chunk build + `observer.chunk_capped` + model-resolution order → verify: `rg capSourceEntriesToTokens` returns zero hits; tsc; `tests/consolidation.test.ts` green (update cap-related assertions)
5. `stream-errors.ts` + three agents + runtime error surfacing → verify: tsc + new stream-errors tests green
6. Full suite → verify: `npx vitest run`
7. Smoke: run a dev session, force an oversized entry (or replay the 1.7M-char fixture), confirm `observer.chunk_capped` + excerpt in the chunk + coverage advances → verify: debug log shows the event; ledger marker `coversUpToId` = returned id
8. Smoke 2: session with giant tool results/thinking → confirm trimmed markers in the observer chunk and reduced `chunkTokens` vs pre-trim → verify: debug log
9. Commit(s): "fix(om): worker-safe observer chunks — trim, serializer budget (oldest-first, excerpt) — upstream PR#34 semantics + trim policy" + "feat(om): stream error visibility for observer/reflector/dropper — upstream PR#33" → verify: two logical commits, attribution in messages

## 6. Test plan

**`tests/source-serialization-budget.test.ts` (new, adapted from upstream):**

- All blocks kept when fitting; later entries stay for next run when budget full (oldest-first order preserved); **no chunk** under unusably-small budget (label guard); single huge tool result → marked head/tail excerpt with `truncatedSourceEntryIds`, `estimatedTokens ≤ budget`, `HEAD:`/`:TAIL` retained, next entry excluded; `renderRecallSourceEntry` still returns the full original; no-`maxTokens` call → all blocks + correct new fields.
- **Trim cases:** tool result > 4096 chars → head 1000 + tail 1000 + marker; ≤ 4096 untouched; thinking block > 4096 → 20%/20% + marker (and absolute cap if implemented); recall rendering untrimmed (`trim` option off); trim composes with budget (trimmed entry fits without excerpt).

**`tests/stream-errors.test.ts` (new, adapted from upstream):**

- error/aborted logged with stage prefix; stop/user/other events ignored; end-to-end `runObserver` with failing fake loop → `undefined` + one `observer.stream_error`; `onError` callback fires.

**`tests/model-budget.test.ts` (extend):** cap resolution — explicit > derived; derived from window (1280 → 256; 1M → 200000); min clamp; invalid window (0/NaN) → fallback.

**`tests/consolidation.test.ts` (update + extend):**

- Oversized backlog capped and drained incrementally across runs: first call `allowedSourceEntryIds: ["raw-1"]`, `coversUpToId: "raw-1"`; next run continues from `"raw-2"` (adapt upstream test to our cursor/pending harness).
- Single oversized tool result → excerpt, provenance preserved, next run proceeds.
- Derived cap from resolved model `contextWindow` (mock `resolveModel` with 1280 → cap 256).
- Notification assertion updated to the honest-chunk format.
- Existing cap tests referencing newest-first behavior → rewritten to oldest-first semantics.

**`tests/config.test.ts` (update):** `observerChunkMaxTokens: 0` accepted (auto); negative rejected; explicit honored.

## 7. Edge cases

- [ ] Backlog of many small entries → drains oldest-first, coverage advances each run (no more silent drops)
- [ ] Single 1.7M-char tool result → trimmed first, excerpt only if still over; the rest of the backlog waits for later runs
- [ ] Budget smaller than label+marker → empty chunk, stage continues without advancing (no false coverage)
- [ ] `branch_summary` entries in backlog → rendered and budgeted like any source entry
- [ ] CJK-heavy chunk → 0.2 ratio keeps worst case ~80% of window (upstream reasoning)
- [ ] **1M session + 128k worker** (the author's case): chunk ≤ ~25.6k estimated tokens of trimmed content per run, every run; backlog drains across runs; no overflow possible (invariant test with a synthetic giant backlog)
- [ ] Manual mode: pending-skip check keys off `coversUpToId` — now the serializer's last id; pending batches store the same id; consistent
- [ ] Worker window from `effectiveContextWindow` config override — honored (upstream lacked this chain)
- [ ] Trimming does not touch user/assistant text content — only tool results and thinking blocks

## 8. Rollback

Two independent commits (serializer/cap, stream-errors); each revertable alone. Config default change (40000 → 0) reverts with the cap commit.
