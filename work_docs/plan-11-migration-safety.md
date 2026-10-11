# Plan 11 — Migration safety, value validation, and dropper cadence

Follow-up to plan-09 / plan-10 after the self-review of the config-surface
branch. Plan-10 shipped; this fixes the safety holes found there and answers the
"what breaks for users" list.

**Goal:** the on-disk migration can never make a config worse than leaving it
alone. Every write is backed up and verified first; every legacy value is
validated with the _same_ predicate the loader uses before it is projected; an
unrecognized value is skipped and surfaced, not silently swallowed; and the
dropper's single surviving fraction reproduces the old two-fraction cadence as
closely as one number can.

---

## 1. Backup must succeed before any write (hard requirement)

Today `defaultBackup()` is best-effort: it swallows `copyFile` errors and the
runner proceeds to write anyway. Change it to a verified gate:

1. If `path.bak` does **not** exist: `copyFile(path, bak)`.
2. Re-read `bak` and assert it byte-equals the original file (or at least parses
   and deep-equals the parsed raw object).
3. If the file already had a `.bak`: re-read and verify it still matches the
   original; if it does not (stale/partial backup), re-create it.
4. Any failure (copy error, read error, mismatch, read-only dir) → **bail
   before the first write**. Return `{ changed:false, persisted:false,
error }`, warn + notify, and leave the file byte-identical.

The runner only ever calls `backup()` on the phase-1 path (first write). The
remove-only path (new keys already present) does not need a new backup because
it deletes only own keys and is idempotent — but it must still be gated by the
version stamp (§3) and must not run if a backup is impossible when the file
still has consumed keys to delete. Decision: run the backup check on **both**
paths, so "we can always restore" holds for every write.

---

## 2. Value-shape validation, 0-as-unset, per-key skip + notify

### 2.1 Reuse the loader predicates (no drift)

Extract the shared validity predicates out of `src/core/unified-config.ts` into
a new dependency-free module `src/core/config-validators.ts`:

- `isFixedTokenThreshold(v)` — positive integer (> 0)
- `isWindowPercent(v)` — (0, 100]
- `isReserveTokens(v)` — positive integer
- `isCompactAfterBy(v)`
- `isUnitFraction(v)` — (0, 1]
- `isCompactionValue(v)`
- `isUnsetZero(v)` — `v === 0`, the legacy "not set" sentinel

`unified-config.ts` and `config-migration/steps.ts` both import from it. The
migration can then never be stricter or looser than the loader for the same key.
(Extraction avoids the cycle: `steps.ts` currently imports nothing by design;
this keeps that property.)

### 2.2 0 means "unset", never "invalid" (regression 1)

For every consumed numeric key, `0` is the documented "not set" sentinel and
must be treated as absent, not as a validation error. This is the root cause of
the compaction-thrash bug: `{ compactAfterTokens: 0, compactAfterRatio: 0.65 }`
aborted the whole file, leaving `0.65` to be re-read as _0.65 %_.

| consumed key                                | 0 today    | must be                      |
| ------------------------------------------- | ---------- | ---------------------------- |
| `compactAfterTokens`                        | abort file | unset → drop key, no warning |
| `compactAfterRatio`                         | abort file | unset → drop key, no warning |
| `compactReserveTokens`                      | abort file | unset → drop key, no warning |
| `dropperPoolFullnessThreshold`              | abort file | unset → drop key, no warning |
| `dropperInputMaxTokens`                     | abort file | unset → drop key, no warning |
| `compactionEngine` / `compaction` (strings) | abort file | n/a (strings)                |

Additional belt-and-braces: even if a fraction `compactAfterRatio` (≤ 1) is left
un-migrated for any reason, the resolver must not silently treat it as a percent.
Add an explicit guard in `normalizeThresholdKnobs` / `shapeThreshold`: a
`compactAfterBy: "percent"` value below some sane floor (e.g. `< 0.5`) with a
fraction-looking value is promoted ×100 with a warning, so the worst case is
"compaction still behaves", never "compact every turn". (Prefer fixing the
migration; this is the seatbelt.)

### 2.3 Per-key skip instead of whole-file abort (regression 2)

Today one unrecognized consumed value aborts the **entire** file, so unrelated
folded keys (`dropperPoolFullnessThreshold`, `dropperInputMaxTokens`,
`observerPreambleMaxTokens`) are never migrated and silently revert to defaults,
and the file is never stamped so it warns forever.

