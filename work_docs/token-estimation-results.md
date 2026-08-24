# Token estimation — calibration summary (review artifact)

- Generated: 2026-08-24T12:09:09.725Z
- Sessions: 1202 unique (realpath-deduped) under `~/.pi/agent/sessions`
- Command: `node scripts/analyze-token-estimation.mjs --summary work_docs/token-estimation-results.md`
- Full plan: `work_docs/issue-usage-based-token-counting.md`
- Raw per-window reports (gitignored, regenerate with the script): `tmp/token-estimation-report.md` (author config), `tmp/token-estimation-report-defaults.md` (code defaults)

Reading guide: **churn×** = how many more fires truthful counting produces with unchanged thresholds; **LATE** = windows where the trigger should have fired under truthful counting but didn't; **same-fire-count T'** = k-th largest actual usage with k = today's est fire count (reproduces today's frequency); **tool_result share** = share of the observer's serialized input that is tool-result text.

## Author's config (observe 25,000 / reflect+drop 80,000 / compact 185,000)

### Measurement decomposition (clean same-model same-segment spans)

| stage | clean pairs | density median | p25 | p75 | p90 | excluded |
|---|---|---|---|---|---|---|
| observer | 1184 | 2.14 | 1.33 | 17.04 | 47.63 | backtrack:30 crossModel:47 nonPositiveDelta:72 tinySpan:38 danglingAnchor:24 noBaseline:683 |
| reflector | 236 | 1.89 | 1.40 | 2.88 | 4.32 | backtrack:24 crossModel:23 nonPositiveDelta:55 tinySpan:16 danglingAnchor:15 noBaseline:558 |
| dropper | 48 | 2.55 | 1.92 | 3.71 | 4.85 | nonPositiveDelta:7 tinySpan:14 noBaseline:38 |
- compaction drift (absolute usage − est-since-anchor): median 88,408, p25 40,263, p75 142,431, p90 180,827


### Aggregate (clean windows, usage>0)

| stage | threshold | n (clean) | median | min | max | est fires | usage fires | churn× | LATE | EARLY | windows | no-usage |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| observer | 25,000 | 1184 | 0.47 | 0.00 | 5.29 | 653 | 1112 | 1.7 | 479 | 20 | 2078 | 774 |
| reflector | 80,000 | 236 | 0.53 | 0.06 | 48.27 | 41 | 162 | 4.0 | 127 | 6 | 927 | 633 |
| dropper | 80,000 | 48 | 0.39 | 0.18 | 12.03 | 0 | 39 | n/a | 39 | 0 | 107 | 45 |
| compaction | 185,000 | 0 | n/a | n/a | n/a | 2 | 167 | 83.5 | 167 | 2 | 1426 | 0 |

### Calibration (usage threshold that reproduces today's fire frequency)

| stage | threshold | same-fire-count T' | achieved | usage p50 | p90 | p95 | max |
|---|---|---|---|---|---|---|---|
| observer | 25,000 | 47,170 | 653 | 47,932 | 120,674 | 139,374 | 222,316 |
| reflector | 80,000 | 126,319 | 42 | 89,510 | 134,823 | 155,898 | 222,316 |
| dropper | 80,000 | n/a | n/a | 95,652 | 139,374 | 140,827 | 173,912 |
| compaction | 185,000 | 348,207 | 2 | 100,656 | 192,332 | 210,173 | 348,207 |

### Observer input simulation (tool-result + thinking trimming)

- windows with content: 1112
- median chunk: 37,783 tokens | tool_result share: 58% | thinking share: 21%
- trim policy: tool results > 4096 chars → head+tail 1000/1000 chars; thinking > 4096 chars → head+tail 20%/20% (fractional)
- median 37,783 → 17,806 tokens (combined median save 42%, p90 65%); of tool-result tokens median 60% saved; of thinking tokens median 21% saved


## Tier calibration (per achieved-context tier)

Tier = max context each session actually reached (max `usage.totalTokens`) — a measured lower bound on the model's window; usable on any user's machine. Compact anchor = 65% of the tier's p90 achieved context (README 60–70% rule). Worker thresholds read off the tier's usage distribution at target fire rates: **fire-20%** = only 20% of that tier's windows exceed it. Usage values are threshold-independent, so this section is identical for both config surfaces.

