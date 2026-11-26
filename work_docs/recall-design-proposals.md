# Recall surface design proposals

**Status:** open design discussion / proposal, not an approved implementation specification. No runtime changes accompany this document.

**Date:** 2026-11-26

**Baseline:** `dev` at `523bb24` (pre-change)

**Companion:** [Recall usage findings](recall-usage-findings.md)

**Related:** [Recall tool](../docs/recall.md), [Observational memory](../docs/observational-memory.md), [Session forensics skill](../.pi/skills/session-forensics/SKILL.md)

## 1. Constraints and intent

The maintainer’s constraints for this work:

- **Clean cut.** Do not add a backward-compatibility layer, deprecated aliases, or dual code paths. Do not hide the new behavior behind an opt-in flag.
- **Keep the engine close to upstream.** The ledger, hash ids, dedup, tombstones, coverage, reflector/dropper contracts, and compaction projection stay as they are unless a change is required. Change the _rendering_ and the _tool surface_.
- **Old sessions must still work.** “No compatibility layer” does not mean old session records stop resolving. The engine reads the same stored records; old summaries contain 12-hex ids, and the 12-hex id remains the ledger’s native key. New summaries can render a different presentation. This is engine-native behavior, not a maintained legacy syntax.
- **Prototype on our code.** Others use the extension, but breaking changes are acceptable if they make the surface substantially better. Move fast; there is no clean A/B measurement. The usage data is accumulated observational evidence, not a controlled trial.
- **Improve the recall loop.** The maintainer is not currently using the extension much. The goal is a recall surface that is useful enough to change that: fewer hex ids to mistype, a familiar transcript reference, and ranges that let the model browse.

The intended mental model is a **browser for compacted history**:

- search finds a scent;
- a reference opens the exact turn, memory, or a window around it;
- the model can continue digging without translating between two id languages.

## 2. What the findings imply

The data in [recall-usage-findings.md](recall-usage-findings.md) says:

1. **Search is the entry point.** 72 of 84 recall sessions start with text; zero start with a typed `#N`; two start with a hex-shaped query (one 12-hex, one 16-hex). `#N`/hex are second-step drills.
2. **Tangents are real.** Median 3 calls, max 38, 372/503 follow-ups within 10 turns. Once the model has a scent, it keeps digging.
3. **The summary’s memory ids are not adopted.** 7 hex calls in 5 sessions; 7 of 8,474 rendered ids queried; 120 of 125 sessions with rendered ids never query one.
4. **Models already write `#N <terms>`.** 28 calls in one session use a leading `#N` followed by search terms. The tool treats the whole string as a literal text query.
5. **Most observations are single-source.** 60% map to one entry; 40% span multiple, mostly ≤20 entries. Reflections span wider (median 16, p90 97).
6. **The tool surface leaks.** `mode: "transcript"`, `mode: "all"`, quoted scopes, `expand` as a parallel channel. The model does not have a stable grammar to reason about.

The design consequence: do not build the primary UX around the model reading a summary and deciding to look up a 12-hex id. Build it around **search → open → browse**, and make the summary a set of _actionable anchors_ rather than a list of opaque keys.

### The existing bridge

The current implementation already cross-links in both directions:

- `recall <hex>` resolves the memory record and annotates its source entries with `#N` indices.
- `recall #N` and search results append related observations/reflections found through `sourceEntryIds`.

The bridge is mechanically sound. The failure is discoverability and grammar: the summary does not make the bracketed hex look like a link, and the common `#N <terms>` form is not parsed as a reference plus a query. The new design keeps the bridge and makes the entry point explicit; it does not replace the cross-link with a new mechanism.

## 3. Non-goals

- Changing stored hash ids, dedup, tombstones, observation/reflection coverage, or the reflector/dropper contracts.
- Replacing `#N` in the stored transcript index or renumbering old session files.
- Preserving `expand`, `mode`, or the current overloaded `query` grammar.
- A feature flag to switch between old and new surfaces.
- An exact replacement for the ledger’s primary key with a positional reference.
- A full transcript browser UI in the TUI; this is the agent-facing tool surface.

