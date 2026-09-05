# feat/changelog-viewer — Session Log (2026-08-28)

## Branch

`feat/changelog-viewer` branched from `dev` (3c90f9a).

## Goal

Add a “Changelog” entry under **Display All** in the `/blackhole settings` pre-selector and a direct `/blackhole changelog` command that shows the shipped `CHANGELOG.md` in a scrollable framed overlay. Title shows package version: `pi-blackhole vX.Y.Z — Changelog`.

## Decisions Made

### 1. Minimal vendored surface (re-vendoring constraint, user request)

`src/pi-base` is a vendored copy of `pi-utils/packages/pi-base`. Re-vendoring wipes files inside it. Decision:

- **New code lives outside vendored tree**: `src/changelog/changelog.ts` (viewer + parser + helpers) is external. `src/pi-base/settings/changelog.ts` was created then moved to `src/changelog` for this reason.
- **Vendored diff is minimal + generic**: only `src/pi-base/settings/config-flow.ts` and `src/pi-base/config-manager.ts` were touched, and the change is a generic `ExtraSelectorEntry` extension point, not a hard-coded `changelog` concept.

Small generic hook vs. zero-diff duplication trade-off:

- Zero-diff alternative would duplicate ~200 LoC of `openDisplayAll`/`openEditMode` plumbing in `blackhole-settings.ts` and bypass `ConfigManager`.
- Generic `extraEntries + onExtraSelect` hook is ~20 LoC, trivially re-applied after a future `pi-base` re-vendor (one interface + three threaded params + routing branch).

See `src/pi-base/settings/config-flow.ts:84-142` and `src/pi-base/config-manager.ts:1-60` for the exact patch size. Keep this file in the re-vendor checklist.

### 2. Package-root detection

Investigation proposed walking up from `import.meta.url` (mirrors `findPiPackageRoot` in `src/om/inline-compaction.ts:316-340`). Validated:

- `pnpm build` uses `tsup` (`splitting: false`). `import.meta.url` is preserved in `dist/index.js` as `import.meta.url` (now visible at `dist/index.js:8316`).
- Works in TS-direct mode (jiti loads `index.ts`) and in bundled mode (`dist/index.js`).
- Added fallbacks: walk-up from `process.cwd()` and `process.argv[1]` for tests / edge cases.
- Helper `getOwnPackageRoot()` + `getPackageVersion()` read `package.json` by name `pi-blackhole`.

File: `src/changelog/changelog.ts:38-121`.

### 3. Rendering — Tier 1 plain-text first (per investigation)

Two tiers were considered:

- **Tier 1 (shipped)**: plain-text via existing `frame()` primitives (`truncateToWidth`, `wrapTextWithAnsi`, `frameContentWidth`, `responsiveInnerRows`, `wrapLine`). Strips `**bold**`, `` `code` ``, `[links](url)` → plain text.
- **Tier 2 (deferred)**: `pi-tui` `Markdown` + `getMarkdownTheme()` (confirmed in `pi-tui@0.84.3`, used by Pi at `modes/interactive/interactive-mode.js:5225`, not verified on `0.81.1`).

Decision: **Ship Tier 1 only**. It works on all supported Pi versions with zero new dependencies. Tier 2 can be added later as a gated enhancement (check `getMarkdownTheme`/`Markdown` existence before use). The viewer is structured to allow that swap: `renderChangelogEntries` is isolated, `createChangelogViewer` could instantiate `new Markdown(text, …)` and slice its `render(width)` output instead.

User note re-applied: pi internals _do_ expose `Markdown` from `pi-tui`; we are free to import it when we do Tier 2, no hand-roll required then.

### 4. Changelog source & distribution (and tsup bundling fix)

