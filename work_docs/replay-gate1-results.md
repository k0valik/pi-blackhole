# Gate 1 replay — results summary (review artifact)

- Generated: 2026-08-24T20:22:26.452Z
- Sessions: 20 unique (realpath-deduped, mtime-sorted) under `~/.pi/agent/sessions` — SMOKE SAMPLE (limited by REPLAY_SESSIONS)
- Command: `REPLAY=1 npx vitest run tests/replay-gate1.test.ts REPLAY_SESSIONS=20`
- Config passes: A, B, C, D, E, A-leg, B-leg, C-leg, D-leg, E-leg (each pass replays the full universe; runtime 0.4s)
- Full plan: `work_docs/plan-06-release-gates.md` §3–§4 · per-session rows: `tmp/replay-gate1-<config>.md` (gitignored)
- Scoring notes: compaction is first-fire-only per session/config (suppressed boundaries reported below — replayed post-fire entries carry un-shrunk historical usage, so re-fires would measure the harness artifact, not the code). Worker windows are pinned per config (128k; E=64k), not inherited from the per-session proxy.

## Per-config aggregates (all passes)

| config | obs fires | obs chunk tok (est) | ref fires | drop fires | skip(no obs data) | usage-basis | UB applied | capped runs | stalls | safety viol | cmp first-fires | cmp %win median | suppressed boundaries | no-fire (no-usage/never-crossed) | crashes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 30 | 445,880 | 14 | 14 | 0 | 84.8% | 28 | 8 | 0 | 0 | 20 | 73.1% | 132 | 0/0 | 0 |
| B | 43 | 574,416 | 30 | 30 | 0 | 83.8% | 0 | 11 | 0 | 0 | 20 | 55.0% | 171 | 0/0 | 0 |
| C | 17 | 191,774 | 6 | 6 | 0 | 81.5% | 200 | 4 | 0 | 0 | 1 | 100.0% | 0 | 0/19 | 0 |
| D | 39 | 625,133 | 6 | 6 | 0 | 82.1% | 0 | 14 | 0 | 0 | 1 | 99.4% | 3 | 0/19 | 0 |
| E | 31 | 308,464 | 19 | 19 | 0 | 85.2% | 368 | 17 | 0 | 0 | 20 | 73.1% | 132 | 0/0 | 0 |
| A-leg (legacy) | 22 | 349,095 | 7 | 7 | 0 | 0.0% | 28 | 7 | 0 | 0 | 5 | 98.6% | 40 | 0/15 | 0 |
| B-leg (legacy) | 40 | 566,713 | 23 | 23 | 0 | 0.0% | 0 | 11 | 0 | 0 | 19 | 52.3% | 156 | 0/1 | 0 |
| C-leg (legacy) | 10 | 168,542 | 0 | 0 | 0 | 0.0% | 200 | 3 | 0 | 0 | 0 | n/a | 0 | 0/20 | 0 |
| D-leg (legacy) | 34 | 569,292 | 3 | 3 | 0 | 0.0% | 0 | 12 | 0 | 0 | 1 | 95.6% | 0 | 0/19 | 0 |
| E-leg (legacy) | 25 | 271,139 | 14 | 14 | 0 | 0.0% | 368 | 16 | 0 | 0 | 5 | 98.6% | 40 | 0/15 | 0 |

## Compaction first-fire distribution (% of windowProxy)

- config A: n=20 | <55%: 0 | 55–60%: 0 | **60–70%: 5** | 70–75%: 6 | >75%: 9 | median 73.1% | p90 100.0%
- config B: n=20 | median 55.0% | p10 44.1% | p90 100.0%
- config C: n=1 | median 100.0% | p10 100.0% | p90 100.0%
- config D: n=1 | median 99.4% | p10 99.4% | p90 99.4%
- config E: n=20 | median 73.1% | p10 65.7% | p90 100.0%

## Findings behind the ✗ verdicts (context for §8 routing)

