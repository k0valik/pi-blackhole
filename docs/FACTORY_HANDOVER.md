# pi extension startup — factory investigation + lazy-loading playbook

> For agents in `pi-blackhole-dev` and `pi-utils`. Two scopes combined:
> **A.** Why pi-blackhole's `index.ts` factory is ~450ms and how to get it toward ~0ms (cache-hit chunk).
> **B.** A transportable playbook for *all* pi packages in `pi-utils`: when to lazy-load, when not to, and how to audit each package.
>
> Do not touch `pi-entry.js` (deleted), single-file bundling config, minify, or `pi-base` without measurement. Probe first, fix next, re-measure after.

---

## 1. The one thing that decides everything: which load mode pi uses

A pi extension is loaded in **one of two modes**, decided solely by the `pi.extensions` field in the package's `package.json` — **not** by install source (git vs npm) and **not** by a `main`/`exports` field.

| Mode | `pi.extensions` | Startup parse behavior | Lazy `await import()` works? |
|---|---|---|---|
| **TS-direct** | `./index.ts` (jiti on Node / native TS on bun) | Modules parsed lazily as the static import graph is walked — unimported subtrees are **never parsed** | ✅ real win |
| **Single-file dist** | `./dist/index.js` | The whole minified file is parsed/evaluated as one unit | ❌ internal lazy imports are **flattened away** by the bundler |
| **Split-chunk dist** | `./dist/chunks/*.js` | Real on-disk chunk files; dynamic imports load a chunk on demand | ✅ real win |

**Every package in `pi-utils` is TS-direct** (`./index.ts` / `./src/extension.ts` …). That is the mode where lazy loading pays off — do not flip to dist to "speed things up"; that would forfeit it.

**npm vs git install does not change the mode.** Publishing only changes whether `dist/` exists for consumers (npm tarball ships `files`; git installs with `--omit=dev` have no toolchain to build it). And in pi-blackhole's own bench, TS-direct measured *faster* to start importing than the bundle (140ms vs 631ms) — so a prebuilt single-file dist is not inherently "better"; it's a publish/fallback artifact.

---

## 2. The three layers of startup cost

```
pi startup (interactive, real user pain 5–8s)
├─ ~0.7s   pi core, no extensions
├─ pi's agent-session creation + provider/networking + settings manager   ← 3–6s, NOT extension-fixable
└─ per-extension contribution (additive; this playbook's scope)
   ├─ module import graph  (~140ms for pi-blackhole's static graph)
   └─ factory() body       (~485ms for pi-blackhole — the big controllable one)
```

### Measured reality (post-0.5.0, pi 0.84.x, clean reinstall, `benchmark-startup.mjs --runs 3`)

```
main TOTAL               4398ms   (createAgentSessionRuntime 4378ms — pi's OWN cost, not extension-fixable)
extensions TOTAL         2821ms   (import + factory across all user extensions)
pi-blackhole             import 444ms + factory 554ms  ≈ 998ms   ◀ biggest single extension
pi-better-toolcalls      import 643ms + factory   1ms  ≈ 644ms
pi-bang-autocomplete     import 485ms + factory  33ms  ≈ 518ms   (dist mode)
pi-free                  import  42ms + factory  16ms  =  58ms   (dist mode)
pi-bash-live-view        import  81ms + factory   1ms  =  82ms   (dist mode)
pi-treex                 import   6ms + factory   4ms  =  10ms   (TS-direct, tiny graph)
pi-cache / pi-context / …                               ≈  5ms   (dist, tiny graphs)
```

Three lessons with teeth:
1. **`createAgentSessionRuntime` (~4.4s) dwarfs every extension.** The interactive 5–8s feeling is mostly pi's own model/provider/settings construction. No per-extension change fixes it.
2. **The load-mode story is secondary to graph size.** The fastest extensions (treex, cache, context — 3–82ms) are small-dist or small-TS. The slow ones (blackhole 998ms, toolcalls 644ms, bang-autocomplete 518ms) are slow because *their dependency subtrees are heavy*, in either mode. A 338KB single-file bundle still takes ~800ms native ESM import — bundle parse/execute dominates, not jiti.
3. **pi-blackhole's 444ms import on a 4KB `index.ts` is its static dependency graph** (before-compact hooks, OM ledger, project-recall corpus, vendored pi-base config manager, changelog viewer pulling `pi-tui`). Its 554ms factory was dominated by `installHostInlineCompactionAdapter` — **resolved 2026-09-06** (see §3 ✅, adapter 506ms → 16ms). The remaining 444ms import graph is the lazy-loading harvest (PR-71 started it).

---

## 3. What pi-blackhole's factory does (the 485ms suspect)

```ts
export default async (pi: ExtensionAPI) => {
  await installHostInlineCompactionAdapter(); // ← imports pi internals via file:// URLs
  scaffoldSettings();
  // ... register hooks/commands/tools (cheap)
};
```

`installHostInlineCompactionAdapter` (`src/om/inline-compaction.ts`) loops `modulePaths` from `findPiPackageRoot(process.argv[1])` and `await import(pathToFileURL(modulePath).href)`. Each import is **cache-hit (~0ms)** or **fresh graph (~400–500ms)** depending on whether pi already loaded that exact file — the R2 distinction.

