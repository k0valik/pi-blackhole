# Plan 05 — Deferred register

**Status:** parking lot. Nothing here is scheduled. Each item needs an explicit decision before entering a phase. Review at every release.

---

---

## D-1 Circuit breaker for repeated stage failures

**What:** after N consecutive swallowed stream errors (`*.stream_error`) in a session for one stage, halt that stage's auto-runs and surface the last error prominently (status overlay + notify); optionally shrink the next chunk attempt (halve) rather than only retrying identical input.

**Origin:** issue #32 comment (IgorGanapolsky): "treat API errors as terminal for that observer slice, and advance (or shrink) the watermark on failure — never only on success."

**Why deferred:** we already have `MAX_STAGE_ATTEMPTS` + `recordRetryableError` + fallback chains + the upper-bound pre-check; the marginal value is the _halt_ semantics and the shrink-on-failure policy, both of which need design (what resets the streak? per-session or persistent?). Phase 2's stream-error logging is the prerequisite and ships first.

## D-2 Upstream PR #40 merge watch

**What:** upstream's real-usage trigger PR is **open** (unmerged) as of 2026-08-01. Our Phase 1/3 implement the same semantics independently (entries-only variant). When it merges, run the lockstep audit for any late changes (review fixes, edge cases we missed).

**Why deferred:** can't diff what doesn't exist yet; our plan doesn't depend on it.

## D-3 `dropperPoolFullnessThreshold` / dropper gating tuning

**What:** the archive shows drop markers are almost never written (1 in 20 sessions; `dropperPoolFullnessThreshold` added 2026-08-01 default 0.1, author at 0.05). After Phases 3–4 the dropper's token leg is usage-based and pool accounting is line-based — re-evaluate whether the fullness threshold and `dropperPressureThreshold × reflectorInputMaxTokens` pressure formula still gate correctly.

**Why deferred:** needs the Phase 3/4 data first; tuning without the new basis would be guessing.

## D-4 Auto-install user communications

**What:** release notes + migration doc blast for the fire-and-forget install base (the breaking-change warning covers in-product; this is the out-of-band channel).

**Why deferred:** happens at Phase 3/4 release time by definition.

## D-5 `estimateContextTokens` re-adoption watch

**What:** pi has an internal `estimateContextTokens(messages)` (usage + trailing, `{ tokens, usageTokens, trailingTokens, lastUsageIndex }`) that is **not** re-exported from the package root (verified runtime-undefined on 0.83.0). Our Phase 1 reimplements the equivalent on entries. If pi exports it publicly later, consider swapping our trailing logic for pi's to stay in lockstep with pi's own compaction semantics.

**Why deferred:** not available today; our implementation is verified against pi's algorithm.

---

## Promoted out of this register (2026-08-01, author feedback)

- **Tool-result/thinking trimming** → promoted into Phase 2 (plan-02 §4.5) as layer (a) of the Worker Safety Invariant (plan-00 D13). The author flagged small-worker overflow protection as an explicit requirement; discovery during planning showed chunk-content trimming did not actually exist yet (`truncateRecordContent` only covers agent-written records).
- **Presets tab in the configure overlay** → promoted into Phase 4 (plan-04 §2.3) as posture profiles (`thresholdScale`) + optional recalibrated absolute blocks, per the author's direction.

## Reviewed-and-rejected (record so they don't come back)

- **Upstream ratio-mode config fields** (`compactAfterTokensMode`, `compactAfterTokensRatio`) — rejected: D5's `0 = auto` sentinel on existing fields delivers the same outcome without new knobs (the author's constraint; the single granted exception is `thresholdScale`, D14).
- **Per-stage opt-in for usage counting** (issue doc open question 2) — rejected: shared measurement core; per-stage divergence is the drift class we're killing.
- **Staged rollout (compaction-only first, coverage later)** (issue doc open question 1) — considered; rejected in favor of phased landing (Phase 1 → 2 → 3) with the atomic _release_ carrying counting + auto-derivation together (D10), since the phases are separately revertable anyway.
- **`getContextUsage().tokens` as the compaction numerator** (upstream PR #40's approach) — rejected in favor of entries-only (D1): same data source, no stale-ctx hazard, testable purity.
