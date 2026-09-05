# Upstream semantic diff — elpapi42/pi-observational-memory token & trigger fixes → pi-blackhole

**Date:** 2026-08-01
**Source artifacts (fetched via `gh`):**

- Issue #32 (root cause, real user observations) — `gh issue view 32 --repo elpapi42/pi-observational-memory`
- PR #33 (merged) — stream error logging
- PR #34 (merged) — observer chunk cap
- Commit `3677e591` (merged) — compaction ratio mode
- PR #40 (open) — real provider-usage trigger thresholds

This is a **semantic** diff, not a port plan. Purpose: extract _what upstream learned_, map each concept onto our (heavily diverged) tree, and flag where our existing machinery already diverges in ways that change the semantics. **No code changes.**

---

## 1. The upstream story — one root cause, four fix layers

### Issue #32 — the terminal failure mode (real user observations)

Observer permanently stuck when the uncovered span behind the observation watermark grows past the model's context window:

- **383 consecutive failed observer calls over two days.** Each "ran" ~3s (a gateway rejection, not inference), surfaced only as the generic _"observer returned no observations"_ warning.
- **chars/4 undercounts non-ASCII ~4×**: debug log showed `tokens=813066` estimated for a chunk that was **>1M real tokens** (`prompt is too long: 5198507 tokens > 1000000 maximum`).
- **Error is invisible by construction**: agent-core doesn't throw on LLM failure — it ends the stream with a final assistant message carrying `stopReason: "error"` + `errorMessage`. The drain loops ignored every event, so a failed call was indistinguishable from "the model chose to record nothing".
- **No self-heal**: chunk built from everything after `latestCoverageIndex(OM_OBSERVATIONS_RECORDED)` with no cap → failure → no marker → next chunk strictly bigger → permanent livelock. `/compact` doesn't help because the chunk starts at the coverage marker, not at the compaction point.
- **Two easy ways in**: a stretch of failed observer calls (provider outage/auth hiccup), or enabling the extension mid-way into an already-long session.

Commenter (IgorGanapolsky) added a hard rule that generalizes beyond this package: **treat API errors as terminal for that observer slice, and advance/shrink the watermark on failure — never only on success**; consider a circuit breaker after N consecutive failures.

### PR #33 — visibility layer (merged, logging-only)

`src/agents/stream-errors.ts`: `logAgentStreamError(stage, event)` watches `message_end` events while draining; logs `<stage>.stream_error` with `stopReason` + `errorMessage` when `stopReason === "error" | "aborted"`. Wired into all three agents' drain loops (`for await (const _event of stream)` → `event`). Turns two days of head-scratching into one grep.

### PR #34 — observer chunk cap (merged)

