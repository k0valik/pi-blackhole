# Changelog

## [0.3.3] - 2026-06-02

### Added

- **New config surface:** `compaction` (`"auto"` | `"manual"` | `"off"`), `compactionEngine` (`"blackhole"` | `"pi-default"`), `tailBehavior` (`"pi-default"` | `"minimal"`). These replace the old `overrideDefaultCompaction`, `noAutoCompact`, and `passive` keys. See [`MIGRATION-GUIDE.md`](MIGRATION-GUIDE.md) for the full mapping. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))
- **Config overlay (`/blackhole configure`):** interactive TUI with ↑↓ navigation, Enter to edit/toggle, Ctrl+S to save. 17 fields across 3 sections (Compaction, Observational Memory, Debug) with inline help text. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))
- **Status overlay (`/blackhole-memory`):** new render with compaction config readout, OM pipeline state, and inline actions (configure, om-off/on). ([#14](https://github.com/k0valik/pi-blackhole/pull/14))
- **Tail behavior control:** `tailBehavior: "minimal"` keeps only the last user message (aggressive pi-vcc cut, default); `tailBehavior: "pi-default"` keeps Pi's ~20k token tail visible (opt-in). Both auto-triggered and `/blackhole` now default to `"minimal"`. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))
- **12 permutation tests** covering all compaction × memory × threshold combinations for the new config keys. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))
- **Documentation:** CONFIG.md (new reference), OLD_CONFIG.md (legacy docs), MIGRATION-GUIDE.md (migration path from old keys), README.md and llms.txt updated for the new surface. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))
- **Per-model context window override:** `OmModelConfig` now supports an optional `contextWindow` field. When set on any stage model or fallback, it overrides Pi's model registry value for the context window check. Unset models inherit from Pi normally. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))
- **Context window pre-check:** before calling each OM stage agent (observer, reflector, dropper), the estimated input tokens (stage cap + 8K reserve for system prompt/tools/turns) are checked against the model's effective context window. If the input exceeds the window, the model is skipped and the next fallback is tried. If all models are exhausted, a warning is shown. Strictly opt-in — with default caps (40K–80K) and typical models (128K+), the check is a no-op unless a `contextWindow` override is explicitly set. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))
- **8 tests** covering context window parsing from config, priority resolution, rejection of invalid values, and `effectiveContextWindow` logic. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))

### Changed

- **`memory: false` no longer blocks auto-compaction.** Memory and compaction are now truly independent — `memory: false` stops OM workers but compaction still runs. Use `compaction: "manual"` or `compaction: "off"` to control compaction separately. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))
- **`compaction: "off"` semantics refined:** blocks blackhole's auto-trigger and returns early from the before-compact hook for auto-triggered compactions (letting Pi handle them), but explicit `/blackhole` still uses blackhole's pipeline. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))
- **Config migration is automatic:** old keys (`overrideDefaultCompaction`, `noAutoCompact`, `passive`) are migrated to new keys in memory at load time. The on-disk file is never mutated. New keys take priority when present. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))
- **Permutation tests updated** to reflect the new behavior: `overrideDefaultCompaction` now gates the legacy trigger path, `memory` no longer gates the trigger, and the 16-permutation matrix uses the correct formula. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))

### Fixed

