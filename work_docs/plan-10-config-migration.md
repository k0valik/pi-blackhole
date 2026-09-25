# Plan 10 — Config file migration

**Goal:** when plan-09's folds/deletions/value-changes ship, rewrite each user's
real config file on disk so the keys they see match the keys the code reads. Old
constituent keys are projected to their new homes and then removed; unknown keys
are never touched.

**Status:** this _reverses_ plan-09's original "ignored, not migrated" posture.
Plan-09 is updated at the affected sections; this file owns the design.

**Reference:** `aliou/pi-guardrails` — `src/shared/config/migration/*` and the
engine in `@aliou/pi-utils-settings` (`src/config-loader.ts`). Study copies:
`/tmp/pi-guardrails`, `/tmp/pius`.

---

## 1. What we borrow, and where we differ

Borrowed:

- One ordered module per migration, each with an id, a trigger, a transform, and
  an optional user-facing message.
- **Per-file application:** global and project-local configs are migrated
  _separately_, each read → transformed → written independently.
- Presence-gated, idempotent re-runs.
- A user-facing `message` describing what changed, surfaced once.

Deliberate differences:

| pi-guardrails                             | ours                                                                | why                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Plain `writeFile`                         | **temp + `fsync` + `rename`**                                       | a crash mid-write must never truncate a config                       |
| Single write pass (strip + add together)  | **two-phase**: write new keys → verify by re-read → remove old keys | never delete a legacy key unless its replacement is provably on disk |
| Unknown keys survive incidentally         | **explicit tested guarantee**                                       | the user's stated requirement must hold, not be assumed              |
| Version stamp drives `shouldRun`          | presence gate **plus** a stamp written on first migration           | no silent rewrites now; version gating available later               |
| Write failure → `console.error`, continue | same, plus explicit read-only tests                                 | Nix / read-only installs are a hard requirement                      |

---

## 2. Module shape

`src/core/config-migration/`:

```ts
export interface ConfigMigration {
  /** Stable id — logs and message accounting. */
  id: string;
  /** Legacy keys this step owns. Nothing outside this list is read or deleted. */
  consumes: readonly string[];
  /** New keys this step is responsible for producing (the phase-1 targets). */
  produces: readonly string[];
  /**
   * Transform a structuredClone of the raw config in place, reading only
   * `consumes` keys and writing only `produces` keys (+ the version stamp).
   * Return true when it changed something. Must be total: if a consumed value
   * is unrecognized, return false and let the gate abort the whole file.
   */
  apply(raw: Record<string, unknown>): boolean;
  /** One-line user-facing note; surfaced once per file when the step runs. */
  message?: string;
}
```

- `steps.ts` — ordered list.
- `runner.ts` — `migrateConfigFile(path)` (below).
- `index.ts` — `migrateConfigFiles(cwd)` entry point.

---

## 3. Algorithm (per file) — two-phase, verified

```
migrateConfigFile(path):
  1. not exists → no-op
  2. read + JSON.parse; invalid JSON → warn, skip (never rewrite corrupt files)
  3. consumed = [k for steps for k in step.consumes if k in raw]
     if consumed is empty → no-op                      # no silent rewrites
  4. projection = clone(raw) ; run step.apply for each step with a consumed key
     if any step reports "unrecognized value" → warn, abort (touch nothing)
  5. targetPresent = every step.produces key is already in raw
     if targetPresent and consumed present → skip to phase 2 (remove-only)
  6. PHASE 1 (only if some target key is missing):
       - backup once (`*.bak`, first write only)
       - atomicWrite(raw + projected keys + configVersion stamp)
       - VERIFY: read the file back; every produces key must be present
         - verify failed (read-only / partial) → warn, return the in-memory
           projected config, and DO NOT remove any old key
  7. PHASE 2 (only after phase-1 verification, or the remove-only case):
       - atomicWrite(projected config with `consumes` keys deleted)
  8. return { changed, applied, messages }
```

Why two phases: a single-pass rewrite that adds new keys and removes old keys
has a crash window where neither exists. Phase 1 only ever _adds_, so the file
is always valid; the version stamp and re-read make the add durable; only then
does phase 2 delete. A crash between the phases is self-healing — the next load
sees new keys + old keys and takes the remove-only path.

The gate ("no silent rewrites") is exactly the user's rule:

- Write only when at least one owned legacy key is present.
- Never project when anything is unrecognized (step returns `false`).
- If the new keys are already present, skip projection and just remove the old
  ones.
- Never remove an old key whose replacement has not been verified on disk.

---

## 4. Atomic write, backup, read-only

```ts
async function atomicWrite(path: string, text: string): Promise<void> {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(tmp, text, "utf-8");
  try {
    const fh = await open(tmp, "r");
    await fh.sync();
    await fh.close();
  } catch {
    /* fsync best-effort */
  }
  await rename(tmp, path);
}
```

- Serialize with the existing 2-space indent + trailing newline.
- On failure, best-effort `unlink(tmp)`; the original file stays byte-identical.
- **Backup:** before the _first_ write only, best-effort `copyFile(path,
`${path}.bak`)` if no `.bak` exists. Skipped silently when not writable.
- **Read-only:** the writer throws; the runner classifies `EROFS`/`EACCES`/
  `EPERM`, warns, writes nothing, and returns the in-memory projected config so
  the current load still behaves migrated. Never throws.

---

## 5. Steps (derived from plan-09 §3)

