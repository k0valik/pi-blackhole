# Configuration Reference — New Config Surface

Pi-blackhole's configuration lives at `~/.pi/agent/pi-blackhole/pi-blackhole-config.json`. This document describes the new unified config keys introduced by the config simplification.

## Config file safety

The config file must contain **valid JSON**. A trailing comma, partial write, or sync-conflict copy will cause the entire file to be rejected — and previously, the overlay would silently fall back to defaults and then overwrite your model configs on save.

**Current behavior:**
- Invalid JSON is logged as a warning and surfaced as a yellow notification in the TUI
- The `/blackhole configure` overlay shows a red error banner and **blocks Ctrl+S** until the file is fixed
- The overlay preserves unknown keys (e.g. `observerModel`, `reflectorModel`) on valid files — only keys in the overlay's field list are managed there
- Changes made via the overlay take effect **immediately** — no session restart needed (the runtime reloads config from disk after save)

**If your config gets corrupted:** fix the JSON syntax directly in the file, then reopen the overlay.

## Quick Reference

```jsonc
{
  // ── Compaction ──
  "compaction": "auto",           // "auto" | "manual" | "off"
  "compactionEngine": "blackhole", // "blackhole" | "pi-default"
  "tailBehavior": "minimal",   // "pi-default" | "minimal"
  "midRunCompaction": "off",    // "resume" | "pause" | "off" (default: off)
  "compactionSummaryMode": "default", // "default" | "append" (default: "default")
  "compactAfterTokens": 81000,    // Token threshold for auto-compaction

  // ── Observational Memory ──
  "memory": true,                 // Enable OM workers + content injection
  "sessionFallback": true,        // Fall back to session model when OM models fail
  "fullFoldAlways": true,         // Treat first compaction as full-fold boundary
  "observeAfterTokens": 15000,    // Token threshold for observer runs
  "reflectAfterTokens": 25000,    // Token threshold for reflector + dropper
  "observationsPoolMaxTokens": 20000, // Observation pool token ceiling
  "observationsPoolTargetTokens": 10000, // Target after dropper prune (no-op)
  "reflectorInputMaxTokens": 80000, // Reflector prompt token cap
  "dropperInputMaxTokens": 80000,  // Dropper prompt token cap
  "observerChunkMaxTokens": 40000, // Max source tokens per observer chunk
  "observerPreambleMaxTokens": 0,  // Preamble budget (0 = auto 30% of chunk)
  "dropperPressureThreshold": 0.70, // Pool-pressure relief valve
  "dropperPoolFullnessThreshold": 0.10, // Min pool fullness before dropper runs
  "agentMaxTurns": 16,            // Max turns per memory agent
  "providerIdleTimeoutMs": 0,     // Background provider idle timeout in ms (0 = disabled, unset = inherit pi default)

  // ── Model configs (edit by hand) ──
  "model": { "provider": "...", "id": "..." },
  "observerModel": { "provider": "...", "id": "..." },
  "reflectorModel": { "provider": "...", "id": "..." },
  "dropperModel": { "provider": "...", "id": "..." },
  "observerFallbackModels": [ { "provider": "...", "id": "..." } ],
  "reflectorFallbackModels": [ { "provider": "...", "id": "..." } ],
  "dropperFallbackModels": [ { "provider": "...", "id": "..." } ],

  // ── Debug ──
  "debug": false,                 // Write debug snapshots to /tmp
  "debugLog": false               // Write debug JSONL to agent directory
}
```

## Compaction Section

### `compaction`

Controls when compaction triggers. Replaces the old `noAutoCompact` and partially replaces `passive`.

| Value | Auto-trigger | `/compact` (Pi built-in) | `/blackhole` |
|-------|:---:|:---:|:---:|
| `"auto"` | blackhole fires at `compactAfterTokens` threshold ✓ | blackhole handles | blackhole handles |
| `"manual"` | skipped | Pi handles ✓ | blackhole handles |
| `"off"` | skipped (Pi handles) | Pi handles ✓ | blackhole handles |

**Examples:**

```jsonc
// Auto-compact (default)
{ "compaction": "auto" }

// Manual only — /compact falls through to Pi, /blackhole uses blackhole pipeline
{ "compaction": "manual" }

// Blackhole skips auto + /compact (Pi handles both), /blackhole still works
{ "compaction": "off" }
```

