// pi-entry.js — committed entrypoint, git-install safe + fast when dist exists.
//
// Problem: `dist/` is gitignored. Direct `pi.extensions: ["./dist/index.js"]`
// is ~2× faster (prebuilt ESM bundle vs jiti transpilation) but breaks fresh
// `git clone` / `pi install git:...` when `prepare` didn't build dist
// (pi runs `npm install --omit=dev` for git deps by default → tsup missing →
// prepare skips). Direct `["./index.ts"]` is robust but pays ~600ms jiti cost
// every startup (benchmark flags it as `⚠ points at .ts but has built dist/`).
//
// This loader gives both: `existsSync(dist)` → fast `dist/index.js` bundle,
// else fallback to `index.ts`. It's committed (not gitignored) so git
// installs always have an entrypoint, and `prepare` still builds dist when the
// toolchain is available for the fast path.
//
// Why no `jiti` dependency? Pi itself loads this file via `jiti` (Node) or
// natively (Bun). On Node, pi's outer `createJiti(...).import()` hook already
// handles extensionless `from "./src/core/settings"` imports, so plain
// `await import("./index.ts")` works without adding `jiti` to our
// dependencies. On Bun, native TS handles `.ts` directly. Adding `jiti` as a
// runtime dep would not grow `dist/index.js` (tsup externalizes it, `dist` is
// built from `index.ts` only) but would install extra files for every
// registry user who never hits the fallback — so we keep zero runtime deps.
//
// Mirrors pi-utils pattern: root `pi.extensions` points at compiled `dist/`,
// per-package points at `src/` — here folded into one file for single-package.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = join(__dirname, "dist", "index.js");

// Top-level await is supported — pi's loader does `await jiti.import(...)`.
let factory;
if (existsSync(distPath)) {
  try {
    ({ default: factory } = await import("./dist/index.js"));
  } catch {
    // dist exists but is corrupt/partial build — fall back to source so a bad
    // artifact doesn't hard-crash the extension. Mirrors pi-utils fix for #821.
    ({ default: factory } = await import("./index.ts"));
  }
} else {
  ({ default: factory } = await import("./index.ts"));
}

export default factory;
