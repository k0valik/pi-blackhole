# Configuration Guide

All settings live in a single JSON file: **`~/.pi/agent/pi-blackhole-config.json`**

The file is auto-created with defaults on first startup. This guide explains every setting in detail so you know exactly what to change and why.

---

## Quick reference

If you just want to get started, here's the minimum you need to know:

1. The defaults work out of the box — you don't need to change anything.
2. If you want to use specific models for the background workers, set `observerModel`, `reflectorModel`, and `dropperModel`.
3. If you don't want observations appended to your conversation at all, set `noAutoCompact: true` and run `/blackhole` manually when you want to compact.

---

## Worker models

These control which model each background worker uses. Each has a primary model and an ordered list of fallbacks tried after failures.

### `model`

**Default:** unset (session model is used as fallback)

The base model for all three workers. If a worker doesn't have its own model configured, this is used as the last resort before the session model. Set this when you want a consistent fallback across all workers.

```json
"model": { "provider": "openrouter", "id": "google/gemma-4-31b-it:free" }
```

### `observerModel`

**Default:** unset

The primary model for the observer worker — the most frequently invoked worker that reads conversation history and extracts observations. You'll want a model that's fast and good at extraction (structured thinking helps). Example:

```json
"observerModel": { "provider": "openrouter", "id": "qwen/qwen3-next-80b-a3b-instruct:free", "thinking": "low" }
```

### `observerFallbackModels`

**Default:** `[]`

Ordered list of fallback models for the observer. If the primary fails (rate limit, timeout, API error), each fallback is tried in order before giving up.

```json
"observerFallbackModels": [
  { "provider": "ollama", "id": "gemma4:31b-cloud", "thinking": "off" },
  { "provider": "openrouter", "id": "google/gemma-4-31b-it:free", "thinking": "off" }
]
```

### `reflectorModel` / `reflectorFallbackModels`

**Default:** unset / `[]`

The reflector synthesizes new observations into durable reflections. Requires stronger reasoning than the observer — you'll want a capable model here.

### `dropperModel` / `dropperFallbackModels`

**Default:** unset / `[]`

The dropper prunes old observations when the pool gets too large. Similar capability requirements as the reflector since it needs good judgment.

### Model config fields

Each model entry supports:

