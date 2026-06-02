# Migration Guide — Old Config to New Config

This document explains how to migrate from the legacy pi-vcc config keys to the new unified config surface. Migration is **automatic** — old config files continue to work without changes. This document covers what changed and how to update existing configs explicitly.

## What Changed

### Key Replacements

| Old Key | New Key(s) | Why |
|---------|-----------|-----|
| `overrideDefaultCompaction` | `compactionEngine` | "Override" was misleading. The new name says what it does: choose the engine |
| `noAutoCompact` | `compaction` | Double-negative removed. Set `compaction: "manual"` instead |
| `passive` | `compaction` + `memory` | Nuclear switch split into independent concerns |
| (implicit) | `tailBehavior` | Brand new — controls visible transcript length after compaction |

### Semantic Changes

**`memory: false` no longer blocks auto-compaction.** In the old config, `memory: false` was a double gate: it disabled OM workers AND blocked auto-compaction entirely. In the new config, these are independent:

```
Old: memory:false → no OM workers + no auto-compaction
New: memory:false → no OM workers only (compaction still runs)
New: compaction:"manual" → no auto-compaction (memory independent)
New: compaction:"off" → blackhole skips auto, but explicit /blackhole still uses blackhole pipeline
```

If you had `memory: false` and depended on it blocking auto-compaction, you should set `compaction: "manual"` in the new config.

**Tail behavior changed for `overrideDefaultCompaction: true` users.** In the old config, enabling blackhole's compaction (`overrideDefaultCompaction: true`) gave you the aggressive pi-vcc cut (last user message only). In the new config, the default tail behavior for auto-triggered compaction is `"pi-default"` (Pi's gentler ~20k tokens). Migration preserves the aggressive cut for existing users — see the migration table below.

## Migration Mapping

### When migration happens

Migration runs **in memory at config load time**. The on-disk file is never mutated. This means:

- Old config files continue to work unchanged
- Migration is idempotent (old keys are removed from the parsed object, so it only runs once)
- NixOS / read-only config files are unaffected

### Mapping Table

| Old Config | Migration Result | Notes |
|-----------|-----------------|-------|
| `{}` (empty / no file) | `compaction: "auto"`, `compactionEngine: "blackhole"`, `tailBehavior: "minimal"` | New defaults for fresh installs |
| `{ "overrideDefaultCompaction": true }` | `compactionEngine: "blackhole"`, `tailBehavior: "minimal"` | Preserves aggressive cut for existing users |
| `{ "noAutoCompact": true }` | `compaction: "manual"` | `/blackhole` still works |
| `{ "passive": true }` | `compaction: "off"`, `memory: false` | Blackhole disabled; Pi handles compaction normally. Was a nuclear switch in old config |
| `{ "memory": false }` | `memory: false` only | Compaction NOT blocked — add `compaction: "manual"` if needed |
| `{ "overrideDefaultCompaction": true, "noAutoCompact": true }` | `compactionEngine: "blackhole"`, `compaction: "manual"`, `tailBehavior: "minimal"` | Combined migration |
| `{ "overrideDefaultCompaction": true, "passive": true }` | `compactionEngine: "blackhole"`, `compaction: "off"`, `memory: false` | Passive wins for compaction |

### When migration does NOT happen

If new keys are present in the config file, no migration runs. New keys take priority.

```jsonc
// Mixed: new keys win, old keys ignored
{
  "overrideDefaultCompaction": true,  // ignored
  "compaction": "manual"              // wins
}
```

## Step-by-Step Migration

### Step 1: Check your current config

```bash
cat ~/.pi/agent/pi-blackhole/pi-blackhole-config.json
```

If you have old keys like `overrideDefaultCompaction`, `noAutoCompact`, or `passive`, migration will handle them automatically. You don't need to change anything.

### Step 2: Optional — Update to new keys

To explicitly adopt the new config, replace old keys with new ones using the mapping table above.

**Before (old config):**
```json
{
  "overrideDefaultCompaction": true,
  "noAutoCompact": false,
  "passive": false,
  "memory": true,
  "compactAfterTokens": 95000
}
```

**After (new config) — same behavior:**
```json
{
  "compaction": "auto",
  "compactionEngine": "blackhole",
  "tailBehavior": "minimal",
  "memory": true,
  "compactAfterTokens": 95000
}
```

Note `tailBehavior: "minimal"` — this preserves the aggressive cut you had before.

### Step 3: Optional — Switch to Pi's gentler cut

If you prefer Pi's default behavior (keep ~20k tokens visible), change `tailBehavior`:

```json
{
  "compaction": "auto",
  "compactionEngine": "blackhole",
  "tailBehavior": "pi-default",
  "memory": true
}
```

### Step 4: Verify

Open the config overlay to see your current settings:

```
/blackhole configure
```

Or check the status overlay:

```
/blackhole-memory
```

## Common Scenarios

### "I had `overrideDefaultCompaction: true` and want the same behavior"

Migration handles this: `compactionEngine: "blackhole"`, `tailBehavior: "minimal"`. Your aggressive cut is preserved.

To explicitly confirm in config:
```json
{ "compactionEngine": "blackhole", "tailBehavior": "minimal" }
```

### "I had `memory: false` and want NO auto-compaction"

Old behavior: `memory: false` blocked auto-compaction *and* disabled OM.

New config to match:
```json
{ "memory": false, "compaction": "manual" }
```

Or if you want truly no compaction at all:
```json
{ "memory": false, "compaction": "off" }
```

### "I want Pi's default compaction back (no blackhole)"

```json
{ "compactionEngine": "pi-default" }
```

Blackhole's auto-trigger will return early and let Pi handle compaction. If you also want the trigger disabled:
```json
{ "compaction": "manual", "compactionEngine": "pi-default" }
```

### "I want the aggressive pi-vcc cut for /blackhole but gentle Pi cut for auto"

This is the current default. Both auto-triggered and `/blackhole` use `"minimal"`:
- Auto-triggered → `tailBehavior: "minimal"` (always aggressive)
- `/blackhole` → `tailBehavior: "minimal"` (aggressive)

### "I want backup before migrating"

Config files are never mutated by migration. Migration runs on the **in-memory parsed object**. Your on-disk config file is untouched. To be extra safe:

```bash
cp ~/.pi/agent/pi-blackhole/pi-blackhole-config.json ~/.pi/agent/pi-blackhole/pi-blackhole-config.json.bak
```

## NixOS / Read-Only Filesystem Notes

- Migration is purely in-memory — no writes to disk
- The old config file remains exactly as-is on disk
- Environment variables can override the new keys without touching the file
- The `/blackhole om-off` / `om-on` subcommands try to save but handle failure gracefully