| tier | n | p50 ctx | p90 ctx | compact (65%) |
|---|---|---|---|---|
| low (<100k) | 733 | 52,272 | 88,079 | 57,251 |
| medium (100–200k) | 356 | 138,265 | 189,836 | 123,393 |
| high (200k+) | 90 | 223,560 | 264,057 | 171,637 |

| tier | stage | fire-20% | fire-40% | fire-60% |
|---|---|---|---|---|
| low (<100k) | observer | 48,021 | 39,518 | 34,464 |
| low (<100k) | compaction | 65,204 | 52,377 | 43,448 |
| medium (100–200k) | observer | 90,469 | 57,582 | 40,966 |
| medium (100–200k) | reflector | 115,515 | 92,513 | 75,684 |
| medium (100–200k) | dropper | 139,374 | 116,299 | 116,299 |
| medium (100–200k) | compaction | 147,894 | 119,678 | 90,464 |
| high (200k+) | observer | 84,120 | 56,331 | 41,592 |
| high (200k+) | reflector | 124,398 | 102,246 | 85,675 |
| high (200k+) | dropper | 95,652 | 72,165 | 51,389 |
| high (200k+) | compaction | 205,093 | 172,192 | 139,052 |

## Code defaults (observe 15,000 / reflect+drop 25,000 / compact 81,000 — auto-install surface)

### Measurement decomposition (clean same-model same-segment spans)

| stage | clean pairs | density median | p25 | p75 | p90 | excluded |
|---|---|---|---|---|---|---|
| observer | 1184 | 2.14 | 1.33 | 17.04 | 47.63 | backtrack:30 crossModel:47 nonPositiveDelta:72 tinySpan:38 danglingAnchor:24 noBaseline:683 |
| reflector | 236 | 1.89 | 1.40 | 2.88 | 4.32 | backtrack:24 crossModel:23 nonPositiveDelta:55 tinySpan:16 danglingAnchor:15 noBaseline:558 |
| dropper | 48 | 2.55 | 1.92 | 3.71 | 4.85 | nonPositiveDelta:7 tinySpan:14 noBaseline:38 |
- compaction drift (absolute usage − est-since-anchor): median 88,408, p25 40,263, p75 142,431, p90 180,827


### Aggregate (clean windows, usage>0)

| stage | threshold | n (clean) | median | min | max | est fires | usage fires | churn× | LATE | EARLY | windows | no-usage |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| observer | 15,000 | 1184 | 0.47 | 0.00 | 5.29 | 691 | 1195 | 1.7 | 504 | 0 | 2078 | 774 |
| reflector | 25,000 | 236 | 0.53 | 0.06 | 48.27 | 220 | 259 | 1.2 | 50 | 11 | 927 | 633 |
| dropper | 25,000 | 48 | 0.39 | 0.18 | 12.03 | 32 | 59 | 1.8 | 28 | 1 | 107 | 45 |
| compaction | 81,000 | 0 | n/a | n/a | n/a | 16 | 842 | 52.6 | 827 | 1 | 1426 | 0 |

### Calibration (usage threshold that reproduces today's fire frequency)

| stage | threshold | same-fire-count T' | achieved | usage p50 | p90 | p95 | max |
|---|---|---|---|---|---|---|---|
| observer | 15,000 | 45,341 | 691 | 47,932 | 120,674 | 139,374 | 222,316 |
| reflector | 25,000 | 54,528 | 222 | 89,510 | 134,823 | 155,898 | 222,316 |
| dropper | 25,000 | 95,652 | 32 | 95,652 | 139,374 | 140,827 | 173,912 |
| compaction | 81,000 | 246,729 | 16 | 100,656 | 192,332 | 210,173 | 348,207 |

### Observer input simulation (tool-result + thinking trimming)

- windows with content: 1112
- median chunk: 36,707 tokens | tool_result share: 56% | thinking share: 22%
- trim policy: tool results > 4096 chars → head+tail 1000/1000 chars; thinking > 4096 chars → head+tail 20%/20% (fractional)
- median 36,707 → 17,015 tokens (combined median save 40%, p90 65%); of tool-result tokens median 57% saved; of thinking tokens median 20% saved


_Generated by `scripts/analyze-token-estimation.mjs --summary`. Re-run any time to reproduce._
