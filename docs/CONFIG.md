# Configuration Reference — New Config Surface

Pi-blackhole's configuration lives at `~/.pi/agent/pi-blackhole/pi-blackhole-config.json`. This document describes the new unified config keys introduced by the config simplification.

## Config file safety

The config file must contain **valid JSON**. A trailing comma, partial write, or sync-conflict copy will cause the entire file to be rejected — the loader reports the failure instead of silently replacing your config with defaults.

**Current behavior:**
- Invalid JSON is surfaced as a yellow TUI warning — `Config file "pi-blackhole-config.json" is Invalid JSON: <parse error>. Using defaults.`
- `/blackhole settings` (alias `/blackhole configure`) still opens and shows defaults for the unreadable file — the modal does not block on the parse error
- Saves are diff-based against the file: only fields you actually changed are written, and unknown keys outside the schema (hand-edited extras) are preserved
- Changes take effect **immediately** — no session restart needed (the runtime reloads config from disk after save)

**If your config gets corrupted:** fix the JSON syntax directly in the file *before* saving from the modal. An unreadable file reads back as empty, so a `global`/`project` save has nothing to diff against and rewrites the file with exactly what the modal is showing (defaults, plus any env overrides) — everything the broken file held is gone. A `session`-scope save writes the session JSONL instead and leaves the file untouched.

## Quick Reference

```jsonc
{
  // ── Compaction ──
  "compaction": "automatic",      // "automatic" | "manual" | "off"
  "tailBehavior": "minimal",   // "pi-default" | "minimal"
  "showPreCompactionMessage": true, // Display-only copy of the newest dropped assistant output (max 16 KiB)
  "midRunCompaction": "off",    // "resume" | "pause" | "off" (default: off)
  "compactionSummaryMode": "default", // "default" | "append" (default: "default")
  // ── Auto-compaction threshold: one shape + an optional floor/ceiling band ──
  "compactAfterBy": "preset",      // "preset" | "percent" | "tokens" | "reserve"
  "compactAfterTokens": 0,        // value when by="tokens". 0 = not set. Never exactly 81000 (legacy residue — dropped)
  "compactAfterRatio": 0,         // value when by="percent" — a PERCENT in (0,100]. 0 = not set
  "compactReserveTokens": 0,      // value when by="reserve". 0 = not set
  "compactAfterPreset": "default",// curve when by="preset" (default "default" — 0.90 @32k → 0.40 @1M)
  "compactAfterMinTokens": 0,     // floor: never compact below N (0 = no floor)
  "compactAfterMaxTokens": 0,     // ceiling: never wait past N (0 = no ceiling)
  "compactAfterPresets": {        // Hand-edited preset DEFINITIONS (name → window/ratio anchors) — NOT a settings-modal field
    "default": [                  // Same-name entries override the built-in curve; shown here for reference
      { "window": 32768, "ratio": 0.9 },
      { "window": 131072, "ratio": 0.8 },
      { "window": 262144, "ratio": 0.7 },
      { "window": 1048576, "ratio": 0.4 }
    ],
    "early-1m": [                 // User-added name — must be selected via the knob; single anchor = constant ratio
      { "window": 131072, "ratio": 0.6 }
    ]
  },
  "retainedToolOutputMaxTokens": 20000, // 0 = disabled; otherwise full historical tool-output budget
  "recallResponseMaxChars": 48000,      // recall response cap; 0 = unbounded; derived per-entry/line shares

  // ── Observational Memory ──
  "memory": true,                 // Enable OM workers + content injection
  "sessionFallback": true,        // Fall back to session model when OM models fail
  "fullFoldAlways": true,         // Treat first compaction as full-fold boundary
  "statusBar": true,              // Footer token gauges (O/P/X) + worker events
  "showWorkerNotifications": true, // Routine memory-job progress toasts
  "observeAfterTokens": 15000,    // Token threshold for observer runs
  "reflectAfterTokens": 25000,    // Token threshold for reflector + dropper
  "observationsPoolMaxTokens": 20000, // Memory maintenance trigger + rendered note-line cap
  "reflectionsPoolMaxTokens": 8000, // Rendered insight-line cap
  "reflectorInputMaxTokens": 80000, // Largest memory snapshot an insight/prune job reads (shared)
  "observerChunkMaxTokens": 40000, // Max conversation tokens per note-taking pass
  "dropperPressureThreshold": 0.70, // Prune memory when note memory is this fraction full
  "agentMaxTurns": 16,            // Max turns per memory agent
  "providerIdleTimeoutMs": 0,     // Background provider body-idle timeout in ms (0 = disabled, unset = inherit pi default)
  "workerAttemptTimeoutMs": 0,    // Hard elapsed deadline per worker/model attempt (0 or unset = disabled)
  // "cacheRetention": "long",    // Optional worker prompt-cache retention: "none" | "short" | "long" (omit = inherit pi's effective setting)

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
| `"automatic"` | blackhole fires at the auto-compaction threshold ✓ | blackhole handles | blackhole handles |
| `"manual"` | skipped | Pi handles ✓ | blackhole handles |
| `"off"` | skipped (Pi handles) | Pi handles ✓ | blackhole handles |

**Examples:**

```jsonc
// Auto-compact (default)
{ "compaction": "automatic" }

