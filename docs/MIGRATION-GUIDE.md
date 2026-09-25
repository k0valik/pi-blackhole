# Upgrade guide — config surface reorg

This release gives the settings surface outcome-level labels and folds several
redundant or dead keys. It is a **config-schema change**, not a rewrite of
blackhole's behavior: the defaults and the pipeline are unchanged, and existing
files are **migrated on disk automatically** at startup. This document lists
what moved, what was removed, and how the automatic migration works.

> If you only ever used the modal (`/blackhole settings`) and never hand-edited
> the JSON, you need to do nothing — the migration runs before the modal reads
> the file. Open the settings once after upgrading to review the new labels.

## TL;DR

| You had…                                    | It becomes…                                              |
| ------------------------------------------- | -------------------------------------------------------- |
| `compactionEngine: "blackhole"`             | `compaction: "automatic"`                                |
| `compactionEngine: "pi-default"`            | `compaction: "off"`                                      |
| `compaction: "auto"`                        | `compaction: "automatic"`                                |
| `compaction: "manual"` / `"off"`            | unchanged                                                |
| `compactionAfterRatio: 0.46` (a fraction)   | `compactAfterRatio: 46` (a percent) + `compactAfterBy: "percent"` |
| `compactAfterTokens: 120000`                | unchanged + `compactAfterBy: "tokens"`                   |
| `compactReserveTokens: 32768`               | unchanged + `compactAfterBy: "reserve"`                  |
| `dropperPoolFullnessThreshold` + `dropperPressureThreshold` | one `dropperPressureThreshold = max(...)` |
| `dropperInputMaxTokens` + `reflectorInputMaxTokens` | one `reflectorInputMaxTokens`                  |
| `observationsPoolTargetTokens`              | removed (it had no effect)                               |
| `observerPreambleMaxTokens`                 | removed (the 30% of the reading batch is now a constant) |

