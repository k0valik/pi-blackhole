---
name: ci-pkg
description: CI workflows, package management, supply chain hardening, and dependency tooling for pi-blackhole. Use when the user says "CI", "package", "dependency", "supply chain", "eslint", "husky", "lockfile", "pnpm", or "hardening".
---

# CI & Package Maintenance — pi-blackhole

## ⚠️ Golden rule

**Nothing gets committed or pushed to `main` without explicit user approval.** Always stage, show the diff, and wait for a "yes" before committing. Never push unapproved changes.

## CI workflows

Two workflows in `.github/workflows/`:

| File | Triggers | Steps |
|---|---|---|
| `ci.yml` | Push to `main`, PRs targeting `main` | `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm lint` |
| `publish.yml` | Tag push `v*` | Same checks + `npm publish` |

Both use `--frozen-lockfile` — if `package.json` and `pnpm-lock.yaml` are out of sync, CI fails.

## TypeScript hardening (`tsconfig.json`)

Beyond `"strict": true`:

```
noImplicitReturns: true    // every code path must return
noUnusedLocals: true       // no dead variables
noUnusedParameters: true   // no dead parameters
```

`include` only covers `src/**/*.ts` and `index.ts` — tests are excluded because they have pre-existing type errors (vitest runs them fine without tsc).

## ESLint (CI-only)

Type-aware rules in `eslint.config.mjs` — NOT run locally, only in CI:

- `@typescript-eslint/no-floating-promises` — unhandled async rejections
- `@typescript-eslint/no-misused-promises` — Promise used as boolean, etc.
- `@typescript-eslint/restrict-template-expressions` — objects/symbols in templates
- `no-unused-vars` — delegated to tsconfig's `noUnusedLocals`

ESLint runs on `src/` only. Config is flat-format (ESM), so the file is `.mjs`.

## Pre-commit hook (husky + lint-staged)

`.husky/pre-commit` runs `pnpm check` on every commit. If `tsc --noEmit` fails, the commit is blocked.

Husky v9+ is used — hooks live in `.husky/` directory. They do NOT auto-install on `pnpm install`; you need `npx husky init` to activate.

## No hardcoded local paths (monorepo-safe)

**Never commit absolute paths** (`/home/...`, `/Users/...`, `C:\...`). Every config and script must work for:
- Anyone cloning the repo from git
- CI runners (ephemeral GitHub Actions environments)
- Different OSes (Linux, macOS, Windows)

### Binding rules

- All dependency resolution goes through `pnpm-lock.yaml` — the lockfile is the single source of truth
- Never alias packages to a global pnpm store path (it's machine-specific and version-fragile)
- If a package can't be resolved locally, add it to `devDependencies` or `dependencies` so `pnpm install` handles it
- Test configs (`vitest.config.ts`, etc.) must not reference user home directories or global store paths
- The published npm package must be portable — config files that don't ship (`tsconfig.json`, `eslint.config.mjs`) are fine as long as they don't embed local paths

### What was fixed

`vitest.config.ts` previously hardcoded `@earendil-works/*` package paths from the global pnpm store. This was replaced with standard devDependency resolution — the packages are installed locally via `pnpm install` and resolved naturally by vitest.

## Supply chain protection

| Layer | Mechanism |
|---|---|
| Lockfile | `pnpm-lock.yaml` pins every transitive dependency to exact versions with integrity hashes |
| Frozen install | CI uses `--frozen-lockfile` — fails if lockfile drifts from `package.json` |
| Pinned versions | All `devDependencies` in `package.json` use exact versions (no `^` ranges) |
| Package manager | `pnpm` — content-addressable store, strict dependency isolation |

## Package management conventions

- `package.json` must have `"packageManager": "pnpm@<version>"` — CI reads this to select the right pnpm version
- `pnpm add -D <pkg>` for dev dependencies
- Always use `--save-exact` or manually pin to exact version
- Never edit `pnpm-lock.yaml` by hand — always regenerate via `pnpm install`
- `pnpm check` — type-check source files (`tsc --noEmit`)
- `pnpm lint` — run ESLint on source files (rarely used locally, mainly CI)
- `npx vitest run` — run tests (skips tsc, uses esbuild)

## When to update

- After adding/removing any dependency: run `pnpm install`, verify `pnpm check` and `npx vitest run` pass
- If CI fails on `--frozen-lockfile`: run `pnpm install` locally to regenerate lockfile
- If a new tsconfig flag is added: check for new source-level errors before committing