## 4. Reference model

One reference grammar, used by both the summary renderer and the recall tool:

| Reference                          | Meaning                                                           |
| ---------------------------------- | ----------------------------------------------------------------- |
| `#134`                             | One transcript message entry (the existing `#N` index).           |
| `#134-147`                         | A contiguous transcript slice, inclusive.                         |
| `#134:text`                        | The message body of entry #134.                                   |
| `#134:path`                        | File content referenced by entry #134.                            |
| `#134:path:full` / `:offset:limit` | Existing drill-down variants.                                     |
| `m12`                              | A compaction-scoped memory alias for one observation/reflection.  |
| `a1b2c3d4e5f6`                     | The native ledger id; still accepted, still the exact record key. |
| `#b3` (optional)                   | A named branch summary; separate namespace, low priority.         |

`coversUpToId` is never a reference. It is a batch watermark, not a location.

### Alias versus hex

The alias is a presentation optimization, not a new identity:

- `MemoryDetails` already stores the rendered observations/reflections in order. The alias can be derived from that order (`m1`, `m2`, …) or persisted as a map. No ledger change is needed.
- `stripOMContent` removes the previous summary’s OM block before the next compile, so under the normal path the live summary only contains the latest generation’s aliases. Old summaries are not a source of live aliases.
- Append/chain mode can retain older summary text. If that path is supported, prefix aliases with a generation (`c3:m12`) or keep the hex id in the rendered line.
- The alias is compaction-scoped; `recall m12` resolves against the latest compaction details. If the model uses an old alias from a chained summary, the resolver should fail clearly and suggest the current summary or a range.
- The 12-hex id remains accepted everywhere the ledger needs exact identity (dedup, tombstones, reflector/dropper, old summaries). That is not a compatibility layer; it is the engine’s native key.

## 5. Proposed tool surface

The current surface overloads `query` with search text, `#N`, `#N:path`, `#N:text`, and hex ids; adds a separate `expand` array; has `mode` (`hybrid|file|touched`) and `scope` (`lineage|all`); and paginates with `page`. The model has to infer which combination is legal.

Proposed clean surface:

```ts
recall({
  query?: string,                 // free-text / regex search only
  refs?: string[],                // "#134", "#134-147", "#134:text",
                                  // "#134:path:full", "m12", "a1b2c3d4e5f6"
  context?: number,               // neighbor entries around single refs
  fields?: "all" | "file" | "touched",  // search fields/view; replaces mode
  scope?: "lineage" | "all",
  page?: number,
})
```

Semantics:

- **`query` only searches.** No reference parsing inside `query` in the strict form. If the parser is forgiving (recommended; see §6), a leading `#N`/`#N-M`/`#N:...` splits into `refs` plus the remainder as `query`.
- **`refs` only opens.** Each ref resolves to a transcript entry, a range, a drill-down, or a memory record. `refs` and `query` can be combined: open the refs, then search within the referenced slice(s). This expresses the observed `#N <terms>` intent.
- **`context`** adds `k` entries before and after a single `#N` ref. `context: 1` covers a tool call plus its result, which are adjacent `#N` entries. Default 0; the model opts in.
- **`fields`** replaces `mode`: `all` (default) searches text, tool args, and tool results; `file` searches file write/edit content; `touched` is the aggregate touched-file view. The naming is discussed below.
- **`scope`** stays `lineage|all`.
- **`page`** paginates search or a large range.
- **No `expand`.** The array is folded into `refs`. No deprecated alias.
- **No `mode`.** No aliases for old values.

Examples:

```jsonc
// Search
{"query": "ctx-checkpoints"}

// Open exact transcript entries
{"refs": ["#735", "#733"]}

// Browse a slice
{"refs": ["#1200-1240"]}

// Open a hit with its neighbors (tool call + result)
{"refs": ["#134"], "context": 1}

// Open a memory record and search inside its source range
{"refs": ["m12"], "query": "draft-max"}

// Open #195 and search inside that entry
{"refs": ["#195"], "query": "both cloned learned"}
```