`compactAfterMinTokens` and `compactAfterMaxTokens` are **new**, optional keys —
see [The shape-plus-band threshold](#the-shape-plus-band-threshold).

## Automatic on-disk migration

Starting at the first session after the upgrade, blackhole migrates the two
config files it owns, independently:

- the global file `~/.pi/agent/pi-blackhole/pi-blackhole-config.json`
- the project file `<cwd>/.pi/pi-blackhole-config.json` (only if it exists)

The per-file algorithm is **two-phase and verified**:

1. Read and parse the file. Invalid JSON or a non-object is left untouched
   (a warning is printed; the file is never rewritten).
2. Project the migration in memory. A recognized key with an unrecognized value
   aborts the whole file — nothing is written or deleted.
3. If the file has no legacy keys, it is a no-op. Blackhole does not silently
   rewrite unrelated files.
4. **Phase 1:** back up the file once as `<file>.bak`, then atomically
   (temp file + rename) write the migration with the new keys **and the old
   keys still present**, plus a `"configVersion": 1` stamp. The file is then
   re-read and every changed key is verified.
5. **Phase 2:** only after that verification passes, atomically write the file
   again with the consumed legacy keys deleted.

Consequences worth knowing:

- **Nothing is deleted before it is confirmed on disk.** If the process crashes
  between phases, the next load sees new + old keys and takes the remove-only
  path.
- **Unknown keys are preserved** verbatim. Blackhole only touches keys it owns.
- **Read-only filesystems** (Nix, managed dotfiles): the write throws, a warning
  is printed, the old keys are kept, and the current session still behaves as if
  the migration had run. The migration is retried on the next load.
- **Exactly one `.bak`** is written, before the first write. The migrated files
  are not version-controlled by blackhole; if your project config is tracked by
  git, commit the migration yourself.

## Removed keys

| Key | Why | What to do instead |
| --- | --- | --- |
| `compactionEngine` | `"blackhole"` and `"pi-default"` were the same as `compaction: "automatic"` and `"off"`. | Use `compaction`. |
| `observationsPoolTargetTokens` | No runtime reader — it never did anything. | Nothing; it is deleted. |
| `observerPreambleMaxTokens` | It only overrode 30% of the reading batch, which is now a constant. | Nothing; it is deleted. |
| `dropperPoolFullnessThreshold` | Merged into `dropperPressureThreshold` (see below). | `dropperPressureThreshold`. |
| `dropperInputMaxTokens` | Merged into `reflectorInputMaxTokens`. | `reflectorInputMaxTokens`. |

### Dropper merge — one residual divergence

`dropperPressureThreshold` (UI: **Prune memory when**) survives. The old
new-data floor is now the constant `0.10`. Migration sets
`dropperPressureThreshold = max(oldPressure, oldFullness)`.

This is **exact** for every config whose floor was the default `0.10` — the
overwhelming majority — at any pressure value. It only differs for a config
that set `fullness` **above 0.10 and above `pressure`**: that config loses its
custom new-data floor in favor of the constant. No single-knob formulation can
preserve two independent numbers, so this is the one accepted divergence.

### Input-budget merge

`reflectorInputMaxTokens` (UI: **Memory read per job**) survives.
`dropperInputMaxTokens` is dropped. If only the dropper key was set, its value
becomes the survivor; if only the reflector key was set, nothing changes; if
both were set, the explicit `reflectorInputMaxTokens` wins. The merge changes
behavior only for configs that deliberately tuned the two differently.

## The shape-plus-band threshold

The auto-compaction point is now one **shape** plus an optional **band**:

```
effective = clamp(shape(window), compactAfterMinTokens, compactAfterMaxTokens)
```

| Key | Role | Notes |
| --- | --- | --- |
| `compactAfterBy` | shape selector: `preset` \| `percent` \| `tokens` \| `reserve` | new; migration records the shape your old keys implied |
| `compactAfterPreset` | the curve when shape = `preset` | unchanged |
| `compactAfterRatio` | value when shape = `percent` | **now a percent in (0, 100]** — was a fraction |
| `compactAfterTokens` | value when shape = `tokens` | unchanged |
| `compactReserveTokens` | value when shape = `reserve` | unchanged |
| `compactAfterMinTokens` | floor (never compact below N) | **new**; `0`/absent = no floor |
| `compactAfterMaxTokens` | ceiling (never wait past N) | **new**; `0`/absent = no ceiling |
| `compactAfterPresets` | expert curve definitions | unchanged, file-only |

Why a band rather than a single number: a flat threshold cannot serve a 1M
model and a 256k model in the same session. `by: "percent", ratio: 46,
maxTokens: 180000` gives ~120k on a 256k window and 180k on a 1M window.

A literal `compactAfterTokens: 81000` was scaffold residue from older versions,
never a deliberate pin. Migration drops it so the selected shape governs. Any
other value is treated as a real pin.

## What did **not** change

- **No JSON key or environment-variable renames.** Every surviving key keeps its
  exact name; only the modal *labels* and descriptions changed. The modal shows
  a `key:` line under each focused field so you can map a label to the file.
- **No behavior change in the default configuration.** A fresh install behaves
  exactly as before; only the on-disk starter file is smaller (see below).
- **Env overrides are not migrated.** `PI_BLACKHOLE_*` variables are read at
  load and are never written to disk. `PI_BLACKHOLE_COMPACTION_ENGINE` is gone,
  and `PI_BLACKHOLE_COMPACTION` still accepts `auto` as an alias for
  `automatic`.

## New-install starter file

A fresh install now writes a small, curated subset of keys
(`compaction`, `compactionSummaryMode`, `tailBehavior`,
`showPreCompactionMessage`, `compactAfterBy`, `retainedToolOutputMaxTokens`,
`memory`, `observeAfterTokens`, `reflectAfterTokens`,
`observationsPoolMaxTokens`, `reflectionsPoolMaxTokens`, `statusBar`) instead of
dumping every default. Absent keys are filled from the built-in defaults at read
time, so this is purely about a readable starter file — not about changing
behavior.

## Label ↔ key mapping

The labels changed; the keys did not. The modal renders the key under the
focused field, and the full mapping lives in
[`docs/CONFIG.md`](CONFIG.md#label--key-mapping).

## Manual migration (optional)

If you prefer to edit the file yourself before it is auto-migrated, apply the
mapping in [TL;DR](#tldr). Nothing breaks if you do not: the loader also folds
legacy keys in memory, so a file with `compactionEngine` or `compaction: "auto"`
still works even if the on-disk rewrite is skipped (for example on a read-only
filesystem).

## Verify

```bash
cat ~/.pi/agent/pi-blackhole/pi-blackhole-config.json
```

Expect: no `compactionEngine`, no `observationsPoolTargetTokens`, no
`observerPreambleMaxTokens`, no `dropperInputMaxTokens`, no
`dropperPoolFullnessThreshold`; a `"configVersion": 1`; and the new threshold
keys if you had a numeric threshold. Then open `/blackhole settings` to review
the new labels, or `/blackhole-memory` for runtime status.