// Manual only — /compact falls through to Pi, /blackhole uses blackhole pipeline
{ "compaction": "manual" }

// Blackhole skips auto + /compact (Pi handles both), /blackhole still works
{ "compaction": "off" }
```

> **Upgrade note.** `compactionEngine` was folded into `compaction` (0.6.0).
> `"blackhole"` meant `compaction: "automatic"`; `"pi-default"` meant
> `compaction: "off"`. The old value `"auto"` is still accepted as an alias
> for `"automatic"`. Existing files are migrated on disk automatically — see
> [MIGRATION-GUIDE.md](MIGRATION-GUIDE.md).

### `compaction` values, engine note

The `compactionEngine` key no longer exists. Its two meaningful values are the
`"automatic"` and `"off"` rows of the matrix above; there is no longer a
redundant `auto + pi-default` combination to express.

### `tailBehavior`

Controls how much of the recent transcript stays *visible* after compaction. Only applies when `compaction: "automatic"`.

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

### `showPreCompactionMessage`

Default `true`. After a successful Blackhole compaction, append a display-only copy of the **newest assistant output that the cut removed from view** so the terminal keeps showing the answer you were reading.

| Value | Behavior |
|-------|----------|
| `true` | Copy up to 16 KiB of the newest dropped assistant text into a plain `blackhole-pre-compaction-output` session entry, rendered as `[Previous output — display only]` below the retained tail and above the compaction card. |
| `false` | No copy; the compaction card appears alone (pre-0.5.x behavior). |

The copy is **cosmetic**: Pi renders the entry but never sends it to the model (`sessionEntryToContextMessages` returns nothing for plain `custom` entries), and Blackhole's own serializers only read `message`, `custom_message`, and `branch_summary` entries. It does not change `firstKeptEntryId`, the summary, or the auto-compaction threshold.

When the newest dropped message is already retained by the cut (the common `minimal` case, where the last user turn and everything after it stay visible), nothing is copied — no duplicates. Compact-all with no retained tail copies the final answer instead.

Things that stay out of the copy: tool output, thinking blocks, images, and exact card layout. The copy is truncated at 16 KiB with a `[Copy truncated]` marker; each eligible compaction adds one entry to the session file (a bounded disk and redraw cost, not a token cost).

```jsonc
// Default: keep the newest dropped answer visible
{ "showPreCompactionMessage": true }

// Plain compaction card only
{ "showPreCompactionMessage": false }
```

### `midRunCompaction`

Controls the **mid-run** auto-compaction trigger. Pi's `agent_end` event only fires when a run exits — during long tool loops (agent calling tools turn after turn) the threshold would otherwise never be evaluated, and accumulated tokens could blow far past the auto-compaction threshold before compaction had any chance to run. This trigger evaluates the threshold at every `turn_end` (after each assistant message + tool executions) while the agent is still working.

Only applies when `compaction: "automatic"`.

Full mechanism, history, and debugging guide: [mid-run-compaction.md](mid-run-compaction.md).

| Value | Behavior |
|-------|----------|
| `"resume"` *(experimental)* | Compact transparently at an awaited `turn_end`, then continue inside the **same** agent run and outer `session.prompt()` promise. No run abort and no synthetic continuation message. |
| `"pause"` | Use Pi's native interrupting `ctx.compact()` at the threshold, then stop. The user continues manually. |
| `"off"` | No mid-run evaluation; only check the threshold when the agent finishes a run (default). Non-persisted sessions (see below) always use the inline path instead. |

`"resume"` reuses Pi's native summary, `session_before_compact`, session-entry, and context-rebuild pipeline. Blackhole's runtime adapter suppresses only the compaction method's initial internal quiesce (`abort`, plus disconnect on older Pi), then refreshes the low-level loop from the compacted `agent.state.messages` before another provider request. Completed tools stay paired, the active run signal is not aborted, background agents do not receive a false interrupt, and nested runners keep awaiting their original prompt promise.

**Compatibility is fail-closed.** The adapter recognizes the known Pi 0.81 legacy and Pi 0.84 connected-listener compact shapes. If Pi internals drift, `"resume"` refuses the mid-run attempt, leaves the current run alive, reports the incompatibility, and suspends retries at that pressure level. It never falls back to the old abort + `blackhole-resume` path.

`"pause"` is intentionally different: it calls public `ctx.compact()`, which aborts the active run by design. That abort may propagate to extensions which treat the run signal as user cancellation, so use `"resume"` for transparent/subagent workflows.

**Non-persisted sessions (subagents, SDK/flow runners).** In-memory sessions (`SessionManager.inMemory()`) are typically disposed by their parent right after `agent_end`, so the deferred `agent_end` compaction reliably loses that race and bails on a stale extension ctx ([#92](https://github.com/k0valik/pi-blackhole/issues/92)); and `"pause"`'s run-interrupting `ctx.compact()` has no user to hand control back to. Non-persisted sessions therefore resolve **all three** `midRunCompaction` values to the transparent inline path at `turn_end` — same-run continuation, no abort, runner lifecycle untouched. Persisted sessions (TUI, file-backed) keep the configured semantics exactly. Fail-closed: when the inline adapter is unsupported for the host, non-persisted sessions skip mid-run compaction entirely — surfaced once per process via the `agent_start` warning; per-turn skips are debug-logged only (they are not counted, since the skip fires every turn while over threshold and would inflate a counter denominated in scheduled compactions). Separate visibility: every *scheduled* auto-compaction skipped because the ctx went stale is counted (`Skipped compactions (disposed ctx): N` in `/blackhole-memory` status, process-wide so a parent surfaces nested-session skips) and warned once per session (UI notification, or stderr for headless runs). Adapter-unavailable warnings are UI-only by design — headless sessions get no `console.warn` (it would leak into the subagent transcript) and the parent cannot be reached without knowing the subagent host, so headless operators watch `debug.ndjson` instead. The `agent_end` deferral remains as a backstop for persisted sessions and for pressure that only crosses the threshold on a run's final turn; non-persisted sessions with an unsupported adapter skip the settled path too (fail-closed).

**Re-trigger safety:** after a successful compaction, accumulated tokens are counted from the fresh compaction entry. Failed or cancelled attempts are suspended until pressure drops below the threshold.

```jsonc
// Default: only evaluate when the run ends
{ "midRunCompaction": "off" }

