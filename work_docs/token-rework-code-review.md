# Code Review — `feat/token-rework`: bugs, regressions, issues

Date: 2026-08-20
Scope: commits `f4e915f` (plan-01), `a123f11` (plan-02), dirty phase-3 tree.
Reference: `work_docs/plan-00-overview.md` (decisions D1-D14).
Verified: `pnpm test` 1422/1422 green (84 files), typecheck clean, lint clean.

## 1. Confirmed bugs (current code)

### 1.1 — Manual-mode (pending) reflector/dropper measure with mismatched basis [HIGH]

`runReflectorStage`/`runDropperStage` manual-mode re-checks compare **raw-estimate** progress against **usage-basis auto-derived** thresholds:

- `src/om/consolidation.ts:1010-1035` — `reflectionTokens = rawTokensAfterIndex(entries, refIdx)` vs `reflectThreshold = resolveTriggerThresholds(...)` (0.40 x window)
- `src/om/consolidation.ts:1344` — same pattern for dropper

At a 128k window, manual mode now fires at ~51.2k *raw estimate* tokens vs. the old explicit 25k default => **~2x later cadence for manual-mode users**. Compounding: `anyStageDue` (trigger side) uses the usage-basis measure functions, so trigger and re-check disagree — the trigger can report "due" while the stage returns `continue` (spurious due notifications, and the reverse). The `basis === "usage"` not_due guard exists only in the auto branch (L671/1042/1364); manual-mode not_due advances (L1024, L1348) still fire on estimate basis, contrary to the plan's fallback-safety rule.

### 1.2 — breaking-notice persists before checking `hasUI` [MEDIUM]

`src/om/breaking-notice.ts:83-84` — `writeLastSeenVersion(BREAKING_SINCE)` runs *before* `if (!ctx?.hasUI) return;`. A headless-first run (CI, ssh, cron) permanently swallows the one-time breaking-change notice for that install. Plan-03 D10 order was notify-then-persist, gated on `hasUI`.

### 1.3 — `observer.chunk_capped` under-reports [LOW]

`src/om/consolidation.ts:709` fires only when `truncatedSourceEntryIds.length > 0`; the plan-02 spec (and the common case — plain budget cut with `sourceEntryIds.length < backlog.length`) is not logged. Diagnostic signal is lost exactly when the chunk is capped by budget alone.

### 1.4 — `resolveBudget` skips the >=1000 clamp for explicit values [LOW]

`src/om/model-budget.ts` — the chunk resolver clamps explicit >=256, but `resolveReflectorInputMaxTokens` / `resolveDropperInputMaxTokens` / `resolveObservationsPoolMaxTokens` pass explicit config through verbatim. Plan-03 §5 said all budget resolvers clamp to sane minimums. `reflectorInputMaxTokens: 500` is honored as 500.

### 1.5 — Thinking trim tail unbounded [LOW]

`src/om/serialize.ts` `trimLongThinkingBlock` — head capped at 4000 (chosen default), but tail = 20% uncapped: a 90k-char block yields an ~18k-char (~4.5k token) tail. The "head/tail cap" decision intent was to bound both.

## 2. Latent risks / unvalidated claims

### 2.1 — Cadence shift for no-usage-provider sessions [RISK, needs validation]

Derived thresholds (0.25 x 128k = 32k, 0.40 x = 51.2k) vs old defaults (15k/25k estimate) => observe fires ~2.1x later on estimate-basis sessions. Plan-03 §8.10 requires re-running `scripts/analyze-token-estimation.mjs --summary` and recording archive before/after numbers; **that validation has not been done** — the "fire frequency ~ same or lower" claim is unverified. Manual mode (1.1) doubles this.

### 2.2 — D7 upper bound is config-dependent [LOW]

Bound uses `resolveWorkerWindow(stageModelConfig, sessionWindow)`: with a 1M session and no configured observer model, the pre-stage bound (~988k) never trips — only the in-stage `context_window_exceeded` pre-check guards after chunk build. Matches the plan's "best synchronously-known" alternative, but the "never overflow the worker" headline is weaker than it reads for that config.

### 2.3 — pi-base settings modal stale vs 0=auto semantics [LOW]

`src/pi-base/blackhole-settings.ts:381` (vendored, untouched): `minVal = 1` for every numeric key except `observerPreambleMaxTokens`. Accidentally harmless now (DEFAULTS are 0 => reset-to-default = reset-to-0), and `target >= max` with 0/0 -> `floor(0/2) = 0` stays consistent. `thresholdScale` is absent from the modal. Phase-4 surface.

### 2.4 — `resolveObservationsPoolTargetTokens` dead code [LOW]

No consumer anywhere; pool target was already a forward-compat no-op pre-change. Not a regression; Phase-4 cleanup.

### 2.5 — Dual threshold-resolution call sites [LOW]

`resolveTriggerThresholds` is invoked both in `due.ts` (anyStageDue) and in-stage (`consolidation.ts:987, 1309`). Same function today, but future clamping/scale changes can drift between trigger and re-check.

### 2.6 — Misc [trivial]

- Excerpt `estimatedTokens` can exceed `maxTokens` by ~3 tokens (ceil rounding in the `availChars` allocation).
- "of X accumulated" notifications mix units (usage tokens + estimate tokens).
- Dropper pressure leg remains dead-by-default (0.15W pool cap < 0.42W pressure threshold) — pre-existing, not a regression.
- `.agent/skills/pi-extension-development/` untracked — must be gitignored, never committed.

## 3. Checked and cleared (not bugs)

- `compactionIndex >= 0 && compactionIndex >= anchorIndex` in `realTokensSinceAnchor` — the `>` vs `>=` question resolves correctly: anchor=-1 falls through to "current real" (delta 0), anchor === compaction gets post-compaction baseline (D3-consistent); doc comment updated. The earlier failing test was a mid-edit artifact; suite is green.
- Trimming correctly never touches user/assistant text (`serialize.ts:96-116` — user via untrimmed `textOnly`, assistant text blocks pushed raw; only thinking + tool results trimmed).
- Excerpt budget math, min-budget guard, single-oversized handling — sound.
- `measureFreshSession` correctly compensates for module-level `realTokensSinceAnchor` semantics; `rawTokensAfterIndex(-1)` = whole branch.
- Env `PI_BLACKHOLE_*_TOKENS=0` semantics change (previously rejected -> now auto) is the documented 0=auto intent; explicit config values kept verbatim per D5.
- 1M-session + unconfigured worker model: chunk (0.2 x 1M = 200k) is consistent because the worker window also resolves to 1M — no hidden overflow.
- Initial 30 failures (consolidation 17, memory-command 6, ...) were a mid-edit snapshot; test files were updated + `tests/due.test.ts` added, everything green. No evidence of weakened tests (failure count 30 -> 0 with expectation updates + new tests only).

## 4. Recommended fixes before Phase-3 lands (priority order)

1. Manual-mode reflector/dropper re-checks -> use `measureReflectorDue` / `measureDropperDue` with the pending-based anchor (kills 1.1 and the dual-measurement drift); gate manual not_due advances on basis.
2. breaking-notice: move persist after notify, inside the `hasUI` branch (1.2).
3. `chunk_capped` -> fire on backlog-cut OR truncation (1.3).
4. Run the plan-03 §7 script + record §8.10 before/after numbers; if estimate-basis cadence >2x slower is unacceptable, revisit ratios before the constants are locked (2.1).
5. Phase-4: pi-base modal minVal/thresholdScale, dead resolver cleanup, thinking tail cap (2.3, 2.4, 1.5).