### `compactionEngine`

Controls which engine generates compaction summaries. Only meaningful when `compaction: "auto"` — for `"manual"`/`"off"` the engine is irrelevant because blackhole's hook lets Pi handle everything except `/blackhole`.

Replaces the old `overrideDefaultCompaction`.

| Value | Behavior |
|-------|----------|
| `"blackhole"` | Blackhole's `compile()` generates a structured summary and injects OM content (default). |
| `"pi-default"` | Pi handles ALL compaction (timing + execution). Blackhole's trigger skips entirely. Blackhole only activates for `/blackhole` command. |

**Interaction matrix:**

| `compaction` | `compactionEngine` | Auto-trigger | `/compact` | `/blackhole` |
|:---:|:---:|---|---|---|
| auto | blackhole | blackhole fires at `compactAfterTokens` ✓ | blackhole handles | blackhole handles |
| auto | pi-default | trigger skips (Pi decides when) | Pi handles | blackhole handles |
| manual | (any) | skipped | Pi handles ✓ | blackhole handles |
| off | (any) | skipped | Pi handles ✓ | blackhole handles |

### `tailBehavior`

Controls how much of the recent transcript stays *visible* after compaction. Only applies when `compactionEngine: "blackhole"`.

| Value | Behavior |
|-------|----------|
| `"pi-default"` | Use Pi's `firstKeptEntryId` — respects Pi's `keepRecentTokens` (~20k tokens kept). Messages before Pi's cut are compiled into the summary and removed from view. |
| `"minimal"` | Keep only the last user message, unless Pi provides a later safe split-turn boundary for an oversized current turn. Everything before the chosen boundary gets compiled and removed (default for both auto-triggered and manual `/blackhole`). |

**Visual comparison:**

```
pi-default (Pi's cut at m3):
  Branch:  [m1] [m2] [m3] [m4] [m5] [m6]
            ──compiled──  ─────visible─────
                          (Pi's keepRecentTokens)

minimal (last user at m5):
  Branch:  [m1] [m2] [m3] [m4] [m5] [m6]
            ─────compiled──────  ─visible─
                                 (last user only)
```

**Effective behavior (how the hook resolves it):**

| Invocation | `tailBehavior` config | Effective |
|------------|:--------------------:|:---------:|
| Manual `/blackhole` | not set | `"minimal"` (aggressive) |
| Manual `/blackhole` | `"pi-default"` | `"pi-default"` |
| Auto-triggered | not set | `"minimal"` (aggressive) |
| Auto-triggered | `"minimal"` | `"minimal"` |

**Examples:**

```jsonc
// Always use aggressive cut (both auto and manual — default)
{ "tailBehavior": "minimal" }

// Use Pi's gentler cut for both auto and manual
{ "tailBehavior": "pi-default" }
```

### `midRunCompaction`

Controls the **mid-run** auto-compaction trigger. Pi's `agent_end` event only fires when a run exits — during long tool loops (agent calling tools turn after turn) the threshold would otherwise never be evaluated, and accumulated tokens could blow far past `compactAfterTokens` before compaction had any chance to run. This trigger evaluates the threshold at every `turn_end` (after each assistant message + tool executions) while the agent is still working.

Only applies when `compaction: "auto"` and `compactionEngine: "blackhole"`.

| Value | Behavior |
|-------|----------|
| `"resume"` *(experimental)* | Compact transparently at an awaited `turn_end`, then continue inside the **same** agent run and outer `session.prompt()` promise. No run abort and no synthetic continuation message. |
| `"pause"` | Use Pi's native interrupting `ctx.compact()` at the threshold, then stop. The user continues manually. |
| `"off"` | No mid-run evaluation; only check the threshold when the agent finishes a run (default). |

`"resume"` reuses Pi's native summary, `session_before_compact`, session-entry, and context-rebuild pipeline. Blackhole's runtime adapter suppresses only the compaction method's initial internal quiesce (`abort`, plus disconnect on older Pi), then refreshes the low-level loop from the compacted `agent.state.messages` before another provider request. Completed tools stay paired, the active run signal is not aborted, background agents do not receive a false interrupt, and nested runners keep awaiting their original prompt promise.