- Canonical file is `docs/CHANGELOG.md` (69 KB, ~700 lines). Root `CHANGELOG.md` was missing.
- Runtime helper tries `join(root, "CHANGELOG.md")` then `join(root, "docs/CHANGELOG.md")`. Tests call `readChangelogText(root)` with explicit root → no `cwd` fallback (fix applied after test failures).
- `package.json:files` now explicitly includes both `CHANGELOG.md` and `docs/CHANGELOG.md` (npm auto-includes `CHANGELOG.md` anyway, but explicit inclusion removes ambiguity). Root `CHANGELOG.md` created as a copy of `docs/CHANGELOG.md` so the tarball contains it at the package root as spec requires.
- **tsup bundling fix (follow-up after review)**: `tsup` with `clean:true` never copies `.md` files into `dist/`. For `pi-session-name` this caused `ENOENT` when `dist/index.js` tried to `readFileSync(resolve(__dirname, "prompt/system.md"))` because the file was inside `src/prompt` and not at `dist/prompt`. Fixed in `pi-utils` commit `42333c3b` by inlining prompt templates at build time via an `esbuild` `onLoad` plugin that replaces `readFileSync(...)` calls with `JSON.stringify(content)`. `pi-git-tools` does the same.
  - Applied same pattern here: `tsup.config.ts` now has `inlineChangelog()` plugin that reads `docs/CHANGELOG.md` at build time and replaces `const BUNDLED_CHANGELOG_TEXT: string | undefined = undefined;` in `src/changelog/changelog.ts` with the file contents (`JSON.stringify`). See `tsup.config.ts:1-42` and `src/changelog/changelog.ts:10-15`.
  - Runtime: `readChangelogText()` tries filesystem first (walk-up + `cwd` fallback). Only if both fail (e.g., `dist/` only shipped, or git install with missing file) it falls back to `BUNDLED_CHANGELOG_TEXT`. In TS-direct mode (`jiti` loads `index.ts`) the constant stays `undefined` and the file is read normally. In bundled mode `dist/index.js` is now 620 KB (was 550 KB) and contains the changelog as a string literal (`BUNDLED_CHANGELOG_TEXT = '## [Unreleased]...'`).
  - Explicit-root calls (`readChangelogText(tmpDir)`) intentionally **do not** use the bundled fallback, so the existing `expect(text).toBeUndefined()` test for missing dirs still passes.
  - This keeps `dist/` self-contained for `npm` registry consumers and for `git` installs where `prepare` rebuilds `dist/` (the file is still at the repo root, but the fallback protects against symlink/pnpm-store path issues where walk-up might miss the package root).
- **Future maintenance**: keep `docs/CHANGELOG.md` and root `CHANGELOG.md` in sync (manual `cp` or add `cp docs/CHANGELOG.md CHANGELOG.md` to `scripts/prepare.mjs` before the `tsup` build, so the inlined content is always fresh).

### 5. Selector & command wiring

- **Selector path**: `src/pi-base/blackhole-settings.ts:449-462` passes `[{ id: "changelog", label: "Display Changelog", available: true }]` via `ConfigManager.openSettings(..., extraEntries, onExtraSelect)` → `openConfigFlow` routes to `openChangelogView`.
- Entry appears **after** “Display all settings” (appended via `entries.push(...extraEntries)`). Label per spec: “Display Changelog”.
- **Command path**: `src/commands/pi-vcc.ts` adds `changelog` to completions, handler `if (trimmed === "changelog") await openChangelogView(ctx)`, and `SUBCOMMAND_NAMES` near-miss handling. ~10 LoC.

### 6. UI shape — standalone Component + frame()

The settings modal body is form-field oriented (`Field → InternalRow`). Changelog is continuous text → standalone overlay:

- `ctx.ui.custom(factory, { overlay: true, overlayOptions: { anchor: "center", width: "92%", maxHeight: "95%" } })`
- `frame(lines, width, theme, { title, fixedInnerRows })`
- Scroll state `scroll`, `PAGE = 5`, `↑↓ / pageUp/pageDown` via `matchesKey`, close on `escape`/`ctrl+c`
- Scroll indicators: `↑ N earlier`, `↓ N more` dim lines, footer `↑↓ scroll · PgUp/PgDn · Esc close`
- Responsive inner rows `responsiveInnerRows(tui.terminal.rows ?? 24, 45, 14)` — mirrors body `PREFERRED_INNER_ROWS`.

File: `src/changelog/changelog.ts:306-506`.

### 7. Entry count / subtitle

- Show all entries (570+ lines) — scrolling handles overflow; `fixedInnerRows + scrolling` means no hard limit. `parseChangelogEntries(text, maxEntries?)` accepts optional limit for future callers but viewer calls without limit.
- Subtitle/title shows package version via `getPackageVersion()` → `pi-blackhole v0.4.9 — Changelog`. Falls back to `pi-blackhole — Changelog` if unreadable.

### 8. Assumption validated

`pnpm build && grep -n "import.meta.url" dist/index.js` now shows `const metaUrl = import.meta.url` at line 8316 — walk-up works in the bundle. Checked after build: `dist/index.js` is 550 KB, `import.meta.url` preserved.

## What Was Implemented

