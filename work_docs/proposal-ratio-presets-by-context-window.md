# Proposal: ratio presets by context window size

- **Status:** Draft — for review, no code written.
- **Author:** contributor (local `feat/context-window-threshold` branch).
- **Date:** 2026-09-05.
- **Related:** issue #60 (shipped, `56af422` + `eedde28`); owner WIP branch `feat/token-rework` (`thresholdScale` preset idea) used as design reference only.
- **Scope:** auto-compaction threshold resolution only. No change to evaluation cadence, mid-run compaction, or the OM pipeline.

## 1. Problem

Issue #60 made the auto-compaction threshold window-aware via two **global** opt-in knobs: `compactAfterRatio` (`floor(window × ratio)`) and `compactReserveTokens` (`window − reserve`). One number applies to every session model. Real deployments span a wide range of context windows in a single install:

Session-capable models on the author's machine (live `/v1/models`, ctx from each preset's `--ctx-size`):

| class (window) | models                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 32,768         | Gemma-4-E2B-IT-QAT:Q4, Qwen3.5-4B-MTP:Q4 (`llama-cpp` :8080)                                                                |
| 65,536         | Gemma-4-31B-IT-QAT:Q4, Qwen3.6-27B-MTP:Q4 (`llama-cpp` :8080)                                                               |
| 131,072        | Qwen3.8-27B (-MTP-) IQ4/Q4/Q4_K_M/Q4_K_S (both `llama-cpp` :8080 and `beellama-cpp` :8090)                                  |
| 262,144        | Qwen3.5-9B-MTP LOW/MEDIUM/Q4, Gemma-4-12B/-26B, Muse-Glimmer-30B, Qwen3.6-28B-REAP, Qwen3.6-35B-A3B-MTP (`llama-cpp` :8080) |
| 1,000,000+     | deepseek v4 flash/pro; openrouter catalog up to ~2M                                                                         |

A single global ratio fails at both ends:

- **Tuned late (0.85)** to avoid churn on 128k+ locals, it leaves dangerously thin headroom on small sessions — at `agent_end`-only check granularity a single long turn can overflow before the next check:

  | window | fire at 0.85 | headroom left |
  | ------ | ------------ | ------------- |
  | 32,768 | 27,853       | **4,915**     |
  | 65,536 | 55,706       | 9,830         |

- **Tuned for the small end** (0.65) is "too early"-feeling on 128k–1M models that users want to fill to ~85% before paying the compaction cost, and it fires almost identically "never" on 1M regardless.

What users actually want varies **by window size**: small windows need a larger _headroom fraction_ (system/tool/OM overhead and single-turn spikes are proportionally large); large windows want very late compaction (churn/cost dominated). This is exactly the "presets that auto-adjust to the context window" direction the owner flagged in `feat/token-rework` — scoped here to the threshold only, additively, on the current architecture.

## 2. Requirements