**Compatibility is fail-closed.** The adapter recognizes the known Pi 0.81 legacy and Pi 0.84 connected-listener compact shapes. If Pi internals drift, `"resume"` refuses the mid-run attempt, leaves the current run alive, reports the incompatibility, and suspends retries at that pressure level. It never falls back to the old abort + `blackhole-resume` path.

`"pause"` is intentionally different: it calls public `ctx.compact()`, which aborts the active run by design. That abort may propagate to extensions which treat the run signal as user cancellation, so use `"resume"` for transparent/subagent workflows.

**Re-trigger safety:** after a successful compaction, accumulated tokens are counted from the fresh compaction entry. Failed or cancelled attempts are suspended until pressure drops below the threshold.

```jsonc
// Default: only evaluate when the run ends
{ "midRunCompaction": "off" }

// Opt in to transparent same-run compaction during long tool loops
{ "midRunCompaction": "resume" }

// Interrupt the run, compact, and hand control back to the user
{ "midRunCompaction": "pause" }
```

### `compactAfterTokens`

Token threshold for auto-compaction. When `compaction: "auto"` and accumulated tokens since the last compaction exceed this threshold, compaction triggers automatically — both mid-run (see `midRunCompaction`) and when the agent finishes a run. If the engine is `pi-default`, blackhole's trigger returns early before checking tokens.

| Type | Default |
|------|---------|
| number | 81000 |

**The interaction with Pi's threshold:** Pi has its own `keepRecentTokens` default (~20k tokens). Blackhole's threshold is independent — it's the trigger point, not the keep point. When blackhole's trigger fires, `tailBehavior` determines how much is actually kept visible.

## Observational Memory Section

### `memory`

Controls whether observational memory workers run and whether OM content is injected into compaction summaries. **Notably, `memory: false` no longer blocks auto-compaction** — compaction and memory are truly orthogonal.

| Value | Behavior |
|-------|----------|
| `true` | OM workers run (observer, reflector, dropper). OM content injected into compaction summaries (default) |
| `false` | No OM workers. No OM content. Compaction still runs normally |

**Examples:**

```jsonc
// Full OM (default)
{ "memory": true }

// Compaction only, no OM workers
{ "memory": false, "compaction": "auto", "compactionEngine": "blackhole" }
```

### `sessionFallback`

When `false`, skip the session-model fallback when all OM model candidates are exhausted. The stage is skipped entirely instead of falling back to the main coding model.

| Type | Default |
|------|---------|
| boolean | `true` |

### `fullFoldAlways`

Treat every compaction as a full-fold boundary so early reflections/drops survive the first compaction in a fresh session.

| Type | Default |
|------|---------|
| boolean | `true` |

### `observeAfterTokens`, `reflectAfterTokens`

Token thresholds that control when the OM pipeline runs. Unchanged from the previous config.

| Key | Default |
|-----|---------|
| `observeAfterTokens` | 15000 |
| `reflectAfterTokens` | 25000 |

### `observationsPoolMaxTokens`

Hard ceiling for the active observation pool. The dropper prunes when this ceiling is reached.

| Type | Default |
|------|---------|
| number | 20000 |

### `observationsPoolTargetTokens`

Target token budget the dropper aims for after pruning. **Currently a no-op** in the pool algorithm. If unset or `>= observationsPoolMaxTokens`, the loader silently resets it to `floor(observationsPoolMaxTokens / 2)`.

| Type | Default |
|------|---------|
| number | 10000 |

### `reflectorInputMaxTokens`

Rolling window cap for reflector prompt tokens. The reflector only sees **new** observations plus a summary budget, capped at this value.

| Type | Default |
|------|---------|
| number | 80000 |

### `dropperInputMaxTokens`

Rolling window cap for dropper prompt tokens.

| Type | Default |
|------|---------|
| number | 80000 |

### `observerChunkMaxTokens`

Max source-entry tokens sent to the observer per chunk.

| Type | Default |
|------|---------|
| number | 40000 |

### `observerPreambleMaxTokens`

Max preamble tokens (`CURRENT REFLECTIONS` / `OBSERVATIONS`) in the observer prompt. Default `0` means auto-compute from `observerChunkMaxTokens` (30%). Only applied in `noAutoCompact` mode where accumulated batch history can grow unbounded.

