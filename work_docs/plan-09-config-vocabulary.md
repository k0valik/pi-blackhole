# Plan 09 — User-facing config vocabulary and surface consolidation

**Goal:** make the configuration surface express _outcomes a user can reason
about_, not internal implementation vocabulary. Two independent workstreams:

1. **Vocabulary** — rename labels/descriptions (and, where accepted, JSON keys)
   from agent-speak to user language.
2. **Consolidation** — remove dead knobs, collapse redundant knobs, and stop
   presenting derivable values as independent choices.

**Back-compat posture (explicit):** no in-place compatibility is required — the
plan freely folds, adds, and deletes keys. Existing config **files are migrated
on disk** by plan-10 (`work_docs/plan-10-config-migration.md`): consumed legacy
keys are rewritten to their new homes and removed, unknown keys are preserved.
Until migration lands, old keys are simply ignored by the loader.

**Root cause to fix, not just symptoms:** the current surface grew one knob per
incident. Each fix added a switch rather than a defaulted behavior. This plan
adds a rule so it stops happening (see §6).

---

## 0. Diagnosis

The pasted modal shows ~30 rows. They are legible to the person who wrote the
pipeline and opaque to everyone else, for three distinct reasons — and only the
first is really about wording:

- **Vocabulary gap.** `source entries`, `chunk`, `preamble`, `pool`,
  `full fold`, `pressure` are internal nouns. The user has no model of the
  pipeline, so no label built from those nouns can land.
- **Redundancy / false choices.** Several knobs are precedence tiers or
  near-duplicates of one another (`compactAfterTokens` vs `Ratio` vs
  `Reserve` vs `Preset`; two dropper fractions combined with `max()`), so the
  user is asked to choose between expressions of the same decision.
- **Dead / derivable knobs.** At least one knob has no runtime reader at all
  (`observationsPoolTargetTokens`), and others exist only to override a value
  the code would otherwise compute (`observerPreambleMaxTokens` = 30% of chunk).

---

## 1. Proposed user vocabulary (the glossary everything else derives from)

| Internal term                   | User-facing term                              | Why                                                                    |
| ------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| source entry / transcript entry | **conversation**                              | Users have a conversation. "Source entry" is a storage word.           |
| observation                     | **note**                                      | "A timestamped fact extracted from the conversation." Short, concrete. |
| reflection                      | **insight**                                   | "A durable, synthesized fact distilled from notes."                    |
| observation pool                | **saved notes**                               | It is the set of notes kept in memory.                                 |
| reflection pool                 | **saved insights**                            |                                                                        |
| observer                        | **note-taker** (UI copy: _extracting notes_)  | Says what it does.                                                     |
| reflector                       | **insight-builder** (UI: _building insights_) |                                                                        |
| dropper                         | **pruner** (UI: _pruning memory_)             | "Drop" is jargon; "prune" is an understandable action.                 |
| chunk                           | **reading batch**                             | "How much conversation the note-taker reads at once."                  |
| preamble                        | **existing memory shown as context**          |                                                                        |
| full fold                       | **full memory maintenance**                   | Explains the consequence, not the algorithm.                           |
| pressure / fullness             | **memory is N% full**                         |                                                                        |
| agent turns                     | **steps per memory job**                      |                                                                        |

The names **observer / reflector / dropper appear in toasts and the status
bar** today. Rename user-visible strings there too; keep internal type/function
names as-is to avoid a churn-only refactor.

---

## 2. Rename table (labels + descriptions only — keys do not change)

**Decision §7.5: no JSON key, env-var, or code renames.** Only the _UI label_
and _description_ columns below are actionable. The former "Proposed key"
column is retired — where it still appears, read it as the UI concept name, not
a config key. `docs/CONFIG.md` gets a key/code → UI-surface mapping table.

### Compaction