| Field | Required | Description |
|---|---|---|
| `provider` | yes | The API provider (`openrouter`, `ollama`, `cerebras`, `zai`, etc.) |
| `id` | yes | The model identifier as recognized by the provider |
| `thinking` | no | Thinking level: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` |
| `cooldownHours` | no | Override the default cooldown period for this specific model (default: 1h) |

### `cooldownHours`

**Default:** `1` (per model entry)

How long (in hours) to skip a model after a retryable error. This prevents hammering a failing API. Each model entry in your config can have its own cooldown, or the default of 1 hour applies.

Cooldowns are persisted to `~/.pi/agent/pi-blackhole/pi-blackhole-cooldown.json` and survive pi restarts.

---

## Token thresholds

These control _when_ each worker runs. Workers trigger when accumulated conversation tokens since the last run exceed the threshold.

### `observeAfterTokens`

**Default:** `10000`

Minimum accumulated tokens before the observer runs again. Lower values = more frequent observations but more API calls and overhead. Higher values = fewer runs, but you might miss details between runs.

The observer only processes a chunk of up to `observerChunkMaxTokens` tokens at a time (newest-first), so even if you accumulate 100k tokens, only the most recent content is sent to the model.

### `reflectAfterTokens`

**Default:** `20000`

Accumulated tokens required before the reflector (and then the dropper) run. Since the reflector depends on having new observations to work with, it makes sense to set this higher than `observeAfterTokens` so you batch up enough observations first.

### `compactAfterTokens`

**Default:** `81000`

Proactive auto-compaction threshold. When accumulated tokens hit this value, the conversation is automatically compacted (if `noAutoCompact` is `false` and `passive` is `false`). This is to prevent the conversation from growing unbounded between explicit `/blackhole` commands.

---

## Token budgets (rolling window caps)

These are hard caps that prevent worker model inputs from growing too large. Unlike thresholds that trigger _when_ a worker runs, these cap _how much_ data is sent to the model.

### `observerChunkMaxTokens`

**Default:** `40000`

The maximum chunk of conversation history sent to the observer model in a single run. The observer reads newest-first, so if there are 200k tokens since the last observation, only the most recent 40k are sent. The rest waits for the next observer run.

Increase this if you have a model with very large context and want the observer to see more history per run. Decrease it if you're hitting token limits on your observer model.

### `reflectorInputMaxTokens`

**Default:** `80000`

The total token budget for the reflector's input, which includes:
- New observations since the last reflection cycle
- Compacted versions of existing memory summaries (compressed to ~15% of this budget each)

If this is too low, existing reflections get aggressively cut and you lose nuance. If too high, you may exceed the model's context window when combined with other input.

### `dropperInputMaxTokens`

**Default:** `80000`

Same concept as `reflectorInputMaxTokens` but for the dropper. The dropper decides which observations to prune when the pool is too large. Existing summaries are compacted to ~20% of this budget.

### `observationsPoolMaxTokens`

**Default:** `20000`

When the total size of active observations exceeds this budget, the dropper is triggered (after the reflector runs) to prune old or low-value observations. This keeps the active observation pool from growing unbounded.

---

## Behavior flags

### `overrideDefaultCompaction`

**Default:** `false`

When `false`, `/blackhole`'s compaction logic only applies when you explicitly run the `/blackhole` command. Pi's built-in compaction (from `agent_end` or other triggers) uses its default behavior.

When `true`, the blackhole compaction pipeline (algorithmic summary + observational memory injection) replaces ALL compactions, including auto-compaction. This is useful if you want the enhanced summary format everywhere, not just on explicit `/blackhole`.

### `noAutoCompact`

**Default:** `false`

When `true`, observations and reflections are saved to disk (`~/.pi/agent/pi-blackhole/<sessionId>-pending.json`) instead of being appended to the conversation as markers. Auto-compaction on `agent_end` is disabled.

Run `/blackhole` manually to flush pending entries to the branch and compact. The `/memory` command shows pending counts when data is waiting.

Use this if you don't want OM markers cluttering your conversation and prefer to compact on your own schedule.

### `passive`

**Default:** `false`

When `true`, completely disables all background workers (observer, reflector, dropper) and auto-compaction. The extension is effectively inactive. Only explicit `/blackhole` compaction works.

Can also be set via environment variable: `PI_BLACKHOLE_PASSIVE=true`

### `debug`

**Default:** `false`

When `true`, writes a pre-compaction debug snapshot to `/tmp/pi-blackhole-debug.json` every time compaction runs. This captures the full state just before the algorithmic summary is built — useful for troubleshooting what the compactor sees.

### `debugLog`

**Default:** `false`

When `true`, writes a continuous debug log (JSONL format) to `~/.pi/agent/pi-blackhole/debug.ndjson`. This logs every worker run, model selection, error, and state transition — much more detailed than the `debug` snapshot. Useful for diagnosing worker failures or unexpected behavior.

### `agentMaxTurns`

**Default:** `16`

The maximum number of agent-loop turns for each background worker. Workers use an agent loop (tool calls, model responses) to perform their task. Higher values allow more complex extraction but cost more and take longer. Lower values cap cost but may result in incomplete work.

---

## Example: full config

```json
{
  "overrideDefaultCompaction": false,
  "noAutoCompact": false,
  "debug": false,

  "model": {
    "provider": "openrouter",
    "id": "google/gemma-4-31b-it:free",
    "thinking": "low",
    "cooldownHours": 6
  },

  "observerModel": {
    "provider": "openrouter",
    "id": "qwen/qwen3-next-80b-a3b-instruct:free",
    "thinking": "low",
    "cooldownHours": 12
  },
  "observerFallbackModels": [
    { "provider": "ollama", "id": "gemma4:31b-cloud", "cooldownHours": 6 },
    { "provider": "openrouter", "id": "google/gemma-4-31b-it:free", "cooldownHours": 6 }
  ],

  "reflectorModel": {
    "provider": "cerebras",
    "id": "gpt-oss-120b",
    "thinking": "low",
    "cooldownHours": 12
  },
  "reflectorFallbackModels": [
    { "provider": "zai", "id": "glm-4.7", "thinking": "low", "cooldownHours": 6 },
    { "provider": "openrouter", "id": "openai/gpt-oss-120b:free", "thinking": "low", "cooldownHours": 6 }
  ],

  "dropperModel": {
    "provider": "cerebras",
    "id": "gpt-oss-120b",
    "thinking": "off",
    "cooldownHours": 12
  },
  "dropperFallbackModels": [
    { "provider": "zai", "id": "glm-4.7", "thinking": "low", "cooldownHours": 6 },
    { "provider": "openrouter", "id": "openai/gpt-oss-120b:free", "thinking": "low", "cooldownHours": 6 }
  ],

  "observeAfterTokens": 10000,
  "reflectAfterTokens": 20000,
  "compactAfterTokens": 81000,
  "observationsPoolMaxTokens": 20000,
  "reflectorInputMaxTokens": 80000,
  "dropperInputMaxTokens": 80000,
  "observerChunkMaxTokens": 40000,
  "agentMaxTurns": 16,

  "passive": false,
  "debugLog": false
}
```

Fallback chains in effect with this config:

```
Observer:  qwen3-next-80b → gemma4:31b-cloud → google/gemma-4-31b-it:free → base model → session model
Reflector: gpt-oss-120b (cerebras) → glm-4.7 (z.ai) → openai/gpt-oss-120b:free → base model → session model
Dropper:   gpt-oss-120b (cerebras) → glm-4.7 (z.ai) → openai/gpt-oss-120b:free → base model → session model
```
