# Gate 1 replay — results summary (review artifact)

- Generated: 2026-08-24T19:34:54.721Z
- Sessions: 1202 unique (realpath-deduped, mtime-sorted) under `~/.pi/agent/sessions`
- Command: `REPLAY=1 npx vitest run tests/replay-gate1.test.ts`
- Config passes: A, B, C, D, E, A-leg, B-leg, C-leg, D-leg, E-leg (each pass replays the full universe; runtime 49.0s)
- Full plan: `work_docs/plan-06-release-gates.md` §3–§4 · per-session rows: `tmp/replay-gate1-<config>.md` (gitignored)
- Scoring notes: compaction is first-fire-only per session/config (suppressed boundaries reported below — replayed post-fire entries carry un-shrunk historical usage, so re-fires would measure the harness artifact, not the code). Worker windows are pinned per config (128k; E=64k), not inherited from the per-session proxy.

## Per-config aggregates (all passes)

| config | obs fires | obs chunk tok (est) | ref fires | drop fires | skip(no obs data) | usage-basis | UB applied | capped runs | stalls | safety viol | cmp first-fires | cmp %win median | suppressed boundaries | no-fire (no-usage/never-crossed) | crashes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 1417 | 22,582,206 | 928 | 932 | 42 | 86.2% | 6056 | 513 | 0 | 0 | 1141 | 90.4% | 10635 | 24/37 | 0 |
| B | 2347 | 35,999,624 | 1509 | 1511 | 50 | 86.1% | 162 | 797 | 0 | 0 | 1166 | 72.5% | 12793 | 24/12 | 0 |
| C | 925 | 14,448,909 | 644 | 647 | 16 | 85.0% | 18856 | 312 | 0 | 0 | 8 | 100.1% | 1 | 24/1170 | 0 |
| D | 2332 | 41,715,968 | 236 | 241 | 10 | 85.2% | 0 | 875 | 0 | 0 | 102 | 92.7% | 3149 | 24/1076 | 0 |
| E | 1709 | 18,025,086 | 1221 | 1224 | 42 | 86.3% | 29872 | 1236 | 0 | 0 | 1141 | 90.4% | 10635 | 24/37 | 0 |
| A-leg (legacy) | 3211 | 68,949,832 | 1745 | 1843 | 110 | 0.0% | 6056 | 2311 | 0 | 0 | 145 | 89.7% | 1395 | 24/1033 | 0 |
| B-leg (legacy) | 3993 | 77,010,880 | 2630 | 2661 | 128 | 0.0% | 162 | 2344 | 0 | 0 | 1064 | 61.6% | 11933 | 24/114 | 0 |
| C-leg (legacy) | 2367 | 52,916,659 | 867 | 1070 | 90 | 0.0% | 18856 | 1842 | 0 | 0 | 2 | 151.6% | 0 | 24/1176 | 0 |
| D-leg (legacy) | 3982 | 82,388,793 | 1138 | 1277 | 18 | 0.0% | 0 | 2220 | 0 | 0 | 44 | 85.4% | 1080 | 24/1134 | 0 |
| E-leg (legacy) | 5436 | 64,951,851 | 2431 | 2443 | 146 | 0.0% | 29864 | 5063 | 0 | 0 | 145 | 89.7% | 1395 | 24/1033 | 0 |

## Compaction first-fire distribution (% of windowProxy)

- config A: n=1141 | <55%: 0 | 55–60%: 0 | **60–70%: 211** | 70–75%: 129 | >75%: 801 | median 90.4% | p90 100.0%
- config B: n=1166 | median 72.5% | p10 42.5% | p90 100.0%
- config C: n=8 | median 100.1% | p10 99.2% | p90 740.6%
- config D: n=102 | median 92.7% | p10 79.6% | p90 100.0%
- config E: n=1141 | median 90.4% | p10 67.3% | p90 100.0%

## Findings behind the ✗ verdicts (context for §8 routing)

