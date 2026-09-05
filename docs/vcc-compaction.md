# VCC Compaction Pipeline

The VCC pipeline replaces Pi's LLM-based compaction with a deterministic, zero-cost algorithmic summary. It extracts structured sections from session messages using regex heuristics. Entry point: `compile()` in [[src/core/summarize.ts]].

## compile pipeline

The `compile()` function orchestrates the full pipeline from raw messages to formatted summary. Each stage is a pure transformation.

```
messages: Message[]
    │
    ▼
normalize()          → NormalizedBlock[]
    │
    ▼
filterNoise()        → NormalizedBlock[] (noise removed)
    │
    ▼
buildSections()      → SectionData (goals, files, commits, preferences, brief)
    │
    ▼
formatSummary()      → string (formatted with headers)
    │
    ▼
+ merge previous summary (if any)
    │
    ▼
+ RECALL_NOTE appended
    │
    ▼
return compiled string
```

### normalize

Converts raw Pi `Message[]` into `NormalizedBlock[]`. Defined in [[src/core/normalize.ts]]. Each message role maps to a block kind:

- **user** → text + image parts
- **assistant** → text, thinking, toolCall parts
- **toolResult** → name + text + isError flag
- **bashExecution** → command + output + exitCode

Uses [[src/core/sanitize.ts]] to strip ANSI codes and control characters before normalization.

### filterNoise

Removes non-essential blocks from the normalized stream. Defined in [[src/core/filter-noise.ts]]. Drops:

- All `thinking` blocks (internal reasoning, not needed in summary)
- Noise tools: `TodoWrite`, `TodoRead`, `ToolSearch`, `WebSearch`, `AskUser`, `ExitSpecMode`, `GenerateDroid`
- User blocks matching noise strings
- XML wrappers: `<system-reminder>`, `<ide_opened_file>`, etc.

### buildSections

