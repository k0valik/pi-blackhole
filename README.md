# pi-blackhole

> [!IMPORTANT]
> **Blackhole is the default compaction engine** (`compactionEngine: "blackhole"`, `compaction: "auto"`). Auto-compaction fires at the configured threshold using blackhole's pipeline — both auto-trigger and Pi's `/compact` command use it. No additional setup needed. To work automatically, blackhole needs to register its hook so it overrides /compact with the `blackhole` compaction engine. Opting out or opting for manual compaction with blackhole can be done as below:
>
> | Setting | Auto-trigger after threshold | `/compact` (Pi built-in) |
> |---|---|---|
> | `"auto"` + `"blackhole"` (default) | blackhole handles ✓ | blackhole handles |
> | `"auto"` + `"pi-default"` | Pi handles | Pi handles |
> | `"manual"` + any | skipped | Pi handles ✓ |
> | `"off"` + any | skipped (Pi handles) | Pi handles ✓ |
>
> The `/blackhole` command always uses blackhole's pipeline regardless of settings.
>
> **Upgrading from an older version?** This version replaces legacy keys (`passive`, `noAutoCompact`, `overrideDefaultCompaction`) with `compaction`, `compactionEngine`, and `tailBehavior`. Automatic migration runs at startup — old configs continue to work. Best effort was made to preserve existing behavior, but review [`MIGRATION-GUIDE.md`](MIGRATION-GUIDE.md) if something behaves differently.
>
> See [`CONFIG.md`](CONFIG.md) for the full reference.

