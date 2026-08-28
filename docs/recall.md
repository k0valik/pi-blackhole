# Recall System

The recall system provides searchable session history after compaction. Pi's default compaction discards old messages; blackhole preserves them through a unified `recall` tool and `/blackhole-recall` command.

## recall tool

The agent gets a unified `recall` tool registered via [[src/tools/recall.ts]]. It handles five input types:

### Entry expansion (#N)

Expands a session entry by index to show full content (not truncated). Parsed by `VCC_ENTRY_PATTERN` (`/^#(\d+)$/`).

Calls `vccRecall({ query: "", expand: [index] })`, merges expanded entries into results (appends non-overlapping, replaces overlapping). Invalid indices outside available range are reported via `invalidExpandIndices()`.

### Drill-down (#N:path)

Explores file content from a tool call within a specific entry. Parsed by [[src/core/drill-down.ts]].

Pattern: `#(\d+):(.+?)(?::(full|\d+(?::\d+)?))?$`

| Syntax | Behavior |
|--------|----------|
| `#42:auth.ts` | Preview first 30 lines |
| `#42:auth.ts:full` | All content (50KB cap) |
| `#42:auth.ts:30` | Lines 31-60 (offset 30, default limit 30) |
| `#42:auth.ts:30:20` | Lines 31-50 (offset 30, limit 20) |
| `#42:file` | List all files, or auto-select if single |

Reads raw session JSONL via `loadAllMessages()`, finds content-bearing tool calls via `isContentBearing()`, matches path via `tc.path.includes(pathPattern)`. Formats edits as `--- edit N ---\noldText\n--- becomes ---\nnewText`.

### OM memory ID (12-char hex)

Recovers source evidence for a specific observation or reflection from the session ledger. Parsed by `MEMORY_ID_PATTERN` (`/^[a-f0-9]{12}$/`).

Calls `omRecall(id)` → `recallMemorySources()` from [[src/om/ledger/recall.ts]]. Shows observations (with `[dropped]` marker for tombstoned ones), reflections, and source entries. Annotates sources with `#N` indices via `buildIndexMap()` + `formatEntryIndexAnnotation()`.

### Free text search (BM25)

BM25-ranked OR search across transcript text and/or file content. Rare terms weighted higher. Defined in [[src/core/search-entries.ts]].

#### BM25 algorithm

Constants: `BM25_K = 1.2`, `BM25_B = 0.75`. ~70 English stopwords filtered from queries.

```
IDF = log((N - df + 0.5) / (df + 0.5) + 1)
TF-Norm = (tf * (K + 1)) / (tf + K * (1 - B + B * dl / avgDl))
Score = sum(IDF * TF-Norm for each term)
```

Stopwords removed from query terms before scoring. If query contains regex metacharacters (`/[|*+?{}()[\]\\^$.]/`), entire query treated as regex pattern instead.

#### Search modes

| Mode | Searches |
|------|----------|
| `hybrid` (default) | Transcript text + tool call args |
| `file` | Only tool call args (file content) |
| `touched` | Aggregate all files written/edited, grouped by path |

#### File indicators

`getFileIndicators()` counts lines per file in content-bearing tool calls. `computeFileMatches()` filters lines matching query regex with snippets (`±2` context lines). `getTouchedFiles()` aggregates entries per path for `mode:touched`.

### Scope

`scope:lineage` (default) searches only the active lineage. `scope:all` searches across all session lineages. Active lineage extracted via [[src/core/lineage.ts]] `getActiveLineageEntryIds()`.

### Pagination

`page:N` (1-based, default 5 results per page). Expand entries merged before pagination for consistent counts. Footer includes scope hint.

## OM coupling

When expanding session entries (`#N`), the tool automatically looks up related observations and reflections from the session ledger. Defined in [[src/om/reverse-recall.ts]].

- `findObservationsForEntryIds()` — Finds observations whose `sourceEntryIds` intersect with the expanded entries
- `findReflectionsForEntryIds()` — Finds reflections that support those observations (via `supportingObservationIds`)
- Results annotated with `#N` indices via `buildIndexMap()` + `formatEntryIndexAnnotation()`

OM integration is wrapped in try/catch — branch may not be available in all contexts. Dropped observations included with `[dropped]` marker.

## /blackhole-recall command

User-facing command for interactive session history search. Defined in [[src/commands/vcc-recall.ts]]. Same engine as the `recall` tool.

```
/blackhole-recall auth token                        # active-lineage search, ranked
/blackhole-recall auth token page:2                 # paginated (5 results/page)
/blackhole-recall hook|inject                       # regex
/blackhole-recall fail.*build scope:all             # regex across all lineages
/blackhole-recall mode:file                         # search only write/edit file content
/blackhole-recall mode:touched                      # aggregate view of all files touched
/blackhole-recall                                   # recent 25 entries
```

Results shown as a collapsible message and auto-fed to the agent as context. Calls `augmentWithObservations()` after rendering to append related OM observations/reflections.

## Session file access

All session access goes through `loadAllMessages()` in [[src/core/load-messages.ts]]. LRU cache:

- Max 3 entries
- 2-second TTL
- mtime-based invalidation (detects file changes between cache hits)
- Cache key includes `allowedEntryIds` set (sorted JSON for collision-free lineage filtering)
- Parse errors logged via `console.warn()` but don't throw

## Content indexing

Only full-file writes are indexed for text search. Tool args capped at 10KB per call.

### Content formatting

`formatRecallOutput()` in [[src/core/format-recall.ts]] formats search results:

- `shortPath()` — Shorten paths relative to CWD or show last 3 components
- `formatFileMatch()` — Tool name, path, line count, optional snippet
- `formatTouchedOutput()` — Paginated file-touch list (5 per page)
