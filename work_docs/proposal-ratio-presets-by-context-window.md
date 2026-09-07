# Spec: window-scaled compaction threshold curve (falling ratio, preset data)

- **Status:** Approved design — review complete 2026-09-06. No code written.
- **Author:** contributor (local `feat/context-window-threshold` branch).
- **Date:** 2026-09-06.
- **Supersedes:** the v1 draft of this file (2026-09-05), which proposed a _rising_ ratio curve (0.60@32k → 0.90@1M) behind a single hard-coded preset picker. The design review inverted the direction and replaced the mechanism. See §1 for the rationale.
- **Related:** issue #60 (shipped, `56af422` + `eedde28`); owner WIP branch `feat/token-rework` used as design reference only. Adversarial design review performed by a debugger subagent against the current code; findings folded into §4–§11.
- **Scope:** auto-compaction threshold resolution only. No change to evaluation cadence, mid-run compaction, the OM pipeline, or `compaction-chain.ts`.

## 1. Problem and chosen direction

Issue #60 made the auto-compaction threshold window-aware via two **global** opt-in knobs: `compactAfterRatio` (`floor(window × ratio)`) and `compactReserveTokens` (`window − reserve`). One number applies to every session model, but real deployments span a wide context-window range in a single install:

| class (window) | models                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| 32,768         | Gemma-4-E2B-IT-QAT:Q4, Qwen3.5-4B-MTP:Q4 (`llama-cpp` :8080)                                                  |
| 65,536         | Gemma-4-31B-IT-QAT:Q4, Qwen3.6-27B-MTP:Q4 (`llama-cpp` :8080)                                                 |
| 131,072        | Qwen3.8-27B (-MTP-) IQ4/Q4/Q4_K_M/Q4_K_S (`llama-cpp` :8080 + `beellama-cpp` :8090)                           |
| 262,144        | Qwen3.5-9B-MTP, Gemma-4-12B/-26B, Muse-Glimmer-30B, Qwen3.6-28B-REAP, Qwen3.6-35B-A3B-MTP (`llama-cpp` :8080) |
| 1,000,000+     | deepseek v4 flash/pro; openrouter catalog up to ~2M                                                           |

Additionally, the pre-#60 _fixed_ default (`compactAfterTokens = 81,000`, still the no-knob behavior today) is mis-scaled at **both** ends: on sub-81k windows it is unreachable, so 32k/64k local models **never** auto-compact mid-session (`compaction-trigger.ts` agent_end and turn_end gates are strictly `tokens < threshold → return`; verified); on 1M+ cloud models it fires at ~8% full.

**Chosen direction (decision D1, inverts v1):** the threshold ratio should **fall as the window grows**. Small windows fill to ~90% because they are cheap to send and the user wants maximum usable history before paying compaction cost; big windows compact _early_ (a smaller fill ratio) because:

- every turn ships the whole (uncompacted) live context — on a paid 1M model, waiting to 90% full means paying ~900k tokens/turn for the entire session, indefinitely;
- a reflection/compaction of ~900k tokens is low-signal and produces bloated summaries;
- large live contexts degrade effective model performance (lost-in-the-middle), so keeping the working set smaller keeps it sharper.

The v1 draft optimized the mirror image (fill big windows to ~90%, fire small windows early for overflow safety). v1's small-end argument is accepted but _reprioritized_ (D4): the owner's fleet uses sub-64k models rarely for long agentic sessions, and because presets are now user-editable data (§4), a user who hits overflow on a 32k session can lower that anchor themselves. Mid-run compaction (`midRunCompaction`) and finer evaluation cadence remain the structural fix for single-turn overflow, explicitly out of scope (§12).

## 2. Decisions (approved answers to the design questions)