// Opt in to transparent same-run compaction during long tool loops
{ "midRunCompaction": "resume" }

// Interrupt the run, compact, and hand control back to the user
{ "midRunCompaction": "pause" }
```

### The auto-compaction threshold: shape + band

The threshold is one **shape** plus an optional **band**:

`effective = clamp(shape(window), compactAfterMinTokens, compactAfterMaxTokens)`

`compactAfterBy` selects exactly one shape; the floor/ceiling always apply on
top of it. Every numeric threshold key uses `0`/absent to mean *not set*.

| Shape (`compactAfterBy`) | Value key | Rule |
| --- | --- | --- |
| `"preset"` (default) | `compactAfterPreset` | a window-scaled curve |
| `"percent"` | `compactAfterRatio` | `floor(window × percent / 100)` |
| `"tokens"` | `compactAfterTokens` | a flat token count on every model |
| `"reserve"` | `compactReserveTokens` | `window − reserve` (clamped ≥ 1) |

| Band key | Role | Default |
| --- | --- | --- |
| `compactAfterMinTokens` | never compact below N | unset (`0` = no floor) |
| `compactAfterMaxTokens` | never wait past N | unset (`0` = no ceiling) |

**Why a band.** A flat threshold cannot serve a 1M model and a 256k model in
the same session. `by: "percent", ratio: 46, maxTokens: 180000` gives ~120k on a
256k window and 180k on a 1M window.

When `compaction: "automatic"` and the measured context since the last
compaction reaches the effective threshold, compaction triggers automatically —
both mid-run (see `midRunCompaction`) and when the agent finishes a run. In
`"manual"`/`"off"` the trigger does not run.

### `compactAfterTokens` *(shape = tokens)*

Flat token count: the same threshold on every model. Used when
`compactAfterBy: "tokens"`.

| Type | Default |
| --- | --- |
| number | unset (`0` = not set) |

**Legacy `81000` residue (migration):** Configs scaffolded by earlier versions, or written by the settings modal before the preset-curve release, literally contain `"compactAfterTokens": 81000` — the old fixed default posture, never a deliberate user pin. The loader treats exactly `81000` as that residue and drops it, so the selected preset curve (or a window-derived knob) governs. The drop does **not** apply to a value set via the `PI_BLACKHOLE_COMPACT_AFTER_TOKENS` env var — env overrides are always explicit. To pin a fixed threshold, set any *other* value (e.g. `80000` or `180000`); the flat-81k behavior can no longer be reproduced by writing exactly `81000`.

**The interaction with Pi's threshold:** Pi has its own `keepRecentTokens` default (~20k tokens). Blackhole's threshold is independent — it's the trigger point, not the keep point. When blackhole's trigger fires, `tailBehavior` determines how much is actually kept visible.

### `retainedToolOutputMaxTokens`

Set to `0` to disable the budget entirely (opt-out). By default a 20000-token budget is applied.

Dedicated token budget for historical `toolResult` text and shell output retained by a Blackhole compaction. At the compaction boundary, Blackhole scans the retained tail newest-first, retaining each full text output while it fits. The text crossing the budget and all older text outputs are represented by compact markers that point to `recall #N` when a stable transcript index is available. That representation is persisted with the compaction and stays unchanged during ordinary provider calls until the next Blackhole compaction. Non-text parts such as images are preserved and do not count against this budget.

This only changes the retained context sent to the provider. Session JSONL, compaction summaries' source messages, and recall data remain full fidelity. Trailing results that have not yet been consumed by an assistant response are protected even when they exceed the budget; they can become eligible when a later compaction constructs a new retained representation.

| Type | Default | Range |
|------|---------|-------|
| number | 20000 | `0` (disabled) or positive integer |

### `recallResponseMaxChars`

Set to `0` to disable the budget entirely (opt-out). Default 48000 characters (~12k tokens).

