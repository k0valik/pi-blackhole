## [Unreleased]

### Changed

- **Upgraded recall & export algorithms (BM25+, SimHash64, c-TF-IDF, and technical density scoring).**
  - Upgraded session history search to **BM25+** with lower-bound delta term ($\delta = 0.5$) preventing length bias against concise observations.
  - Added lightweight morphological stemming (`stemToken`) to `dedup.ts` for higher token-set overlap across grammatical variants.
  - Added 64-bit SimHash locality-sensitive fingerprinting (`computeSimHash64`, `simHashHammingDistance`) and cluster drift guards to speed up pairwise candidate filtering and prevent transitive clustering drift.
  - Added technical entity density scoring (`technicalDensityFactor`) in `format-export.ts` to reward concrete code artifacts (paths, symbols, flags, hashes) over conversational transcripts.
  - Expanded stemming and technical-artifact detection for common software terminology, major language file types, framework constructs, API routes, DevOps/configuration signals, errors, and semantic versions.
  - Topic labels now preserve readable surface words while using stems only for internal matching and scoring.
  - Upgraded topic labeling from standard TF-IDF to **c-TF-IDF** (Class-based TF-IDF with sublinear saturation) and added a Key Topics index table in the export preamble.

### Fixed

- **Git-based installs no longer require interactive `pnpm approve-builds`.** `simple-git-hooks` is explicitly trusted through pnpm 11's workspace `allowBuilds` configuration, and the prepare lifecycle now initializes hooks and builds the bundle exactly once.

---

## [0.4.9] - 2026-08-28

### Added

