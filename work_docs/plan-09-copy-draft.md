# Plan 09 — Copy draft (for review)

Companion to `plan-09-config-vocabulary.md`. This is the actual wording to
review and approve before it lands in `blackhole-settings.ts`.

**Conventions**

- **Label** — the row text in the config modal. UI-only; the JSON key does not
  change.
- **Slot 1** — the always-visible muted line: _what the knob does_, outcome-level,
  no internal nouns.
- **Slot 2** — the accent line shown for the current value: _what your value
  means right now, and which way to turn it._ For enums/booleans one line per
  option; for numbers a function of the value (examples shown at the default and
  at typical tuned values).
- Keys shown for the §4.8 `key:` legend.

---

## Compaction

### When to compact — `compaction`

Merged control (§3.1): `compactionEngine` is folded in and dropped.

- **Slot 1:** How blackhole handles compaction of the chat history. Automatic
  compacts on its own when the threshold is reached; manual only compacts when
  you run `/blackhole`; off leaves compaction to Pi.
- **Slot 2:**
  - `automatic` — blackhole compacts automatically when the threshold is reached
    (recommended).
  - `manual` — only `/blackhole` compacts; memory notes are held until then.
  - `off` — blackhole steps aside and Pi handles compaction; `/blackhole` still
    works.

### How summaries are kept — `compactionSummaryMode`

- **Slot 1:** What happens to earlier summaries when a new compaction happens.
- **Slot 2:**
  - `default` — each compaction replaces the previous summary with one current
    summary.
  - `append` — every summary is kept as a separate part; `/blackhole` merges
    them back into one.

### Recent messages kept visible — `tailBehavior`

- **Slot 1:** How much of the most recent chat stays on screen after a
  compaction. Everything before that point is summarized and removed from view.
- **Slot 2:**
  - `minimal` — keep only your last message (default).
  - `pi-default` — keep roughly the last 20k tokens of chat.

### Compacting during a long task — `midRunCompaction`

- **Slot 1:** Whether blackhole may compact while a long task is still running.
- **Slot 2:**
  - `resume` — compact mid-task and continue without interrupting (experimental).
  - `pause` — interrupt the task, compact, and stop so you can review.
  - `off` — only check the threshold between tasks (default).

### Keep the last answer visible — `showPreCompactionMessage`

- **Slot 1:** After a compaction, re-display the newest answer that was scrolled
  out of view. Display only — never sent to the model.
- **Slot 2:**
  - on — the dropped answer is shown again below the compaction card (up to
    16 KiB).
  - off — only the compaction card is shown.

---

## When to compact automatically

### Auto-compact when — `compactAfterBy`

- **Slot 1:** How the auto-compaction point is chosen. A preset adapts to each
  model's context window; percent, fixed, and reserve are simple overrides.
- **Slot 2:**
  - `preset` — the threshold follows a curve scaled to each model's context
    window (recommended).
  - `percent` — the same fraction of every model's window; add a floor or
    ceiling to stay sane across models.
  - `tokens` — the same fixed number of tokens on every model.
  - `reserve` — keep a fixed amount of context free; compact once the remaining
    headroom would drop below it.

### Percent of context window — `compactAfterRatio`

Shown only when Auto-compact when = percent.

- **Slot 1:** Compact once the conversation reaches this percentage of the
  active model's context window. Add a floor and ceiling if you switch between
  very different model sizes.
- **Slot 2 (dynamic):**
  - At 46% — a 256k model compacts at ~120k; a 1M model would compact at ~482k
    unless a ceiling is set.
  - At 40% — a 1M model compacts at ~400k.

### Fixed token count — `compactAfterTokens`

Shown only when Auto-compact when = tokens.

- **Slot 1:** Compact once the conversation reaches this exact number of tokens,
  regardless of the model's context window.
- **Slot 2 (dynamic):**
  - At 180000 — compaction starts at 180k tokens on every model.
  - At 90000 — suited to small local models.

### Headroom reserve — `compactAfterReserveTokens`

Shown only when Auto-compact when = reserve.

- **Slot 1:** Keep this many tokens of context free — compact once the remaining
  headroom would drop below it (threshold = window − reserve). Keeps a constant
  margin on any model size.