| Current key                                                                                                          | Proposed key                               | Proposed label                    | Proposed description (user language)                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compaction`                                                                                                         | `compaction` _(values reworked, see §3.1)_ | **When to compact**               | _Choose how chat history is compressed so long sessions keep working._                                                                                            |
| `compactionEngine`                                                                                                   | **merge into `compaction`**                | —                                 | —                                                                                                                                                                 |
| `compactionSummaryMode`                                                                                              | `summaryStyle`                             | **How summaries are kept**        | _Replace: each compaction rewrites one current summary. Append: keep every summary as a separate part; `/blackhole` folds them into one._                         |
| `tailBehavior`                                                                                                       | `recentMessages`                           | **Recent messages kept visible**  | _After compacting, how much of the most recent chat stays on screen. Minimal keeps only your last message; Pi's default keeps roughly the last 20k tokens._       |
| `midRunCompaction`                                                                                                   | `compactDuringLongRuns`                    | **Compacting during a long task** | _Off checks only between tasks. Resume compacts mid-task and continues without interrupting. Pause interrupts so you can review and continue._                    |
| `showPreCompactionMessage`                                                                                           | `showLastOutput`                           | **Keep the last answer visible**  | _After compacting, re-display the newest answer that was scrolled out of context. Display only — never sent to the model._                                        |
| `compactAfterTokens` + `compactAfterRatio` + `compactAfterPreset` (+ `compactAfterPresets`) + `compactReserveTokens` | **shape + band** (see §3.2)                | **Auto-compact when**             | _The point at which blackhole compacts automatically. Presets scale with your model's context window; the floor and ceiling keep it sane when you switch models._ |
| `retainedToolOutputMaxTokens`                                                                                        | `toolOutputBudget`                         | **Tool output kept**              | _How much old tool/command output stays in context. Older output is replaced by a recall pointer, so nothing is lost._                                            |
| `recallResponseMaxChars`                                                                                             | `recallResponseBudget`                     | **Recall answer size**            | _Largest single response the recall tool may return, so one huge old message cannot flood context._                                                               |

### Auto-compaction threshold (the worst offender today)

Six keys plus a magic `81000` migration rule, presenting as four competing
formulations of the same decision. Reworked as **shape + band** (§3.2):

| Control     | Key                                                                           | Role                                    |
| ----------- | ----------------------------------------------------------------------------- | --------------------------------------- |
| Shape       | `compactAfterBy`: `preset` / `percent` / `tokens` / `reserve`                 | how the threshold tracks the window     |
| Curve       | `compactAfterPreset`                                                          | when shape = preset (default)           |
| Value       | `compactAfterRatio` (percent) / `compactAfterTokens` / `compactReserveTokens` | when shape = percent / tokens / reserve |
| Floor       | `compactAfterMinTokens` _(new)_                                               | never compact below N                   |
| Ceiling     | `compactAfterMaxTokens` _(new)_                                               | never wait past N                       |
| Definitions | `compactAfterPresets`                                                         | expert curve editing                    |

`effective = clamp(shape(window), minTokens, maxTokens)`.

Modal presentation: one enum **Auto-compact when** (`Preset (recommended)` /
`Percent of context window` / `Fixed token count` / `Headroom reserve`), the matching value field
shown only when relevant (`visibleWhen`), the preset picker for `preset`, and
**Never compact below** / **Never compact later than** always visible. The
selector removes the old four-tier precedence — exactly one shape is active;
the band always applies.

**Copy requirement.** Every control here needs the §4.0 two-line treatment,
more than anywhere else, because the band is unintuitive without it: slot 1
explains the concept, slot 2 states the current effect. For the ceiling: slot 1
= _Never wait past this many tokens before compacting, whatever the model's
window is_; slot 2 = _At 180000 — on a 1M model this compacts at ~18% full; on
a 256k model the percent rule already fires first_. Same for the floor, the
shape values, and the value field.

### Observational memory — cadence

| Current key          | Proposed key         | Proposed label           | Proposed description                                                                                                                              |
| -------------------- | -------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory`             | `memory`             | **Observational memory** | _Background workers that read your conversation and keep durable notes across compactions._                                                       |
| `observeAfterTokens` | `noteEveryTokens`    | **Take notes every**     | _New conversation tokens before the note-taker runs. Lower = more responsive memory, more background work._                                       |
| `reflectAfterTokens` | `insightEveryTokens` | **Build insights every** | _New conversation tokens before insights are distilled from notes and memory is pruned._ (Note: this currently also gates the pruner — see §3.4.) |

### Observational memory — budgets

| Current key                                                 | Proposed key                       | Proposed label                 | Proposed description                                                                                                                    |
| ----------------------------------------------------------- | ---------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `observationsPoolMaxTokens`                                 | `noteMemoryBudget`                 | **Note memory budget**         | _How many notes are kept in the compacted memory sent to the model. When the saved notes reach this size, memory is folded and pruned._ |
| `reflectionsPoolMaxTokens`                                  | `insightMemoryBudget`              | **Insight memory budget**      | _How many insights are kept in compacted memory. 0 = unlimited._                                                                        |
| `observationsPoolTargetTokens`                              | **DELETE**                         | —                              | No runtime reader (plan-08 §1.4).                                                                                                       |
| `observerChunkMaxTokens`                                    | `noteReadingBatch`                 | **Conversation read per pass** | _How much of the new conversation the note-taker reads in one run. The rest is read on subsequent passes._                              |
| `observerPreambleMaxTokens`                                 | **DELETE** (hardcode 30%)          | —                              | Only overrides a derived default; no product fork.                                                                                      |
| `reflectorInputMaxTokens`                                   | **merge → `memoryReadMax`**        | **Memory read per job**        | _Largest memory snapshot an insight-builder or pruner reads at once._                                                                   |
| `dropperInputMaxTokens`                                     | **merge → `memoryReadMax`**        | (same field)                   | Both default to 80000; they read the same memory pool.                                                                                  |
| `dropperPressureThreshold` + `dropperPoolFullnessThreshold` | **`pruneWhenFull`** (one fraction) | **Prune memory when**          | _Percentage full that triggers pruning of low-value notes (default 70%)._                                                               |
| `agentMaxTurns`                                             | `maxStepsPerJob`                   | **Max steps per memory job**   | _Upper bound on tool/reasoning steps a background memory job may take._                                                                 |

