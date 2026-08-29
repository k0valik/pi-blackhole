# Observational Memory

The observational memory (OM) system captures timestamped facts and durable reflections that survive across compactions. Three background workers run during the session, storing results in a session ledger.

## The three workers

Three background workers run automatically when `memory: true` (default). Each uses an `agentLoop` with tool-calling capabilities — not a single LLM call.

### Observer

Reads conversation since the last observation marker and extracts timestamped facts. Input capped to `observerChunkMaxTokens` newest-first. Runs most frequently.

The observer can call `record_observations` multiple times per run to work through a chunk incrementally. Observations include `sourceEntryIds` linking back to the conversation entries they were extracted from.

### Reflector

Distills new observations into durable reflections: stable facts, patterns, and constraints. Runs less often (threshold: `reflectAfterTokens`).

### Dropper

Prunes low-value observations from active memory when the pool exceeds `observationsPoolMaxTokens`. Keeps reflections in the session ledger.

```
[Conversation turn] ──> (accumulated tokens >= observeAfterTokens)
                            │
                            v
                    1. OBSERVER
                       (extracts timestamped observations via agent loop)
                            │
                            v
                    2. REFLECTOR
                       (synthesizes durable reflections via agent loop)
                            │
                            v
                    3. DROPPER
                       (prunes low-value observations, keeps reflections)
```

## Agent prompts and contracts

Each worker runs an `agentLoop` driven by a system prompt and a single record/drop tool. This section documents the three contracts — objective, inputs, tool schema, validation, edge cases, and shared loop mechanics.

All three workers share the same loop configuration: `toolExecution: "sequential"`, `thinkingLevel: "low"` (default), `maxTurns` capped by the config's `agentMaxTurns` (default 16) via a `shouldStopAfterTurn` counter, and `maxTokens` bounded by `boundedMaxTokens(model, AGENT_LOOP_MAX_TOKENS)` where [[src/om/model-budget.ts]] `AGENT_LOOP_MAX_TOKENS = 32_000`. Record identity is a content hash (`hashId` in [[src/om/ids.ts]]), so identical content is deduplicated within and across calls.

### Observer contract

Compresses a chunk of recent conversation into timestamped, rated observations. System prompt `OBSERVER_SYSTEM` in [[src/om/agents/observer/prompts.ts]]; agent `runObserver` in [[src/om/agents/observer/agent.ts]].

**Tool**: `record_observations` — `observations[]`, each `{ timestamp: "YYYY-MM-DD HH:MM" (regex-validated), content: string (minLength 1, single-line), relevance: low|medium|high|critical, sourceEntryIds: string[] (minItems 1) }`.

**Injected inputs** (assembled into the user message): current reflections, current observations formatted `[id] date [relevance] content`, the new conversation chunk with `[Source entry id: <id>]` labels and inline message timestamps, and a current local-time fallback.

**Validation**: `normalizeSourceEntryIds` *filters* unknown ids rather than rejecting the whole batch (one hallucinated id must not discard valid observations — the same pattern as the dropper). Content is truncated by `truncateRecordContent`. Each observation with no surviving valid `sourceEntryIds` is rejected individually. Duplicates are skipped by content hash.

**Edge cases**: when nothing is recorded, `ObserverEmptyReason` distinguishes `no_new_content`, `tool_not_called`, `all_rejected` (every `sourceEntryIds` invalid), `all_duplicates`, and `empty_array`. If the stream ends with `stopReason: "error"` **and** zero observations were collected, `runObserver` throws so the pipeline can fall back to another model; if some observations were collected, they are kept.

**Why it matters**: the relevance level assigned here drives downstream dropping, and `sourceEntryIds` are the only provenance link back to the raw conversation. The prompt enforces single-fact granularity (one fact per observation) so retrieval and dropping can operate at fact resolution.

### Reflector contract

Distills durable reflections from active observations — explicitly not a second observation layer. System prompt `REFLECTOR_SYSTEM` in [[src/om/agents/reflector/prompts.ts]]; agent `runReflector` in [[src/om/agents/reflector/agent.ts]].

**Tool**: `record_reflections` — `reflections[]` (minItems 1), each `{ content: string (minLength 1), supportingObservationIds: string[] (minItems 1) }`.

**Injected inputs**: current reflections, current observations shown as `[id] date [relevance] [coverage: none|partial|strong] content` (coverage tiers from [[src/om/agents/dropper/coverage.ts]]), and optional compact summaries of existing reflections/observations marked "for context only — do NOT re-process".