Bounding cap on any single `recall` tool / `/blackhole-recall` response. A huge stored message (long tool-result line, big expanded entry, giant observation body) must never flood the agent's context. Per-entry and per-line allocations are derived internally from this one knob:

- Search snippet lines capped (~1000 chars) with the match kept visible.
- Expanded entries share the budget, each with a continuation marker to `#N:text:full` / `#N:path:full`.
- Related observation/reflection bodies capped (~1200 chars); full content reachable via the 12-hex memory id.
- Total budget enforced entry-aware (trailing entries dropped before the header, footer names the omitted count + continuation).

Session JSONL and the complete stored content are never modified — only what a single recall response renders is bounded, and the full payload stays reachable via paged drill-downs (`#N:text:offset:limit` / `#N:path:offset:limit`).

| Type | Default | Range |
|------|---------|-------|
| number | 48000 | `0` (unbounded) or positive integer |

### `compactAfterRatio` *(shape = percent)*

A **percentage** of the active session model's context window: blackhole
compacts when the context reaches `floor(window × percent / 100)`. Used when
`compactAfterBy: "percent"`. The threshold is re-derived on every evaluation, so
switching models mid-session (`/model`) takes effect on the next check.

| Type | Default |
| --- | --- |
| number, percent in (0, 100] | unset (`0` = not set) |

Examples on common windows at `46`:

```text
128k model → ~59k   256k model → ~118k   1M model → ~482k
```

> **Upgrade note.** The key was a fraction (0.46) in earlier releases; it is now
> a percent (46). Migration converts existing fractions automatically.

**How the window is resolved** (see `model.contextWindow` below): per-model config override → Pi's model registry → 128k fallback. If Pi doesn't know your custom-provider model's window, set `contextWindow` on its model entry in this config so the ratio targets the real window.

### `compactReserveTokens` *(shape = reserve)*

Keep a constant amount of headroom: blackhole compacts when only
`compactReserveTokens` of window remain — threshold `= window − reserve`
(clamped ≥ 1). Used when `compactAfterBy: "reserve"`.

| Type | Default |
| --- | --- |
| positive integer | unset (`0` = not set) |

```text
200k window − 32k reserve → ~168k    1M window − 32k reserve → ~968k
```

**Upgrade from the old precedence.** `compactAfterBy` does not exist in
pre-0.6.0 files. Migration records the shape the old keys implied: explicit
`compactAfterTokens` > `compactAfterRatio` > `compactReserveTokens` > the
preset curve. A file value of exactly `81000` is legacy scaffold residue and is
dropped (see `compactAfterTokens`).

**Settings modal:** the shape selector **Auto-compact when** sits above a
`depth: 1` group — the value field for the chosen shape, the preset picker, and
the always-visible **Never compact below** / **Never compact later than** band.
`0` means *not set*. The loader treats a file value of `0` exactly like an
absent key.

**Examples:**

```jsonc
// ~46% of the active model, capped at 180k on huge windows
{ "compactAfterBy": "percent", "compactAfterRatio": 46, "compactAfterMaxTokens": 180000 }

// Never compact below 150k, whatever the shape computes
{ "compactAfterBy": "percent", "compactAfterRatio": 40, "compactAfterMinTokens": 150000 }

// Keep at least 32k tokens of headroom free
{ "compactAfterBy": "reserve", "compactReserveTokens": 32768 }
```

### `compactAfterPreset` *(preset curve when shape = preset)*

Names which curve in the effective preset table applies when
`compactAfterBy: "preset"`. Options = the built-in `default` curve plus any
names you added in `compactAfterPresets`; the **Preset** select in
`/blackhole settings` lists exactly those names, so the options and runtime
resolution cannot disagree.

| Type | Default |
|------|---------|
| string | `"default"` |

An unknown name (typo, or a preset that was dropped for invalid data) warns once and falls back to the built-in `default` curve — resolution always returns a positive threshold, never an error.

Env override: `PI_BLACKHOLE_COMPACT_AFTER_PRESET`.

### `compactAfterPresets` *(preset curve definitions — hand-edited JSON only)*

Defines the window → ratio anchor lists that `compactAfterPreset` selects. **Not a settings-modal field and not a defaults key**: it is hand-edited JSON that config saves carry verbatim, so the modal can never diff, normalize, or clobber it. Built-in definitions ship in code; a same-name entry in this file overrides the built-in curve, and a new name extends the table.

Each preset is a name → ordered array of anchors, `{ "window": <int > 0>, "ratio": <0 < ratio ≤ 1> }`. The ratio at a window is **piecewise-linear interpolation** in window space between the surrounding anchors, and constant outside the anchor range; the effective threshold is `floor(window × ratio)` (minimum 1). A single-anchor preset degenerates to a constant ratio — effectively a global-ratio curve. Anchors are validated at parse time: `window` must be a positive integer and `ratio` in `(0, 1]`; the list is sorted ascending by `window` (a duplicate window keeps the last entry); a preset left with no valid anchors is dropped with a console warning.

Direction of the built-in curve is intentional: the ratio **falls** as the window grows. Small windows fill to ~90% (cheap to send, maximum usable history); huge windows compact early (paid per-token context cost, higher-quality summaries, sharper working set).

