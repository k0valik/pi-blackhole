# Plan 03 — Truthful triggers & auto-derivation

**Phase:** 3 of 4 — the core behavioral change. **Behavior change: YES** (trigger numerators become real usage; thresholds become auto-derived; one-time breaking-change warning).
**Master doc:** `plan-00-overview.md` (decisions D1–D7, D10, D11).
**Depends on:** Phase 1 (measurement core). Benefits from Phase 2 (honest chunk sizes) but does not require it. **Blocks:** Phase 4.

---

## 1. Goal

Make every trigger truthful and every threshold self-sizing:

1. **Compaction** fires at real context ≥ resolved threshold (default `0.65 × session window`) — never-late, never-wasteful, matching what the user sees in pi's footer.
2. **Observer/reflector/dropper** fire on **usage deltas since their anchor** (cursor → coverage marker → compaction), with the **worker-window upper bound** so a backlog can never outgrow the worker before the trigger trips.
3. **One due-computation per stage** consumed by `anyStageDue`, the stage runners, and `/blackhole-memory` — killing the check/recheck/display drift class.
4. **Config:** every threshold field gains `0 = auto`; defaults become auto; explicit values honored as absolute overrides on the new (usage) basis; one-time breaking-change warning shipped atomically.

## 2. Non-goals