- **Config** `observerChunkMaxTokens`: explicit value wins → else `floor(contextWindow * 0.2)` of the resolved memory model → else `60000` fallback. Minimum `256` (enough for label + omission marker + useful context; tiny user settings can't truncate the source label and falsely advance coverage).
- **0.2 rationale**: chunk sizes come from the ~4 chars/token estimator, which undercounts non-ASCII up to ~4×, so worst case lands ~80% of the window with room for system prompt + prior memory + response.
- **Serializer budget**: `serializeSourceAddressedBranchEntries(entries, { maxTokens })` — oldest-first, complete entries kept whole, **coverage advances only through ids the serializer actually returned**. If the _oldest_ entry alone exceeds the budget, it is sent as a clearly marked **head/tail excerpt** (`[… middle omitted: source exceeds observer input budget …]`) under its original source id; the raw session entry is untouched, so `recall` still resolves the full source.
- **`observer.chunk_capped`** debug event: cap, backlog size, chunk size, truncated ids.
- Model resolution moved _before_ chunk construction (the derived cap needs the resolved model).
- Notification now reports the **actual chunk tokens**, not the backlog tokens.

**Comment trail (WSXYT, both rounds matter):** first version kept the _whole_ first entry even when over cap — and immediately hit a **1.7M-character tool result** that still blew the window. The follow-up (in the merged PR) is the head/tail excerpt: "chunk budgeting now lives in the source-addressed serializer and measures the actual text sent to the observer, including source labels… Coverage advances only through ids the serializer actually returned… I also added a minimum useful budget and a guard so an extremely small user setting can never truncate the source label and falsely advance coverage."

### Commit `3677e591` — compaction ratio mode (merged)

- `compactAfterTokensMode: "calibrated" | "ratio"` (default `calibrated`, backwards-compatible), `compactAfterTokensRatio` default `0.68`, must be in `(0, 1)` (0 would never trigger; ≥1 would compact at/after the full window with no room for the response).
- `resolveCompactAfterTokens(config, contextWindow)`: ratio → `max(1, floor(window * ratio))`; falls back to calibrated value when window is undefined/0/negative so compaction is always safe.
- `/om:status` shows the **resolved** threshold on the "Next compaction" line.
- Rationale: static 81K preempts a 1M window at 8%; but **context window ≠ attention**, so the ratio is user-tunable (lower it on models that degrade at long range).

### PR #40 — real provider-usage trigger thresholds (open, the big one)

All trigger thresholds were measured on **estimated** tokens (chars/4 of source entries only) while the UI percentage and pi's own ratio threshold scale with the **model's context window**. Measured divergence in real sessions: **19–46% undercount vs actual provider usage**. Concrete: with `compactAfterTokensRatio` 0.35 on a 1M window, the footer can show 36% while the estimate sits at ~25–30% — sessions visibly cross the threshold and auto-compaction never fires. Observer fired at ~11–19K real tokens when configured for 10K.

Changes:

- **`compaction-trigger.ts`**: read `ctx.getContextUsage()` (prefers last assistant message `usage.totalTokens`, falls back to `input+output+cacheRead+cacheWrite`; exactly the footer percent basis). Prefer the reported `contextWindow` for ratio mode. Raw-estimate fallback when `getContextUsage` is absent (older pi).
- **`consolidation-trigger.ts`** (observer/reflector): **anchor-based real-token deltas** — real context now minus real context at the last coverage/compaction anchor. Configured 10K now means 10K of _real_ context growth. Same raw fallback.
- **`progress.ts`**: `contextTokensFromUsage`, `realContextTokensAfterCompaction`, `realContextTokensAtCoverage`, `realTokensSinceAnchor`.
- **`pool.ts` / `observer/agent.ts` / `tokens.ts`**: `observationLineTokenCount` — pool budget and stored `tokenCount` count the **full rendered line** (`[id] timestamp [relevance] content`), not bare content, because that's the actual footprint the observer writes back.

**The key architectural insight (this is the "cannot reuse verbatim" answer):**

> The usage carried **on the compaction entry itself is the summary-generation call's usage** — pre-compaction scale, a different LLM call — so it is deliberately NOT a valid post-compaction baseline. The baseline is the **first valid assistant usage AFTER the compaction entry**.

Two more correctness rules from the anchor logic:

- **Negative delta** (mid-session model/provider switch with a different usage basis) → treat as _unmeasurable_ → **fall back to the raw estimate**, not clamp to 0 (would starve the stage forever) and not measure from zero (would read the whole context as growth and re-fire every turn).
- `realContextTokensAtCoverage` walks **backward from the coverage index** to the last valid assistant usage at/before the anchor; error/abort messages (`stopReason: "error" | "aborted"`) are excluded from usage baselines.

**Deliberate out of scope** (PR #40, and it matters for us too):

- **Outbound budgets** — observer chunk cap serializer, agent-loop `maxTokens`: text that has never been through the LLM has no provider usage; chars/4 is the only and correct tool.
- **Internal accounting** — full-fold pressure, dropper coverage/stats, status sums: comparisons against _other internal config values on the same estimate basis_ are self-consistent and don't drift like estimate-vs-window comparisons do.
- **Known cosmetic drift**: newly recorded observations store line-based `tokenCount` while old ones store content-only — self-heals as observations are replaced.

---

## 2. Semantic mapping onto pi-blackhole

### 2.1 Host capability (verified against our installed pi 0.83.0)

| Primitive                                                                                           | Available?               | Notes                                                                                                                |
| --------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `ctx.getContextUsage(): { tokens: number \| null, contextWindow: number, percent: number \| null }` | ✅ on `ExtensionContext` | `tokens` is `null` right after compaction / before next LLM response — exactly PR40's "unmeasurable → fallback" case |
| `calculateContextTokens(usage)`                                                                     | ✅ exported              | "Uses native totalTokens when available, falls back to components" — the tavasti-fork helper, typed                  |
| `getLastAssistantUsage(entries)`                                                                    | ✅ exported              | pi's own "last valid assistant usage" scan                                                                           |
| `estimateContextTokens(messages): { tokens, usageTokens, trailingTokens, lastUsageIndex }`          | ✅ exported              | pi's own usage + trailing-estimate semantics — the exact model our plan's compaction counter wants                   |
| `Usage` shape                                                                                       | ✅                       | `totalTokens`, `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning?`, `cost`                                    |

### 2.2 Upstream change → our file → our current state

| Upstream (concept)                                                        | Our file                                                                                                  | Our current state                                                                                                                                                             | Gap                                                                                                                                                |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stream-errors.ts` + `<stage>.stream_error`                               | `src/om/agents/{observer,reflector,dropper}/agent.ts` drain loops                                         | Loops use `for await (const event of stream)` but ignore events; `observer.error`/`reflector.error`/`dropper.error` debug events exist but only fire on **thrown** exceptions | **Missing.** Swallowed `stopReason: "error"` messages (the #32 failure) never reach the debug log. Cheap to add, matches PR #33 exactly            |
| `observerChunkMaxTokens` config                                           | `src/om/config.ts` → `src/core/unified-config.ts` (L195)                                                  | **Exists**, but static default `40_000`                                                                                                                                       | Upstream derives `floor(window × 0.2)` with 60K fallback + 256 min clamp. No derivation, no clamp                                                  |
| Serializer budget (`maxTokens`, oldest-first, excerpt)                    | `src/om/serialize.ts` `serializeSourceAddressedBranchEntries` (L194)                                      | No options; unbounded; no excerpt                                                                                                                                             | See §2.3 divergence #1–#3                                                                                                                          |
| Chunk capping in `runObserverStage`                                       | `src/om/consolidation.ts` `capSourceEntriesToTokens` (L102)                                               | Exists, but **newest-first** and over-budget single entry sent **whole**                                                                                                      | Direction inverted vs upstream (data loss), no excerpt (the exact 1.7M-char-tool-result failure)                                                   |
| `observer.chunk_capped` event                                             | `src/om/consolidation.ts` debug events                                                                    | Absent                                                                                                                                                                        | Missing                                                                                                                                            |
| Model resolution before chunk build                                       | `src/om/consolidation.ts` `runObserverStage`                                                              | Model resolved inside the retry loop (L799)                                                                                                                                   | Minor; ours has `effectiveContextWindow` + `observer.context_window_exceeded` upper-bound check (unique to us) that partially covers the intent    |
| Ratio mode (`compactAfterTokensMode`/`Ratio`/`resolveCompactAfterTokens`) | `src/om/config.ts`, `src/om/compaction-trigger.ts`, `src/commands/memory.ts`                              | **Absent entirely**                                                                                                                                                           | New feature, self-contained (see §4 decision)                                                                                                      |
| `getContextUsage()` in compaction trigger                                 | `src/om/compaction-trigger.ts` (L135, L289, L411)                                                         | Raw `rawTokensSinceLastCompaction` only                                                                                                                                       | PR40 approach viable on our host; must respect our `effectiveContextWindow` override chain                                                         |
| `realTokensSinceAnchor` + anchor helpers                                  | `src/om/ledger/progress.ts`                                                                               | Only raw counters (`rawTokensSince*Coverage`, `rawTokensSinceLastCompaction`)                                                                                                 | Missing — this is the piece our plan flagged as "can't reuse verbatim"                                                                             |
| `stageDue` real-delta gating                                              | `src/om/consolidation.ts` `anyStageDue` (L204) + `runObserverStage`/`runReflectorStage`/`runDropperStage` | Raw `rawTokensSince*Coverage` vs threshold                                                                                                                                    | **Complicated by our unique features** — see §2.3 #5–#8                                                                                            |
| `observationLineTokenCount`                                               | `src/om/tokens.ts` + `observer/agent.ts` L185 + `dropper/agent.ts` L224/L424                              | `tokenCount: estimateStringTokens(content)` (content-only); pool sums bare `tokenCount`                                                                                       | Same drift upstream fixed; note our `progress.ts` `buildExistingObservationsSummary` already counts full lines — pools vs display already disagree |
| Status shows resolved threshold                                           | `src/commands/memory.ts` L158–161                                                                         | Shows raw estimate vs static config value                                                                                                                                     | Cosmetic; estimate-basis display is self-consistent per PR40 out-of-scope, but will disagree with footer %                                         |

### 2.3 Divergences that change the semantics (read these carefully)

1. **Chunk cap direction is inverted.** Upstream PR #34 keeps **oldest-first** so coverage advances incrementally and a backlog drains completely across runs. Our `capSourceEntriesToTokens` walks **newest-to-oldest** (`for (let i = entries.length - 1; i >= 0; i--)`): when capped, the **oldest** uncovered entries are dropped and `coversUpToId` jumps past them → that conversation is **permanently never observed** (silent memory loss), not merely delayed. The function also carries an unresolved comment block ("Remove the `kept.length > 0` guard? No — keep the guard…") indicating the design was never settled. Upstream's invariant — _"coverage advances only through ids the serializer actually returned"_ — is the correct one.
2. **Single oversized entry is sent whole.** Ours: "include it anyway to avoid data loss". Upstream's first attempt did exactly this and immediately hit the **1.7M-char tool result** that still blew the window; the merged fix is the marked head/tail excerpt with `truncatedSourceEntryIds` and a min-budget guard. Ours reproduces the fixed bug.
3. **Cap budget ≠ actual sent text.** Ours estimates chars of message content only (plus JSON for custom entries) — no `[Source entry id: …]` label overhead, no `branch_summary` rendering, no separator. Upstream budgets the actual rendered source-addressed text, so the cap is honest about what the API receives.
4. **Dropper has no upstream equivalent.** Upstream's dropper is pool-fullness based (internal accounting → estimate is correct per PR40 out-of-scope). Ours additionally uses `rawTokensSinceDropCoverage` in `dropperDue` and `runDropperStage` — a coverage-token counter upstream never had. PR40's anchor helpers only cover observations/reflections + compaction; the dropper counter has **no upstream anchor pattern to copy**, confirming our plan's note that the three coverage counters are not interchangeable.
5. **Cursors replace coverage markers.** Our `anyStageDue`/stage runners use `runtime.getCursor("observer"|"reflector"|"dropper")` when present, falling back to legacy coverage markers. Any anchor-based real-token delta must anchor at the **cursor's `entryId`**, not the `latestCoverageIndex` marker — and cursor positions are _not_ tied to a `coversUpToId` usage-bearing message, so the "last valid assistant usage at/before anchor" search needs the cursor index as the anchor boundary.
6. **Manual mode / pending.json has no usage anchors.** In `compaction: "manual"` the branch has no OM markers; observation/reflection batches live in per-session pending files, and `effectiveTokens` is adjusted from `pending.observation.coversUpToId`. Provider usage still exists on the branch (assistant messages are real), but the _baseline_ ("usage at coverage") has no ledger marker to attach to — pending coverage must be mapped onto the branch's usage-bearing messages, or the fallback path will be taken for every manual-mode window.
7. **Retry/fallback machinery interacts with failure handling.** Ours has `MAX_STAGE_ATTEMPTS = 10`, `recordRetryableError`, stage fallback models, and `observer.context_window_exceeded` upper-bound pre-checks (the "min of threshold vs effectiveCtx − reserve" logic). Upstream has none of this. PR #33's stream-error logging is the _complement_ to our retry loop — it makes the retried failure visible; a circuit-breaker idea from #32's comments would layer on top of `recordRetryableError`'s existing state.
8. **`effectiveContextWindow` override chain.** Ours resolves `OmModelConfig.contextWindow` (config) → `model.contextWindow` → `128000`. Upstream reads window from `ctx.model` / `getContextUsage()`. Any derived cap (PR #34) or ratio mode (commit 3677e591) must run through our resolution, and `getContextUsage().contextWindow` (provider-reported) should be preferred over static metadata when available.

### 2.4 Impact checklist — who sees each change

| Change                                                     | Blast radius                                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real-usage compaction counter                              | `compaction-trigger.ts` (3 call sites) — fire timing; our own archive evidence: 21 LATE compaction windows, churn 7.7×                                                                                                                               |
| Anchor-based coverage deltas                               | `consolidation.ts` `anyStageDue` + all three stage runners + `commands/memory.ts` progress display + manual-mode pending adjustments                                                                                                                 |
| `observationLineTokenCount`                                | `observer/agent.ts` (stored `tokenCount`), `dropper/agent.ts` (pool sums ×2), pool-fullness thresholds, `buildExistingObservationsSummary` consistency                                                                                               |
| Chunk cap semantics (oldest-first, honest budget, excerpt) | `serialize.ts` + `consolidation.ts` `runObserverStage` + tests                                                                                                                                                                                       |
| Stream error logging                                       | 3 agent drain loops; logging-only                                                                                                                                                                                                                    |
| Ratio mode                                                 | config, compaction-trigger, memory.ts status line                                                                                                                                                                                                    |
| Tests                                                      | `tests/session-ledger-progress.test.ts` (extend), `tests/consolidation-trigger.test.ts` (ours), `tests/compaction-trigger.test.ts` (ours), plus upstream's new `observer-chunk-cap` / `source-serialization-budget` / `stream-errors` suites adapted |

---

## 3. Decision points for the plan (open, no recommendation yet)

1. **Compaction basis**: tavasti-fork style _usage + trailing estimate since compaction_ (our work_docs calibration data is on this basis: "usage since marker") vs PR40 style _`getContextUsage().tokens` total real context_ (matches footer % but changes threshold semantics to total-context basis). They are different quantities; pick per the calibration evidence.
2. **Chunk cap direction**: adopt oldest-first (upstream invariant) — fixes silent data loss in our current newest-first cap?
3. **Cap source**: keep static 40K, or adopt derivation (`window × ratio`, fallback, min clamp)?
4. **Head/tail excerpt** for oversized single entries — adopt upstream's serializer-budget approach wholesale (it subsumes our `capSourceEntriesToTokens`)?
5. **Ratio mode**: in scope for this plan or separate?
6. **Stream error logging** (PR #33): cheap, matches our `recordRetryableError` machinery — include?
7. **Dropper counter**: no upstream anchor pattern exists; verify our `rawTokensSinceDropCoverage` stays estimate-based (self-consistent per PR40 out-of-scope) while pool sums move to line-based counting.
8. **Anchor mapping for cursors + pending/manual mode** (our unique features) — the real design work of porting PR40's `realTokensSinceAnchor`.

---

## 4. Deep reference — upstream artifacts, function by function

### 4.1 Issue #32 — the full failure anatomy

**Environment that produced it:** `pi-observational-memory@3.0.3`, `debugLog: true`, model `anthropic/claude-opus-5` (1M context) behind an Anthropic-compatible gateway. User config had `compactAfterTokens: 950000` (close to the 1M limit). The session grew a large uncovered span before the first observer run.

**Debug log cycle (repeating forever):**

```
12:24:44 observer.start  tokens=813066 entries=1250
12:24:48 observer.empty  coversUpToId=e38147ad     <- 3.4s later
12:24:54 observer.start  tokens=813532 entries=1254
12:24:58 observer.empty  coversUpToId=aa1a2929     <- 3.7s later
12:25:04 observer.start  tokens=813983 entries=1256
12:25:06 observer.empty  coversUpToId=50559ef9     <- 2.5s later
```

Across the whole log: **383× `observer.empty`, 0× `observer.records`, avg 3.0s per call** (min 0.6s, max 15.7s). Meanwhile other sessions on the same machine/config/model recorded observations fine — ruling out config or auth.

**Timing signature:** hitting the same gateway directly with an oversized prompt returns in ~4.7s with:

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "prompt is too long: 5198507 tokens > 1000000 maximum"
  }
}
```

~3s per observer "run" is a gateway rejection, not inference for an 800K-token prompt.

**Why the error is invisible:** `runObserver` drains the agent-loop stream and only checks whether any `record_observations` calls accumulated. When the LLM call errors, agent-core ends the stream with a `stopReason: "error"` assistant message, the loop exits normally, `accumulated.size === 0`, and the caller reports "observer returned no observations". The actual API error message never reaches the debug log — indistinguishable from "the model had nothing to say".

**Why it can't self-heal (the 4-step trap):**

1. `runObserverStage` builds the chunk from everything after `latestCoverageIndex(OM_OBSERVATIONS_RECORDED)` with no size cap.
2. The call fails → no marker appended → watermark stays put.
3. Next turn the chunk is strictly larger. Once it's over the context window, failure is guaranteed forever.
4. Compaction doesn't truncate this span — the ledger keeps the full branch, and the observer reads from the watermark, not from `firstKeptEntryId`.

**The two suggested fixes (author's own, both shipped):**

1. **Cap the observer chunk** — oldest-first entries up to a budget (author used 60K estimated tokens: "conservative enough that even a 4× undercount stays far below real windows"). Coverage advances incrementally until the backlog drains. Recovered the stuck session immediately: 1336-entry backlog drained in ~60K-token slices, `observer.records` on every run since. (→ PR #34)
2. **Log stream-level errors** — watch for assistant messages with `stopReason === "error"`/`"aborted"` while draining and emit an `observer.stream_error` debug event with the `errorMessage`. (→ PR #33)

**Commenter's hard rule (IgorGanapolsky):** treat API errors as terminal for that observer slice; **advance (or shrink) the watermark on failure — never only on success**; a cheap circuit breaker after N consecutive observer API failures in a session (record `last_error`, increment `fail_streak`, halt when `fail_streak >= threshold`; optionally advance the watermark by a fixed small step so the next attempt is smaller, not larger). None of this is implemented upstream or in ours — it remains a suggestion.

### 4.2 PR #33 — stream error logging (merged, logging-only)

**`src/agents/stream-errors.ts` (new, 22 lines):**

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

**Wiring** — three one-line changes in the agent drain loops (`for await (const _event of stream)` → `event`, plus `logAgentStreamError("observer"/"reflector"/"dropper", event)`):

- `src/agents/observer/agent.ts` (drain loop comment: "Drain events; the tool's execute already collects records.")
- `src/agents/reflector/agent.ts` ("Tool execution collects records.")
- `src/agents/dropper/agent.ts` ("Tool execution collects candidate ids.")

**With this in place, the #32 failure shows up in the debug log as:**

```
{"event":"observer.stream_error","data":{"stopReason":"error","errorMessage":"prompt is too long: 5198507 tokens > 1000000 maximum"}}
```

**Tests (`tests/stream-errors.test.ts`, 127 lines):** logs error/aborted message_end with the right stage prefix; ignores successful (`stopReason: "stop"`), non-assistant (user role), and non-message events (`turn_start`); end-to-end `runObserver` with a failing fake loop yields `observations === undefined` + one `observer.stream_error` event. Uses a `vi.hoisted` mock for `getAgentDir` and the real `withDebugLogContext`/`debugLogRelativePath`.

**Key semantic points:**

- Only `message_end` events carry the final message with `stopReason`/`errorMessage`.
- Non-assistant messages (user/toolResult) are ignored — their `message_end` shape differs anyway.
- Logging only when `debugLog` is enabled (via `debugLog`); **no behavior change otherwise** — an errored run still returns empty/undefined results, still does not advance coverage.
- It does NOT implement the #32 commenter's circuit breaker — just visibility.

### 4.3 PR #34 — observer chunk cap (merged)

**Config additions (`src/config.ts`):**

```ts
export const OBSERVER_CHUNK_FALLBACK_MAX_TOKENS = 60_000;
export const OBSERVER_CHUNK_MIN_TOKENS = 256;
export const OBSERVER_CHUNK_CONTEXT_RATIO = 0.2;

export function resolveObserverChunkMaxTokens(
  config: Config,
  contextWindow: number | undefined,
): number {
  if (config.observerChunkMaxTokens !== undefined && config.observerChunkMaxTokens > 0) {
    return Math.max(OBSERVER_CHUNK_MIN_TOKENS, config.observerChunkMaxTokens);
  }
  if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
    return Math.max(
      OBSERVER_CHUNK_MIN_TOKENS,
      Math.floor(contextWindow * OBSERVER_CHUNK_CONTEXT_RATIO),
    );
  }
  return OBSERVER_CHUNK_FALLBACK_MAX_TOKENS;
}
```

Precedence: **explicit config > derived (`floor(contextWindow × 0.2)`) > 60K fallback**, everything clamped to ≥ 256. Non-positive explicit values are ignored (fall through to derived/fallback), not clamped — only positive values get the min clamp. `contextWindow` must be a positive finite number.

**Why 0.2:** chunk sizes come from the ~4 chars/token estimator, which undercounts non-ASCII content by up to ~4× (the #32 session was CJK-heavy, "813K estimated" was >1M real), so worst case lands at ~80% of the window with room left for the system prompt, prior memory, and the response.

**Why 256 minimum:** enough for a complete source label, omission marker, and useful context; an extremely small user setting must not truncate the source label and falsely advance coverage.

**Serializer budget (`src/serialize.ts`):**

```ts
export type SourceAddressedSerialization = {
  text: string;
  sourceEntryIds: string[];
  estimatedTokens: number;
  truncatedSourceEntryIds: string[];
};

export type SourceAddressedSerializationOptions = {
  maxTokens?: number;
};

const SOURCE_OMISSION_MARKER =
  "\n\n[… middle omitted: source exceeds observer input budget; original source remains in the session ledger …]\n\n";
```

`serializeSourceAddressedBranchEntries(entries, { maxTokens })` semantics:

- Walks entries **oldest-first**; skips entries without ids or non-renderable; renders each via `serializeBranchEntries([entry])`; skips empty renders.
- Block = `[Source entry id: <id>]\n<rendered>`, joined by `\n\n`. Budget counts `estimateStringTokens(separator + block)` — **the actual text sent, including labels and separators**.
- If adding a block would exceed the budget and blocks already exist → **`break`** (later entries stay for the next run; coverage advances only through ids actually returned).
- If the _first_ (oldest) entry alone exceeds the budget → `truncateSourceBlockToTokenBudget(label, rendered, maxTokens)`:
  - If `label + SOURCE_OMISSION_MARKER` alone exceeds the budget → return `undefined` → **no chunk at all** (break with empty result, coverage does not advance — the label can never be truncated).
  - Else `maxChars = max(1, maxTokens × 4)`; retained = maxChars − fixed(label+marker) chars; `headChars = ceil(retained/2)`, `tailChars = retained − headChars`; output = `label + head + marker + tail`.
  - Pushes the excerpt, records the id in `sourceEntryIds` **and** `truncatedSourceEntryIds`, sets `estimatedTokens = estimateStringTokens(excerpt)`, breaks.
- Returns `{ text, sourceEntryIds, estimatedTokens: estimateStringTokens(text), truncatedSourceEntryIds }`.

**Consolidation-trigger changes (`src/hooks/consolidation-trigger.ts` `runObserverStage`):**

- Model resolution moved **before** chunk construction (the derived cap needs the resolved model's `contextWindow`); a resolution failure aborts before the "observer running" notification instead of after (reads better).
- Backlog = `sourceEntriesAfter(entries, lastCoverageIdx)`; `contextWindow = (resolved.model as { contextWindow?: number }).contextWindow`; `maxChunkTokens = resolveObserverChunkMaxTokens(config, contextWindow)`; chunk = serializer with `{ maxTokens: maxChunkTokens }`.
- `coversUpToId = sourceEntryIds.at(-1)` — **the last id the serializer actually returned**, not the backlog tail.
- `observer.chunk_capped` debug event when `sourceEntryIds.length < backlogEntries.length || truncatedSourceEntryIds.length > 0`:
  ```ts
  debugLog("observer.chunk_capped", {
    maxChunkTokens,
    backlogEntries,
    backlogTokens,
    chunkEntries,
    chunkTokens,
    truncatedSourceEntryIds,
  });
  ```
- Notification now reports chunk tokens, not backlog tokens: `observer running on ~<chunkTokens>-token chunk`.
- `observer.start` debug event gains `chunkTokens`.

**Test suite:**

- `tests/observer-chunk-cap.test.ts` — `resolveObserverChunkMaxTokens` precedence (explicit > derived > fallback), min clamp, non-positive ignored, invalid windows (undefined/0/−1/NaN → fallback).
- `tests/consolidation-trigger.test.ts` (added describe) — oversized backlog capped and drained incrementally across runs with coverage advancing each time (`allowedSourceEntryIds: ["raw-1"]` then `["raw-2"]`); single over-cap entry bounded with head/tail excerpt preserving provenance (`HEAD:`/`:TAIL`/marker present, `raw-next` absent, `coversUpToId: "raw-huge"`); derived cap from resolved model's `contextWindow` (1280 → 256); notification assertion loosened to `/^Observational memory: observer running on ~\d+-token chunk$/`.
- `tests/source-serialization-budget.test.ts` — all blocks kept when fitting; later entries kept for next run when budget full; **no source returned under unusably small budget** (label guard); head/tail excerpt for one huge tool result with `truncatedSourceEntryIds`; `renderRecallSourceEntry` still renders the original full entry.

**Comment trail (WSXYT) — the design evolution:**

1. First round: "the current cap handles a backlog made of many entries, but a single huge tool-result entry can still exceed the model window. The loop deliberately includes at least one entry even when it is over the cap… In my case it was a **1.7M-character tool result** and the API still returned `input exceeds the context window`. I don't want to hide that edge case; I'm testing a local fix that truncates only the observer's rendered copy while keeping the full source entry in the session ledger."
2. Second round (merged): "chunk budgeting now lives in the source-addressed serializer and measures the actual text sent to the observer, including source labels. Normal entries are kept whole. If the oldest entry alone is too large, the observer gets a clearly marked head/tail excerpt under the original source id; the raw session entry is unchanged, so `recall` still resolves the full source. **Coverage advances only through ids the serializer actually returned.** I also added a minimum useful budget and a guard so an extremely small user setting can never truncate the source label and falsely advance coverage. The new regression case is based on the real 1.7M-character tool result."

### 4.4 Commit `3677e591` — compaction ratio mode (merged)

**Config:**

```ts
export type CompactAfterTokensMode = "calibrated" | "ratio";
// Config: compactAfterTokensMode (default "calibrated"), compactAfterTokensRatio (default 0.68)

export function resolveCompactAfterTokens(
  config: Config,
  contextWindow: number | undefined,
): number {
  if (
    config.compactAfterTokensMode === "ratio" &&
    typeof contextWindow === "number" &&
    contextWindow > 0
  ) {
    return Math.max(1, Math.floor(contextWindow * config.compactAfterTokensRatio));
  }
  return config.compactAfterTokens;
}
```

- `COMPACT_AFTER_TOKENS_MODE_VALUES` const array; `isCompactAfterTokensMode` validator.
- `validRatioOrUndefined`: ratio must be a finite number strictly in `(0, 1)` — 0 would never trigger; ≥ 1 would compact at/after the full window with no room left for the response.
- `compactAfterTokens` is **always retained as the fallback**: calibrated mode uses it directly; ratio mode uses it whenever the window is undefined/0/negative.

**Rationale (from the commit message):** the calibrated default (81K) preempts a 1M window at ~8%, wasting most of it; but **context window ≠ attention** — some models advertise a large window but degrade at long range, so the ratio is user-tunable (e.g. 0.4 to compact earlier on degraded models, 0.7 on models that stay sharp).

**Status command:** `/om:status` "Next compaction" line shows `resolveCompactAfterTokens(runtime.config, ctx.model?.contextWindow)` — the **resolved** threshold, in both modes.

**Tests:** `tests/compaction-trigger.test.ts` (ratio mode describe: fires above scaled threshold, not below, falls back on undefined/0 window, same resolved threshold on deferred re-check), `tests/config.test.ts` (accepts valid mode/ratio; rejects invalid mode `"auto"`, ratio 0/1/1.5/−0.2/non-numeric → defaults; `resolveCompactAfterTokens` unit cases incl. `floor` to ≥ 1), `tests/status-command.test.ts` (shows `500,000` threshold in ratio mode with 1M window; falls back to `30` calibrated on undefined/0 window).

### 4.5 PR #40 — real provider-usage trigger thresholds (open)

**The problem statement (verbatim essence):** all trigger thresholds (compaction, observer, reflector, dropper pool) were measured against estimated token counts (`estimateStringTokens` = chars/4 approximations of source entries only), while the UI percentage and the plugin's own ratio threshold scale with the model's context window. Estimates systematically undercount real usage because they exclude the system prompt, tool schemas, thinking tokens, and provider-reported overhead. Measured divergence in real sessions: **19–46% undercount vs actual provider usage**. Concretely, with `compactAfterTokensRatio` at 0.35 on a 1M-window model, the footer can show 36% while the plugin's estimate sits at ~25–30% of the window — sessions visibly cross the configured threshold and auto-compaction never fires. Same drift class affects observer (fires at ~11–19K real tokens when configured for 10K) and reflector.

**`src/session-ledger/progress.ts` — new helpers (full):**

```ts
type UsageLike = {
  totalTokens?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export function contextTokensFromUsage(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as UsageLike;
  const total =
    typeof u.totalTokens === "number" && Number.isFinite(u.totalTokens) && u.totalTokens > 0
      ? u.totalTokens
      : undefined;
  if (total !== undefined) return total;
  const parts = [u.input, u.output, u.cacheRead, u.cacheWrite];
  if (parts.every((p) => typeof p === "number" && Number.isFinite(p))) {
    const sum = parts.reduce<number>((acc, p) => acc + (p ?? 0), 0);
    return sum > 0 ? sum : undefined;
  }
  return undefined;
}

function validAssistantContextTokens(entry: Entry): number | undefined {
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object")
    return undefined;
  const msg = entry.message as { role?: string; stopReason?: string; usage?: unknown };
  if (msg.role !== "assistant" || msg.stopReason === "aborted" || msg.stopReason === "error")
    return undefined;
  return contextTokensFromUsage(msg.usage);
}
```

- `realContextTokensAfterCompaction(entries, compactionIdx)` — walks **forward** from `compactionIdx + 1`, returns the first valid assistant context tokens. **Pi's docs state the last assistant usage before/at a compaction reflects the PRE-compaction context size; the usage carried on the compaction entry itself is the summary-generation call's usage (pre-compaction scale, a different LLM call), so it is deliberately NOT used as a baseline.**
- `realContextTokensAtCoverage(entries, coverageIdx)` — walks **backward** from `coverageIdx` (inclusive), returns the last valid assistant usage at/before the anchor. Undefined when no valid usage exists (error/abort storm) — callers must fall back rather than measure from zero (which would read the full context as growth and re-fire every turn).
- `realTokensSinceAnchor(entries, customType, currentContextTokens)`:
  ```ts
  const coverageIdx = customType ? latestCoverageIndex(entries, customType) : -1;
  const compactionIdx = findLastCompactionIndex(entries);
  if (compactionIdx > coverageIdx) {
    const baseline = realContextTokensAfterCompaction(entries, compactionIdx);
    if (baseline === undefined) return undefined;
    const delta = currentContextTokens - baseline;
    return delta >= 0 ? delta : undefined;
  }
  if (coverageIdx >= 0) {
    const baseline = realContextTokensAtCoverage(entries, coverageIdx);
    if (baseline === undefined) return undefined;
    const delta = currentContextTokens - baseline;
    return delta >= 0 ? delta : undefined;
  }
  return Math.max(0, currentContextTokens);
  ```
  - **Anchor precedence: most recent of (compaction, coverage).** After a compaction, coverage anchors are gone (or pre-compaction), so the delta is measured from the compaction's own post-usage baseline — i.e. real growth since the compaction.
  - **Negative delta** (mid-session model/provider switch to a different usage basis) → `undefined` → callers fall back to the raw estimate. Never clamp to 0 (would starve the stage forever), never measure from zero (would over-fire every turn).
  - **No anchor at all** (fresh session, no compaction, no coverage) → `max(0, currentContextTokens)`.

**`src/hooks/compaction-trigger.ts`:**

```ts
const contextUsage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
let tokens = contextUsage?.tokens;
if (typeof tokens !== "number" || !Number.isFinite(tokens)) {
  // getContextUsage unavailable on older pi hosts, or context unknown until the next valid assistant response.
  const entries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
  if (!entries) return;
  tokens = rawTokensSinceLastCompaction(entries);
  if (typeof tokens !== "number") return;
}
// Prefer the window reported by getContextUsage(); fall back to ctx.model.
const contextWindow =
  contextUsage?.contextWindow ??
  (typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined);
const threshold = resolveCompactAfterTokens(runtime.config, contextWindow);
if (tokens < threshold) return;
```

The deferred re-check (setTimeout path) does the same: `currentUsage = getContextUsage()`; `currentTokens = currentUsage?.tokens`; fallback to `rawTokensSinceLastCompaction(currentEntries)` (and early-return resetting `compactInFlight = false` when `!currentEntries`); skip when `currentTokens < threshold`.

**`src/hooks/consolidation-trigger.ts`:**

```ts
function realContextTokens(ctx: ConsolidationCtx): number | undefined {
  const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
  const tokens = usage?.tokens;
  return typeof tokens === "number" && Number.isFinite(tokens) ? tokens : undefined;
}

function stageDue(entries, runtime, currentTokens, customType, rawEstimateFn, threshold): boolean {
  if (currentTokens !== undefined) {
    const real = realTokensSinceAnchor(entries, customType, currentTokens);
    if (real !== undefined) return real >= threshold;
  }
  // Real delta unmeasurable (no usage baseline, or accounting basis changed) or
  // old pi host without getContextUsage — fall back to the raw estimate, which
  // self-limits after coverage and cannot over-fire or starve.
  return rawEstimateFn(entries) >= threshold;
}

function anyStageDue(entries, runtime, currentTokens): boolean {
  return (
    stageDue(
      entries,
      runtime,
      currentTokens,
      OM_OBSERVATIONS_RECORDED,
      rawTokensSinceObservationCoverage,
      runtime.config.observeAfterTokens,
    ) ||
    stageDue(
      entries,
      runtime,
      currentTokens,
      OM_REFLECTIONS_RECORDED,
      rawTokensSinceReflectionCoverage,
      runtime.config.reflectAfterTokens,
    )
  );
}
```

- `ConsolidationCtx` gains `getContextUsage?: () => { tokens?: number | null; contextWindow?: number } | undefined`, threaded through `maybeLaunchConsolidation`.
- `runObserverStage`/`runReflectorStage` compute `real = realTokensSinceAnchor(...)` and use it when defined, else the raw estimate — with the comment: "fallback: no usage baseline / basis change".

**`src/tokens.ts` + `src/agents/observer/agent.ts` + `src/agents/dropper/pool.ts` — line-based counting:**

```ts
export function observationLineTokenCount(observation: {
  id: string;
  timestamp: string;
  relevance: string;
  content: string;
}): number {
  return estimateStringTokens(
    `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`,
  );
}
```

- `observationTokenSum(observations: readonly Observation[])` now sums `observationLineTokenCount(observation)` instead of bare `observation.tokenCount` — "the pool budget caps how much observation text is re-rendered into future contexts, and every line carries metadata overhead".
- `runObserver` stores `tokenCount: observationLineTokenCount({ id, timestamp, relevance, content })` instead of `estimateStringTokens(content)`.

**Out of scope (deliberate, verbatim reasoning):**

- **Outbound budgets** — `serialize.ts` (observer chunk cap) and `model-budget.ts` (agent loop `maxTokens`) bound how much _we_ send to the model. The text is raw source content that has never been through the LLM, so no provider-reported usage exists yet; a chars/4 estimate is the only available and the correct tool here.
- **Internal accounting** — the full-fold pressure check (`projection.ts`), dropper coverage/stats (`coverage.ts`, `dropper/agent.ts`), and `/om:status` display sums (`status.ts`) compare against **other internal config values on the same estimate basis** (e.g. folded pool vs `observationsPoolMaxTokens`), not against a context-window-derived threshold or the UI percentage. Self-consistent comparisons don't drift the way estimate-vs-window comparisons do.
- **Known cosmetic drift** — newly recorded observations store a line-based `tokenCount` while observations recorded before this change and all reflections store content-only counts. These only affect internal display/accounting numbers, self-heal as old observations are replaced, and reflections are not subject to any pool budget.

**Verification claims:** typecheck clean; live-tested across several days — auto-compaction now fires at the configured ratio against real context usage matching the footer percentage; observer/reflector fire at configured real-token thresholds; code reviewed by two independent reviewers. `getContextUsage` added in pi 0.49.0 (2026-01-17) — both new paths detect absence and fall back, so hosts without it keep working.

---

## 5. Our side — inventory of the code the plan touches

### 5.1 `src/om/ledger/progress.ts` — counter layer (MOVED from upstream `src/session-ledger/progress.ts`)

Exported functions with line numbers (as of this session):

| Line | Function                                                    | Semantics                                                                                                                                                                                 |
| ---- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 20   | `isSourceEntry(entry)`                                      | `message` \| `custom_message` \| `branch_summary` (const `SOURCE_ENTRY_TYPES` set)                                                                                                        |
| 24   | `entryIndexById(entries)`                                   | id → index map                                                                                                                                                                            |
| 30   | `entryIndexForId(entries, id)`                              | index or −1                                                                                                                                                                               |
| 62   | `latestCoverageIndex(entries, customType)`                  | highest index of the `coversUpToId` target among valid coverage markers of that type; −1 if none. Validity requires non-empty `observations`/`reflections`/`observationIds` on the marker |
| 79   | `latestCoverageMarkerId(entries, customType)`               | the `coversUpToId` of the latest valid marker                                                                                                                                             |
| 100  | `earlierCoverageMarkerId(firstId, secondId)`                | earlier of two marker ids by index                                                                                                                                                        |
| 117  | `rawTokensAfterIndex(entries, index)`                       | sum of `estimateEntryTokens` over source entries after `index`                                                                                                                            |
| 125  | `rawTokensSinceCoverage(entries, customType)`               | `rawTokensAfterIndex(entries, latestCoverageIndex(...))`                                                                                                                                  |
| 132  | `rawTokensSinceObservationCoverage`                         | wrapper for `OM_OBSERVATIONS_RECORDED`                                                                                                                                                    |
| 136  | `rawTokensSinceReflectionCoverage`                          | wrapper for `OM_REFLECTIONS_RECORDED`                                                                                                                                                     |
| 140  | `rawTokensSinceDropCoverage`                                | wrapper for `OM_OBSERVATIONS_DROPPED`                                                                                                                                                     |
| 144  | `findLastCompactionIndex(entries)`                          | last `type === "compaction"` entry, backward scan                                                                                                                                         |
| 151  | `rawTokensSinceLastCompaction(entries)`                     | see below                                                                                                                                                                                 |
| 168  | `observationsCreatedAfterIndex(entries, sinceIndex)`        | deduped observations from `OM_OBSERVATIONS_RECORDED` markers after index                                                                                                                  |
| 193  | `reflectionsCreatedAfterIndex(entries, sinceIndex)`         | same for reflections                                                                                                                                                                      |
| 219  | `buildExistingObservationsSummary(observations, maxTokens)` | one-line `[id] ts [rel] content` summaries, token-capped (line-based counting already!)                                                                                                   |
| 239  | `buildExistingReflectionsSummary(reflections, maxTokens)`   | one-line `[id] content`, token-capped                                                                                                                                                     |

`rawTokensSinceLastCompaction` (L151) detail — this is the counter with the **compaction-point** semantics, NOT coverage semantics:

```ts
export function rawTokensSinceLastCompaction(entries: Entry[]): number {
  const compactionIndex = findLastCompactionIndex(entries);
  if (compactionIndex === -1) return rawTokensAfterIndex(entries, -1);
  const firstKeptEntryId = entries[compactionIndex].firstKeptEntryId;
  const firstKeptIndex = entryIndexForId(entries, firstKeptEntryId);
  if (firstKeptIndex === -1) return rawTokensAfterIndex(entries, compactionIndex);
  return rawTokensAfterIndex(entries, firstKeptIndex - 1);
}
```

Note it anchors at **`firstKeptEntryId − 1`** (the pre-compaction retained boundary), not at the compaction entry itself — and the fallback path (`firstKeptIndex === -1`) measures from the compaction entry index. This is the counter the tavasti fork changes to usage + trailing, and it's the one whose baseline rules PR #40 derives (`realContextTokensAfterCompaction`).

Also note: `buildExistingObservationsSummary` already counts **full rendered lines** (`[id] ts [rel] content`) while pool sums (`dropper/agent.ts`) and stored `tokenCount` count **bare content** — an existing internal inconsistency that `observationLineTokenCount` (PR #40) would unify.

### 5.2 `src/om/serialize.ts` — serializer (MOVED from upstream `src/serialize.ts`, still identical shape: **no budget options**)

- `serializeBranchEntries(entries)` — message → `serializeConversation` (pi's); `custom_message` → `renderCustomMessage(entry, { recallFormat: false })`; `branch_summary` → `[Branch summary @ <ts>]: <summary>`. Joined `\n\n`.
- `SourceAddressedSerialization = { text, sourceEntryIds }` (upstream now also has `estimatedTokens`, `truncatedSourceEntryIds`).
- `serializeSourceAddressedBranchEntries(entries)` — **no options param**; builds `[Source entry id: <id>]\n<rendered>` blocks, unbounded, oldest-first in input order. **This is the function PR #34 extends with `{ maxTokens }` + excerpt.**
- `renderRecallMessage(entry)` — user / assistant (with thinking included, redacted omitted) / tool result (`[Tool result: <toolName> @ <ts>]`). `renderRecallSourceEntry(s)` — recall-format rendering; used by the excerpt test to prove the raw entry survives intact.

### 5.3 `src/om/tokens.ts` — estimation (UNCHANGED upstream copy)

- `estimateStringTokens(text) = Math.ceil(text.length / 4)` — chars/4.
- `estimateEntryTokens(entry)` — `message` → pi's `estimateTokens(message)` (imported as `estimateMessageTokens`); `custom_message.content` string → chars/4, array → sum of text blocks; `branch_summary.summary` string → chars/4; else 0.
- **Header comment: "Upstream: https://github.com/elpapi42/pi-observational-memory (src/tokens.ts) Unmodified."** — the tavasti fork adds `hasUsageData`/`getUsageTokens` here.
- Note the mixed basis: pi's `estimateTokens` doc says it "overestimates tokens" (conservative), chars/4 for strings undercounts — our aggregate archive evidence still shows net underreporting (medians 0.61–0.83 est/usage).

### 5.4 `src/om/consolidation.ts` — stage orchestrator (REWRITTEN vs upstream `src/hooks/consolidation-trigger.ts`)

Key constants/helpers:

- `MAX_STAGE_ATTEMPTS = 10` (L91) — per-stage retry budget with fallback models.
- `sourceEntriesAfter(entries, index)` (L93).
- `capSourceEntriesToTokens(entries, maxTokens)` (L102) — **our existing cap; newest-first; whole oversized entry; per-entry char estimate of message content / JSON of custom entries / summary chars; no labels, no separators.** Full code with its internal debate comments:
  ```ts
  function capSourceEntriesToTokens(entries: Entry[], maxTokens: number): Entry[] {
    let totalTokens = 0;
    const kept: Entry[] = [];
    for (let i = entries.length - 1; i >= 0; i--) {
      // ← newest-first
      const entry = entries[i];
      let chars = 0;
      // Tokenize all entry types, not just "message": custom_message and
      // branch_summary entries also consume observer context window.
      if (entry.type === "message" && entry.message) {
        const msg = entry.message as any;
        if (typeof msg.content === "string") chars = msg.content.length;
        else if (Array.isArray(msg.content)) {
          for (const block of msg.content) if (block.text) chars += block.text.length;
        }
      } else if (
        entry.type === "custom" &&
        (entry.customType === OM_OBSERVATIONS_RECORDED ||
          entry.customType === OM_REFLECTIONS_RECORDED ||
          entry.customType === OM_OBSERVATIONS_DROPPED)
      ) {
        chars = String(JSON.stringify(entry.data ?? {})).length;
      } else if (entry.summary) {
        chars = String(entry.summary).length;
      }
      const estTokens = Math.ceil(chars / 4);
      if (totalTokens + estTokens > maxTokens && kept.length > 0) break;
      // Remove the `kept.length > 0` guard? No — keep the guard but allow
      // the first entry to be dropped only if it exceeds maxTokens alone.
      // (The guard against empty kept list prevents dropping the first entry
      // when later entries are small; but a single oversized entry should
      // still be included to avoid losing the newest data entirely.)
      if (totalTokens + estTokens > maxTokens && kept.length === 0) {
        // First (newest) entry exceeds maxTokens alone — include it anyway
        // to avoid data loss, but don't add more.
        kept.unshift(entry);
        break;
      }
      kept.unshift(entry);
      totalTokens += estTokens;
    }
    return kept;
  }
  ```
  The comment block is a live artifact of an unsettled design decision. The "include it anyway" behavior is upstream PR #34 v1's exact behavior that was later replaced by the excerpt.

**`anyStageDue(entries, runtime, pending?)` (L199–~380)** — the stage gating with our unique features:

- **Observer**: cursor-based when `cursors.observer` exists (`rawTokensAfterIndex(entries, cursorIdx)`); else coverage-marker-based (`rawTokensSinceObservationCoverage >= observeAfterTokens`).
- **Reflector**: cursor-based; requires accumulated tokens ≥ `reflectAfterTokens` AND new observation batches after the cursor (marker `coversUpToId` at/before cursor is skipped; pending batches in manual mode also checked).
- **Dropper** (short-circuit: only computed when observer and reflector are both not due): active pool tokens = folded `activeObservations` `tokenCount` sum (+ pending batches in manual mode); `fullnessVsPool = poolTokens / observationsPoolMaxTokens`; must pass `dropperPoolFullnessThreshold` (default 0.1); pressure check `poolTokens >= dropperPressureThreshold * reflectorInputMaxTokens`; new-data check via dropper cursor (or pending batches in manual mode); **plus** a `rawTokensSinceDropCoverage >= reflectAfterTokens` leg.

**`runObserverStage` full flow (L~660–975):**

1. `entries = ctx.sessionManager.getBranch()`; `observerCursor = runtime.getCursor("observer")`; `effectiveStart` = cursor index if cursor exists → else `latestCoverageIndex(OM_OBSERVATIONS_RECORDED)` → else `findLastCompactionIndex(entries)` (cold start).
2. `tokens = rawTokensAfterIndex(entries, effectiveStart)`; if `< observeAfterTokens` → advance cursor to last source entry with reason `"not_due"` and return `"continue"`.
3. `chunkEntries = sourceEntriesAfter(entries, effectiveStart)`; if `tokens > observerChunkMaxTokens` → `capSourceEntriesToTokens(chunkEntries, maxChunkTokens)`. (Cap only engages when the _estimate_ exceeds the cap — the cap itself is on the same estimate basis.)
4. `coversUpToId = chunkEntries.at(-1)?.id` — **last entry after capping** (comment: "must point to the LAST entry AFTER capping, not before").
5. `serializeSourceAddressedBranchEntries(chunkEntries)` → `chunk`, `sourceEntryIds`; `chunkTokens = Math.ceil(chunk.length / 4)`; empty → `"continue"`.
6. `fullProjection(entries)` memory; prior observations/reflections summary lines; **manual mode**: merge pending batches, preamble capped via `observerPreambleMaxTokens` (0 → auto 30% of `observerChunkMaxTokens`) with `selectPriorObservations` relevance/recency scoring.
7. Manual-mode `isObservationChunkPending(sessionId, coversUpToId)` → skip (`observer.pending_skip`).
8. `MAX_STAGE_ATTEMPTS` loop: `resolveModel("observer")`; manual-mode `effectiveTokens` adjusted from `pending.observation.coversUpToId`; notification `observer running on ~<chunkTokens>-token chunk (of <effectiveTokens> accumulated)`; `observer.start` debug; `stageModelForThinking = runtime.findCandidateConfig(...)`; `effectiveObsCtx = effectiveContextWindow(resolved.model, stageModelConfig(runtime, "observer"))`; `observerEstimatedInput = chunkTokens + AGENT_LOOP_RESERVE`; **if `observerEstimatedInput > effectiveObsCtx` → `observer.context_window_exceeded` debug + `recordRetryableError` + info notify + `continue`** (this is our unique upper-bound pre-check — the "min of threshold vs effectiveCtx − reserve" logic from the plan).
9. `runObserver({ model, apiKey, headers, priorReflections, priorObservations, chunk, allowedSourceEntryIds: sourceEntryIds, maxTurns: agentMaxTurns, thinkingLevel })`.
10. Non-empty → `buildObservationsRecordedData` → `observer.records` debug; manual mode → `savePendingObservation` + `observer.pending`; auto → `pi.appendEntry(OM_OBSERVATIONS_RECORDED, ...)` + `observer.appended`; empty → `observer.empty` with reason + cursor advance `"empty"`; errors → `observer.error` / `observer.stale_ctx`.

**`runReflectorStage` / `runDropperStage`** mirror this: `reflector.start` L1122, `reflector.context_window_exceeded` L1152, `dropper.context_window_exceeded` L1480, `recordRetryableError` per stage.

### 5.5 `src/om/agents/*` — the three agent loops

- `observer/agent.ts`: `record_observations` tool schema (fields incl. `sourceEntryIds: Type.Array(Type.String({ minLength: 1 }))` — "Exact source entry ids from the chunk that directly support this observation"); `normalizeSourceEntryIds` (only ids present in the chunk, deduped; invalid → rejected with count); stores `tokenCount: estimateStringTokens(content)` (L185); drain loop at **L273**: `for await (const event of stream) { /* Drain events; the tool's execute already collects records. */ }` then `await stream.result()`. Uses `nowTimestamp`, `truncateRecordContent` from serialize.
- `reflector/agent.ts`: drain loop at **L204** ("Tool execution collects records.").
- `dropper/agent.ts`: drain loop at **L393** ("Tool execution collects candidate ids."); `observationTokens = observations.reduce((sum, o) => sum + o.tokenCount, 0)` (L224); prompt includes "Observation pool pressure: ~X tokens; target budget: ~Y tokens; fullness: ~Z%."; `maxDropCountForPool`; final allowed-id token sum (L424).

All three use `streamSimple` from `@earendil-works/pi-ai/compat` and `AGENT_LOOP_MAX_TOKENS`/`boundedMaxTokens` from `model-budget.js`. None logs stream errors — PR #33's wiring applies 1:1 here.

### 5.6 `src/om/model-budget.ts` — our unique budget layer

```ts
export const AGENT_LOOP_MAX_TOKENS = 32_000;
export function boundedMaxTokens(model, requested = AGENT_LOOP_MAX_TOKENS) {
  return typeof model.maxTokens === "number" && model.maxTokens > 0
    ? Math.min(model.maxTokens, requested)
    : requested;
}
export function effectiveContextWindow(resolvedModel, modelConfig?) {
  // 1. OmModelConfig.contextWindow override (>0) → 2. model.contextWindow (>0) → 3. 128_000 fallback
}
```

This is the **config-override-aware window resolution upstream lacks**. Any derived chunk cap (PR #34) or ratio mode (commit 3677e591) must run through this chain — and `getContextUsage().contextWindow` (provider-reported, PR #40) should be preferred over static metadata when available.

### 5.7 `src/om/config.ts` + `src/core/unified-config.ts` — unified config (REWRITTEN vs upstream `src/config.ts`)

- `src/om/config.ts` just re-exports `DEFAULTS` from `UNIFIED_DEFAULTS` (plus `loadConfig`/`readEnvConfig` normalization).
- `unified-config.ts` L195: `observerChunkMaxTokens: 40_000` **static default** (no window derivation, no min clamp). L196: `observerPreambleMaxTokens: 0` (0 → auto 30% of chunk cap in manual mode).
- `OmModelConfig` supports a `contextWindow` override (normalized via `positiveInt`), consumed by `effectiveContextWindow`.
- No `compactAfterTokensMode`/`compactAfterTokensRatio` — ratio mode is entirely absent.

### 5.8 `src/om/compaction-trigger.ts` — our compaction hook (REWRITTEN vs upstream)

- `autoCompactionSkipReason(runtime)` gating: `compaction: "off"` → skip; `compaction: "manual"` → skip; `compactionEngine: "pi-default"` → skip; legacy keys (`passive`, `noAutoCompact`, `overrideDefaultCompaction`) only when new keys are absent. **Memory does not gate compaction** (memory:false + compaction:auto = compact without OM).
- **Mid-run resume**: `MID_RUN_RESUME_CUSTOM_TYPE = "blackhole-resume"`, `MID_RUN_RESUME_MESSAGE` injected after a mid-run compaction so the agent resumes instead of stopping (ctx.compact() aborts the in-flight run and pi does not auto-continue). **Upstream has no equivalent.**
- `notifySafely` + `isStaleExtensionContextError` — **the deferred microtask (setTimeout) and async work may outlive the extension ctx (stale after session replacement/reload)**; calls into ctx can throw "extension ctx is stale". **This is why lazy `ctx.getContextUsage()` inside deferred work needs try/catch or synchronous capture — a real design constraint PR #40 doesn't have (their ctx lives long enough).**
- `RETRYABLE_ERROR_RE` imported from `./retryable-error.js`.
- Three `rawTokensSinceLastCompaction` call sites: L135 (turn_end path), L289 (agent_end path), L411 (deferred re-check).

### 5.9 `src/commands/memory.ts` — status display (upstream `src/commands/status.ts` was ELIMINATED/replaced)

- L158–161: `obsProgress = rawTokensSinceObservationCoverage(entries)`, `reflectionProgress = rawTokensSinceReflectionCoverage`, `dropProgress = rawTokensSinceDropCoverage`, `compactionProgress = rawTokensSinceLastCompaction` — all raw estimates.
- Manual mode adjusts obs/reflection progress from `pending.observation.coversUpToId` / `pending.reflection.coversUpToId`.
- Display lines: `Next observation: ~X / <threshold> tokens (P%)`, `Next reflection: ...`, `Next compaction: ...`, pool lines. Upstream commit 3677e591 changed the compaction line to show the **resolved** threshold; ours shows the static config value.

### 5.10 `src/om/status-overlay.ts` — config/status overlay (our own component, no upstream equivalent)

`StatusInfo` shape: `{ compaction, compactionEngine, tailBehavior, memory, compactAfterTokens, consolidationInFlight, compactInFlight, lastObserverError?, lastReflectorError?, lastDropperError? }`. Shows config status and pipeline state; the `last*Error` fields pair naturally with stream-error logging (PR #33) — a swallowed error currently never populates them.

### 5.11 `src/om/agents/dropper/pool.ts`-equivalent — pool math lives inside `dropper/agent.ts`

`observationPoolFullness(observationTokens, targetTokens)`, `dropUrgencyForFullness`, `maxDropCountForPool` — all keyed on `observationTokens` summed from `tokenCount` (bare content). Upstream extracted `pool.ts` and switched sums to `observationLineTokenCount`.

---

## 6. Host capability reference — pi 0.83.0 (verified from installed `dist/*.d.ts`)

### 6.1 Extension context

```ts
interface ContextUsage {
    /** Estimated context tokens, or null if unknown (e.g. right after compaction, before next LLM response). */
    tokens: number | null;
    contextWindow: number;
    /** Context usage as percentage of context window, or null if tokens is unknown. */
    percent: number | null;
}
// on ExtensionContext:
getContextUsage(): ContextUsage | undefined;
```

`tokens: number | null` — **null right after a compaction and before the next valid LLM response** — this is exactly PR #40's "unmeasurable → fall back to raw estimate" case, and it confirms that a fresh `getContextUsage()` read is not always available.

### 6.2 Compaction module exports (all public from `@earendil-works/pi-coding-agent`)

```ts
/** Calculate total context tokens from usage. Uses the native totalTokens field when available, falls back to computing from components. */
export declare function calculateContextTokens(usage: Usage): number;

/** Find the last valid assistant message usage from session entries. */
export declare function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined;

export interface ContextUsageEstimate {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
  lastUsageIndex: number | null;
}
/** Estimate context tokens from messages, using the last assistant usage when available. If there are messages after the last usage, estimate their tokens with estimateTokens. */
export declare function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate;

/** Check if compaction should trigger based on context usage. */
export declare function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean;
// CompactionSettings = { enabled: boolean; reserveTokens: number; keepRecentTokens: number }

export interface CompactionResult<T = unknown> {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter?: number;
  /** Usage from the LLM call(s) that generated this summary, if available */
  usage?: Usage; // ← the compaction entry's own usage — PR #40 says: do NOT use as a baseline
  details?: T;
}
```

- `calculateContextTokens(usage)` — the exact helper the tavasti fork imports; **the same `totalTokens`-first / components-fallback logic PR #40 reimplements as `contextTokensFromUsage`.**
- `estimateContextTokens` — pi's own usage + trailing-estimate implementation, the model our plan's compaction counter follows.
- `getLastAssistantUsage(entries)` — scans session entries for the last valid assistant usage; a candidate baseline finder for coverage/cursor anchors (though it has no "at/before index" bound — we'd need our own bounded scan).

### 6.3 `Usage` shape (from `@earendil-works/pi-ai`)

```ts
interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number; // subset of cacheWrite with 1h retention (Anthropic)
  reasoning?: number; // subset of output; providers that expose a breakdown
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
```

- Real session example (from work_docs): `input 4507 + cacheRead 6016 + output 174 = totalTokens 10697`.
- `AssistantMessage.usage: Usage` — always present on assistant messages.
- `ToolResultMessage.usage?: Usage` — "Usage from the tool execution itself, if available. **Not part of main LLM context accounting.**" — tool-result usage must never be used as a baseline.
- `StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted"` — PR #33 filters `error`/`aborted`; PR #40's `validAssistantContextTokens` also excludes them from baselines.
- `AssistantMessageEvent` stream protocol: terminates with `done` (reason stop/length/toolUse) or `error` (reason aborted/error carrying the final `AssistantMessage`) — confirms agent-core encodes failures in the stream, not as thrown exceptions (the #32 root cause).

---

## 7. Taxonomies — the mental models the plan needs

### 7.1 The three counting bases

| Basis                                                                      | How                                                                                | Correct for                                                                                                                                                                              | Wrong for                                                                                                                                                   |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **chars/4 estimate** (`estimateStringTokens`, pi `estimateTokens`)         | `ceil(chars/4)` or pi's per-message heuristic                                      | Outbound budgets (text never seen by the LLM: observer chunk serializer, agent-loop `maxTokens`); self-consistent internal accounting (pool vs pool config, coverage stats, status sums) | Comparing against a context-window-derived threshold or the UI percentage — drifts 19–46% (upstream) / median 0.61–0.83 (our archive)                       |
| **usage + trailing estimate** (tavasti fork, pi's `estimateContextTokens`) | last assistant `usage.totalTokens` after an anchor + chars/4 for trailing messages | "Real new content since anchor X" — preserves threshold semantics (81K = 81K of new content since last compaction)                                                                       | Nothing obvious; needs a valid usage anchor                                                                                                                 |
| **provider-reported total** (`getContextUsage().tokens`, PR #40)           | the live context size pi itself displays in the footer                             | Matching the UI/footer basis; ratio-mode thresholds                                                                                                                                      | Threshold semantics change to "total context" basis (not "since compaction") — must recalibrate `compactAfterTokens`/coverage thresholds against this basis |

**Which counter takes which basis (draft, for the plan):**

- Compaction trigger: either usage+trailing (tavasti/our plan — our calibration data is on this basis) or `getContextUsage().tokens` (PR #40 — matches UI). **Different quantities; the decision changes what `compactAfterTokens` means.**
- Coverage counters (observer/reflector): **must be delta-based** — real context now minus real context at the anchor (PR #40's `realTokensSinceAnchor`), or usage+trailing since the anchor. Anchor = most recent of (compaction, coverage, cursor, pending).
- Dropper token counter (`rawTokensSinceDropCoverage`, ours only): no upstream pattern; estimate-based is self-consistent, delta-based possible if we want real tokens.
- Pool budget sums: internal accounting → estimate-based is fine, **but must count full rendered lines** (`observationLineTokenCount`), since that's what actually gets re-rendered.

### 7.2 The anchor taxonomy

| Anchor                      | Where                                                                  | Baseline (real usage)                                                  | Notes                                                                                                                                              |
| --------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compaction                  | `findLastCompactionIndex`                                              | first valid assistant usage **after** the compaction entry             | The compaction entry's own `usage` is the summary call — pre-compaction scale, different LLM call. **Never a baseline.**                           |
| Coverage marker             | `latestCoverageIndex(entries, customType)` → `coversUpToId` index      | last valid assistant usage **at or before** that index (walk backward) | Error/abort assistant messages excluded                                                                                                            |
| Cursor (ours)               | `runtime.getCursor(stage).entryId` → index                             | last valid assistant usage at/before cursor index                      | Cursor positions are not tied to usage-bearing messages; they're moved on `"not_due"`, `"empty"`, success — semantics differ from coverage markers |
| Pending (ours, manual mode) | `pending.observation.coversUpToId` / `pending.reflection.coversUpToId` | map onto the branch's usage-bearing messages                           | No ledger marker exists; baseline lookup must resolve the pending coversUpToId to a branch index first                                             |
| No anchor                   | fresh session, no compaction, no coverage                              | —                                                                      | PR #40: `max(0, currentContextTokens)`; fall back to raw estimate when baseline undefined                                                          |

### 7.3 The failure-handling taxonomy

| Layer                   | Who                                                                                                              | What happens                                                                                                        | Status                                                                                                                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Thrown exceptions       | our `runObserverStage`/`runReflectorStage`/`runDropperStage` catch blocks                                        | `observer.error` / `reflector.error` / `dropper.error` debug events                                                 | Exists                                                                                                                                                                                                             |
| Swallowed stream errors | agent drain loops                                                                                                | `stopReason: "error"/"aborted"` message_end ignored → looks like "no observations"                                  | **Missing (PR #33)** — the #32 failure mode                                                                                                                                                                        |
| Upper-bound pre-check   | our `observer.context_window_exceeded` / `reflector.context_window_exceeded` / `dropper.context_window_exceeded` | estimated input + `AGENT_LOOP_RESERVE` vs `effectiveContextWindow` → skip + `recordRetryableError` + fallback model | Exists (unique to us) — but uses **static model metadata**; if the provider/gateway window differs (the #32 case: 1M model behind a gateway), the pre-check uses the wrong window and oversized prompts still ship |
| Retry loop              | `MAX_STAGE_ATTEMPTS = 10` + `recordRetryableError` + stage fallback models                                       | retries across fallback chain                                                                                       | Exists (unique to us)                                                                                                                                                                                              |
| Circuit breaker         | suggested in #32 comments only                                                                                   | fail_streak ≥ threshold → halt observer path; optionally shrink/advance watermark on failure                        | Not implemented upstream or in ours                                                                                                                                                                                |

**Observation:** our stage runners already have the pre-check + retry, so the _#32 livelock cannot reproduce identically_ (we skip rather than send oversized). But: (a) the pre-check uses static window metadata (`effectiveContextWindow` ← `OmModelConfig` → `model.contextWindow` → 128K), not the provider-reported window — PR #40's `getContextUsage().contextWindow` closes that gap; (b) our newest-first cap still **permanently skips the oldest data** when capped; (c) a single oversized entry is sent whole. The remaining failure surface is precisely what upstream PR #34 (excerpt) + PR #33 (visibility) + PR #40 (real window) address.

### 7.4 Threading `getContextUsage` through async/deferred work (our unique constraint)

Upstream reads `ctx.getContextUsage()` lazily inside handlers whose ctx outlives the work. Our `compaction-trigger.ts` **captures ctx synchronously before setTimeout** and guards calls with `isStaleExtensionContextError` — because "the setTimeout + async work below may outlive the extension ctx (stale after session replacement/reload)". Our consolidation stages are launched async too (`maybeLaunchConsolidation` → `runLaunchedWork`), and `runObserverStage` reads `entries` from `ctx.sessionManager.getBranch()` late. Any usage read inside a stage needs either: synchronous capture at trigger time, or a `try/catch` + typeof guard + raw-estimate fallback when the ctx is stale. This is a real porting consideration PR #40 didn't have to face.

---

## 8. Evidence base — our own archive numbers (work_docs/token-estimation-results.md)

Method: `scripts/analyze-token-estimation.mjs` replays both counting methods over session JSONLs using pi's real `estimateTokens`/`calculateContextTokens`; ratios only over marker-present windows; window clamped to the current branch (last compaction's `firstKeptEntryId`) because the JSONL retains pre-compaction bulk the runtime branch does not.

### Author's config (observe 25,000 / reflect+drop 80,000 / compact 185,000) — aggregate over 698 unique sessions

| stage      | threshold | n   | median est/usage | min  | max   | est fires | usage fires | churn× | LATE | EARLY |
| ---------- | --------- | --- | ---------------- | ---- | ----- | --------- | ----------- | ------ | ---- | ----- |
| observer   | 25,000    | 243 | 0.80             | 0.00 | 23.59 | 297       | 377         | 1.3    | 98   | 18    |
| reflector  | 80,000    | 176 | 0.83             | 0.00 | 23.59 | 98        | 164         | 1.7    | 77   | 11    |
| dropper    | 80,000    | 5   | 0.61             | 0.03 | 1.17  | 192       | 286         | 1.5    | 109  | 15    |
| compaction | 185,000   | 339 | 0.61             | 0.00 | 3.17  | 3         | 23          | 7.7    | 21   | 1     |

- **Compaction is the worst**: 3 estimated fires vs 23 truthful fires, **7.7× churn**, 21 LATE windows. Matches upstream PR #40's "never fires" claim.
- LATE counts (windows that should have fired under truthful counting): observer 98, reflector 77, dropper 109, compaction 21.

### Calibration (usage threshold reproducing today's fire frequency, `same-fire-count T'`)

| stage      | threshold | T'      | usage p50 | p90     | p95     | max     |
| ---------- | --------- | ------- | --------- | ------- | ------- | ------- |
| observer   | 25,000    | 36,303  | 31,775    | 110,826 | 129,975 | 238,483 |
| reflector  | 80,000    | 99,327  | 40,621    | 114,395 | 131,394 | 238,483 |
| dropper    | 80,000    | 103,162 | 66,956    | 142,940 | 165,993 | 274,486 |
| compaction | 185,000   | 262,007 | 67,020    | 143,523 | 169,043 | 274,486 |

### Observer input simulation (tool-result + thinking trimming)

- windows with content: 674; median chunk: **19,282 tokens**; **tool_result share: 51%**, thinking share: 22%.
- trim policy: tool results > 4096 chars → head+tail 1000/1000 chars; thinking > 4096 chars → head+tail 20%/20% (fractional).
- median 19,282 → 12,220 tokens (median save 31%, p90 61%); of tool-result tokens median 51% saved; of thinking tokens median 1% saved.

**Relevance to the plan:** the observer's serialized input is dominated by tool results (median 51%) — the exact content class that produced the 1.7M-char entry in PR #34's comment trail. A head/tail trim policy for tool results is already validated by our simulation and is a candidate addition alongside the serializer budget.

### Tier calibration (per achieved-context tier; compact anchor = 65% of tier p90 achieved context)

| tier              | n   | p50 ctx | p90 ctx | compact (65%) |
| ----------------- | --- | ------- | ------- | ------------- |
| low (<100k)       | 358 | 49,703  | 91,918  | 59,747        |
| medium (100–200k) | 246 | 137,233 | 187,347 | 121,776       |
| high (200k+)      | 71  | 222,459 | 273,451 | 177,743       |

Fire-rate thresholds per tier (usage basis, threshold-independent): fire-20% / fire-40% / fire-60% per stage (observer/reflector/dropper/compaction) — full table in `work_docs/token-estimation-results.md`. These are candidate recalibrated defaults for usage-based counting.

---

## 9. Upstream timeline & repo context

- Version in #32: `pi-observational-memory@3.0.3`.
- PR #33 and #34 both merged **2026-07-29** (owner elpapi42: "fix the conflicts and i will merge it asap"; WSXYT rebased onto latest master, resolved notification/agent-loop conflicts, kept new `streamSimple` arg from #28).
- Commit `3677e591` — ratio mode; authored before PR #40 (PR #40's body references `compactAfterTokensRatio` as existing). 196 tests before, 17 new.
- PR #40 — open at fetch time; no review comments; `reviewDecision` empty. Claims: two independent reviewers approved final state; live-tested several days; requires pi ≥ 0.49.0 (2026-01-17) for `getContextUsage` with graceful fallback.
- Upstream file layout vs ours (lockstep mapping): `src/session-ledger/*` → `src/om/ledger/*` (MOVED); `src/hooks/compaction-trigger.ts` → `src/om/compaction-trigger.ts` (MODIFIED); `src/hooks/consolidation-trigger.ts` → `src/om/consolidation.ts` (REWRITTEN); `src/agents/*` → `src/om/agents/*` (MOVED/MODIFIED); `src/config.ts` → `src/om/config.ts` + `src/core/unified-config.ts` (REWRITTEN); `src/serialize.ts` → `src/om/serialize.ts` (MOVED); `src/tokens.ts` → `src/om/tokens.ts` (UNCHANGED); `src/commands/status.ts` → `src/commands/memory.ts` (ELIMINATED/replaced); upstream `pool.ts` has no counterpart (pool math inline in our `dropper/agent.ts`).

---

## 10. Open observations & design notes (raw, for the plan)

1. **The plan's "cannot reuse verbatim" note is confirmed and answered by upstream PR #40**: the coverage counters need _anchor-based deltas_ (`realTokensSinceAnchor`), not the compaction counter's _usage-since-compaction_ shape — because (a) after a compaction the coverage anchors are gone and the delta must start from the compaction's post-usage baseline, (b) the compaction entry's own usage is the summary call and is invalid, (c) negative deltas (basis changes) must fall back, not clamp.
2. **Our dropper counter has no upstream counterpart** (`rawTokensSinceDropCoverage` doesn't exist upstream — their dropper is pool-fullness only). Any "real usage" treatment of the dropper token counter is ours to design; PR #40's out-of-scope reasoning suggests estimate-based is defensible (self-consistent internal accounting), but our `dropperDue` also gates on `reflectAfterTokens`-scale token counts, so it participates in the same drift class.
3. **`observerChunkMaxTokens` static 40K vs upstream derivation**: 40K ≈ `0.2 × 200K` window and sits between upstream's 60K fallback and `0.2 × 128K = 25.6K`. Static works for typical windows but does not scale to 1M models (40K chunks → 25 observer calls for a 1M backlog — fine — but the _cap_ itself never lets a big-window model take bigger, cheaper chunks; conversely on tiny windows 40K may still exceed the model's real window — the `effectiveContextWindow` pre-check catches that).
4. **Cap interplay with `effectiveContextWindow`**: our pre-check compares `chunkTokens + AGENT_LOOP_RESERVE` vs `effectiveObsCtx`; if the serializer budget becomes honest (labels + separators + excerpts), `chunkTokens` from the serializer is the right numerator. If the cap is derived from the _same_ window source as the pre-check, the two can be reconciled (cap = fraction of effective window).
5. **`ToolResultMessage.usage` is explicitly "not part of main LLM context accounting"** — baselines must only use assistant-message usage; tool-result usage fields (if ever populated) must be ignored by the helpers.
6. **Stale-ctx hazard for `getContextUsage`**: our compaction trigger and consolidation stages outlive the extension ctx in deferred paths; usage reads need synchronous capture or guarded lazy reads. (See §7.4.)
7. **Status display basis**: `/blackhole-memory` shows estimate-based progress vs static thresholds; the footer shows real percent. PR #40 leaves status sums estimate-based (self-consistent) but commit 3677e591 shows the _resolved threshold_ on the compaction line — minimal change that removes the biggest visible mismatch (threshold, not numerator).
8. **The `not_due` cursor advance is a silent fire-suppressor**: `runObserverStage` advances the observer cursor with reason `"not_due"` when tokens < threshold — under real-usage counting, if the delta computation is wrong (e.g. baseline undefined → raw fallback → estimate < threshold), the cursor still advances and the stage won't re-check until new entries land. The fallback path must not advance coverage/cursors on unmeasurable baselines (PR #40's "fall back rather than clamp/starve" rule applies to cursor advancement too).
9. **Upstream notification semantics changed**: PR #34 reports chunk tokens (`~X-token chunk`), ours reports `~X-token chunk (of Y accumulated)` — after porting, the "accumulated" part (backlog) is the informative number for the user; upstream dropped it in favor of honesty about what's sent. Decide which surface to keep.
10. **Test surface to extend**: `tests/session-ledger-progress.test.ts` (usage-aware paths, delta calculations, fallback cases), `tests/consolidation-trigger.test.ts` (cursor + pending anchors, manual mode), `tests/compaction-trigger.test.ts` (getContextUsage paths + stale-ctx), plus adapted upstream suites (`observer-chunk-cap`, `source-serialization-budget`, `stream-errors`).
11. **Agent drain-loop events**: all three of our agents already iterate `for await (const event of stream)` (observer L273, reflector L204, dropper L393) — the `_event` → `event` rename from upstream PR #33 is already effectively in place in ours; only the `logAgentStreamError` call is missing.
12. **`estimateContextTokens` (pi) is a drop-in for the plan's compaction counter** if we want pi-maintained logic; it returns `{ tokens, usageTokens, trailingTokens, lastUsageIndex }` — trailing = chars/4 estimate of messages after the last usage. The tavasti fork reimplements the same with `calculateContextTokens` + `estimateTokens`. Prefer pi's public helper (less code, stays in sync with pi's own compaction semantics) unless we need the bounded anchor scan (pi's `getLastAssistantUsage` is unbounded — ours must bound at the anchor index).
13. **Ratio-mode + real-usage combination (upstream final state)**: ratio mode resolves the _threshold_ from the window; PR #40 resolves the _numerator_ from real usage — the two compose into "compact at ratio × window of real context", which is exactly the footer-aligned behavior. Our plan's upper-bound logic (`effectiveCtx − reserve`) then becomes the _safety cap_ on top, rather than the trigger itself.
14. **Observer preamble (manual mode) is a separate budget**: `observerPreambleMaxTokens` (default 30% of chunk cap) caps accumulated observation summaries fed to the observer. It interacts with the chunk cap only in manual mode; upstream has no equivalent (no manual mode). Keep out of the real-usage discussion — it's an outbound budget (estimate-based, correct).
15. **Docs to update if ported**: `README.md`, `CONFIG.md`, `docs/configuration.md` equivalents — our config docs live in `CONFIG.md`; upstream updated README + docs/configuration.md for both PR #34 (chunk cap) and commit 3677e591 (ratio mode).