New contract per step:

- Validate each consumed value with the shared predicate.
- Valid (or `0` sentinel) → project it as today.
- Unrecognized → **skip that step only**: do not produce, do not delete, do not
  abort the file. Record `{ stepId, key, value, reason }`.
- The other steps still migrate.
- Any skip → do **not** write the version stamp (§3), so the next load retries
  and re-warns until the user fixes the value.

`projectConfig()` returns `{ config, valueChanged, consumedToDelete, applied,
messages, skipped: Skipped[] }`; the `error` abort field is removed.

### 2.4 Surface it with `ctx.ui.notify` (hasUI)

`migrateConfigFiles(cwd, deps)` gains a `notify(message, level)` dep alongside
`warn`. `index.ts` passes one that does `if (ctx.hasUI) ctx.ui?.notify(...)`.
Emitted:

- one warning per skipped value: `blackhole: config key "dropperInputMaxTokens"
has an unrecognized value; left it untouched — migrate it by hand or fix it in
/blackhole settings`.
- one warning when the backup/verify failed and migration was abandoned.
- read-only installs get the existing "could not write" warning, now also via
  `notify`.

`warn` (console) stays for headless runs.

---

## 3. Version stamp is the gate; notice fires either way (regression 8)

### 3.1 Gate

`configVersion` (already introduced, `CONFIG_VERSION = 1`) becomes the _only_
gate:

```
migrateConfigFile(path):
  read + parse (invalid JSON → warn, skip, never rewrite)
  if raw.configVersion is present  → return { gated: true }   # already handled
  proj = projectConfig(raw)                                   # §2, per-key skips
  if no consumed key present       → return base              # nothing to do
  backup + verify (§1)             → bail on failure
  phase 1 (add new keys) → verify on disk → phase 2 (remove consumed)
  stamp configVersion ONLY when proj.skipped.length === 0
```

- Presence of `configVersion` ⇒ never attempt a rewrite again.
- A partial (skipped) migration is **not** stamped, so it retries; once the user
  fixes the value it completes and stamps.
- Fresh/scaffolded files (no consumed keys) are never rewritten and never
  stamped — the next load also finds nothing to do.

### 3.2 Notice

`maybeNotifyConfigMigration(ctx, outcome, deps)` fires **whenever the running
version equals `MIGRATION_NOTICE_VERSION`**, regardless of whether a migration
ran (today it is wired only when `results.some(changed)`). It emits two
notifications once per process:

1. the upgrade notice (what changed, review settings, upgrade guide, changelog);
2. a separate outcome note:
   - `migrated` — "blackhole: your config was migrated to the new surface."
   - `none` — "blackhole: your config needed no migration."
   - `blocked` — "blackhole: your config could not be written (read-only?); it
     is running migrated in memory this session."

`outcome` is derived in `index.ts` from the `migrateConfigFiles` results
(`persisted` / no change / `changed && !persisted`). The gate remains the
package version; the constant stays a release-time knob (owner decides).

---

## 4. Dropper cadence: one fraction, smoothed (regression 3)

### 4.1 The data

The old two fractions had distinct roles:

- `F` = fullness floor — "do not prune a pool smaller than this".
- `P` = pressure — "prune even with no new data once this full".

Effective old trigger for the no-new-data path was `max(F, P)`; the new-data
path was gated by `F`. Real configs (owner + others):

| P (pressure) | F (fullness) | max(F,P) pressure-path | F new-data floor |
| ------------ | ------------ | ---------------------- | ---------------- |
| 0.20         | 0.01         | 0.20                   | 0.01             |
| 0.40         | 0.03         | 0.40                   | 0.03             |
| 0.50         | 0.07         | 0.50                   | 0.07             |
| 0.70         | 0.10         | 0.70                   | 0.10 (default)   |