- Ratio-mode _config fields_ (upstream's `compactAfterTokensMode`/`compactAfterTokensRatio`) — rejected (D5/D11); auto-derivation replaces them.
- Changing raw estimate counters (they remain as the fallback path).
- Trimming (Phase 5), pool accounting (Phase 4).

## 3. The unified due-computation

New home: `src/om/consolidation.ts` (or extract `src/om/due.ts` if consolidation.ts grows — decide at implementation; extraction preferred, consolidation.ts is already ~1500 lines).

```ts
export type StageMeasurement = {
  due: boolean;
  progress: number; // tokens measured on `basis`
  threshold: number; // resolved (auto-derived or absolute override)
  basis: CountBasis; // "usage" | "estimate" — for display honesty
  anchorIndex: number; // resolved anchor actually used (-1 = none)
  upperBoundApplied: boolean; // true when worker-window bound drove `due`
};

export function measureObserverDue(entries, runtime, pending?): StageMeasurement;
export function measureReflectorDue(entries, runtime, pending?): StageMeasurement;
export function measureDropperDue(entries, runtime, pending?): StageMeasurement; // token leg only; pool/new-data legs unchanged
```

**Anchor resolution per stage (preserves current semantics exactly):**

- observer: cursor `entryId` → index; else `latestCoverageIndex(OM_OBSERVATIONS_RECORDED)`; else `findLastCompactionIndex` (cold start); else −1.
- reflector: cursor → coverage (reflections) → manual-mode pending batch mapping; plus the existing **new-data leg** (observation batches after the cursor / pending) — unchanged, only the token leg changes.
- dropper token leg: cursor → `latestCoverageIndex(OM_OBSERVATIONS_DROPPED)` → pending. Pool-fullness/pressure/new-data legs stay estimate-based internal accounting (Phase 4 only changes their line-counting basis).

**Progress:** `measureSinceAnchor(entries, anchorIndex)` (Phase 1) — usage-delta when computable, raw fallback otherwise.

**Threshold resolution (single resolver):**

```ts
// src/om/model-budget.ts or due.ts
export function resolveTriggerThresholds(
  config,
  sessionWindow,
): {
  observeAfterTokens: number; // config >0 ? config : floor(sessionWindow × 0.25 × scale)
  reflectAfterTokens: number; // config >0 ? config : floor(sessionWindow × 0.40 × scale)
  compactAfterTokens: number; // config >0 ? config : floor(sessionWindow × 0.65 × scale)
};
// scale = config.thresholdScale (default 1.0) — applies ONLY to auto-derived values (D14);
// explicit absolute thresholds are returned verbatim (clean break, D5).
export function resolveCompactThreshold(config, sessionWindow): number; // used by compaction-trigger + memory.ts
```

- `sessionWindow = resolveSessionContextWindow(ctx.model, () => guardedGetContextUsage(ctx))` (Phase 1 §3.3).
- Minimum sane floors: derived thresholds clamped ≥ 1000 (avoid degenerate tiny windows producing 0).

**Worker-window upper bound (D7):**

```ts
due = progress >= Math.min(resolvedThreshold, workerWindowSync − AGENT_LOOP_RESERVE − STAGE_OVERHEAD)
```

- `workerWindowSync` = best **synchronously** available worker window: stage's configured model metadata `contextWindow` (sync registry lookup if available; else session window; else 128k). The in-stage `context_window_exceeded` pre-check remains the authoritative guard — the bound exists to fire _earlier_, never later. `STAGE_OVERHEAD` ≈ preamble/system estimate per stage (constant, e.g. 4000; observer preamble is separately capped already).
- When the bound drives `due`, set `upperBoundApplied: true` and debug-log it (`observer.upper_bound`, etc.).

**Consumers:**

- `anyStageDue` → calls the three measure functions (replaces L219–333's inline legs; cursor/pending logic moves into the measure functions).
- `runObserverStage`/`runReflectorStage`/`runDropperStage` → call the same measure function for their re-check; **delete** the duplicated `rawTokensSince*Coverage >= config.*` lines (L219–241, L327–333, L1051–1057, L1352–1358).
- **Fallback-safety rule (semantic diff §10.8):** when `basis === "estimate"` because the baseline was _unmeasurable_ (not merely "no usage provider"), the `not_due` cursor advance in `runObserverStage` must NOT fire — advance cursors only on a trustworthy measurement. (Simplest: skip the not_due advance whenever `basis === "estimate"`.)
- `/blackhole-memory` (`memory.ts`) → same functions for the progress lines (Phase 4 styles the output).

## 4. Compaction trigger (`src/om/compaction-trigger.ts`)

All three call sites (L135 `handleTurnEnd`, L289 `handleAgentEnd`, L411 deferred re-check) become:

```ts
const entries = ctx.sessionManager.getBranch() as Entry[];
const real = realContextTokens(entries);
const tokens = real ?? rawTokensSinceLastCompaction(entries); // D4 fallback
const basis = real !== undefined ? "usage" : "estimate";
const threshold = resolveCompactThreshold(
  runtime.config,
  resolveSessionContextWindow(ctx.model, () => guardedGetContextUsage(ctx)),
);
if (tokens < threshold) {
  /* pressure-relieved path (midRunCompactionSuspended lift) — unchanged */
}
```

- Entries-only numerator → no stale-ctx hazard in the deferred re-check (D1). `resolveSessionContextWindow`'s thunk is guarded (try/catch) for the deferred path.
- `handleTurnEnd`'s suspension-lift logic (`midRunCompactionSuspended`) keys off the same truthful `tokens < threshold` — unchanged structurally.
- Debug events (`compaction_trigger.*`) gain `{ basis, threshold }`.
- Note on semantics: `realContextTokens` _is_ "real context now" = "since last compaction" when a compaction happened (post-compaction baseline). The raw fallback keeps its `firstKeptEntryId`-based estimate semantics.

## 5. Config changes (`src/core/unified-config.ts`, `src/core/config-env.ts`)

| Field                          | Change                                                                                                                                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compactAfterTokens`           | move to `nonNegativeInt` normalization; default `81000 → 0`                                                                                                                                                     |
| `observeAfterTokens`           | same; default `15000 → 0`                                                                                                                                                                                       |
| `reflectAfterTokens`           | same; default `25000 → 0`                                                                                                                                                                                       |
| `reflectorInputMaxTokens`      | same; default `80000 → 0` (auto = 0.60 × worker window, resolved at stage time)                                                                                                                                 |
| `dropperInputMaxTokens`        | same; default `80000 → 0` (auto = 0.60 × worker window)                                                                                                                                                         |
| `observationsPoolMaxTokens`    | same; default `20000 → 0` (auto = 0.15 × session window)                                                                                                                                                        |
| `observationsPoolTargetTokens` | default `10000 → 0` (auto = pool max / 2; existing "half of max" logic absorbs this)                                                                                                                            |
| `observerChunkMaxTokens`       | (Phase 2) default `40000 → 0`                                                                                                                                                                                   |
| **`thresholdScale`**           | **NEW field — the only one (D14).** Default `1.0`; finite > 0, clamped [0.1, 10]; multiplies auto-derived observe/reflect/compact thresholds; ignored for explicit values. Env: `PI_BLACKHOLE_THRESHOLD_SCALE`. |

- Budget resolvers live next to `resolveObserverChunkMaxTokens` in `model-budget.ts`: `resolveReflectorInputMaxTokens(config, workerWindow)`, `resolveDropperInputMaxTokens(config, workerWindow)`, `resolveObservationsPoolMaxTokens(config, sessionWindow)`. All clamp to sane minimums (≥ 1000).
- Env vars (`PI_BLACKHOLE_*`) unchanged — `0` now means auto; documented.
- **Where autos resolve:** trigger thresholds resolve per-measurement (session window can change mid-session on model switch — derivation must follow live, that's the point). Worker budgets resolve per stage run (worker model can change across the fallback chain — recompute per attempt with that attempt's window; the `context_window_exceeded` pre-check already does per-attempt resolution).
- Pool max: resolving per status/fold call is fine (pure function of session window).

## 6. Breaking-change warning (D10)

- New tiny module `src/om/breaking-notice.ts`: `BREAKING_SINCE = "<this release version>"`; state file `~/.pi/agent/pi-blackhole/last-seen-version.json` (pattern from `cooldown.ts` L28/53/64).
- Hook: `pi.on("agent_start")` (register once, e.g. in consolidation or its own registration): if `hasUI && lastSeen < BREAKING_SINCE` → `ctx.ui.notify("pi-blackhole: token counting now uses real model usage; thresholds auto-derive from your model's context window — custom thresholds keep working (now counted in real tokens, ~1.45× your old estimate values). See /blackhole configure.", "warning")`, then persist current version. Once per install, not per session beyond first display.
- Release-checklist note in the file header: delete the module + state key 2 minor versions later (programmatic removal, issue doc appendix B).

## 7. Constants finalization (script-driven, recorded here at execution)

Before landing Phase 3, re-run the archive analysis to finalize D6's derivation constants:

1. `node scripts/analyze-token-estimation.mjs --summary work_docs/token-estimation-results.md` → verify: report regenerates cleanly
2. Read off T' (cadence-preserving) and fire-40% values for observe/reflect on the medium tier; confirm `0.25`/`0.40` window-fractions sit between them on 128k; adjust to `0.20`/`0.30` etc. if the data says otherwise → verify: chosen constants + justification appended to this doc's §10 and to `plan-00` D6
3. Sanity-check `0.65 × window` against the tier compact anchors (59.7k/121.8k/177.7k ≈ 65% of tier p90) → verify: table reproduced in the release notes

## 8. Steps

1. Threshold resolvers + budget resolvers + window floors in `model-budget.ts` → verify: tsc + resolver unit tests
2. Config normalization (8 fields to `nonNegativeInt`, defaults → 0) → verify: `tests/config.test.ts` updated green; `loadConfig` round-trip with explicit values honored
3. `due.ts` measure functions + anchor resolution (move cursor/pending legs out of `anyStageDue`) → verify: tsc + new due unit tests
4. Rewire `anyStageDue` + three stage runners + delete duplicated inline checks → verify: `rg "rawTokensSince.*>= *config\\." src/om/consolidation.ts` → zero hits; `tests/consolidation.test.ts` green
5. `compaction-trigger.ts` three call sites → verify: `tests/compaction-trigger.test.ts` green (rewritten for usage/auto paths); `tests/auto-compact-permutations.test.ts` green
6. `memory.ts` progress lines consume measure functions (output styling is Phase 4; wire the data now) → verify: `tests/memory-command.test.ts` green
7. Breaking-notice module + registration + state persistence → verify: new test (fires once, persists, suppresses)
8. Constants finalization (§7) → verify: recorded
9. Full suite → verify: `npx vitest run`
10. Archive before/after: run `analyze-token-estimation.mjs` with old est vs new auto-derived thresholds; confirm default-user fire frequency ≈ constant-or-lower and LATE windows ≈ 0 → verify: numbers appended to this doc
11. Live soak checklist (§9) → verify: checked off in a real session
12. Commit: "feat(om): truthful usage-based triggers with auto-derived thresholds (plan-03; supersedes tavasti@360f24a scope)" → verify: single atomic commit incl. config + warning + tests

## 9. Live soak checklist (real session, `debugLog: true`)

- [ ] `observer.start` shows honest `chunkTokens`; progress uses `basis:"usage"` when usage exists
- [ ] `/blackhole-memory` observer/reflector/compaction lines match reality (cross-check against pi footer %)
- [ ] Auto compaction fires at ~65% of the session model's window (force with a small window override in model config)
- [ ] A model switch mid-session does not produce runaway firing (negative-delta fallback)
- [ ] Right after compaction: no immediate re-trigger; coverage deltas resume from the post-compaction baseline
- [ ] 64k-worker scenario (config override): observer fires via upper bound before overflow; no `context_window_exceeded` loop
- [ ] Breaking-change notice appears once, then never again

## 10. Migration notes (for CONFIG.md / release notes — Phase 4 polishes)

- **Defaults users:** nothing to do. Thresholds now auto-derive from the live model window; fire frequency ≈ same or lower; compaction now actually works before the hard limit.
- **Custom-threshold users:** your values are **respected verbatim** (D5 clean break, per field) — but they now count **real usage tokens** (~1.45× your old estimate values for observe/reflect, ~1.6× for compaction), so cadence rises unless you act. Three options: multiply by ~1.45 (author's config example: observe `25000 → ~36000`; reflect `80000 → ~116000`; compact `185000 → ~260000`), set the field to `0` (auto), or keep values and tune later with `thresholdScale`.
- **`0` semantics:** `0` = auto-derive. Previously `0` was rejected/absent → default, so no valid existing config changes meaning by setting `0` explicitly.
- **`thresholdScale`:** the one new knob. `1.0` default = derived thresholds as documented. `0.6` = cost-saver (~40% fewer worker runs), `1.5` = responsive. Only affects auto-derived thresholds; your explicit values are never scaled.

## 11. Edge cases

- [ ] Provider without usage reporting → everything on estimate basis; behaves like today
- [ ] **1M session + ~128k workers (the author's flagged scenario):** auto observe threshold 250k → upper bound clamps firing to ~115k accumulated (worker ingestible); chunk ≤ ~25.6k trimmed estimated tokens per run; backlog drains across ~5 runs; worker never overflowed (D13 invariant; integration test with synthetic windows)
- [ ] Small local models (32k–128k), zero config → auto-derivation ≈ today's low/medium defaults; floors clamp degenerate values
- [ ] Fresh session, no assistant turns → estimate basis; no firing before first response
- [ ] Right after compaction → unmeasurable → estimate basis; no re-trigger storm
- [ ] Model switch mid-session (window changes) → derivation follows live window; negative delta → fallback
- [ ] Manual mode: pending anchors resolve via `entryIndexForId(pending.*.coversUpToId)`; pending batch removed → anchor −1 → coverage-marker fallback chain
- [ ] Fork/switch recovery: cursors absent → coverage markers → compaction → −1 (existing chain preserved)
- [ ] `firstKeptEntryId` missing from branch (corrupt/compacted-away) → raw fallback path identical to today
- [ ] Tiny window (e.g. 8k local model) → floors clamp thresholds ≥ 1000; worker bound prevents overflow firing
- [ ] `compactAfterTokens: 0` + `compaction: "manual"` → resolver still used for display; no firing (gating unchanged)

## 12. Rollback

Single revert restores estimate counters + static defaults. The breaking-notice state file is inert if the module is reverted (harmless leftover; next breaking release reuses the pattern).
