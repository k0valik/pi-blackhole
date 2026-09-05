# Plan 06 — Release gates: replay verification & live soak ("before release")

**Status:** Gate plan — executes after Phases 1–3 (Gate 1) and after installing the branch build (Gate 2). **Not a code phase.**
**Master doc:** `plan-00-overview.md`. **Inputs:** all plan-01…04 artifacts, `scripts/analyze-token-estimation.mjs` (infrastructure to reuse), `~/.pi/agent/sessions/**` (698 real session JSONLs as fixtures).
**Purpose:** two explicit, data-driven confirmations before this hits `main` — **not** anecdotal "feels fine".

---

## 1. The two-gate model

| Gate                                         | When                                                                           | Question answered                                                       | Data                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Gate 1 — offline replay ("what-if")**      | Phases 1–3 landed on the feature branch, pre-merge                             | "Does the new code even work, and what would it have done differently?" | **Existing** 698 real session JSONLs replayed through the **real new code** with example configs |
| **Gate 2 — live soak + breakpoint analysis** | Branch build installed in the author's daily-driver pi, a few days of real use | "Does it work in actual usage, confirmed from artifacts?"               | **New** session JSONLs created after the breakpoint + real debug logs (`debugLog: true`)         |

Both gates have **explicit pass/fail criteria** (§4, §6). A failed gate routes back to a specific phase (§8) — it does not get explained away.

## 2. Why Gate 1 is possible at all (and why the old script can't do it)

The existing `scripts/analyze-token-estimation.mjs` **reimplements** the counter logic inline (`usageSinceLastCompaction`, `usageDeltaSinceCoverage` — shadow copies). That was right for investigating, but a release gate must exercise the **shipped code**, not a parallel implementation that could drift from it.

Phase 1's D1 design (entries-only, pure counters) is what makes this feasible: every decision the new code makes — `realContextTokens`, `measureSinceAnchor`, threshold/budget resolvers, the budgeted serializer, the due functions — is a **pure function of entries + config + window**. No ctx, no LLM calls, no host. The replay harness imports the real `src/` modules and drives them with real session data.

LLM effects are simulated structurally (§3.3): when a stage "fires", the harness appends a **synthetic marker** with the exact shape the real stage would write, so subsequent measurements see the same ledger state the real pipeline would produce.

## 3. Gate 1 — the replay harness

### 3.1 Location & runner

- **`tests/replay-gate1.test.ts`** — a vitest suite gated behind `REPLAY=1` (skipped in CI), importing directly from `src/` (zero new dependencies; vitest 4.1.9 already handles TS). npm script: `"replay": "REPLAY=1 vitest run tests/replay-gate1.test.ts"`.
- (Acceptable alternative at implementation: `scripts/replay-whatif.mts` + `tsx` devDep. Decide then; vitest is the default because it adds nothing.)
- Reports: full per-session rows → `tmp/replay-gate1-<config>.md` (gitignored); tracked math-only summary → `work_docs/replay-gate1-results.md` (same pattern as `token-estimation-results.md`).

### 3.2 Reused from `analyze-token-estimation.mjs`

