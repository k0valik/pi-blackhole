# Recall usage findings

**Status:** research note / baseline, not a product specification. No runtime changes accompany this document.

**Date:** 2026-11-26

**Baseline:** `dev` at `523bb24` (pre-change)

**Companion:** [Recall surface design proposals](recall-design-proposals.md)

**Tool:** [`scripts/recall-usage-report.py`](../scripts/recall-usage-report.py)

**Verification:** the totals in this note come from a full run of the report script on 2026-11-26 against the session corpus described below (`tmp/recall-usage/summary.json`; `tmp/` is gitignored).

## TL;DR

- **84 of 1,228 sessions (6.8%) ever call `recall`.** There are 503 calls in total, and 84% of them are free-text search.
- **`#N` is not how models enter the transcript.** Zero sessions start with a typed `#N` reference; 72 start with a text search. `#N` and hex ids are second-step drills after search.
- **Once a model starts, it digs.** Median 3 calls per recall session, mean 6, max 38. 27 sessions have 5+ calls and 18 have 10+. 372 of 503 calls are follow-ups within 10 assistant turns of a previous call; 43 sessions have at least two clustered follow-ups.
- **Observation/reflection ids are almost unused.** 7 hex-id calls in 5 sessions (1.4% of calls), all resolved. 8,474 unique memory ids were rendered in compaction summaries; 7 were ever queried (0.08%). 120 of 125 sessions with rendered ids never queried one.
- **Models already try `#N` plus a query.** 28 of 503 calls pass `#N <search terms>` in `query`; the tool treats the whole string as literal text search. All 28 are in one long `pi-websearch` session. 13 more calls use a pure `#N`, and 4 use `#N:text`/`#N:...`.
- **Most observations are anchored to one entry.** 6,499 of 10,861 (59.8%) have exactly one `#N`-mappable source; 4,329 (39.9%) span multiple, with median span 5 and p90 32. Reflections span wider (median 16, p90 97), so ranges are more useful for observations than reflections.
- **The bottleneck looks like the search→drill transition, not the length of the id.** Models already use search; the missing primitive is “open a window around this hit” and “open the memory this summary line points at.” The id format alone does not explain why 96% of sessions with rendered ids never query one.

## What was measured

All session JSONL files under the pi agent sessions root, read-only:

| Population                                            |   Count |
| ----------------------------------------------------- | ------: |
| Files discovered (excluding `.trash/`)                |   1,410 |
| Files included                                        |   1,228 |
| Files excluded by default (`pi-blackhole-dev`)        |     182 |
| Sessions with at least one compaction                 |     361 |
| Sessions with at least one OM compaction              |     162 |
| Sessions with at least one `recall`/`vcc_recall` call |      84 |
| Total recall calls                                    |     503 |
| Assistant messages in included sessions               | 138,305 |
| Assistant messages after the first OM compaction      |  41,243 |

`recall` (296 calls) and the legacy `vcc_recall` (207 calls) are counted together. Query shapes, expansion, timing, compaction visibility, and OM source spans are derived from the same files.

## Identity spaces

These are different namespaces. Treating them as interchangeable is the source of most of the design confusion.

| Identifier       | Meaning                                                                                                                                                                                                              | Where it lives                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `#134`           | Index among `type:"message"` entries in session-file order. Counts across compaction windows and abandoned branches. Tool results are messages and are counted; custom entries and `branch_summary` entries are not. | `src/core/global-indices.ts`, `src/core/load-messages.ts` |
| `[a1b2c3d4e5f6]` | Content-hash id of one observation or reflection record. Primary key for dedup, tombstones, `supportingObservationIds`, dropper ids, and `recall <id>`.                                                              | `src/om/ids.ts`, `src/om/ledger/types.ts`                 |
| `coversUpToId`   | Batch watermark: the last source entry the observer was shown. Shared by every observation in that recording batch. Never rendered.                                                                                  | `om.observations.recorded` marker                         |
| `sourceEntryIds` | The specific session entries cited for one observation. Zero or more; can include `branch_summary` / `custom_message`, which have no `#N`.                                                                           | Observation record                                        |
| `m12` (proposed) | Compaction-scoped display alias for a rendered observation/reflection. Presentation only; the stored hash id remains the identity.                                                                                   | Not implemented                                           |

`#N` is a transcript address. The 12-hex id is a derived-record primary key. An observation is a row in a derived table with a many-to-many join to transcript entries; a reflection is a row keyed by observation ids and has no direct transcript address at all.

## Usage

### Calls by query shape

