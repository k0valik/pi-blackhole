# Plan 04 — Consistency, display & docs

**Phase:** 4 of 4 — polish the user sees. **Behavior change: minor** (internal accounting basis + display honesty + docs).
**Master doc:** `plan-00-overview.md` (decisions D11, D12).
**Depends on:** Phase 3. **Blocks:** nothing.

---

## 1. Goal

1. **One counting rule for observations everywhere** — `observationLineTokenCount` for stored `tokenCount` and every pool sum, ending the existing display-vs-pool inconsistency (`buildExistingObservationsSummary` counts full lines; pools count bare content).
2. **Honest status display** — `/blackhole-memory` shows basis-tagged progress (`~` prefix on estimate-basis numbers) and **resolved** thresholds (the auto-derived number, not `0`).
3. **Docs that tell the truth** — README/CONFIG.md/llms.txt rewritten for auto-derivation + migration guide; presets retired into override guidance.

## 2. File-by-file spec

### 2.1 Line-based observation accounting (D12)

- `src/om/agents/observer/agent.ts` (L185): store `tokenCount: observationLineTokenCount({ id, timestamp, relevance, content })` instead of `estimateStringTokens(content)`.
- **Sum sites** (all switch from reading bare `tokenCount` to computing `observationLineTokenCount(obs)` — uniform basis for old content-only and new line-based records alike):
  - `src/om/agents/dropper/agent.ts` L224 (pool sum for fullness/urgency) and L424 (allowed-id token sum)
  - `src/om/consolidation.ts` `anyStageDue` poolTokens reduce (~L310) and `runDropperStage` pool calc
  - `src/om/agents/dropper/coverage.ts` L85, L130 (bucket sums)
  - `src/om/ledger/projection.ts` — verify whether its observationTokens sum reads `tokenCount`; switch if so (the full-fold pressure check `observationTokens >= observationsPoolMaxTokens`, L257)
  - Debug-only sums (e.g. `observer.records` observationTokens) — switch for consistency; harmless.
