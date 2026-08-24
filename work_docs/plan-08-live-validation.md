# Plan 08 — Token-rework decision record & live validation protocol

**Date:** 2026-08-24
**Status:** Decisions landed on `feat/token-rework` (post dev-sync merge `a3346df`, compat/inference commit `7615f62`). Protocol below is **not yet executed** — it is the script for the driven real-life test of the branch build.
**Master doc:** `plan-00-overview.md`. This doc records every in-flight design deliberation that postdates plan-00..06 and defines how we validate them on real hardware before release.

---

## 1. Decision log (this iteration)

### D15 — Backwards compatibility for explicitly-configured users: clean break + escape hatch (A+C)

The question: pre-0.5.0 users who explicitly set thresholds (`observeAfterTokens: 25000` etc.) — preserve their behavior exactly, or ship the counting-basis fix with a migration path?

- **Chosen:** explicit values are honored verbatim as absolute real-token triggers (**A**, plan-00 D5 unchanged), plus an **opt-in legacy escape hatch**: `PI_BLACKHOLE_LEGACY_ESTIMATE=1` forces trigger numerators back to chars/4 so pinned setups keep their exact old cadence until they migrate (**C**).
- **Rejected:** full legacy-basis preservation (B) — dual counting paths kept alive indefinitely, preserving the never-fires defect the rework exists to fix (archive: author-config compaction fired 16× est vs 842× usage-equivalent windows).
- **Form:** env-only, deliberately NOT a config field (plan-00's "no field proliferation" contract holds; `thresholdScale` remains the only new permanent knob). Removal tracked in plan-05 D-6 (~1–2 minors after 0.5.0).
- Surface: `/blackhole-memory` prints a legacy-mode tag; breaking notice mentions the hatch.

### D16 — External proposal (compactAfterRatio / compactReserveTokens): substance already shipped, fields rejected

The proposal asked for auto-derivation from the active model's context window (`compactAfterRatio: 0.65`, or reserve-based `window − reserveTokens`), precedence `explicit > ratio > default`, recalculation on model change, fallback when unknown.

Mapping onto what landed:

| Proposal | feat/token-rework |
|---|---|
| derive from contextWindow | `effectiveSessionWindow` → live getContextUsage → registry → measured-peak floor (D18) |
| `compactAfterRatio: 0.65` | `compactAfterTokens: 0` = auto = 0.65 × window |
| explicit > derived > default | explicit `> 0` honored verbatim > auto × `thresholdScale` |
| recalculating on model change | per-measurement resolution; peak floor scoped to tail assistant model |
| unknown window → 81000 | 128k floor → 83.2k, raised automatically by observed usage |

New ratio/reserve *fields* stay rejected (plan-05): same outcome without knobs. Suggested reply: point at 0.5.0's derivation table + `thresholdScale`; reserve-shaping is a possible future knob if a user case appears.

### D17 — Calibration rework: flat multipliers are dead; presets are fire-rate profiles only

The analyzer was rewritten (`scripts/analyze-token-estimation.mjs` on top of the new `scripts/om-session-parser.mjs` core): event-based windows (every compaction/marker = one row), branch-aware ancestor-path replay (`/tree` backtracks, append-chain JSONL bulk and fallback-chain model churn can no longer pollute measurements), reason-coded exclusion of degenerate pairs.

Results over the author archive (1202 sessions; **one heavy user's baseline — directional, not universal**, see D19):

- Coverage-stage density (usageΔ/estΔ on clean same-model spans): observer median **2.14**, reflector **1.89**, dropper **2.55** — but p25–p90 spans 1.33→47.6. Chars/4 can under- or over-count by multiples depending on provider/content.
- Compaction drift (absolute usage − est-since-anchor): median **+88k**, p90 +181k — dominated by scope overhead (system prompt + tool schemas + injected summaries) the est counter structurally never sees.
- Consequences shipped:
  - The flat "~1.45×" migration claim is retired everywhere (notice text, docs).
  - Plan-04 §2.3's optional "recalibrated absolute preset blocks" must **not** be shipped as conversion constants — presets are posture profiles (`thresholdScale`) on the usage scale, nothing else.

### D18 — Peak-inferred session window floor

Registry/context-usage windows can be missing or wrong (local llama.cpp models especially). New `effectiveSessionWindow(dueCtx, entries)`: if the branch shows the current model already served a prompt larger than the resolved window, raise the window to `ceil(peak / 0.65)` so derived thresholds stay at-or-above observed reality — a 1M-window model with no registry entry must not compact at ~83k. Capped at `MAX_INFERRED_SESSION_WINDOW` (2M).

Verified pi semantics (source, `agent-session.js setModel`): **the switch applies immediately** (`agent.state.model = model`) **while any in-flight agent loop keeps its current stream** — cycling models mid-generation neither breaks the loop nor redirects the in-flight request. Therefore peaks are scoped to the **branch-tail assistant message's model**: inference follows a switch from the first post-switch completed turn, with no dependence on run boundaries. `/blackhole-memory` renders against the same effective window so display can never disagree with firing.

### D19 — Archive evidence caveats

All numbers above come from one author's history (heavily tool-using, code-heavy content, several providers incl. free-tier fallback chains). They are baselines for sanity and edge-case catching — not representative of the install base. The live protocol below (different providers, controlled windows, driven scenarios) is the actual gate.

### D20 — Sync decisions (dev → feat/token-rework merge)

dev's interim usage-counter port (`cebd27a`, tavasti@360f24a lineage) is fully subsumed by plan-01/03's measurement core; `rawTokensSinceLastCompaction` stays pure-estimate (D4 naming contract) with usage layered at call sites. dev's independent PR#58/#59 machinery (append-mode segments, mid-run exponential backoff, adapter-unavailable classification) was unioned into the branch's trigger/hook files. Conflicts resolved: tokens.ts/tests took branch supersets; compaction-trigger/before-compact were semantic unions; CHANGELOG/CONFIG folded additively.

---

## 2. Live validation protocol ("Gate 2b" — driven, on-branch build)

**Environment:** pi installed from the `feat/token-rework` runtime clone (`~/.pi/agent/git/github.com/k0valik/pi-blackhole/` synced to this branch, `/reload` after each change); `debugLog: true` throughout. Every phase ends with artifact analysis before moving on — this is driven testing with validation in between, not a soak.

**Artifacts per scenario:** session JSONL (branch-aware replay via `node scripts/om-session-parser.mjs <file> [--json]`), `~/.pi/agent/pi-blackhole/debug.ndjson`, `/blackhole-memory` output screenshot/notes.

### L1 — Local llama.cpp (qwen3.6-35b-a3b-ud), config matrix

Iterations, one session each (or `/resume` where noted):

| # | Config under test | Expectation |
|---|---|---|
| L1.1 | all-auto defaults, memory ON, midRunCompaction resume | fires cluster near 0.65 × llama.cpp-reported window (or inferred floor if registry missing); `compaction_trigger.tokens` ≈ last assistant usage ±small delta |
| L1.2 | same + `thresholdScale: 0.6` then `1.5` | fire points scale proportionally; nothing else moves |
| L1.3 | `PI_BLACKHOLE_LEGACY_ESTIMATE=1` + old explicit values (75k/185k-style) | cadence matches pre-0.5.0 behavior; `/blackhole-memory` shows the legacy tag; basis all estimate |
| L1.4 | hatch OFF again, same explicit values | values honored verbatim but counted in real tokens — earlier fires than L1.3, exactly the documented shift |
| L1.5 | memory OFF run | workers silent, compaction still truthful |

Pass checks (each iteration):

- [ ] `compaction_trigger.threshold_reached` tokens within ±5% of the last valid assistant usage in the JSONL
- [ ] No fire below `0.55 × effective window` unless manually invoked
- [ ] `/blackhole-memory` progress lines match recomputed reality (±5%)
- [ ] Append-chain floors behave: segment N+1 floor ≥ segment N floor (segments accumulate by design)

### L2 — Mid model (256k window)

- Derivation scales: compact auto = 166k; observe = 64k; verify from `/blackhole-memory` resolved-threshold lines, then force one fire each.
- Explicit override interplay: set `compactAfterTokens: 120_000` → fires there, not at 166k (precedence check).

### L3 — Large model (1M window) — the headline scenario

- [ ] Zero compaction attempts anywhere near ~100k (the old-registry failure mode D18 fixes); first auto-compaction candidates only appear past ~600k or when the peak floor says otherwise
- [ ] With 128k-class worker models configured: observer upper-bound events (`observer.upper_bound`) engage before backlog overflow; chunks ≤ 0.20 × worker window; coverage advances every run (backlog drains across runs, nothing silently dropped)
- [ ] `session_window.inferred` debug event appears if the 1M model's registry entry is absent/wrong

### L4 — Manual + mid-run + switches (driven edge cases)

- [ ] `/blackhole` explicit compaction mid-append-chain: chain folds/rebases cleanly, next auto cycle measures from the rebuilt context (no immediate refire)
- [ ] Model switch 1M → llama.cpp mid-session (mid-run switch fine per D18): thresholds drop to the small window within one completed turn of the switch; no runaway firing from stale large-model peaks (tail-model scoping)
- [ ] Reverse switch llama.cpp → 1M: thresholds recover upward via registry or peak floor
- [ ] ctrl+p model cycling during generation (×15 rapid): loop intact, next turn-end measurement uses the settled model
- [ ] Provider without usage reporting (if available): everything falls back to estimate basis with `~` markers; no cursor starvation (fallback-safety rule)

### Post-phase harness checks (any phase)

```bash
node scripts/om-session-parser.mjs <session.jsonl> --json   # anchors resolved? ghost-entry count?
node scripts/analyze-token-estimation.mjs <N>               # drift/density sane for these sessions?
rg '"event":"session_window.inferred"' ~/.pi/agent/pi-blackhole/debug.ndjson
```

Failure routing: fire-point mismatch → due.ts/threshold resolution · chunk overflow → plan-02 serializer · anchor dangling/stalls → ledger coverage · anything else → record in `work_docs/replay-gate2-notes.md` alongside Gate 2 soak results.

---

## 3. Out of scope here

Recall-tool rework (plan-07) lands on its own branch above this one. Gate 1 replay harness (plan-06 §3) remains scheduled separately — `tests/vcc-support/real-sessions.ts` sampling and the parser core are its building blocks.