Session discovery (`~/.pi/agent/sessions`, realpath-dedupe), JSONL parsing, **branch clamping** (`branchStartIndex`: last compaction's `firstKeptEntryId`, because the JSONL retains pre-compaction bulk the runtime branch does not), tier bucketing by achieved max `usage.totalTokens`, report writers.

### 3.3 Simulation loop (per session, per config)

1. Load entries; clamp to branch.
2. Determine the session window proxy: **achieved max `usage.totalTokens`** (measured lower bound on the model window — same tiering basis as the analyze script). _Consequence: replay thresholds are underestimates of production's (registry window), so Gate 1 is conservative — it fires earlier than production would. Also support a `--window <N>` override for exact-window runs._
3. Worker window: config-supplied per run (see §3.4) — workers aren't recorded in session files.
4. Walk the branch chronologically; at every assistant-message entry (turn boundary approximation), evaluate **the real due functions** (Phase 3) with a simulated runtime: `{ config: presetConfig, cursors: inMemoryMap }`, `pending = undefined` (manual mode is out of replay scope — note as limitation).
5. **Observer due** → run the real `serializeSourceAddressedBranchEntries(backlog, { maxTokens: resolvedCap })`; record `{ progress, threshold, basis, upperBoundApplied, chunkTokens, chunkEntries, truncatedIds, capped }`; simulate the stage effect: append synthetic `{ type: "custom", customType: OM_OBSERVATIONS_RECORDED, data: { observations: [dummyObservation], coversUpToId: <last returned id> } }` (non-empty observations so `isValidCoverageEntry` passes) + advance simulated cursor.
6. **Reflector due** → same shape with `OM_REFLECTIONS_RECORDED` / dummy reflection. (Reflector input budgeting not simulated — needs real observation content; record token-leg fires only. Limitation noted.)
7. **Dropper** → token leg only (real `rawTokensSinceDropCoverage`/measure equivalent); pool-fullness legs need real observation content → **not simulated** (limitation noted).
8. **Compaction check** → real `realContextTokens(entries)` vs `resolveCompactThreshold(config, windowProxy)`; on fire: record `{ realTokens, threshold, pctOfWindow }` and append a **synthetic compaction entry** `{ type: "compaction", firstKeptEntryId: <entry ~20% back from the tail> }` so the strictly-after-compaction anchoring resets exactly as it would in production → multi-compaction sessions replay realistically.

### 3.4 Configs under test (the "3 presets" + continuity row)

| Config                                      | Meaning                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. shipped default**                      | all threshold/budget fields `0` (auto), `thresholdScale: 1.0`, worker window 128k                                                                 |
| **B. cost-saver**                           | same as A with `thresholdScale: 0.6`                                                                                                              |
| **C. responsive**                           | same as A with `thresholdScale: 1.5`                                                                                                              |
| **D. author's current config (continuity)** | observe 25k / reflect+drop 80k / compact 185k explicit — shows exactly how the author's cadence shifts and validates the ×1.45 migration guidance |
| **E. small-worker sweep** (invariant proof) | config A with worker window 64k — the 1M-session/128k-worker scenario pushed harder                                                               |

(If Phase 4 ships recalibrated absolute preset blocks, add them as F/G/H.)

### 3.5 Metrics (per config, aggregated + per-session rows)

- **Fire events** per stage; compaction fire-time as **% of window** (should cluster at 65% ±5 for config A).
- **Worker Safety Invariant:** for every simulated observer run — `chunkTokens ≤ resolvedCap` and `chunkTokens + AGENT_LOOP_RESERVE ≤ workerWindow`. Count violations (**must be 0**, all configs, especially E).
- **Coverage integrity:** runs that failed to advance `coversUpToId` (**must be 0**); final uncovered backlog per session (should be < chunk cap unless the session ended mid-drain).
- **Trim/excerpt engagement:** capped runs, excerpted entries, trim markers present; chunk-token reduction vs untrimmed (sanity vs the 31%-median simulation).
- **Basis mix:** % of measurements on `usage` vs `estimate` (informational — providers without usage).
- **Cost proxy:** observer/reflector run counts per session vs the **old-code simulation** (raw counters from `src/` — import them too, so old-vs-new is apples-to-apples).
- **Robustness:** all 698 sessions process without a thrown error (malformed entries, missing usage, forks, branch summaries, empty branches).

## 4. Gate 1 — pass criteria (explicit)

| #    | Criterion                                                                                                                                                | Config       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| G1.1 | Zero crashes across all 698 sessions                                                                                                                     | all          |
| G1.2 | **Zero** worker-safety violations (`chunkTokens ≤ cap` AND `chunkTokens + 8k ≤ workerWindow`)                                                            | all, incl. E |
| G1.3 | **Zero** observer runs that fail to advance `coversUpToId` (no livelock possible)                                                                        | all          |
| G1.4 | Compaction fires cluster: ≥ 90% of fires at 60–70% of window proxy (config A); where achieved context never reached the threshold, correctly zero fires  | A            |
| G1.5 | Cost proxy: observer+reflector runs vs old code — A within [0.5×, 1.5×], B ≤ A, C ≥ A; D matches the predicted ~1.3–1.7× (validating the migration note) | A–D          |
| G1.6 | Basis report shows usage-basis on the large majority of windows (expect >90%; archive has usage)                                                         | all          |
| G1.7 | Summary written to `work_docs/replay-gate1-results.md` with the full numbers                                                                             | all          |

**If a criterion fails:** §8 routing. A failing gate is a **stop**, not a discussion.

## 5. Gate 2 — live soak & breakpoint analysis

### 5.1 Setup

1. Install the branch build into the daily-driver pi (the author's normal install flow from `pi-blackhole-dev`).
2. Ensure `debugLog: true` (author already runs it).
3. **Breakpoint marker:** the breaking-notice state file (`~/.pi/agent/pi-blackhole/last-seen-version.json`) records the install version + write time — that timestamp IS the breakpoint. Additionally drop a one-line note into `work_docs/replay-gate2-notes.md`: date, branch SHA, config in use (author's explicit config, or config A/B/C).
4. Use normally for **a few days** (target: ≥ 3 days, ≥ 2 sessions that would previously have triggered auto-compaction, ≥ 1 session with a large tool result if it happens naturally — do **not** stage artificial workloads; the point is real usage).

### 5.2 Analysis (after the soak)

**`tests/replay-gate2.test.ts`** (same env-gated harness, `--post`-style mode) reading **only sessions started after the breakpoint** + the debug logs:

**From new session JSONLs (recompute everything with the shipped code):**

- For every `OM_OBSERVATIONS_RECORDED` marker: the measured progress at marker time justified the run (≥ resolved threshold or upper-bound) — no phantom runs, no starved stages.
- Coverage advances on every recorded run; no session with > 3 consecutive observer runs without a marker.
- For every compaction entry: last valid assistant usage before it ≈ resolved threshold at that moment (**±10%**), i.e. auto-compaction fired where the footer said it should.
- Uncovered backlog at session end < chunk cap or session still active.

**From debug logs (the new visibility events doing their job):**

- Any `observer.empty` streak ≥ 3 has an explaining event adjacent: `*.stream_error`, `observer.chunk_capped`, `*.context_window_exceeded`, or `observer.pending_skip` — **zero unexplained streaks**.
- Every `observer.chunk_capped` shows `truncatedSourceEntryIds` non-empty when an excerpt was sent; every chunk honors the cap.
- `observer.upper_bound` events present in any long session with auto thresholds (sanity that D7 engages).
- No `stream_error` loop: same error message > 10× consecutively for one stage.
- Cross-check `/blackhole-memory` displayed numbers vs harness-recomputed (display honesty): within 5% or explained by timing.

**Prediction reconciliation:** compare Gate-2's measured fire frequency (author's config) against Gate-1's config-D prediction; log the delta in `work_docs/replay-gate2-notes.md`.

## 6. Gate 2 — pass criteria (explicit)

| #    | Criterion                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------- |
| G2.1 | Zero unexplained `observer.empty` streaks (≥ 3) in debug logs                                                          |
| G2.2 | Zero coverage stalls: no session with > 3 consecutive observer runs without `coversUpToId` advancing                   |
| G2.3 | Every auto-compaction fired within ±10% of its resolved threshold (real usage at fire time)                            |
| G2.4 | Zero chunks exceeding cap; zero `context_window_exceeded` loops (a stage skipping the whole fallback chain repeatedly) |
| G2.5 | No `stream_error` loop (same error > 10× consecutive)                                                                  |
| G2.6 | Display numbers within 5% of recomputed                                                                                |
| G2.7 | Fire frequency vs Gate-1 prediction within ±30% (else understand why before release)                                   |
| G2.8 | `work_docs/replay-gate2-notes.md` completed: dates, SHA, config, all numbers, verdict                                  |

## 7. Steps

1. Implement `tests/replay-gate1.test.ts` (harness: reuse analyze-script infra; import real `src/` modules; synthetic markers; §3 metrics) → verify: `REPLAY=1 npx vitest run tests/replay-gate1.test.ts` completes on 20 most-recent sessions
2. Full-universe run (all 698) × configs A–E → verify: `tmp/replay-gate1-*.md` + tracked summary generated
3. Evaluate against §4 criteria → verify: each criterion checked off with its number in `work_docs/replay-gate1-results.md`
4. Fix-forward any failure (§8 routing) and re-run → verify: all criteria green on the final branch state
5. Merge prep (Phase 4 can land before or after Gate 1; Gate 1 must pass on the exact branch state that merges) → verify: branch SHA recorded
6. Install branch build; record breakpoint (§5.1) → verify: note in `work_docs/replay-gate2-notes.md`
7. Soak ≥ 3 days → verify: enough new sessions/debug data exist (§5.1 targets)
8. Implement + run `tests/replay-gate2.test.ts` → verify: report generated
9. Evaluate §6 criteria; complete the notes file with verdict → verify: all green
10. Only then: merge to `main`, publish, advance the breaking-notice constant per plan-03 → verify: release checklist in plan-03 §8 step 12

## 8. Failure routing

| Failing check                       | Route back to                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| G1.2 / G2.4 (worker safety, chunks) | Phase 2 (chunk integrity)                                                        |
| G1.3 / G2.2 (coverage stalls)       | Phase 2 (serializer/coverage) or Phase 3 (due computation)                       |
| G1.4 / G2.3 (compaction timing)     | Phase 3 (compaction numerator/threshold)                                         |
| G1.5 / G2.7 (cost/cadence)          | Phase 3 §7 (constants finalization) — re-derive, re-run                          |
| G2.1 (empty streaks)                | Phase 2 (stream errors) — or a real provider issue, surfaced correctly: document |
| G2.5 (error loops)                  | Phase 5 D-1 circuit-breaker decision gets pulled forward                         |
| G2.6 (display drift)                | Phase 4 (display)                                                                |

## 9. Limitations (recorded, accepted)

- Replay simulates stage **effects** with synthetic markers; it cannot simulate observation/reflection **content**, so reflector-input budgeting and dropper pool legs are token-leg-only in Gate 1. Gate 2 covers them with real content.
- Session window is a measured lower bound (achieved max usage), not the registry window → Gate 1 thresholds are conservative (fire earlier than production). `--window` override exists for exact runs.
- Manual mode / pending.json is out of replay scope (no pending state in old sessions to replay against); Gate 2 covers it only if the soak uses it (author runs auto — note if that changes).
- The harness assumes turn boundaries at assistant messages; mid-turn tool-result sequences merge into one evaluation point — matches the real `turn_end`/`agent_end` cadence closely enough for gate purposes.