The migration sets `P' = max(P, F)` (exact for the pressure path) and drops `F`.
A flat `0.10` new-data floor (today's code) is wrong for three of the four rows:
it raises a 1–7 % floor to 10 %, i.e. it _delays_ new-data pruning the more the
user had tuned it down.

### 4.2 Proposal — derive the floor from the surviving pressure

```ts
/** New-data floor derived from the single surviving pressure knob. */
export function dropperNewDataFloor(pressureThreshold: number): number {
  const p = Number.isFinite(pressureThreshold) ? pressureThreshold : 0.7;
  return Math.min(0.1, Math.max(0.02, 0.15 * p));
}
```

Why ×0.15 clamped to [0.02, 0.10]:

| P    | observed F | floor(P)=clamp(0.15P) |
| ---- | ---------- | --------------------- |
| 0.20 | 0.01       | 0.03                  |
| 0.40 | 0.03       | 0.06                  |
| 0.50 | 0.07       | 0.075                 |
| 0.70 | 0.10       | 0.10                  |

- The default `P = 0.70` reproduces today's `0.10` **exactly** — no change for
  the default posture.
- Lowering `P` lowers the floor proportionally, so "prune earlier" stays coherent
  across the whole knob instead of one end moving and the other staying pinned.
- The clamp keeps tiny pressures from producing a near-zero floor that would let
  the pruner run on a 2 %-full pool.

Every floor consumer moves together:

- `consolidation.ts` `anyStageDue` gate (replaces the constant).
- `consolidation.ts` `skipFullness:` passed to `maxDropCountForPool`.
- `/blackhole-memory` "eligible at ≥X %" line (`commands/memory.ts`).
- `ledger/progress.ts` doc comment and `pressureHint` scale.

`DROPPER_NEWDATA_FLOOR` the constant is replaced by `dropperNewDataFloor(P)`.

**Alternative if preferred:** keep the flat `0.10` constant (today's code). It is
simpler but shifts every custom floor, so it is not the recommendation.

---

## 5. Accepted / no-op

- **Regression 4** (reflector/dropper input budgets merge) — accepted; they may
  share one budget.
- **Regression 5** (`observerPreambleMaxTokens` deleted, 30 % constant) —
  accepted.
- **Regression 6** (removed env vars; `PI_BLACKHOLE_COMPACT_AFTER_RATIO` ≤ 1
  means fraction) — accepted; document in `docs/MIGRATION-GUIDE.md` only.
- **Regression 7** (project config + `.bak` written) — accepted; `.pi/` is
  dotfile territory and these files should not be committed.
- **`compactAfterTokens: 81000` dropped** — unchanged; already dropped on `dev`.

---

## 6. Tests (AGENTS T1–T8)

Write red first for each fix:

1. **Backup gate** — injected failing `copyFile` / mismatching re-read → no
   write, original byte-identical, warning emitted.
2. **0-as-unset matrix** — `{compactAfterTokens:0, compactAfterRatio:0.65}` →
   ratio migrates to `65`, threshold is window-scaled (not < 1 %); same for
   reserve-0 and dropper-budget-0.
3. **Fraction-left-behind seatbelt** — a forced un-migrated `0.65` percent shape
   resolves to ≥ ~50 %, never sub-1 %.
4. **Per-key skip** — one bad value (`compactionEngine:"hybrid"`) leaves _other_
   steps migrated, reports the skip, does not stamp.
5. **Version gate** — a file with `configVersion` is never rewritten even with
   consumed keys present.
6. **Notice** — fires on `version === MIGRATION_NOTICE_VERSION` for migrated /
   none / blocked; does not fire on a different version; once per process.
7. **Dropper floor** — `dropperNewDataFloor` table (0.2/0.4/0.5/0.7 → 0.03/
   0.06/0.075/0.10), clamp ends, `anyStageDue` matrix, and the two-phase proof
   still holds.

Do not regress plan-10's existing tests (two-phase, unknown-key preservation,
read-only, corrupt JSON, idempotence).

---

## 7. Decisions (resolved)

1. **Dropper floor** — adopt `dropperNewDataFloor(P) = clamp(0.15 × P, 0.02,
0.10)` (§4.2). Default `P = 0.70` reproduces `0.10` exactly.
2. **Partial migration** — do not stamp; retry + re-warn on the next load until
   the bad value is fixed.
3. **Notice** — two separate notifications: the upgrade notice, then the
   outcome note (migrated / none / blocked).

## 8. Triage of the PR #135 bot reviews (kilo-code, coderabbit, fallow)

Verified against the code on this branch. Bots have narrow context; every item
below was checked at the cited line before a verdict.

### Fix — real, in scope (folded into the sections above)

| Finding                                                                                                                          | Where                             | Section                                                              |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------- |
| `isWindowPercent` cannot tell a legacy fraction from a percent → sub-1 % threshold                                               | `unified-config.ts`               | §2.2 seatbelt                                                        |
| `defaultBackup` swallows copy errors; remove-only path takes no backup                                                           | `runner.ts`                       | §1                                                                   |
| `0` sentinel aborts the whole file                                                                                               | `steps.ts`                        | §2.2                                                                 |
| Whole-file abort, error discarded by the loader                                                                                  | `steps.ts`, `unified-config.ts`   | §2.3 / §2.4                                                          |
| Notice fires only when `changed`, including when nothing reached disk                                                            | `index.ts`, `migration-notice.ts` | §3.2                                                                 |
| Tuned dropper fullness replaced by `0.10`                                                                                        | `consolidation.ts`                | §4                                                                   |
| `PI_BLACKHOLE_COMPACTION_ENGINE` silently inverts intent                                                                         | `unified-config.ts`               | new — one-line shim (`pi-default` → `off`) + warn                    |
| `legacyPassiveKey` captured from global layer only (project `passive` no longer arms the env undo)                               | `unified-config.ts:800`           | new — capture from both layers                                       |
| Per-layer `compactAfterBy` makes the shape order-dependent across scopes                                                         | `unified-config.ts:812`           | new — re-derive the shape once after the merge from value precedence |
| `configFileNeedsMigration` counts `compactionEngine` as a new key                                                                | `unified-config.ts:1010`          | new — obsolete reminder; fix the predicate                           |
| `estimateDescriptionRows` ignores the new dynamic help line                                                                      | `render.ts:462`                   | new — sum present help blocks                                        |
| `buildVisibilityContext` keys rows by bare key across tabs → conditional threshold rows hidden when a key repeats in another tab | `values.ts:29`                    | new — scope the map by active tab                                    |
| Modal `validate` never migrates a fraction, then persists the selector beside it                                                 | `blackhole-settings.ts:609`       | new — normalize a `(0,1]` ratio ×100 in the modal path               |
| `atomicWrite` leaks the temp file when `writeFile` fails; rename drops the original file mode                                    | `runner.ts:63`                    | new — wrap in try/unlink, chmod temp to source mode                  |
| `ctx.cwd` passed unguarded; a missing cwd skips the global migration                                                             | `index.ts:62`                     | new — guard                                                          |
| `docs/MIGRATION-GUIDE.md` not shipped in `package.json files` (notice points at it)                                              | `package.json`                    | new — add `docs/`                                                    |
| `compactionAfterRatio` typo in the guide; understated dropper divergence in guide + CONFIG                                       | docs                              | new — fix wording                                                    |
| `Math.round(ratio*100)` can round a tiny fraction to `0`                                                                         | `steps.ts:206`                    | §2.2 — treat a round-to-0 as unset                                   |
| Stale `max(pressure, fullness)` comment                                                                                          | `consolidation.ts:319`            | trivial                                                              |

### Defer — ambiguous, low, or not a regression

- **Phase-2 clobbers a concurrent writer** — inherent without file locking; needs
  a coordinated lock story, not a quick fix. Documented limitation.
- **`fsync` on a read-only handle / parent dir not fsynced** — platform nuance
  (Windows); the temp+rename already gives crash safety on POSIX.
- **`EPERM`/`EACCES` reported as read-only** — message wording only.
- **`min > max` silently discards the ceiling** — edge; decide later whether to
  warn. Floor-wins is a defensible clamp.
- **Env-implied shape exists in only one loader** (`ConfigManager` slash-command
  path) — pre-existing split-loader pattern; drift is display-only and needs a
  separate design pass.
- **Env shape forced on mere presence** — the value still falls through the
  legacy precedence, so the threshold is not wrong.
- **`legacy-modes` deletes keys even when its side effects were gated** — matches
  the old `migrateOldKnobs` behavior exactly; not a regression.
- **fallow `unused-export` / `code-duplication`; docstring coverage** — lint and
  style, not behavior.
- **Test-quality findings** — tests are being rewritten for this work; the gaps
  (vacuous guard, stubbed atomicity, dead doc path) are noted and will be covered
  by the new red-first tests.
- **`CHANGELOG` and `observational-memory.md` strings that describe the old
  `0.10` floor** — updated as part of §4.

### Not a bug

- **"`applyConfigMigrations(...).error` is discarded"** — the function returns
  `{ config, changed }`; there is no `error` field. The _underlying_ concern
  (an aborted file is silent) is real and is handled by §2.3/§2.4.
