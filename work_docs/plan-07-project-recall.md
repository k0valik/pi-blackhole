# Plan 07 — Project recall: cross-session search for the `recall` tool

**Date:** 2026-08-20
**Status:** Planning — no code changes yet
**Inputs:** `/tmp/opencode/pi-chrollo` (v0.4.0 clone, MIT), pi-coding-agent 0.84.0 session-manager API, current `src/tools/recall.ts` + `src/commands/vcc-recall.ts`

---

## 1. Problem statement

The `recall` tool and `/blackhole recall` command search **only the active session** (plus its lineage). When the agent needs to answer "how did we solve X before?" or "what was decided about Y?", the answer is scattered across the current project's history — dozens of old session `.jsonl` files that the tool cannot see. The user's request, verbatim intent: add a new boolean/object param to the existing `recall` tool and `/blackhole recall` command so searches span the **current project's session history**, not just the active session.

The user describes the desired design as **layered**: recall tool layer → project recall layer → chrollo primitives (clone of https://github.com/k3-2o/pi-chrollo, v0.4.0, MIT, npm `@k3_2o/pi-chrollo`).

## 2. North star

**"Search the whole project's memory, get three sentences, know how old it is."** The agent asks a free-form query; the tool returns highly condensed, timestamped snippets from the project's recent session history — ranked by relevance, recency, and first appearance — with an explicit staleness warning, never raw turn dumps.

## 3. Requirements (from the author)

1. **Corpus:** scan the project's last **50–75** session `.jsonl` files, newest by mtime.
2. **Reuse pi-chrollo's primitives** rather than reinventing (search/normalize/tokenize/format/read).
3. **Ranking:** tf-idf **and/or** RRF rerank, plus **recency**, **term frequency**, and **first-appearance** signal (the oldest session entry where a snippet was first seen).
4. **Output:** highly condensed snippets — session id, date, path/line, 2–3 sentences of context. Never raw turn dumps.
5. **Role weighting:** user/assistant messages above tool outputs (file-read noise).
6. **Renamed/moved files:** basename/fuzzy fallback.
7. **Race safety:** avoid reading the actively-written session file.
8. **Optional scope sub-mode:** `conversation | tool_outputs | all`.
9. **Relative timestamps:** e.g. `"3 days ago in session a1b2c3"`.
10. **Staleness marker** (added later, verbatim intent): when `project = true`, the project-side results carry a `<--old context-->` header with a baked-in one-liner — "these entries are potentially stale, as they are coming from old sessions, decisions might have changed between them, thread lightly" — "you get the gist".
11. **Single source of truth:** this problem statement, the examples, and everything above live in `work_docs/` (this document).

## 4. Design decisions (decision log)

| # | Decision | Rationale |
|---|---|---|
| **D1** | **Vendor chrollo's core primitives** (`search.ts`, `normalize.ts`, `tokenize.ts`, `format.ts`, `read.ts`) into `src/chrollo/` with MIT attribution header + version note. **Never** register its `search_memory`/`read_memory` tools. | Same precedent as `src/pi-base/` (vendored upstream, surgical rewiring only). The npm package would register its own tools (conflict) and its root is hardcoded to `~/.pi/agent/sessions` — vendoring lets us parameterize root + role filter. |
| **D2** | **One rg pass over an explicit file list** (paths as args, not `-- <dir>`), with per-term `-m 200` caps, 30s timeout, 100MB maxBuffer (chrollo's `runRipgrep` flags). | Chrollo v0.4.0 deliberately removed BM25/corpus-stats/recency-decay ("13s-freeze class of global-corpus-stat scanning"). We keep that discipline: no global scans, bounded candidate set. |
| **D3** | **Approximate tf-idf computed over candidate matched lines only** (idf = `log((N-df+0.5)/(df+0.5)+1)` over the candidate line set; tf per line). | The user asked for tf-idf; chrollo dropped corpus stats for latency. Compromise: document frequencies over the **already-matched candidate lines** — no extra I/O, still meaningful discrimination. |
| **D4** | **RRF merge of two ranked lists** (chrollo term-overlap order ∪ tf-idf order), then **recency decay** `1/(1+days)^0.3` and **first-seen boost** as tie-breakers. | Satisfies req 3 with bounded compute: overlap is chrollo's proven fast ranker, tf-idf adds precision, RRF is the standard way to fuse them, recency/first-seen break ties. |
| **D5** | **Role weights:** user/assistant ×1.0; toolResult/bashExecution ×0.4; tool-call args searchable only in `tool_outputs`/`all` scopes. | Req 5. File-read noise (e.g. `Read` tool results echoing file content) must not outrank real conversation. |
| **D6** | **First-appearance = min line timestamp per session** among matching lines; surfaced in output and used as a tie-break (earlier first-seen wins). | Req 3's "oldest session entry where a snippet was first seen". Cheap: timestamps only parsed for matched lines. |
| **D7** | **Active session excluded** from the candidate list by path equality with `ctx.sessionManager.getSessionFile()`; also `stat`-skip any file whose mtime equals the active session's or is being written (same inode check). | Req 7 — never race the live session file (half-written line, torn JSON). |
| **D8** | **Basename/fuzzy fallback:** if the query contains a path-like token (`src/foo.ts`), additionally emit an rg pattern on the basename (`foo.ts`); matches annotate `(basename match)`. | Req 6 — survives renames/moves inside the project. |
| **D9** | **New params on the `recall` tool:** `project: boolean` (default `false`) + `projectScope: StringEnum ["conversation","tool_outputs","all"]` (default `conversation`); `query` required when `project: true`. Command adds `project:true` and `pscope:(...)` parsing (new regex alongside `SCOPE_RE`/`MODE_RE` — `pscope` avoids colliding with the existing `scope:(lineage|all)`). | Matches "boolean/object param" intent; explicit separate scope keeps the existing `scope`/`mode` semantics untouched. |
| **D10** | **Staleness header:** the project formatter emits, once per results block (every page), exactly `<--old context-->` plus a one-liner: `entries from older sessions may be stale — decisions may have changed since; tread lightly`. Shared by tool and command (single constant string). | Req 10. The `<--old context-->` marker mirrors pi's compaction labeling, so it reads naturally to the agent. |
| **D11** | **rg is a hard requirement** for project recall (chrollo is rg-native); graceful error if `rg` is not on PATH. | Blackhole currently has zero binary deps — this is the accepted tradeoff (decision point, see §13 Q1). ripgrep 15.1.0 present on the dev machine; ~102MB corpus per project dir makes pure-Node scanning too slow. Need to figure out where pi ships the rg binary to point at it |
| **D12** | **New config fields:** `projectRecallSessionCount` (default **60**, in the 50–75 range) and `projectRecallEnabled` (default `true`). | Bounds the corpus; doc-consistency rule applies (README.md / CONFIG.md / llms.txt must mirror `src/core/unified-config.ts` defaults). |

## 5. Target architecture (the layered approach)

```
┌──────────────────────────────────────────────────────────┐
│  recall tool layer          (unchanged entry points)      │
│  src/tools/recall.ts  +  src/commands/vcc-recall.ts       │
│  new: params {project, projectScope} / project:true,      │
│       pscope:(...) → dispatch to projectRecall()          │
└───────────────┬──────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────┐
│  project recall layer        (new: src/project-recall/)   │
│  session-dir.ts   → resolve project session dir           │
│  candidates.ts    → N newest .jsonl by mtime, exclude     │
│                     active session, byte cap ~150MB       │
│  search.ts        → one rg pass over the file list        │
│  score.ts         → overlap · tf-idf · RRF · recency ·    │
│                     first-seen · role weights             │
│  renamed.ts       → basename/fuzzy fallback               │
│  format.ts        → condensed snippets + relativeTime()   │
│                     + <--old context--> header            │
└───────────────┬──────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────┐
│  chrollo primitives         (vendored: src/chrollo/)      │
│  runRipgrep/parseRgJson/buildSearchResults (search.ts)    │
│  parseLine (normalize.ts) · tokenize/queryTerms           │
│  formatSearchLine/clock (format.ts) · read (read.ts)      │
│  surgical mods: root param, role filter, fileList mode    │
└──────────────────────────────────────────────────────────┘
```

## 6. Tool / command parameter surface

**`recall` tool** (src/tools/recall.ts) — schema additions:
- `project: Type.Boolean()` — default `false`. When `true`, search across the project's session history instead of the active session.
- `projectScope: Type.StringEnum(["conversation", "tool_outputs", "all"])` — default `conversation`; only meaningful with `project: true`.
  - `conversation` — user/assistant text only (chrollo's parseLine default).
  - `tool_outputs` — adds toolResult/bashExecution text + tool-call args.
  - `all` — everything, weighted per D5.
- Dispatch in `execute()`: `params.project === true` → `projectRecall(params, ctx)` (before the drill-down/om paths). `query` is required in this branch; no `DEFAULT_RECENT` fallback. `page` reused for pagination (PAGE_SIZE=5, existing header/footer pattern).

**`/blackhole recall` command** (src/commands/vcc-recall.ts):
- Parse `project:true` and `pscope:(conversation|tool_outputs|all)` (new `PROJECT_SCOPE_RE` in src/core/recall-scope.ts, mirroring `SCOPE_RE`/`MODE_RE` style).
- Same pipeline and output, delivered via `pi.sendMessage({customType: "blackhole-recall", content, display: true}, {triggerTurn: true})`.

## 7. Algorithm (per call)

1. Resolve project session dir (D1/dir logic; see §13 risk 1).
2. List `*.jsonl` by mtime desc; drop the active session file (D7); take first `projectRecallSessionCount` (default 60); hard byte cap (~150MB) as backstop.
3. Tokenize query via chrollo `queryTerms` (stopwords, camelCase/snake/kebab splits, ≤8 terms).
4. **One** rg call: `--json -n -F -i --sortr modified -m 200` with `-e term` per term, `--` followed by the explicit file paths (D2). Basename fallback terms appended when the query carries a path-like token (D8).
5. Parse JSONL stream (chrollo `parseRgJson`); filter by scope via the vendored, role-aware `parseLine` (conversation keeps only user/assistant text; other scopes widen to toolResult/bashExecution + toolCalls).
6. Score each candidate line (D3/D4/D5): term-overlap count → tf-idf over candidate set → RRF merge → recency decay → first-seen tie-break → role weight.
7. Per-file diversity cap (chrollo `PER_FILE_CAP=3`), `MAX_RESULTS=15`-style global cap, yieldToEventLoop chunking preserved.
8. Format (D9/D10/D11 + req 4/9): `<--old context-->` header + one-liner, then entries — session id (8 chars), relative date, `path:line`, 2–3 sentences of context (whitespace-collapsed, clipped).

## 8. Output format + examples

```
<--old context-->
entries from older sessions may be stale — decisions may have changed since; tread lightly

#1 [ab12cd34 · 3 days ago · src/tools/recall.ts:210]
  assistant: we unified drill-down into parseDrillDown, then dispatch checks #N:path first
#2 [f8e7d6c5 · 2 weeks ago · src/core/search-entries.ts:88]
  user: BM25-lite stays — chrollo dropped their scorer in v0.4.0
#3 [b0b1c2d3 · 1 month ago · src/core/recall-scope.ts:14]
  user: keep scope/mode regexes separate, normalize before parse
```

- `conversation` scope shows bare `role:` lines; `tool_outputs`/`all` entries get a `[toolName]` prefix.
- Basename matches annotate `(basename match)` and the path shown is the old path.
- First-seen note on entry footer when it differs from the entry date (e.g. `first seen 2 months ago`).
- Pagination: `-- page 1/3 (15 results), use page:N or /blackhole recall page:2 --` (existing pattern).
- Drill-down (`#N:path` on a project result) is a **v2 option** via the vendored `read()` window (see §14 non-goals).

## 9. Vendoring chrollo primitives

- Copy from `/tmp/opencode/pi-chrollo` (v0.4.0): `src/search.ts`, `src/normalize.ts`, `src/tokenize.ts`, `src/format.ts`, `src/read.ts` → `src/chrollo/`. Add MIT attribution header with upstream URL + version. Skip `index.ts` (tool registration), `corpus.ts` (hardcoded root — replaced by our resolution), `test/`.
- Surgical modifications only:
  - `defaultRoot()` → injectable root (project session dir).
  - `parseLine` → role/scope filter (keep toolResult/bashExecution/toolCalls when scope ≠ conversation).
  - `search()` → `fileList` mode (explicit paths) alongside root mode.
- Verify the five files contain no pi API surface (they are pure Node + rg — confirmed against the 0.80.x-era package; no 0.84-only APIs).

## 10. Config surface (new fields)

| Field | Default | Meaning |
|---|---|---|
| `projectRecallEnabled` | `true` | master switch for project recall |
| `projectRecallSessionCount` | `60` | newest N sessions scanned (author range: 50–75) |

Both mirrored in `src/core/unified-config.ts`, README.md, CONFIG.md, llms.txt (docs-consistency rule). Env overrides: `PI_BLACKHOLE_*` pattern.

## 11. New file layout

```
src/chrollo/            vendored primitives (search/normalize/tokenize/format/read)
src/project-recall/
  session-dir.ts        project session dir resolution (+0.81.1 fallback)
  candidates.ts         mtime-ordered list, active-session exclusion, N + byte caps
  search.ts             rg-over-filelist wrapper (RgRunner-injectable for tests)
  score.ts              overlap · tf-idf · RRF · recency · first-seen · role weights
  first-seen.ts         min-timestamp-per-session computation
  renamed.ts            basename/fuzzy fallback
  format.ts             condensed snippets + relativeTime() + staleness header const
  read-context.ts       (v2 option) read() window drill-down
src/core/recall-scope.ts  + PROJECT_SCOPE_RE + normalizeProjectScope/parse helpers
src/tools/recall.ts     + project/projectScope params, dispatch branch
src/commands/vcc-recall.ts  + project:true/pscope: parsing
tests/project-recall.test.ts   fixture dir + stubbed RgRunner + JSONL v3 fixtures
```

## 12. Tests (no network, no real sessions)

- Fixture project session dir under a temp agentDir (existing pattern: `vi.mock("@earendil-works/pi-coding-agent")` → `getAgentDir`), inline JSONL v3 fixtures, stubbed `RgRunner` (chrollo's injectable runner type).
- Coverage: candidate selection (mtime order, active-session exclusion, N cap), scope filtering (conversation vs tool_outputs vs all), role weights, tf-idf/RRF ordering, first-seen, recency, staleness header present iff `project: true`, basename fallback, relative timestamps, page pagination, command `project:true`/`pscope:` parsing.
- Extend `tests/blackhole-recall.test.ts` for the new dispatch + command parsing.
- `pnpm typecheck && pnpm lint && pnpm test` must stay green; no test may shell out to rg.

## 13. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `ctx.sessionManager.getSessionDir()` availability on pi 0.81.1 (min supported peer) unverified — only 0.84.0 in store | Medium | Fallback: compute dir from `getCwd()` with pi's exact sanitize pattern (`--${cwd.replace(/^[/\\]/,"").replace(/[/\\:]/g,"-")}--` under `agentDir/sessions`); compat CI job re-pins and re-tests |
| Cold-disk latency on first pass over ~102MB corpus | Medium | One bounded rg pass over explicit files with `-m` caps; candidate list cached with TTL (reuse load-messages LRU pattern); parse timestamps only for matched lines |
| rg missing on user machines (new binary dep) | Low→Medium | D11 graceful error message; documented in README/llms.txt; decision point Q1 |
| Chrollo parseLine drops assistant toolCalls for indexing | By design | Extended only for scope ≠ conversation (req 8); conversation stays chrollo-faithful |
| Vendored copy drifts from upstream chrollo | Low | Attribution header + version note; re-vendor on demand |

## 14. Open questions / decision points

1. **rg as a hard requirement** vs pure-Node fallback scanner for project recall? (recommend: hard requirement — chrollo is rg-native, ~102MB corpora are too slow in Node)
2. **`projectRecallSessionCount` default = 60** within the 50–75 range — acceptable? (recommend: yes)
3. **Drill-down into project results** (`#N:path` → window via vendored `read()`): v1 or v2? (recommend: v2, keep v1 read-only snippets)

## 15. Non-goals (v1)

- Registering chrollo's own `search_memory`/`read_memory` tools (vendored primitives only).
- Search across projects (scope is the current project only).
- Indexing/embedding/sidecar caches — stateless per call, chrollo's design discipline.
- Drill-down expansion of project results (v2 option).
- Changes to the active-session search path (`scope`/`mode` semantics untouched).

---

### User notes and initial statements before plan:

**Problem**
Currently, the `recall` tool (and `/blackhole recall` command) only searches within the active session. In larger projects with hundreds of `.jsonl` session files, historical context is lost. For instance:

* A user refers to a decision made a week ago in a different session.
* A code comment references a specific error (e.g., `bugfix 1 - undefined variable threw`), and the agent needs to track down when and where that code section was previously read or modified across past sessions.

**Proposed Solution & Design**

1. **Tool Parameter:** Add a `project` boolean option/object to the existing `recall` tool interface.
2. **Session File Filtering:** When `project = true`, scan the project's historical `.jsonl` files, focusing on the $50\text{--}75$ most recent sessions based on `mtime`.
3. **Search & Reranking:** Utilize `pi-chrollo` primitives to process the session logs. Rank and retrieve results using a combination of:
* **Recency:** Session timestamp (`mtime`).
* **Frequency & Relevance:** TF-IDF and Reciprocal Rank Fusion (RRF).
* **First Appearance:** Pinpointing the oldest session entry where a snippet was first encountered.

Here are the key edge cases, performance considerations, and potential enhancements you should consider before building out the architecture:

### Edge Cases & Technical Pitfalls

* **Token Window & Context Pollution:**
* Searching across $50\text{--}75$ full session logs could return a massive amount of matching text. If the tool injects raw matches back into the context, it will easily blow through token budgets or degrade model attention.
* *Fix:* The project recall tool response should yield highly condensed snippets (e.g., Session ID, date, path/line referenced, and 2–3 sentences of context around the hit), rather than raw turn dumps.


* **Noise from File Reads vs. Actual Discussion:**
* In `pi` sessions, a file might be read automatically 20 times during mundane tool runs without meaningful user discussion. If you search for `foo.ts`, TF-IDF might over-index on raw tool read payloads rather than high-value assistant/user messages.
* *Fix:* Implement a weighting strategy or score booster for user messages and assistant summaries over raw tool output payloads.


* **Data Drift Across Renamed/Moved Files:**
* Searching for `src/foo.ts` will miss historical references if the file was moved from `src/legacy/foo.ts` a week ago.
* *Fix:* Include term-based fuzzy fallback or strip path prefixes (search by filename `foo.ts` alongside relative paths).


* **Stale Session Locking / Incomplete Files:**
* The current active session file is open and actively being written to.
* *Fix:* Ensure the historical file reader explicitly ignores or safely reads around the currently active `.jsonl` lock/file pointer to prevent read/write race conditions.

---

### Architectural & Usability Enhancements

* **Two-Tier Search Strategy (Lexical + Metadata Filter):**
* Deeply parsing and running TF-IDF/RRF over 75 large `.jsonl` files on every recall call can introduce non-trivial latency if done synchronously.
* *Fix:* Pre-filter sessions using quick filesystem heuristics (e.g., last modified window, file size) or keep a lightweight, in-memory inverted index / SQLite metadata store for session summaries if performance becomes an issue.


* **Explicit Target Modes (`code` vs `chat`):**
* A user asking *"When did we implement the auth middleware?"* requires searching assistant/user conversation turns.
* A user asking *"Where was this error printed?"* requires searching tool outputs/logs.
* *Idea:* Allow the agent or user to specify a sub-scope (or let RRF balance them), e.g., `scope: "conversation" | "tool_outputs" | "all"`.


* **Structured Traceability Output:**
* When the tool returns results to the agent, include relative timestamps (e.g., *"3 days ago in session `a1b2c3`"*). Agents perform significantly better at temporal reasoning when given relative offsets rather than raw epoch or UTC timestamps.

---

`pi-chrollo` generates structured markdown reports out of single `.jsonl` session files (extracting user prompts, tool actions, assistant turns, and token counts). Vendoring its parser/primitives gives you clean message extraction out of raw `pi` event logs without having to maintain session file parsing.

Combining `pi-chrollo`'s structural extraction with hybrid lexical search (TF-IDF + RRF) introduces a few architectural edge cases and integration gaps to keep in mind:

---

### Unhandled Edge Cases & Pitfalls

**1. RRF Score Distortion Across Granularity Levels**

* **Issue:** `pi-chrollo` parses sessions into macro components (entire turns or tool call outputs). If RRF ranks entire raw turns against small code snippets, a 2,000-line tool output payload containing the search term once will compete directly with a 2-line user message that mentions the term multiple times.
* **Fix:** When slicing `.jsonl` data via `pi-chrollo` primitives, chunk text into atomic, uniform blocks (e.g., individual user/assistant turns, or sliding window chunks of large tool outputs) *before* building TF-IDF term frequencies. RRF requires list items to represent equivalent semantic granularity.

**2. Asynchronous Multi-Session File I/O Deadlocks**

* **Issue:** Iterating and parsing 50–75 raw session files synchronously using standard filesystem reads during an active tool call can block Node's main execution loop for several seconds.
* **Fix:** Stream the file reads or use worker threads (`worker_threads`) when reading and scoring large batch batches of historical `.jsonl` files. Set a hard time budget (e.g., 800 ms execution ceiling) that truncates historical depth if search takes too long.

**3. Fragmented Code Block Scoring (Escaped JSON Artifacts)**

* **Issue:** In raw `pi` session `.jsonl` files, tool calls (like file reads or edits) store code inside double-escaped JSON strings (e.g., `\n`, `\"`, `\\`). Raw TF-IDF calculations over unescaped JSON strings treat control syntax as keywords or fail to tokenize terms like `foo.ts` correctly.
* **Fix:** Run text through `pi-chrollo`'s unescape/normalizer transformations *first* to extract plain text before tokenization and term-frequency extraction.

**4. Project Path Disconnects Across Sessions**

* **Issue:** `pi` session files are typically grouped by directory or workspace hash. If the user moved or renamed the root folder across sessions, filtering by absolute path will fail to group past sessions into the same "project."
* **Fix:** Identify project boundaries using `git` repository root anchors (`.git` head or hash) or workspace relative paths rather than absolute file system strings.

---

### Key Architectural Recommendations

| Feature Dimension | Single Session Recall | Project Recall Extension |
| --- | --- | --- |
| **Search Scope** | Current active `.jsonl` memory | Historical 50–75 `.jsonl` logs filtered by `mtime` |
| **Unit of Retrieval** | Exact turn / message context | High-density snippet + Session ID + Relative age |
| **Ranking Metric** | Chronological index | Reciprocal Rank Fusion ($RRF = \sum \frac{1}{k + r}$) |
| **Context Payload** | Full raw turns | Condensed inline context (max 150 tokens per hit) |

```
Query -> Filter last N files (mtime) 
      -> Parse via pi-chrollo primitives 
      -> Rank [TF-IDF Keyword Score] + [Recency Weight] 
      -> RRF Fusion 
      -> Format top K hits -> Return to Agent

```

* **Query Expansion for Code Identifiers:** If searching for a symbol like `handleAuthError`, split terms on camelCase and snake_case (`handle`, `auth`, `error`). Historical logs often contain parts of function names in stack traces or conversation logs rather than exact verbatim matches.
* **Dynamic Recency Decay:** Apply an exponential time-decay multiplier to the TF-IDF term scores based on session age. A match from 2 days ago should outrank an identical match from 3 weeks ago unless the term frequency in the older file is significantly higher.
---

## 16. Recall query handling rework — lexical fusion (finding, appended 2026-08-20)

Supersedes the §15 non-goal wording "Changes to the active-session search path": `scope`/`mode` semantics stay untouched, but the **internal scoring path** of the active-session recall gains lexical fusion. The section below is the author's finding + direction; it lives here per the "everything in one place" rule.

### 16.1 The finding — the dot-bug

`src/core/search-entries.ts:64-65`:

```ts
const looksLikeRegex = (query: string): boolean =>
  /[|*+?{}()[\]\\^$.]/.test(query);
```

`.` is in the metacharacter set. Every query containing a dot — **i.e. any query mentioning a filename** — is treated as ONE literal regex pattern, matched verbatim against whole messages. The model's prose query `"foo.ts should not be rewritten to bar.ts"` becomes a single wildcard-heavy pattern → **zero hits**, every time. This is the observed failure: the model "thinks it is a first-class google search" and the tool silently returns nothing.

Secondary failure, even with the dot-bug fixed: the BM25 path (line 431) splits `foo.ts` → `foo` + `ts`. `ts` is df-heavy (nearly every doc) → near-zero idf; `rewritten` vs `rewrite` is an inflection mismatch; short tokens `foo`/`bar` are weak signals. Ranking collapses to noise.

### 16.2 Design direction (author-confirmed, 2026-08-20)

**No new param/array on the recall tool.** The model calls `recall` with the same arguments, same code — internally the tool runs the existing search AND a new lexical search, then merges (RRF fusion + dedupe by entry index). `search-entries.ts` can be changed freely (e.g. to export internals) — it is not treated as untouchable.

**D14 — Single pipeline, dual-pass fusion.** One code path: upstream `searchEntries` (fixed) + new `lexicalSearchEntries` on the same entries/messages; merge via RRF (`Σ 1/(k+r)`, k≈60), dedupe by entry index, prefer the lexical snippet (atomic-path-aware) when an entry appears in both lists. Cheap early-out: trivial queries (≤2 terms, no path tokens) run the upstream path only.

**D15 — Surgical edits to `search-entries.ts`:**
- Fix `looksLikeRegex`: drop `.` from the metachar set; regex path fires only for pattern-forming metachars (`^ $ ( ) [ ] { } * + ? | \`).
- Export what the lexical pass needs: `fullText`, `buildBM25Context`, `bm25Score`, `snippetRegex`, `lineSnippet` (or the computed BM25 result list).

**D16 — Lexical pass (`src/core/lexical-search.ts`):**
- Atomic term extraction BEFORE splitting: path/file tokens kept whole (`foo.ts`, `src/foo.ts`) + basename variant; identifiers kept whole (`parseDrillDown`); quoted phrases as exact terms; remainder → general words, stopword-filtered.
- Weighted tiers: path ×3, identifier ×2, general ×1; primary rank = count of strong terms matched (AND-boost: docs mentioning both `foo.ts` AND `bar.ts` float up).
- Proximity bonus: min line-distance between matched strong terms (same line = the "foo.ts ... bar.ts mentioned together" signal).
- Light inflection on general words only (`rewrit\w*`-style alternation for rewritten/rewrite/rewriting) — never on paths/identifiers. No stemming engine, no corpus stats, no vectors.
- Uniform granularity: score atomic blocks (turns / windowed chunks of large tool outputs), not raw 2000-line dumps — per the user's own RRF edge-case note below.
- Perf: both passes share ONE cached `fullText` doc set (no extra I/O); the lexical pass is a pure in-memory O(entries × terms) scoring run on top.

**D17 — Self-correction footer.** On zero/weak hits, output lists the terms actually used (`terms: foo.ts, bar.ts, rewritten`) so the model learns to emit better queries.

**D18 — Shared with project recall.** Plan-07's project recall consumes the same lexical core + fusion — one query-understanding path for both scopes. The atomic path-token extraction doubles as the substrate for the renamed/moved basename fallback (req 6) and chrollo's `queryTerms` already provides the same camelCase/snake_case splitting discipline (author's "Query Expansion for Code Identifiers" note below).

**Tests:** pin both single-term queries (existing behavior preserved) and prose-query behavior (the dot-bug regression case: `"foo.ts should not be rewritten to bar.ts"` must return hits, ranked with both files present first); fusion dedupe; RRF ordering; proximity; inflection; self-correction footer.

---

## 17. Observations as first-class corpus + cross-search (author note, 2026-08-20)

Author requirement, verbatim intent: project recall must be able to "search" and rank the **observations** in the pending json files we write and the jsonl files we write — the cross-search where recorded observations are surfaced and cross-referenced with direct `#N:path` entries must be wired into project-wide recall, and observation-backed evidence gets **higher values and better treatment in the RRF ranking**.

### 17.1 What exists today (single-session cross-search)

Verified in code:

- Every observation is recorded with `sourceEntryIds` — the exact session entry ids it derives from (observer prompt, `src/om/agents/observer/prompts.ts:23`; invalid ids rejected in `agents/observer/agent.ts`). Rendered line form: `[id] timestamp [relevance] content` (`ledger/render-summary.ts:21`).
- `indexLedger` (`src/om/ledger/recall.ts:101`) indexes the branch's `om.observations.recorded` / `om.reflections.recorded` / `om.observations.dropped` custom entries + a `droppedIds` set.
- **vcc→OM direction** (`src/om/reverse-recall.ts`): `findObservationsForEntryIds` / `findReflectionsForEntryIds` — given target entry ids, surface observations whose `sourceEntryIds` intersect (reflections match indirectly via `supportingObservationIds`). Wired into `src/tools/recall.ts:153,228` and `src/commands/vcc-recall.ts:35` as appended "Related observations/reflections" blocks. **Fed from `ctx.sessionManager.getBranch()` — the ACTIVE session only.**
- **OM→vcc direction** (`src/om/ledger/recall.ts:194` `recallMemorySources`): a 12-hex memory id resolves back to its source entries, with missing/nonSource/dropped/partial/collision flags. Used by the `MEMORY_ID_PATTERN` path in recall.ts.

### 17.2 The gap

Chrollo's `parseLine` keeps only user/assistant message lines — `om.*` custom entries (observations/reflections/dropped) and pending.json batches (`src/om/pending.ts`, `<sessionId>-pending.json` observationBatches in manual mode) are **not searchable** in the planned project recall as of §16. This section closes that gap.

### 17.3 Author intent — unified corpus, bidirectional cross-search, evidence-mass ranking

1. **Corpus:** project recall indexes, per session: message lines (chrollo), `om.observations.recorded` entries (observation = {id, content, timestamp, relevance, sourceEntryIds, tokenCount}), reflections, dropped ids, plus pending.json observation batches. Observations are first-class documents, not just text.
2. **Cross-referencing (generalized to project scope):**
   - Entry/snippet hit → related observations: extend `findObservationsForEntryIds` from branch-only to a **project-level ledger index** (keyed per session, since `sourceEntryIds` are session-local).
   - Observation hit → its source entries: generalize `recallMemorySources` across sessions (`(sessionId, #N)` annotations instead of session-local `#N`).
3. **Evidence-mass boost in RRF** (author example, verbatim): "a CRITICAL observation recorded, levenshtein matched with 15 other user mentions as well, and then also written in the code, should get a higher value, than if there is no observation recorded for a similar stuff." Concretely, the RRF score of a hit receives a multiplier from the sum of:
   - **relevance tier** of the backing observation(s): critical > high > medium > low (the LLM's "primitive session-level rank"),
   - **cluster size**: levenshtein near-duplicate count across sessions/mentions (recurring insight → stronger),
   - **code corroboration**: content-bearing tool calls (write/edit) touching matching paths/topics,
   - **status**: active observations boost; `dropped` ones do not (droppedIds set).
   - Ranked: observation + cluster + code > bare observation > bare mention (no observation recorded).
4. **Same unified corpus feeds the `/blackhole export` command** (Appendix A) — ranking/dedup machinery is shared.

### 17.4 Wiring notes

- New: `src/project-recall/ledger.ts` — project-level observation/reflection index (per-session indexLedger on parsed custom entries + pending batches).
- `reverse-recall.ts` / `ledger/recall.ts` can be modified directly as needed — the project layer wraps or extends them with session-aware lookup, or mirrors their logic with (session, id) keys.
- Cross-session snippet output annotates `(session id, #N)` instead of bare `#N` when referencing source entries of observations from other sessions.
- Tests: fixture sessions with recorded/dropped observations + a pending.json batch; assert observation-backed hits rank above bare mentions, dropped observations don't boost, cross-session source annotations render correctly.

## §18 — ripgrep discovery (no bundling, no hard requirement)

**Verified facts (0.84.0):**
- `tools-manager.js` exports `getToolPath(tool)` / `ensureTool(tool, silent?)` but they are **not re-exported** from the package index (`dist/index.d.ts`) — deep import only, not public API, 0.81.1-compat risk → **do not import them**; mirror the logic locally instead (~15 lines).
- `getToolPath` logic (tools-manager.js:78-91): check `join(getBinDir(), "rg" + (win32 ? ".exe" : ""))` first, then system PATH via `commandExists`.
- `getBinDir() = join(getAgentDir(), "bin")` (config.js:440-441) → `~/.pi/agent/bin/` (matches CHANGELOG #470). Blackhole already resolves agentDir via the same `getAgentDir()` for session paths, so the bin dir is consistent.
- On Android/Termux pi skips download (`pkg install rg` → PATH only).

**Design (D19 — replace/extend D11):**
- New module `src/core/resolve-rg.ts`: `resolveRgPath(): string | null` with candidate resolution in order:
  1. NO explicit override `PI_BLACKHOLE_RG_PATH` env (consistent with existing `PI_BLACKHOLE_*` convention), no new config knob, overkill for simple ripgrep finding! 
  2. Pi managed dir: `join(getAgentDir(), "bin", "rg" | "rg.exe")` — `existsSync`.
  3. PATH walk: split `process.env.PATH` by `path.delimiter`, `existsSync(join(dir, rg|rg.exe))`, `fs.accessSync(X_OK)` on non-win32.
- Verify the chosen candidate with `execFile(rgPath, ["--version"])` (5s timeout); on failure fall through to next candidate.
- Memoize result per process (re-stat cached path cheaply per call).
- None found → actionable error in the tool result ("run pi once so it downloads rg to ~/.pi/agent/bin, or install ripgrep, or set PI_BLACKHOLE_RG_PATH") — rg stays a soft requirement, graceful degradation. Pure-Node fallback scanner remains an open question (cold-disk latency, see §13/§14).
- Vendored `runRipgrep` gets an `rgPath` parameter (thread through the injectable `RgRunner` type — same seam chrollo already uses for tests), so tests stub the runner and never touch a real binary.

- Graceful degradation and fail with an error if rg is not available after all the discovery, so model doesn't try to use the project recall over and over again if not available.

---

## §19 — Machine recon receipts (2026-08-25, branch `feat/project-recall`)

Empirical validation of §17/Appendix A assumptions against the real corpus (`~/.pi/agent/sessions`, 1202 files / 1100MB / 1 corrupt line; `~/.pi/agent/pi-blackhole`, 420 pending/stale files). Throwaway scripts under `/tmp/opencode/recon/`; findings below are measured, not estimated.

### 19.1 Corpus inventory

| Signal | Value |
|---|---|
| Sessions carrying om markers | 305 of 1202 (571MB), range 2026-05-11 → 2026-08-14 |
| `om.observations.recorded` | 297 entries → **17,646 observations, 100% shape-valid** against current validators |
| Relevance spread | high 9919 / medium 4829 / critical 1789 / low 1109 |
| Observation content mass | ~759k est tokens (3.0M chars) |
| `om.reflections.recorded` | 221 entries → 2396 reflections; `supportingObservationIds` resolve vs same-file obs ids at **99.9%** |
| `om.observations.dropped` | only 12 entries / 1200 ids — dropper status signal is thin |
| Legacy `om.observation` | 8 entries, different shape (`data.records`, `YYYY-MM-DD HH:MM` timestamps, no tokenCount/coversUpToId) → tiny export shim needed |
| `om.folded` | **zero occurrences in the wild** → MemoryDetails handling can be deferred |
| Internal linkage | `sourceEntryIds` resolve in-file 99.97%, `coversUpToId` 99.87% |
| Pending files | 2204 obs + 531 refl + 42 drops across 86 batch-bearing files (+330 cursor-only shells from the known June 19–24 manual-mode recording gap — ignore that window); **249 orphaned** (no matching session file) still holding real data → export must include orphans and prefer main over `.stale` |

### 19.2 Compaction is a view boundary, not deletion (docs corrected)

Claim found in session-forensics skill + `scripts/om-session-parser.mjs` header was wrong. Measured: pre-compaction-boundary `coversUpToId` resolves 200/200, pre-boundary `sourceEntryIds` 956/956 across sampled compacted sessions; parser reads all lines (0 mismatches). pi appends a `compaction` entry with `firstKeptEntryId`; `buildSessionContext` slices the view only. Fixed: skill SKILL.md (4 spots), parser comments (on `feat/token-rework`, where the script lives). Consequence for this plan: whole-file scanning sees full history; D7 race safety only needs to exclude the *active* file.

### 19.3 Two id spaces (wiring note for §17.4)

Observation/reflection `id`s are 12-hex **memory ids**; observations' `sourceEntryIds` are **entry ids**; reflections' `supportingObservationIds` point at observation memory ids. The project ledger index must key both spaces.

### 19.4 Duplication analysis (recon nr.2 — author's slicing guidance applied)

Author guidance: relevance tiers feed RRF criticality, timestamps feed recency/scoring, memory ids carry no rendered value → output slices to content only. Measured duplication:

| Metric | Value |
|---|---|
| Exact-normalized duplicate copies | **47.9% of all obs** (8554 redundant); tokens 767k → 371k by hash dedup alone |
| Fuzzy lev@0.92 adds | only ~4% further savings (387k vs 371k); insensitive across 0.90–0.95 |
| Cluster profile @0.92 | 9740 clusters, 74.2% singletons; dup clusters: 1805 span >1 file, 705 same-file bursts |
| Mega-clusters (50–84×) | all trace to **one logical session copied into 3 scope dirs × within-file repeat bursts** (member timestamps span ~2 minutes) |
| Cross-scope session copies | 51 session ids present in >1 scope dir (50× three-way, all project-move artifacts) |
| Low/med boilerplate repeats (author's hypothesis) | real but small: 759 groups of 2–3; every large group traces back to copy inflation |

Design consequences:
1. **Exact-normalized dedup FIRST** (cheap content hash) — halves the corpus, kills fork/move inflation and record bursts. Levenshtein clustering is a refinement (paraphrase merge + display cap ≤3 per A.1), not the main lever.
2. **Session-id dedup**: same header `session.id` in multiple scope dirs = one logical session (keep newest mtime). This also mitigates the project-identity fragmentation (this repo's history spans `projects/pi-blackhole-dev`, `~/pi-blackhole-dev`, `.pi/agent/extensions/pi-blackhole`).
3. **Cluster-size boost must be damped** (`log(1+distinctLogicalSessions)`): raw repetition counts pipeline artifacts and single-episode bursts, not long-horizon recurrence. Linear boosting would be badly wrong.
4. Relevance tiers survive as rank inputs even among duplicates; low-value boilerplate repeats exist but rarely exceed 2–3×.
5. Export sizing: global rep-only ≈ 371k est tokens (~1.5MB raw) → A.1's "50–100kb distilled" needs relevance+recency filtering and/or per-project scoping on top of dedup.

### 19.5 Latency receipt

Pure-Node whole-corpus scan (parse every line of all 1202 files): 9.4s. rg over one project's marker-bearing subset will be far below that; D2's bounded single-pass discipline is comfortable at this corpus size.

### 19.6 Project scoping + reflection elevation (author notes, 2026-08-25)

- **One scope folder = one project.** Corpus walks only the cwd-encoded scope dir (`--home-kovalik-projects-pi-blackhole-dev--`), plus the git-root-encoded dir as secondary candidate when it differs. Other projects' session files are never opened — speed + true "current project" scoping.
- **Reflections outrank all raw observations.** Pipeline semantics: the reflector is a second LLM pass that reviewed, dropped, and promoted observations before distilling them, so a reflection carries verified value from the project's perspective. `/blackhole-export` renders the Reflections section above every observation tier and scores reflections with high-tier weight × an evidence-mass multiplier `1+log2(1+supportingObservationIds.length)` (damped, per §19.4).
- Cheap prefilter discipline: attributed session files are skipped before JSON parsing when a buffered read shows no `om.` substring at all.

---

## Appendix A — `/blackhole export` — distilled project memory dump (author concept, 2026-08-20)

Closely tied to the project-recall plan: same treatment, reuses the same primitives (chrollo search/normalize, tf-idf/RRF/recency ranking, levenshtein dedup, unified observation corpus from §17) and builds on it.
Instead, the export command turns the observation pipeline's accumulated output into a portable, distilled artifact.

### A.1 What it does

1. **Walk the project's session `.jsonl` files** + the pending json files (`<sessionId>-pending.json`, manual mode) and collect the observational memory entries: observations (with LLM-assigned `relevance`: critical/high/medium/low — the "primitive, session-level rank"), reflections, dropped ids.
2. **Rank** with the same machinery as project recall (§16/§17): tf-idf / RRF reranking, recency sorting, first-seen.
3. **Near-duplicate clustering** (levenshtein-style): catch close candidates — very similar observations that surfaced several times across sessions get boosted up the rankings; near-identical ones appear **at most 2–3 times** in the output.
4. **Strip the technical prefixes** — `[id] timestamp [relevance]` — from each observation line (they were already sorted as described above; the tags' work is done by then).
5. **Produce a structured markdown file** — a distilled version of the project's memory, potentially still 50–100kb / several thousand lines. Anyone with project knowledge can filter out what's still relevant (the extension does the cheap static analysis programmatically; the "owner" — with an LLM's help — surfaces what is still valid).
6. **Import-ready**: the survivors can be imported into the user's choice of agent memory system or tooling (pi-memory, Obsidian, vector store, ...).

### A.2 Relationship to the pipeline

- Addresses the "wasted tokens" concern: observations persist in session files (or pending buffers) even if a session never compacts — export recovers that latent memory.
- Shares the unified corpus + ranking/dedup machinery from §17 (observations as first-class corpus).
- Passive mode (`PI_BLACKHOLE_PASSIVE`) remains the opt-out for users who don't want the pipeline cost at all.

### A.3 Tests

- Fixture project sessions + pending.json batch: export output strips prefixes, caps near-identical observations at 2–3, boosts recurring insights, and is valid markdown.

### A.4 Implementation decisions (2026-08-26, branch `feat/project-recall`)

The first export commit (a123e12) was a deterministic, deduplicated dump: 83 sessions → 3053 observations → 1421 unique bullets + 568 reflections, tiered but flat. The improvements below move it **from a deduplicated dump toward a distilled, topic-organized brief** (the direction agreed with the author: anyone in possession of the `.md` can import it into their own memory system). Commit is `A4-shipped` (see CHANGELOG/commit message); rationale for each decision:

| # | Decision | Rationale |
|---|---|---|
| **A4-D1** | Command output is delivered via `pi.sendMessage({customType:"blackhole-export", content, display:true})` with **no `triggerTurn`**; a `ctx.ui.notify("Exporting project memory…", "info")` shows the working indicator | `triggerTurn:true` made the agent start reading the export as a new turn — the export is a **user artifact**, not agent context. `display:true` (the pi-context/pi-cache pattern) renders the notification in the TUI; the agent stays on task. The file on disk is the artifact. |
| **A4-D2** | `CorpusReflection` preserves `supportingObservationIds: string[]` instead of collapsing to `supportingCount: number` | Coverage-weighted ranking needs the actual id set: an observation's export score must reflect **how many reflections validated it**. Damping (log-scale) happens at scoring time, not parse time. |
| **A4-D3** | Three-pass dedup: exact normalized → Levenshtein@0.92 (bigram-Jaccard prefilters) → **Sørensen-Dice token-set similarity** over remaining reps | Levenshtein edits catch near-identical wording but miss paraphrases that reorder/swap vocabulary. Sørensen-Dice is order-independent: `2·|A∩B|/(|A|+|B|)` over stop-word-stripped token sets. Merges require **Sørensen-Dice ≥ 0.75 AND Levenshtein ≥ 0.60** — the Levenshtein floor prevents pure keyword overlap from merging distinct facts. |
| **A4-D4** | Stop-word stripping before tokenization, explicitly including `user`/`agent` | Those two words appear in a vast majority of observations (observer prompt patterns); they would dominate token-set overlap and inflate similarity for unrelated items. The stop list covers English function words + discourse markers (exported as `STOP_WORDS`). |
| **A4-D5** | Coverage-weighted ranking: score × `(1 + 0.3·log2(1 + coverage))`, where coverage = count of reflections citing any member id | A reflection is a second LLM pass that reviewed and validated the observation; covered observations are verified durable facts and outrank equal-tier unsupported ones. Log-scaled so 10 citations don't dominate the tier term. |
| **A4-D6** | Consensus rerank: score × `(1 + 0.2 · maxRelatedSimilarity)`, where maxRelatedSimilarity = max Sørensen-Dice to any sibling cluster | Clusters sharing vocabulary with a sibling represent recurring themes; the small weight breaks ties without letting keyword overlap masquerade as importance. |
| **A4-D7** | Viability gate: low-tier clusters with <2 distinct sessions and zero reflection coverage are dropped; medium similarly but kept when ≥50 chars | Cuts the noise floor (single-session transient notes, setup scaffolding) with zero LLM involvement. Measured corpus: removes the majority of the ~1421 unique observations while keeping all high/critical and every recurrence. |
| **A4-D8** | Orphan (unattributed pending) observations render only when their cluster spans ≥2 orphaned sessions | The measured corpus had 858 orphan observations from 34 lost sessions — almost entirely single-occurrence crash noise. Cross-session orphans are the only ones likely to carry durable signal. |
| **A4-D9** | Topic grouping replaces the flat tier dump: observation clusters group by shared content keywords (top-2 TF per cluster), connected via union-find; sections labeled by top-2 shared keywords; reflections matching a topic render beneath it; unmatched reflections stay in the top Reflections section (with a note when distribution happened) | Wiki-importability is the stated goal (§A.1): a flat 600+ bullet list is a database dump, not a document. Keyword-derived topics are deterministic, dependency-free, and stable across runs. Fallback to tier sections when <2 topics form (corpus too diverse). |
| **A4-D10** | Generic-keyword guard: keywords shared by >30% of clusters are excluded from topic edges (`GENERIC_KEYWORD_RATIO = 0.3`) | Words like `config`/`code`/`file` appear everywhere; connecting on them would merge the whole corpus into one topic. |
| **A4-D11** | Bullets surface provenance inline: `(across N sessions)`, `(recorded N×)`; fuzzy extras render as indented sub-bullets; wording `seen across` → `across` | Frequency signal was previously hidden in the stats footer only; surfacing it inline makes recurrence visible to a reader (human or importing agent) without parsing headers. |
| **A4-D12** | Stats extended: `observationsClustered`, `observationsRendered`, `observationsFiltered`, `topicGroups`; header shows rendered count after the viability gate | The old "1421 unique" overstated what the reader actually receives; the new header says how many survive dedup **and** the gate, plus how many clusters the gate removed. |
| **A4-D13** | Multi-pass clustering runs statelessly on every export (no caching layer) | Deterministic output is the author requirement (same corpus → same file); the corpus walk is already bounded to the project scope folders + pending dir (§19.5). |

**Tests** — `tests/blackhole-export.test.ts` gained an `orphan456-pending.json` fixture (a cross-session orphan survivor, needed because A4-D8 requires ≥2 orphaned sessions to render) and asserts the new `across 2 sessions` meta. All 1421 tests green; typecheck, lint, and format all clean.
