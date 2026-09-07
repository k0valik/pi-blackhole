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

Append-only mode can preserve a longer exact provider-input prefix. It does not guarantee a provider cache hit or reduce logical context size. When the projected post-compaction context passes half of the session model's context window minus the trailing note, the next automatic compaction folds the chain into one fresh segment instead of appending, as long as the aggregate summary is smaller than the chain it replaces (otherwise rebasing would grow the context, so appending continues). The projection anchors on the latest reported provider usage when a trusted assistant response exists after the newest segment, and estimates from character counts plus the measured kept tail otherwise. Explicit `/blackhole` rebases at any time.