- **D1 — Direction.** Ratio falls with window; purely falling, no small-end floor. Default anchors 0.90@32k … 0.40@1M (§7).
- **D2 — Mechanism.** One selection knob (`compactAfterPreset`, a string naming the active preset) **plus** user-editable preset _definitions_ (`compactAfterPresets`, a top-level config key) holding named window→ratio anchor lists. The modal shows only the one-knob select; definitions are hand-edited JSON.
- **D3 — Default applies out of the box.** No config ⇒ the built-in `default` preset governs. The flat-81,000 no-knob fallback is removed; `DEFAULTS.compactAfterTokens` becomes `undefined`. Flat-81k behavior is reproducible with an explicit fixed `compactAfterTokens` at any value other than the reserved legacy marker `81000` (which the loader auto-migrates — §4.3, §10).
- **D4 — Small end.** 0.90@32k accepted with the ~3.3k-headroom tradeoff (review finding R2; §11).
- **D5 — Storage model.** `compactAfterPreset` is a `DEFAULTS`/modal key (edits must persist through the vendored save diff). `compactAfterPresets` is **not** a `DEFAULTS` key and has no modal field — built-in definitions live in a code-side constant merged at resolution. Required by review finding R1 (§4.2).
- **D6 — Curve semantics.** Piecewise-linear interpolation in window space between anchors; constant extrapolation beyond the first/last anchor. A single-anchor preset degenerates to a global ratio (a feature, not an error).
- **D7 — No "off curve" select.** Opting out of the curve entirely is done by setting `compactAfterTokens` explicitly (or a numeric knob); no extra modal affordance.

## 3. Requirements

1. **Zero behavior change for anyone who has configured a numeric knob.** Explicit `compactAfterTokens` / `compactAfterRatio` / `compactReserveTokens` keep winning over the preset for the active model.
2. **A sane default applies with no config** (D3): a no-config install now resolves the threshold from the built-in `default` preset and the session model's measured window — not a flat 81,000.
3. **One modal knob** (D2), whose options = built-in preset names + any names the user added in the file (computed by the same merge the resolver uses, so options and resolution cannot disagree).
4. **Preset definitions are user data**: overridable per name, extensible with new names, carried verbatim by config saves, never normalized or clobbered (R1).
5. **Resolution always returns a number ≥ 1** — including when the selected preset name is unknown/missing (fall back to the built-in `default` preset with a one-time warning). Returning `undefined` would invert the gate and compact on every event (R5).
6. **Per-evaluation resolution** from `ctx.model`'s window (already true post-#60): mid-session `/model` switches re-derive on the next check.
7. Anchor validation at parse time (shape/range/sort); invalid data dropped with the existing warn pattern, never a crash.
8. Docs-consistency duty (AGENTS.md): every number and the old-default narrative updated in lockstep across README, `docs/CONFIG.md`, `docs/OLD_CONFIG.md`, `llms.txt`, both changelogs, and the example-config fixtures (§10).

## 4. Schema and storage

### 4.1 Config keys (doc-level)

```jsonc
// ~/.pi/agent/pi-blackhole/pi-blackhole-config.json
{
  "compactAfterPreset": "default", // selection knob — modal field
  "compactAfterPresets": {
    // hand-edited only; no modal field
    "default": [
      // overrides the built-in curve of this name
      { "window": 32768, "ratio": 0.9 },
      { "window": 131072, "ratio": 0.8 },
      { "window": 262144, "ratio": 0.7 },
      { "window": 1048576, "ratio": 0.4 },
    ],
    "early-1m": [
      // user-added name (must be selected via the knob)
      { "window": 131072, "ratio": 0.6 }, // single anchor = constant ratio
    ],
  },
}
```

Anchors are ordered ascending by `window`; each anchor is `{ window: positive int, ratio: 0 < ratio ≤ 1 }`.

### 4.2 Storage model and why (R1 — the review's crux finding)

The vendored `ConfigManager.save()` (`src/pi-base/config-manager.ts:769–903`) computes a diff over `Object.keys(DEFAULTS)` and, for each differing DEFAULTS key with **no** registered field, writes it unconditionally (the `if (field && …)` validation guard at `:869` is skipped). Two failure modes follow if `compactAfterPresets` were a DEFAULTS key:

- **(i)** a hand-edit made _while the modal is open_ is reverted by saving any unrelated field (the modal's stale snapshot vs the file re-read at save time);
- **(ii)** the modal's deep-merged value (built-ins + file) is key-count-larger than a file that overrides one name, so `deepEqual` fails and save writes the fully-expanded object — normalization.

**Fix (D5):** keep `compactAfterPresets` out of `DEFAULTS`. The "Preserve unknown keys from the existing file" branch (`:878–884`) then copies the file's _current_ value verbatim into every save — hand-edited definitions can never be diffed, normalized, or clobbered, even by a mid-modal file edit. Built-in definitions ship as a code constant, merged at resolution:

```ts
// effective presets = built-ins overlaid by the user's file definitions
effectivePresets = { ...BUILTIN_PRESETS, ...(cfg.compactAfterPresets ?? {}) };
```

A file overriding only one name therefore overlays that name and keeps every other built-in.

Known, accepted cost: because the unknown-key branch sets `hasDiff = true` whenever the key exists in the file, a modal save with a tuned `compactAfterPresets` present rewrites the file even when nothing else changed — content-identical, harmless.

`compactAfterPreset` **is** a `DEFAULTS` key (default `"default"`), so a modal edit to the select persists. Benign side effect (verified): an unrelated save materializes `compactAfterPreset: "default"` into a file that lacks it — same as today's behavior of writing `compactAfterTokens: 81000`.

### 4.3 `DEFAULTS` changes

| Key                                          | Current     | New                                                                                                                                    |
| -------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `compactAfterTokens`                         | `81_000`    | `undefined` (legacy `81000` is a reserved, auto-migrated scaffold marker — a fixed threshold needs any other explicit value, spec §10) |
| `compactAfterPreset`                         | —           | `"default"`                                                                                                                            |
| `compactAfterPresets`                        | —           | _absent_ (code-side `BUILTIN_PRESETS` instead; see §4.2)                                                                               |
| `compactAfterRatio` / `compactReserveTokens` | `undefined` | unchanged                                                                                                                              |

`DEFAULT_COMPACT_AFTER_TOKENS` (`model-budget.ts:6–9`, duplicated at `blackhole-settings.ts:31`) dies. Its consumers switch to preset resolution: `compactThresholdTokens` fallback (`model-budget.ts:41`), the `compactAfterTokens` modal field default (`blackhole-settings.ts:118` — field now shows unset/placeholder), and the status suffix (`memory.ts:201` area). `status-overlay.ts` / `configure-overlay.ts` references are dead code (unimported) — untouched.

**Legacy-scaffold residue (implemented, amends the review's "dead code" read):** old config files carry a literal `compactAfterTokens: 81000` — `scaffoldConfig()` and modal saves materialized the full defaults into every file. A **legacy-residue drop** replaces the old derived-mode block: when the merged value is exactly `81000` and not env-supplied (env stays explicit), it is deleted so the default preset curve or a configured derived knob governs. Without it, the scaffolded value would silently beat every window-derived surface — including the preset — regressing issue #60 for ratio/reserve users whose files carry it. The review's assumption that "no injected default ⇒ no deletion needed" missed that the residue lives in _files_, not the merge.

## 5. Precedence and resolution

```text
compactAfterTokens    any explicit value in file/env                    → absolute tokens (wins)
compactAfterRatio     numeric                                           → floor(window × ratio)
compactReserveTokens  numeric                                           → window − reserve
compactAfterPreset    named curve, active window                        → floor(window × ratio₍window₎)
built-in "default"    when the knob names an unknown/empty preset       → warn once, fall back (R5)
```

- `compactThresholdTokens(cfg, contextWindow)` (extended) and `autoCompactThreshold(cfg, model)` are unchanged in signature; `autoCompactThreshold` is still called per event by `compaction-trigger.ts` (`:176`, `:326`) and by the `/blackhole-memory` status line (`memory.ts:201`) — the status number and the trigger number therefore cannot disagree.
- Unknown selected preset name (file or env): warn once, resolve via the built-in `default` preset. The function **always returns `Math.max(1, floor(window × ratio))`-shaped integers** — never `undefined` (R5).
- Unknown window (no override, no registry value → `effectiveContextWindow`'s 128,000 fallback) resolves through the curve at 128k (~0.80 → 104,857). Display shows the `128,000-token window` basis so the fallback is discoverable.

## 6. Curve semantics

- A preset is an ordered anchor list. Ratio at a window is **piecewise-linear interpolation in window space** between the surrounding anchors; windows below the first or above the last anchor use the nearest anchor's ratio (constant extrapolation).
- Rationale (D6): with user-authored data, 3–5 anchors define an entire fleet curve with no class-boundary arithmetic; a monotone curve stays monotone; a single-anchor preset _is_ today's global ratio, so nothing is lost.
- Effective threshold = `Math.max(1, Math.floor(window × ratio(window)))`.
- Interpolation vs step-classes was re-reviewed; interpolation retained for authoring ergonomics. Step classes would need explicit boundary decisions and add nothing for a curve users will author directly. (Rejected alternative, per v1 §3C.)

### 6.1 Anchor validation (parse time)

For each preset in `compactAfterPresets`: anchors must be an array; each element `{ window: int > 0, ratio: finite, 0 < ratio ≤ 1 }`; list sorted ascending by `window` (silently sort; duplicate windows keep the last). A preset with only invalid elements (or an empty/non-array body) is dropped with `console.warn` (mirrors existing parse warn patterns). Dropping a preset that the knob names results in the §5 fallback. There is no per-anchor validator today (`parseConfig` only enum/positive-int checks) — one is added.

## 7. Built-in `default` preset

| window    | ratio | fires at (floor) | headroom |
| --------- | ----- | ---------------- | -------- |
| 32,768    | 0.90  | 29,491           | 3,277    |
| 131,072   | 0.80  | 104,857          | 26,215   |
| 262,144   | 0.70  | 183,500          | 78,644   |
| 1,048,576 | 0.40  | 419,430          | 629,146  |

Interpolated midpoints (for the actual fleet): 65,536 → ~0.867 (fires ~56,798); 200,000 → ~0.747; 524,288 → 0.60 (fires ~314,573). At 1,000,000 the ratio interpolates to ~0.419 (fires ~418,530); only at/above the 1,048,576 anchor does it hit exactly 0.40. Matches the approved D1 example anchors (0.90@32k, 0.80@128k, ~0.40@1M — the 1M shorthand is the interpolated ~0.42).

These numbers are **suggested defaults only** — the whole point of D2 is that users re-tune them by editing the `default` preset in the file.

## 8. Config surfaces touched

| Surface                             | Change                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/core/unified-config.ts`        | interface + doc comments; `DEFAULTS` per §4.3; parse + validation for the knob (non-empty string) and the preset dictionary (anchors per §6.1); delete the dead derived-mode block (`:642–651`)                                                                                                                          |
| `src/core/config-env.ts`            | `PI_BLACKHOLE_COMPACT_AFTER_PRESET` (string; mirror the enum-ish parsers at `:165–190`); "only applied when the var is set" is already guaranteed by the `parsed !== undefined` write gate; no central enum list to extend, but mirror the manual invalid-env-env warn block in `blackhole-settings.ts` `validate`       |
| `src/om/model-budget.ts`            | extend `CompactThresholdConfig`; add exported `BUILTIN_PRESETS` + `presetRatioForWindow(anchors, window)` (pure, interpolating) + effective-preset merge + unknown-name fallback; delete `DEFAULT_COMPACT_AFTER_TOKENS`; `compactThresholdTokens` gains the preset branch below the numeric knobs and always returns ≥ 1 |
| `src/pi-base/blackhole-settings.ts` | enum select "Compaction threshold preset", options = `Object.keys(effective presets)` computed in `fields(cfg)`; fix the `compactAfterTokens` field default (`:118`, no longer `?? 81000`); remove the local `DEFAULT_COMPACT_AFTER_TOKENS` (`:31`); not added to `REQUIRED_NUMERIC_KEYS`                                |
| `src/commands/memory.ts`            | status suffix: `· auto ~80% of 131,072-token window (preset: default)` — resolved from the same `autoCompactThreshold` call as the trigger                                                                                                                                                                               |
| `src/om/compaction-trigger.ts`      | no change (already resolves per event)                                                                                                                                                                                                                                                                                   |
| Docs & fixtures                     | §10                                                                                                                                                                                                                                                                                                                      |

## 9. Test plan (pure unit, repo conventions)

- `model-budget.test.ts` — interpolation exactness at anchors and midpoints; extrapolation below-first/above-last anchor; single-anchor = constant ratio; merged effective presets (built-in + file override + added name); unknown preset name → built-in `default`, never `undefined`; precedence numeric knobs > preset; explicit `compactAfterTokens` (incl. `81000`) wins; unknown window → 128k class value.
- `config.test.ts` — knob parses as non-empty string; preset dictionary accepted; invalid anchor shapes/ratios dropped with warn; unsorted anchors sorted; empty/invalid preset dropped; single-anchor kept; **no 81000 injection for a no-knob config**; scaffolded `81000` in a file is dropped as residue (preset/derived govern) while env `81000` stays explicit; env `PI_BLACKHOLE_COMPACT_AFTER_PRESET` engages the preset and an invalid env value keeps configured state. Update existing assertions that expect `toBe(81_000)` / "keeps fixed default" (list from review: `config.test.ts:38`, the derived-mode + invalid-env blocks).
- `config-manager-modal.test.ts` — **save preserves a hand-edited `compactAfterPresets` key verbatim** (unknown-key branch); an unrelated modal save neither clobbers (incl. a mid-modal file edit) nor normalizes it; the knob persists when changed via the modal. (Review enumerated the test-local `DEFAULTS` literal at `:29` — the new tests must import the real `config`/`DEFAULTS`.)
- `memory-command.test.ts` — status suffix shows the preset basis and the number matches `autoCompactThreshold`.
- `compaction-trigger.test.ts` — a 32,768-window model fires at ~29,491 under the default preset while a 1M model does not; re-derives after a `/model` switch. Update the "keeps the fixed-default behavior" case (passes `compactAfterTokens: 81_000` explicitly — semantics unchanged, intent renamed).
- `model-budget.test.ts:129–131` — the "falls back to 81000" asserts are removed/replaced.

## 10. Back-compat, migration, docs lockstep

- Numeric knobs still win over the preset; nothing silently changes for users who already set `compactAfterRatio` / `compactReserveTokens` / explicit tokens.
- **No-config users change behavior on upgrade (intended, D3):** 32k/64k models that never auto-compacted mid-session now fire at ~0.9 of window; 128k-window models go from 81,000 → ~104,857. Root `CHANGELOG.md` `## [Unreleased]` needs an explicit "Behavior change" note, not just an Added entry.
- **Reserved legacy marker:** exactly `compactAfterTokens: 81000` reads as the old default posture — `scaffoldConfig()` and pre-curve modal saves wrote full defaults into every file, and 81000 always meant "the default", never a true pin (the old loader dropped it whenever a derived knob was set for exactly this reason). The loader therefore drops a file value of `81000` so the preset curve or a configured derived knob governs; env-set values stay explicit. Any **other** explicit fixed value (e.g. `80000`) reproduces flat-threshold behavior. Users pinned to literal 81k must pick a neighbouring value.
- Docs/fixtures that must change in lockstep (review-verified grep): `README.md`, `docs/CONFIG.md` (new subsection: semantics, curve table, precedence, migration; drop/replace the 81,000 default text), `docs/OLD_CONFIG.md`, `llms.txt`, root `CHANGELOG.md`, `example-config.json`, `example-config-old.json`, `scripts/analyze-token-estimation.mjs`. Every number must mirror the §7 table and `DEFAULTS`.

## 11. Accepted risks and open items

1. **Small-window headroom (R2).** 0.90@32k leaves ~3,277 tokens of headroom at agent_end-only granularity; a single long turn can overflow before the next check. Accepted by decision D4; mitigations are user anchor tuning and enabling `midRunCompaction` (cadence is out of scope, §12).
2. **Unknown-window fallback** now resolves to ~104,857 (was 81,000). Intentional; made discoverable by the status-line window display.
3. **Upgrade behavior change** for no-config users (D3). Intentional; changelog-noted.
4. **Interpolation chosen over step classes** (D6). If authoring ergonomics later argue for steps, the anchors are data and the interpolation function is the only code that changes.
5. **Modal save rewrites the file** whenever a tuned `compactAfterPresets` exists and any modal field changes — content-identical, harmless (accepted cost of D5).
6. **Per-model numeric-ratio escape hatch** — not now (v1 §8Q4 stance retained); a user who needs one bespoke ratio can add a single-anchor preset, which the class table otherwise cannot express. Mechanism understood via `contextWindow` override matching if ever needed.

## 12. Non-goals / out of scope

- **Evaluation cadence**: finer-than-agent_end checks and mid-turn reserve logic remain a separate concern. The curve reduces overflow risk only by _choice of headroom_, not by check frequency. If small-window overflow persists despite tuning, the fix is cadence, not the curve — separate proposal.
- **Reserve presets** (`compactReserveTokens` stays a single global number). A reserve variant can reuse the same anchor machinery if ever wanted.
- **`compaction-chain.ts`** (`MAX_CHAIN_WINDOW_RATIO = 0.5`) — orthogonal append-mode governor; untouched.
- The OM pipeline, mid-run compaction, and `compactionSummaryMode` are untouched.

## 13. Reference points (current code)

- `src/om/model-budget.ts`: `CompactThresholdConfig` (`:13`), `compactThresholdTokens` (`:33`), `DEFAULT_COMPACT_AFTER_TOKENS` (`:6–9`), `SessionWindowConfig` (`:49`), `sessionContextWindow` (`:86`), `autoCompactThreshold` (`:104`), `effectiveContextWindow` (`:128`).
- `src/core/unified-config.ts`: threshold interface (`:110–140`), `DEFAULTS` (`:217–235`), parse validators (`:275–441`), 81000 injection (`:581`), derived-mode deletion (`:631–651`).
- `src/core/config-env.ts`: `DECLARATIVE_ENV_OVERRIDES` compact entries (`:88–108`), enum-ish parsers (`:165–190`).
- `src/pi-base/config-manager.ts`: `save()` diff + unknown-key preserve (`:769–903`, esp. `:860–884`).
- `src/pi-base/blackhole-settings.ts`: ConfigManager wiring (`:37–44`), `DEFAULT_COMPACT_AFTER_TOKENS` (`:31`), compactAfterTokens field default (`:118`), `REQUIRED_NUMERIC_KEYS` repair (`:421–447`), enum validate warn block.
- `src/om/compaction-trigger.ts`: per-event `autoCompactThreshold` (`:176`, `:326`), agent_end gate (`:446`), turn_end mid-run gate (`:146–153`).
- `src/commands/memory.ts`: `compactThresholdSuffix` (`:44–63`), status threshold (`:201`).
- Dead code (no change): `status-overlay.ts` (`:34,:91`), `configure-overlay.ts` (`:86`).
- Tests encoding current behavior: `model-budget.test.ts` (`:129–131`), `config.test.ts` (`:38`, derived-mode + invalid-env blocks), `config-manager-modal.test.ts` (`:29`), `memory-command.test.ts`, `compaction-trigger.test.ts`.