| id                       | consumes                                                                                     | produces / does                                                                                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compaction-engine-fold` | `compactionEngine`                                                                           | drops it; `compaction: "auto"` + `pi-default` → `off` (equivalent); value `auto` → `automatic`                                                                                                                          |
| `threshold-array`        | `compactAfterTokens`, `compactAfterRatio`, `compactAfterReserveTokens`, `compactAfterPreset` | sets `compactAfterBy` by the old precedence (tokens > ratio > reserve > preset); `ratio` ×100 (fraction → percent); `compactAfterReserveTokens` is **preserved** as `compactAfterBy: "reserve"`; legacy `81000` dropped |
| `dropper-fraction-merge` | `dropperPoolFullnessThreshold`                                                               | sets `dropperPressureThreshold = max(oldPressure, oldFullness)`, drops the fullness key; the new-data floor becomes the constant 0.10 (plan-09 §3.3)                                                                    |
| `input-budget-merge`     | `dropperInputMaxTokens`                                                                      | folds into `reflectorInputMaxTokens` when the survivor is unset; drops the dropper key                                                                                                                                  |
| `dead-knobs`             | `observationsPoolTargetTokens`, `observerPreambleMaxTokens`                                  | deletes them                                                                                                                                                                                                            |
| `legacy-modes`           | `passive`, `noAutoCompact`, `overrideDefaultCompaction`                                      | same mapping as the in-memory `migrateOldKnobs`, persisted                                                                                                                                                              |

Notes:

- `compactAfterPresets` is **not** consumed — it stays.
- Env vars are not migrated (out of scope).

---

## 6. Where it runs

- Global: `<agentDir>/pi-blackhole/pi-blackhole-config.json`
- Project: `<cwd>/.pi/pi-blackhole-config.json`

Both scopes are migrated automatically at extension init (and/or at the top of
`loadUnifiedConfig`), once per process per path. A tracked project config is the
user's problem (§8). Because files are rewritten before any reader runs, the
vendored modal loader needs no change — by the time `/blackhole configure` opens,
the file on disk is current.

---

## 7. Tests

Fixtures:

- **`example-config-old.json`** — the real pre-plan fixture; do **not** delete
  (plan-09 §5 item 6).
- **`example-config.json`** — the post-plan canonical file.
- A pinned `tests/fixtures/config-migration/{old,expected}.json` pair so the
  example files changing does not silently re-baseline the test.

Cases:

1. **Real-fixture migration** — migrate `example-config-old.json`; assert zero
   consumed keys remain, output is valid JSON, matches the pinned `expected.json`.
2. **Unknown-key preservation** — inject `"x-custom": {...}` + a plausible future
   key; assert both survive byte-for-byte while consumed keys are gone.
3. **Only-owned keys** — no non-consumed key is added, removed, or altered.
4. **Two-phase proof** — inject a writer that records calls: assert phase 1 does
   not delete old keys, a re-read happens between phases, and phase 2 runs only
   after the projection verified.
5. **Phase-2 safety** — force phase-1 verification to fail; assert old keys are
   still present in the file and the returned in-memory config is projected.
6. **Remove-only path** — file already has the new keys plus an old key; assert
   one write, old key removed, new key untouched.
7. **Gate / no silent rewrite** — a file with no consumed keys is not written;
   an unrecognized consumed value aborts with no write.
8. **Idempotence** — second run reports no change, file byte-identical.
9. **Atomicity** — temp + rename used; a throwing write/rename leaves the
   original byte-identical, no temp remains.
10. **Read-only** — injected `EACCES` writer: no throw, warning logged, in-memory
    projected config returned.
11. **Per-scope independence** — global and project migrate separately.
12. **Corrupt JSON** — untouched, no throw.
13. **Version stamp** — written once on first migration, preserved thereafter.
14. **One test per step** (AGENTS T5), including `auto + pi-default → off`, the
    ratio→percent conversion, reserve preserved as a shape, `81000` dropped, and
    the legacy-modes clean-up.

Follow AGENTS T1–T8: failing test first, one behavior per test, cleanup in
`afterEach`/`finally`, no unsafe casts, mock the real serializer shape.

---

## 8. Resolved decisions

1. **Two-phase, verified migration, presence-gated, with a version stamp.**
   Never rewrite a file with nothing to migrate; never delete an old key until
   its replacement is verified on disk. Stamp `configVersion` on first migration
   for future gating.
2. **One-time `.bak`** before the first write; atomic rename stays.
3. **`compactAfterReserveTokens` is preserved** as a shape
   (`compactAfterBy: "reserve"`). Users actively rely on it; dropping it would
   regress them.
4. **The dropper fractions merge to one knob** (`dropperPressureThreshold`).
   Migration sets `max(oldPressure, oldFullness)`; the new-data floor becomes the
   constant 0.10. Exact for default-floor configs; the only divergence is a
   custom floor above 0.10 (plan-09 §3.3).
5. **Both scopes auto-migrate.** A tracked project config is the user's problem.
6. **`legacy-modes` cleaned off disk** as a step.

---

## 9. Changelog notice (exit gate)

`src/changelog/migration-notice.ts` already ships a one-per-process, version-gated
nudge (`maybeNotifyThresholdMigration`, gated to `MIGRATION_NOTICE_VERSION`,
wired in `index.ts:59`). The release that carries this work must add a notice for
this migration:

- Bump `MIGRATION_NOTICE_VERSION` in place to the release version and remove its
  `TODO(0.5.3)` note. The module is version-gated, so it self-noops on later
  releases; no removal is needed.
- Message: config keys were renamed/reorganized and the user's file has been
  migrated; invite them to review settings and read the upgrade guide; end with
  `/blackhole changelog`.
- Reuse the existing machinery (once-per-process guard, `getPackageVersion`
  gate, no flag file so read-only installs are unaffected).
- This is an **exit gate**: the release is not "done" until users are told.

---

## 10. Confirm

- Resolved and applied: reserve is kept as a shape; the dropper fractions merge
  to one knob; the notice is renewed in place. No open items.
