# pi-blackhole

**Deterministic compaction + session-aware observational memory for [Pi](https://github.com/earendil-works/pi) — in one unified extension.**

`/blackhole` replaces Pi's LLM-based `/compact` with an algorithmic structural summary — fast, zero-cost. Three background workers (Observer, Reflector, Dropper) capture durable facts and decisions that survive across compactions. Per-worker model fallback chains with persisted cooldowns. Manual flush mode. One JSON file to configure it all.

---

## Install

```bash
# From npm (recommended)
pi install npm:pi-blackhole

# Or directly from GitHub
pi install git:github.com/k0valik/pi-blackhole
```

If you have standalone `pi-vcc` or `pi-observational-memory` installed, remove them first — they conflict and will prevent blackhole from loading:

```bash
pi uninstall npm / git:https://github.com/sting8k/pi-vcc
pi uninstall npm / git:https://github.com/elpapi42/pi-observational-memory
```

Then `/reload` or restart Pi. The config file at `~/.pi/agent/pi-blackhole/pi-blackhole-config.json` is created with sensible defaults — no setup required for the default behavior. Config merges global → project → env → session (session is ephemeral). See **[`docs/CONFIG.md`](docs/CONFIG.md)** for tuning or run `/blackhole settings` to open the interactive overlay.

> **Want a guided setup?** Pass [`llms.txt`](llms.txt) to your agent — it will walk you through the interview, including picking cheap fallback models for your providers.

---

## ✨ What's new

> **Latest release: [0.4.10](CHANGELOG.md#0410---2026-08-29)**
>
> - **Recall & export ranking upgrade** — BM25+, SimHash64, c-TF-IDF, technical density scoring, and surface-form-preserving topic labels for sharper dedup and more readable exports; export preamble now carries a best-effort heuristic warning.
> - **`/blackhole-export` — distilled project-memory export** — Export for long-term agent memory tools - scans all project sessions + pending buffers, fuzzy-dedupes, and writes one import-ready Markdown (`Reflections → Critical → High → Medium → Low`) with topic badges and orphan-gated pending. `out:<path>.md` supported.
> - **Append compaction mode** (`compactionSummaryMode: "append"`) — better prompt caching - keep every auto-compaction summary as an immutable segment visible to the model (`S1 | S2 | …`) instead of rewriting a single summary. `/blackhole` rebases the chain. Opt-in.
> - **Mid-run auto-compaction** (`midRunCompaction: "resume"` | `"pause"`) — **good for goal/task** opt into transparent compaction during long tool loops without interrupting the agent. Default is `"off"`.
> - **Robust compaction-failure handling** — unified `session_compact_failed` (pi >=0.84.3) with correct attribution, overflow-retry visibility, and noise filtering; plus bundled-CLI `AgentSession` resolution so inline compaction works from `dist/bundle/cli.js` ([#62](https://github.com/k0valik/pi-blackhole/pull/62)).

See [`CHANGELOG.md`](CHANGELOG.md) for the full history.

### ⚠️ Upcoming change

> **Default compaction thresholds will become model-context-window-aware** in an upcoming release. Instead of static absolute tokens (`compactAfterTokens: 81000`), default thresholds will derive from your model's effective context window — keeping the same approximate cadence regardless of model size. Existing explicitly-set values will continue to be respected verbatim. If you're using the defaults, no action is needed; the migration is automatic.

---

## What it does

Long engineering sessions degrade. Pi's native `/compact` calls an LLM to write a free-form prose summary — then compacts that summary, then compacts the next. After a few cycles, load-bearing details vanish: why a decision was made, which approaches were rejected, what the user clarified early on. The session is still alive; the agent has stopped carrying the real context.

`pi-blackhole` solves this in two complementary ways:

- **Algorithmic compaction** — a deterministic, zero-cost `compile()` pipeline extracts structured sections (goal, files, commits, preferences, brief transcript) and replaces the old conversation with one compact block. No LLM is called for compaction itself.
- **Observational memory** — three background workers (Observer → Reflector → Dropper) run during the session, capturing timestamped facts and distilling durable reflections in a session ledger that survives every compaction.

Both halves share a single hook and a single output. Together they keep the agent's context sharp across arbitrarily long sessions — without the cost, drift, or erosion of repeated LLM-based summarization.

---

## Commands

| Command | Description & Options |
| --- | --- |
| `/blackhole` | Manual compact — deterministic structural summary |
| `/blackhole settings` | Open the configuration overlay *(Alias: `/blackhole configure`)* |
| `/blackhole changelog` | Open the in-app changelog viewer |
| `/blackhole cleanup` | Remove orphaned pending files |
| `/blackhole om-off` | Disable observational memory |
| `/blackhole om-on` | Enable observational memory |
| `/blackhole-memory` | Memory pipeline status & token counters *(Same as `/blackhole-memory status`)* |
| `/blackhole-memory view` | Show visible observations and reflections (after compaction trimming), copied to clipboard |
| `/blackhole-memory full` | Show **all** recorded memory (including dropped observations), copied to clipboard |
| `/blackhole-recall <query>` | Search session history. Supports `page:N`, `scope:all`, `mode:file|touched`, regex *(Also available to agent as `recall` tool)* |
| `/blackhole-export` | Export distilled project memory (observations/reflections across past sessions + pending buffers) to import-ready markdown *(Options: `out:<path>.md`)* |

All commands work regardless of `compaction` mode — only *when* auto-compaction fires changes. See [Compaction modes](#compaction-modes) below.

### The `recall` tool (agent-facing)

The agent gets one unified `recall` tool that handles every form of historical lookup. Searches read the raw session file directly, bypassing compaction.

| Input | What it does |
|---|---|
| `[12-char hex]` | Recover source evidence for a specific observation or reflection ID from the session ledger. |
| `#N` | Expand a session entry by index (show full content, not truncated). |
| `#N:path` | Drill-down into file content from a tool call (e.g. `#42:auth.ts` shows first 30 lines; `#42:auth.ts:30` shows the next 30; `#42:auth.ts:full` shows everything). |
| Free text | BM25-ranked search across transcript and/or file content. Rare terms weighted higher. |
| `mode:file` | Search only write/edit file content. |
| `mode:touched` | Aggregate all files written/edited across the session, grouped by path. |
| Regex | Pattern search (e.g. `fork.*pi-vcc`, `hook\|inject`). |
| `scope:all` | Search across all session lineages (default: active lineage only). |

When the agent expands a session entry (`#N`), related observations and reflections from the session ledger are automatically shown alongside the expanded content — so the agent gets the raw transcript *and* the durable fact layer in one call.

The `/blackhole-recall` command exposes the same engine to the user. Results are shown as a collapsible message and auto-fed to the agent as context.

---

## Compaction modes

Two modes, one shared goal: keep your agent's context sharp without manual housekeeping. (`compaction: "off"` is a third escape hatch that hands everything back to Pi.)

| | Auto (default) | Manual (`compaction: "manual"`) | Off (`compaction: "off"`) |
|---|---|---|---|
| Workers run? | Yes | Yes | Yes (unless `memory: false`) |
| Observations go to | Conversation markers (invisible in TUI) | Per-session disk buffers | Conversation markers |
| Auto-compact on `agent_end` | Yes — blackhole fires at `compactAfterTokens` | No | No (Pi handles it) |
| `/compact` (Pi built-in) | Replaced by blackhole | Pi handles | Pi handles |
| `/blackhole` | Optional | **Required** to flush + compact | Optional, but works |
| Use case | "Install and forget" | "I want to control when context gets compressed" | "Let Pi handle it, but I want `/blackhole` when I need it" |

Manual mode is the maintainer's daily driver: workers still run, but observations accumulate in `<sessionId>-pending.json` files instead of cluttering the conversation. `/blackhole` flushes the buffer, runs algorithmic compaction, and injects durable reflections in one shot.

`compaction: "off"` + `memory: false` (or `PI_BLACKHOLE_PASSIVE=true`) completely disables all background workers and blackhole's auto-compaction — useful for debugging or comparing against Pi's native path. Explicit `/blackhole` still works in this mode.

#### Who owns the compaction?

With the default `compactionEngine: "blackhole"`, blackhole's `session_before_compact` hook owns every compaction Pi initiates — threshold auto-compact, overflow recovery, and `/compact` — replacing Pi's LLM summarizer with the deterministic pipeline. The only exception is defensive: if both the VCC summary and the OM projection come up empty (a pathological all-noise transcript), blackhole declines and Pi's native summarizer runs, so you never get a context-free replacement. With `compactionEngine: "pi-default"`, `compaction: "manual"`, or `compaction: "off"`, Pi handles everything except explicit `/blackhole`. See [`docs/CONFIG.md` → `compactionEngine`](docs/CONFIG.md#compactionengine) for the full interaction matrix.

### How does `/blackhole` compare to `/compact`?

- `/compact` calls an LLM to write a free-form summary — costly, lossy, no memory layer.
- `/blackhole` uses algorithmic section extraction (goals, files, commits, preferences…) **plus** injects observations and reflections from the session ledger. No LLM is involved in the compaction itself. Fast, deterministic, memory-preserving - the observational memory pipeline's arrived results apply instantly on compaction.

`/blackhole` is essentially a single `/compact` that just works — especially in manual mode.

---

## How it works

When `/blackhole` fires (manually or via the auto-trigger), two things happen in one shot:

1. **The vcc pipeline** analyzes the transcript tail and produces a structured summary: session goal, file changes, commits, outstanding blockers, user preferences, and a rolling brief transcript. Deterministic — same input always produces the same output.
2. **Observational memory injection** renders accumulated observations and reflections from the session ledger and appends them below the summary.

The agent receives a deterministic recap of recent work *plus* durable facts from the full session history — in a single replacement block. No LLM was called for the compaction itself.

---

## Quick start config

Defaults target ~128k context models and work out of the box — no tuning required. To keep costs low, set cheap models for the background workers (the only required change for most setups):

```json
{
  "observerModel":  { "provider": "openrouter", "id": "qwen/qwen3-next-80b-a3b-instruct:free" },
  "reflectorModel": { "provider": "cerebras",   "id": "gpt-oss-120b" },
  "dropperModel":   { "provider": "cerebras",   "id": "gpt-oss-120b" }
}
```

Fallbacks (optional): each worker tries `stageModel → stageFallbacks → base model → session model` (skipping cooled-down models). By default the workers **do not** fall back to your session model — this avoids surprise cost and cache busting. Enable it with `sessionFallback: true` (default) or set `model` as a shared fallback. See [`docs/CONFIG.md` → Model Configuration](docs/CONFIG.md#model-configuration).

Config file: **`~/.pi/agent/pi-blackhole/pi-blackhole-config.json`**

Full reference — every key, default, and env override — lives in:

- 📘 **[`docs/CONFIG.md`](docs/CONFIG.md)** — authoritative config reference. Start here for tuning.
- 🤖 **[`llms.txt`](llms.txt)** — agent-facing interview. Pass it to your agent for a guided setup.
- 📦 **[`example-config.json`](example-config.json)** — annotated example with fallback rationale and `thinking` levels.

---

## Demo

`/blackhole` collapses ~143k tokens of conversation into a ~6.3k structured summary (YMMV based on your settings). `/blackhole-memory` shows pipeline status. `/blackhole-recall` searches history — the agent can do the same via its `recall` tool.

https://github.com/user-attachments/assets/a7dd804d-6aca-4bdb-8b6e-0dd779363a43

### The three memory workers

Three background workers (separate LLM calls) run automatically during the session when `memory: true` (the default):

- **Observer** — reads conversation since the last observation marker and extracts timestamped facts: events, decisions, preferences. Input is capped to `observerChunkMaxTokens` newest-first to prevent context blowup on long sessions. Runs most frequently.
- **Reflector** — distills new observations into durable reflections: stable facts, patterns, and constraints that survive future compactions. Runs less often.
- **Dropper** — prunes low-value observations from active memory when the pool exceeds `observationsPoolMaxTokens`, while keeping reflections and other long-term elements safely in the session ledger.

```
[Conversation turn] ──> (accumulated tokens >= observeAfterTokens)
                            │
                            v
                    1. OBSERVER   (extracts timestamped observations)
                            │
                            v
                    2. REFLECTOR  (synthesizes durable reflections)
                            │
                            v
                    3. DROPPER    (prunes low-value observations)
```

Each worker uses an `agentLoop` with tool-calling capabilities — they don't just make a single LLM call. The observer, for example, can call `record_observations` multiple times per run to work through a chunk incrementally.

If any stage fails (model error, rate limit, timeout), remaining stages are skipped and the full pipeline retries on the next `agent_start` or `turn_end`. A 30-second retry gate prevents hammering failing APIs. Within each stage, the runtime tries all configured fallback models before giving up — each failed model is cooled down and skipped in subsequent attempts.

---

## What the agent sees after compaction

After compaction, the agent sees something like this (sections appear only when relevant — a session with no git commits won't show `[Commits]`):

```
[Session Goal]
- Fix the authentication bug in login flow
- [Scope change]
- Also update the session token refresh logic

[Files And Changes]
- Modified: src/auth/session.ts
- Created: tests/auth-refresh.test.ts

[Commits]
- a1b2c3d: fix(auth): refresh token after password reset

[Outstanding Context]
- lint check still failing on line 42

[User Preferences]
- Prefer Vietnamese responses
- Always run tests before committing

[user]
Fix the auth bug...

[assistant]
Root cause is a missing token refresh...
...transcript continues...

---
The conversation before this point has been compacted into the summary above.
Details not captured here — exact code, error messages, file paths — are only recoverable via `recall`.
Use `recall` to search the session history. Do not redo work already completed.

## Reflections
[c3d4e5f6a1b2] User is building Acme Dashboard on Next.js 15 with Supabase auth.

## Observations
[a1b2c3d4e5f6] 2026-05-23 [high] User decided to switch from REST to GraphQL; motivation was reducing over-fetching.
[b2c3d4e5f6a1] 2026-05-23 [medium] GraphQL migration completed; user confirmed working.

----
Bracketed ids in reflections and observations connect to their source session entries.
These are condensed memories from earlier in this session.
When entries conflict, the most recent observation reflects the latest known state.
Use `recall` with an id to retrieve original context.
----
```

> **Note:** The OM injection format uses `## Reflections` and `## Observations` Markdown headers followed by a brief footer. Each observation and reflection has a 12-char hex identifier the agent (and you, via `/blackhole-recall`) can use to recover source evidence. When no observations or reflections exist, only the short recall-guidance footer is appended.

---

## Feature comparison

| | pi-blackhole | pi-vcc | pi-obs-memory | Pi default |
|---|---|---|---|---|
| Algorithmic compaction (no LLM cost) | ✓ | ✓ | — | — |
| Deterministic output | ✓ | ✓ | — | — |
| Structured summary sections | ✓ | ✓ | — | — |
| Observations + reflections | ✓ | — | ✓ | — |
| Context survives across compactions | ✓ | — | ✓ | — |
| Background memory workers | ✓ | — | ✓ | — |
| Searchable history after compaction | ✓ | ✓ | partial | — |
| Per-worker model config | ✓ | — | — | — |
| Fallback model chains + persisted cooldowns | ✓ | — | — | — |
| Manual flush mode (`compaction: "manual"`) | ✓ | — | — | — |
| Memory toggle (`/blackhole om-off`) | ✓ | — | — | — |
| Unified single-file config | ✓ | — | — | — |
| Per-session pending state | ✓ | — | — | — |

---

## Uninstall

```bash
pi uninstall git:github.com/k0valik/pi-blackhole
rm -rf ~/.pi/agent/pi-blackhole
```

---

## Documentation map

| Doc | Audience | What's in it |
|---|---|---|
| **[`README.md`](README.md)** | You, now | Install, commands, the pitch, the value, the demo. |
| **[`CHANGELOG.md`](CHANGELOG.md)** | You | Every release, what changed, who contributed. |
| **[`docs/CONFIG.md`](docs/CONFIG.md)** | You, when tuning | Every config key with type, default, behavior, and env-var overrides. |
| **[`llms.txt`](llms.txt)** | Your agent | Step-by-step guided setup interview, anti-patterns, exact file paths, internal constants. |
| **[`docs/MIGRATION-GUIDE.md`](docs/MIGRATION-GUIDE.md)** | You, if upgrading | Old → new config key mapping, semantic changes, automatic migration behavior. |
| **[`docs/OLD_CONFIG.md`](docs/OLD_CONFIG.md)** | Reference only | The legacy pi-vcc / pi-observational-memory config surface. Kept for historical context. |
| **[`example-config.json`](example-config.json)** | You | Annotated example config with comments. |
| **[`docs/APPEND_COMPACTION.md`](docs/APPEND_COMPACTION.md)** | You, if curious | Rules for `compactionSummaryMode: "append"`. |

> **Note:** All docs except `README.md`, `CHANGELOG.md` (package root, read by `/blackhole changelog`), and `llms.txt` live under `docs/` — product docs (`architecture.md`, `CONFIG.md`, etc.); `archived_docs/` is local-only (gitignored).

---

## Migration from an older version

If you're upgrading from a pre-0.4.0 config (the old `pi-vcc` / `pi-observational-memory` keys, or an early `pi-blackhole` config with `overrideDefaultCompaction` / `noAutoCompact` / `passive`): see **[`docs/MIGRATION-GUIDE.md`](docs/MIGRATION-GUIDE.md)** for the key mapping, semantic changes, and notes on automatic migration.

The short version: old keys are auto-migrated in memory at load time and the on-disk file is never mutated. Set the new keys explicitly via `/blackhole settings` (alias `/blackhole configure`) to silence the migration notification.

The legacy config surface is documented at **[`docs/OLD_CONFIG.md`](docs/OLD_CONFIG.md)** for reference only — no new keys are added there.

---

## Credits

`pi-blackhole` started as a merge of two upstream projects but has since diverged significantly. The codebase still carries DNA from both:

- **[pi-vcc](https://github.com/sting8k/pi-vcc)** by @sting8k — algorithmic conversation compaction (the `compile()` pipeline, section extraction, recall core).
- **[pi-observational-memory](https://github.com/elpapi42/pi-observational-memory)** by @elpapi42 — session-ledger-based observation/reflection capture, memory agents, ledger folding.

What blackhole adds and reworks on top:

- **Unified configuration** — one JSON file, not two.
- **Per-worker model fallback chains** with persisted cooldowns that survive Pi restarts.
- **Manual flush mode** — `compaction: "manual"` saves observations to per-session disk buffers.
- **Conflict resolution** — OM hooks into vcc's compaction, not Pi's default.
- **Memory toggle** (`/blackhole om-off` / `/blackhole om-on`) — disable the memory layer without uninstalling.
- **Per-session pending state** — isolated per-session JSON files, no cross-session contamination.
- **Custom provider bridge** — consolidation agents loaded via jiti can still use provider stream functions registered by other extensions.
- **Retryable error detection with per-model cooldowns** — models that fail get cooled down, fallbacks tried automatically, 30-second retry gate prevents spam.
- **Improved observer/reflector/dropper prompts** — each heavily customized with detailed extraction rules, relevance guidance, and error handling.
- **OM-recall coupling** — when expanding session entries via `recall`, related observations and reflections are automatically shown.
- **Thinking level support** — per-model `thinking` field for reasoning effort control, including `max` where supported by the provider.

## License

MIT