### Advanced (keep, move to an "Advanced" section, label plainly)

| Current key                       | Proposed label                                | Notes                                                                                          |
| --------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `fullFoldAlways`                  | **Keep early notes through first compaction** | Expert.                                                                                        |
| `sessionFallback`                 | **Fall back to session model**                | _If all dedicated memory models fail, use the main chat model. Off = skip that memory update._ |
| `cacheRetention`                  | **Worker prompt caching**                     | Expert (feature branch).                                                                       |
| `providerIdleTimeoutMs`           | **Worker idle timeout**                       | Expert.                                                                                        |
| `workerAttemptTimeoutMs`          | **Worker attempt timeout**                    | Expert.                                                                                        |
| `statusBar`                       | **Footer status bar**                         |                                                                                                |
| `showWorkerNotifications`         | **Memory job notifications**                  |                                                                                                |
| `debug`, `debugLog`               | Debug snapshots / logging                     | Expert.                                                                                        |
| `skipForProviders`, model configs | not in modal                                  | Hand-edited only; keep.                                                                        |

---

## 3. Consolidation proposals

Ordered by confidence. Each notes whether it changes behavior.

### 3.1 Collapse `compaction` + `compactionEngine` (behavior-equivalent)

The 3×2 matrix has fewer distinct outcomes than it appears. From
`compaction-trigger.ts` and `before-compact.ts`:

- `compaction: "off"` and `compactionEngine: "pi-default"` **both** skip
  blackhole's auto-trigger and **both** let Pi handle `/compact`, while
  `/blackhole` still uses the blackhole pipeline. They are the same behavior
  with two different reasons.
- `compaction: "manual"` also skips auto + `/compact` for blackhole, but
  additionally routes OM output to per-session pending buffers
  (`isManualMode`) to be flushed on `/blackhole`.

Proposed single enum:

```jsonc
"compaction": "automatic" | "manual" | "off"
// automatic — blackhole compacts automatically (default)
// manual    — only /blackhole; memory output buffered until then
// off       — blackhole steps aside; Pi handles automatic compaction
```

Delete `compactionEngine`. `tailBehavior`, `summaryStyle`, etc. are only
consulted when blackhole is actually handling a compaction, so they become
naturally irrelevant in `off`. **Behavior-equivalent** for all currently
reachable states; only removes the ability to express the redundant
`auto + pi-default` combination.

### 3.2 Rework the auto-compaction threshold surface (keep granularity)

**The original "collapse to one knob" is rejected** (owner decision). A single
scalar cannot serve a user who runs a 1M model and a 256k model in the same
conversation, and a flat percentage is window-blind. The surface becomes a
**shape plus a band**:

| Control     | Key                                                                           | Role                                    |
| ----------- | ----------------------------------------------------------------------------- | --------------------------------------- |
| Shape       | `compactAfterBy`: `preset` / `percent` / `tokens` / `reserve`                 | how the threshold tracks the window     |
| Curve       | `compactAfterPreset`                                                          | when shape = preset (default)           |
| Value       | `compactAfterRatio` (percent) / `compactAfterTokens` / `compactReserveTokens` | when shape = percent / tokens / reserve |
| Floor       | `compactAfterMinTokens` _(new)_                                               | never compact below N                   |
| Ceiling     | `compactAfterMaxTokens` _(new)_                                               | never wait past N                       |
| Definitions | `compactAfterPresets`                                                         | expert curve editing                    |

`effective = clamp(shape(window), minTokens, maxTokens)`.

The selector removes the four-tier precedence (exactly one shape is active);
the band is orthogonal and always applies, so it is not a competing
formulation. All keys stay flat scalars, so the runtime shallow-merge and the
modal deep-merge agree.

**Why the band is essential, not optional** (from reported user cases):

- **1M @ 40%, downgrading to 256k:** `by: percent, ratio: 40, minTokens: 150000`
  → 1M: 400k; 256k: max(102k, 150k) = 150k. The floor absorbs the downgrade.
- **256k @ 120k, Opus 1M @ 180k:** `by: percent, ratio: 46, maxTokens: 180000`
  → 256k: 120k; 1M: min(482k, 180k) = 180k. The ceiling pins the absolute
  operating point on the big window. The default curve is wrong for this user in
  both directions (~184k @256k, ~419k @1M — too late), which is exactly why the
  band must be reachable without editing a curve.

