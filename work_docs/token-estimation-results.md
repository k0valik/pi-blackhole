# Token estimation — calibration summary (review artifact)

- Generated: 2026-08-20T00:07:14.017Z
- Sessions: 1178 unique (realpath-deduped) under `~/.pi/agent/sessions`
- Command: `node scripts/analyze-token-estimation.mjs --summary work_docs/token-estimation-results.md`
- Full plan: `work_docs/issue-usage-based-token-counting.md`
- Raw per-window reports (gitignored, regenerate with the script): `tmp/token-estimation-report.md` (author config), `tmp/token-estimation-report-defaults.md` (code defaults)

Reading guide: **churn×** = how many more fires truthful counting produces with unchanged thresholds; **LATE** = windows where the trigger should have fired under truthful counting but didn't; **same-fire-count T'** = k-th largest actual usage with k = today's est fire count (reproduces today's frequency); **tool_result share** = share of the observer's serialized input that is tool-result text.

## Author's config (observe 25,000 / reflect+drop 80,000 / compact 185,000)

### Aggregate (ratios over marker-present, usage>0 windows)

| stage | threshold | n | median | min | max | est fires | usage fires | churn× | LATE | EARLY | marker | no-marker | no-usage |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| observer | 25,000 | 254 | 0.80 | 0.00 | 1487.68 | 692 | 805 | 1.2 | 135 | 22 | 297 | 881 | 26 |
| reflector | 80,000 | 184 | 0.83 | 0.00 | 1487.68 | 226 | 313 | 1.4 | 109 | 22 | 221 | 957 | 24 |
| dropper | 80,000 | 6 | 0.65 | 0.03 | 1.17 | 320 | 441 | 1.4 | 144 | 23 | 12 | 1166 | 6 |
| compaction | 185,000 | 385 | 0.63 | 0.00 | 3.17 | 18 | 36 | 2.0 | 26 | 8 | 389 | 789 | 5 |

### Calibration (usage threshold that reproduces today's fire frequency)

| stage | threshold | same-fire-count T' | achieved | usage p50 | p90 | p95 | max |
|---|---|---|---|---|---|---|---|
| observer | 25,000 | 35,022 | 692 | 46,809 | 119,243 | 143,773 | 297,071 |
| reflector | 80,000 | 92,825 | 226 | 51,677 | 120,476 | 143,905 | 297,071 |
| dropper | 80,000 | 95,905 | 320 | 64,906 | 139,324 | 163,641 | 297,071 |
| compaction | 185,000 | 214,990 | 18 | 65,325 | 140,049 | 163,641 | 297,071 |

### Observer input simulation (tool-result + thinking trimming)

- windows with content: 1151
- median chunk: 35,536 tokens | tool_result share: 57% | thinking share: 21%
- trim policy: tool results > 4096 chars → head+tail 1000/1000 chars; thinking > 4096 chars → head+tail 20%/20% (fractional)
- median 35,536 → 17,188 tokens (combined median save 41%, p90 65%); of tool-result tokens median 60% saved; of thinking tokens median 19% saved


## Tier calibration (per achieved-context tier)

Tier = max context each session actually reached (max `usage.totalTokens`) — a measured lower bound on the model's window; usable on any user's machine. Compact anchor = 65% of the tier's p90 achieved context (README 60–70% rule). Worker thresholds read off the tier's usage distribution at target fire rates: **fire-20%** = only 20% of that tier's windows exceed it. Usage values are threshold-independent, so this section is identical for both config surfaces.

| tier | n | p50 ctx | p90 ctx | compact (65%) |
|---|---|---|---|---|
| low (<100k) | 722 | 52,272 | 88,089 | 57,258 |
| medium (100–200k) | 343 | 137,742 | 187,637 | 121,964 |
| high (200k+) | 90 | 223,560 | 264,057 | 171,637 |

| tier | stage | fire-20% | fire-40% | fire-60% |
|---|---|---|---|---|
| low (<100k) | observer | 68,712 | 51,092 | 34,759 |
| low (<100k) | reflector | 72,956 | 54,869 | 38,939 |
| low (<100k) | dropper | 74,715 | 56,410 | 40,207 |
| low (<100k) | compaction | 74,715 | 56,410 | 40,207 |
| medium (100–200k) | observer | 126,431 | 104,163 | 49,425 |
| medium (100–200k) | reflector | 128,295 | 106,549 | 65,521 |
| medium (100–200k) | dropper | 143,589 | 120,831 | 106,675 |
| medium (100–200k) | compaction | 143,589 | 120,831 | 106,675 |
| high (200k+) | observer | 185,578 | 104,036 | 54,411 |
| high (200k+) | reflector | 185,578 | 104,036 | 53,557 |
| high (200k+) | dropper | 214,990 | 143,905 | 105,853 |
| high (200k+) | compaction | 212,987 | 143,905 | 105,853 |

## Code defaults (observe 15,000 / reflect+drop 25,000 / compact 81,000 — auto-install surface)

### Aggregate (ratios over marker-present, usage>0 windows)

| stage | threshold | n | median | min | max | est fires | usage fires | churn× | LATE | EARLY | marker | no-marker | no-usage |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| observer | 15,000 | 254 | 0.80 | 0.00 | 1487.68 | 827 | 904 | 1.1 | 106 | 29 | 297 | 881 | 26 |
| reflector | 25,000 | 184 | 0.83 | 0.00 | 1487.68 | 755 | 876 | 1.2 | 140 | 19 | 221 | 957 | 24 |
| dropper | 25,000 | 6 | 0.65 | 0.03 | 1.17 | 858 | 989 | 1.2 | 136 | 5 | 12 | 1166 | 6 |
| compaction | 81,000 | 385 | 0.63 | 0.00 | 3.17 | 296 | 435 | 1.5 | 159 | 20 | 389 | 789 | 5 |

### Calibration (usage threshold that reproduces today's fire frequency)

| stage | threshold | same-fire-count T' | achieved | usage p50 | p90 | p95 | max |
|---|---|---|---|---|---|---|---|
| observer | 15,000 | 23,133 | 827 | 46,809 | 119,243 | 143,773 | 297,071 |
| reflector | 25,000 | 35,022 | 755 | 51,677 | 120,476 | 143,905 | 297,071 |
| dropper | 25,000 | 37,606 | 858 | 64,906 | 139,324 | 163,641 | 297,071 |
| compaction | 81,000 | 100,282 | 296 | 65,325 | 140,049 | 163,641 | 297,071 |

### Observer input simulation (tool-result + thinking trimming)

- windows with content: 1151
- median chunk: 34,793 tokens | tool_result share: 54% | thinking share: 22%
- trim policy: tool results > 4096 chars → head+tail 1000/1000 chars; thinking > 4096 chars → head+tail 20%/20% (fractional)
- median 34,793 → 16,462 tokens (combined median save 39%, p90 64%); of tool-result tokens median 57% saved; of thinking tokens median 19% saved


_Generated by `scripts/analyze-token-estimation.mjs --summary`. Re-run any time to reproduce._
