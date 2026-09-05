# Token estimation — calibration summary (review artifact)

- Generated: 2026-08-01T03:35:02.960Z
- Sessions: 698 unique (realpath-deduped) under `~/.pi/agent/sessions`
- Command: `node scripts/analyze-token-estimation.mjs --summary work_docs/token-estimation-results.md`
- Full plan: `work_docs/issue-usage-based-token-counting.md`
- Raw per-window reports (gitignored, regenerate with the script): `tmp/token-estimation-report.md` (author config), `tmp/token-estimation-report-defaults.md` (code defaults)

Reading guide: **churn×** = how many more fires truthful counting produces with unchanged thresholds; **LATE** = windows where the trigger should have fired under truthful counting but didn't; **same-fire-count T'** = k-th largest actual usage with k = today's est fire count (reproduces today's frequency); **tool_result share** = share of the observer's serialized input that is tool-result text.

## Author's config (observe 25,000 / reflect+drop 80,000 / compact 185,000)

### Aggregate (ratios over marker-present, usage>0 windows)

| stage      | threshold | n   | median | min  | max   | est fires | usage fires | churn× | LATE | EARLY | marker | no-marker | no-usage |
| ---------- | --------- | --- | ------ | ---- | ----- | --------- | ----------- | ------ | ---- | ----- | ------ | --------- | -------- |
| observer   | 25,000    | 243 | 0.80   | 0.00 | 23.59 | 297       | 377         | 1.3    | 98   | 18    | 280    | 418       | 23       |
| reflector  | 80,000    | 176 | 0.83   | 0.00 | 23.59 | 98        | 164         | 1.7    | 77   | 11    | 207    | 491       | 21       |
| dropper    | 80,000    | 5   | 0.61   | 0.03 | 1.17  | 192       | 286         | 1.5    | 109  | 15    | 11     | 687       | 6        |
| compaction | 185,000   | 339 | 0.61   | 0.00 | 3.17  | 3         | 23          | 7.7    | 21   | 1     | 343    | 355       | 5        |

### Calibration (usage threshold that reproduces today's fire frequency)

| stage      | threshold | same-fire-count T' | achieved | usage p50 | p90     | p95     | max     |
| ---------- | --------- | ------------------ | -------- | --------- | ------- | ------- | ------- |
| observer   | 25,000    | 36,303             | 298      | 31,775    | 110,826 | 129,975 | 238,483 |
| reflector  | 80,000    | 99,327             | 98       | 40,621    | 114,395 | 131,394 | 238,483 |
| dropper    | 80,000    | 103,162            | 192      | 66,956    | 142,940 | 165,993 | 274,486 |
| compaction | 185,000   | 262,007            | 3        | 67,020    | 143,523 | 169,043 | 274,486 |

### Observer input simulation (tool-result + thinking trimming)

- windows with content: 674
- median chunk: 19,282 tokens | tool_result share: 51% | thinking share: 22%
- trim policy: tool results > 4096 chars → head+tail 1000/1000 chars; thinking > 4096 chars → head+tail 20%/20% (fractional)
- median 19,282 → 12,220 tokens (combined median save 31%, p90 61%); of tool-result tokens median 51% saved; of thinking tokens median 1% saved

## Tier calibration (per achieved-context tier)

Tier = max context each session actually reached (max `usage.totalTokens`) — a measured lower bound on the model's window; usable on any user's machine. Compact anchor = 65% of the tier's p90 achieved context (README 60–70% rule). Worker thresholds read off the tier's usage distribution at target fire rates: **fire-20%** = only 20% of that tier's windows exceed it. Usage values are threshold-independent, so this section is identical for both config surfaces.

| tier              | n   | p50 ctx | p90 ctx | compact (65%) |
| ----------------- | --- | ------- | ------- | ------------- |
| low (<100k)       | 358 | 49,703  | 91,918  | 59,747        |
| medium (100–200k) | 246 | 137,233 | 187,347 | 121,776       |
| high (200k+)      | 71  | 222,459 | 273,451 | 177,743       |

| tier              | stage      | fire-20% | fire-40% | fire-60% |
| ----------------- | ---------- | -------- | -------- | -------- |
| low (<100k)       | observer   | 56,438   | 36,396   | 22,069   |
| low (<100k)       | reflector  | 72,331   | 48,253   | 31,094   |
| low (<100k)       | dropper    | 75,841   | 51,674   | 33,069   |
| low (<100k)       | compaction | 75,841   | 51,674   | 33,069   |
| medium (100–200k) | observer   | 114,104  | 67,922   | 28,542   |
| medium (100–200k) | reflector  | 119,605  | 82,400   | 38,990   |
| medium (100–200k) | dropper    | 141,269  | 120,476  | 104,168  |
| medium (100–200k) | compaction | 141,466  | 120,476  | 104,800  |
| high (200k+)      | observer   | 120,504  | 89,876   | 30,397   |
| high (200k+)      | reflector  | 119,963  | 85,511   | 31,973   |
| high (200k+)      | dropper    | 203,424  | 128,551  | 95,141   |
| high (200k+)      | compaction | 201,339  | 128,551  | 96,444   |

## Code defaults (observe 15,000 / reflect+drop 25,000 / compact 81,000 — auto-install surface)

### Aggregate (ratios over marker-present, usage>0 windows)

| stage      | threshold | n   | median | min  | max   | est fires | usage fires | churn× | LATE | EARLY | marker | no-marker | no-usage |
| ---------- | --------- | --- | ------ | ---- | ----- | --------- | ----------- | ------ | ---- | ----- | ------ | --------- | -------- |
| observer   | 15,000    | 243 | 0.80   | 0.00 | 23.59 | 388       | 451         | 1.2    | 88   | 25    | 280    | 418       | 23       |
| reflector  | 25,000    | 176 | 0.83   | 0.00 | 23.59 | 359       | 447         | 1.2    | 103  | 15    | 207    | 491       | 21       |
| dropper    | 25,000    | 5   | 0.61   | 0.03 | 1.17  | 460       | 552         | 1.2    | 96   | 4     | 11     | 687       | 6        |
| compaction | 81,000    | 339 | 0.61   | 0.00 | 3.17  | 173       | 282         | 1.6    | 121  | 12    | 343    | 355       | 5        |

### Calibration (usage threshold that reproduces today's fire frequency)

| stage      | threshold | same-fire-count T' | achieved | usage p50 | p90     | p95     | max     |
| ---------- | --------- | ------------------ | -------- | --------- | ------- | ------- | ------- |
| observer   | 15,000    | 23,581             | 388      | 31,775    | 110,826 | 129,975 | 238,483 |
| reflector  | 25,000    | 36,303             | 359      | 40,621    | 114,395 | 131,394 | 238,483 |
| dropper    | 25,000    | 40,069             | 460      | 66,956    | 142,940 | 165,993 | 274,486 |
| compaction | 81,000    | 108,206            | 173      | 67,020    | 143,523 | 169,043 | 274,486 |

### Observer input simulation (tool-result + thinking trimming)

- windows with content: 674
- median chunk: 19,282 tokens | tool_result share: 49% | thinking share: 22%
- trim policy: tool results > 4096 chars → head+tail 1000/1000 chars; thinking > 4096 chars → head+tail 20%/20% (fractional)
- median 19,282 → 11,992 tokens (combined median save 30%, p90 61%); of tool-result tokens median 49% saved; of thinking tokens median 1% saved

_Generated by `scripts/analyze-token-estimation.mjs --summary`. Re-run any time to reproduce._