1. **Zero behavior change unless opted in.** Today's semantics stay byte-for-byte for everyone: fixed 81,000 when no knob set; `compactAfterTokens` (explicit, non-default) > `compactAfterRatio` > `compactReserveTokens`.
2. **One small knob**, not thirty per-model entries (owner's few-knobs preference). A _class table keyed by measured window_ — not per-model config.
3. **Per-evaluation resolution** from `ctx.model` window (already true post-#60); mid-session `/model` switches re-derive.
4. Honest, safe default headroom at every class in the fleet (target ≥ ~10k headroom on the 32k class, ≥ ~25k on the 128k class).
5. Respect the vendored-editor constraint: any new key must be added to the `DEFAULTS` literal in `src/core/unified-config.ts` (as `undefined`) or `ConfigManager.save()`'s diff-over-`Object.keys(DEFAULTS)` can never persist a modal edit.
6. Explicit numeric knobs, when present, still win over the preset for the active model.

## 3. Design options

### A. Per-model `compactAfterRatio` on the existing model slots

Mirror the `contextWindow` override machinery (`contextWindowOverrides` / `sessionContextWindow` in `src/om/model-budget.ts:60,86`): each `OmModelConfig` may carry a ratio; matched by `provider + id`.

- Precise; the natural escape hatch. But unusable as the _primary_ mechanism for a ~30-preset local fleet (one entry per preset), and it duplicates what a class table gives for free.
- Verdict: **keep as a later escape hatch, not the mechanism** (see §8 open question 4).

### B. Window-class preset table (recommended)

A single opt-in key selects a _curve_: `window → ratio`. The curve is defined in code by anchors at standard sizes; the resolver looks up the active model's measured window, picks its class, and derives `floor(window × classRatio)`.

- One knob. Automatically serves the whole fleet. Boundary behavior is testable in pure unit tests.
- Semantics identical to today's ratio path (a ratio is a ratio); the preset just _chooses_ the ratio per window instead of the user choosing one globally.

### C. Continuous interpolation between anchors

Same anchors, but piecewise-linear in `window` instead of stepping. Smoother, but harder to explain/predict and to display ("81% of 131,072-token window" is noise). Verdict: **step classes**; note interpolation as a rejected alternative for predictability.

## 4. Recommended design (Option B)

### 4.1 Schema (doc-level; not code)

New optional key on `UnifiedConfig`:

```
compactAfterPreset?: "balanced"   // (reserved for future names: "late", "conservative", …)
```

- `undefined` (default) → today's exact behavior.
- `"balanced"` → derived mode engages: fixed 81,000 is dropped (like ratio/reserve today) unless `compactAfterTokens` is explicitly set.

### 4.2 Resolution order

```
compactAfterTokens  (explicit: file/env, and ≠ the 81,000 fixed default)   — wins
compactAfterRatio   (numeric)                                               — then
compactAfterReserveTokens (numeric)                                         — then
compactAfterPreset  (class table for the active window)                     — then
fixed 81,000 default (when nothing is set)
```

Rationale: numeric knobs are what a user reaches for when they have a _specific_ requirement for the current model class; they keep overriding the generic preset, so migrating to presets is a one-line change (clear the numeric ratio, set the preset) and keeping both is harmless (numeric wins).

### 4.3 Default `"balanced"` curve (proposed anchors)

Boundaries are half-steps between nominal sizes; ratios chosen to keep ≥ ~10k headroom at 32k and ≥ ~25k at 128k while staying late on big models:

| measured window `W`        | class ratio | fires at            | headroom |
| -------------------------- | ----------- | ------------------- | -------- |
| `< 48,000` (32k)           | 0.60        | 19,661 / 32,768     | 13,107   |
| `48,000 – 95,999` (64k)    | 0.70        | 45,875 / 65,536     | 19,661   |
| `96,000 – 191,999` (128k)  | 0.80        | 104,858 / 131,072   | 26,214   |
| `192,000 – 383,999` (256k) | 0.85        | 222,822 / 262,144   | 39,322   |
| `≥ 384,000` (512k+)        | 0.90        | 900,000 / 1,000,000 | 100,000  |

Fleet walk-through vs today's single 0.85:

| session window | today (0.85)               | preset (balanced)       | Δ                                    |
| -------------- | -------------------------- | ----------------------- | ------------------------------------ |
| 32,768         | fire 27.9k / **4.9k left** | fire 19.7k / 13.1k left | overflow-prone → safe                |
| 131,072        | fire 111.4k / 19.7k        | fire 104.9k / 26.2k     | effectively same, more cushion       |
| 262,144        | fire 222.8k                | fire 222.8k             | identical                            |
| 1,000,000      | fire 850k                  | fire 900k               | identical in practice (both "never") |

Unknown window (no registry value, no override → 128k fallback in `effectiveContextWindow`) lands in the 128k class → 0.80, i.e. ~104,858 — a hair above the legacy 81k default and consistent with the pre-#60 128k calibration.

## 5. Back-compat & migration

- Key defaults to `undefined`: no config, env, or modal change for anyone not opting in; all existing tests for the current precedence stay green.
- A user currently on a global numeric ratio (e.g. 0.85) who wants presets: clear `compactAfterRatio`, set `compactAfterPreset: "balanced"`. Forgetting to clear the numeric ratio is harmless — numeric still wins (documented), so nothing silently changes.
- Derived-mode deletion in `loadUnifiedConfig` (`unified-config.ts:613`) must extend its condition from
  `ratio|reserve set` to `ratio|reserve|preset set` — otherwise a preset-only config keeps the injected 81,000 and the preset never engages. This is the one behavioral trap in the whole change; covered by a dedicated test.

## 6. Config surfaces touched

| Surface                                      | Change                                                                                                                                                                                                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/unified-config.ts`                 | interface + doc comment; `DEFAULTS` literal gains `compactAfterPreset: undefined` (mandatory — see requirement 5); parse validation (enum, invalid → dropped with existing warn pattern, mirroring `compaction`/`midRunCompaction`); derived-mode delete condition extended |
| `src/core/config-env.ts`                     | `compactAfterPreset` EnvParser (`PI_BLACKHOLE_COMPACT_AFTER_PRESET`), conditional on raw presence like the other enum vars                                                                                                                                                  |
| `src/om/model-budget.ts`                     | extend `CompactThresholdConfig`; add exported `presetRatioForWindow(preset, window): number` (pure, unit-testable); `compactThresholdTokens` gains the preset branch below the numeric knobs                                                                                |
| `src/pi-base/blackhole-settings.ts`          | enum select in the Compaction section (unset = today). **Not** added to `REQUIRED_NUMERIC_KEYS` (not numeric)                                                                                                                                                               |
| `src/commands/memory.ts`                     | status suffix gains a preset basis: `· auto 80% of 131,072-token window (preset: balanced)` — keep the resolved _number_ from the same resolver so display and trigger can't disagree                                                                                       |
| `src/om/compaction-trigger.ts`               | no change — it already calls `autoCompactThreshold` per event                                                                                                                                                                                                               |
| `status-overlay.ts` / `configure-overlay.ts` | untouched (no live producer / superseded by the modal)                                                                                                                                                                                                                      |

Docs: `docs/CONFIG.md` new subsection (semantics, curve table, precedence, migration); README note; `docs/CHANGELOG.md` Unreleased `### Added` entry.

## 7. Test plan (pure unit, repo conventions)

- `model-budget.test.ts` — class selection at boundaries (47,999 vs 48,000; 95,999 vs 96,000; …); unknown window → 128k class; precedence numeric ratio > preset; preset > default; `compactAfterTokens` non-default still wins; `presetRatioForWindow` table exactness.
- `config.test.ts` — parse accepts `"balanced"`, rejects `"aggressive"/"auto"/0` → key dropped + tokens default stays; preset-only config **drops** the 81,000 (the §5 trap); explicit 180,000 tokens + preset → token mode; env `PI_BLACKHOLE_COMPACT_AFTER_PRESET` engages derived mode and an invalid env value keeps configured state.
- `compaction-trigger.test.ts` — two sessions, same branch pressure: a 32,768-window model fires at `0.60 × 32,768` while a 1M model under the same preset does not (re-derive-per-evaluation).
- `memory-command.test.ts` — status line shows the preset-derived number + basis suffix.

## 8. Open questions

1. **Curve values.** The §4.3 table is a first proposal calibrated against the author's fleet. Sanity-check against real sessions before finalizing (see 2).
2. **Boundaries/step vs interpolate.** Half-step boundaries and step classes proposed; interpolation rejected for predictability — confirm.
3. **≥384k cap at 0.90.** Fine for 1M/2M (fires ~never, huge absolute headroom). A 0.95 tier would keep it "basically never" too — confirm 0.90 is fine or drop to 0.85.
4. **Per-model numeric-ratio escape hatch (Option A) later?** Recommended _later_, only if a specific model needs a bespoke ratio the class table can't express (mechanism already understood via `contextWindow` override matching).
5. **Unknown-window fallback** (128k → class 0.80 ≈ 104,858) acceptable as the default for models pi can't size (e.g. new llama presets before pi-llama-cpp parses `--ctx-size`)? Display makes the fallback visible (`128,000-token window`), so it is discoverable.
6. **Preset names / future curves** — implement only `"balanced"` now (YAGNI) and treat the enum as extensible? Recommended yes.

## 9. Non-goals / related work (explicitly out of scope here)

- **Evaluation cadence**: presets reduce overflow risk at small windows by raising the headroom fraction, but the check still runs only at `agent_end` (and `turn_end` when `midRunCompaction` is on). If small-window overflow persists _despite_ the 0.60 class, the fix is cadence (more frequent checks or a reserve), not the ratio — separate proposal.
- **Reserve presets** (`compactReserveTokens` stays a single global number). The ratio curve covers the fleet need; a reserve variant can reuse the same class machinery if ever wanted.
- **`compaction-chain.ts`** (`MAX_CHAIN_WINDOW_RATIO = 0.5`) is an orthogonal append-mode governor — untouched.

## 10. Reference points (current code)

- `src/om/model-budget.ts`: `compactThresholdTokens` (`:33`), `SessionWindowConfig` (`:49`), `sessionContextWindow` (`:86`), `autoCompactThreshold` (`:104`), `effectiveContextWindow` (`:128`).
- `src/core/unified-config.ts`: threshold interface (`:110–140`), `DEFAULTS` (`:225–235`), derived-mode delete (`:613`).
- `src/core/config-env.ts`: `DECLARATIVE_ENV_OVERRIDES` compact entries (`:88–108`).
- `src/pi-base/blackhole-settings.ts`: Compaction section fields; `REQUIRED_NUMERIC_KEYS` sanity fill.
- `src/commands/memory.ts`: `compactThresholdSuffix` (`:44–63`), status line (`:201`).
- Vendored-editor constraint: `ConfigManager.save()` diff iterates `Object.keys(DEFAULTS)` (`src/pi-base/config-manager.ts`) — new keys must exist in the `DEFAULTS` literal to persist.