**Known limitation.** Window is a usable proxy for operating point only because
these users' classes differ in window (256k vs 1M). Two models with the _same_
window but different operating points (cheap vs expensive reasoning-heavy) are
not expressible. A per-model threshold override on the model entry is the
robust fix; **flagged, not scoped**.

**Copy requirement.** These controls get the §4.0 two-line treatment more than
anywhere else, because the band is unintuitive: slot 1 explains the concept,
slot 2 states the current effect. For the ceiling: slot 1 = _Never wait past
this many tokens before compacting, whatever the model's window is_; slot 2 =
_At 180000 — on a 1M model this compacts at ~18% full; on a 256k model the
percent rule already fires first_. Same for the floor, the shape values, and the
value field.

**Value semantics (decided, §7.1): percent.** `compactAfterRatio` is entered and
displayed as a percentage in (0, 100], e.g. `46` — not `0.46`.

### 3.3 Merge the two dropper fractions

`anyStageDue` consults two fractions: `dropperPressureThreshold` (prune without
new data at Y% full) and `dropperPoolFullnessThreshold` (a floor — the dropper
never runs below X% full, and it also gates the new-data path). The pressure
path's effective trigger is `max(pressure, fullness)`, but `fullness` is _also_
an independent floor on the new-data path, so the two do not reduce to one value
without either deriving the floor or accepting a change. **One number cannot
encode two.**

**Decided (§7.4): merge to one user-facing knob.** The surviving key is
`dropperPressureThreshold`; `dropperPoolFullnessThreshold` is dropped. To keep
behavior as close to unchanged as possible:

- `pruneWhenFull` is the pressure trigger.
- The new-data floor becomes a **constant** (0.10, today's default), not a knob.
- Migration sets `pruneWhenFull = max(oldPressure, oldFullness)`.

This is exact for every config whose floor was 0.10 — the default and the
overwhelming majority — at any pressure value. It changes only configs that set
`fullness` above 0.10 _and_ above `pressure`: those lose their custom new-data
floor in favor of the constant. That is the one residual divergence; no
single-knob formulation preserves both numbers exactly.

### 3.4 Delete dead and derived knobs (no behavior change)

- `observationsPoolTargetTokens` — no runtime reader (confirmed on current
  tree: only config plumbing, modal, env map). Delete from all layers.
- `observerPreambleMaxTokens` — default `0` auto-computes 30% of
  `observerChunkMaxTokens`. Hardcode the 30% constant. Keep the derived value
  visible in `/blackhole-memory` telemetry, not as a knob.

### 3.5 Merge reflector/dropper input budgets (behavior change only when tuned)

`reflectorInputMaxTokens` and `dropperInputMaxTokens` share the default
(80000) and both cap a memory-snapshot prompt. Collapse to one
`memoryReadMaxTokens`. Users who had intentionally tuned them differently lose
that; acceptable per the back-compat posture. Keep `noteReadingBatch` separate
because it caps a transcript prompt, not a memory prompt. **Merge confirmed
(§7.3).**

### 3.6 Split the pruner cadence from the insight cadence (architecture)

`reflectAfterTokens` is both the insight-build trigger and the pruner's
new-data threshold (plan-08 §1.4). Tuning insight frequency silently retunes
pruning. After §3.3, propose the pruner be governed solely by `pruneWhenFull`
plus new-data availability, and stop overloading `reflectAfterTokens`. This is
the kind of "centralize in a helper" change the root-cause rule in §6 asks for.

### 3.7 Clarify `observationsPoolMaxTokens`'s three jobs (surface, not merge)

It is simultaneously (a) the full-fold trigger in
`buildCompactionProjection`, (b) the rendered observation-line cap via
`selectPriorObservations`, and (c) the basis for the pruner gate. This is why
it looks miscategorized next to `observerChunkMaxTokens` — it operates on
_accumulated memory_, not on _input to a worker_. Keep as one
`noteMemoryBudget` but describe all three consequences in the doc and label it
**Memory budget**, not "Observation pool max". If we later want to split it,
the natural split is _stored-pool maintenance threshold_ vs _rendered output
cap_; out of scope here.

### 3.8 Config file migration → plan-10

Folds and deletions would leave existing users with keys that no longer do
anything. A per-file, atomic migration rewrites their global and project configs
on disk, preserving unknown keys. Design, algorithm, atomicity/read-only
handling, and the test plan live in `work_docs/plan-10-config-migration.md`.

---

## 4. UI/presentation proposal

The vendored modal already supports sections, `depth`, `visibleWhen`, and
two-line help (`description` + `valueDescriptions`) with no `pi-base` change.
Only the _dynamic_ numeric value line needs a small vendored addition (see
§4.6).

### 4.0 The two-line help convention

The modal already renders two description blocks for any field that defines
both (see `renderFieldDesc`, `src/pi-base/settings/render.ts:356`):

```
description            → always shown, muted   (what the knob is)
valueDescriptions[value] → shown when defined, accent (what your current choice does)
```

This is exactly the disambiguation the user asked for after noticing it on
_Show pre-compaction output_. It is not config-dependent and not field-shape
dependent — it is a per-field schema choice. Today only a handful of fields
populate `valueDescriptions` (on live: `showPreCompactionMessage`, `memory`;
on this branch also `showWorkerNotifications`). Roll it out deliberately.

**The copy contract for the two slots.** The two slots are not
interchangeable, and the split maps directly onto what the renderer can
express:

| Slot       | Field                      | Shown                      | Content                                                                                                                                                          |
| ---------- | -------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 (muted)  | `description`              | always                     | **What it does** — outcome-level explanation, no internal nouns. Value-independent tuning guidance ("raise to retain more detail") goes at the end of this slot. |
| 2 (accent) | `valueDescriptions[value]` | only for the current value | **What your value means + how to tune** — the concrete consequence of the current value, and which way to move it.                                               |

Rationale: slot 2 is _value-keyed_, so it can only state things conditional on
the current value. Anything stable across values belongs in slot 1.

Worked example (`noteMemoryBudget`):

```
Line 1 (muted)  How many notes are kept in the compacted memory sent to the
                model. When saved notes reach this size, memory is folded and
                pruned. Raise it to retain more detail; lower it to send less
                memory every turn.
Line 2 (accent) At 20000 — memory is pruned once notes reach ~20k tokens
                (the default).
```

Rollout per field type:

- **Booleans** → add `valueDescriptions: { on, off }` to every toggle
  (`sessionFallback`, `fullFoldAlways`, `statusBar`, `debug`, `debugLog`).
- **Enums** → add `valueDescriptions` keyed by option (all compaction enums,
  `autoCompact.when`, `cacheRetention`). `optionLabels` keeps the value-cell
  text; `valueDescriptions` supplies the focused current-option explanation.
- **Numbers** → see §4.6.

1. **Semantic grouping.** Replace the current implementation-layer ordering
   with concept sections, authored _after_ the branch merge so
   `showWorkerNotifications` and `cacheRetention` land in the right place from
   the start. Each section is a `type: "section"` row; the order below is the
   modal order.

   **Compaction** _(how history is compressed)_
   - `compaction` — When to compact
   - `summaryStyle` — How summaries are kept
   - `recentMessages` — Recent messages kept visible
   - `compactDuringLongRuns` — Compacting during a long task
   - `showLastOutput` — Keep the last answer visible

   **When to compact automatically**
   - `compactAfterBy` — Auto-compact when
   - `compactAfterRatio` / `compactAfterTokens` — _(depth 1, conditional)_ the value
   - `compactAfterPreset` — _(depth 1, conditional)_ the preset
   - `compactAfterMinTokens` — _(depth 1)_ Never compact below
   - `compactAfterMaxTokens` — _(depth 1)_ Never compact later than

   **Context budgets** _(what stays in provider context)_
   - `toolOutputBudget` — Tool output kept
   - `recallResponseBudget` — Recall answer size

   **Memory — behavior**
   - `memory` — Observational memory
   - `noteEveryTokens` — Take notes every
   - `insightEveryTokens` — Build insights every
   - `pruneWhenFull` — Prune memory when

   **Memory — sizes**
   - `noteMemoryBudget` — Note memory budget
   - `insightMemoryBudget` — Insight memory budget
   - `noteReadingBatch` — Conversation read per pass
   - `memoryReadMaxTokens` — Memory read per job

   **Advanced**
   - `fullFoldAlways` — Keep early notes through first compaction
   - `sessionFallback` — Fall back to session model
   - `cacheRetention` — Worker prompt caching
   - `agentMaxTurns` — Max steps per memory job
   - `providerIdleTimeoutMs` — Worker idle timeout
   - `workerAttemptTimeoutMs` — Worker attempt timeout
   - `statusBar` — Footer status bar
   - `showWorkerNotifications` — Memory job notifications
   - `debug` — Debug snapshots
   - `debugLog` — Debug JSONL logging

   This fixes the concrete scattering in today's list: the threshold knobs are
   no longer split by `retainedToolOutputMaxTokens`, `fullFoldAlways` is no
   longer buried after the timeout knobs, and `sessionFallback` no longer sits
   above the cadence knobs.

2. **`depth` + `visibleWhen` for related sub-fields.** The threshold controls
   sit at `depth: 1` under the `compactAfterBy` selector: the value field is
   visible when `compactAfterBy !== "preset"`, the preset picker when
   `compactAfterBy === "preset"`, and the floor/ceiling always visible. The
   group reads as one decision with its parameters. Apply the same pattern to
   any future merged surface.
3. **Human units in `valueNote`**: tokens are meaningless to most users. Show
   _"~15k tokens ≈ 10–15 messages"_ / _"185k ≈ 90% of a 200k model"_ next to
   the value. The modal already renders a dim suffix (`valueNote`).
4. **Keep a curated default config (§7.6).** `scaffoldConfig()` currently writes
   all of `DEFAULTS`. Reduce it to a small curated subset (the meaningful,
   likely-to-be-tuned keys); do not write `{}` and do not dump every default.
   The loader already fills any absent key at read time.
5. **Rename worker names in user-visible strings** (toasts, status bar):
   note-taker / insight-builder / pruner.
6. **Dynamic numeric value line (small vendored change).** `valueDescriptions`
   for numbers is `Record<string, string>` keyed by the exact stringified
   value, which is unusable for arbitrary token counts. Add to `FieldBase`:

   ```ts
   /** Value-aware second help line (slot 2); rendered in the valueDescription slot. */
   valueDescription?: (value: unknown) => string | undefined;
   ```

   and render its return in the accent slot of `renderFieldDesc`. Then numeric
   knobs can satisfy the §4.0 contract: slot 1 carries the stable "what it does"
   and tuning direction, slot 2 the computed current-value consequence —
   _"~15k tokens ≈ 10–15 messages"_, _"At 185000 — compacts at ~90% of a 200k
   model"_, _"At 0.70 — prunes once memory is 70% full"_. ~10 lines, surgical, no
   change to existing fields. Falls back cleanly to the current single-line
   behavior when absent. If vendored churn is unwanted, `valueNote` (dim row
   suffix) is the no-change fallback, at lower prominence and in the row rather
   than the description block.

### 4.7 User-facing shell copy (notifications, status bar, command output)

A reported issue (same class of problem, one layer up from config labels):
notifications say _which internal process_ is running
(`observer`, `reflector`, `dropper`, `token chunk`, `accumulated`) instead of
_what blackhole is doing for the user_. The config-vocabulary work in §1 is the
same fix; apply it to every shell string. Rule: **shell copy states the user
outcome, not the stage name.**

**Notifications** (`runtime.tryEmitWorkerInfo` callers in
`src/om/consolidation.ts`; `runtime.ts` warnings/errors):

| Current                                                                                  | Proposed                                                                                                                                |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `Observational memory: observer running on ~40,000-token chunk (of 185,000 accumulated)` | `blackhole: reading recent conversation for notes (~40k of 185k new tokens)`                                                            |
| `Observational memory: N observations recorded`                                          | `blackhole: saved N notes`                                                                                                              |
| `Observational memory: no observations — model did not call the observation tool`        | `blackhole: no new notes — the model returned nothing usable`                                                                           |
| `Observational memory: no observations — <reason>`                                       | `blackhole: no new notes — <plain reason>`                                                                                              |
| `Observational memory: reflector running (~X tokens accumulated, ~Y-token input)`        | `blackhole: building insights from saved notes`                                                                                         |
| `Observational memory: dropper running (~X tokens accumulated, ~Y-token input)`          | `blackhole: pruning low-value notes`                                                                                                    |
| `Observational memory: <stage> skipped — <reason>`                                       | `blackhole: skipping memory update — <plain reason>`                                                                                    |
| `Observational memory: <phase> failed: <msg>`                                            | `blackhole: memory update failed — <msg>`                                                                                               |
| `blackhole: N source entries processed; tail kept n/m user turns (~0.5k tok)`            | `blackhole: compacted N conversation entries; kept the last n of m turns (~0.5k tokens)`                                                |
| `blackhole: Nothing to compact (no live messages)`                                       | `blackhole: nothing to compact`                                                                                                         |
| `blackhole: Too few live messages — … Set tailBehavior …`                                | `blackhole: too few messages to compact — Pi keeps a larger recent window; choose a smaller `Recent messages kept visible` to force it` |

**Status bar** (`src/om/status-bar.ts`, `[type]` labels): `observer` →
`notes`, `reflector` → `insights`, `dropper` → `pruning`, `compact` →
`compacting`.

**Toast token detail stays.** The rewrite changes wording only. The concrete
numbers (`~40k of 185k`, input sizes) remain, because they are the honest
signal of what is actually being sent to the model. Do not truncate them to a
bare action phrase.

**Gauges — keep `O`/`P`/`X` as-is (decided).** They measure accumulation, not
workers: `O` = conversation since the last note-taking run, `P` = note-memory
fill, `X` = context since the last compaction. Renaming to `O`/`R`/`D` was
considered and rejected: it would wrongly imply observer/reflector/dropper, and
neither `P` nor `X` is a reflector or dropper pool (the spinner's `[type]`
label already reports the running worker). `n`/`m`/`c` was rejected as equally
opaque. The mitigation for the letters is documentation: keep the `statusBar`
legend in `docs/CONFIG.md` in sync (it already spells out O/P/X).

**`/blackhole-memory`** (`src/commands/memory.ts`): rename the `── Pipeline ──`
lines — `Observer:` → `Notes:`, `Reflector:` → `Insights:`, `Dropper:` →
`Pruning:`, `Obs pool:` → `Note memory:`, `Reflect pool:` → `Insight memory:`,
`Consolidation: running (observer)` → `Memory update: running (reading notes)`, and
_"Transcript accumulated since last run. Triggers when exceeding threshold."_ →
_"New conversation since the last memory update. A run starts once it passes the threshold."_

### 4.8 Key legend in the modal (user request)

Surface the underlying JSON key in the focused field's description block — a
final dim line like `key: observationsPoolTargetTokens` — so a user can map the
UI label to the file and tune it by hand.

- **Automatic (recommended).** Render `key: <field.key>` in `renderFieldDesc`
  from the field's own `key`. No per-field authoring, so it can never drift from
  the real key; it also matches the one-to-one field↔key mapping ConfigManager
  already assumes. Small vendored addition to `pi-base/settings/render.ts`
  (same file as §4.6).
- **Hand-authored.** Append `key: …` to each `description`. Zero vendored
  change, but ~30 strings that will drift.

Prefer automatic. For a field that maps to more than one key (a fold whose
survivor is a pair), list them comma-separated. This makes the `docs/CONFIG.md`
key→UI mapping table (§7.5) a convenience rather than the only bridge.

---

## 5. Sequencing

Each phase is independently shippable and revertible.

1. **P1 — pure labels/descriptions** (no schema change). Rename every label and
   description in `blackhole-settings.ts`, add section headers and `valueNote`
   hints, and apply the §1 vocabulary to all shell copy — toasts, status-bar
   `[type]` labels, and `/blackhole-memory` output (§4.7). Add the key/code →
   UI-surface mapping table to `docs/CONFIG.md` (§7.5) and update `llms.txt`.
   No behavior, no key churn.
2. **P2 — delete dead/derived knobs** (§3.4): `observationsPoolTargetTokens`,
   `observerPreambleMaxTokens`. Schema, modal, env map, docs, tests.
3. **P3 — threshold surface rework** (§3.2: shape selector + floor/ceiling,
   keep reserve) + collapse `compaction`/`engine` (§3.1). The largest change;
   touches loader, resolver, modal, env, docs.
4. **P4 — merge memory knobs** (§3.3, §3.5, §3.6). Behavior changes land here;
   ship with before/after notes in CHANGELOG and observe pruner logs.
5. ~~**P5 — key renames**~~ **Cancelled (§7.5).** No JSON key, env-var, or code
   identifier renames. P1's UI relabeling plus the CONFIG.md mapping carries the
   readability win.
6. **Docs — replace the stale migration guide.** `docs/MIGRATION-GUIDE.md`
   documents the PR #14-era legacy migration (`passive` / `noAutoCompact` /
   `overrideDefaultCompaction`) and is no longer relevant. Rewrite it as the
   final upgrade note for this work: which keys are folded/added/removed, how the
   on-disk migration rewrites them (plan-10), and the label↔key mapping. Update
   the README docs-table entry that points at it. Also **delete
   `docs/OLD_CONFIG.md`** (the legacy pi-vcc config reference) and its README
   docs-table entry — the old surface is gone. **Keep `example-config-old.json`**:
   it is the real fixture for the migration tests (plan-10 §7) — do not delete.
   CHANGELOG history is left as-is. Land with the last of P2–P4 so the key set is
   final.