**Built-in `default` preset** (curve data is user-tunable — edit the `default` entry below to re-shape it):

| window | ratio | effective threshold (`floor`) | headroom |
| ------ | ----- | ----------------------------- | -------- |
| 32,768 | 0.90 | 29,491 | 3,277 |
| 131,072 | 0.80 | 104,857 | 26,215 |
| 262,144 | 0.70 | 183,500 | 78,644 |
| 1,048,576 | 0.40 | 419,430 | 629,146 |

Worked examples: 65,536 → ~0.867 (fires ~56,797); 200,000 → ~0.747 (fires ~149,482, ≈75% full); 1,000,000 → ~0.419 (fires ~418,530); 1,048,576 and above → exactly 0.40 (constant extrapolation); below 32,768 → 0.90 (constant).

**Example:**

```jsonc
{
  "compactAfterPreset": "default", // knob: options = built-in names + names defined below
  "compactAfterPresets": {
    "default": [
      // Same-name override of the built-in curve — anchor values may be tuned
      { "window": 32768, "ratio": 0.9 },
      { "window": 131072, "ratio": 0.8 },
      { "window": 262144, "ratio": 0.7 },
      { "window": 1048576, "ratio": 0.4 }
    ],
    "early-1m": [
      // User-added name (must be selected via the knob) — single anchor = constant 0.6 ratio
      { "window": 131072, "ratio": 0.6 }
    ]
  }
}
```

**Migration:** out of the box (no config) the built-in `default` curve governs. A scaffolded/modal-written `"compactAfterTokens": 81000` from before this change is dropped at load (see `compactAfterTokens` above), leaving the preset curve or any configured numeric knob in charge. You only need `compactAfterPresets` when you want to tune a curve or add presets of your own.

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
{ "memory": false, "compaction": "automatic" }
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

Stored observation-token pressure threshold for full-fold maintenance, plus a hard cap on estimated rendered observation lines in compaction output. IDs, timestamps, relevance labels and newline separators count. High/critical observations are preferred newest-first, then medium/low by relevance and recency. Oversized records are skipped; selected records stay whole and return to source order. Source history is not deleted.

| Type | Default |
|------|---------|
| number | 20000 |

### `reflectionsPoolMaxTokens`

Hard cap on estimated rendered reflection lines in compaction output. Selects newest whole records that fit, then restores source order. IDs and newline separators count. Non-negative finite integer; `0` disables the cap. Invalid file values use the default. This does not limit worker prompts or raw/view lookups, and omitted source records remain available through `recall`.

| Type | Default |
|------|---------|
| non-negative integer | 8000 |

Both output budgets use the project's chars/4 estimate, not an exact provider tokenizer. Section headings, recall note and footer add tokens outside these line budgets; total trailing memory is not exactly 28,000 tokens. Compact-all retains eligible bounded memory and applies recorded drops.

### `reflectorInputMaxTokens` *(Memory read per job)*

Rolling window cap for a memory-snapshot prompt. Shared by the insight-building
(reflector) and pruning (dropper) jobs — they read the same data. The reflector
sees **new** notes plus a summary budget, capped at this value.

> **Upgrade note.** `dropperInputMaxTokens` was merged into this key (0.6.0);
the dropper's value becomes the survivor only when this key is unset. The
unrelated `observationsPoolTargetTokens` and `observerPreambleMaxTokens` knobs
were removed (they had no effect). The observer's existing-memory cap is now the
fixed `30%` of `observerChunkMaxTokens`.

| Type | Default |
| --- | --- |
| number | 80000 |

### `observerChunkMaxTokens`

Max conversation tokens sent to the note-taker per reading pass.

| Type | Default |
| --- | --- |
| number | 40000 |

### `dropperPressureThreshold` *(Prune memory when)*

Fraction of `observationsPoolMaxTokens` at which low-value notes are pruned.
The new-data floor is derived from this value
(`dropperNewDataFloor(P) = clamp(0.15 × P, 0.02, 0.10)`); `1.0` disables
pressure-driven pruning.

> **Upgrade note.** `dropperPoolFullnessThreshold` was merged into this key
> (0.6.0); migration sets `max(oldPressure, oldFullness)`. The old independent
> new-data floor is now derived from the pressure — the default `0.70`
> reproduces the old `0.10`, and a custom pressure scales the floor with it.

| Type | Default | Range |
| --- | --- | --- |
| number | 0.70 | (0, 1] |

- **0.70** (default): pressure-driven pruning runs when note memory reaches 70% of the budget
- **Higher** (e.g. 0.90): waits until memory is fuller before pruning
- **Lower** (e.g. 0.50): prunes more eagerly
- **1.0**: disables pressure-driven pruning — the pruner only runs when new notes/insights exist and the pool clears 10%

### `agentMaxTurns`

Shared turn cap for background memory agents. It is passed as `maxTurns` to `runObserver`, `runReflector`, and `runDropper` agent loops, capping retry/reasoning iterations within a single stage execution.

| Type | Default |
|------|---------|
| number | 16 |

### `cacheRetention`

