# blackhole

Unified compaction + observational memory for Pi.

Combines algorithmic conversation compaction (pi-vcc) with background observation/reflection capture (pi-observational-memory) into a single extension. Adds fallback model chains, persisted cooldowns, and unified configuration.

## How it works

On `/blackhole`, pi-vcc analyzes the transcript tail and produces a structured summary of recent turns (goals, decisions, code changes, files). At the same time, the observational memory system renders accumulated observations and reflections from the session ledger. These are combined into a single replacement block — the agent sees both a deterministic recap of what just happened and durable facts from the full session history. Observations and reflections survive across compactions because they live in a session ledger that is re-read and re-summarized each time.

## What it does

**During the session** — three background workers run after configurable token thresholds:

- **Observer** — reads fresh conversation since the last observation marker, extracts timestamped observations (facts, events, decisions, preferences) via an agent loop. Input is capped to `observerChunkMaxTokens` (newest-first) to avoid blowing up context.
- **Reflector** — distills new observations into durable reflections (long-lived facts, patterns, constraints) that survive across compactions.
- **Dropper** — prunes old observations from active memory when the pool exceeds `observationsPoolMaxTokens`.

The pipeline runs in order: observer → reflector → dropper. If any stage fails (API error, rate limit), the remaining stages are skipped and the pipeline retries on the next `agent_start` or `turn_end`.

**After compaction** — the `recall` tool recovers source evidence using 12-char hex ids, `#N` transcript entry indices, or free-text BM25/regex search.

## Compaction modes

Blackhole has two modes for how observations and auto-compaction behave:

### Auto mode (default, `noAutoCompact: false`)

Everything runs automatically. Background workers append observations and reflections directly to the conversation as markers. Auto-compaction triggers on `agent_end` when accumulated tokens exceed `compactAfterTokens`. `/memory` shows live progress.

Use this if you want a set-and-forget experience — the extension handles everything, but your conversation will contain OM markers between turns.

### Manual mode (`noAutoCompact: true`)

Background workers still run, but results are saved to disk (`~/.pi/agent/pi-blackhole/<sessionId>-pending.json`) instead of being appended to the conversation. Auto-compaction on `agent_end` is disabled — you decide when to compact.

Run `/blackhole` to flush pending entries to the branch and compact in one shot. `/memory` shows pending counts when data is waiting.

Use this if you prefer a clean conversation without OM markers and want to compact on your own schedule.

| | Auto mode (default) | Manual mode (`noAutoCompact: true`) |
|---|---|---|
| Workers run? | Yes | Yes |
| Where observations go | Conversation markers | Disk files |
| Auto-compaction on `agent_end` | Yes | No |
| When to run `/blackhole` | Optional (auto handles it) | Required to flush + compact |
| Conversation clutter | OM markers between turns | Clean |

## Commands

| Command | What it does |
|---|---|
| `/blackhole` | Trigger compaction: algorithmic summary + observational memory |
| `/blackhole-recall` | Show memory status: worker token progress, counts, errors |
| `/blackhole-recall view` | Show visible memory content and copy to clipboard |
| `/blackhole-recall full` | Show complete recorded memory state and copy to clipboard |

## Tools

| Tool | Input | Returns |
|---|---|---|
| `recall` | `[12char hex]` — observation/reflection source evidence; `#N` — transcript entry; free text — BM25+regex search | Source message(s) with timestamps |

## Configuration

All settings live in a single file: **`~/.pi/agent/pi-blackhole-config.json`**

Auto-created with defaults on first startup. See [CONFIG.md](CONFIG.md) for a detailed guide to every setting.

Quick start — a minimal config with custom models:

```json
{
  "observerModel": { "provider": "openrouter", "id": "qwen/qwen3-next-80b-a3b-instruct:free" },
  "reflectorModel": { "provider": "cerebras", "id": "gpt-oss-120b" },
  "dropperModel": { "provider": "cerebras", "id": "gpt-oss-120b" }
}
```

### Settings at a glance