- Reflection `tokenCount` fields (if any) stay content-only — reflections carry no pool budget (upstream PR #40's reasoning); note in code comment.
- Old observations keep content-only stored counts → sum-site computation makes accounting uniform anyway; stored-count drift is cosmetic and self-heals as observations are replaced.

### 2.2 Status display (`src/commands/memory.ts`)

Progress lines become basis-honest and threshold-resolved:

```
Next observation: ~12,400 / 32,000 tokens (39%)        ← '~' prefix when basis === "estimate"
Next observation:  41,200 / 32,000 tokens (129%)       ← no prefix on usage basis
Next compaction:   96,500 / 133,120 tokens (72%)       ← threshold = 0.65 × live window when auto
```

- Consume the Phase 3 measure functions (`measureObserverDue` etc. + `realContextTokens` for compaction) — same code path as the triggers; the display can never disagree with the trigger again.
- Resolved thresholds via `resolveTriggerThresholds`/`resolveCompactThreshold` with the live session window.
- Pool lines show line-based sums vs resolved pool max (auto-derived when `0`).
- Add a small "basis: usage | estimate" hint line when any counter is on estimate basis (explains the `~`).

### 2.3 Presets tab in the config modal (author's direction — promoted from deferred)

New tab in the configure overlay (`src/om/configure-overlay.ts`, alongside the existing field sections), using the pi-base settings modal's existing **scope actions** (`save-global` / `save-project` / `discard` / `cancel` — `src/pi-base/settings/body.ts` L77–81, `getScopeActionOptions` L713):

- **"Auto (recommended)"** — writes `0` (auto) to all threshold/budget fields. This is the fire-and-forget default.
- **Posture profiles** — one-click `thresholdScale` writes: "Cost-saver" `0.6`, "Balanced" `1.0`, "Responsive" `1.5`. These follow the live model window automatically; they are the modern form of the old low/medium/high presets.
- **Absolute presets (optional, for users who want exact pins)** — the legacy low/medium/high blocks, **values regenerated on the usage basis** via the archive script (the README numbers are estimate-era and must not be reused). Decision point at implementation: include this third section or keep the tab profiles-only; the tab structure supports both.
- Every choice shows a one-line summary of what it writes before saving (fields + values + scope).

### 2.4 Docs rewrite

**`CONFIG.md`:**

- Settings table: every threshold field documents `0 = auto (derived)` with its derivation rule; "absolute override" semantics; usage-basis vs estimate-basis clearly labeled per field (triggers = real usage; budgets = estimate).
- Migration section (from `plan-03` §10): defaults users do nothing; custom-threshold users multiply by ~1.45 or set `0`; author's-config worked example (25k→36k/0, 80k→116k/0, 185k→260k/0).
- Env-var table: same `0 = auto` notes.

**`README.md`:**

- "Configuration presets" section (L306+) → replaced by "How thresholds auto-derive" (the formula table from plan-00 D6, in prose) + "When to override" (small windows, degraded long-range attention models, cost tuning via `thresholdScale`) + the modal Presets tab + link to migration notes.
- Defaults table updated (0 = auto everywhere + `thresholdScale: 1.0`).

**`llms.txt`:**

- "Context size presets" section (L323–348) → rewritten: derivation is now runtime behavior; the old guidance formulas are superseded by the documented auto-derivation constants; preset blocks removed; guidance becomes "install, pick a posture in /blackhole configure, done — override individual fields only if you know why".

**`CHANGELOG.md`:** breaking-change entry (counting basis, defaults → auto, migration ×1.45, new debug events `observer.chunk_capped` / `*.stream_error` / `observer.upper_bound`).

## 3. Steps

1. `observationLineTokenCount` adoption (stored + all sum sites) → verify: `rg "sum.*tokenCount|tokenCount.*reduce" src/` shows only line-based computation at sum sites; tsc
2. Pool/projection/coverage tests updated → verify: `npx vitest run tests/dropper.test.ts tests/dropper-coverage.test.ts tests/projection.test.ts tests/fold.test.ts`
3. Presets tab in the configure overlay (§2.3) → verify: overlay opens the tab; each profile writes the documented fields to the chosen scope; `tests/configure-overlay.test.ts` + `tests/config-manager-modal.test.ts` updated green
4. `memory.ts` display (basis tags, resolved thresholds, pool lines, basis hint) → verify: `tests/memory-command.test.ts` updated green; manual `/blackhole-memory` eyeball in a live session
5. CONFIG.md / README.md / llms.txt / CHANGELOG.md → verify: docs review; every number in docs matches `unified-config.ts` defaults and resolver constants (grep cross-check)
6. Full suite → verify: `npx vitest run`
7. Commit: "feat(om): line-based observation accounting, honest status display, presets tab, auto-derivation docs (plan-04)" → verify: single commit

## 4. Test plan

- **Accounting:** observer stores line-based `tokenCount` (assert exact `estimateStringTokens(`[id] ts [rel] content`)`); pool sums treat old content-only and new line-based records identically (fixture with mixed records); dropper fullness/urgency driven by line sums; projection full-fold boundary shifts accordingly (update expectations).
- **Display:** estimate-basis numbers render with `~`; usage-basis without; resolved threshold shown for auto (`0`) config; explicit override shown verbatim; basis-hint line appears only when any basis is estimate.
- **Regression:** `tests/memory-command.test.ts`, `tests/consolidation.test.ts`, `tests/observer.test.ts` green.

## 5. Edge cases

- [ ] Mixed old/new observations in one pool → uniform line-based sums
- [ ] Auto pool max on tiny windows → clamped ≥ minimum; target = max/2 < max invariant preserved (existing validator)
- [ ] `observationsPoolTargetTokens > 0` explicit with auto max → validator still enforces target < resolved max? (today it validates against configured max — spec: validate against **resolved** max; document)
- [ ] Status with no entries / fresh session → estimate basis, floors, no NaN percentages
- [ ] Docs numbers vs code constants drift → grep cross-check step in §3.4

## 6. Rollback

Single revert; accounting basis change is internal-only, display change is cosmetic, docs are docs.