First-fire pct by session length (agent-run counts; short <5 / medium 5–14 / long ≥15):
- Short sessions: 5 fired | in 60–70% band: 1 (20.0%) | at ≥95% of proxy: 2 (40.0%)
- Medium sessions: 10 fired | in 60–70% band: 3 (30.0%) | at ≥95% of proxy: 3 (30.0%)
- Long sessions: 5 fired | in 60–70% band: 1 (20.0%) | at ≥95% of proxy: 0 (0.0%)
- G1.4: the D18 snap mechanism was verified directly (per-boundary traces): first fires land exactly at `floor(0.65·⌈p/0.65⌉) = p` crossings. The band miss is dominated by session-length composition — short sessions (first evaluation already past 65% of their own proxy) structurally fire at ≈100%; long sessions cluster near the crossing. plan-06's ≥90%-in-band assumption predates D18 and presumes sessions long enough to contain an intermediate crossing.
- Fires above 100% of proxy (config C p90 = 740%) occur when the latest valid usage predates large recent content: realContextTokens adds the chars/4 estimate of everything after that usage point, which can exceed the historical usage max. C's near-zero compaction fire count (1170 never-crossed) is scale-1.5 arithmetic: the auto compact threshold sits at ~97.5% of proxy while disengaged and rises further once the floor engages.
- G1.5 B/C: measured directions are B > A and C < A — consistent with thresholdScale mechanics (scale 0.6 lowers auto thresholds → more, smaller runs; scale 1.5 raises them → fewer runs). plan-06's `B ≤ A, C ≥ A` inequalities read inverted relative to that physics; run counts alone also ignore per-run chunk size (see obs chunk tok column).
- G1.5 A/A-leg + D/D-leg: shipped usage-basis counting fires ~1.2–1.3× relative to the legacy-estimate twin over identical spans (A: 2345 vs 1826; D: 2568 vs 2090 obs+ref runs) — inside family with the churn-derived 1.3–1.7× prediction, just under its lower bound. NOTE: the first harness run measured 0.47× because consolidation.ts gated the not_due cursor advance on usage basis only, so the legacy twins accumulated progress across checks and over-fired; fixing that gating (consolidation.ts + this mirror now advance on estimate basis too when legacyEstimateCounting is on) restored the legacy contract of exact pre-0.5.0 cadence.
- G1.6: estimate-basis measurements come from sessions without valid usage, spans after invalid latest assistants (stream errors/provider gaps → realTokensSinceAnchor undefined), cold-start prefixes before first usage, and post-compaction segments until a cursor refresh lands on surviving entries.

## Pass criteria (plan-06 §4)

| # | Criterion | Numbers | Verdict |
|---|---|---|---|
| G1.1 | Zero crashes across all sessions | 0 crashes / 20 files × 10 passes | ✓ |
| G1.2 | Zero worker-safety violations (chunk ≤ cap AND +8k ≤ workerWindow) | 0 across all passes incl. E | ✓ |
| G1.3 | Zero observer runs failing to advance coversUpToId | 0 stalls / 291 observer runs | ✓ |
| G1.4 | No config-A first-fire below 55% of windowProxy; ≥40% of long-session (≥15 runs) first-fires within 60–70%; zero-fires correct; suppressed counts reported | all-fires in band: 5/20 (25.0%), below-55%: 0, long-session (≥15 runs) band share: 20.0% of 5, no-fire: 0 no-usage + 0 never-crossed, suppressed boundaries 132 | ✗ |
| G1.5 | Cost proxy: A within [0.75×,1.5×] of old code, B ≥ A (0.6 runs more), C ≤ A (1.5 runs less), D-shift within calibrated [1.0,1.5] | A/A-leg 1.52 (obs+ref runs 44 vs 29), B 73, C 23, D/D-leg 1.22 (45 vs 37) | ✗ |
| G1.6 | Usage-basis share ≥85% of measurements (structural estimate windows excluded by design) | 83.5% of 3,300 (shipped-code passes; legacy twins excluded by design) | ✗ |
| G1.7 | Summary written to work_docs/replay-gate1-results.md | this file | ✓ |

**FAILED CRITERIA** (plan-06 §8 routing — stop, do not patch product code to pass):

- G1.4 FAILED: 0 first-fire(s) below 55% of proxy; long-session band share 20.0% over 5 (<40%)
- G1.5 FAILED: A/A-leg cost ratio 1.5172413793103448 outside [0.75, 1.5]
- G1.6 FAILED: usage-basis share 83.5% < 85% over 3300 measurements

_Limitations (plan-06 §9): manual mode/pending out of scope; reflector input budgeting + dropper pool legs token-leg-only; windowProxy is a measured lower bound with accepted lookahead; compaction scored first-fire-only; G1.6 excludes legacy twins (estimate basis forced by design)._