**Validation**: `normalizeReflectionContent` rejects empty or multiline content. `normalizeSupportingObservationIds` is **strict** — if *any* id is unknown, the reflection is rejected (unlike the observer/dropper filter pattern), because inflated support ids would make observations look more-covered than they are and cause unsafe downstream drops. Dedup is against existing reflections plus this run.

**Edge cases**: returns `undefined` immediately when `observations.length === 0`. Emitting zero reflections is a valid, expected outcome ("it is better to emit zero reflections than one per observation"). Same throw-on-error-if-empty pattern as the observer.

**Coverage tiers as review context**: `none`/`partial`/`strong` are guidance, not a quota, priority score, or instruction to emit. `supportingObservationIds` form a coverage/provenance set that doubles as dropper evidence — the reflector is the sole writer of the coverage relationship the dropper later trusts.

### Dropper contract

Identifies the *safest* active observations to remove from compacted memory; the default action is KEEP and uncertainty resolves to keeping. System prompt `DROPPER_SYSTEM` in [[src/om/agents/dropper/prompts.ts]]; agent `runDropper` in [[src/om/agents/dropper/agent.ts]].

**Tool**: `drop_observations` — `{ ids: string[] (minItems 1), reason?: string }`.

**Deterministic budget gate (before the LLM runs)**: the agent computes pool fullness (`observationPoolFullness` = active tokens / budget), urgency (`dropUrgencyForFullness`: `<0.30` low, `<0.60` medium, else high), and `maxDropCountForPool`. If fullness `< 0.10` (`DROP_SKIP_FULLNESS`), `maxDropsAllowed` is 0 and the LLM is **not called at all**. Otherwise the allowed drop ratio interpolates from `0.10` (`DROP_MIN_RATIO`) at fullness 0.10 up to `0.50` (`DROP_MAX_RATIO`) at fullness 1.0, applied to the non-critical observation count (critical observations are excluded from the ratio base).

**Deterministic final selection (after the LLM proposes)**: `selectDropCandidates` re-ranks the proposed ids by `(coverage drop rank, relevance drop rank, timestamp age, proposal order)` and slices to `maxDropsAllowed`. So the LLM proposes candidates, but the deterministic ranker enforces ordering and the hard cap — the LLM cannot exceed the budget or reorder past the safety ranking.

**Validation**: `normalizeDropObservationIds` filters unknown ids (filter pattern). The tool ack reports running candidate count and the hard `maxDropsAllowed` so the model self-regulates.

**Edge cases**: returns `undefined` when `observations.length === 0` or `maxDropsAllowed <= 0`. Result reasons: `selected_nonempty`, `no_tool_call`, `all_filtered`, `selected_empty`. Same throw-on-error-if-empty pattern.

**Preservation floor**: regardless of relevance, budget pressure, coverage, or age, the prompt forbids dropping observations that uniquely carry user preferences/constraints/corrections, concrete completions, named identifiers, exact errors, decisions + rationale, event dates, unresolved blockers, or non-standard terminology. Dropping removes from active compacted memory only — ledger history and source evidence are retained.

## Session ledger

The session ledger stores observations and reflections as custom entries appended to the Pi branch. Three custom types are used:

| Custom type | Constant | Contents |
|-------------|----------|----------|
| `om.observations.recorded` | `OM_OBSERVATIONS_RECORDED` | `Observation[]` + `coversUpToId` |
| `om.reflections.recorded` | `OM_REFLECTIONS_RECORDED` | `Reflection[]` + `coversUpToId` |
| `om.observations.dropped` | `OM_OBSERVATIONS_DROPPED` | `observationIds[]` + `coversUpToId` (tombstones) |

Types defined in [[src/om/ledger/types.ts]]. Each observation and reflection has a 12-char hex identifier. Type guards (`isObservation`, `isReflection`, etc.) validate data shape.

### Ledger folding

Folding deduplicates observations/reflections and applies tombstones. First-valid-record-wins semantics.

```typescript
interface FoldedLedger {
  observations: Observation[];           // all first-valid (including dropped)
  activeObservations: Observation[];     // not tombstoned
  droppedObservationIds: Set<string>;    // tombstone set
  reflections: Reflection[];             // all first-valid
  observationsById: Map<string, Observation>;
  reflectionsById: Map<string, Reflection>;
}
```