### ✅ Resolved 2026-09-06: the barrel-first ordering was the 484ms

Probe on pi 0.85.1 (clean reinstall, `dev`):

```
BEFORE  [probe] import .../pi-coding-agent/dist/index.js            -> 484ms   ← fresh graph (barrel)
        [probe] import .../pi-coding-agent/dist/bundle/chunks/chunk-*.js -> 10ms   ← cache-hit (loaded by pi)
        adapter total -> 506ms

AFTER   [probe] import .../pi-coding-agent/dist/bundle/chunks/chunk-*.js -> 5ms
        adapter total -> 16ms
```

The fix (`src/om/inline-compaction.ts`, commit `41cd034`): **collect the bundled-runtime chunk candidates first (per host path / pi package root), and only fall back to the `dist/index.js` barrel for a root that never resolves a chunk.** Keep per-host iteration so multiple host roots are still all patched (the `patches every independently loaded host AgentSession identity` test). Do **not** `return` on first success — that broke the multi-host case. Preserve `hostCandidateCount` (informational). Factory time dropped ~490ms (506ms adapter → 16ms).

```ts
const modulePaths = new Set<string>();
const rootsWithChunk = new Set<string>();
for (const hostPath of hostPaths) {
  for (const packageRoot of packageRoots) {
    if (findPiPackageRoot(hostPath) !== packageRoot) continue;
    const bundledRuntime = findBundledRuntimeModule(hostPath, packageRoot);
    if (bundledRuntime) { modulePaths.add(bundledRuntime); rootsWithChunk.add(packageRoot); }
  }
}
for (const packageRoot of packageRoots) {
  if (rootsWithChunk.has(packageRoot)) continue;
  modulePaths.add(join(packageRoot, "dist", "index.js"));
}
```

Transportable rule: **never `import()` a fresh barrel when pi has already loaded the exact chunk** — parse the chunk pi runs from (`dist/bundle/chunks/chunk-*.js`, found via `findBundledRuntimeModule`), import it (cache-hit), and let the barrel be a last-resort fallback only. This single reorder is worth ≈10× more than any bundling flag tweak.

On bun/binary installs `findPiPackageRoot` fails (no on-disk `package.json`) → adapter returns `supported:false` and the probe shows ~0ms/error → valid; don't force the Node shape.

**Patch-deadline (R3):** factories run *before* the session is constructed, so fire-and-forget from the factory (`void adapter()`) is safe — but `pi.on("session_start")` is **too late** (patch would miss the current session).

---

## 4. When to lazy-load — the PR-71 pattern (transportable)

PR #71 (`perf/lazy-worker-loading`) applied the pattern at three sites in this repo; the rules generalize to every package:

**Rule 1 — registration is never lazy.**
`pi.registerCommand` / `pi.registerTool` / `pi.on(...)` must run at startup: cheap one-time calls that make the registry + descriptions + completions available. They do **not** execute your handler code.

**Rule 2 — the hot command main-action stays eager.**
If a handler's main path runs every session (compact, recall, any autocalled tool), keep its implementation statically imported; `await` on that path only adds scheduling noise.

**Rule 3 — cold sub-paths become lazy.**
Subcommands, modals/settings, changelog viewers, cleanup, exporters, background agents → `await import("./x.js")` *inside the handler branch*, not at top level.

**Rule 4 — gate the import behind the cheapest zero-import check.**
Structure pipelines so each stage loads only when its inputs exist:
```ts
handler(args) {
  const parsed = validate(args);            // zero-import guard
  if (!parsed.ok) return;                    // fail fast, load nothing
  const { heavyThing } = await import("./heavy");
  // ... use heavyThing
}
```
Bad invocation → pays none of the heavy imports.

**Rule 5 — the stats of PR-71's actual shape** (what to copy):
- `/blackhole` handler: settings/changelog/cleanup/om-off → `await import(...)` in the branch; the compact path + `before-compact` hooks + pending flush stayed static.
- Export pipeline: `findGitRoot` imported after `out:` validation; `corpus` after path validation; `format-export` only after a non-empty corpus.
- Memory workers (`runObserver`/`runReflector`/`runDropper` — LLM loops, largest graphs) imported only after the stage is due *and* a usable model passes the budget check.

**Rule 6 — two footguns (both hit this repo):**
1. **The destructure trap:** a dynamic import rewritten into an existing branch must supply *every* symbol that branch used from the old static import — otherwise `ReferenceError: X is not defined` at runtime (the `config`/`GLOBAL_CONFIG_DIR` incident). Test contract: registration + argument completion must load **zero** optional modules.
2. **Single-file bundling flattens lazy imports.** Check `tsup.config.ts` / `splitting` before promising a win to a dist-loaded package. If a package must ship dist-loaded, either point `pi.extensions` at TS or enable chunk splitting.