- **Distilled project-memory export (`/blackhole-export`).** ([#65](https://github.com/k0valik/pi-blackhole/pull/65)) New command that scans project-scoped session JSONL files plus global OM pending buffers, deduplicates/clusters observations, and writes a single import-ready Markdown file (tiered as `Reflections → Critical → High → Medium → Low` plus an `Unattributed pending memory` section for orphaned buffers). Scoring is tier-weighted with recency decay, log-scaled recurrence and evidence-mass boosts, consensus rerank, burst penalty and length factor; viability gating keeps low/medium only with multi-session support or length/quality, high/critical always. Hierarchical topic assignment via Sørensen-Dice graph + TF-IDF labeling; three-pass dedup (exact normalized, Levenshtein@0.88 after bigram-Jaccard prefilter, Sørensen-Dice@0.70 with Levenshtein floor). Output parsing via `out:<path>.md` or a timestamped default; deterministic and stateless. New modules `src/project-recall/corpus.ts`, `dedup.ts`, `format-export.ts`, `session-dir.ts` and handler `src/commands/blackhole-export.ts` (wired in `index.ts`). Appendix A slice of the project-recall plan — future project-aware recall search remains out of scope for this release.

### Fixed

- **Capture `AgentSession` from bundled Pi CLI entrypoint.** ([#62](https://github.com/k0valik/pi-blackhole/pull/62), thanks @daoguademeng) `installHostInlineCompactionAdapter` now resolves the host `AgentSession` from the bundled CLI's runtime chunk (when the entrypoint is `dist/bundle/cli.js`) in addition to `dist/index.js`, so inline (mid-run) compaction works when Pi is launched via its bundled CLI instead of silently falling back to settled compaction.
- **Unified `session_compact_failed` handling (pi >=0.84.3).** Ported from [ceblan/pi-blackhole#ceb-dev](https://github.com/ceblan/pi-blackhole/compare/main...ceblan:pi-blackhole:ceb-dev) (thanks @ceblan / Carlos Estrada): new `src/hooks/compact-failed.ts` closes gaps in failure coverage — structured `compact_failed.received` trace with corrected `attributedFromExtension` (`fromExtension || compactWasPiVcc || lastCompactCancelled`), defensive `compactInFlight` + `autoCompactionController` reset (aborts orphaned idle-wait so it cannot launch a second compaction after a later turn), overflow-retry `willRetry` visibility (`"overflow compaction aborted, retrying turn"`), and `compactionEngine: pi-default` noise filtering. `Runtime.lastCompactCancelled` is set on every `{ cancel: true }` from `before-compact` and consumed attempt-scoped with `compactWasPiVcc` (leak-free lifecycle: set at `session_before_compact` start, consumed on `session_compact` success or `session_compact_failed`). Covers pi #8328 overflow path.

---

## [0.4.8] - 2026-08-23

### Added

- **Opt-in append compaction (`compactionSummaryMode`).** New config key (`default` | `append`; `default` is the default) plus `PI_BLACKHOLE_COMPACTION_SUMMARY_MODE` override. In append mode each automatic Blackhole compaction appends one immutable provider-visible segment (`S1 | S2 | …`) while every stored summary stays a complete fallback; `/blackhole` rebases the active chain into one clean segment; a legacy v1 summary enters through one marked rebase. A new `context` hook projects segments before each model call and fails closed to the fallback on any malformed state. When the projected chain passes half of the model's context window, the next automatic compaction folds it back into one segment. Falls back to rewrite surgery once per session when append mode encounters unsupported state. See `docs/APPEND_COMPACTION.md`. ([#58](https://github.com/k0valik/pi-blackhole/pull/58), thanks @sonSunnoi)

### Changed

- **Mid-run compaction failures now use exponential backoff** (1s doubling to a 30s cap) instead of suspending retries until context pressure drops. A single transient failure no longer wedges auto-compaction for the rest of the pressure episode; failure notices now include "retrying in Xs".
- **Permanent inline-compaction unavailability (pi version lacks the adapter API) is now classified once** and reported as a single warning ("using settled compaction fallback") instead of surfacing as a retryable failure every episode. With `midRunCompaction: resume`, later turn-end attempts skip the adapter immediately, and agent start warns once if resume mode is configured against a known-unsupported adapter.
- **Compaction token counting now uses real provider usage when available.** `rawTokensSinceLastCompaction` reads the last valid assistant message's usage (`calculateContextTokens`: `totalTokens` or the input/output/cache component sum) after the latest compaction entry, plus a chars/4 estimate for trailing entries, instead of estimating the whole window from characters. Chars/4 remains the fallback for sessions without usage data. Error/aborted assistant turns are never used as baselines; usage from before the latest compaction is ignored (it reflects the pre-compaction context). Approach from tavasti@360f24a (pi-vcc upstream PR #40); hardened implementation ported from plan-01 of the token-rework work.
- **Minimal tails honor later Pi split-turn boundaries.** An oversized current turn can now be cut at Pi's safe assistant/user boundary instead of being retained whole after compaction.

### Fixed

- **Inline compaction ignores aborted/errored assistant turns.** Assistant messages with `stopReason: "error"` or `"aborted"` are now skipped when checking for trailing in-flight tool calls, matching Pi's own transform-messages behavior.
- **Inline compaction ignores stale tool calls** that reference cleared state from a prior turn ([#57](https://github.com/k0valik/pi-blackhole/pull/57), thanks @daoguademeng)
- **Settings modal footer and key dispatch guard against section rows.** Prevents a crash when the focused row in `/blackhole configure` is a section header instead of an editable field.

---

## [0.4.7] - 2026-08-15

### Fixed

- **Installation from git now works without a prebuilt `dist/`.** The package manifest entrypoint now points at `./index.ts` instead of `./dist/index.js`. Because `dist/` is gitignored, direct Git installs were missing the extension entrypoint and failing to load. Pi can load the TypeScript entrypoint directly, so this restores functionality for `npm install github:k0valik/pi-blackhole` and similar Git-based installs. Registry installs are unaffected (npm/pnpm/bun ship the prebuilt `dist/` bundle).

---

## [0.4.6] - 2026-08-14

### Added

- **Session-local config.** Config values can now be set at session scope via `/blackhole configure` or the config modal's scope selector. Session config is ephemeral — it lives only for the current session and overrides project-local and env values, so you can experiment with settings like `midRunCompaction` or `compactionEngine` without touching files or environment variables.

- **All env overrides are visible in the config modal.** `PI_BLACKHOLE_MID_RUN_COMPACTION`, `PI_BLACKHOLE_COMPACTION`, and `PI_BLACKHOLE_COMPACTION_ENGINE` (alongside existing overrides like `PI_BLACKHOLE_SKIP_PROVIDERS` and `PI_BLACKHOLE_PROVIDER_IDLE_TIMEOUT_MS`) now appear in the env tab of the config modal with their current effective values, so you can see at a glance what the environment is contributing.

### Changed

- **Config modal migrated to the canonical `pi-base` config-rework surface.** The modal now uses the upstream scope-selector and config-flow, replacing the legacy `openSettingsModal` path. The layer precedence is: global → project → env → session, matching pi-utils behavior.

### Removed

- **Dead monolith-era config code.** Removed `src/pi-base/config-settings.ts`, `settings-registry.ts`, `settings-ui.ts`, `registry.ts`, `report.ts`, `llm.ts`, `hash.ts`, `context-provider.ts`, `once.ts`, `debug.ts`, `config-manager-howto.md`, `settings/README.md`, and the obsolete `scope-action.test.ts`. Blackhole-specific wiring (kitty decode, NixOS read-only warnings, key migration, clamping) remains in `blackhole-settings.ts`.

### Fixed

- **Recall drill-down honors lineage scope.** ([#54](https://github.com/k0valik/pi-blackhole/issues/54)) `#N:path` drill-down now checks the active lineage before expanding off-lineage entries, matching every other recall path. Off-lineage indices are blocked under the default `scope:"lineage"` and require `scope:"all"` to access.
- **Inline compaction restores the Working indicator.** ([#52](https://github.com/k0valik/pi-blackhole/pull/52), thanks @daoguademeng) After inline compaction completes, the UI "Working" indicator is restored so the user sees activity resumed.

### Dependencies

- Bumped dev-dependency group across 2 PRs (#45, #53): `@typescript-eslint/eslint-plugin` to `8.66.0`, `eslint` to `10.8.0`, `lint-staged` to `17.3.0`, `typebox` to `1.3.10`, `typescript` to `6.0.3` (pinned for `@typescript-eslint` v8 compatibility), and `vitest` to `4.1.10`.

## [0.4.4] - 2026-08-06

### Added

- **Experimental compatibility shim for pi-codex-compaction coexistence.** ([#47](https://github.com/k0valik/pi-blackhole/pull/47), thanks @danielmrdev) Optional `skipForProviders` (config key or `PI_BLACKHOLE_SKIP_PROVIDERS` env override) makes blackhole step aside entirely — no compaction, no observational-memory consolidation — for listed providers, giving exactly-one-engine semantics when pi-codex-compaction also registers a `session_before_compact` handler. **Niche surface by design**: unsurfaced in README/CONFIG.md until a second consumer exists (see shim notes in `src/core/provider-skip.ts`); surfaced only in example-config.json.

- **Isolated provider idle timeout for background memory jobs.** ([#48](https://github.com/k0valik/pi-blackhole/pull/48), thanks @FelikZ) Optional `providerIdleTimeoutMs` lets observer/reflector/dropper worker HTTP requests tolerate longer silent provider intervals without forcing interactive Pi requests to wait equally long, by wrapping the provider `fetch` with an undici dispatcher that injects `bodyTimeout`. Unset inherits pi's global default; `0` disables; `> 0` sets a millisecond cap. Configurable via config file, `/blackhole configure`, or `PI_BLACKHOLE_PROVIDER_IDLE_TIMEOUT_MS`.

### Fixed

- **Credential-resolved provider endpoints are preserved for observational-memory workers on Pi versions whose registry exposes `getProviderAuth()`.** Observer, reflector, and dropper now use the endpoint selected by Pi's auth resolver, preventing GitHub Copilot Business/Enterprise requests from falling back to the Individual endpoint and returning HTTP 421. On older registries without `getProviderAuth()`, the fix degrades silently to the previous behavior.
- **`midRunCompaction: "resume"` no longer aborts or replaces the active run.** ([#50](https://github.com/k0valik/pi-blackhole/pull/50), thanks @daoguademeng) The old `ctx.compact()` + `blackhole-resume` path propagated a false interrupt to background/subagent extensions and let nested child runners resolve before Blackhole's detached resume run finished. Resume mode now performs Pi's native compaction pipeline inline from the awaited `turn_end` handler, refreshes the next low-level turn from the compacted messages, and continues inside the original `session.prompt()` promise. Completed tool calls remain paired; no synthetic user/custom message is injected. `"resume"` is an **experimental opt-in** — it monkey-patches Pi host internals and can silently deactivate on host drift.
- **Mid-run compaction compatibility fails closed.** A reload-idempotent, weakly referenced runtime adapter recognizes the known Pi 0.81 and 0.84 `AgentSession.compact()` shapes. Unknown internal drift refuses transparent compaction and leaves the active run alive instead of falling back to the unsafe aborting path. External abort/cancellation still passes through normally.

### Testing

- Added adapter contract coverage for Pi 0.81/0.84 compact shapes, no-abort behavior, compacted next-turn context refresh, external cancellation, unpaired-tool rejection, fail-closed drift handling, and reload idempotency. A real `AgentSession` + faux-provider integration test runs on both the 0.81.1 compatibility baseline and 0.84.0 dev baseline, proving the active run signal stays live, the next provider request receives the compacted context, and the original `session.prompt()` remains pending through compaction. Trigger tests prove no `ctx.compact()` or `blackhole-resume` dispatch.

### Dependencies

- Bumped `@earendil-works/pi-*` devDependencies from `0.83.0` to `0.84.0`; the peer range remains `>=0.81.1 <1.0.0`, and the adapter retains a tested legacy-shape path for the minimum supported host.

## [0.4.3] - 2026-08-01

### Added

- **pi-base config modal for `/blackhole configure`.** ([#41](https://github.com/k0valik/pi-blackhole/pull/41)) The hand-rolled configure overlay is replaced with pi-base's ConfigManager + settings modal (vendored into `src/pi-base/`), with scope-aware editing: global config lives at `<agentDir>/pi-blackhole/` (respecting `PI_CODING_AGENT_DIR`), project config overlays `<cwd>/.pi/pi-blackhole-config.json`.

### Changed

- **Number fields edit inline in `/blackhole configure`.** Number fields (e.g. `compactAfterTokens`, `observeAfterTokens`) no longer cycle in fixed steps on every Enter — pressing Enter drops into inline editing where you type the value directly; `←`/`→` still fine-tune by step when not editing.
- **Destructive-action confirmations are safer.** The delete/reset scope confirm now lists **Cancel first (pre-selected)** and shows a warning-color line stating what the action will do — tabbing into the confirm can never land on a destructive action by accident.
- **Custom provider streams discovered through pi's model registry.** ([#42](https://github.com/k0valik/pi-blackhole/pull/42), thanks @FelikZ) The bridge that lets OM agents (observer/reflector/dropper) use custom providers (e.g. claude-bridge) now captures `streamSimple` functions from pi's public registry API (`getRegisteredProviderIds`/`getRegisteredProviderConfig`) on every `agent_start`, instead of wrapping `pi.registerProvider` and reading the private `registeredProviders` field. Works regardless of extension load order and includes providers added after startup; the legacy discovery path remains available for older pi releases.
- **Precompiled extension bundle for faster startup.** The extension now ships a prebuilt `dist/index.js` bundle (tsup/esbuild) instead of being transpiled file-by-file by jiti at startup — module loading drops from ~85 source files to a single ESM file, measured ~1.6–2× faster extension load. The `@earendil-works/pi-*` packages and `typebox` stay external and resolve to the host pi's copies at runtime via its loader aliases. `pnpm build` produces the bundle; `prepare` builds automatically on install. The package manifest points at `./dist/index.js` and falls back to `index.ts` (slow path) when `dist/` is absent, so a fresh checkout still works pre-build.

### Fixed

- **Manual-mode pending files now contain full observation payloads.** ([#41](https://github.com/k0valik/pi-blackhole/pull/41)) The `noAutoCompact` → `compaction:'manual'` migration is completed: `isManualMode()` now checks both keys across all save/load gates, so manual-mode observations are written to the pending file (`savePendingObservation`) instead of falling through to `appendEntry()` (JSONL) — restoring crash-safe mid-run interruption recovery and `/blackhole flush` parity.
- **Config modal could overwrite the user's config with defaults.** `openSettings` did not pass `globalConfigDir` to the settings modal, so the modal initialized every field from the schema default (it read a nonexistent config in the extensions dir) instead of the actual config file. Saving then wrote those defaults over the real values (e.g. `compactAfterTokens` 185000 → 81000) while the runtime kept the correct values in memory — a confusing half-applied state. The modal now initializes from the real config file.
- **Number-field editing could get stuck.** While inline-editing a number field, typing/backspace/escape were swallowed by the step-cycling branch, leaving the modal in an editing state with no way out (Enter showed a cursor but nothing worked, and `ctrl+c` couldn't close it). All editing keys now flow through the inline editor, and `ctrl+c` closes the modal even mid-edit.
- **Typed input failed in Kitty terminals.** Kitty reports printable characters as CSI-u sequences (e.g. `5` arrives as `\x1b[53u`); they were rejected by the input filter — and after the first fix, inserted as raw escape bytes. The input filter and the insert path now decode them, so typing works in Kitty terminals.
- **Config save failures on read-only filesystems are now visible.** `ConfigManager.save()` throws when the write fails (e.g. config managed by Nix), and `/blackhole om-off`/`om-on` surface a warning — previously the failure was silently swallowed while the in-memory runtime state changed, diverging from disk without explanation.
- **`PI_BLACKHOLE_*` env overrides now apply at runtime.** The declarative env map (`memory`, `debug`, `compactAfterTokens`, …) was only honored by the modal path; the runtime config loader ignored it. The env map + application logic moved to a shared module used by both paths, so e.g. `PI_BLACKHOLE_COMPACT_AFTER_TOKENS=200000` now affects the actual compaction threshold, not just the modal display.

### Testing

- **Ported the upstream pi-base test suite (246 tests)** from `pi-utils/packages/pi-base` — config manager, settings modal (buffered mode, smoke, inline-edit, field validation) plus the 4 small modules (env, shell, types, ui) they cover. Only import-path adaptation was needed; zero semantic drift, which also confirms the vendored modal is behaviorally aligned with upstream.
- **New regression tests pin this release's fixes:** config-manager `globalConfigDir` forwarding, number-field inline editing (including a Kitty CSI-u integration case driving the full renderer path), Kitty decode, and runtime env overrides.
- **Tests no longer touch the system clipboard.** The memory-command tests ran the real `copyTextToClipboard` (spawning `wl-copy`/`xclip`/`xsel`) and overwrote the user's clipboard with fixture data; the module is now mocked and the mock's use is asserted so a regression fails the suite instead of mutating the clipboard.

### Dependencies

- **Bumped `@earendil-works/pi-*` devDependencies to `0.83.0`** (agent-core, ai, coding-agent, tui); the peer range stays `>=0.81.1 <1.0.0`. CI re-verifies typecheck + tests against the minimum supported `0.81.1` on every push/PR, so both the oldest and newest supported pi versions stay green.

### Packaging

- **Tolerant `prepare` build hook.** The `prepare` script is now a dependency-free `node scripts/prepare.mjs` that builds `dist/` only when the toolchain is present, and otherwise skips silently — it can never abort an install for git/checkout consumers running npm, pnpm, or bun in any devDependency configuration. Husky hooks install best-effort (dev checkouts only). Registry installs are unaffected (npm/pnpm/bun never run `prepare` on registry packages).
- **npm publishing now uses provenance.** The publish workflow runs `npm publish --provenance` (GitHub OIDC attestation), so every tarball carries a signed signature linking it to this repo + workflow — verifiable with `npm audit signatures` / `gh attestation verify`. The release gate now matches CI (build, typecheck, lint, test, format check).
- **Dev tooling.** Prettier (repo normalized once, enforced via lint-staged), husky pre-commit (lint+format staged files, then typecheck) and pre-push (typecheck + full test suite), ESLint extended to `tests/` and root configs, and CI now runs tests + format check alongside the build.

---

## [0.4.2] - 2026-07-27

### Changed

- **`midRunCompaction` default changed from `"resume"` to `"off"`.** ([#40](https://github.com/k0valik/pi-blackhole/issues/40), thanks @daoguademeng) `ctx.compact()` aborts the active agent operation before compacting, which is not lifecycle-safe at `turn_end` for subagent/background-work extensions: it propagates through the shared `AbortSignal` and cannot be distinguished from user cancellation. This affects both parent-side subagent workflows (active/queued children aborted, parent stalled) and child-side nested sessions (runner terminated, orphan transcript continues, `blackhole-resume` resumes a session the parent already sees as completed). `off` defers compaction to `agent_end`, which is the only currently safe boundary for extension-owned work. `resume` and `pause` are preserved as explicit opt-in for users without subagent workflows.

---

## [0.4.1] - 2026-07-24

### Added

- **Mid-run auto-compaction (`midRunCompaction`).** ([#38](https://github.com/k0valik/pi-blackhole/pull/38), thanks @daoguademeng) The threshold trigger previously only ran on `agent_end`, which never fires while the agent is looping through tool calls — during long runs `compactAfterTokens` could be exceeded many times over without a single evaluation, and the post-run wait was aborted by any new `agent_start`, deferring compaction indefinitely under continuous use. The threshold is now also evaluated at every `turn_end` (after each assistant message + tool executions). New config enum `midRunCompaction: "resume" | "pause" | "off"` (default `"resume"`): `resume` compacts at the threshold and injects a `blackhole-resume` message (`triggerTurn`) so the agent continues the task with the compacted context; `pause` compacts and hands control back; `off` restores the old end-of-run-only behavior. Available in `/blackhole configure`.
- **`/blackhole <text>` follow-up prompt.** After compaction, `/blackhole` optionally sends `<text>` as a follow-up message so the model continues the task without re-typing. Wrapped in `void Promise.resolve(...).catch(() => {})` for robust error handling.
- **Subcommand near-miss detection.** `/blackhole configure foo` now shows a warning instead of silently becoming a follow-up prompt.

- **`/blackhole cleanup` command for orphaned pending files.** Per-session pending files (`*-pending.json`, `*-pending.stale.json`) accumulate when compaction is manual and sessions are abandoned or deleted. The command scans the `pi-blackhole/` directory, cross-references session IDs against all session JSONL files, and provides an interactive TUI picker to safely remove orphaned files. Non-TUI modes (RPC/JSON/print) list orphaned files as a notification without deleting.

### Command formatting cleanup

- `/blackhole` and `/blackhole-memory` subcommands and modes now use `[bracketed]` syntax (e.g. `[om-on]`, `[hybrid]`) with shortened descriptions, making the command palette visually consistent and easier to scan.

### Notification & session goal reorg

- Session goal now derives from the first user message and is persisted at the top across compactions, with `(#N)` entry indexing for traceability.
- OM info notifications are gated to one per phase/turn — warnings and errors still fire immediately.
- Git commit extraction now handles tool_call, bash, and post-convert user-text formats.
- Cooldown skip messages now strip raw JSON from the reason for cleaner display, with a log pointer for debugging.

### Fixed

- **Mid-run compaction failure resilience.** ([#38](https://github.com/k0valik/pi-blackhole/pull/38), thanks @daoguademeng) If the before-compact hook cancels (or compaction errors) after `ctx.compact()` has already aborted the run, resume mode still re-triggers the agent so the task doesn't stall, and further mid-run attempts are suspended until a compaction lowers pressure below the threshold (prevents abort/cancel thrash loops).
- **Early-session reflection/drop starvation on first compaction.** Added `fullFoldAlways` config flag (default `true`). When no prior full-fold boundary exists, reflections and drops now use the observation boundary instead of being excluded. Previously, fresh sessions silently lost all durable memory on the first compaction because there was no full-fold history to anchor the maintenance boundary.
- **`capBrief` omission count now computed after `firstHeader` trim.** Previously the "N earlier lines omitted" header was computed before the section-header anchor trim, so the count was understated when headers caused additional trimming. This matched an upstream bug that was already fixed there.

- **Recall-note bloat across multiple compactions.** `compile()` now strips OM content first, then removes all recall-note paragraphs from the previous summary using paragraph-level matching (instead of only stripping a trailing exact match). After 3+ compactions, the summary no longer accumulates 3+ embedded copies of the recall note.

## [0.4.0] - 2026-07-24

### Added

- **`/blackhole cleanup` command for orphaned pending files.** Per-session pending files (`*-pending.json`, `*-pending.stale.json`) accumulate when compaction is manual and sessions are abandoned or deleted. Provides an interactive TUI picker to safely remove orphaned files. Non-TUI modes (RPC/JSON/print) list them without deleting.
- **`dropperPressureThreshold` in configure overlay.** Already in config schema but missing from `/blackhole configure` TUI. Now editable alongside other OM thresholds.
- **`fullFoldAlways` in TUI overlay.** Added to the configure overlay under Observational Memory section.
- **Session goal from first user message.** Persisted at the top across compactions with `(#N)` entry indexing for traceability.
- **OM info notifications gated to one per phase/turn.** Warnings and errors still fire immediately.
- **Git commit extraction expanded.** Now handles `tool_call`, `bash`, and post-convert user-text formats.
- **Cooldown skip messages strip raw JSON** from the reason for cleaner display, with a log pointer for debugging.
- **`/blackhole` and `/blackhole-memory` subcommands now use `[bracketed]` syntax** (e.g. `[om-on]`, `[hybrid]`) with shortened descriptions for visual consistency.

### Fixed

- **Early-session reflection/drop starvation on first compaction.** Added `fullFoldAlways` config flag (default `true`). When no prior full-fold boundary exists, reflections and drops use the observation boundary instead of being excluded.
- **Recall-note bloat across multiple compactions.** `compile()` strips OM content first, then removes all recall-note paragraphs using paragraph-level matching (instead of only stripping a trailing exact match).
- **OAuth/ADC-backed providers (Vertex, custom OAuth) now accepted by OM pipeline.** `resolveModel` uses `modelRegistry.hasConfiguredAuth()` instead of requiring a truthy `auth.apiKey`. Falls back to legacy behavior on older pi versions. ([#38](https://github.com/k0valik/pi-blackhole/issues/38))
- **`ResolveResult.apiKey` is always a string.** Defaults to `""` instead of casting `undefined`.
- **jiti provider bridge type-safe for pi 0.81.1+.** `pi.registerProvider` wrapper satisfies the overloaded signature in pi-coding-agent 0.81.1.
- **Config overlay blocks save on invalid JSON.** Red error banner and Ctrl+S block prevent wiping model configs on corrupt files. ([#35](https://github.com/k0valik/pi-blackhole/issues/35))
- **Config reloads after overlay save.** `Runtime.reloadConfig()` forces a fresh disk read after `/blackhole configure` saves. ([#36](https://github.com/k0valik/pi-blackhole/issues/36))
- **Invalid JSON warning surfaced via TUI.** Yellow warning notification shown at every config load point instead of only `console.warn`.
- **Defensive null guards for `b.args` and `ui.notify`.** Prevents crashes from stale extension context.
- **`streamSimple` import updated to `pi-ai/compat`.** Removed from main export in pi 0.80.3.
- **Legacy fallback config errors now passed to `onWarn` callback.** JSON parse errors in legacy fallback files (`pi-vcc-config.json`, `settings.json`, `.pi/settings.json`) are surfaced via the warning callback, not just `console.warn`.
- **`saveUnifiedConfig` warns before overwriting corrupt config.** If the config file has invalid JSON, a warning is logged before overwriting.
- **`dropperPressureThreshold` clamped to `[0.01, 1]` in overlay save.** Previously could silently lose value on reload.
- **`deleteOrphanedBatch` reports partial failures.** "Delete all" now shows `Deleted X/Y (Y-X failed)` when individual unlinks fail.
- 4 new tests for `fullFoldAlways` behavior in `buildCompactionProjection`: reflections survive first compaction when enabled, excluded when disabled, full-fold boundary still takes precedence, and post-boundary reflections remain excluded.
- 3 new tests for recall-note deduplication in `compile`: wrapped recall note stripped, OM content stripped before recall note, and three-cycle accumulation produces exactly one recall note.
- 5 new tests for follow-up prompt: extraction, subcommand exclusion, empty-args suppression, send after completion, compaction-failure suppression.
- 6 new tests for CompactionStats population: all fields populated, compactAll flag, totalUserTurns count, keptUserTurns count, compactAll zero kept, and format string coverage.
- 2 new tests for capBrief omission count: header-trimmed count is correct (99 for 200 lines with header at line 100), and no-header fallback still correct.

### Changed

- **New config key:** `fullFoldAlways` (boolean, default `true`). Added to `UnifiedConfig` schema, defaults, and config file parsing.
- **CompactionStats expanded from 3 to 11 fields.** Added `compactAll`, `totalUserTurns`, `keptUserTurns`, `requestedKeepUserTurns`, `keepUserTurnsExplicit`, `keepFallbackToCompactAll`, `smartKeepAdjusted`, `smartFromKeep`. All populated from `buildOwnCut` return data (Bug A fix).
- **Shared `formatCompactionStats` exported.** Both the `/blackhole` command handler and hook's `session_compact` handler now use a single shared formatter, eliminating the duplicate inline toast strings and the private `formatTokens` helper.
- **Dead ternary collapsed.** `effectiveTailBehavior` no longer has an `isPiVcc` branch with identical values on both sides (Bug B fix).
- **Dependencies: bumped `@earendil-works/pi-*` packages to `0.81.1`** (agent-core, ai, coding-agent, tui).
- **Removed 6 unused exports from `om/cleanup.ts`** (`scanPendingFiles`, `findSessionDirs`, `collectAllSessionIds`, `crossReference`, `formatSize`, `formatAge`).

### Tests

- 4 new tests for `fullFoldAlways` behavior in `buildCompactionProjection`.
- 3 new tests for recall-note deduplication in `compile`.
- 6 new tests for OAuth/ADC auth paths.
- Tightened capping assertions in robust tests.
- Added robust coverage for OM and CCC pipelines.

---

## [0.3.9] - 2026-06-24

### Auto-compaction idle race fix (#31, #33)

The auto-compaction trigger used to bail permanently when `ctx.isIdle()`
returned `false` at the first `setTimeout(0)` check after `agent_end`.
When another extension (e.g. pi-rewind) registered an async `agent_end`
handler whose I/O kept the agent state busy past the next macrotask,
the trigger logged `"bail: not_idle"` and never retried — auto-compaction
effectively never fired in this configuration.

**New behavior:** the trigger keeps `compactInFlight = true` and polls
`isIdle()` every 200ms (in 50ms slices) until the agent truly settles,
or one of two cancellation signals:

- `agent_start` fires — the user (or another extension) started a new
  turn. `AbortController.abort()` cancels the wait; the new turn's own
  `agent_end` will re-evaluate and start a fresh wait if still needed.
- Session change (e.g. `/resume`) — detected inside the wait loop.

Only the cell `compaction:auto + compactionEngine:blackhole` is affected.
All other config combinations (off, manual, pi-default) are unchanged.

### CI: fallow audit job

- Added `fallow-audit` CI job (PR only, changed-code audit with compact
  format, review comments, no SARIF)

### Test cleanup

- Removed stale `transcript-mode` tests left orphaned when the feature
  was deliberately dropped in v0.3.7 as redundant with hybrid search.

---

## [0.3.8] - 2026-06-19

### Pipeline progress cursors - fix re-run loop (#28, #29)

The pipeline previously coupled progress tracking to output markers: if a stage
produced empty output or errored, no marker was written, causing the stage to
re-process the same data on every `agent_start`/`turn_end` trigger. In real-world
logs the dropper ran 8,350× vs observer 1,124×, with zero drops selected.

- **Per-stage progress cursors** decouple progress from output. Each stage
  (observer, reflector, dropper) gets a cursor entry ID that advances whenever
  the stage runs - regardless of whether it produced output. "I looked and
  found nothing" is a valid answer that blocks re-processing.
- **Cursor `state` field** (`recorded` | `empty` | `error` | `skipped` | `not_due` | `initial`)
  distinguishes empty runs from skipped stages from actual output.
- **Reflector gates on new data.** If no new `OM_OBSERVATIONS_RECORDED` batches
  exist since the reflector cursor, and `reflectAfterTokens` threshold not met,
  skip entirely - no LLM call.
- **Dropper gates on pressure or new data.** Runs only when pool ≥ 10% fullness AND
  (new data exists OR pool ≥ `dropperPressureThreshold` × `reflectorInputMaxTokens`).
  Previously always returned `not_over_target` with 0 drops - now correctly skipped.
- **Cursor storage:** in-memory primary (zero-I/O gating), async flush to
  `{sessionId}-pending.json` for durability across restarts. Degrades gracefully
  on read-only filesystems.
- **Stale cursor recovery:** if a cursor's entry ID disappears (fork, navigation,
  compaction), falls back to coverage-marker logic for one run, then writes fresh cursors.

### New config key: `dropperPressureThreshold`

- Fraction of `reflectorInputMaxTokens` at which the dropper fires even without
  new data (pressure relief valve). Default `0.70` (70%). Set to `1.0` to disable
  pressure-driven dropper entirely.

### Debug log additions

- `observer.skip`, `reflector.start`, `reflector.skip`, `dropper.start`,
  `dropper.skip`, `cursor.loaded`, `cursor.saved`

### Deferred pipeline concerns (pre-merge review)

Audit surfaced 7 correctness/performance edge cases in the cursor pipeline.
Four were fixed; three were deferred as harmless or cosmetic.

**Fixed:**
- **Session fork cursor bleed (#2).** `cursorsLoaded` was a one-shot boolean
  — on session fork, stale cursors bled into the new branch because
  `validateCursors` was never re-invoked. Now keyed by `cursorsLoadedSessionId`
  so cursors are re-loaded and re-validated whenever the session ID changes.
- **Manual-mode pool fullness underestimation (#1).** `anyStageDue` had no
  visibility into pending observations in `compaction: "manual"` mode (branch
  has no OM markers). Reflector and dropper due checks now accept an optional
  `PendingOMState` so pending batches contribute to new-data scans and pool
  token counts. Prevents the pipeline from stalling after the first run in
  manual mode.
- **foldLedger on every agent_start/turn_end (#3).** `dropperDue` called
  `foldLedger` (O(n) on branch) unconditionally — even when the observer or
  reflector alone made the pipeline due. Now short-circuits: the fold is
  only computed when both observer and reflector are not due.
- **Observer cursor to non-source entry (#6).** When the observer skipped
  (not due), the cursor advanced to `entries.at(-1)` which could be a custom
  OM marker rather than a conversation source entry. Now advances to the
  last source entry (`findLast(isSourceEntry)`).

**Deferred:**
- **"unknown" magic entry ID (#4).** Functional but cosmetic — the sentinel
  triggers fallback on next load. 9 call sites; zero behavioral change.
- **Observer re-checks tokens (#5).** Harmless — only reached when pipeline
  launched for a different stage. Correctly advances cursor to `not_due`.
- **Dropper cursor fallback cascade (#7).** The 4-step `coversUpToId ??`
  `observationCoverageId ?? entries.at(-1)?.id` cascade is already reasonable
  fallback ordering.

### Tests

- 17 new tests for cursor gating, persistence, stale recovery, and debug log events
- 3 new tests for manual-mode pending awareness (reflector, dropper, post-first-run)
- `dropperPressureThreshold` added to config validation tests



# Changelog

## [0.3.7] - 2026-06-10

### Recall tool simplification (#27)

- Dropped `mode:transcript` — strict subset of `mode:hybrid` with no unique capability. (#27)
- Consolidated 5 scattered `promptGuidelines` into 2 focused entries; removed "NOT semantic" redundancy and JSONL implementation leak. (#27)
- Removed internal taxonomy from mode descriptions ("transcript + file indicators" → "all session content"). (#27)
- Added `mode:touched` support to `/blackhole-recall` command (previously only worked via agent tool). (#27)
- Collapsed drill-down examples to `#N:path with optional :offset:limit or :full`. (#27)

### Stale context crash protection (#26)

- Added `getErrorMessage()` to normalize cross-process error serialization (Error objects, plain objects with `message`, arbitrary thrown values). (#26)
- Added `isStaleExtensionContextError()` to detect stale-context error patterns. (#26)
- Added `notifySafely()` wrapper around `ui.notify()` calls to prevent stale-context notification errors from propagating. (#26)
- Wrapped `agent_end` handler, async compaction callbacks (`onComplete`, `onError`), and deferred timer callback to silently bail on stale-context errors. (#26)

### Lockstep sync — 2026-06-05 (#25)

- Ported [pi-observational-memory/58f05fa](https://github.com/elpapi42/pi-observational-memory/commit/58f05fa): remove `Math.min(100)` cap from `pct()` helper so overfull observation pool (>100%) is displayed accurately instead of silently capping at 100%. (#25)
- Skipped [pi-observational-memory/58f05fa](https://github.com/elpapi42/pi-observational-memory/commit/58f05fa) command renames (`/om-status`→`/om:status`, `/om-view`→`/om:view`) — our equivalent commands (`/blackhole-memory`) already use a different naming scheme. (#25)
- Deferred [pi-observational-memory/bf79ff7](https://github.com/elpapi42/pi-observational-memory/commit/bf79ff7) and [pi-observational-memory/52b5844](https://github.com/elpapi42/pi-observational-memory/commit/52b5844): pool metrics extraction + `budgetTokens`→`targetTokens` rename. Blocking branch (`noautocompact-reflector-dropper`) is now stale/dropped, but changes touch heavily diverged files. (#25)

## [0.3.5] - 2026-06-04

### Added

- **`sessionFallback` config option.** When `false`, skip the main session model as last-resort fallback when all OM-specific model candidates are exhausted. Default `true` for backward compatibility. Useful for keeping OM workers on cheaper/faster models. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))
- **Session-file LRU cache.** `loadAllMessages` now caches up to 3 session files with mtime + TTL (2s) invalidation. Reduces redundant I/O on repeated recall searches in the same session. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))
- **Pending state sanitization.** `readSessionState` now filters corrupted batch entries (missing `coversUpToId` or `data` fields) instead of returning them as-is. Prevents crashes from edge cases like a partial write to `pending.json`. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))
- **Shared `isRetryableError` / `RETRYABLE_ERROR_RE`.** Extracted from `cooldown.ts` and `compaction-trigger.ts` into `retryable-error.ts` — single source of truth, re-exports Pi's `isContextOverflow` for provider-specific overflow detection. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))
- **Shared provider-stream bridge.** `createBridgeStreamFn` extracted from all three OM agents (observer, reflector, dropper) into `provider-stream.ts`. Custom providers registered by other extensions (e.g., claude-bridge) continue working through jiti-loaded consolidation agents. ([#21](https://github.com/k0valik/pi-blackhole/pull/21))
- **Async buffered debug logging.** `debugLog()` now buffers JSONL writes in memory and flushes on a 1-second background timer, with synchronous flush on `exit`. Reduces event-loop blocking during high-frequency debug events. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))
- **Windows path support in file extraction.** `longestCommonDirPrefix` normalizes backslashes and recognizes `C:\`-style drive letters. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))

### Fixed

- **Context window check uses actual input size, not configured cap.** Observer/reflector/dropper now compute `observerEstimatedInput` from the actual chunk tokens after capping, not from `observerChunkMaxTokens`. More accurate — fewer false "context window exceeded" rejections on smaller-than-cap inputs. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))
- **`coversUpToId` now points past capping, not before.** Observer stage captured the last entry ID before capping source entries to `maxChunkTokens`, so the coverage marker could point to an entry that was dropped. Now captured after capping. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))
- **`capSourceEntriesToTokens` counts all entry types.** Previously only `"message"` entries counted toward the token budget — custom OM entries (`observations_recorded`, `reflections_recorded`, etc.) and summary-bearing entries were invisible, risking context overflow in the observer. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))
- **Reflector/dropper avoid redundant disk reads.** Both stages now use the outer-scope `pending` variable (already read in the `noAutoCompact` block) instead of calling `readPendingState(sessionId)` again inside the for loop. Neutral correctness win. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))
- **Observer rejects invalid observation IDs gracefully.** `normalizeSourceEntryIds` now filters out unknown/duplicate IDs instead of returning `undefined` and discarding the entire observation batch. One hallucinated ID from the LLM no longer loses valid observations. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))
- **`pendingObservationsCreatedAfter` properly typed.** Changed from `pending: any` to `pending: PendingOMState` — catches type mismatches at compile time. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))
- **Section headers in summaries use line-boundary regex.** `sectionOf` and `stripOMContent` now match `## Reflections` / `## Observations` at the start of a line instead of using bare `indexOf`. Prevents false positives when those phrases appear inside file paths or conversation text. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))
- **Read+same-path-Modified dedup in file summaries.** `mergeFileLines` now removes a path from `Read` if it also appears in `Modified` — a file that was read then edited shouldn't show twice. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))
- **`reverse-recall` outputs related reflections.** The `_reflections` dead parameter is now used — related reflections are shown alongside observations when expanding session entries. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))
- **Cooldown reason in UI notification.** The `getCooldownEntry` function now returns the actual entry (with reason), so the status notification shows *why* a model was cooled down, not just "cooldown active". ([#20](https://github.com/k0valik/pi-blackhole/pull/20))
- **Env override validation.** Invalid `PI_BLACKHOLE_COMPACTION` / `PI_BLACKHOLE_COMPACTION_ENGINE` values now print a warning instead of being silently ignored. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))
- **`observerPreambleMaxTokens` accepts 0.** Now uses `nonNegativeInt` validator instead of `positiveInt` — 0 means "auto-compute", which was the intended semantics. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))

### Changed

- **Replaced hand-rolled text wrapping with `wrapTextWithAnsi` from pi-tui.** The custom `wrapLine` function was replaced with `wrapLineWithContinuation` using pi-tui's ANSI-aware wrapping. Handles list continuation indentation and ANSI mid-sequence splits correctly. ([#21](https://github.com/k0valik/pi-blackhole/pull/21))
- **`visibleWidth` re-exported from pi-tui.** The local CJK-width implementation in `key-matcher.ts` was replaced with a re-export from `@earendil-works/pi-tui`. Fallback note retained if the import fails in overlay context. ([#21](https://github.com/k0valik/pi-blackhole/pull/21))
- **Bash command compression improved.** Multi-line commands joined with semicolons instead of first-line-only. Pipe tails strip `awk`/`python3`/`node`/`bun` excluded (their output carries semantic meaning). Word-boundary truncation instead of mid-word cut. Up to 10 tail-strip iterations with stability guard. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))
- **`fuzzyMatch` → `prefixMatch`.** The `/blackhole` subcommand filter changed from fuzzy/subsequence matching to simple prefix matching. Predictable narrowing: typing "om" matches "om-on" and "om-off". ([#21](https://github.com/k0valik/pi-blackhole/pull/21))
- **`read` tool summary field corrected.** `TOOL_SUMMARY_FIELDS` now maps lowercase `read` → `"path"` (not `"file_path"`), matching the actual tool argument. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))
- **Tool error blank-line suppression.** `stringifyBrief` now suppresses blank lines between consecutive tool/error summaries (previously only between consecutive tool summaries). ([#20](https://github.com/k0valik/pi-blackhole/pull/20))
- **Recall header distinguishes matches vs expands.** The search result header now shows `"X matches (+ Y expanded)"` when entries were pulled in via `#N` expand rather than matching the query. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))
- **Compaction output instructions split into full/basic variants.** `CONTEXT_USAGE_INSTRUCTIONS` shortened to 4 lines (previously 10). When observations/reflections are present, the full version includes the bracketed-ids preamble + recall footer. When none exist (or OM is off), a basic 2-line recall-guidance footer is appended instead. `renderSummary` always returns a footer, and `stripOMContent` handles both variants to prevent compounding. ([#23](https://github.com/k0valik/pi-blackhole/pull/23))

### Removed

- **Dead `loadSettings()` / `PiVccSettings`.** Config loading unified in `unified-config.ts` — the `settings.ts` wrapper had zero callers. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))
- **Dead `transcriptEntries` from `SectionData`.** Removed from `sections.ts` and `build-sections.ts`. (dead since v0.3.3) ([#20](https://github.com/k0valik/pi-blackhole/pull/20))
- **Dead toggle helpers.** `toggleCompaction`, `toggleCompactionEngine`, `toggleTailBehavior` removed from `unified-config.ts` (zero callers — toggling is handled by the configure overlay). ([#20](https://github.com/k0valik/pi-blackhole/pull/20))
- **Dead `vcc-report.test.ts`.** Test file was testing a non-existent `src/core/report.js` module. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))
- **Dead `config-simplification.test.ts`.** Tested old config migration that's been stable since v0.3.3. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))

### Docs

- **Renamed example configs.** `example-config-v2.json` → canonical `example-config.json` (new config surface). Old `example-config.json` → `example-config-old.json` (legacy keys). ([#21](https://github.com/k0valik/pi-blackhole/pull/21))
- **README: updated "What the agent sees" example** to match actual output ordering and expanded RECALL_NOTE text. ([#21](https://github.com/k0valik/pi-blackhole/pull/21))
- **README: added `sessionFallback` to settings table.** ([#20](https://github.com/k0valik/pi-blackhole/pull/20))
- **example-config.json: added `sessionFallback` field.** ([#20](https://github.com/k0valik/pi-blackhole/pull/20))
- **README: updated "What the agent sees" example** to match the new shorter CONTEXT_USAGE_INSTRUCTIONS text and note about basic footer when OM is off. ([#23](https://github.com/k0valik/pi-blackhole/pull/23))

## [0.3.4] - 2026-06-02

### Added

- **`cooldownHours: 0` disables cooldown without disk writes.** Previously `cooldownHours: 0` was rejected by the positive-int validator and silently replaced with a 1-hour cooldown. Now 0 is a valid value that disables cooldown entirely — no disk writes, no persistent state. Failed models are tracked in-memory within each consolidation stage (via `failedInCycle` set) so the fallback chain still advances past them. ([#16](https://github.com/k0valik/pi-blackhole/issues/16), [#18](https://github.com/k0valik/pi-blackhole/pull/18))
- **Kitty CSI-u keyboard protocol support for overlays.** The configure and status overlays use pi-tui's `matchesKey` (which handles both legacy terminal sequences and Kitty's CSI-u protocol) instead of the homegrown `matchKey`. Digit input uses `decodeKittyPrintable` to decode CSI-u encoded characters. ([#17](https://github.com/k0valik/pi-blackhole/issues/17), [#19](https://github.com/k0valik/pi-blackhole/pull/19))
- **Per-stage failure notification isolation.** When cooldown is disabled, each consolidation stage (observer, reflector, dropper) now shows its own failure notification — observer failure no longer suppresses reflector/dropper notifications. ([#19](https://github.com/k0valik/pi-blackhole/pull/19))

### Fixed

- **Keyboard freeze in `/blackhole configure` on Kitty terminal.** The homegrown `matchKey` function did not recognize Kitty's CSI-u keyboard protocol sequences (used by Kitty, WezTerm, and other modern terminals). Switched to pi-tui's `matchesKey` which supports both legacy and CSI-u input. ([#17](https://github.com/k0valik/pi-blackhole/issues/17), [#19](https://github.com/k0valik/pi-blackhole/pull/19))
- **Config error notifications no longer downgraded to info.** When a session model has no API key configured, the notification correctly shows a "warning" level message instead of the misleading "info" message previously shown when `failedInCycle` was non-empty. ([#16](https://github.com/k0valik/pi-blackhole/issues/16), [#18](https://github.com/k0valik/pi-blackhole/pull/18))

### Changed

- **Removed `key-matcher.ts` `matchKey` export** (replaced by pi-tui's `matchesKey`). The `visibleWidth` export is retained.

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
