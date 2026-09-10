# Append Compaction

`compactionSummaryMode` controls how Blackhole exposes VCC summaries after compaction.

```json
{
  "compactionSummaryMode": "default"
}
```

Values:

- `default` keeps the existing behavior. Each compaction exposes one complete replacement summary.
- `append` stores an immutable VCC segment for each automatic or mid-run Blackhole compaction. The `context` hook exposes the active chain as separate provider messages.

In append mode, explicit `/blackhole` is a manual rebase. It folds the active chain and newly covered context into one clean segment and starts a new chain. Historical session entries remain on disk.

Each compaction also stores one complete fallback summary. If the prior complete summary is unavailable, version-2 segment details are missing or invalid, the chain is on another branch, or the active fallback message cannot be matched exactly once, Blackhole keeps the normal one-summary fallback path. It does not silently repair a malformed version-2 chain.

Observational memory and the shared recall note are not frozen inside every segment. Blackhole adds one current trailing message after the immutable VCC chain.

Environment override:

```text
PI_BLACKHOLE_COMPACTION_SUMMARY_MODE=default|append
```

Append-only mode can preserve a longer exact provider-input prefix. It does not guarantee a provider cache hit or reduce logical context size. At an existing compaction, ordinary rebase requires pressure and useful saving: append-chain size above `floor(W / 8)` or estimated full context above `floor(W / 2)`, and saving at least `max(1, min(24000, floor(24000 * W / 272000)))`. At 272k, those values are 34k, 136k and 24k. A 40k chain with only 4k reclaimable stays append under ordinary conditions.

Candidates use identical bounded current memory and kept tail. Rendered chain sizes include coverage markers and Pi summary wrappers. Full-context estimates reconstruct a compatible trusted usage baseline, retain its fixed residual overhead, and replace visible content with each candidate. Missing evidence leaves totals unknown, never mislabeled chain-only totals. With no supplied finite positive model window, only the 34k/24k chain policy applies.

Explicit `/blackhole` forces rebase; `/compact` does not. Overflow recovery and known capacity pressure (`appendTotal > W - reserveTokens`) choose the smaller valid candidate without the ordinary minimum saving. Diagnostics report insufficient recovery when estimated output still exceeds capacity. Estimates do not prove a future request will fit; Pi's overflow retry/error control remains active.

Observation output defaults to 20,000 rendered-line tokens; reflection output (`reflectionsPoolMaxTokens`) defaults to 8,000. Whole records only, including IDs and newline separators. Headings, recall note and footer add separate trailing cost. Compact-all retains eligible bounded memory. Omitted source records remain recallable; worker reflection prompts stay unchanged. Cadence, summary model calls and persistent details schema are unchanged.
