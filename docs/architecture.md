# Architecture

pi-blackhole merges deterministic algorithmic compaction with session-surviving observational memory into one Pi extension. VCC handles compaction; OM handles the memory layer.

The entry point is `index.ts` (default export factory registered via `pi.extensions`).

## Design philosophy

The core insight: Pi's native LLM compaction erodes detail after repeated cycles. pi-blackhole replaces it with deterministic extraction plus a surviving memory layer.

Five architectural pillars define the extension:

1. **Deterministic compaction** — The [[vcc-compaction#compile pipeline]] extracts structured sections (goals, files, commits, preferences, brief transcript) using regex heuristics. No LLM, no hallucination, no API cost.
2. **Observational memory** — Three [[observational-memory#The three workers|background workers]] (Observer, Reflector, Dropper) capture timestamped observations and durable reflections in a session ledger that persists across compactions.
3. **Unified configuration** — One JSON file (`~/.pi/agent/pi-blackhole/pi-blackhole-config.json`) replaces two upstream configs. See [[config#Unified configuration]].
4. **Per-worker model fallback** — Each OM worker has a primary model and ordered fallback list with persisted cooldowns. See [[observational-memory#Model resolution]].
5. **Graceful degradation** — Failed stages skip silently; the pipeline retries on the next trigger. A 30-second retry gate prevents hammering failing APIs.

## Module map

The codebase is organized into VCC core pipeline (`src/core/`, `src/extract/`), observational memory (`src/om/`), commands (`src/commands/`), tools (`src/tools/`), and hooks (`src/hooks/`).

```
index.ts                      # Entry point — registers hooks/commands/tools, provider stream bridge
src/
  types.ts                    # NormalizedBlock, FileOps shared types
  details.ts                  # PiVccCompactionDetails type
  sections.ts                 # SectionData interface
  core/                       # VCC compaction pipeline
    load-messages.ts          # JSONL session loading with LRU cache
    normalize.ts              # Raw messages → NormalizedBlock[]
    filter-noise.ts           # Remove thinking blocks, noise tools, XML wrappers
    build-sections.ts         # Orchestrate section extraction
    summarize.ts              # compile() entry point — pipeline orchestrator
    format.ts                 # Format SectionData → readable summary
    format-recall.ts          # Recall output formatting
    brief.ts                  # Compressed transcript builder with token counting
    content.ts                # Text utilities (clip, snippet, path detection)
    drill-down.ts             # #N:path file content extraction
    search-entries.ts         # BM25 + regex search
    render-entries.ts         # Message → RenderedEntry
    sanitize.ts               # ANSI/control char stripping
    lineage.ts                # Active lineage entry ID extraction
    recall-scope.ts           # scope:lineage|all, mode:hybrid|file|touched parsing
    skill-collapse.ts         # <skill> tag → [skill: X]
    tool-args.ts              # Tool argument extraction
    unified-config.ts         # Unified config loading/merging/migration
    settings.ts               # Config scaffolding wrapper
  extract/                    # Section extraction modules
    goals.ts                  # Extract task goals/scope changes
    files.ts                  # Track file activity (read/modified/created)
    preferences.ts            # Extract user preferences
    commits.ts                # Extract git commits
  hooks/
    before-compact.ts         # session_before_compact hook — VCC + OM injection
  om/                         # Observational memory system
    runtime.ts                # Central runtime, model resolution, cooldown
    consolidation.ts          # Observer → Reflector → Dropper pipeline
    compaction-trigger.ts     # agent_end → auto-compaction
    config.ts                 # OM config re-exports
    pending.ts                # Per-session pending state (manual mode)
    model-budget.ts           # Token budget / context window estimation
    cooldown.ts               # Model cooldown persistence
    provider-stream.ts        # Provider stream bridge for jiti agents
    retryable-error.ts        # Retryable error detection
    reverse-recall.ts         # OM id → session entry reverse lookup
    serialize.ts              # Branch entry serialization
    tokens.ts                 # Token counting
    ids.ts                    # ID generation
    clipboard.ts              # Clipboard helpers
    configure-overlay.ts      # Interactive config overlay TUI
    status-overlay.ts         # Status display overlay TUI
    key-matcher.ts            # Key matching for overlay
    debug-log.ts              # JSONL debug logging
    agents/
      observer/               # Observer agent (agent.ts, prompts.ts)
      reflector/              # Reflector agent (agent.ts, prompts.ts)
      dropper/                # Dropper agent (agent.ts, coverage.ts, prompts.ts)
    ledger/
      types.ts                # Entry, Observation, Reflection types + validators
      fold.ts                 # Ledger folding (dedup + tombstones)
      projection.ts           # Projection slicing (visible/full/compaction)
      render-summary.ts       # Format observations/reflections for output
      recall.ts               # Ledger recall/search
      progress.ts             # Token counting / coverage tracking
  commands/
    pi-vcc.ts                 # /blackhole command
    memory.ts                 # /blackhole-memory command
    vcc-recall.ts             # /blackhole-recall command
  tools/
    recall.ts                 # Unified recall tool
```

## Data flow

The extension intercepts two lifecycle events and provides three user-facing commands plus one agent-facing tool.

```
[Pi session messages]
      │
      ├──> OM Workers (background, agent_start + turn_end)
      │    Observer → extracts timestamped observations
      │    Reflector → synthesizes durable reflections
      │    Dropper → prunes low-value observations
      │         │
      │         v
      │    [Session Ledger] (observations + reflections)
      │
      ├──> Auto-compaction trigger (agent_end)
      │    tokens >= compactAfterTokens → ctx.compact()
      │
      └──> session_before_compact hook
           VCC compile() → structured summary
           + OM injection (reflections + observations from ledger)
           → Replacement block sent to agent
```

### Lifecycle hooks

The extension registers five lifecycle hooks via `pi.on()`:

- **`agent_start`** — Triggers [[observational-memory#Consolidation pipeline|consolidation]] check (are any workers due?) and aborts pending auto-compaction from the previous turn.
- **`turn_end`** — Same consolidation check as `agent_start`.
- **`agent_end`** — Evaluates [[observational-memory#Compaction trigger|auto-compaction threshold]]. If tokens exceed `compactAfterTokens`, schedules `ctx.compact()` after the agent becomes idle.
- **`session_before_compact`** — The central hook. Runs VCC `compile()` and appends OM content. See [[vcc-compaction#before-compact hook]].
- **`session_compact_failed`** — Failure visibility for aborted/failed compactions: structured trace, `compactInFlight` reset, overflow-retry notification, and attribution fix. Available from pi 0.84.3. See [[observational-memory#Compaction trigger#Compact-failure handling]].

## Key types

Core data structures shared across the VCC pipeline and OM system.

### NormalizedBlock

Discriminated union representing one part of a parsed session message. Defined in [[src/types.ts]].

```typescript
type NormalizedBlock =
  | { kind: "user"; text: string; sourceIndex?: number }
  | { kind: "assistant"; text: string; sourceIndex?: number }
  | { kind: "tool_call"; name: string; args: Record<string, unknown>; sourceIndex?: number }
  | { kind: "tool_result"; name: string; text: string; isError: boolean; sourceIndex?: number }
  | { kind: "bash"; command: string; output: string; exitCode: number | undefined; sourceIndex?: number }
  | { kind: "thinking"; text: string; redacted: boolean; sourceIndex?: number };
```

### SectionData

Structured summary data produced by `buildSections()`. Defined in [[src/sections.ts]].

```typescript
interface SectionData {
  sessionGoal: string[];
  outstandingContext: string[];
  filesAndChanges: string[];
  commits: string[];
  userPreferences: string[];
  briefTranscript: string;
}
```

### Observation

Timestamped fact extracted by the Observer worker. Defined in [[src/om/ledger/types.ts]].

```typescript
interface Observation {
  id: string;           // 12-char hex
  content: string;
  timestamp: string;    // ISO date
  relevance: "low" | "medium" | "high" | "critical";
  sourceEntryIds: string[];
  tokenCount: number;
}
```

### Reflection

Durable insight synthesized by the Reflector from observations. Defined in [[src/om/ledger/types.ts]].

```typescript
interface Reflection {
  id: string;                      // 12-char hex
  content: string;                 // single line, no newlines
  supportingObservationIds: string[];
  tokenCount: number;
}
```

### Runtime

Central OM runtime managing model resolution, consolidation lifecycle, cooldown integration, and error tracking. Defined in [[src/om/runtime.ts]]. Holds in-memory state: config, cursors, error timestamps, in-flight flags, compaction stats.

## Provider stream bridge

The extension's consolidation agents are loaded via `jiti` with `moduleCache: false`, creating a separate `pi-ai` instance whose `apiProviderRegistry` lacks custom providers registered by other extensions (e.g., `claude-bridge`).

The bridge solves this with two mechanisms:

1. **Wrap `pi.registerProvider`** — Captures `streamSimple` functions at registration time into a `Symbol.for("pi-blackhole:provider-streams")` global Map. Handles providers registered after pi-blackhole's factory runs.
2. **`agent_start` scan** — On first agent start, scans `modelRegistry.registeredProviders` for providers that registered before pi-blackhole loaded. Uses `hasScannedFallback` flag to run once.

The `createBridgeStreamFn()` in [[src/om/provider-stream.ts]] lets jiti-loaded agents access these custom providers without going through pi-ai's registry.

## Upstream lineage

pi-blackhole carries DNA from both upstreams but has diverged significantly. A lockstep audit system (`.pi/skills/lockstep/`) classifies each upstream commit for porting decisions.

- **From pi-vcc**: The `compile()` pipeline, section extraction, recall core — `src/core/` and `src/extract/` modules are largely unmodified from upstream.
- **From pi-observational-memory**: Session-ledger-based observation/reflection capture, memory agents, ledger folding — `src/om/ledger/` is unmodified, `src/om/runtime.ts` and `src/om/consolidation.ts` are modified for fallback chains.
- **pi-blackhole additions**: Unified config, per-worker model fallback with cooldowns, manual flush mode, memory toggle, per-session pending state, provider stream bridge, retryable error detection, improved prompts, OM-recall coupling, thinking level support.