| Setting | Default | What it controls |
|---|---|---|
| `overrideDefaultCompaction` | `false` | Makes /blackhole handle ALL compactions, not just the explicit `/blackhole` command |
| `noAutoCompact` | `false` | Opt-in manual mode: saves observations to disk instead of conversation, disables auto-compaction. Run `/blackhole` to flush + compact |
| `debug` | `false` | Writes pre-compaction debug snapshot to `/tmp/pi-blackhole-debug.json` |
| `model` | — | Base model for all workers (last fallback before session model) |
| `observerModel` | — | Primary model for the observer worker |
| `observerFallbackModels` | `[]` | Ordered fallback models for observer, tried after primary fails |
| `reflectorModel` | — | Primary model for the reflector worker |
| `reflectorFallbackModels` | `[]` | Ordered fallback models for reflector |
| `dropperModel` | — | Primary model for the dropper worker |
| `dropperFallbackModels` | `[]` | Ordered fallback models for dropper |
| `cooldownHours` (per model) | `1` | How long to skip a model after a retryable error |
| `observeAfterTokens` | `10000` | Token threshold between observer runs |
| `reflectAfterTokens` | `20000` | Token threshold between reflector/dropper runs |
| `compactAfterTokens` | `81000` | Token threshold for proactive auto-compaction |
| `observationsPoolMaxTokens` | `20000` | Max token budget for active observations before dropper prunes |
| `reflectorInputMaxTokens` | `80000` | Max token budget for reflector input (new obs + compacted summaries) |
| `dropperInputMaxTokens` | `80000` | Max token budget for dropper input (new obs + compacted summaries) |
| `observerChunkMaxTokens` | `40000` | Max tokens per observer chunk (newest-first, prevents context blowup) |
| `agentMaxTurns` | `16` | Max agent-loop turns for background workers |
| `passive` | `false` | Disables all background workers and auto-compaction entirely |
| `debugLog` | `false` | Writes debug JSONL to `~/.pi/agent/pi-blackhole/debug.ndjson` |

Env override: `PI_BLACKHOLE_PASSIVE=true` disables workers without changing the config file.

### Cooldowns

Cooldowns are persisted to `~/.pi/agent/pi-blackhole/pi-blackhole-cooldown.json` and survive pi restarts. On any error (rate limit, timeout, API failure, 5xx), the failed model is cooled down and the next fallback is tried. Each entry records the model key, the error, the responsible stage, and the expiry timestamp.

## Per-worker model fallback chains

Each worker can have its own primary model and an ordered list of fallbacks. On any error (API failure, 401, 429, 5xx, timeout), the failed model is cooled down and the next candidate is tried. If all candidates are exhausted for a stage, the pipeline aborts and retries on the next trigger event (respecting a 30s minimum interval between failed runs). The session model (the model you're chatting with) is always the last resort and is never cooled down.

## Install

```bash
pi install git:github.com/k0valik/pi-blackhole
```

If you previously had standalone pi-vcc or pi-observational-memory installed, remove them first:

```bash
pi uninstall https://github.com/sting8k/pi-vcc
pi uninstall /path/to/pi-observational-memory
```

Then `/reload` or restart pi.

## Uninstall

```bash
pi uninstall git:github.com/k0valik/pi-blackhole
```

Also remove the config and data files if you want a clean slate:

```bash
rm -rf ~/.pi/agent/pi-blackhole ~/.pi/agent/pi-blackhole-config.json
```

## Credits

This project merges two upstream projects — the vast majority of the code comes from them:

- **[pi-vcc](https://github.com/sting8k/pi-vcc)** by @sting8k — algorithmic conversation compaction (paper: "View-oriented Conversation Compiler for Agent Trace Analysis")
- **[pi-observational-memory](https://github.com/elpapi42/pi-observational-memory)** by @elpapi42 — session-ledger-based observation/reflection capture with the three-stage pipeline

Blackhole combines, configures, and extends them into a single extension with unified configuration, fallback model chains, persisted cooldowns, and error detection.

## License

MIT
