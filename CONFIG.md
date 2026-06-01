# Configuration Reference — New Config Surface

Pi-blackhole's configuration lives at `~/.pi/agent/pi-blackhole/pi-blackhole-config.json`. This document describes the new unified config keys introduced by the config simplification.

## Quick Reference

```jsonc
{
  // ── Compaction ──
  "compaction": "auto",           // "auto" | "manual" | "off"
  "compactionEngine": "blackhole", // "blackhole" | "pi-default"
  "tailBehavior": "pi-default",   // "pi-default" | "minimal"
  "compactAfterTokens": 81000,    // Token threshold for auto-compaction

  // ── Observational Memory ──
  "memory": true,                 // Enable OM workers + content injection
  "observeAfterTokens": 15000,    // Token threshold for observer runs
  "reflectAfterTokens": 25000,    // Token threshold for reflector + dropper
  "agentMaxTurns": 16,            // Max turns per memory agent

  // ── Debug ──
  "debug": false,                 // Write debug snapshots to /tmp
  "debugLog": false               // Write debug JSONL to agent directory
}
```

## Compaction Section

### `compaction`

Controls when compaction triggers. Replaces the old `noAutoCompact` and partially replaces `passive`.

| Value | Behavior |
|-------|----------|
| `"auto"` | Triggers automatically when `compactAfterTokens` threshold is reached (default) |
| `"manual"` | Only via `/blackhole` command. Auto-triggered compaction is blocked |
| `"off"` | Blackhole skips auto-triggered compaction (Pi handles), but explicit `/blackhole` still uses blackhole's pipeline |

**Examples:**

```jsonc
// Auto-compact (default)
{ "compaction": "auto" }

// Manual only — user runs /blackhole when they want to compact
{ "compaction": "manual" }

// Blackhole skips auto, but /blackhole still works
{ "compaction": "off" }
```

### `compactionEngine`

Controls which engine handles the compaction summary generation. Replaces the old `overrideDefaultCompaction`.

| Value | Behavior |
|-------|----------|
| `"blackhole"` | Blackhole's `compile()` function generates a structured summary and injects observational memory content (default) |
| `"pi-default"` | Pi's built-in summarization handles everything. Blackhole runs no summary logic |

**Examples:**

```jsonc
// Blackhole handles compaction (default)
{ "compactionEngine": "blackhole" }

// Pi handles compaction — blackhole only adds memory content if memory:true
{ "compactionEngine": "pi-default" }
```

**Interaction with auto/manual:**

| compaction | compactionEngine | Result |
|:---:|:---:|--------|
| auto | blackhole | Auto-trigger → blackhole pipeline + OM injection |
| auto | pi-default | Auto-trigger → Pi handles it (blackhole returns early) |
| manual | blackhole | Only `/blackhole` → blackhole pipeline |
| manual | pi-default | Only `/blackhole` → Pi-default compaction |
| off | blackhole | Auto → Pi handles. `/blackhole` → blackhole pipeline |
| off | pi-default | Auto → Pi handles. `/blackhole` → Pi default |

### `tailBehavior`

Controls how much of the recent transcript stays *visible* after compaction. Only applies when `compactionEngine: "blackhole"`.

| Value | Behavior |
|-------|----------|
| `"pi-default"` | Use Pi's `firstKeptEntryId` — respects Pi's `keepRecentTokens` (~20k tokens kept). Messages before Pi's cut are compiled into the summary and removed from view (default for auto-triggered) |
| `"minimal"` | Keep only the last user message. Everything before gets compiled and removed. Same as the original pi-vcc behavior (default for manual `/blackhole`) |

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
| Auto-triggered | not set | `"pi-default"` (gentle) |
| Auto-triggered | `"minimal"` | `"minimal"` |

**Examples:**

```jsonc
// Use Pi's gentler cut for auto, aggressive for /blackhole (default)
{ "tailBehavior": "pi-default" }

// Always use aggressive cut (both auto and manual)
{ "tailBehavior": "minimal" }
```

### `compactAfterTokens`

Token threshold for auto-compaction. When `compaction: "auto"` and accumulated tokens since the last compaction exceed this threshold, compaction triggers automatically.

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

### `observeAfterTokens`, `reflectAfterTokens`, `agentMaxTurns`

These control the OM pipeline thresholds. Unchanged from the previous config.

### `agentLoopReserve`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `agentLoopReserve` | number | `8000` | Tokens reserved in context window for agent loop overhead (system prompt, tools, turn overhead). Used by the context window pre-check — before calling an OM agent, blackhole checks if the estimated input (stage cap + reserve) fits in the model's effective context window. If not, the next fallback is tried. |

## Debug Section

### `debug` / `debugLog`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `debug` | boolean | false | Writes detailed debug snapshots to `/tmp/pi-blackhole-debug.json` |
| `debugLog` | boolean | false | Writes structured JSONL debug logs to the agent directory |

## Environment Variable Overrides

Environment variables override config file values at load time:

| Variable | Overrides | Example |
|----------|-----------|---------|
| `PI_BLACKHOLE_PASSIVE` | Sets `compaction: "off"` + `memory: false` | `PI_BLACKHOLE_PASSIVE=1` |
| `PI_BLACKHOLE_COMPACTION` | Overrides `compaction` | `PI_BLACKHOLE_COMPACTION=manual` |
| `PI_BLACKHOLE_COMPACTION_ENGINE` | Overrides `compactionEngine` | `PI_BLACKHOLE_COMPACTION_ENGINE=pi-default` |

Legacy env vars still supported: `PI_VCC_OM_PASSIVE`, `PI_OBSERVATIONAL_MEMORY_PASSIVE`.

## Complete Examples

### Minimal auto-compact (new config, all defaults)

```json
{
  "compaction": "auto",
  "compactionEngine": "blackhole",
  "tailBehavior": "pi-default",
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

## Viewing & Editing

- **Config file**: `~/.pi/agent/pi-blackhole/pi-blackhole-config.json`
- **TUI overlay**: `/blackhole configure` — opens an interactive overlay with ↑↓ navigation, Enter to toggle, Ctrl+S to save
- **CLI subcommands**: `/blackhole om-off` / `/blackhole om-on` — toggle memory without editing the file
