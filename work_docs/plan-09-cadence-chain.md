# Plan 09 — Cadence chain v2: deriving worker rhythm from the compaction point

**Status:** Proposed & fully specified — constants locked, acceptance criteria locked, **implementation pending**. Nothing in `src/` implements this yet.
**Date:** 2026-08-25
**Origin:** post-Gate-1 design review on `feat/token-rework` (head at time of writing: `922d117`, the experimental checkpoint containing the thresholdScale preset swap and Gate-1 criteria recalibration).
**Deliberation format:** three-way — the author plus two independent advisory analyses (referred to below as Analysis A and Analysis B), followed by a meta-review that caught an arithmetic mislabel. Every material claim used here was re-verified against the repository; where an advisor was wrong, this doc records the correction explicitly (§6).
**Related:** supersedes parts of plan-00 (§5 config table, §7 scenario-D text, decision D6/D14 framing); extends plan-03's threshold resolver; interacts with plan-08 D18 (peak floor) and D21 (preset swap). Governance constraints inherited from plan-00 L6/L138 and plan-05's recorded rejection of ratio-mode fields.

---

## 1. Background — the two pipelines, in plain language

pi-blackhole runs two independent pipelines over two kinds of context windows:

| | Session pipeline | OM memory pipeline |
|---|---|---|
| **Window** | The chat model's context window `W_eff` (resolved live: context usage → registry → 128k floor → raised by the measured-peak floor, plan-08 D18) | Each worker's *own* window (observer/reflector/dropper models, e.g. 128k) |
| **Question** | "How full may the conversation get?" | "How often do background workers snapshot memory — and how much can one call carry?" |
| **Trigger** | `compactAfterTokens` — deterministic compaction wipes old history | `observeAfterTokens` / `reflectAfterTokens` (+ pool legs for the dropper) |
| **Per-call budgets** | — | observer chunk ≤ 20% of worker window; reflector/dropper input ≤ 60%; D7 cap: trigger ≤ workerWindow − 8k − 4k |

Plain version: compaction protects the conversation from running out of room. OM thresholds decide how often workers come to collect memories. Both currently speak in fractions of the session window because that was the one ruler every archived measurement had.

## 2. The current shape on the branch (the thing being revised)

```ts
compact = compactAfterTokens > 0 ? value : floor(W_eff × 0.65 × thresholdScale)
observe = observeAfterTokens > 0 ? value : floor(W_eff × 0.25 × thresholdScale)
reflect = reflectAfterTokens > 0 ? value : floor(W_eff × 0.40 × thresholdScale)
// then, unchanged: D7 clamp min(threshold, workerWindow − 8k − 4k)
```

Three **siblings**, each an independent fraction of the same ruler, moved by one shared dial.

## 3. The problem (from the author's acceptance scenarios)

Two failures surfaced when the author tried to express *"compaction at 0.35×window, portably, with dense-enough observations"*:

1. **Coupling with no lever.** `thresholdScale` multiplies all three together. There is no way to say "wipe the board at 35%, but take photos twice as often as the default rhythm" — moving the wipe point drags the photo rhythm along mechanically, and vice versa. Compaction timing ("how full may Window #1 get?") and observation cadence ("how often do we save memories before detail dies?") are different questions sharing one multiplier.
2. **Absolute overrides are portable-hostile.** Setting `compactAfterTokens: 290000` pins compaction for one session model; switching 1M ↔ 256k silently mis-scales it — per-model retuning is exactly the disease this branch exists to cure.

### 3.1 The invariant that matters (the key insight)

Observations-per-compaction-interval is ratio geometry: `cycles = compactRatio / observeRatio`. Today that equals 0.65 / 0.25 = **2.6**, and it is *accidentally* window- and scale-invariant — but only on the auto path. Pin `compactAfterTokens` absolutely and cadence (still W-derived) loses all relationship to the segment being protected. The product needs that cycle count to be a structural property **regardless of where C comes from**.

Framing that makes it intuitive: the natural ruler for observation cadence isn't the window — it's **how much detail dies at the next compaction**. That defines how many snapshots are worth taking per era.