| Shape                                  | Calls | Share |
| -------------------------------------- | ----: | ----: |
| Free-text / regex search               |   423 | 84.1% |
| Expand-only (`expand` array, no query) |    40 |  8.0% |
| Pure `#N` entry                        |    13 |  2.6% |
| `touched` view                         |    12 |  2.4% |
| 12-hex memory id                       |     7 |  1.4% |
| `#N:...` drill                         |     4 |  0.8% |
| Mode-only                              |     1 |  0.2% |
| 16-hex / other hex                     |     2 |  0.4% |
| None                                   |     1 |  0.2% |

### Sessions by first call kind

| First call       | Sessions |
| ---------------- | -------: |
| Text search      |       72 |
| `touched`        |        8 |
| 12-hex memory id |        1 |
| 16-hex           |        1 |
| Expand-only      |        1 |
| None             |        1 |
| **Typed `#N`**   |    **0** |

Sessions that contain at least one call of each kind (not mutually exclusive): text 76, expand-only 18, touched 10, `#N` entry 5, hex 5, `#N:...` drill 3.

### Timing

| Timing                         |       Calls |
| ------------------------------ | ----------: |
| Before the first OM compaction | 346 (68.8%) |
| After the first OM compaction  | 157 (31.2%) |

Rate: 3.64 recall calls per 1,000 assistant messages overall; 3.81 per 1,000 after the first OM compaction. There is no meaningful increase in recall usage once observational memory is in play.

### Tangents

When a model uses `recall`, it usually uses it repeatedly in the same session:

| Metric                                                |           Value |
| ----------------------------------------------------- | --------------: |
| Sessions with recall                                  |              84 |
| One-call sessions                                     |              27 |
| Sessions with 5+ calls                                |              27 |
| Sessions with 10+ calls                               |              18 |
| Median / mean / max calls per recall session          |   3 / 5.99 / 38 |
| Calls from the top 5 sessions                         | 161 / 503 (32%) |
| Sessions with ≥2 follow-ups within 10 assistant turns |              43 |
| Follow-up calls within 10 assistant turns             | 372 / 503 (74%) |

The tangent pattern is real. The problem is that the first move is almost always a text search, not a reference.

## Memory-id usage

| Metric                                                              |                         Value |
| ------------------------------------------------------------------- | ----------------------------: |
| Sessions with a 12-hex call                                         |                             5 |
| 12-hex calls                                                        |                             7 |
| Record kind                                                         | 7 observations, 0 reflections |
| Resolved by `recall`                                                |                         7 / 7 |
| Visible in a prior compaction summary                               |                         6 / 7 |
| Not visible in a prior compaction                                   |                         1 / 7 |
| OM sessions with any hex recall                                     |                5 / 162 (3.1%) |
| OM sessions with any recall after OM                                |              23 / 162 (14.2%) |
| Unique memory ids rendered in compaction summaries (session-scoped) |                         8,474 |
| Unique rendered ids ever queried                                    |                     7 (0.08%) |
| Sessions with rendered ids                                          |                           125 |
| …that ever queried one                                              |                      5 (4.0%) |
| …that never queried one                                             |                   120 (96.0%) |

Distribution of the 7 hex calls: 5 in `/mnt/e/pi-mono` (extension development, May 2026), 1 in `ik_llama.cpp`, 1 in `~/.pi/agent`. The bulk is development/debugging, not ordinary application work. When the model did use an id, the id was usually one it had just seen in a summary, and the lookup succeeded. The failure mode is not “the id does not resolve”; it is “the model does not reach for it.”

There was also one 13-hex query (`3fbfd746cec82`) that returned no match, and one 16-hex query that was treated as text. Models do fumble id shape when they try to reproduce an id from a summary.

## How models actually reference history

`#N` is used as a **second-step drill**, not an entry point:

- `ik_llama.cpp`: ~20 text searches → `#5` → more text → 13-hex (fails) → 12-hex (succeeds) → text → `#735` → `#733` → `expand [733]`.
- `pi-mono`: text → `#55` → `#46` → `#55` → `#54` → three hex recalls.

The strongest tool-surface signal is the mixed query shape:

| Reference shape                           | Calls |
| ----------------------------------------- | ----: |
| `#N <search terms>` in one `query` string |    28 |
| Pure `#N`                                 |    13 |
| `#N:...` drill                            |     4 |
| 12-hex in free text                       |     2 |
| Fully consecutive `expand` array          |     3 |

All 28 `#N <terms>` calls are in one long `pi-websearch` session. The model writes something like `#195 <terms...>`; the tool runs a BM25 search for the literal string and does **not** open entry #195. The model is already asking for “open this entry and search around/within it.” The tool cannot express that request. That is a semantic mismatch, not just mental load.