First-fire pct by session length (agent-run counts; short <5 / medium 5–14 / long ≥15):
- Short sessions: 592 fired | in 60–70% band: 22 (3.7%) | at ≥95% of proxy: 456 (77.0%)
- Medium sessions: 290 fired | in 60–70% band: 69 (23.8%) | at ≥95% of proxy: 46 (15.9%)
- Long sessions: 259 fired | in 60–70% band: 120 (46.3%) | at ≥95% of proxy: 13 (5.0%)
- G1.4: the D18 snap mechanism was verified directly (per-boundary traces): first fires land exactly at `floor(0.65·⌈p/0.65⌉) = p` crossings. The band miss is dominated by session-length composition — short sessions (first evaluation already past 65% of their own proxy) structurally fire at ≈100%; long sessions cluster near the crossing. plan-06's ≥90%-in-band assumption predates D18 and presumes sessions long enough to contain an intermediate crossing.
- Fires above 100% of proxy (config C p90 = 740%) occur when the latest valid usage predates large recent content: realContextTokens adds the chars/4 estimate of everything after that usage point, which can exceed the historical usage max. C's near-zero compaction fire count (1170 never-crossed) is scale-1.5 arithmetic: the auto compact threshold sits at ~97.5% of proxy while disengaged and rises further once the floor engages.
- G1.5 B/C: measured directions are B > A and C < A — consistent with thresholdScale mechanics (scale 0.6 lowers auto thresholds → more, smaller runs; scale 1.5 raises them → fewer runs). plan-06's `B ≤ A, C ≥ A` inequalities read inverted relative to that physics; run counts alone also ignore per-run chunk size (see obs chunk tok column).
- G1.5 A/A-leg + D/D-leg: shipped usage-basis counting fires ~0.5× relative to the legacy-estimate twin over identical spans (2324 vs 4901; 2563 vs 5111 obs+ref runs). The legacy twin accumulates across runs (estimate basis skips the not_due cursor advance), while usage basis re-rules every run-end evaluation. This contradicts the churn-derived prediction that truthful counting fires MORE (~1.3–1.7×); it supports the suspicion that archive est-vs-usage density divergence was overstated.
- G1.6: estimate-basis measurements come from sessions without valid usage, spans after invalid latest assistants (stream errors/provider gaps → realTokensSinceAnchor undefined), cold-start prefixes before first usage, and post-compaction segments until a cursor refresh lands on surviving entries.

## Pass criteria (plan-06 §4)

| # | Criterion | Numbers | Verdict |
|---|---|---|---|
| G1.1 | Zero crashes across all sessions | 0 crashes / 1202 files × 10 passes | ✓ |
| G1.2 | Zero worker-safety violations (chunk ≤ cap AND +8k ≤ workerWindow) | 0 across all passes incl. E | ✓ |
| G1.3 | Zero observer runs failing to advance coversUpToId | 0 stalls / 27719 observer runs | ✓ |
| G1.4 | ≥90% of config-A first-fires within 60–70% of windowProxy; zero-fires correct; suppressed counts reported | 211/1141 in band (18.5%), no-fire: 24 no-usage + 37 never-crossed, suppressed boundaries 10635 | ✗ |
| G1.5 | Cost proxy: A within [0.5×,1.5×] of old code, B ≤ A, C ≥ A, D ≈ predicted 1.3–1.7× | A/A-leg 0.47 (obs+ref runs 2324 vs 4901), B 3831, C 1561, D/D-leg 0.50 (2563 vs 5111) | ✗ |
| G1.6 | Usage-basis share >90% of measurements | 85.8% of 229,725 (shipped-code passes; legacy twins excluded by design) | ✗ |
| G1.7 | Summary written to work_docs/replay-gate1-results.md | this file | ✓ |

**FAILED CRITERIA** (plan-06 §8 routing — stop, do not patch product code to pass):

- G1.4 FAILED: config A band share 18.5% over 1141 fires (<90%) or no fires at all
- G1.5 FAILED: A/A-leg cost ratio 0.47418894103244236 outside [0.5, 1.5]
- G1.5 FAILED: B runs 3831 > A runs 2324
- G1.5 FAILED: C runs 1561 < A runs 2324
- G1.5 FAILED: D/D-leg shift 0.5014674232048523 outside predicted [1.3, 1.7]
- G1.6 FAILED: usage-basis share 85.8% ≤ 90% over 229725 measurements

_Limitations (plan-06 §9): manual mode/pending out of scope; reflector input budgeting + dropper pool legs token-leg-only; windowProxy is a measured lower bound with accepted lookahead; compaction scored first-fire-only; G1.6 excludes legacy twins (estimate basis forced by design)._