## Projection

Projection builds slices of the ledger for different purposes. Defined in [[src/om/ledger/projection.ts]].

### Full projection

`fullProjection(entries)` — All observations and reflections through branch tip (or specified entry). Used for worker context.

### Visible projection

`visibleProjection(entries)` — What the agent sees after compaction. Uses `MemoryDetails` from the latest compaction entry. Before first compaction, shows everything.

### Compaction projection

`buildCompactionProjection(entries, firstKeptEntryId, config)` — Builds the memory slice for compaction output. Uses boundary-based folding:

- Observations boundary: `firstKeptEntryId` (normal fold)
- Reflections/drops boundary: `latestFullFoldBoundaryId` (maintenance boundary)
- **Full fold**: When observation tokens ≥ `observationsPoolMaxTokens`, fold through branch tip
- **Token cap**: Even if dropper kept some old observations, a safety valve caps to pool budget using `selectPriorObservations()`

### Selection scoring

`selectPriorObservations()` caps observations to a token budget. Relevance tier dominates:

- **High/critical**: Always kept (score base 10)
- **Medium**: Scored by relevance + recency (base 5)
- **Low**: Scored by relevance + recency (base 1)

Recency uses array position (0 = oldest), avoiding wall-clock dependency that punishes multi-day sessions.

## Coverage scoring

Reflection-coverage tiers quantify how many current reflections cite each observation id, giving the dropper evidence that an observation's durable meaning is preserved before it is pruned. Computed deterministically in [[src/om/agents/dropper/coverage.ts]].

Coverage is the bidirectional contract between the reflector and the dropper: the reflector *writes* `supportingObservationIds` (which determine coverage), and the dropper *reads* coverage to decide what is safe to drop. It is recomputed every run from the current reflection and observation sets — it is never persisted.

### Tier model

`reflectionCoverageTierForCount(count)`: `none` (0 reflections cite the id), `partial` (exactly 1), `strong` (2 or more). An observation with no matching reflection defaults to `none`, which is the most protected tier.

### Functions

The module exports pure functions over the current reflection and observation sets; none mutate their inputs or persist state.

- `reflectionSupportCounts(reflections)` → `Map<obsId, count>`. Dedups ids within each reflection via a `Set`, so a reflection listing the same id twice counts once.
- `reflectionCoverageMap(observations, reflections)` → `Map<obsId, tier>`. Builds the per-observation tier map; unknown ids resolve to `none`.
- `REFLECTION_COVERAGE_DROP_RANK` — `{ strong: 0, partial: 1, none: 2 }`. Lower rank drops first, so strongly-covered observations are treated as safer to prune than uncovered ones.
- `summarizeCoverageByRelevance` / `summarizeCoverageByRelevanceForIds` → bucket count and tokens by `relevance × tier`. Used for `dropper.agent_start` / `dropper.result` debug logging so the dropper's input and output coverage distribution is observable.
- `summarizeCoverageTransitionsByRelevance(before, after)` → records `before->after` tier deltas (e.g. `none->strong`) per relevance, skipping unchanged tiers. Used to log how a reflector run shifted coverage.
- `observationToDropperLine(observation, coverage)` → formats `[id] date [relevance] [coverage: X] content` — the exact line format the dropper prompt and reflector input expect.
- `coverageTierForObservation(observation, coverageById)` → single-lookup helper.

### Why it is needed

Without coverage evidence the dropper must guess whether an observation's meaning survives elsewhere. Coverage provides a deterministic signal: strongly-covered observations are likely redundant, while uncovered high/critical ones are load-bearing.

This is what lets the pool be pruned toward `observationsPoolTargetTokens` without silently losing durable facts.

### Invariants and edge cases

Coverage is recomputed every run from the live sets and follows a few load-bearing invariants.

- Coverage is a property of the *current* reflection set vs observation set — staleness is impossible because it is never cached.
- `strong` requires ≥2 **distinct** reflections citing the id (intra-reflection duplicates collapse).
- `summarizeCoverageByRelevanceForIds` silently skips ids absent from `observations` rather than erroring, so partial id lists (e.g. only dropped ids) summarize cleanly.
- The transition summary records only deltas, so a no-op reflector run produces an empty transition map.
- Safety dependence: because the dropper trusts these tiers, the reflector's strict `supportingObservationIds` validation is the load-bearing guard against id inflation — inflated ids would inflate coverage and cause unsafe drops.