**Algorithmic compaction + session-aware observational memory for [Pi](https://github.com/badlogic/pi-mono) — in one unified extension.**

Blackhole merges the best ideas from [pi-vcc](https://github.com/sting8k/pi-vcc) and [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) into something that's become its own beast entirely. Deterministic compaction that costs nothing. A memory layer that survives compactions. Per-worker model fallback chains with persisted cooldowns. Manual flush mode. All configured from one JSON file.

> **Why this exists:** I liked both extensions but they fought each other — OM hooked into Pi's default compaction and blocked vcc from working. So I merged them, made them share a single hook and output, and added everything both were missing: fallback chains, cooldowns, a memory toggle, and a manual mode for people who want to control when context gets compressed.
>
> The codebase has since diverged heavily from both upstreams, but tries to keep up-to-date with any fixes from them.

📖 See [`CHANGELOG.md`](CHANGELOG.md) for release history.
⚙️ See [`CONFIG.md`](CONFIG.md) for the full configuration reference.
🔄 See [`MIGRATION-GUIDE.md`](MIGRATION-GUIDE.md) if upgrading from an older version.
📜 See [`OLD_CONFIG.md`](OLD_CONFIG.md) for the legacy config documentation.

---

## Quick start

```bash
# Install from npm (recommended)
pi install npm:pi-blackhole

# Or directly from GitHub
pi install git:github.com/k0valik/pi-blackhole
```

If you have standalone pi-vcc or pi-observational-memory installed, remove them first — they conflict and will prevent blackhole from working. You don't loose any features from either extension:

```bash
pi uninstall npm / git:https://github.com/sting8k/pi-vcc
pi uninstall npm / git:https://github.com/elpapi42/pi-observational-memory
```

Then `/reload` or restart Pi.

### Automated setup

Pass [`llms.txt`](llms.txt) to your agent and it will walk you through configuration step by step — no need to read all the docs.

### Lockstep with upstreams

pi-blackhole tracks both upstream repositories via a [lockstep audit system](.pi/skills/lockstep/SKILL.md). Every new commit from [pi-vcc](https://github.com/sting8k/pi-vcc) and [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) is classified as safe-to-port, modified (needs review), rewritten (skip), or orphan (needs mapping). Bugfixes and compatible improvements get ported; intentional divergences stay. Nothing is blindly merged — every ported change is reviewed per-commit with human approval. See `.pi/skills/lockstep/` for the full workflow.

---

## Demo

`/blackhole` collapses ~143k tokens of conversation into a ~6.3k structured summary (YMMV based on your settings). `/blackhole-memory` shows pipeline status. `/blackhole-recall` searches history the agent can also reach via its `recall` tool and incrementally search previous conversation history.



https://github.com/user-attachments/assets/a7dd804d-6aca-4bdb-8b6e-0dd779363a43




---

## The problem it solves

Long engineering sessions degrade. Pi's native compaction calls an LLM to write free-form prose summaries — then compacts those summaries, then compacts *those* summaries. After enough cycles, load-bearing details vanish: why a decision was made, what approaches were already rejected, what the user clarified earlier.

The session is still alive. The agent is no longer carrying the real context.

The two upstream projects each solve one half:

- **pi-vcc** replaces Pi's LLM-based compaction with a deterministic, zero-cost algorithmic summary. Fast, reproducible, no hallucination risk. But repeated compactions still erode detail — it's still a summary.
- **pi-observational-memory** captures timestamped observations and durable reflections in a session ledger that survives across compactions. But its compaction path still calls an LLM — costing money and risking drift on every compact.

**pi-blackhole** puts vcc in the compaction slot and OM in the memory layer, where each does what it's designed for.

---

## How it works

When you run `/blackhole` (or when auto-compaction fires), two things happen in one shot:

1. **The vcc pipeline** analyzes the transcript tail and produces a structured summary: session goal, file changes, commits, outstanding blockers, user preferences, and a rolling brief transcript.
2. **Observational memory injection** renders accumulated observations and reflections from the session ledger and appends them below the summary.

The agent receives a deterministic recap of recent work *plus* durable facts from the full session history — in a single replacement block. No LLM was called for the compaction itself.

### The three memory workers

Three background workers (separate LLM calls) run automatically during the session (when `memory: true`, which is the default):

- **Observer** — reads conversation since the last observation marker and extracts timestamped facts: events, decisions, preferences. Input is capped to `observerChunkMaxTokens` newest-first to prevent context blowup on long sessions. Runs most frequently.
- **Reflector** — distills new observations into durable reflections: stable facts, patterns, and constraints that survive future compactions. Runs less often.
- **Dropper** — prunes low-value observations from active memory when the pool exceeds `observationsPoolMaxTokens`, while keeping reflections and other long-term elements safely in the session ledger.

```
[Conversation turn] ──> (accumulated tokens >= observeAfterTokens)
                            │
                            v
                    1. OBSERVER
                       (extracts timestamped observations via agent loop)
                            │
                            v
                    2. REFLECTOR
                       (synthesizes durable reflections via agent loop)
                            │
                            v
                    3. DROPPER
                       (prunes low-value observations, keeps reflections)
```

Each worker uses an `agentLoop` with tool-calling capabilities — they don't just make a single LLM call. The observer, for example, can call `record_observations` multiple times per run to work through a chunk incrementally.

### Graceful degradation

If any stage fails (model error, rate limit, timeout), remaining stages are skipped and the full pipeline retries on the next `agent_start` or `turn_end`. A 30-second retry gate prevents hammering failing APIs. Within each stage, the runtime tries all configured fallback models before giving up — each failed model is cooled down and skipped in subsequent attempts.

### What the agent sees after compaction

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

## Reflections
[c3d4e5f6a1b2] User is building Acme Dashboard on Next.js 15 with Supabase auth.

## Observations
[a1b2c3d4e5f6] 2026-05-23 [high] User decided to switch from REST to GraphQL; motivation was reducing over-fetching.
[b2c3d4e5f6a1] 2026-05-23 [medium] GraphQL migration completed; user confirmed working.

----
Use `recall` to search for prior work, decisions, and context from before this summary. Do not redo work already completed.

These are condensed memories from earlier in this session.

- Reflections: stable, long-lived facts about the user, project, decisions, and constraints.
- Observations: timestamped events from the conversation history, in chronological order.

Treat these as past records. When entries conflict, the most recent observation reflects the latest known state. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.

When exact source context is needed for precision or traceability, use the `recall` tool with the relevant observation or reflection id.
----
```

> **Note:** The OM injection format uses `## Reflections` and `## Observations` Markdown headers with a preamble and footer. Each observation and reflection has a 12-char hex identifier you can use with the `recall` tool to recover source evidence, as well as the agent can search based on them and get relevant context back.

---

## Compaction modes

Two modes, one shared goal: keep your agent's context sharp without manual housekeeping.

- **Auto mode (default):** install and forget. Workers run, observations are appended as invisible conversation markers, compaction fires automatically when tokens exceed threshold.
- **Manual mode (`compaction: "manual"` — the maintainer's daily driver):** same workers, same pipeline. But observations go to per-session disk buffers and compaction only happens when you run `/blackhole`. Cleaner conversation, manual schedule.

The tradeoff is simplicity vs cleanliness:

| | Auto (default) | Manual (`compaction: "manual"`) |
|---|---|---|
| Workers run? | Yes | Yes |
| Observations go to | Conversation markers (invisible in TUI) | Disk (`<sessionId>-pending.json`) |
| Observations accumulate across runs | Branch markers (replaced each cycle) | Pending batches accumulated — `/blackhole-memory` shows pending counts |
| Auto-compact on `agent_end` | Yes | No |
| `/blackhole` | Optional — use it whenever you want | Required to flush + compact |
| Conversation history | OM marker entries between turns (they exist but don't clutter the display) | Clean — nothing between turns |
| Use case | "I don't want to think about it" | "I want to control when context gets compressed" |

**Does `/blackhole` work like a single `/compact` that Just Works?**

Yes, that's exactly the idea, especially in manual mode. When you feel context is getting full or accuracy is slipping, type `/blackhole`. It flushes any accumulated observations from disk, runs algorithmic vcc compaction (zero LLM cost), and injects your durable reflections into the replacement block. One command, everything gets compressed while keeping your session memory alive.

The difference from Pi's built-in `/compact`:
- `/compact` calls an LLM to write a free-form summary — costly, lossy, no memory layer.
- `/blackhole` uses algorithmic section extraction (goals, files, commits, preferences...) plus injects observations/reflections from the session ledger. No LLM involved in the compaction itself. Fast, deterministic, memory-preserving.

### Fully disabled

Set `compaction: "off"` and `memory: false` (or the environment variable `PI_BLACKHOLE_PASSIVE=true` which sets both) to completely disable all background workers and blackhole's auto-compaction trigger. Pi handles auto-compaction normally. Explicit `/blackhole` still uses blackhole's pipeline. This is useful for debugging or if you want manual-only blackhole involvement.

### Without observational memory (vcc-only)

Set `memory: false` or run `/blackhole om-off` for pure vcc compaction — no background workers, no memory injection. The compaction still uses the algorithmic vcc pipeline (not Pi's LLM-based compaction). Re-enable with `/blackhole om-on` or setting `memory: true`.

This is a lighter alternative to `compaction: "off"`: workers are off but blackhole's compaction engine still handles compaction.

---

## Commands

| Command | What it does |
|---|---|
| `/blackhole` | Compact the conversation. Subcommands: `om-off` / `om-on` toggle observational memory. |
| `/blackhole-memory` (or `status`) | Pipeline status: token progress, observation/reflection counts, pending data, last errors |
| `/blackhole-memory view` | Show visible observations and reflections (after compaction trimming), copied to clipboard |
| `/blackhole-memory full` | Show ALL recorded memory (including dropped observations), copied to clipboard |
| `/blackhole-recall <query>` | Search session history. Supports `page:N`, `scope:all`, `mode:file|transcript|touched` |

## Tools

The agent gets a unified `recall` tool that handles three types of input:

| Input | What it does |
|---|---|
| `[12-char hex]` | Recover source evidence for a specific observation or reflection ID from the session ledger |
| `#N` | Expand a session entry by index (show full content) |
| `#N:path` | Drill-down into file content from a tool call (e.g. `#42:auth.ts` shows first 30 lines; `#42:auth.ts:30` shows next 30; `#42:auth.ts:full` shows everything) |
| Free text | BM25-ranked OR search across transcript and/or file content. Rare terms weighted higher. |
| `mode:file` | Search only write/edit file content |
| `mode:transcript` | Search only conversation text |
| `mode:touched` | Aggregate all files written/edited, grouped by path with entry indices |
| Regex | Pattern search (e.g. `fork.*pi-vcc`, `hook|inject`) |
| `scope:all` | Search across all session lineages, not just the active one |

---

## Configuration

All settings in a single JSON file: **`~/.pi/agent/pi-blackhole/pi-blackhole-config.json`** — auto-created with defaults on first startup. See [`CONFIG.md`](CONFIG.md) for the full reference with detailed explanations for every knob. An annotated example config with the new config surface is at [`example-config-v2.json`](example-config-v2.json). The legacy example is at [`example-config.json`](example-config.json).

Quick start — just set custom models (if you want):

```json
{
  "observerModel":  { "provider": "openrouter", "id": "qwen/qwen3-next-80b-a3b-instruct:free" },
  "reflectorModel": { "provider": "cerebras",   "id": "gpt-oss-120b" },
  "dropperModel":   { "provider": "cerebras",   "id": "gpt-oss-120b" }
}
```

Everything else has sensible defaults.

### Settings at a glance

| Setting | Default | What it controls |
|---|---|---|
| `compaction` | `"auto"` | When compaction triggers: `"auto"` (blackhole auto-fires), `"manual"` (only `/blackhole`), `"off"` (Pi handles auto + `/compact`, `/blackhole` still works) |
| `compactionEngine` | `"blackhole"` | Which engine handles auto-compaction: `"blackhole"` or `"pi-default"`. Only meaningful when `compaction: "auto"` — for `"manual"`/`"off"` the hook lets Pi handle everything except `/blackhole` |
| `tailBehavior` | `"minimal"` | How much of the transcript stays visible after compaction: `"minimal"` (last user message only, default) or `"pi-default"` (gentle, ~20k tokens) |
| `memory` | `true` | `false` = OM workers off + no memory injection (compaction still runs) |
| `model` | — | Base fallback model for all workers (last resort before session model) |
| `observerModel` / `observerFallbackModels` | — / `[]` | Primary + fallback models for observer (extracts facts) |
| `reflectorModel` / `reflectorFallbackModels` | — / `[]` | Primary + fallback models for reflector (synthesizes reflections) |
| `dropperModel` / `dropperFallbackModels` | — / `[]` | Primary + fallback models for dropper (prunes observations) |
| *(per model)* `thinking` | `"low"` | Thinking/reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| *(per model)* `cooldownHours` | `1` | How long to skip this model after a retryable error |
| *(per model)* `contextWindow` | *(inherited from Pi)* | Override context window for this model. If unset, inherits from Pi's model registry. When set, the OM pipeline checks if the estimated input fits before calling the model — if not, the next fallback is tried. |
| `observeAfterTokens` | `15000` | Min accumulated tokens before observer runs |
| `reflectAfterTokens` | `25000` | Min accumulated tokens before reflector + dropper run |
| `compactAfterTokens` | `81000` | Auto-compaction threshold (when `compaction: "auto"`) |
| `observerChunkMaxTokens` | `40000` | Max observer input per run (newest-first) |
| `observerPreambleMaxTokens` | `0` (auto) | Preamble cap for observer in `compaction: "manual"` mode (auto = 30% of chunk) |
| `observationsPoolMaxTokens` | `20000` | Max active observation pool before dropper prunes |
| `observationsPoolTargetTokens` | `10000` | Target size dropper aims for after pruning (derived: half of pool max) |
| `reflectorInputMaxTokens` | `80000` | Max reflector input budget |
| `dropperInputMaxTokens` | `80000` | Max dropper input budget |
| `agentMaxTurns` | `16` | Max agent-loop turns per worker per run |
| `agentLoopReserve` | `8000` | Tokens reserved in context window for agent loop overhead (system prompt, tools, turn overhead). Used by the context window pre-check. |
| `debug` | `false` | Pre-compaction snapshot to `/tmp/pi-blackhole-debug.json` |
| `debugLog` | `false` | Continuous JSONL debug log to `~/.pi/agent/pi-blackhole/debug.ndjson` |

**Environment override:** `PI_BLACKHOLE_PASSIVE=true` sets `compaction: "off"` + `memory: false` without touching the config file. Also accepts legacy `PI_VCC_OM_PASSIVE` / `PI_OBSERVATIONAL_MEMORY_PASSIVE`.

### Configuration presets

The defaults above target a **medium-context** setup (~128k context window, e.g. GPT-4o, Claude Sonnet).
Paste the appropriate block into your config to match your main session model's context size.

#### Low context (~32k-64k — older models, fast budget models)

```json
{
  "observeAfterTokens": 5000,
  "reflectAfterTokens": 10000,
  "compactAfterTokens": 30000,
  "observerChunkMaxTokens": 15000,
  "observerPreambleMaxTokens": 0,
  "observationsPoolMaxTokens": 8000,
  "reflectorInputMaxTokens": 30000,
  "dropperInputMaxTokens": 30000
}
```

#### Medium context (~128k — GPT-4o, Claude Sonnet, Gemini Pro; this is the default)

These are the built-in defaults. If you reset your config, these are what you get:

```json
{
  "observeAfterTokens": 15000,
  "reflectAfterTokens": 25000,
  "compactAfterTokens": 81000,
  "observerChunkMaxTokens": 40000,
  "observerPreambleMaxTokens": 0,
  "observationsPoolMaxTokens": 20000,
  "reflectorInputMaxTokens": 80000,
  "dropperInputMaxTokens": 80000
}
```

#### High context (~200k+ — Claude Opus, Gemini Ultra, large local models)

```json
{
  "observeAfterTokens": 20000,
  "reflectAfterTokens": 40000,
  "compactAfterTokens": 180000,
  "observerChunkMaxTokens": 80000,
  "observerPreambleMaxTokens": 0,
  "observationsPoolMaxTokens": 40000,
  "reflectorInputMaxTokens": 160000,
  "dropperInputMaxTokens": 160000
}
```

**What to tune first:** `compactAfterTokens` should be significantly below your model's total context window — aim for ~60-70%. If the agent loses context before compaction fires, lower it. If compaction fires too often and breaks flow, raise it. The other thresholds scale proportionally.

### Tip: comments in config

The config preserves unknown keys, so you can add `_comment` or `_notes` fields to document your choices inline. They're ignored by the parser.

```json
{
  "_comment": "Tuned for my Cerebras + OpenRouter free model setup",
  "observerModel": { "provider": "openrouter", "id": "qwen/qwen3-next-80b-a3b-instruct:free", "thinking": "low" }
}
```

---

## Model fallback chains

Each worker has a primary model and an ordered fallback list. On any error — rate limit, timeout, API failure, 5xx — the failed model is cooled down and the next candidate is tried. If all candidates are exhausted, the pipeline aborts and retries on the next trigger event. The session model is always the last resort and is never cooled down.

```
[Worker fails: 429 / timeout / 5xx / connection error]
         │
         v
  Add model to cooldown list
  (persisted to pi-blackhole-cooldown.json)
         │
         v
  Try next fallback candidate
         │
         v
  [All candidates exhausted?]
         │              │
        yes             no ──> try next
         │
         v
  Fall back to session model (never cooled down)
```

Cooldowns survive Pi restarts — they're persisted to `~/.pi/agent/pi-blackhole/pi-blackhole-cooldown.json`. Each entry records the model identifier, the triggering error, which stage failed, and the expiry timestamp.

### Resolution order

For each stage, the runtime builds a candidate list from:

1. **Primary stage model** (`observerModel`, `reflectorModel`, `dropperModel`)
2. **Stage fallback models** (`observerFallbackModels`, etc.) — tried in order
3. **Base model** (`model` — shared across all workers)
4. **Session model** (the model used for your main conversation — always the last resort)

Models with active cooldowns are transparently skipped. The runtime tries up to 10 model resolutions per stage before giving up entirely.

### Example: full resolution chain

With a fully configured setup:

```
Observer:  qwen3-next-80b (openrouter) → gemma4:31b-cloud (ollama) → gemma-4-31b-it:free (openrouter) → base model → session model
Reflector: gpt-oss-120b (cerebras) → glm-4.7 (z.ai) → gpt-oss-120b:free (openrouter) → base model → session model
Dropper:   gpt-oss-120b (cerebras) → glm-4.7 (z.ai) → gpt-oss-120b:free (openrouter) → base model → session model
```

### Per-model thinking levels

Each model config supports a `thinking` field that controls reasoning effort:

```json
{
  "observerModel": {
    "provider": "openrouter",
    "id": "qwen/qwen3-next-80b-a3b-instruct:free",
    "thinking": "low",       ← reasoning effort for this specific model
    "cooldownHours": 12       ← custom cooldown duration
  }
}
```

Valid values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Not all models support every level.

### Retryable error detection

The runtime uses a regex to detect retryable errors — it looks for patterns like `rate limit`, `429`, `5xx`, `timeout`, `service unavailable`, `connection error`, `websocket closed`, etc. Non-retryable errors (auth failures, invalid model IDs) immediately skip that candidate and move to the next.

### 30-second retry gate

After any stage fails completely, the pipeline waits 30 seconds before attempting another consolidation run. This prevents rapid retry loops that would waste API calls on the same failing models.

---

## Recall

Pi's default compaction discards old messages permanently — after compaction, the agent only sees the summary. Blackhole preserves searchable history through two surfaces.

### `recall` tool (agent-facing)

The agent gets one unified tool that searches session history, expands entries, drills into file content, and looks up observational memory. Searches read the raw session file directly, bypassing compaction.

| Input | What it does |
|---|---|
| `[12-char hex]` | Recover source evidence for an observation or reflection ID from the session ledger |
| `#N` | Expand a session entry by index (show full content, not truncated) |
| `#N:path` | Drill-down into file content from a tool call (e.g. `#42:auth.ts` shows first 30 lines; `#42:auth.ts:30` shows next 30; `#42:auth.ts:full` shows everything) |
| Free text | BM25-ranked OR search across transcript + file indicators. Rare terms weighted higher. |
| `mode:file` | Search only write/edit file content |
| `mode:transcript` | Search only conversation text |
| `mode:touched` | Aggregate all files written/edited across the session, grouped by path with entry indices |
| Regex | Pattern search (e.g. `fork.*pi-vcc`, `hook\|inject`) |
| `scope:all` | Search across all session lineages (default: active lineage only) |

**OM coupling:** When expanding session entries (`#N`), the tool automatically looks up related observations and reflections from the session ledger. If any of your expanded entries are referenced as source evidence by an observation, those observations are shown alongside the expanded content.

### `/blackhole-recall` command (user-facing)

Results are shown as a collapsible message and auto-fed to the agent as context. Same engine as the `recall` tool.

```
/blackhole-recall auth token                        # active-lineage search, ranked
/blackhole-recall auth token page:2                 # paginated (5 results/page)
/blackhole-recall hook|inject                       # regex
/blackhole-recall fail.*build scope:all             # regex across all lineages
/blackhole-recall mode:file                         # search only write/edit file content
/blackhole-recall mode:transcript                   # search only conversation
/blackhole-recall mode:touched                      # aggregate view of all files touched
/blackhole-recall                                   # recent 25 entries
```

### Details

**File drill-down** reads the raw session JSONL to extract file content from tool call operations. Supports offset/limit paging so you can browse long files. Note: edit diffs are not indexed for text search — drill-down reads them from the raw session as original full-file writes.

**Touched mode** (`mode:touched`) aggregates all files written, edited, or read across the session, grouped by path. Each entry shows which tool operation touched the file and the line count. Useful for getting a lay of the land after a long session.

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

## Credits

pi-blackhole started as a merge of two upstream projects, but has since diverged significantly. The codebase still carries DNA from both:

- **[pi-vcc](https://github.com/sting8k/pi-vcc)** by @sting8k — algorithmic conversation compaction (the `compile()` pipeline, section extraction, recall core)
- **[pi-observational-memory](https://github.com/elpapi42/pi-observational-memory)** by @elpapi42 — session-ledger-based observation/reflection capture, memory agents, ledger folding

What blackhole adds and reworks on top:

- **Unified configuration** — one JSON file, not two
- **Per-worker model fallback chains** with persisted cooldowns that survive Pi restarts
- **Manual flush mode** — `compaction: "manual"` saves observations to per-session disk buffers
- **Conflict resolution** — OM hooks into vcc's compaction, not Pi's default
- **Memory toggle** (`/blackhole om-off` / `/blackhole om-on`) — disable the memory layer without uninstalling
- **Per-session pending state** — isolated per-session JSON files, no cross-session contamination
- **Custom provider bridge** — consolidation agents loaded via jiti can still use provider stream functions registered by other extensions
- **Retryable error detection with per-model cooldowns** — models that fail get cooled down, fallbacks tried automatically, 30-second retry gate prevents spam
- **Improved observer/reflector/dropper prompts** — each heavily customized with detailed extraction rules, relevance guidance, and error handling
- **OM-recall coupling** — when expanding session entries via `recall`, related observations and reflections are automatically shown
- **Thinking level support** — per-model `thinking` field for reasoning effort control

## License

MIT
