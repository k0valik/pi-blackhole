# AGENTS.md

Pi extension package: algorithmic session compaction for a coding agent, merging two upstream packages (pi-vcc) + (pi-observational-memory) with heavy divergence on both.

## Commands

```bash
pnpm test          # vitest run (all tests, ~89 files, no network)
pnpm typecheck     # tsc --noEmit (src/**/*.ts + index.ts only)
pnpm lint          # oxlint .
pnpm format:check  # oxfmt --check .
pnpm build         # tsup bundle → dist/ (gitignored; pi loads dist/index.js)
pnpm check         # typecheck + lint
```

- CI order: `build` → `typecheck` → `lint` → `test` → `format:check` (.github/workflows/ci.yml).
- pre-commit: lint-staged (now in `package.json:lint-staged`) + typecheck. pre-push: typecheck + test.
- pnpm only (`packageManager: pnpm@11.2.2`). TypeScript pinned to 6.0.3 for @typescript-eslint v8 compat — never bump TS alone.
- `oxfmt` config and `lint-staged` live in `package.json`; `.oxfmtignore` stays at root.
- Prepare script (`scripts/prepare.mjs`) builds dist via tsup on install; must never break consumer installs. It warns (never fails) when tsup is absent and `dist/index.js` is missing, which is the git install without `npmCommand` case.

## Testing quirks

- Source imports use `.js` extensions (`../om/tokens.js`); vitest's alias strips them. Keep this convention in new files.
- **`tests/` is NOT in tsconfig.json** — running tsc over tests surfaces ~150 pre-existing type errors tracked as a separate cleanup. Do not "fix" test type errors; oxlint covers unused vars there.
- `src/pi-base/**/*.test.ts` is excluded from tsconfig and type-aware lint by design.
- Tests are pure unit tests with fake agent loops — no LLM/network. `tests/vcc-support/real-sessions.ts` optionally samples `~/.pi/agent/sessions`, but nothing requires real data.

## Architecture

- `index.ts` is the real factory; `pi.extensions` points at the built `dist/index.js` (gitignored). Git installs that skip devDependencies (`npm install --omit=dev` with no `npmCommand` set) cannot build dist, so `scripts/prepare.mjs` warns and the extension will not load until `npmCommand` is set. The factory installs the host inline-compaction adapter, captures provider streams, registers consolidation + compaction triggers, `session_before_compact` + `session_compact_failed` + `context` hooks, commands, and the unified `recall` tool.
- `src/core/` — unified config (`unified-config.ts` = defaults + resolution; env overrides declared in `config-env.ts` as `PI_BLACKHOLE_*`). configManager is the true source and entry point - users edit in UI.
- `src/extract/` — vcc compaction section extraction (goals, files, commits, preferences, brief).
- `src/om/` — observational memory: `agents/` (observer → reflector → dropper agent loops), `ledger/`, `runtime.ts`, `consolidation.ts`, `compaction-trigger.ts`, `cooldown.ts` (persisted fallback cooldowns), `pending.ts` (manual-mode disk buffers), `inline-compaction.ts`.
- `src/project-recall/` — project-scoped memory: `corpus.ts` (project session scan + pending orphan attribution), `dedup.ts`, `format-export.ts`, `session-dir.ts`.
- `src/hooks/` — `before-compact.ts` (`session_before_compact`), `compact-failed.ts` (`session_compact_failed` pi >=0.84.3), `compaction-context.ts` (`context` append-mode projection).
- `src/commands/` — `pi-vcc.ts` (`/blackhole`), `memory.ts` (`/blackhole-memory`), `vcc-recall.ts` (`/blackhole-recall`), `blackhole-export.ts` (`/blackhole-export`), `cleanup.ts`.
- `src/tools/recall.ts` — session-history search/expand/drill-down.
- `src/pi-base/` — **vendored copy** (config manager + settings modal). Treat as upstream code: surgical rewiring and minimal fixes only if it causes runtime failures.
- `docs/` — committed product docs: `architecture.md`, `observational-memory.md`, `recall.md`, `vcc-compaction.md`, `APPEND_COMPACTION.md`.
- `work_docs/` — separate planning docs.

## Workflow conventions

- Working branch is `dev`; `main` is the npm-published release branch.
- Conventional commits (`feat:`, `fix:`, `chore(release):`, `build(deps-dev):` with scopes like `(pi-base)`, `(recall)`, `(export)`).
- CHANGELOG.md should be kept up to date on substantial changes (keepachangelog style). `## [Unreleased]` on `dev` becomes `## [X.Y.Z] - YYYY-MM-DD` on release.
- Docs consistency: every number in README.md / docs/CONFIG.md / llms.txt must match `src/core/unified-config.ts` defaults — cross-check when changing defaults. `docs/` mirrors the same source of truth.

## Debugging / runtime

- `debug: true` → pre-compaction snapshot at `/tmp/pi-blackhole-debug.json`; `debugLog: true` → JSONL at `~/.pi/agent/pi-blackhole/debug.ndjson`.
- Config lives at `~/.pi/agent/pi-blackhole/pi-blackhole-config.json`; cooldowns at `pi-blackhole-cooldown.json`.

## Testing

- **T1. Prove a new test can fail — while writing it, never after.** The red run comes from writing the test first against untouched code: test → red → implement → green, in that order. This applies to fixes you author in this session too (including review follow-ups): land the test before the fix, not the other way round. Never reconstruct a "pre-fix" state to demonstrate redness — no reverting, stashing, `git checkout`, or patching out changes, especially not your own uncommitted work; that destroys the change to re-verify it. For a change whose red run you didn't witness (pre-existing fix, someone else's work), run the test green and confirm its assertions target the changed path instead. If a test can't fail, it isn't testing anything.
- **T2. Arm every precondition the branch needs.** If the code path depends on prior state (a flag, a prior call, session data), set that state explicitly in the test. Don't assume execution reaches the new guard by default, check what runs before it.
- **T3. Cover every branch, not just the happy path.** Each conditional (if/else, fallback, empty vs populated input) needs its own test case. A theme-present case and a theme-absent case are two tests, not one.
- **T4. Assert the specific thing that would break, not a generic proxy.** A broad negative check, like asserting a substring is absent from the whole output, passes even when an unrelated change happens to introduce that same substring elsewhere. Assert against a stable, unique token or the actual structure.
- **T5. One behavior per test case.** If one assertion in a block throws, every assertion after it silently stops running and its coverage disappears from the failure report. Split sequential checks into separate test cases.
- **T6. Clean up in a finally block or an after-hook, never inline after assertions.** If an assertion throws before cleanup runs, tmp files, mocks, or state leak into the next test run.
- **T7. Don't bypass type or null safety checks to make a test compile.** Non-null assertions, unsafe casts, and untyped escapes (`any` or equivalent) silence the same runtime uncertainty the code under test is supposed to handle. Type the value the way production does and narrow it explicitly.
- **T8. Match mocks to real output shape.** If the real dependency wraps, escapes, or transforms its return value, the mock has to do the same. A stripped-down mock can make a test pass by exercising a code path that never runs in production.