Orchestrates section extraction from filtered blocks. Defined in [[src/core/build-sections.ts]]. Calls each extraction module and assembles the [[architecture#Key types#SectionData|SectionData]] structure.

## Section extraction

Four extraction modules produce the structured sections. Each uses deterministic regex-based heuristics — no LLM involved.

### Goals extraction

Extracts task goals and scope changes from user message blocks. Defined in [[src/extract/goals.ts]].

- **Goal patterns**: Scope-change signals (`instead`, `change of plan`), task intent (`fix`, `implement`, `add`)
- **Non-goal detection**: Rejects pasted output, code, paths, tool dumps, meta-prompts
- **Template signals**: Stops at `For each`, `Do NOT implement`
- **Scope change**: Emits `[Scope change]` marker when detected
- **Leading test**: Only checks first 200 chars of user blocks (prevents pasted output false positives)
- **Limit**: Max 8 goals

### Files extraction

Tracks file activity (read/modified/created) from tool calls. Defined in [[src/extract/files.ts]].

- **Read**: `Read`, `read_file`, `View`
- **Modified**: `Edit`, `Write`, `edit`, `write`, `edit_file`, `write_file`, `MultiEdit`
- **Created**: Forward-compatible (empty in current implementation)
- **Path normalization**: Strips common directory prefix (≥2 levels) from all paths
- **Dedup**: Modified files removed from Created set (file existed before)

### Preferences extraction

Extracts user preferences from user message blocks. Defined in [[src/extract/preferences.ts]].

- **Patterns**: `prefer`, `don't want`, `always use`, `never use`, `please use`, `style:`, `format:`
- **Filters**: Length 5-200 chars, excludes questions (ending `?`), max 1 preference per user block
- **Dedup**: `dedupPreferencesAgainstGoals()` removes preferences that duplicate goals
- **Limit**: Max 10 preferences

### Commits extraction

Extracts git commits from bash tool calls. Defined in [[src/extract/commits.ts]].

- **Detect**: `git commit -m "..."` in bash command
- **Hash extraction**: Looks at next 2 tool results for `[branch <hash>]`, `hash..hash`, or 8-12 hex chars
- **Dedup**: By `hash::message` key
- **Limit**: Max 8, most recent

## Brief transcript

The brief transcript is a compressed representation of the full conversation. Built by [[src/core/brief.ts]].

### Token counting

Uses `Intl.Segmenter` for Unicode-aware word segmentation. Stop words excluded from token budget. Falls back to whitespace split when `Intl.Segmenter` is unavailable.

### Compression rules

Rules applied when compressing each message type into the brief transcript.

- **User messages**: Truncated to 256 tokens (excluding stop words)
- **Assistant messages**: Truncated to 200 tokens
- **Bash compression**: Strip `cd <path> &&`, pipe tails (`head/tail/sort/wc`), cap 120 chars
- **Tool one-liners**: Extract path/command/query for summary via [[src/core/tool-args.ts]]
- **Deduplication**: Collapse consecutive identical tool calls as `xN`
- **Error collapse**: Merge back-to-back `[tool_error]` sections with same tool and body
- **Tool call capping**: Keep last 8 tool calls per assistant turn, omit earlier
- **Skill collapse**: Convert `<skill name="X">` blocks to `[skill: X]` via [[src/core/skill-collapse.ts]]

### Content utilities

Text utilities shared across the pipeline. Defined in [[src/core/content.ts]].

- `clip(text, max)` — Truncate to max chars
- `clipSentence(text, max)` — Find sentence boundary within max chars
- `isContentBearing(args)` — Check tool args for path + content-bearing fields
- `toolCallArgsText(args)` — Extract up to 10KB per content-bearing tool call
- `snippet(text, regex)` — Extract ±60 chars around first match

## Formatting

Formats `SectionData` into a human-readable summary with TUI-safe wrapping. Defined in [[src/core/format.ts]].

- **Section headers**: `[Session Goal]`, `[Files And Changes]`, `[Commits]`, `[Outstanding Context]`, `[User Preferences]`
- **List format**: `- item` under each header
- **Brief cap**: Keep last 120 lines, avoid cutting mid-section
- **Line wrapping**: 120 chars, preserve list-item continuation indent
- **RECALL_NOTE**: Footer appended by `compile()` to avoid duplication during merge

### Merge previous summary

When compaction runs on an already-compacted session, `compile()` merges the new summary with the previous one:

- Sections merged line-by-line, capped at 8-15 items per section
- File merge: Dedup Modified/Created/Read paths
- Brief merge: Concatenate transcripts
- Strip `RECALL_NOTE` before merge to avoid duplication
- Strip `## Reflections`/`## Observations` from previous compaction (OM content is re-injected fresh)

## before-compact hook

The `session_before_compact` hook is the integration point between VCC and OM. Defined in [[src/hooks/before-compact.ts]].

### Guards

The hook checks several conditions before proceeding:

- `compaction: "off"` → Skip auto-triggered compaction (`/blackhole` still works)
- `compactionEngine: "pi-default"` → Let Pi handle auto-compaction
- `compaction: "manual"` → `/compact` falls through to Pi, only `/blackhole` uses VCC

### buildOwnCut

The `buildOwnCut()` function determines which messages to compile:

- Find last compaction entry and its `firstKeptEntryId`
- **Orphan recovery**: When `lastKeptEntryId` no longer exists in branch, resume from after last compaction entry
- **Tail behavior**:
  - `pi-default`: Use Pi's `firstKeptEntryId` (respects `keepRecentTokens`, ~20k tokens)
  - `minimal`: Keep only last user message (aggressive, original pi-vcc behavior)
- **Compact-all**: Single user prompt → compact everything, `firstKeptEntryId=""` sentinel
- **Too few messages**: Cancel if <3 messages (or <2 with pi-default tail)

### Ownership and native fallback

When blackhole is active (`compactionEngine: "blackhole"`), the hook owns the summary for every Pi-initiated compaction — threshold auto-compact, overflow recovery, and manual `/compact` — and returns `{ compaction: { ... } }` to take ownership. In `manual`/`off` modes and for `compactionEngine: "pi-default"` it returns `undefined` so Pi handles the compaction natively (only `/blackhole` forces VCC).

Defensive delegation: `compile()` returns `""` when everything before the cut is noise-filtered and no previous summary exists. If the VCC summary is empty **and** the OM projection produced no reflections/observations, the hook returns `undefined` (emitting a `before_compact.native_fallback` trace) so Pi's native summarizer writes the summary instead of blackhole replacing the context with a footer-only block. `ExtensionHandler` permits `void`, and Pi only acts on `result?.compaction`, so the bare return is a safe fall-through.

### Cancellation flag

Every `{ cancel: true }` return (own-cut guards, legacy `noAutoCompact`) sets `runtime.lastCompactCancelled = true` so the failure handler can attribute the aborted compaction.

At the start of each attempt, `lastCompactCancelled` resets and `compactWasPiVcc` is overwritten from the `/blackhole` marker. Success consumes the origin marker; failure captures and clears both flags. This attributes hook cancellations correctly without leaking `/blackhole` state into later pi-default attempts — see [[observational-memory#Compaction trigger#Compact-failure handling]].

### OM injection

After VCC `compile()` produces the structured summary, the hook appends OM content:

1. `buildCompactionProjection()` — Select observations/reflections under token budget
2. `renderSummary()` — Format as `## Reflections` / `## Observations` with footer
3. Append to VCC summary

The OM injection uses relevance-tiered selection: high/critical observations always kept, medium/low scored by relevance + recency. See [[observational-memory#Projection]].

### Compaction details

The hook attaches `PiVccCompactionDetails` to the compaction entry for debugging and tracking. Defined in [[src/details.ts]]:

```typescript
interface PiVccCompactionDetails {
  compactor: "blackhole";
  version: number;
  sections: string[];
  sourceMessageCount: number;
  previousSummaryUsed: boolean;
}
```

### Zero-usage entries and overflow recovery (#8328)

Blackhole compaction entries carry zero provider usage (LLM compaction bypassed); pi ≥ 0.84.3 handles this correctly in overflow checks (upstream fix #8328).

Before pi 0.84.3, `_checkCompaction` early-returned when no assistant message had usage data, so overflow auto-compaction could never fire after a blackhole compaction — a latent stuck state. Upstream fix #8328 (commit 4495469a5) falls back to pure message-size estimates when usage is absent. Minimum pi version for correct overflow recovery: 0.84.3. See also [[observational-memory#Compaction trigger#Pi version requirement (#8328)]].

## Tail behavior

Controls how much of the recent transcript stays visible after compaction. Only applies when `compactionEngine: "blackhole"`.

| Invocation | Config | Effective |
|------------|--------|-----------|
| Manual `/blackhole` | not set | `minimal` (aggressive) |
| Manual `/blackhole` | `pi-default` | `pi-default` |
| Auto-triggered | not set | `minimal` |
| Auto-triggered | `minimal` | `minimal` |

See [[config#Compaction settings#Tail behavior]] for configuration details.

## Orphan recovery

When `lastKeptEntryId` from a previous compaction no longer exists in the branch (due to manual session editing, fork navigation, or compaction), the hook recovers:

1. Detect that `lastKeptEntryId` is not in the branch
2. Resume collection from after the last compaction entry
3. Compile all messages from that point
4. Set `firstKeptEntryId=""` as sentinel (triggers orphan recovery on next compaction too if needed)

This prevents broken state after manual session editing.