Other schema friction observed:

| Unexpected value                        | Calls |
| --------------------------------------- | ----: |
| `mode: "transcript"`                    |     2 |
| `mode: "all"`                           |     1 |
| `scope: "\"all\""` (literal quotes)     |    29 |
| `scope: "\"lineage\""` (literal quotes) |     3 |
| `scope: "file"`                         |     1 |

`expand` is also a separate expansion channel (96 calls with an `expand` array; 62 of them length 1), overlapping with `#N` expansion. The surface asks the model to choose among `query`, `expand`, `mode`, `scope`, and drill suffixes, and the model often chooses a shape the parser does not support.

## Source spans

For every recorded observation and reflection, the cited source entry ids were mapped into `#N` space. “Span” is `max(#N) - min(#N)` over the distinct mapped sources; it is a bounding range, not a claim that every entry in between is relevant.

|                                   |  Observations |   Reflections |
| --------------------------------- | ------------: | ------------: |
| Total records analysed            |        10,861 |         2,224 |
| No `#N`-mappable source           |     33 (0.3%) |      9 (0.4%) |
| Exactly one source entry          | 6,499 (59.8%) |   920 (41.4%) |
| Multiple source entries           | 4,329 (39.9%) | 1,295 (58.2%) |
| Multi-source span median          |             5 |            16 |
| Multi-source span p75 / p90 / p99 | 14 / 32 / 113 | 44 / 97 / 238 |
| Multi-source span max             |           235 |           346 |

Bucket distribution for multi-source records:

| Span bucket       | Observations | Reflections |
| ----------------- | -----------: | ----------: |
| 1 (single source) |        6,499 |         920 |
| 2                 |          851 |         140 |
| 3–5               |        1,379 |         208 |
| 6–20              |        1,328 |         378 |
| 21–100            |          710 |         448 |
| >100              |           61 |         121 |
| No mapped source  |           33 |           9 |

Implications:

- A single `#N` anchor is enough for 60% of observations.
- 82% of multi-source observations have a span of 20 or less; a range with a cap around 20 covers most of the useful cases.
- Reflections often span a large window (44% span more than 20; 121 span more than 100). A range is a coarse browsing hint for reflections, not an exact provenance range.

## Caveats

- **File order, not active-branch order.** The scan follows JSONL append order and counts all branches. A compaction or call on an abandoned branch is still counted. The active-branch view may be smaller.
- **Mixed tool generations.** `vcc_recall` is the legacy tool; `recall` is the unified one. Some sessions predate the unified surface, so query-shape distribution is partly a function of the installed version.
- **`#N` is message-only.** Custom entries, `branch_summary`, and `custom_message` have no `#N`. Observations citing those sources have no `#N`-mappable span.
- **Source spans are first-valid and file-order.** Records are deduped by id; the message index is the file-order message index, not necessarily the active lineage. Forks and branch navigation can change what a given `#N` resolves to.
- **`error-ish` is a heuristic.** The non-hex result classification counts any result text containing “error” as `error-ish`; many are content excerpts, not tool failures. The `empty` count (102) is more reliable.
- **The 28 mixed queries are one session.** They demonstrate intent, not population-wide frequency.
- **No causal claim.** Low observation-id usage does not prove the model “does not understand the link.” It may not need the fact, may prefer search, or may not have a reason to reopen history. The tangent data shows that when the model does need to dig, it digs; it just starts from search.
- **Sessions span months and multiple models.** The data is observational, not a controlled experiment.

## Reproduce

```bash
# Default: ~/.pi/agent/sessions (or $PI_CODING_AGENT_DIR/sessions)
python3 scripts/recall-usage-report.py

# Include raw call rows and truncated query examples (contains session excerpts — private)
python3 scripts/recall-usage-report.py --dump-calls --examples 8

# Add exclusions or point at another sessions root
python3 scripts/recall-usage-report.py \
  --sessions-root ~/.pi/agent/sessions \
  --exclude my-project \
  --out-dir /tmp/recall-report
```

Default output: `tmp/recall-usage/report.txt` and `tmp/recall-usage/summary.json` (the repo ignores `tmp/`). `calls.jsonl` is written only with `--dump-calls`.

The default exclusion is the substring `pi-blackhole-dev` (matched against both the file path and the session header `cwd`). Use `--no-default-exclude` to include it, or repeat `--exclude` for more projects.

## Related

- [Recall surface design proposals](recall-design-proposals.md)
- [Observational memory](../docs/observational-memory.md)
- [Recall tool](../docs/recall.md)
- [Session forensics skill](../.pi/skills/session-forensics/SKILL.md)