| Type | Default |
|------|---------|
| number | 0 |

### `dropperPressureThreshold`

Fraction of `reflectorInputMaxTokens` at which the dropper runs even without new observation or reflection data. This is a **pool-size pressure valve**: when the active observation pool exceeds this fraction of `reflectorInputMaxTokens`, the dropper fires to keep the pool pruned. The reflector's own input is capped separately by `reflectorInputMaxTokens` and only includes new items plus a summary budget.

| Type | Default | Range |
|------|---------|-------|
| number | 0.70 | (0, 1] |

### `dropperPoolFullnessThreshold`

Minimum observation-pool fullness (fraction of `observationsPoolMaxTokens`) before the dropper may run. Prevents the dropper from churning a nearly empty pool. Once the pool passes this threshold, the dropper runs when enough new transcript accumulates (`reflectAfterTokens`) with new observations/reflections. Lower it (e.g. `0.05`) to have the dropper prune more eagerly on lean pools.

| Type | Default | Range |
|------|---------|-------|
| number | 0.10 | (0, 1] |

- **0.70** (default): dropper fires when pool reaches 70% of `reflectorInputMaxTokens` — leaves 30% headroom for system prompts, tool scaffolding, and reflection summaries
- **Higher** (e.g. 0.90): less aggressive pruning, more headroom needed from your model
- **Lower** (e.g. 0.50): more aggressive pruning, useful with smaller models or free-tier context windows
- **1.0**: disable pressure-driven dropper entirely — dropper only runs when new observation/reflection data exists AND the pool is ≥10% full

### `agentMaxTurns`

Shared turn cap for background memory agents. It is passed as `maxTurns` to `runObserver`, `runReflector`, and `runDropper` agent loops, capping retry/reasoning iterations within a single stage execution.

| Type | Default |
|------|---------|
| number | 16 |

### `providerIdleTimeoutMs`

Body-idle timeout for background provider streams (observer/reflector/dropper worker HTTP requests). Higher values let background memory jobs tolerate longer silent provider intervals without forcing interactive Pi requests to wait equally long. Applied by wrapping the provider `fetch` with an undici dispatcher that injects `bodyTimeout`.

- **unset** — inherit pi's global provider timeout (no wrapper applied).
- **`0`** — explicitly disabled (no wrapper applied).
- **`> 0`** — wait up to this many milliseconds for a response body after the request is sent.

Accepted via plain config or `PI_BLACKHOLE_PROVIDER_IDLE_TIMEOUT_MS`. Negative values are rejected. WebSocket transports are not affected.

| Type | Default | Range |
|------|---------|-------|
| number | unset | `0` or positive integer |

## Model Configuration

Model overrides are **first-class config keys**, not "unknown keys". They are fully parsed and validated by `loadUnifiedConfig()` and are **only editable via direct file edit** (the `/blackhole configure` overlay preserves them but does not surface them).

### Primary models

| Key | Description |
|-----|-------------|
| `model` | Base model override for all memory workers. Tried after stage-specific models and fallbacks. |
| `observerModel` | Primary observer model (most frequent worker). |
| `reflectorModel` | Primary reflector model (synthesizes durable facts). |
| `dropperModel` | Primary dropper model (prunes observations). |

### Fallback arrays

| Key | Description |
|-----|-------------|
| `observerFallbackModels` | Ordered fallback array for observer, tried after `observerModel`. |
| `reflectorFallbackModels` | Ordered fallback array for reflector, tried after `reflectorModel`. |
| `dropperFallbackModels` | Ordered fallback array for dropper, tried after `dropperModel`. |

### `OmModelConfig` schema

Each model config supports the following fields:

| Field | Type | Description |
|-------|------|-------------|
| `provider` | string | Provider name (required). |
| `id` | string | Model ID (required). |
| `thinking` | enum | Thinking level: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`. Defaults to `"low"` when unset. |
| `cooldownHours` | number | Cooldown duration in hours after a retryable error (429/5xx/timeout). Defaults to `1` when omitted. Set to `0` to disable persistent cooldown. |
| `contextWindow` | number | Override for the model's context window. Inherits from Pi's model registry when unset. |

**Example:**

```jsonc
{
  "observerModel": {
    "provider": "anthropic",
    "id": "claude-sonnet-4-20250514",
    "thinking": "low",
    "cooldownHours": 2,
    "contextWindow": 200000
  },
  "observerFallbackModels": [
    { "provider": "openai", "id": "gpt-4o", "thinking": "minimal" }
  ]
}
```

## Debug Section

### `debug` / `debugLog`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `debug` | boolean | false | Writes detailed debug snapshots to `/tmp/pi-blackhole-debug.json` |
| `debugLog` | boolean | false | Writes structured JSONL debug logs to the agent directory |

## Deprecated Keys

These keys are still accepted for backward compatibility but are silently migrated to the new surface on load. They are removed from the in-memory config object and not written back by the overlay.

| Key | Replacement |
|-----|-------------|
| `overrideDefaultCompaction` | `compactionEngine` + `tailBehavior` |
| `noAutoCompact` | `compaction: "manual"` |
| `passive` | `compaction: "off"` + `memory: false` |

## Environment Variable Overrides

Environment variables override config file values **at load time** and apply to both the runtime and the modal. Invalid values fall back to the configured (or default) value.

Boolean parsing accepts `1`, `true`, `yes`, `on` (and `0`, `false`, `no`, `off`).

### Compaction mode

| Variable | Overrides | Example |
|----------|-----------|---------|
| `PI_BLACKHOLE_COMPACTION` | `compaction` (`auto` \| `manual` \| `off`) | `PI_BLACKHOLE_COMPACTION=manual` |
| `PI_BLACKHOLE_COMPACTION_ENGINE` | `compactionEngine` (`blackhole` \| `pi-default`) | `PI_BLACKHOLE_COMPACTION_ENGINE=pi-default` |
| `PI_BLACKHOLE_MID_RUN_COMPACTION` | `midRunCompaction` (`resume` \| `pause` \| `off`) | `PI_BLACKHOLE_MID_RUN_COMPACTION=resume` |
| `PI_BLACKHOLE_COMPACTION_SUMMARY_MODE` | `compactionSummaryMode` (`default` \| `append`) | `PI_BLACKHOLE_COMPACTION_SUMMARY_MODE=append` |

### Passive mode (legacy)

Sets `compaction: "off"` + `memory: false` when truthy. All three names remain supported:

| Variable | Notes |
|----------|-------|
| `PI_BLACKHOLE_PASSIVE` | Current name |
| `PI_VCC_OM_PASSIVE` | Legacy pi-vcc name |
| `PI_OBSERVATIONAL_MEMORY_PASSIVE` | Legacy pi-observational-memory name |

### Declarative field overrides

Boolean fields:

| Variable | Overrides |
|----------|-----------|
| `PI_BLACKHOLE_MEMORY` | `memory` |
| `PI_BLACKHOLE_DEBUG` | `debug` (debug snapshots) |
| `PI_BLACKHOLE_DEBUG_LOG` | `debugLog` (JSONL logging) |
| `PI_BLACKHOLE_SESSION_FALLBACK` | `sessionFallback` |
| `PI_BLACKHOLE_FULL_FOLD_ALWAYS` | `fullFoldAlways` |

Positive-integer fields (invalid values fall back):

| Variable | Overrides |
|----------|-----------|
| `PI_BLACKHOLE_COMPACT_AFTER_TOKENS` | `compactAfterTokens` |
| `PI_BLACKHOLE_OBSERVE_AFTER_TOKENS` | `observeAfterTokens` |
| `PI_BLACKHOLE_REFLECT_AFTER_TOKENS` | `reflectAfterTokens` |
| `PI_BLACKHOLE_OBSERVATIONS_POOL_MAX_TOKENS` | `observationsPoolMaxTokens` |
| `PI_BLACKHOLE_OBSERVATIONS_POOL_TARGET_TOKENS` | `observationsPoolTargetTokens` |
| `PI_BLACKHOLE_REFLECTOR_INPUT_MAX_TOKENS` | `reflectorInputMaxTokens` |
| `PI_BLACKHOLE_DROPPER_INPUT_MAX_TOKENS` | `dropperInputMaxTokens` |
| `PI_BLACKHOLE_OBSERVER_CHUNK_MAX_TOKENS` | `observerChunkMaxTokens` |
| `PI_BLACKHOLE_OBSERVER_PREAMBLE_MAX_TOKENS` | `observerPreambleMaxTokens` |
| `PI_BLACKHOLE_AGENT_MAX_TURNS` | `agentMaxTurns` |
| `PI_BLACKHOLE_PROVIDER_IDLE_TIMEOUT_MS` | `providerIdleTimeoutMs` |

Float field (must be in `(0, 1]`):

| Variable | Overrides |
|----------|-----------|
| `PI_BLACKHOLE_DROPPER_PRESSURE_THRESHOLD` | `dropperPressureThreshold` |
| `PI_BLACKHOLE_DROPPER_POOL_FULLNESS_THRESHOLD` | `dropperPoolFullnessThreshold` |

### Paths and internals

| Variable | Purpose |
|----------|---------|
| `PI_CODING_AGENT_DIR` | Overrides the pi agent data directory (config lives at `<dir>/pi-blackhole/pi-blackhole-config.json`) |
| `PI_VCC_COMPACT_INSTRUCTION` | Internal sentinel for the pi-default compaction engine — not a user override |

## Complete Examples

### Minimal auto-compact (new config, all defaults)

```json
{
  "compaction": "auto",
  "compactionEngine": "blackhole",
  "tailBehavior": "minimal",
  "memory": true
}
```

### Manual compaction, no OM, aggressive tail

```json
{
  "compaction": "manual",
  "compactionEngine": "blackhole",
  "tailBehavior": "minimal",
  "memory": false
}
```

### Pi's engine, no blackhole involvement

```json
{
  "compaction": "auto",
  "compactionEngine": "pi-default"
}
```

### Fully disabled

```json
{
  "compaction": "off",
  "memory": false
}
```

### Custom OM models with fallbacks

```jsonc
{
  "memory": true,
  "observerModel": {
    "provider": "anthropic",
    "id": "claude-sonnet-4-20250514",
    "thinking": "low"
  },
  "observerFallbackModels": [
    { "provider": "openai", "id": "gpt-4o", "thinking": "minimal" }
  ],
  "reflectorModel": {
    "provider": "google",
    "id": "gemini-2.5-pro",
    "contextWindow": 1000000
  },
  "dropperModel": {
    "provider": "anthropic",
    "id": "claude-haiku-4-20250514",
    "cooldownHours": 0
  }
}
```

## Viewing & Editing

- **Config file**: `~/.pi/agent/pi-blackhole/pi-blackhole-config.json`
- **TUI overlay**: `/blackhole settings` (alias: `/blackhole configure`) — opens an interactive overlay with ↑↓ navigation, Enter to toggle, Ctrl+S to save
- **CLI subcommands**: `/blackhole om-off` / `/blackhole om-on` — toggle memory without editing the file

### `compactionSummaryMode`

Controls how auto-compaction summaries are stored and presented to the model. Only applies when `compaction: "auto"` and `compactionEngine: "blackhole"`. Explicit `/blackhole` triggers independent of this mode and always folds the chain into a clean segment.

| Value | Behavior |
|-------|----------|
| `"default"` | Each auto-compaction replaces the previous summary with a fresh one (rewrite — existing behavior, default). |
| `"append"` | Each auto-compaction appends one immutable provider-visible segment (`S1 \| S2 \| …`). The model sees all prior compaction segments alongside the current conversation. Every stored summary remains a complete fallback. |

**In `append` mode:**
- Auto-compactions append a new segment to the chain; earlier segments stay visible to the model.
- Explicit `/blackhole` rebases the active chain into one clean segment and starts a new chain.
- Legacy v1 summaries (from before this feature) enter through one marked rebase.
- When the projected chain passes half of the model's context window, the next auto-compaction folds it back into one segment.
- A new `context` hook projects segments before each model call and **fails closed to the fallback** on any malformed state.
- Falls back to rewrite surgery once per session when append mode encounters unsupported state.

**Example:**

```jsonc
// Default: each compaction rewrites the summary (existing behavior)
{ "compactionSummaryMode": "default" }

// Append: freeze auto-compaction segments for the model
{ "compactionSummaryMode": "append" }
```

See [`docs/APPEND_COMPACTION.md`](docs/APPEND_COMPACTION.md) for the fallback, branch, observational-memory, and cache-measurement rules.