- **Slot 2 (dynamic):**
  - At 32768 — a 200k model compacts at ~168k; a 1M model at ~968k.

### Preset — `compactAfterPreset`

Shown only when Auto-compact when = preset.

- **Slot 1:** Which window-scaled curve sets the compaction point. Edit curves in
  the config file under `compactAfterPresets`.
- **Slot 2:**
  - `default` — gently falling curve: ~90% of a small window, ~40% of a 1M
    window.
  - _(custom name)_ — a curve you defined in the config file.

### Never compact below — `compactAfterMinTokens`

- **Slot 1:** Never compact before the conversation grows past this many tokens,
  whatever the percentage or preset says. Protects you when you switch to a
  smaller-context model and the percentage alone would compact far too early.
- **Slot 2 (dynamic):**
  - At 0 — no floor (default).
  - At 150000 — even a 256k model will not compact before ~150k tokens.

### Never compact later than — `compactAfterMaxTokens`

- **Slot 1:** Never let the conversation grow past this many tokens before
  compacting, whatever the percentage or preset says. Useful on very large
  windows where a percentage would wait far too long.
- **Slot 2 (dynamic):**
  - At 0 — no ceiling (default).
  - At 180000 — a 1M model compacts at 180k instead of ~480k.

---

## Context budgets

### Tool output kept — `retainedToolOutputMaxTokens`

- **Slot 1:** How much recent tool and command output stays in context. Older
  output is replaced by a recall pointer, so nothing is lost — it just is not
  sent to the model every turn.
- **Slot 2 (dynamic):**
  - At 20000 — the newest ~20k tokens of tool output stay in context (default).
  - At 0 — no limit; all tool output stays in context.

### Recall answer size — `recallResponseMaxChars`

- **Slot 1:** Largest single answer the recall tool may return, so one huge old
  message cannot flood the context. Full content stays reachable through paged
  drill-downs.
- **Slot 2 (dynamic):**
  - At 48000 — one recall answer is capped at ~48k characters (~12k tokens)
    (default).
  - At 0 — no cap.

---

## Memory — behavior

### Observational memory — `memory`

- **Slot 1:** Background jobs that read your conversation and keep durable notes
  and insights across compactions.
- **Slot 2:**
  - on — memory jobs run and their notes are included in compactions (default).
  - off — no memory jobs and no memory content; compaction still works.

### Take notes every — `observeAfterTokens`

- **Slot 1:** How much new conversation accumulates before the note-taker runs.
  Lower keeps memory more current at the cost of more background calls.
- **Slot 2 (dynamic):**
  - At 15000 — a note-taking pass starts after ~15k new tokens (default).
  - At 8000 — notes keep up with the conversation more closely.

### Build insights every — `reflectAfterTokens`

- **Slot 1:** How much new conversation accumulates before notes are distilled
  into durable insights and memory is pruned of low-value notes.
- **Slot 2 (dynamic):**
  - At 25000 — insights are built and memory is pruned after ~25k new tokens
    (default).
  - At 10000 — memory is consolidated more often.

### Prune memory when — `dropperPressureThreshold`

Survivor of the two dropper fractions (§3.3); `dropperPoolFullnessThreshold` is
dropped.

- **Slot 1:** How full note memory gets, as a share of the note memory budget,
  before low-value notes are pruned. Pruning always needs this threshold.
- **Slot 2 (dynamic):**
  - At 70% — pruning starts once note memory is ~70% full (default).
  - Lower (e.g. 40%) — prune earlier and keep memory lean.
  - Higher (e.g. 90%) — keep more notes and prune later.

---

## Memory — sizes

### Note memory budget — `observationsPoolMaxTokens`

- **Slot 1:** How much note text is kept in the memory sent to the model. Once
  saved notes reach this size, blackhole runs a full memory maintenance pass that
  keeps the most useful notes.
- **Slot 2 (dynamic):**
  - At 20000 — memory is maintained once notes reach ~20k tokens (default).
  - Raise to retain more detail; lower to send less memory every turn.

### Insight memory budget — `reflectionsPoolMaxTokens`

- **Slot 1:** How much insight text is kept in the memory sent to the model.
  Older insights drop out of view but stay available through recall.