Tool description (short form):

> Search session history, or open references into it. `query` searches text/regex. `refs` opens transcript entries (`#134`, `#134-147`, `#134:text`, `#134:path:full`) or memory aliases/ids (`m12`, 12-hex). `context` adds neighbors; `fields` selects search fields; `scope` selects lineage/all; `page` paginates.

This removes the “which parameter do I use for this id?” decision. The model either searches or opens.

### `fields` naming

`mode` is a bad name because it is not a mode of recall; it selects which index to search. Options:

- `fields: "all" | "file" | "touched"` — one parameter, but `touched` is a view, not a field.
- `searchIn: "all" | "file"` plus `view: "touched"` — clearer, two parameters.
- Keep `touched` as a separate command/tool; it is a report, not a search result. It has only 12 calls in the baseline.
- `source: "all" | "file" | "touched"` — short and accurate enough.

Recommendation: `fields: "all" | "file"`, and move `touched` to a separate `touched` view or a flag `touched: true`. If keeping one parameter, `source` is better than `mode`. This is an open decision, not a blocker.

## 6. Parser stance: strict or forgiving?

The clean cut says `query` is search-only. But the model already writes `#195 <terms>` (28 calls in one session). Two options:

**A. Strict.** `query` is always search text. A leading `#N` is an error with a hint: “Use refs for #N; query is search-only.” This is the purest surface, but it breaks the model’s natural behavior and produces a failed call before the model learns.

**B. Forgiving (recommended).** If `query` starts with a well-formed ref, split it: `#195 <terms>` becomes `refs: ["#195"]` + `query: "<terms>"`. This is not a compatibility layer; it is the documented grammar. The model’s existing language is accepted, and the intent is made explicit. The strict description still says “use refs,” but the parser does not punish the common form.

If B is chosen, define it precisely:

- `#N` followed by whitespace and text → ref + query.
- `#N` alone → ref, no query.
- `#N-M` followed by text → range + query.
- A hex id inside a longer query is **not** split; `observation a1b2...` remains a text search. Only a leading, well-formed ref is special.
- Invalid ref-like prefixes (`#-1`, 13-hex) return a clear error and a valid-forms hint; do not silently search.

## 7. Rendering memory references

Current observation line:

```
[a1b2c3d4e5f6] 2026-11-20 [high] content...
```

Proposed:

```
[m12 @ #134-147] 2026-11-20 [high] content...
```

or, if the native key is preferred:

```
[a1b2c3d4e5f6 @ #134-147] 2026-11-20 [high] content...
```

Rationale:

- The alias/hex is the exact record key; `recall m12` returns the record, its sources, and the source `#N` annotations.
- The range is the browser handle; `recall #134-147` opens the slice. It is a hint, not a provenance claim.
- The arrow makes the link explicit; the current bracketed hex does not.

Rules:

- **Range = min/max of the mapped `sourceEntryIds` in `#N` space.** Not `coversUpToId`; not the marker position.
- **Single mapped source** → render `@ #134`, not `#134-134`.
- **No mapped source** (anchored only to `branch_summary`/`custom_message`, or unanchored) → omit `@ ...`.
- **Span too large** → either omit the range or render an open anchor (`@ #134+`). Suggested cap: 20 for observations (82% of multi-source observations are ≤20), 40 for a wider net. For reflections, 44% exceed 20 and 121 exceed 100; ranges are usually a coarse anchor, not a precise one. Consider omitting ranges for reflections and keeping only the alias, or anchoring to the newest supporting observation.
- **Reflections**: exact support is `supportingObservationIds`; a range is transitive through observations. If rendered, label it as a browsing hint, not a provenance range.
- **Branch summaries**: optional `#b3` namespace; they are not `type:"message"` and have no `#N`. Low priority.
- **Observations with multiple disjoint sources**: a range over-approximates. That is acceptable for browsing; the alias remains exact.

The range is a rendering addition, not a replacement for the stored key. If aliases are later removed, the hex + range line still works.

## 8. Range and context semantics

Why ranges:

- The model often needs the **neighborhood** of a hit, not one entry. Tool calls and results are adjacent `#N` entries; the observed sequences `#305` → `#305:text` and `#735` → `#733` show the model assembling context one call at a time.
- A range lets it fetch the slice in one call and spend its budget on reading, not on repeated expansion.

Proposed:

- `refs: ["#134-147"]` returns the contiguous transcript slice, oldest first, with the same per-entry rendering/budget as `expand`. Include a header that states the range and any truncation/continuation.
- `context: k` on a single `#N` returns `#N-k .. #N+k`, clipped at the beginning/end. The model can use `context: 1` for a tool pair.
- `refs` + `query`: restrict the search to the referenced slice. If multiple refs, search the union of their slices. This is the explicit form of `#195 <terms>`.
- **Pagination is scope-relative.** If `refs` are present, `page` pages the referenced slice/search, not the global result set. A page footer must not invite the model to leave the referenced scope. If a scoped search has no matches, return a clear “no matches within #195” and optionally suggest a global search, rather than silently searching globally. The observed #195 sequence is exactly this trap: page 1 hit #195 by content, page 2 was a global result starting at #238.
- Range rendering must respect `scope: "lineage"`; `#N` is file-order and can include abandoned branches. A range in `scope: "lineage"` should skip entries outside the active lineage, or clearly state that it is file-order. This needs a decision; the current `#N` expand path already has lineage filtering in some cases.
- Budget: reuse `capRecallBlocks`; ranges can be large. Page them or return the first N entries with a continuation.
- Suffixes: keep `#N:text` and `#N:path` for single entries. Do not invent `#N-M:text` in v1; the model can open the range, then drill the exact entry.

## 9. Summary footer and prompt framing

The current footer says:

> Bracketed ids in reflections and observations connect to their source session entries. … Use `recall` with an id to retrieve original context, or `#N:path` drill-down…

It describes the mechanism but not the _action_. If the summary renders `[m12 @ #134-147]`, the footer should say:

> The bracketed memory ref is a link into the conversation that was removed. If a fact matters, call `recall` with `m12` for the exact record, or `#134-147` to browse the source window. Do not retype long ids; copy the ref.

Keep it short. The model already sees the tool description every turn; the footer should reinforce the behavior, not duplicate the grammar.

## 10. Measurement plan

Baseline (from the findings doc):

| Metric                               |                            Baseline |
| ------------------------------------ | ----------------------------------: |
| Sessions with recall                 |                   84 / 1,228 (6.8%) |
| First call: text / `#N` / hex        | 72 / 0 / 2 (one 12-hex, one 16-hex) |
| Calls: text / hex                    |                             423 / 7 |
| `#N <terms>` literal searches        |                                  28 |
| Follow-up calls within 10 turns      |                           372 / 503 |
| Rendered ids queried                 |                           7 / 8,474 |
| OM sessions with any recall after OM |                            23 / 162 |

After implementation, rerun:

```bash
python3 scripts/recall-usage-report.py --dump-calls --examples 8
```

Compare:

- first-call kind (does any session start with a ref? does text drop?)
- `#N <terms>` count (should be parsed, not literal; ideally the shape disappears)
- range/context refs (new counter; add to the script if needed)
- hex calls and rendered/queried coverage
- follow-ups per tangent (should stay high)
- empty-result rate (should not rise)

There is no controlled experiment. Use before/after on the same session corpus, inspect a handful of tangents, and treat the numbers as directional. The most important qualitative outcome is that a model that wants to dig no longer has to translate between id languages.

## 11. Implementation slices

Ordered for low risk and fast feedback:

1. **Render-only alias/range.** Add `[m12 @ #134-147]` (or `[hex @ #range]`) to the compaction renderer. Derive the alias from `MemoryDetails` order; compute the range from mapped `sourceEntryIds`. Old summaries keep their hex. No tool changes. Tests: single source, multi source, no mapped source, large span, reflection, unanchored.
2. **`refs` + range parser.** Add `refs: string[]`, `#N-M`, `context`; keep `query` search-only. Update the tool description. Remove `expand` and `mode` in the same cut. Tests: pure ref, range, drill suffix, context, refs+query, invalid ref.
3. **Leading-ref split.** If forgiving parsing is chosen, split `#N <terms>` in `query` into ref+query. Tests: mixed shape, hex-in-text is not split, invalid ref error.
4. **Alias resolver.** `recall m12` resolves against the latest compaction details; clear failure on stale/unknown alias. Tests: latest-only, chained/append caveat, alias collision policy.
5. **Branch summary refs (optional).** `#b3` namespace if branch summaries are important enough; otherwise defer.
6. **Rerun the report and update the docs.** Add counters for range/context refs and leading-ref splits.

## 12. Open questions

- **Alias or hex in the rendered line?** Alias is shorter and more familiar; hex is the stable native key and avoids generation-scoping. Could render both (`[m12 a1b2c3d4e5f6 @ #range]`) if tokens truly do not matter, but that is noisy.
- **Alias generation scope.** Is the latest compaction enough? What happens in append/chain mode? Prefix or invalidate?
- **Range cap.** 20? 40? Per-record type? What does an over-cap span render as: omit, `#start+`, or a truncated range with a warning?
- **Reflections.** Range, no range, or anchor to the newest supporting observation? Their spans are large; a range may mislead.
- **Unanchored observations.** No `#N` source; alias only. Confirm that is acceptable.
- **Strict vs forgiving parser.** Does accepting `#N <terms>` undermine the “query is search-only” clarity? Recommendation: forgiving, documented as grammar.
- **`refs` + `query` semantics.** Search within the referenced slice, or open refs and separately search globally? The observed intent is “within/around”; that should be the default. What happens when a scoped search has no matches: empty scoped result, or an explicit global fallback?
- **Scoped pagination.** When a ref is present, does `page` stay inside the referenced range? What does the page footer say? The current global footer is misleading.
- **`fields` vs `mode`.** Keep `touched`? Move to a separate view? Rename to `source`?
- **Range and scope.** `#N` is file-order; `scope:"lineage"` may skip entries. How should a range render hidden-branch entries? State file-order explicitly or filter.
- **Fork/branch drift.** `#N` ranges in old summaries can point at different content after a fork or branch navigation. The alias/hex remains exact. Should ranges be regenerated on resume, or treated as best-effort hints?
- **Tool budget.** A range can be huge; page size, headers, and continuation semantics need tests.
- **Old summaries.** They contain hex; the tool must keep resolving hex. Is that “compatibility” or simply the native key? (Current position: native key, not a compatibility layer.)

## 13. Risks

- A range is approximate; the model may treat it as exact provenance. Label it as a browsing hint.
- Ranges can be large and expensive; without a cap/budget they can flood context.
- Alias scoping across compactions is easy to get wrong; test chained/append paths.
- `#N` is file-order, not lineage-order; hidden-branch entries can appear in a range.
- Removal of `expand`/`mode` breaks any external prompt or agent that learned the old surface. Accepted per the clean-cut constraint.
- The model may still prefer text search; the change removes a mismatch but does not guarantee adoption.
- The analysis baseline is observational; a post-change improvement could be model drift, not the surface.

## 14. Decision log

| Date       | Decision                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-11-26 | No backward-compatibility layer, no opt-in flag. Clean cut; keep the ledger engine; change rendering and tool surface.                                 |
| 2026-11-26 | Compaction-scoped aliases are acceptable; token cost is not the primary concern.                                                                       |
| 2026-11-26 | Range is intended as a browsing aid for reaching a point that is not hit exactly on the first recall, or for facts spanning multiple entries.          |
| 2026-11-26 | The current bidirectional bridge (hex ↔ `#N`) is acknowledged as an earlier consolidation attempt; the tool surface is the part that needs tightening. |

## 15. Related

- [Recall usage findings](recall-usage-findings.md)
- [Recall tool](../docs/recall.md)
- [Observational memory](../docs/observational-memory.md)
- [VCC compaction](../docs/vcc-compaction.md)
- [Mid-run compaction](../docs/mid-run-compaction.md)