Provider-neutral prompt-cache retention preference forwarded to the observer, reflector, and dropper worker streams. Unset defers to pi's effective setting (its provider default is `short`). Adapters that do not support a value ignore it, so `long` is opt-in rather than our default.

- **unset** — inherit pi's effective setting (its provider default is `short`).
- **`none`** — no prompt caching where the adapter supports it.
- **`short`** — short-lived retention, pi's provider default.
- **`long`** — extended retention where supported.

Accepted via plain config, `/blackhole settings`, or `PI_BLACKHOLE_CACHE_RETENTION`; values are case-insensitive on every path, so `"LONG"` resolves to `long`. The settings modal shows an explicit `unset` option so an untouched field never pins a value, and switching back to `unset` removes a stored value from the file; invalid file or env values are dropped at load and the previous value stays. The setting only affects memory workers, never foreground Pi chat requests.

| Type | Default | Values |
|------|---------|--------|
| string | unset | `none` \| `short` \| `long` |

### `providerIdleTimeoutMs`

Body-idle timeout for background provider streams (observer/reflector/dropper worker HTTP requests). Higher values let background memory jobs tolerate longer silent provider intervals without forcing interactive Pi requests to wait equally long. Applied by wrapping the provider `fetch` with an undici dispatcher that injects `bodyTimeout`.

- **unset** — inherit pi's global provider timeout (no wrapper applied).
- **`0`** — explicitly disabled (no wrapper applied).
- **`> 0`** — allow at most this many milliseconds between response-body chunks.

This is not a hard request deadline: waiting for response headers, streamed heartbeat bytes, and later agent-loop turns can keep a worker alive longer. Use `workerAttemptTimeoutMs` when fallback must happen by a wall-clock deadline.

Accepted via plain config or `PI_BLACKHOLE_PROVIDER_IDLE_TIMEOUT_MS`. Negative values are rejected. WebSocket transports are not affected.

| Type | Default | Range |
|------|---------|-------|
| number | unset | `0` or positive integer |

### `workerAttemptTimeoutMs`

Hard elapsed deadline for one worker/model attempt. It covers the complete observer, reflector, or dropper agent loop for the selected model: response headers, streamed bodies and heartbeats, tool turns, and final confirmation. When the deadline expires, Blackhole aborts that attempt. If the model is a configured candidate, Blackhole records its cooldown and immediately resolves the next fallback, which gets a fresh deadline. The final session-model fallback behaves differently: it is attempted once per stage, and a timeout there records no cooldown and ends the stage's model search instead of retrying the same session model up to ten times.

- **unset** or **`0`** — disabled.
- **`> 0`** — abort one model attempt after this many milliseconds.