7. **P6 — config file migration (plan-10).** Lands after the folds (P3/P4) fix
   the final key set. Rewrites existing global and project files, atomically and
   per-scope, preserving unknown keys and respecting read-only installs. See
   `work_docs/plan-10-config-migration.md`.
8. **Exit gate — migration notice.** The release carrying this work must bump
   the version-gated notice in `src/changelog/migration-notice.ts` so users are
   told once that their config was migrated, to review their settings, and to
   read the upgrade guide; the message points at `/blackhole changelog`. The
   release is not done until this fires. Details: plan-10 §9.

---

## 6. Governance rule (so this doesn't recur)

Add to the project conventions:

> **A config knob is a last resort.** A fix gets a knob only when there is a
> genuine product fork that a reasonable default cannot resolve. A value that
> can be derived (a ratio of another knob, a cap computed from an input size)
> is a constant, not a knob. A behavior that needs to change per incident is a
> helper with a better default, not a new switch. Every knob must name a
> user-observable outcome, and must be describable in one sentence without an
> internal noun (`pool`, `chunk`, `preamble`, `fold`, `source entry`).

Knob review checklist for new PRs:

- Does a sensible default remove the need for this knob?
- Can it be derived from an existing knob? If so, derive it.
- Does it duplicate a precedence tier of another knob? Merge.
- Is it observable by the user (an outcome), or only by us (a mechanism)?
  Mechanism-only settings belong in the config file as expert keys, not the
  basic modal.
