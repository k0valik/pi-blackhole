# pi-blackhole

Algorithmic compaction + session-aware observational memory for [Pi](https://github.com/badlogic/pi-mono), in one extension.

Combines [pi-vcc](https://github.com/sting8k/pi-vcc) and [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) with unified configuration, per-worker model fallback chains, persisted cooldowns, and a manual flush mode.

> This is a frankenmerge. I liked both extensions but they were not compatible - observational memory hooked into Pi's default compaction and prevented pi-vcc from working. So I merged them, made them share the same hook and output, and added the things both were missing: fallback chains, cooldowns, and a toggle between them.
> Please also see the [`CHANGELOG.md`](CHANGELOG.md)

### Lockstep with upstreams

pi-blackhole tracks both upstream repositories via a [lockstep audit system](https://github.com/k0valik/pi-blackhole/tree/lockstep/2026-05-27/.pi/skills/lockstep) that classifies every new upstream commit as safe-to-port, modified (needs review), rewritten (skip), or orphan (needs mapping). The goal is to lift bugfixes, prompts improvements, and compatible features without breaking existing users or rolling back intentional divergences. Ported changes are reviewed per-commit with human approval — nothing is blindly merged. See [SKILL.md](.pi/skills/lockstep/SKILL.md) for the full workflow. An example execution (including rationale for skipped changes) is documented in [PR #8](https://github.com/k0valik/pi-blackhole/pull/8).

#### For easy setup pass the [`llms.txt`](llms.txt) llms.txt to your agent and it will guide you through the config without needing to read all the docs if you're as lazy as me.


# Demo

- /blackhole collapses a 94k context-size conversation into a ~7.8k (for my settings) next input, shows the current stats for /blackhole-memory and /blackhole-recall (can be called by agent as well) augmenting the relevant neighbour observations and exact conversations so the agent can expand when it needs to remember previous conversation

https://github.com/user-attachments/assets/ab7c5787-1bbd-466f-a231-0818e68e9f39

---

## The problem

Long AI engineering sessions inevitably degrade. Pi's native compaction relies on an LLM to generate free-form prose summaries recursively. Pi compacts the conversation — then compacts that summary — then compacts again. After enough cycles, small but load-bearing details disappear: why a decision was made, what approaches were already rejected, what the user clarified earlier in the session.

The session is still alive. The agent is no longer carrying the real context.

The two upstream projects solve different halves of this:

- **pi-vcc** replaces Pi's LLM-based compaction with a deterministic, zero-cost algorithmic summary. Fast, reproducible, no hallucination risk. But the compacted output is still a summary — repeated compactions still erode detail.
- **pi-observational-memory** captures observations and reflections in a session ledger that survives compactions. But its compaction path still calls an LLM.

**pi-blackhole** puts vcc in the compaction slot and OM in the memory layer, where each does what it's designed for.

---

## Feature Comparison

| | pi-blackhole | pi-vcc | pi-obs-memory | Pi default |
|---|---|---|---|---|
| Algorithmic compaction (no LLM) | ✓ | ✓ | — | — |
| Deterministic output | ✓ | ✓ | — | — |
| Structured summary sections | ✓ | ✓ | — | — |
| Observations + reflections | ✓ | — | ✓ | — |
| Context survives across compactions | ✓ | — | ✓ | — |
| Background workers | ✓ | — | ✓ | — |
| Searchable history after compaction | ✓ | ✓ | partial | — |
| Per-worker model config | ✓ | — | — | — |
| Fallback model chains + persisted cooldowns | ✓ | — | — | — |
| Manual flush mode (`noAutoCompact`) | ✓ | — | — | — |
| Memory toggle (`/blackhole om-off`) | ✓ | — | — | — |
| Unified single-file config | ✓ | — | — | — |

---

## How it works

On `/blackhole`, the vcc pipeline analyzes the transcript tail and produces a structured summary: session goal, file changes, commits, outstanding blockers, user preferences, and a rolling brief transcript. Accumulated observations and reflections from the session ledger are rendered and appended below it. The agent receives a deterministic recap of recent work and durable facts from the full session history in a single replacement block.

Three background workers from `pi-observational-memory` run during the session:

- **Observer** — reads conversation since the last observation marker and extracts timestamped facts: events, decisions, preferences. Input is capped to `observerChunkMaxTokens` newest-first to prevent context blowup on long sessions.
- **Reflector** — distills new observations into durable reflections: stable facts, patterns, and constraints that survive future compactions.
- **Dropper** — prunes low-value observations from active memory when the pool exceeds `observationsPoolMaxTokens`, while keeping reflections and other long-term elements safely in the session ledger.

```
[Conversation turn] ──> observeAfterTokens threshold
                            │
                            v
                    1. OBSERVER
                       (extracts observations)
                            │
                            v
                    2. REFLECTOR
                       (distills reflections)
                            │
                            v
                    3. DROPPER
                       (prunes observations, keeps reflections)
```

The pipeline runs in order: observer -> reflector -> dropper. If any stage fails, remaining stages are skipped and the pipeline retries on the next `agent_start` or `turn_end`. A minimum 30-second interval is enforced between failed runs.

### What the agent sees after compaction

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

[a1b2c3d4e5f6] 2026-05-23 [high] User decided to switch from REST to GraphQL; motivation was reducing over-fetching.
[b2c3d4e5f6a1] 2026-05-23 [medium] GraphQL migration completed; user confirmed working.
[c3d4e5f6a1b2] Reflection: User is building Acme Dashboard on Next.js 15 with Supabase auth.
```

Sections appear only when relevant — a session with no git commits won't have `[Commits]`.

---

## Compaction modes

Two modes, one shared goal: keep your agent's context sharp without manual housekeeping.

- **Auto mode (default):** install and forget. Workers run, observations are appended as invisible conversation markers, compaction fires automatically when tokens exceed threshold.
- **Manual mode (`noAutoCompact: true` — the maintainer's setup):** same workers, same pipeline. But observations go to a disk buffer and compaction only happens when you run `/blackhole`. Cleaner conversation, manual schedule.

The tradeoff is simplicity vs cleanliness:

| | Auto (default) | Manual (`noAutoCompact: true`) |
|---|---|---|
| Workers run? | Yes | Yes |
| Observations go to | Conversation markers (invisible in TUI) | Disk (`pending.json`) |
| Observations accumulate across runs | Branch markers (replaced each cycle) | Pending batches — `/memory` shows pending counts |
| Auto-compact on `agent_end` | Yes | No |
| `/blackhole` | Optional — use it whenever you want | Required to flush + compact |
| Conversation history | OM marker entries between turns (they exist but do not clutter the display) | Clean — nothing between turns |
| Use case | "I don't want to think about it" | "I want to control when context gets compressed" |

**Does `/blackhole` work like a single `/compact` that Just Works?**

Yes, that's exactly the idea, especially in manual mode. When you feel context is getting full or accuracy is slipping, type `/blackhole`. It flushes any accumulated observations from disk, runs algorithmic vcc compaction (zero LLM cost), and injects your durable reflections into the replacement block. One command, everything gets compressed while keeping your long-term memory alive.

The difference from Pi's built-in `/compact`:
- `/compact` calls an LLM to write a free-form summary — costly, lossy, no memory layer.
- `/blackhole` uses algorithmic section extraction (goals, files, commits, preferences...) plus injects observations/reflections from the session ledger. No LLM involved in the compaction itself. Fast, deterministic, memory-preserving.

### Without observational memory

Set `memory: false` or run `/blackhole om-off` for pure pi-vcc compaction — no background workers, no memory injection. Re-enable with `/blackhole om-on` or `memory: true`.

---

## Commands

| Command | What it does |
|---|---|
| `/blackhole` | Compact. `om-off` / `om-on` toggle observational memory. |
| `/blackhole-memory` | Pipeline status: token progress, worker counts, last errors |
| `/blackhole-memory view` | Visible observations and reflections, copied to clipboard |
| `/blackhole-memory full` | Complete recorded memory, copied to clipboard |
| `/blackhole-recall <query>` | Search session history. Supports `page:N`, `scope:all` |

## Tools

| Tool | Input | Returns |
|---|---|---|
| `recall` | `[12char hex]` — source evidence for an observation/reflection; `#N` — transcript entry by index; free text — BM25+regex ranked search | Source message(s) with timestamps |

---

## Configuration

All settings in **`~/.pi/agent/pi-blackhole/pi-blackhole-config.json`** — auto-created with defaults on first startup. See [`CONFIG.md`](CONFIG.md) for the full reference and tuning guidance. An annotated example config with explanations is at [`example-config.json`](example-config.json).

Quick start with custom models:

```json
{
  "observerModel":  { "provider": "openrouter", "id": "qwen/qwen3-next-80b-a3b-instruct:free" },
  "reflectorModel": { "provider": "cerebras",   "id": "gpt-oss-120b" },
  "dropperModel":   { "provider": "cerebras",   "id": "gpt-oss-120b" }
}
```

### Settings at a glance

| Setting | Default (medium) | What it controls |
|---|---|---|
| `overrideDefaultCompaction` | `false` | Route all Pi compactions through blackhole, not just explicit `/blackhole` |
| `noAutoCompact` | `false` | Manual mode: save to disk, disable auto-compaction |
| `memory` | `true` | `false` = pi-vcc only, no workers, no OM injection |
| `passive` | `false` | Disable all workers and auto-compaction entirely |
| `model` | — | Base fallback model for all workers |
| `observerModel` / `observerFallbackModels` | — / `[]` | Primary + fallbacks for observer |
| `reflectorModel` / `reflectorFallbackModels` | — / `[]` | Primary + fallbacks for reflector |
| `dropperModel` / `dropperFallbackModels` | — / `[]` | Primary + fallbacks for dropper |
| `observeAfterTokens` | `10000` | Token cadence between observer runs |
| `reflectAfterTokens` | `20000` | Token cadence for reflector and dropper |
| `compactAfterTokens` | `81000` | Auto-compaction threshold |
| `observerChunkMaxTokens` | `40000` | Max observer input per run (newest-first) |
| `observerPreambleMaxTokens` | `0` (auto) | Max preamble tokens in observer prompt for `noAutoCompact` mode (auto = 30% of chunk) |
| `observationsPoolMaxTokens` | `20000` | Max active observation pool before dropper prunes |
| `reflectorInputMaxTokens` | `80000` | Max reflector input budget |
| `dropperInputMaxTokens` | `80000` | Max dropper input budget |
| `agentMaxTurns` | `16` | Max turns per worker agent loop |
| `debug` | `false` | Pre-compaction snapshot to `/tmp/pi-blackhole-debug.json` |
| `debugLog` | `false` | Continuous JSONL log to `~/.pi/agent/pi-blackhole/debug.ndjson` |

Env override: `PI_BLACKHOLE_PASSIVE=true` disables all workers without touching the config file.

### Configuration presets

The defaults above target a **medium-context** setup (~128k context window, e.g. GPT-4o, Claude Sonnet).
Paste the appropriate block into your config to match your model's context size.

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

Our built-in defaults already target this tier. If you reset your config, these are what you get:

```json
{
  "observeAfterTokens": 10000,
  "reflectAfterTokens": 20000,
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

**What to tune first:** `compactAfterTokens` should be significantly below your model's total context window — aim for ~60-70%. If you find the agent loses context before compaction fires, lower it. If compaction fires too often and breaks flow, raise it. The other thresholds scale proportionally with this value.

---

## Model fallback chains

Each worker has a primary model and an ordered fallback list. On any error — rate limit, timeout, API failure — the failed model is cooled down and the next candidate is tried. If all candidates are exhausted, the pipeline aborts and retries on the next trigger event. The session model is always the last resort and is never cooled down.

```
[Worker fails: 429 / timeout / 5xx]
         │
         v
  Add model to cooldown list
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

Cooldowns are persisted to `~/.pi/agent/pi-blackhole/pi-blackhole-cooldown.json` and survive Pi restarts. Each entry records the model key, the triggering error, the responsible stage, and the expiry timestamp.

With a full config, resolution order looks like:

```
Observer:  qwen3-next-80b → gemma4:31b-cloud → gemma-4-31b-it:free → base model → session model
Reflector: gpt-oss-120b (cerebras) → glm-4.7 (z.ai) → gpt-oss-120b:free → base model → session model
Dropper:   gpt-oss-120b (cerebras) → glm-4.7 (z.ai) → gpt-oss-120b:free → base model → session model
```

---

## Recall

Pi's default compaction discards old messages permanently — after compaction, the agent only sees the summary. Blackhole preserves searchable history through two surfaces.

### `recall` tool (agent-facing)

Searches the raw session JSONL directly, bypassing compaction. Default scope is the active conversation lineage.

| Input | What it does |
|---|---|
| `[12char hex]` | Recover source evidence for an observation or reflection |
| `#N` | Expand a transcript entry by index |
| Free text | BM25-ranked OR search, rare terms weighted higher |
| Regex | Pattern search (e.g. `fork.*pi-vcc`, `hook\|inject`) |

### `/blackhole-recall` command (user-facing)

Results are shown as a collapsible message and auto-fed to the agent as context.

```
/blackhole-recall auth token              # active-lineage search, ranked
/blackhole-recall auth token page:2       # paginated (5 results/page)
/blackhole-recall hook|inject             # regex
/blackhole-recall fail.*build scope:all   # regex across all lineages
/blackhole-recall                         # recent 25 entries
```

---

## Install

```bash
# From npm (recommended)
pi install npm:pi-blackhole

# Or directly from GitHub
pi install git:github.com/k0valik/pi-blackhole
```

If you have standalone pi-vcc or pi-observational-memory installed, remove them first — they will conflict:

```bash
pi uninstall https://github.com/sting8k/pi-vcc
pi uninstall https://github.com/elpapi42/pi-observational-memory
```

Then `/reload` or restart Pi.

### Standalone install (without Pi)

```bash
npm install pi-blackhole
# or
pnpm add pi-blackhole
```

## Uninstall

```bash
pi uninstall git:github.com/k0valik/pi-blackhole
rm -rf ~/.pi/agent/pi-blackhole
```

---

## Credits

The bulk of this codebase comes from two upstream projects:

- **[pi-vcc](https://github.com/sting8k/pi-vcc)** by @sting8k — algorithmic conversation compaction
- **[pi-observational-memory](https://github.com/elpapi42/pi-observational-memory)** by @elpapi42 — session-ledger-based observation and reflection capture

pi-blackhole combines, configures, and extends them into a single extension and adds unified configuration, per-worker model fallback chains, persisted cooldowns, manual flush mode, and conflict resolution between the two, and better error detection.

## License

MIT
