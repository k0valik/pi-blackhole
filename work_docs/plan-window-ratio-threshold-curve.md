# Plan — Window-scaled falling-ratio compaction threshold curve

**Date:** 2026-09-06
**Status:** Draft for review (Plannotator gate).
**Master doc:** `work_docs/proposal-ratio-presets-by-context-window.md` (approved spec 2026-09-06; decisions D1–D7).
**Branch:** `feat/context-window-threshold` (base: issue #60 already shipped on this branch).
**Behavior change:** YES by design — for no-config users, on the commit that flips `DEFAULTS.compactAfterTokens` to `undefined` (Phase B). Phases before that are additive and behavior-neutral.

---

## 1. Goal

Replace the flat-81,000 no-knob threshold and the two global numeric knobs' monopoly with a **window→ratio threshold curve**: one selection knob (`compactAfterPreset`) choosing a named preset; preset definitions user-editable as data (`compactAfterPresets` in the config file); a purely falling built-in `default` preset (0.90@32k → 0.40@1M) that applies out of the box. Resolution stays per-event from `ctx.model`'s window and always returns a number ≥ 1.

## 2. Scope

**In:** `src/om/model-budget.ts`, `src/core/unified-config.ts`, `src/core/config-env.ts`, `src/pi-base/blackhole-settings.ts`, `src/commands/memory.ts`; tests `model-budget`, `config`, `config-manager-modal`, `memory-command`, `compaction-trigger`; docs README / `docs/CONFIG.md` / `docs/OLD_CONFIG.md` / `llms.txt` / changelogs / `example-config*.json` / `scripts/analyze-token-estimation.mjs`.

**Out:** evaluation cadence, mid-run compaction, OM pipeline, `compaction-chain.ts`, `status-overlay.ts` / `configure-overlay.ts` (dead code — untouched). Per-model numeric escape hatch — later, out of scope (spec §11.6).

## 3. Sequencing — five commits, each leaving the suite green

Each phase is TDD (tests first where practical) and ends with `pnpm exec vitest run <touched tests>` + `pnpm typecheck`.

### Phase A — Resolution core, additive (behavior-neutral)

New pure machinery with hand-built configs in tests. `DEFAULTS` untouched → no-knob configs still resolve 81,000, so every existing assertion stays green.

**A1. `src/om/model-budget.ts`:**

- Add types: `PresetAnchor = { window: number; ratio: number }`; extend `CompactThresholdConfig` with `compactAfterPreset?: string` and `compactAfterPresets?: Record<string, PresetAnchor[]>`.
- Export `BUILTIN_PRESETS: Record<string, PresetAnchor[]>` = `{ default: [ {32768,0.90}, {131072,0.80}, {262144,0.70}, {1048576,0.40} ] }` (spec §7).
- Export pure `presetRatioForWindow(anchors, window): number` — piecewise-linear interpolation in window space; constant extrapolation outside the first/last anchor; single-anchor ⇒ constant ratio (spec §6).
- Export `effectivePresets(cfg)` = `{ ...BUILTIN_PRESETS, ...(cfg.compactAfterPresets ?? {}) }` (spec §4.2).
- Extend `compactThresholdTokens`: after the numeric knobs, add the preset branch → `name = cfg.compactAfterPreset ?? "default"`; `anchors = effectivePresets(cfg)[name] ?? BUILTIN_PRESETS.default` (unknown-name silent fallback); return `max(1, floor(window × presetRatioForWindow(anchors, window)))`. **Guarantee: never returns `undefined`** (spec §5, R5). `DEFAULT_COMPACT_AFTER_TOKENS` stays for now.
- Do NOT delete `DEFAULT_COMPACT_AFTER_TOKENS` yet (Phase B removes it atomically with the DEFAULTS flip).

**A2. Tests — `tests/model-budget.test.ts` (new `describe` blocks, keep the 81,000 asserts):**

- `presetRatioForWindow` exactness at anchors; interpolated midpoints (65,536 → ~0.867; 200,000 → ~0.747; 524,288 → 0.60); extrapolation below first / above last; single-anchor = constant.
- `compactThresholdTokens` with preset cfg: fires `floor(window×ratio)`; precedence numeric ratio/reserve/tokens still beat the preset; explicit `compactAfterTokens` (incl. 81,000) wins; unknown preset name falls back to built-in `default` (never `undefined`); `effectivePresets` overlay (file overrides `default`, adds a name, other built-ins kept).

**A3. Verify:** `pnpm exec vitest run tests/model-budget.test.ts` and the untouched existing model-budget/config tests still pass.

### Phase B — Config surface + the behavior flip (the big commit)

**B1. `src/core/unified-config.ts`:**

- `DEFAULTS`: `compactAfterTokens` → `undefined`; add `compactAfterPreset: "default"`. `compactAfterPresets` stays **absent** from `DEFAULTS` (spec §4.2 — save-diff/clobber protection; modal save must treat it as an unknown key carried verbatim).
- Interface + doc comments for both new fields; keep `compactAfterTokens?: number`.
- `parseConfig`: add `compactAfterPresets` parsing (raw key, not DEFAULTS-bound) + `compactAfterPreset` non-empty-string parse. New anchor validator (spec §6.1): each entry `{window: int>0, ratio: finite, 0<ratio≤1}`; sort ascending by window; duplicate windows keep the last; a preset with no valid anchors is dropped with `console.warn` (existing warn pattern).
- After the file/env merge: if `compactAfterPreset` names a preset missing from `effectivePresets(...)` → warn once + treat knob as unset (built-in `default` governs). (Env-override path re-checks — see B2.)
- Delete the dead derived-mode deletion block (`:631–651`) — with no injected 81,000 there is nothing to delete; the "explicit" test collapsing to `!== undefined` is the desired behavior (explicit file `81000` is never dropped). Remove the now-unused 81000-injection comment path (`:581` context).
- **Blast-radius sweep:** `grep -rn "DEFAULT_COMPACT_AFTER_TOKENS\|81000\|compactAfterTokens" src/ tests/` and update every consumer of the removed constant (see B3) and every test that asserts the no-knob 81,000 default.

**B2. `src/core/config-env.ts`:** add `compactAfterPreset` → `PI_BLACKHOLE_COMPACT_AFTER_PRESET` (string form mirroring the enum-ish parsers at `:165–190`; only applied when the var is set). If the env value names an unknown preset, warn and ignore (mirror the invalid-env-enum warn block in `blackhole-settings.ts` `validate`).

**B3. `src/om/model-budget.ts`:** delete `DEFAULT_COMPACT_AFTER_TOKENS`; the `compactThresholdTokens` fallback is now the preset branch (no numeric knobs + no/unknown preset ⇒ built-in `default`). Same for `blackhole-settings.ts:31` local copy.

**B4. `src/pi-base/blackhole-settings.ts`:** fix the `compactAfterTokens` numeric-field value (`:118` `?? DEFAULT…` → plain `cfg.compactAfterTokens`; show unset/placeholder). **Audit `REQUIRED_NUMERIC_KEYS` (`:421–447`)**: if `compactAfterTokens` is listed, remove it — its DEFAULTS is now legitimately `undefined` and the sanity-fill must not write it back.

**B5. Test updates (behavior flip):**

- `tests/config.test.ts` — replace the no-knob `toBe(81_000)` asserts (e.g. `:38`, derived-mode + "keeps fixed default" invalid-env blocks) with: no-knob config yields `compactAfterTokens: undefined` and `compactAfterPreset: "default"`; explicit file `81000` is kept (not dropped); preset dictionary parse/validation/sort/drop cases; invalid anchor shapes dropped with warn; knob parse + unknown-name warn; env preset var engages / invalid env keeps state.
- `tests/model-budget.test.ts:129–131` — replace the "falls back to 81000" asserts with default-preset expectations at the 128k fallback window (~104,857).
- `tests/compaction-trigger.test.ts` — the "keeps the fixed-default behavior" case passes `compactAfterTokens: 81_000` explicitly; re-aim it at the new no-knob semantics (32,768-window model fires at ~29,491 under the default preset; 1M does not; re-derive after `/model` switch).
- `tests/memory-command.test.ts` — no-knob status now shows the preset basis (land display in Phase D; here keep it green by updating the number expectations only if the suffix change lands together — if not, defer to D and keep B green).

**B6. Verify:** `pnpm exec vitest run tests/model-budget.test.ts tests/config.test.ts tests/compaction-trigger.test.ts tests/memory-command.test.ts` + `pnpm typecheck`. This commit is the intended **behavior change** — note it in the root CHANGELOG here or in Phase E (do it in E so docs land atomically; either is acceptable, say which in the commit body).

### Phase C — Settings modal select + save-preservation proof

**C1. `src/pi-base/blackhole-settings.ts`:** add enum field `compactAfterPreset`, label "Compaction threshold preset", description pointing at hand-edited `compactAfterPresets` for curve editing, `options: Object.keys(effectivePresets(cfg))` computed in `fields(cfg)` (built-ins + file names — same merge as the resolver, spec §8). Not in `REQUIRED_NUMERIC_KEYS` (not numeric).

**C2. Tests — `tests/config-manager-modal.test.ts`** (import the real `config`/`DEFAULTS`, not the test-local literal):

- Selecting a different preset name via the modal persists.
- **Save preservation (the review's R1 proof):** with a hand-edited `compactAfterPresets` key in the file (override `default` + one added name), an unrelated modal save leaves the file's `compactAfterPresets` byte-identical (unknown-key branch; never normalized to built-ins+file). Also cover the mid-modal hand-edit case if the harness allows.
- No `compactAfterPresets` in `DEFAULTS` keys (regression guard).

**C3. Verify:** `pnpm exec vitest run tests/config-manager-modal.test.ts tests/config.test.ts` + `pnpm typecheck`.

### Phase D — Status display

**D1. `src/commands/memory.ts`:** extend `compactThresholdSuffix` (`:44–63`) with the preset branch → `· auto ~80% of 131,072-token window (preset: default)`; derived from the same `autoCompactThreshold` call already used by the status line (`:201`) so display and trigger cannot disagree. No-knob fixed-default `""` case disappears (no flat default remains).

**D2. `tests/memory-command.test.ts`:** status shows the preset basis + resolved number for a no-knob config and for a numeric-ratio config (unchanged suffix).

**D3. Verify:** `pnpm exec vitest run tests/memory-command.test.ts tests/compaction-trigger.test.ts`.

### Phase E — Docs & fixtures lockstep (numbers must mirror spec §7 + `DEFAULTS`)

`README.md`, `docs/CONFIG.md` (new subsection: semantics, curve table, precedence, migration; replace 81,000-default text), `docs/OLD_CONFIG.md`, `llms.txt`, root `CHANGELOG.md` (`### Added` + explicit **Behavior change** note for the no-config default), `docs/CHANGELOG.md` if present, `example-config.json` / `example-config-old.json` (drop/replace the `81_000` example), `scripts/analyze-token-estimation.mjs:121` (formula default). Cross-check every number against `DEFAULTS` (AGENTS.md docs-consistency rule). Commit `docs(compaction): ...` (md-only lint-staged may need `--no-verify` per the known oxfmt papercut).

### Phase F — Full gate

`pnpm check` (typecheck + lint), `pnpm test`, `pnpm format:check`. Manual runtime spot-check via the dev clone (`~/.pi/agent/git/github.com/k0valik/pi-blackhole/`): `/blackhole-memory status` shows the preset basis; a 32k-window session fires near ~29.5k; hand-edited preset + modal save preserves the file. Update `docs/CHANGELOG.md` `### Added` + release notes if kept separately.

## 4. Watch-items (from the adversarial review — verify while implementing)

1. **`compactThresholdTokens` must never return `undefined`** (R5) — the gate inverts and compacts every event. Covered by the Phase A unknown-name test.
2. **`compactAfterPresets` must stay out of `DEFAULTS`** (R1) — the moment it enters `Object.keys(DEFAULTS)`, save() diffs it with no field guard and clobber/normalization returns. The modal test in C2 is the regression proof.
3. **Modal field for `compactAfterTokens`** must tolerate `undefined` (B4) — after the flip, "unset" is the default posture.
4. **`REQUIRED_NUMERIC_KEYS`** repair must not re-inject 81,000 (B4) — grep it before editing.
5. **Existing 81,000 assertions** live in 5 test files + 8 docs/fixture files — the Phase B blast-radius sweep is mandatory, not cosmetic.
6. **Env var naming** — `PI_BLACKHOLE_COMPACT_AFTER_PRESET` must follow the "only applied when actually set" gate, else an unset var could inject an empty string.

## 5. Definition of done

- `pnpm check` + `pnpm test` + `pnpm format:check` green.
- No-knob config → threshold from built-in `default` preset at the active model's window; explicit `compactAfterTokens: 81000` reproduces legacy behavior; numeric knobs still win over the preset.
- Hand-edited `compactAfterPresets` survives modal saves verbatim (test-proven).
- Status line and trigger resolve the same number; modal select lists built-in + user presets.
- Docs/fixtures/changelogs updated in lockstep with `DEFAULTS`.