Accepted via plain config, `/blackhole settings`, or `PI_BLACKHOLE_WORKER_ATTEMPT_TIMEOUT_MS`. Settings-modal saves persist the key correctly at global, project, and session scope. Direct config and env values must not exceed 2,147,483,647 ms (Node's maximum timer delay); larger values are rejected. The settings UI caps edits at 3,600,000 ms. It only affects Blackhole workers, never foreground Pi chat requests.

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
| `thinking` | enum | Thinking level: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`. Defaults to `"low"` when unset. |
| `cooldownHours` | number | Cooldown duration in hours after a cooldown-worthy error — transient (429/5xx/timeout) or deterministic 4xx (missing provider-required headers, bad credentials, unknown model). Defaults to `1` when omitted. Set to `0` to disable persistent cooldown. |
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

## UI Section

### `statusBar`

Show the footer status bar: three token gauges — O (transcript since last observer run), P (observation pool fill), X (context since last compaction) — plus worker spinners and `✓ +N` completion events.

| Type | Default |
|------|---------|
| boolean | `true` |

### `showWorkerNotifications`

Routine memory-job progress toasts — e.g. `blackhole: reading recent conversation for notes`, `blackhole: saved N notes`, `blackhole: building insights`, `blackhole: pruning low-value notes`, and the info-level `blackhole: no new notes` notice. Set to `false` for quiet sessions.

Warnings and errors are unaffected: model fallback/unavailability, context-window skips, no-output warnings, worker failures, compaction notifications, and explicit `/blackhole*` command output all stay visible.

| Type | Default |
|------|---------|
| boolean | `true` |

## Debug Section

### `debug` / `debugLog`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `debug` | boolean | false | Writes detailed debug snapshots to `/tmp/pi-blackhole-debug.json` |
| `debugLog` | boolean | false | Writes structured JSONL debug logs to the agent directory |

## Deprecated Keys

These keys are still accepted for backward compatibility but are silently migrated to the new surface on load. They are removed from the in-memory config object and not written back by the overlay.

| Key | Replacement |
| --- | --- |
| `overrideDefaultCompaction` | `compaction` + `tailBehavior` |
| `noAutoCompact` | `compaction: "manual"` |
| `passive` | `compaction: "off"` + `memory: false` |
| `compactionEngine` | folded into `compaction` (`"blackhole"` → `"automatic"`, `"pi-default"` → `"off"`) |
| `dropperPoolFullnessThreshold` | merged into `dropperPressureThreshold` (`max`) |
| `dropperInputMaxTokens` | merged into `reflectorInputMaxTokens` |
| `observationsPoolTargetTokens` | removed (no effect) |
| `observerPreambleMaxTokens` | removed (30% of the reading batch is a constant) |

These are rewritten on disk by the two-phase migration described in
[MIGRATION-GUIDE.md](MIGRATION-GUIDE.md); they also keep working in memory if
the rewrite is skipped (read-only filesystem).

## Label ↔ key mapping

The settings modal uses outcome-level labels; the JSON keys are unchanged. The
modal also prints `key: <key>` under the focused field, so this table is a
convenience, not the only bridge.

| Modal section | Label | Key |
| --- | --- | --- |
| Compaction | When to compact | `compaction` |
| Compaction | How summaries are kept | `compactionSummaryMode` |
| Compaction | Recent messages kept visible | `tailBehavior` |
| Compaction | Compacting during a long task | `midRunCompaction` |
| Compaction | Keep the last answer visible | `showPreCompactionMessage` |
| When to compact automatically | Auto-compact when | `compactAfterBy` |
| When to compact automatically | Percent of context window | `compactAfterRatio` |
| When to compact automatically | Fixed token count | `compactAfterTokens` |
| When to compact automatically | Headroom reserve | `compactReserveTokens` |
| When to compact automatically | Preset | `compactAfterPreset` |
| When to compact automatically | Never compact below | `compactAfterMinTokens` |
| When to compact automatically | Never compact later than | `compactAfterMaxTokens` |
| Context budgets | Tool output kept | `retainedToolOutputMaxTokens` |
| Context budgets | Recall answer size | `recallResponseMaxChars` |
| Memory — behavior | Observational memory | `memory` |
| Memory — behavior | Take notes every | `observeAfterTokens` |
| Memory — behavior | Build insights every | `reflectAfterTokens` |
| Memory — behavior | Prune memory when | `dropperPressureThreshold` |
| Memory — sizes | Note memory budget | `observationsPoolMaxTokens` |
| Memory — sizes | Insight memory budget | `reflectionsPoolMaxTokens` |
| Memory — sizes | Conversation read per pass | `observerChunkMaxTokens` |
| Memory — sizes | Memory read per job | `reflectorInputMaxTokens` |
| Advanced | Fall back to session model | `sessionFallback` |
| Advanced | Max steps per memory job | `agentMaxTurns` |
| Advanced | Keep early notes through first compaction | `fullFoldAlways` |
| Advanced | Memory job prompt caching | `cacheRetention` |
| Advanced | Memory job idle timeout | `providerIdleTimeoutMs` |
| Advanced | Memory job attempt timeout | `workerAttemptTimeoutMs` |
| Advanced | Footer status bar | `statusBar` |
| Advanced | Memory job notifications | `showWorkerNotifications` |
| Advanced | Debug snapshots | `debug` |
| Advanced | Debug JSONL logging | `debugLog` |

## Environment Variable Overrides

Environment variables override config file values **at load time** and apply to both the runtime and the modal. Invalid values fall back to the configured (or default) value.

Boolean parsing accepts `1`, `true`, `yes`, `on` (and `0`, `false`, `no`, `off`).

### Compaction mode

| Variable | Overrides | Example |
|----------|-----------|---------|
| `PI_BLACKHOLE_COMPACTION` | `compaction` (`automatic` \| `manual` \| `off`; `auto` is an accepted alias) | `PI_BLACKHOLE_COMPACTION=manual` |
| `PI_BLACKHOLE_MID_RUN_COMPACTION` | `midRunCompaction` (`resume` \| `pause` \| `off`) | `PI_BLACKHOLE_MID_RUN_COMPACTION=resume` |
| `PI_BLACKHOLE_SHOW_PRE_COMPACTION_MESSAGE` | `showPreCompactionMessage` (`true` \| `false`) | `PI_BLACKHOLE_SHOW_PRE_COMPACTION_MESSAGE=off` |
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
| `PI_BLACKHOLE_STATUSBAR` | `statusBar` |
| `PI_BLACKHOLE_SHOW_WORKER_NOTIFICATIONS` | `showWorkerNotifications` |

Integer fields (invalid values fall back; `reflectionsPoolMaxTokens` also accepts `0` to disable its cap):

| Variable | Overrides |
|----------|-----------|
| `PI_BLACKHOLE_COMPACT_AFTER_TOKENS` | `compactAfterTokens` |
| `PI_BLACKHOLE_COMPACT_RESERVE_TOKENS` | `compactReserveTokens` |
| `PI_BLACKHOLE_RETAINED_TOOL_OUTPUT_MAX_TOKENS` | `retainedToolOutputMaxTokens` |
| `PI_BLACKHOLE_RECALL_RESPONSE_MAX_CHARS` | `recallResponseMaxChars` |
| `PI_BLACKHOLE_OBSERVE_AFTER_TOKENS` | `observeAfterTokens` |
| `PI_BLACKHOLE_REFLECT_AFTER_TOKENS` | `reflectAfterTokens` |
| `PI_BLACKHOLE_OBSERVATIONS_POOL_MAX_TOKENS` | `observationsPoolMaxTokens` |
| `PI_BLACKHOLE_REFLECTIONS_POOL_MAX_TOKENS` | `reflectionsPoolMaxTokens` |
| `PI_BLACKHOLE_REFLECTOR_INPUT_MAX_TOKENS` | `reflectorInputMaxTokens` |
| `PI_BLACKHOLE_OBSERVER_CHUNK_MAX_TOKENS` | `observerChunkMaxTokens` |
| `PI_BLACKHOLE_AGENT_MAX_TURNS` | `agentMaxTurns` |
| `PI_BLACKHOLE_PROVIDER_IDLE_TIMEOUT_MS` | `providerIdleTimeoutMs` |
| `PI_BLACKHOLE_WORKER_ATTEMPT_TIMEOUT_MS` | `workerAttemptTimeoutMs` |

Float fields (must be in `(0, 1]`):

| Variable | Overrides |
| --- | --- |
| `PI_BLACKHOLE_DROPPER_PRESSURE_THRESHOLD` | `dropperPressureThreshold` |

The `compactAfter*` value variables also force the shape: setting
`PI_BLACKHOLE_COMPACT_AFTER_TOKENS` implies `compactAfterBy: "tokens"`, `…_RATIO`
implies `"percent"` (a value ≤ 1 is treated as the old fraction and converted
to a percent), and `…_RESERVE_TOKENS` implies `"reserve"`. There are no env
vars for `compactAfterBy`, `compactAfterMinTokens`, or `compactAfterMaxTokens`,
and `PI_BLACKHOLE_COMPACTION_ENGINE` was removed.

`PI_BLACKHOLE_COMPACT_AFTER_RATIO` is a percent in `(0, 100]` (also accepts the
old fraction <= 1 and converts it). `PI_BLACKHOLE_DROPPER_POOL_FULLNESS_THRESHOLD`
was removed.

Preset-name field (non-empty string):

| Variable | Overrides |
|----------|-----------|
| `PI_BLACKHOLE_COMPACT_AFTER_PRESET` | `compactAfterPreset` |

Enum fields (invalid values keep the file value; matching is case-insensitive):

| Variable | Overrides |
|----------|-----------|
| `PI_BLACKHOLE_CACHE_RETENTION` | `cacheRetention` (`none` \| `short` \| `long`) |

### Paths and internals

| Variable | Purpose |
|----------|---------|
| `PI_CODING_AGENT_DIR` | Overrides the pi agent data directory (config lives at `<dir>/pi-blackhole/pi-blackhole-config.json`) |
| `PI_VCC_COMPACT_INSTRUCTION` | Internal sentinel for the pi-default compaction engine — not a user override |

## Complete Examples

### Minimal auto-compact (all defaults)

```json
{
  "compaction": "automatic",
  "tailBehavior": "minimal",
  "memory": true
}
```

### Manual compaction, no OM, aggressive tail

```json
{
  "compaction": "manual",
  "tailBehavior": "minimal",
  "memory": false
}
```

### Pi handles compaction (blackhole steps aside)

```json
{
  "compaction": "off"
}
```

### 256k @ ~120k, 1M @ 180k

```json
{
  "compaction": "automatic",
  "compactAfterBy": "percent",
  "compactAfterRatio": 46,
  "compactAfterMaxTokens": 180000
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

Controls how auto-compaction summaries are stored and presented to the model. Only applies when `compaction: "automatic"`. Explicit `/blackhole` triggers independent of this mode and always folds the chain into a clean segment.

| Value | Behavior |
|-------|----------|
| `"default"` | Each auto-compaction replaces the previous summary with a fresh one (rewrite — existing behavior, default). |
| `"append"` | Each auto-compaction appends one immutable provider-visible segment (`S1 \| S2 \| …`). The model sees all prior compaction segments alongside the current conversation. Every stored summary remains a complete fallback. |

**In `append` mode:**
- Auto-compactions append a new segment to the chain; earlier segments stay visible to the model.
- Explicit `/blackhole` rebases the active chain into one clean segment and starts a new chain.
- Legacy v1 summaries (from before this feature) enter through one marked rebase.
- At an existing compaction, ordinary rebase requires pressure **and** useful saving. Pressure means rendered append chain (including incoming segment and host wrappers) exceeds `floor(W / 8)`, or estimated full context exceeds `floor(W / 2)`. Saving must reach `max(1, min(24000, floor(24000 * W / 272000)))`. At a 272k window: 34k chain pressure, 136k context pressure, 24k minimum saving.
- Both candidates contain the same current memory and kept tail. Full totals use a compatible trusted usage baseline minus reconstructed visible baseline plus reconstructed candidate content. Missing or inconsistent evidence leaves totals **unknown**, with chain-only policy still available. Without a supplied finite positive window, use 34k/24k chain policy and no invented capacity threshold.
- Explicit `/blackhole` forces rebase after normal guards. `/compact` does not. Overflow recovery, or known append total above `W - reserveTokens`, chooses the smaller candidate without a 24k minimum. Estimates do not prove overflow recovery; Pi retains retry/error control.
- This governor never requests compaction. Upstream threshold presets and explicit user cadence (including 168,000) are unchanged. No extra model call, price model, or timer.
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