- **Save error handling:** `save()` returns boolean and wraps writes in try/catch — read-only filesystems (e.g., Nix-managed config) no longer crash with an unhandled exception. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))
- **Number input restriction:** configure overlay now only accepts digits for number fields, preventing garbage values from being entered. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))
- **Defensive bounds:** section header pads in configure-overlay and status-overlay use `Math.max(0, ...)` / `Math.max(2, ...)` to prevent negative `.repeat()` counts on tiny terminals. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))
- **Config save failure warning:** `/blackhole configure` now shows a "warning" notification when the config file can't be written instead of a misleading "info" notification. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))
- **Legacy config tests:** updated `config.test.ts` to check new config keys (`compaction`, `compactionEngine`, `memory`) instead of deleted legacy fields (`passive`, `overrideDefaultCompaction`), fixing 10 pre-existing test failures. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))
- **pi-default non-message firstKeptEntryId resolution:** when Pi's `firstKeptEntryId` points to a non-message entry (e.g., OM metadata or compaction), `buildOwnCut` now resolves to the next actual message entry instead of falling through to the minimal cut. ([#15](https://github.com/k0valik/pi-blackhole/pull/15))
- **Array micro-optimization in buildOwnCut:** replaced `branchEntries.slice(cutInBranch + 1).find()` with `branchEntries.find()` using an index check, avoiding a temporary array allocation. ([#15](https://github.com/k0valik/pi-blackhole/pull/15))

## [0.3.2] - 2026-06-01

### Fixed

- **Auto-compaction gating:** added explicit guard at the top of the compaction trigger that returns early when `overrideDefaultCompaction` is `false` (the default). Previously, blackhole would still evaluate token thresholds and call Pi's default compaction hook even when not opted in — causing confusing log entries and unnecessary evaluations. Now blackhole stays completely out of Pi's compaction unless the user explicitly opts in. ([#13](https://github.com/k0valik/pi-blackhole/pull/13))

### Added

- **README top banner:** prominent NOTE at the top instructing users to set `"overrideDefaultCompaction": true` for blackhole to handle compaction automatically. Existing config matrix in the IMPORTANT section retained for reference.

## [0.3.1] - 2026-05-31

### Fixed

- **Auto-compaction idle detection timing:** changed compaction scheduling from `queueMicrotask` to `setTimeout(..., 0)`. The microtask fired before Pi completed its post-response processing cycle, causing `ctx.isIdle()` to always return `false` and compaction to be deferred indefinitely. `setTimeout` yields to the event loop, allowing Pi to mark itself idle before the callback runs. ([#13](https://github.com/k0valik/pi-blackhole/pull/13))

### Added

- **Debug logging for compaction pipeline:** structured `debugLog` instrumentation at every decision point — guard checks, token threshold evaluation, branch entry inspection, session identity validation, idle check, and compaction completion/error. Opt-in via `"debugLog": true` in config, zero overhead otherwise. ([#13](https://github.com/k0valik/pi-blackhole/pull/13))
- **Permutation test suite:** 36 new tests covering all 16 configuration knob combinations for auto-compaction trigger behavior. ([#13](https://github.com/k0valik/pi-blackhole/pull/13))

## [0.2.4] - 2026-05-29

### Recall: progressive discovery

- **Touched mode (`mode:touched`):** aggregate view of all files written/edited across the session, grouped by path with entry indices. Accessible via `recall` tool and `/blackhole-recall` command. ([#12](https://github.com/k0valik/pi-blackhole/pull/12))
- **Drill-down (`#N:path`):** read file content from tool call arguments in any transcript entry. Supports `#42:auth.ts` (preview first 30 lines), `#42:auth.ts:full` (all lines), `#42:auth.ts:offset:limit` (paged). Path auto-selects when unique; ambiguous paths list options. ([#12](https://github.com/k0valik/pi-blackhole/pull/12))
- **Search mode filtering (`mode:file`, `mode:transcript`, `mode:hybrid`):** `mode:file` searches only write/edit file content; `mode:transcript` searches only conversation text; `mode:hybrid` (default) searches both. ([#12](https://github.com/k0valik/pi-blackhole/pull/12))
- **Merged expand + search:** `#N` expand entries are now merged into search results (rather than being mutually exclusive), with proper pagination and sorting. ([#12](https://github.com/k0valik/pi-blackhole/pull/12))
- **`scope` parameter as `StringEnum`:** tool schema now uses `StringEnum` (strict literal union) instead of `Type.Union` for `scope` and `mode` parameters. ([#12](https://github.com/k0valik/pi-blackhole/pull/12))

### Fixed

- **Null-safe entry IDs in `load-messages.ts`:** gracefully handles entries with `null` IDs instead of crashing with `String(null)` → `"null"`. ([#12](https://github.com/k0valik/pi-blackhole/pull/12))
- **`formatRecallOutput` preserves legacy `files:[...]` format:** the expand-only path (no query) was silently dropping file info from entries that have the `files` field but no `fileMatches` — now falls back to the old `files:[path1, path2]` suffix. ([#12](https://github.com/k0valik/pi-blackhole/pull/12))

### Crash protection — jiti bridge, EACCES guards, config safety

- **Jiti bridge for custom providers:** `index.ts` now wraps `pi.registerProvider` to capture `streamSimple` functions into a `Symbol.for()` global, and scans `modelRegistry.registeredProviders` once on `agent_start`. This prevents crashes when consolidation agents (loaded via jiti with `moduleCache: false`) resolve a custom provider like `claude-bridge` — previously the jiti-loaded pi-ai instance had an empty `apiProviderRegistry` and threw `"No API provider registered"`. ([#11](https://github.com/k0valik/pi-blackhole/pull/11))
- **Lazy bridge evaluation:** the bridge stream function now checks the provider map at call time instead of at import time, fixing an IIFE race condition where the bridge was permanently disabled because provider registration hadn't happened yet at module load. ([#11](https://github.com/k0valik/pi-blackhole/pull/11))
- **Always-run fallback scan:** replaced `providerStreams.size > 0` guard with a dedicated `hasScannedFallback` flag — the fallback scan now always runs once regardless of how many providers the wrapper already captured, handling extensions that register before blackhole loads. ([#11](https://github.com/k0valik/pi-blackhole/pull/11))
- **EACCES guards:** `writeCooldownMap()` and `writeSessionState()` now wrapped in try/catch. Prevents process crash on read-only filesystems (e.g., Nix-managed config). Cooldown loss is advisory (slightly more API traffic); pending state loss is safe (idempotent re-processing). ([#11](https://github.com/k0valik/pi-blackhole/pull/11))
- **Numeric config validation:** all numeric fields are validated at load — NaN, infinity, and negative values are reset to defaults. Prevents silent math errors in pipeline logic. ([#11](https://github.com/k0valik/pi-blackhole/pull/11))
- **`observerPreambleMaxTokens=0` explicitly allowed** in numeric validation (means "auto-compute"). ([#11](https://github.com/k0valik/pi-blackhole/pull/11))
- **Better error messages for config save failures:** `/blackhole om-on` / `om-off` now use `"warning"`-level notification with an explanation about read-only filesystems when the config save fails, instead of a misleading `"info"`-level "Failed to save config.". ([#11](https://github.com/k0valik/pi-blackhole/pull/11))

## [0.2.3] - 2026-05-27

### Lockstep sync — 2026-05-27

- Ported upstream OM prompt refinements: coverage tiers in dropper prompt, "highest-resistance" critical framing in observer, coverage stewardship in reflector (#safe)
- Ported upstream debug logging: `dropper.agent_start`, `dropper.tool_call`, `dropper.result` with full coverage/relevance diagnostics (#d6b02c0)
- Ported upstream coverage-aware pruning: new `coverage.ts` module, drop candidate sort by coverage→relevance→age, critical observations no longer hard-rejected (#e00363a)
- Adapted config: added `observationsPoolTargetTokens` as forward-compat no-op (upstream 52b5844 budgetTokens→targetTokens rename)
- Skipped upstream pool refactor (bf79ff7) and rename (52b5844): kept our ratio-based urgency algorithm
- Recovered output cap from feat/compaction-output-cap: `buildCompactionProjection` now caps rendered observations to `observationsPoolMaxTokens` budget via relevance+recency scoring

## [0.2.2] - 2026-05-26

### Added

- `/blackhole-memory` pipeline display reworked: renamed "Coverage" to "Pipeline", replaced percentage-based metrics with `X tokens (triggers at Y)` format to eliminate false-alarm 100% readings, added `[auto-disabled]` annotation for compaction in noAutoCompact mode, and show preamble cap in Pending section ([#7](https://github.com/k0valik/pi-blackhole/pull/7))
- Default `observeAfterTokens` increased from 10,000 to 15,000 and `reflectAfterTokens` from 20,000 to 25,000 for better cost-efficiency on mid/high context sessions ([#7](https://github.com/k0valik/pi-blackhole/pull/7))
- Observer preamble cap in noAutoCompact mode: the observer stage's `CURRENT OBSERVATIONS` preamble is now capped to prevent unbounded prompt growth from accumulated observation batches. High-relevance observations are always kept; medium and low observations are scored by relevance tier and relative recency (array position, not wall-clock time), with the best-scoring kept within the token budget. Reflections are never trimmed. The cap is governed by the new `observerPreambleMaxTokens` config setting (default `0` = auto-compute 30% of `observerChunkMaxTokens`). Only applies in `noAutoCompact` mode — the auto-compact path is unchanged. ([#7](https://github.com/k0valik/pi-blackhole/pull/7))
- Accumulated batch history for noAutoCompact mode: the observer, reflector, and dropper stages now feed accumulated pending.json batches (observationBatches/reflectionBatches) to the LLM instead of reading from the (empty) branch. This restores the same historical context the pipeline receives in autoCompact mode — prior observations/reflections, existing summaries — but without writing markers to the visible branch. Each pipeline run appends its output batch to the pending store; on /blackhole flush, all accumulated batches are written as separate branch markers, preserving per-run coverage. ([#7](https://github.com/k0valik/pi-blackhole/pull/7))
- Accumulated dropper batches (`droppedBatches`) in pending.json so that earlier dropper runs are not lost when a subsequent cycle overwrites `pending.dropped` before a /blackhole flush. The flush now writes all accumulated dropper batches to the branch, preventing observations dropped in earlier cycles from being "un-dropped" on compaction. ([#7](https://github.com/k0valik/pi-blackhole/pull/7))

### Fixed

- Reflector and dropper now read from `pending.json` in `noAutoCompact` mode instead of scanning the branch for observation markers that are never written there. Previously the early-exit gates in both stages returned immediately because `latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED)` found nothing in the branch (observations are saved to pending only). This caused the reflector and dropper to skip entirely, leaving the pipeline half-functional — no reflections were ever generated, the dropper never pruned, and the display showed misleading pool values. The fix adds `noAutoCompact`-aware early-exit gates that check `pending.observation`, `pending.reflection`, and `pending.dropped` state, using their `coversUpToId` values to calculate token gaps and gate correctly on `reflectAfterTokens`. Observations and reflections are fed from pending data instead of the empty branch. The notification token-adjustment logic (which already existed for all three stages) is now effective because the stages actually run. ([#6](https://github.com/k0valik/pi-blackhole/pull/6))

## [0.2.1] - 2026-05-24

### Fixed

- Prevent repeated `Intl.Segmenter` constructor fallback retries on unsupported runtimes ([#5](https://github.com/k0valik/pi-blackhole/pull/5))
- `/blackhole-memory` accumulated token counts now factor in pending `coversUpToId` as virtual coverage markers in `noAutoCompact` mode ([#5](https://github.com/k0valik/pi-blackhole/pull/5))
- Pipeline notifications (observer/reflector/dropper) show accurate accumulated values accounting for pending coverage ([#5](https://github.com/k0valik/pi-blackhole/pull/5))
- `stageThinkingLevel()` resolves per-model thinking config instead of using the primary stage model's setting for all fallback attempts ([#5](https://github.com/k0valik/pi-blackhole/pull/5))
- Move `@earendil-works/*` packages to `peerDependencies` (provided by pi host at runtime), `typebox` to `devDependencies` (import type only) ([#5](https://github.com/k0valik/pi-blackhole/pull/5))
- Dead code removal: deleted `src/om/compaction-hook.ts` and `src/core/report.ts` ([#5](https://github.com/k0valik/pi-blackhole/pull/5))
- Module-level state leak: compaction stats moved to `Runtime` instance for session isolation ([#5](https://github.com/k0valik/pi-blackhole/pull/5))
- Unified config loading: removed dual `loadSettings` path, `ensureConfig` called at handler start ([#5](https://github.com/k0valik/pi-blackhole/pull/5))
- Stale context in deferred compaction: replaced `setTimeout(..., 0)` with `queueMicrotask` and session ID validation ([#5](https://github.com/k0valik/pi-blackhole/pull/5))
- Silent JSON parse failures in `load-messages.ts` — now logged ([#5](https://github.com/k0valik/pi-blackhole/pull/5))
- Silent `scaffoldConfig` errors — now logged ([#5](https://github.com/k0valik/pi-blackhole/pull/5))
- `visibleProjection` falls through to `fullProjection` when no compaction has run ([#5](https://github.com/k0valik/pi-blackhole/pull/5))
- `renderMessage` calls in `report.ts` and test types missing required `Message` properties ([#5](https://github.com/k0valik/pi-blackhole/pull/5))
- CI publish workflow uses `npm` instead of `pnpm` (not available in runner) ([#5](https://github.com/k0valik/pi-blackhole/pull/5))
- Added `typescript` devDependency for CI `tsc` check ([#5](https://github.com/k0valik/pi-blackhole/pull/5))

### Changed

- Improved model fallback: `resolveModel` iterates fallback chain (stage → fallbacks → base → session), records per-model cooldown on retryable errors ([#5](https://github.com/k0valik/pi-blackhole/pull/5))

### Added

- Bi-directional recall coupling: `#N` transcript expansion shows related OM observations/reflections; OM hex-id recall shows `#N` entry index annotations ([#5](https://github.com/k0valik/pi-blackhole/pull/5))
- `id` field on `RenderedEntry` for cross-referencing with session entries ([#5](https://github.com/k0valik/pi-blackhole/pull/5))

## [0.2.0] - 2026-05-24

### Added

- Initial release: unified compaction (pi-vcc) + observational memory (pi-observational-memory)
- `/blackhole` command for manual compaction with OM content injection
- `/blackhole-memory` command for pipeline status display
- `/blackhole-recall` command for unified recall (transcript + OM)
- Three-stage consolidation pipeline: observer → reflector → dropper with fallback retry
- Per-session pending file isolation
- Model cooldown persistence across restarts
- CI/CD publish workflow for npm