**Test contracts to replicate** (this repo's `tests/lazy-command-imports.test.ts`, `tests/lazy-workers.test.ts`):
- registering + `getArgumentCompletions` loads no optional modules
- handler("settings") loads exactly `["settings"]` — no other module
- export: invalid path loads nothing; empty corpus loads session-dir + corpus but not the formatter

---

## 5. Common myths (corrected)

- **"Prebuilding yields worse results."** — Not categorically. A single-file bundle forfeits *lazy-loading* (flattened), but isn't inherently slow. TS-direct is the right default for git-installed packages you control; dist stays as a publish/`--omit=dev`-fallback artifact. Keep the build script — it's for npm tarballs, dev-free installs, and prod-artifact validation — not because pi needs it to run.
- **"npm-published = bun-transpiled = faster."** — False. Mode is decided by `pi.extensions`, not by install source.
- **"Moving to index.ts fixes startup."** — Only enables Lever A. pi-blackhole is *already* TS-direct and the 554ms factory **was** Lever B (resolved 2026-09-06: adapter 506ms → 16ms via chunk-first ordering; see §3 ✅).

---

## 6. Audit checklist — one agent per package

For each package in `pi-utils/packages/*`:

1. **Classify** — `cat package.json | jq '.pi.extensions'`.
   - TS-direct ([./index.ts] etc.) → lazy-loading is available. Keep it that way.
   - dist entry → either flip to TS or enable `splitting: true` before promising gains.
2. **Scan the entry module** (`index.ts` / `src/extension.ts`).
   - List every top-level import that pulls a **heavy graph**: `pi-tui`, vendored config managers, corpus/dedup/export libs, LLM agent loops, anything with its own deps.
   - For each: is it (a) needed at registration, (b) used only in rare/cold handler paths, or (c) shared with the always-on path?
     - (a)/(c) → keep static.
     - (b) → move to `await import()` behind the cheapest guard (Rule 4).
3. **Scan for pi-internal imports by path** (`await import(pathToFileURL(...))`, or importing from a barrel like `dist/index.js` of pi's own source).
   - Is the imported target already in pi's module cache? If it points at a barrel while pi runs from `dist/bundle/chunks/chunk-*.js` → that's a ~400–500ms fresh-graph import.
   - **Canonical fix (pi-blackhole §3 ✅, commit `41cd034`):** collect bundled-runtime chunks first per host path, only fall back to `dist/index.js` barrels for roots with no chunk. Patch every unique module (don't `return` early — multi-host test `patches every independently loaded host AgentSession identity` breaks). The single reorder `dist/index.js 484ms → chunk 5ms` is worth ~10× any bundling tweak.
4. **Measure before/after**: `PI_TIMING=1 pi --no-extensions extensions list` isolated and the shared bench (`node scripts/benchmark-startup.mjs --runs 3`), table with pi version, node/bun version, commit SHA.
5. **Gate** — run the package's `typecheck` + tests + `oxfmt --check` after edits; keep the two lazy test-contract patterns where sensible.

Priority heuristic: largest graphs first (pi-tui pullers, config-manager vendored code, export/corpus pipelines, worker-agent loops). Small TUI packages may show only a few ms — don't churn them for nothing; measure first.

---

## 7. Repro/probe commands (from the original investigation)

1. Baseline:
```bash
node /home/kovalik/projects/pi-utils/scripts/benchmark-startup.mjs --runs 3
PI_TIMING=1 pi --no-extensions -e $(realpath index.ts) extensions list 2>&1 | grep -E "pi-blackhole|extensions TOTAL"
```
2. Probe the adapter loop (`.bak`, restore after):
```bash
cp index.ts index.ts.bak
# patch src/om/inline-compaction.ts loop:
# for (const modulePath of modulePaths) {
#   const t0 = performance.now();
#   const hostModule = await import(pathToFileURL(modulePath).href);
#   console.error(`[probe] import ${modulePath} -> ${Math.round(performance.now()-t0)}ms`);
# }
PI_TIMING=1 pi --no-extensions -e $(realpath index.ts) extensions list 2>&1 | grep probe
mv index.ts.bak index.ts && grep -c probe src/om/inline-compaction.ts   # expect 0
```
3. Find pi's actual loaded chunk to target (Node unbundled):
```bash
PI_REAL=$(readlink -f $(command -v pi)); grep -m1 node $PI_REAL
grep -oE 'from "\./chunks/[^"]+"' $(dirname $PI_REAL)/../dist/bundle/cli.js | head
grep -o 'export{[^}]*_bindExtensionCore[^}]*}' ~/.pi/.../pi-coding-agent/dist/bundle/chunks/chunk-*.js
```
4. Verify the fix lands in the real install: rebuild dist only if the package is served from dist; for TS-direct packages just re-run step 1.

---

## 8. Guardrails

- Probe generated source with `.bak`; restore and verify no `probe` left.
- No `npx` — use vendored `tsup`/`esbuild`.
- Measure isolated (`-e`) and full (`--runs 3`) both; record env (pi version, node/bun version, commit SHA).
- Don't flip `pi.extensions`, don't reintroduce `pi-entry.js`, don't change bundling without a measurement showing it matters.
- One fix → rebuild → re-measure loop. No direct fixing without proof.