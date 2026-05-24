# Changelog

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