## Consolidation pipeline

The consolidation pipeline runs Observer → Reflector → Dropper on `agent_start` and `turn_end` events. Defined in [[src/om/consolidation.ts]].

### Trigger conditions

`anyStageDue()` checks whether any worker should run:

- **Observer due**: Tokens since last observation coverage ≥ `observeAfterTokens`
- **Reflector due**: Tokens since last reflection coverage ≥ `reflectAfterTokens` AND new observations exist
- **Dropper due**: Pool ≥ `dropperPressureThreshold × reflectorInputMaxTokens` OR (new data exists AND pool ≥ 10% full)

In manual mode (`compaction: "manual"`), the branch has no OM markers — pending state provides pool fullness and new-data visibility.

### Pipeline execution

`runConsolidationPipeline()` executes stages sequentially:

1. **Observer** — `runObserverStage()`: serialize chunk, cap to `observerChunkMaxTokens`, run observer agent loop, append/save observations
2. **Reflector** — `runReflectorStage()`: collect new observations since last reflection, run reflector agent loop, append/save reflections
3. **Dropper** — `runDropperStage()`: collect active observations, run dropper agent loop, append/save drops

Each stage clears `failedInCycle` between stages. Cursor state is flushed to pending file after all stages complete.

### Cursor system

Pipeline cursors track progress per stage. Defined in `PipelineCursor` / `PipelineCursors`. States: `initial`, `recorded`, `empty`, `error`, `skipped`, `not_due`.

- Cursors are loaded from pending file once per session (validated against current branch)
- **Cursor validation**: If a cursor's entry ID no longer exists (fork, navigation, compaction), falls back to latest coverage marker
- Cursors are flushed to pending file after all stages complete (async via microtask)

### Context window pre-check

Before calling each worker, the pipeline estimates input tokens and checks against the model's effective context window.

## Model resolution

Each worker resolves models in a fallback chain. Defined in [[src/om/runtime.ts]] `Runtime.resolveModel()`.

### Resolution order

For each stage, the runtime builds a candidate list:

1. **Primary stage model** (`observerModel`, `reflectorModel`, `dropperModel`)
2. **Stage fallback models** (`observerFallbackModels`, etc.) — tried in order
3. **Base model** (`model` — shared across all workers)
4. **Session model** (the main conversation model — last resort, never cooled down)

Models with active cooldowns are transparently skipped. Up to 10 model resolutions per stage before giving up (`MAX_STAGE_ATTEMPTS = 10`).

### Session fallback

`sessionFallback: true` (default) falls back to the session model when all OM candidates are exhausted. Set `false` to skip the stage entirely instead. This is useful when you don't want OM workers consuming your main model's rate limits.

## Cooldown system

Models that fail with retryable errors are cooled down and skipped in subsequent attempts. Defined in [[src/om/cooldown.ts]].

### Persistence

Cooldowns persist to `~/.pi/agent/pi-blackhole/pi-blackhole-cooldown.json` with ISO 8601 timestamps. Each entry records:

- `modelKey` — `provider/id` identifier
- `until` — expiry timestamp
- `reason` — error message
- `stage` — which stage failed

Cooldowns survive Pi restarts. `expireCooldowns()` runs lazily on config load. `isCooldownActive()` reads from disk each call.

### Cooldown hours

`cooldownHours` per model config (default: 1 hour). Set `0` to disable cooldown — the model is tracked in-memory for the current stage only (no disk writes), using `failedInCycle` set.

### Retryable error detection

A single regex in [[src/om/retryable-error.ts]] matches: HTTP 429, 5xx, rate limits, timeouts, network failures, connection errors, WebSocket closures. Also re-exports Pi's `isContextOverflow` for authoritative overflow detection.

## Compaction trigger

Auto-compaction fires on `agent_end` when tokens exceed `compactAfterTokens`. Defined in [[src/om/compaction-trigger.ts]].

### Guards

Conditions checked before auto-compaction fires.