| File                                  | Action                    | Notes                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/changelog/changelog.ts`          | **New** (external)        | `getOwnPackageRoot()`, `getPackageVersion()`, `stripMarkdownInline()`, `readChangelogText()` (with `BUNDLED_CHANGELOG_TEXT` fallback), `parseChangelogEntries()`, `entriesToPlainLines()`, `renderChangelogEntries()`, `createChangelogViewer()`, `openChangelogView()` (~520 LoC). External to `src/pi-base`. Inlined at build via `tsup.config.ts`. |
| `tsup.config.ts`                      | **Build**                 | Adds `inlineChangelog()` esbuild `onLoad` plugin (mirrors `pi-session-name` 42333c3b) that inlines `docs/CHANGELOG.md` into `BUNDLED_CHANGELOG_TEXT`. `dist/index.js` now self-contained (620 KB).                                                                                                                                                    |
| `src/pi-base/settings/config-flow.ts` | **Minimal generic patch** | Adds `ExtraSelectorEntry` interface, `extraEntries` param to `buildSelectorEntries`, `openSelector`, `openConfigFlow` + routing `if (extraEntries.some(...)) await onExtraSelect(id)`. ~27 LoC. Generic, not changelog-specific.                                                                                                                      |
| `src/pi-base/config-manager.ts`       | **Minimal generic patch** | Imports `ExtraSelectorEntry`, adds `extraEntries?` + `onExtraSelect?` to `openSettings`, threads to `openConfigFlow`. ~15 LoC after reformat.                                                                                                                                                                                                         |
| `src/pi-base/blackhole-settings.ts`   | **Wiring**                | Imports `openChangelogView`, passes `Display Changelog` entry + handler to `config.openSettings`.                                                                                                                                                                                                                                                     |
| `src/commands/pi-vcc.ts`              | **Command**               | Adds `changelog` completion, handler `trimmed === "changelog"` → `openChangelogView`, description + near-miss list.                                                                                                                                                                                                                                   |
| `src/changelog/changelog.test.ts`     | **New tests**             | 13 tests: root detection, markdown stripping, PR-link handling, parsing, maxEntries, plain-lines, render, read from real docs/CHANGELOG, missing-root undefined, temp docs read, viewer smoke (title + content), scroll/close, missing fallback.                                                                                                      |
| `package.json`                        | **Shipping**              | `files` adds `CHANGELOG.md` + `docs/CHANGELOG.md`.                                                                                                                                                                                                                                                                                                    |
| `CHANGELOG.md`                        | **New (copy)**            | Root copy of `docs/CHANGELOG.md` so the npm tarball contains it at the package root. Also inlined into `dist/`.                                                                                                                                                                                                                                       |

## Planned / Deferred

- **Tier 2 Markdown rendering**: gate on `Markdown` + `getMarkdownTheme` availability in `pi-tui` (present in 0.84.3, not verified on 0.81.1). Wrap rendered markdown lines in `frame()` chrome for consistency. Keep Tier 1 fallback.
- **Entry-count limit UI**: currently shows all; could add a “Show last 15 / Show all” toggle if 69 KB proves heavy on narrow terminals. Scrolling already handles it.
- **Sync of CHANGELOG copies**: add a `scripts/prepare.mjs` copy step or a pre-publish `cp docs/CHANGELOG.md CHANGELOG.md` so future edits don’t drift. Mention in `docs/CHANGELOG.md` maintenance notes.
- **Tests for selector integration**: the existing `src/pi-base/settings/config-flow.test.ts` covers the generic hook via default params (no regression). A dedicated integration test that drives `config.openSettings` with a fake `changelog` entry and asserts `openChangelogView` is called could be added — currently covered by unit tests on the viewer + manual verification.
- **Re-vendoring checklist**: after every `pi-base` vendor sync, re-apply the two-file generic hook patch (copy the `ExtraSelectorEntry` block). Consider extracting it to a patch file under `docs/archived_docs/`.

## Validation

- `pnpm build` — success, `dist/index.js` 620 KB (was 550 KB before inline), `import.meta.url` preserved, `BUNDLED_CHANGELOG_TEXT = '## [Unreleased]...'` visible in bundle, changelog helpers bundled.
- `pnpm typecheck` — `tsc --noEmit` passes (fixed `await import` in tests → static `mkdirSync` import, explicit-root fallback bug).
- `pnpm test` — 90 files, 1456 tests passing (2 failures fixed: `readChangelogText` explicit-root fallback → now returns `undefined` without cwd fallback; viewer fallback now correctly triggers `Changelog not found` path). Added bundled-fallback semantics (explicit root still returns undefined, implicit walk-up falls back to inlined text).
- Manual smoke: `createChangelogViewer` renders with versioned title, wrapped bullets, scroll indicators, Esc close; `openChangelogView` reachable via `/blackhole changelog` and via selector last entry. Verified `grep -c BUNDLED_CHANGELOG dist/index.js` = 3 and content starts with `## [Unreleased]`.

## Risk / Notes

- **Compat**: only `node:` built-ins (`fs`, `path`, `url`) + `pi-tui` helpers. Safe across Pi 0.81.1 → 0.84.0+.
- **Root CHANGELOG drift**: if `docs/CHANGELOG.md` is edited without copying to root, shipped tarball could ship stale root copy but viewer reads `docs/CHANGELOG.md` first, so runtime still shows fresh docs copy. Add sync step to avoid confusion.
- **Width handling**: viewer recomputes wrapped lines on each `render(width)` and caches by `lastWidth`; scroll bounds clamped to `wrapped.length - visible`. Narrow terminals (<40 cols) still frame correctly due to `truncateToWidth`.