- Does the description survive the "no internal nouns" test?

---

## 7. Decisions (resolved)

1. **Percent, not ratio.** `compactAfterBy: "percent"` with `compactAfterRatio`
   stores and displays a percentage in (0, 100], e.g. `46` — not `0.46`. See §3.2.
2. **`manual` stays a top-level compaction mode.** Do not fold it into an expert
   flag. `/blackhole` manual compaction is a must-have, marquee explicit flow.
3. **Merge the reflector and dropper input budgets.** One `memoryReadMax`
   surface; they read the same data and do not need independent toggles. §3.5.
4. **Pruning merges to one knob, behavior preserved as far as possible.**
   `pruneWhenFull` (surviving key `dropperPressureThreshold`) replaces both
   fractions; the new-data floor becomes the constant 0.10; migration sets it to
   `max(oldPressure, oldFullness)`. Exact except for configs with a custom floor
   above 0.10 (the one residual divergence). §3.3.
5. **No key or code renames.** Keep every JSON key, env var, and code
   identifier as-is. Only UI labels/descriptions change. `docs/CONFIG.md` gains
   a key/code → UI-surface mapping table. Cancels the old P5. (Deletion of the
   dead keys — P2 — is separate and stands.)
6. **Keep a curated default config.** New installs keep scaffolding a small
   curated subset of keys (the curated defaults) — not `{}`, not the full
   `DEFAULTS` dump.