- `compaction: "off"` → Skip entirely
- `compaction: "manual"` → Skip auto-trigger
- `compactionEngine: "pi-default"` → Skip (Pi handles timing)
- `memory: false` → No longer blocks compaction (orthogonal)
- Agent retrying (`stopReason: "error"` with retryable error) → Skip (agent hasn't truly finished)

### Idle waiting

After threshold is reached, the trigger waits for the agent to become truly idle before calling `ctx.compact()`:

- Polls `ctx.isIdle()` every 200ms (50ms slices for responsiveness)
- `agent_start` aborts pending wait (new turn starting)
- `session_compact_failed` aborts any pending wait before clearing its controller reference
- Session identity validation — bails if session changed (replaced/reloaded)
- Re-checks token threshold after idle (pressure may have been relieved by another compaction)

### Pi version requirement (#8328)

pi ≥ 0.84.3 is required for overflow auto-compaction to fire after blackhole compactions (upstream fix #8328, commit 4495469a5).

Blackhole compactions produce zero provider usage (the LLM compaction is bypassed). Before the fix, `_checkCompaction` early-returned when no assistant message carried usage data, so pi could never recover from context overflow after a blackhole compaction. The fix falls back to pure message-size estimates when usage is absent. Minimum supported version for correct overflow recovery: pi 0.84.3.

### Compact-failure handling

The `session_compact_failed` event (pi ≥ 0.84.3) gets unified handling in [[src/hooks/compact-failed.ts]].

Before this hook, failure coverage was fragmented: `/blackhole` and the auto-trigger had their own `onError` callbacks, but overflow compaction failures (pi-initiated, mid-turn) were invisible, `/compact` cancelled by our guards was only notified inside the hook, and overflow aborts with retry had no visibility at all. The handler does four things:

1. **Structured trace log** — `compact_failed.received` records reason, aborted, willRetry, fromExtension, errorMessage, and session id.
2. **Defensive `compactInFlight` guard** — on abort or error, aborts any pending idle-wait controller before clearing its reference, then resets `compactInFlight`. This prevents an orphaned wait from launching a second compaction after a later turn.
3. **Overflow-retry visibility** — `reason: "overflow"` + `aborted` + `willRetry` notifies `"blackhole: overflow compaction aborted, retrying turn"` (info).
4. **pi-default noise filter** — failures under `compactionEngine: "pi-default"` that are not ours get only a light `compact_failed.skipped_pi_default` trace; error notifications fire only for failures attributed to blackhole.

#### Attribution fix

Upstream only sets `fromExtension: true` for content-bearing compactions, so hook `{ cancel: true }` returns are mislabeled false; the handler derives the true origin instead.

The derived field is `attributedFromExtension = fromExtension || compactWasPiVcc || lastCompactCancelled`. Both runtime flags are attempt-scoped: each `session_before_compact` overwrites them, success consumes `compactWasPiVcc`, and failure captures then clears both before side effects. This prevents `/blackhole` attribution from leaking into later pi-default failures.

## Manual mode

When `compaction: "manual"`, observations go to per-session disk buffers instead of conversation markers. Defined in [[src/om/pending.ts]].

### Pending state

Each session gets its own `<sessionId>-pending.json` under `~/.pi/agent/pi-blackhole/`. Contains:

- Latest observation/reflection/dropper results (replaced each run)
- Accumulated batches (observationBatches, reflectionBatches, droppedBatches) for LLM context and flush
- Pipeline cursors (persisted across restarts)

### Flush on /blackhole

When `/blackhole` runs in manual mode, pending entries are flushed to the branch via `pi.appendEntry()` and the file is cleared. This eliminates race conditions from concurrent sessions writing to a shared file.

### Stale backup

Before each write, the current pending file is renamed to `<sessionId>-pending.stale.json` as backup. Best-effort — stale backup is optional.

## Render summary

Formats observations and reflections for compaction output. Defined in [[src/om/ledger/render-summary.ts]].

### Output format

```
## Reflections
[hexid] Reflection content...

## Observations
[hexid] 2026-05-23 [high] Observation content...

----
Bracketed ids connect to source session entries...
----
```

When no observations or reflections exist, only a short recall-guidance footer is appended. The footer instructs the agent on how to use `recall` with IDs and `#N:path` drill-down.

## Graceful degradation

If any stage fails (model error, rate limit, timeout), remaining stages are skipped and the full pipeline retries on the next trigger event.

- **30-second retry gate**: After any stage fails completely, `markConsolidationError()` sets a timestamp. `isConsolidationRetryGated()` returns true for 30 seconds.
- **Per-model cooldown**: Failed models are cooled down and skipped in subsequent attempts.
- **Stale context handling**: `agent_end` handlers catch "extension ctx is stale" errors gracefully.
