# Configuration Reference — New Config Surface

Pi-blackhole's configuration lives at `~/.pi/agent/pi-blackhole/pi-blackhole-config.json`. This document describes the new unified config keys introduced by the config simplification.

## Quick Reference

```jsonc
{
  // ── Compaction ──
  "compaction": "auto",           // "auto" | "manual" | "off"
  "compactionEngine": "blackhole", // "blackhole" | "pi-default"
  "tailBehavior": "minimal",   // "pi-default" | "minimal"
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

Controls which engine handles auto-compaction summaries. Only meaningful when `compaction: "auto"` — for `"manual"`/`"off"` the engine is irrelevant because blackhole's hook lets Pi handle everything except `/blackhole`.

Replaces the old `overrideDefaultCompaction`.

| Value | Behavior |
|-------|----------|
| `"blackhole"` | Blackhole's `compile()` generates a structured summary and injects OM content (default). Also controls WHEN to compact (triggers at `compactAfterTokens`). |
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