7. **Migration is reinstated.** Plan-09's original no-migration posture is
   reversed: real config files are rewritten on disk (plan-10). Folds/adds/
   deletions are migrated, unknown keys are preserved, and the modal needs no
   change because files are current before it reads them.

### 7.1 How a fold works (corrected)

A fold is a **net key reduction**, not an addition. One key survives (or a new
key _replaces_ several) and the consumed keys stop being read — plan-10 removes
them from existing files and writes the surviving/new keys in their place. This
does require
updating every reader of the consumed keys, but those readers are a small,
grep-able set concentrated in the config resolver and a few guards. Most
higher-level code already goes through a resolver (`autoCompactThreshold`, the
`isManualMode` helper, etc.) rather than reading the raw keys, so the fan-out is
small.

"Don't add a new key" is compatible with this: a new key that replaces four is a
reduction. The only real choice is _reuse an existing surviving key_ vs.
_introduce one key for the merged concept_.

Per group:

| Folded group                                                | Surviving key                            | New key?                                                                                 | Readers to update                                                                                   |
| ----------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `compaction` + `compactionEngine`                           | `compaction` (values reworked)           | no                                                                                       | `compaction-trigger`, `before-compact`, `compact-failed`, `consolidation`, `isManualMode`, commands |
| `compactAfterTokens`+`Ratio`+`Reserve`+`Preset`             | shape selector + value + floor + ceiling | **yes** (selector + floor + ceiling); `compactReserveTokens` kept as the `reserve` value | `model-budget` resolver, `compaction-trigger`, `memory`, config plumbing, modal                     |
| `reflectorInputMaxTokens` + `dropperInputMaxTokens`         | reuse one (UI "Memory read per job")     | no                                                                                       | `consolidation`                                                                                     |
| `dropperPressureThreshold` + `dropperPoolFullnessThreshold` | `dropperPressureThreshold`               | no                                                                                       | `consolidation`, `progress`, `memory`                                                               |
| `observationsPoolTargetTokens`, `observerPreambleMaxTokens` | — (delete)                               | n/a                                                                                      | config plumbing, modal, `memory`                                                                    |
| `debug` + `debugLog`                                        | **not folded** (user decision)           | n/a                                                                                      | —                                                                                                   |

Of the real folds, `compaction`+engine, the two input budgets, and the two
dropper fractions each reuse an existing key. The threshold group is not a
simple collapse — it is the shape+band rework in §3.2 (selector + floor +
ceiling, with `compactReserveTokens` kept as the `reserve` shape). The per-model
threshold override that would handle same-window/different-operating-point cases
is deliberately out of scope (§3.2, §8).

This supersedes the earlier "presentation-only vs add-a-key" framing:
presentation-only (keep all keys, merge only in the modal) is **rejected** — it
is not a fold.

---

## 8. What this plan deliberately does not do

- Rename any JSON key, env var, or internal TypeScript identifier
  (`Observation`, `runObserver`, `dropperPressureReached`). Only UI copy
  changes (§7.5).
- Rework the observation/reflection rendering algorithm.
- Add a Basic/Advanced _toggle_ to the vendored modal. Section ordering +
  `visibleWhen` achieve the goal without touching `pi-base`.
- Split `noteMemoryBudget` into its three constituent roles (§3.7) — flagged,
  not scoped.
- Add a per-model compaction-threshold override. The window-based shape+band
  (§3.2) covers classes that differ in window; same-window classes with
  different operating points would need a threshold on the model entry.
  Flagged, not scoped.