- **Slot 2 (dynamic):**
  - At 8000 — the newest ~8k tokens of insights are kept (default).
  - At 0 — keep all insights.

### Conversation read per pass — `observerChunkMaxTokens`

- **Slot 1:** How much new conversation the note-taker reads in one pass.
  Anything beyond this is read on a later pass.
- **Slot 2 (dynamic):**
  - At 40000 — up to ~40k tokens of conversation per pass (default).

### Memory read per job — `reflectorInputMaxTokens`

Merged control (§3.5): `dropperInputMaxTokens` is folded in. _(Note for review:
the surviving key keeps the old name, so the `key:` legend will read
`reflectorInputMaxTokens` under a "Memory read per job" label.)_

- **Slot 1:** Largest memory snapshot an insight-building or pruning job reads at
  once. Lower is cheaper but sees less context.
- **Slot 2 (dynamic):**
  - At 80000 — up to ~80k tokens of memory per job (default).

---

## Advanced

### Fall back to session model — `sessionFallback`

- **Slot 1:** What to do when every model configured for a memory job fails.
- **Slot 2:**
  - on — use your main chat model for that memory job (default).
  - off — skip that memory update instead of spending your chat model on it.

### Max steps per memory job — `agentMaxTurns`

- **Slot 1:** Maximum tool and reasoning steps a single background memory job may
  take before it stops.
- **Slot 2 (dynamic):**
  - At 16 — up to 16 steps per job (default).

### Keep early notes through first compaction — `fullFoldAlways`

- **Slot 1:** Keep notes and insights gathered early in a session through its
  first compaction, instead of letting that compaction start memory fresh.
- **Slot 2:**
  - on — early memory survives the first compaction (default).
  - off — the first compaction starts memory from scratch.

### Memory job prompt caching — `cacheRetention`

- **Slot 1:** Whether memory jobs ask the provider to cache their prompts.
  Caching can cut cost and latency when the same prompt is reused.
- **Slot 2:**
  - unset — use pi's default (`short`).
  - `none` — do not request caching.
  - `short` — pi's default retention.
  - `long` — extended retention where the provider supports it.

### Memory job idle timeout — `providerIdleTimeoutMs`

- **Slot 1:** How long a memory job's model connection may go silent before it is
  treated as dead. 0 disables the timeout; unset uses pi's default.
- **Slot 2 (dynamic):**
  - At 0 — disabled (default).

### Memory job attempt timeout — `workerAttemptTimeoutMs`

- **Slot 1:** Hard time limit for one memory-job model attempt. When it expires,
  blackhole aborts and tries the next fallback model. 0 disables it.
- **Slot 2 (dynamic):**
  - At 0 — disabled (default).

### Footer status bar — `statusBar`

- **Slot 1:** Show the footer memory gauges and background job activity.
- **Slot 2:**
  - on — gauges and job activity shown (default).
  - off — hidden.

### Memory job notifications — `showWorkerNotifications`

- **Slot 1:** Show routine progress messages while background memory jobs run.
  Warnings and errors always show.
- **Slot 2:**
  - on — routine progress messages shown (default).
  - off — quiet; warnings and errors only.

### Debug snapshots — `debug`

- **Slot 1:** Save a detailed snapshot of each compaction to
  `/tmp/pi-blackhole-debug.json` for troubleshooting.
- **Slot 2:**
  - on — snapshots written.
  - off — none (default).

### Debug JSONL logging — `debugLog`

- **Slot 1:** Append a rolling structured log of background activity to
  `~/.pi/agent/pi-blackhole/debug.ndjson`.
- **Slot 2:**
  - on — log written (rotates at 10 MB).
  - off — none (default).

---

## Fields intentionally not drafted

- `observationsPoolTargetTokens` — deleted (§3.4).
- `observerPreambleMaxTokens` — deleted (§3.4), 30% of the reading batch is now a
  constant.
- `dropperPoolFullnessThreshold` — folded into Prune memory when (§3.3).
- `dropperInputMaxTokens` — folded into Memory read per job (§3.5).
- `compactionEngine` — folded into When to compact (§3.1).
- `compactAfterPresets`, `skipForProviders`, model configs — file-only, not in the
  modal.