## 4. Chain v2 — the design

Make the dependency explicit. Resolve the compaction point first; derive worker cadence from it:

```ts
C       = compactAfterTokens > 0 ? value                      // explicit wins verbatim (D5)
        : floor(W_eff × 0.65 × thresholdScale)                // auto path (unchanged)

observe = observeAfterTokens > 0 ? value : floor(k_obs × C)   // k_obs = 0.25
reflect = reflectAfterTokens > 0 ? value : floor(k_ref × C)   // k_ref = 0.40
// clamps ≥ 1000 apply after derivation;
// then, unchanged: D7 clamp min(threshold, workerWindow − AGENT_LOOP_RESERVE − STAGE_OVERHEAD);
// dropper continues sharing the reflect threshold.
```

Exported constant names: `OBSERVE_OF_COMPACT_RATIO` / `REFLECT_OF_COMPACT_RATIO` (replacing `OBSERVE_THRESHOLD_RATIO` / `REFLECT_THRESHOLD_RATIO`; `COMPACT_THRESHOLD_RATIO = 0.65` stays).

### 4.1 Locked decisions

| Decision | Value | Rationale |
|---|---|---|
| Cadence constants | **k_obs = 0.25, k_ref = 0.40** → exactly **4 observation cycles** + ~2.5 reflection cycles per compaction era | Author's bands: 3–7 cycles (big scenario) and 1–4 (small). Exact-4 sits comfortably above the "at least 3" floor and at the top of the small band. Chosen with corrected cost math (see §6.3) after an initial pick was made under a mislabeled figure. |
| Default-density cost | **Accepted: +54%** default worker-call frequency (observe spacing 32_000 → 20_800 on a 128k-equivalent = 1.54×; reflect likewise) | More frequent, smaller worker calls; quantified by the Gate rerun; noted in CHANGELOG. The rejected cheaper alternative (k = 0.30/0.45 → +28%, ~3 cycles) left zero margin over the "at least 3" floor. |
| Scale inertness under explicit C | **Confirmed deliberate deviation** from plan-00 §7 scenario-D ("pin compact → scale applies only to the auto ones"). Pinning C makes `thresholdScale` fully inert everywhere. | One consistent rule — "scale tunes derivation; explicit values win verbatim" — versus double-application (cadence would derive from C then shrink again by scale). Must be loudly documented: mixed-custom users (explicit compact + auto workers) will see worker cadence move whenever they retune compaction. |
| Zero new config fields | Confirmed | plan-00 L6/L138 maintenance contract; plan-05's recorded rejection of ratio-mode fields. Future portable-density demand should extend as a C-relative override replacing the k constant — never as W-referenced sibling ratios. |
| Non-goal: pool budgets | `observationsPoolMaxTokens` et al. remain window-referenced | The pool spends main-context budget (it is re-rendered into Window #1), so it is capacity, not cadence. |

### 4.2 Properties

- **Invariant by construction:** cycles-per-era = 1/k_obs, independent of window size, `thresholdScale`, and of how C was set. Switching a 1M model for a 256k model changes absolute spacing, never the cycle count.
- **Zero new knobs.** `thresholdScale` remains the single posture dial: it scales C and cadence follows proportionally ("cost-saver stretches the whole chain"). Presets, modal contract, env map untouched.
- **Explicit-C feeds cadence too** — the surgical-compaction case stops stranding worker tuning. (This coupling is the feature; see §5 surprise list.)
- **Reverse escape preserved verbatim:** explicit `observeAfterTokens` / `reflectAfterTokens` override their legs completely. For lying-provider pinning, prefer `OmModelConfig.contextWindow` (pin the window; ratios follow it) over threshold pinning.
- **Phantom-C:** under `compaction: "off"` / `"manual"`, C still resolves (and displays) but never fires — cadence treats it purely as a proportionality yardstick. Document, or it gets filed as a bug.
- **Legacy hatch unaffected:** `PI_BLACKHOLE_LEGACY_ESTIMATE` forces estimate numerators only; derivation follows the chain regardless.
- **D7 clamp applies last:** small-worker safety unchanged (but see §4.3 drain regime).

### 4.3 The drain regime (why arithmetic alone can't validate this)

When the chunk budget is smaller than inter-fire growth (big session + small pinned workers), the observer drains greedily: actual worker LLM calls per era converge to **C ÷ chunk-cap** (e.g. 350k ÷ 25.6k ≈ 13–14 scoops), not 1/k_obs. Threshold arithmetic describes trigger *readiness*; the serializer decides *call count*. Acceptance testing must therefore count **real worker calls** on both a large-worker config and a small-pinned-worker config.

## 5. Acceptance scenarios & tests (pass/fail section)

Tolerance note: scale `0.538` puts compaction at 349.7k, not 351k — assert **≈350k ± tolerance**, never hard-coded round numbers.

| # | Setup | Expectation |
|---|---|---|
| S1 | 1M session model, auto thresholds, `thresholdScale: 0.538` (→ C ≈ 350k) | observe spacing ≈ 87.4k → **4 obs runs** inside the era (band 3–7 ✓); ~2.5 reflect |
| S2 | 256k session model, same config | C ≈ 90k, spacing ≈ 22.5k → **4 obs runs** (band 1–4 ✓) |
| Explicit-C anchoring | `compactAfterTokens: X` ⇒ observe/reflect derive from X; `thresholdScale` provably inert everywhere | unit-level |
| Override precedence | explicit `observeAfterTokens`/`reflectAfterTokens` win verbatim; scale affects nothing overridden | unit-level |
| Cycle invariance | identical cycle counts across W ∈ {256k, 1M} × scale ∈ {1.0, 0.538} | unit-level |
| Drain-aware counts | big session + 128k pinned workers (config-E shape): count ACTUAL worker LLM calls per era — converges to C/chunkCap, not 4 | replay/integration |
| Before/after evidence | harness config **F** (`thresholdScale: 0.538`) run once pre-change (records today's ~2.6-cycle baseline) and once post-change (shows 1/k_obs⁻¹ = 4) | replay |

## 6. Deliberation record (what we thought of, and what was wrong)

### 6.1 Journey

1. **Sibling design** (plan-00/03, landed on the branch) — calibrated against the pre-critique archive; worked until the author tried the 0.35×window-portable-with-dense-observations combination and found the two questions welded together.
2. **Author's acceptance scenarios** (S1/S2 above, with the 3–7 / 1–4 bands) — stated the requirement without prescribing mechanism; explicitly ruled out per-model absolute retuning.
3. **Two independent advisory analyses converged** on the same chain mechanics, name, and sequencing (land before Gate-2 soak), differing mainly in process depth:
   - Analysis A: strong acceptance table, drain-regime caveat, density quantification — but stale repo-state claims and a constants-attribution error ("author chose 0.25/0.40" — the author had not yet decided at that point).
   - Analysis B: deeper governance grounding (plan-00 L6/L138, plan-05 rejection record), the display-consistency catch (`memory.ts` renders resolved thresholds and must be swept), and the before/after F-row evidence structure.
4. **Meta-review** arbitrated: adopted B's outline as spec skeleton + A's acceptance table as pass/fail section, and struck A's "+30%" figure (below).

### 6.2 Corrections for the record (anti-hallucination receipts)

- **Cost mislabel (material):** A's "+~30% baseline worker runs" was paired with the k=0.25 numbers. Wrong: +28% belongs to k=0.30; **k=0.25 costs +54%** (32k → 20.8k spacing = 1.54×). The author's initial constant choice was made under the cheaper label and was **re-confirmed after the correction** — the decision stands on honest numbers.
- **Repo-state staleness:** A claimed uncommitted working-tree changes pending; the preset-swap/criteria checkpoint had already been committed (`922d117`). Lesson applied throughout: verify receipts against `HEAD`, not against another analysis's snapshot.
- **Hard-coded scenario number:** 351k is scale 0.54; scale 0.538 gives 349.7k. All assertions use tolerant ranges.
- **Display drift prevention:** resolved-threshold rendering in `/blackhole-memory` consumes the same resolver; the chain shifts those numbers denser — sweep required or it surfaces later as a "display disagrees with triggers" bug (the exact class plan-04 was written to kill).

### 6.3 Rejected alternatives (so they don't come back)

- **New ratio fields** (`compactRatio`, `observeRatio`, …) — recreates the twice-recorded anti-pattern (plan-00 L6/L138; plan-05 reviewed-and-rejected of upstream's `compactAfterTokensMode/Ratio`). The `0 = auto` sentinel exists precisely to avoid them.
- **Inverting the scale formula** (divide instead of multiply) — touches shipped code/docs/presets again, least intuitive for users reading raw numbers.
- **Keeping defaults unchanged** (chain available only via explicit overrides) — leaves default users holding the exact coupling flaw being fixed.
- **Worker-window-derived cadence** — breaks immediately when the session compacts far below the worker's capacity (a 1M worker never triggers inside a 256k era); cadence must track the protected segment, i.e. C.
- **Usage-shrinkage modeling in replay** (from the earlier Gate-1 discussion) — would test our assumptions, not shipped code; first-fire scoring chosen instead.

## 7. Implementation outline (when scheduled)

In order:

1. `src/om/due.ts`: chain inside `resolveTriggerThresholds` (resolve C first — explicit or `floor(W_eff × 0.65 × scale)` — then derive observe/reflect from C when their own fields are absent). Swap constant names per §4. Doc comments: chain semantics, explicit-C scale-inertness, phantom-C.
2. `tests/due.test.ts`: numeric expectation updates (128k defaults at scale 1.0: observe 32_000 → 20_800, reflect 51_200 → 33_280, and descendants); add chain tests for §5 rows: explicit-C anchoring, scale inertness, cycle invariance across windows/scales, clamps-after-derive, D7 interaction.
3. Display sweep: `/blackhole-memory` (`src/commands/memory.ts`) renders resolved values via the same resolver — verify output consistency; no separate logic expected.
4. Replay harness `tests/replay-gate1.test.ts`: add config F row; run once before landing (baseline evidence) and once after (chain evidence); expect worker legs denser across A/B/C/E/F, compaction leg untouched (C derivation identical), G-criteria slack absorbs the shift (G1.4 compaction-leg untouched; G1.5 bands have room; D untouched — fully explicit).
5. Docs sweep: CONFIG.md (derivation table rewritten as the chain; mixed-explicit warning + reverse escape; phantom-C note), llms.txt formulas, README table line, CHANGELOG derivation bullet + behavior-delta sentence (+54% default worker cadence; explicit-C now drives cadence; scale inert then), unified-config.ts field comments.
6. `work_docs/plan-08-live-validation.md`: D23 decision entry pointing here; update §3 addendum if needed.
7. Gates: `pnpm check && pnpm test` (expectation updates counted, none weakened) → replay green incl. F → `pnpm format:check`. Conventional commits, local only; push only after author review.
8. Land **before** the Gate-2 live soak so the soak validates the final shape. Post-landing reminders for the L-phase matrix: Cost-saver = scale 1.5, Responsive = 0.6 (post-swap mapping); scale-1.5 compaction sits at ~97.5% of window *by design* (documented cost-saver trade-off, not a bug).

## 8. Why this direction (framing for a future reader)

The branch's founding promise was "one ruler, everything derived" — and Gate 1 proved the derived machinery safe. But the first ruler choice conflated two questions that users tune separately: *when does the conversation get wiped?* and *how often is memory snapshotted before the wipe?* Anchoring cadence to the wipe point converts an accidental ratio into a structural guarantee — "four snapshots per era, whatever era means on your hardware" — while keeping every existing field, every verbatim guarantee (D5), the single posture dial, and the zero-new-fields maintenance contract. The cost is one honest behavior delta (+54% default worker cadence) and one documented rule change (explicit C silences the scale dial). Both were accepted consciously, on corrected arithmetic, with the cheaper alternative recorded alongside for future revisiting.
