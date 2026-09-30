# Implementation plan: observer coverage cursor + completion strictness

Branch: `fix/observer-coverage-and-completion` (off `dev`).
Source: fork `kunkun9527/pi-blackhole` @ `7d52ba8` (analysis: `fork_comparison_02.md`,
`fork-divergence-review-2026-09-29.md`). Written before any implementation.

## Scope (decided)

| ID     | Item                                                                                                                               | Status                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| F1     | Coverage cursor: oldest-first prefix capping + bounded drain so `coversUpToId` never passes entries never sent to the model        | IN                         |
| F2     | Completion strictness: `length` / `aborted` / terminal-`toolUse` / `signal.aborted` are failures in observer, reflector, dropper   | IN                         |
| F2b    | Never-throw-from-`streamFn` safety: sync throws converted to an error stream (agent-loop has no `.catch()`, a sync throw kills pi) | IN (no pricing)            |
| Tier 1 | `observeAfterTokens > observerChunkMaxTokens` config guard (warn)                                                                  | IN                         |
| Tier 3 | Input pricing / measured prompt fit / `planInputBatches` / `budgetedStream` / `AGENT_LOOP_RESERVE` removal                         | OUT (explicit)             |
| —      | CJK/language ports (D1, D2, D6, D7), recall/export/prefs/RPC, `InputBudgetError → abort`, fork's model-fallback changes            | OUT                        |
| —      | `AGENTS.md` edit (never-throw constraint documented there)                                                                         | OUT (explicitly forbidden) |

## Non-goals / must-preserve (our 0.5.10 machinery)

- `WorkerStreamError` + `workerStreamErrorMessage` framing + `withDiscardedCount` (classification scans messages for 4xx codes).
- Stage loop `MAX_STAGE_ATTEMPTS = 10` + model-fallback stage loop. **Do not** port `InputBudgetError → return "abort"` semantics from the fork.
- `closedByCompleteBatch` kept-close path (result with `errorAfterClose` returns observations instead of throwing).
- `turnCapExhausted` flag semantics: session-model exhausts cap → not retried (existing tests `consolidation.test.ts:1582`, `observer-terminate.test.ts`).
- Dropper "cap fired with zero candidates = empty success" documented behavior.
- `.js` extensions in source imports; `tests/` outside tsconfig; no pricing math anywhere.

---

## F2 — completion strictness

### Design

New module **`src/om/agents/completion.ts`** (fork put it in `input-budget.ts`; that file is
pricing-heavy and not ported):

```ts
export function agentCompletionError(
  messages: Message[],
  signal?: AbortSignal,
  completedByTool?: boolean,
): string | undefined;
```

Returns `undefined` (no error) or a reason string. Rules (fork's, plus our fixes):

1. `signal?.aborted` → `"aborted"`.
2. **Reverse-find the last message with a `stopReason`** (fork does this; our current code only
   inspects `msgs.at(-1)` — a terminal `toolResult` has no `stopReason`, so today an
   error/`length` stopReason one step back is silently missed. Upgrade all three agents.)
3. `stopReason in {error, aborted, length, toolUse}` → error, **unless**
   `stopReason === "toolUse" && completedByTool`.
4. Framing stays in the agents: `workerStreamErrorMessage("Observer" | "Reflector" | "Drop", err)`.

### `completedByTool` mapping (our semantics, not fork's raw boolean)

| Agent                                          | `completedByTool` argument                      |
| ---------------------------------------------- | ----------------------------------------------- |
| observer                                       | `closedByCompleteBatch \|\| turnCap?.exhausted` |
| reflector                                      | `closedByCompleteBatch \|\| turnCap?.exhausted` |
| dropper (no complete-close, no terminate tool) | `turnCap?.exhausted`                            |

Rationale (caveat found during analysis): a `toolUse` stopReason set by **our own turn cap** is
already handled by the turn-cap branch. If the completion check ran first (or didn't exempt the
cap), a cap-ended run would throw a plain `WorkerStreamError` with `turnCapExhausted = false`,
which classifies as retryable → **same session model retried → retry storm**, a regression of
"session model that exhausts the cap is not retried". Two mitigations, apply both:

- Pass `… || turnCap?.exhausted` into the toolUse exemption (above).
- **Reorder** the `turnCap` check **before** the `agentError` guard in observer/reflector
  (today agentError is checked first — safe today only because agentError was error-only).
  Verified no case conflicts: hard-exit reasons (`error`, `aborted`) always leave
  `exhausted === false`, so the two branches never both claim a case.

Dropper specifics: `if (agentError) throw` stays unconditional (no kept-close). Cap + zero
candidates still reaches the existing empty-success path because `exempt(toolUse)` makes
`agentError` undefined. Genuine terminal-`toolUse` **without** cap/complete-close is the new
failure — coverage must not advance as "empty" when the model still had tool work pending.

`length`/`aborted` treated as ordinary retryable `WorkerStreamError` (no deterministic 4xx codes
→ no cooldown storm beyond the existing bounded retry; `aborted` when the generation was
cancelled is additionally short-circuited by `isGenerationActive` right after the attempt).
Open question, default = keep simple: do **not** set `turnCapExhausted` for `length` (a
different fallback model may allow more tokens; the fork doesn't either).

### Where `signal` comes from

`args.signal` (the per-attempt controller passed by `runWorkerAttempt`). Interaction checked:
the attempt timeout aborts that signal and settles the attempt promise first, so the agent's
later `agentCompletionError("aborted")` throw is absorbed by the settled attempt (`.then` handlers
already attached) — no double-settle, no unhandled rejection.

---

## F2b — never-throw-from-streamFn

- Production `streamFn` = bridge (`createBridgeStreamFn`): steps 1/3/4
  (`modelRegistry.streamSimple`, custom fns) can throw **synchronously**; `runAgentLoop` is
  `void`-ed with no `.catch()` in host `agent-loop.js` → sync throw = unhandled rejection = pi
  process death (fork's `budget-stream-crash` finding; their fix was tied to `budgetedStream`,
  ours is a standalone wrapper).
- Add to `src/om/provider-stream.ts` (natural home: already owns the stream-fn factory):

  ```ts
  export function neverThrow(streamFn: StreamFn): StreamFn;
  ```

  Wraps the **final** `streamFn` inside each worker agent
  (`const streamFn = neverThrow(args.streamFn ?? createBridgeStreamFn(...))`). Sync throw →
  return a refusal stream built with `createAssistantMessageEventStream` (exists in installed
  pi-ai) that pushes `{type:"error", error: String(err)}` then ends with
  `{stopReason:"error", errorMessage:String(err)}`. The agent's completion check then turns it
  into the normal `WorkerStreamError` → stage fallback. Port the essence of fork's
  `budget-stream-crash.test.ts` as a unit test.

- **No per-turn budget recheck** inside `streamFn` — that requires measurement/pricing (tier 3,
  out). The "existing estimate math" pre-flight guard in `runObserverStage` stays as-is.
- Caveat: verify against `tests/provider-stream.test.ts` — wrapping only the bridge output must
  not change shapes tests assert on.

---

## F1 — coverage cursor (oldest-first prefix + bounded drain)

### Core invariant

> `coversUpToId` = id of the **last actually-sent** source entry
> (`prepared.sourceEntryIds.at(-1)`, not `chunkEntries.at(-1)`), and the cursor advances only
> to that id. Delivered ⇒ covered; never-delivered stays in the backlog.

Derivation of safety without porting measured-prompt fit: the pre-flight guard either passes
(whole chunk sent in one user message → all covered) or the model is skipped (no advance);
exhausted attempts → `"abort"` with cursor untouched. Multi-turn growth overflow → provider
error stream → `WorkerStreamError` → no advance. Same guarantee the fork got via
`InputBudgetError`, without their abort semantics.

### Changes in `src/om/consolidation.ts`

1. **`capSourceEntriesToTokens` → first-prefix** (currently newest-first suffix):
   keep entries from the start until the budget is exhausted; keep a single oversized first
   entry (fork behavior — an entry bigger than the budget is still taken so the cursor can
   make progress _if_ a model fits it; if none fits, attempts exhaust → abort, cursor stuck —
   known limitation, identical to fork, document in CHANGELOG/docs only if asked).
   - Flip is the load-bearing fix: with a suffix, `coversUpToId = last sent` still pointed at
     the tip while older entries stayed unsent. With a prefix, `chunkEntries.at(-1)` _is_ the
     frontier.
2. **`coversUpToId = sourceEntryIds.at(-1) ?? …`** — derived from post-serialization ids.
   Entries skipped by the serializer (empty render: thinking-only, placeholder bodies) are
   covered without being sent; they contain nothing observable, accepted and documented.
3. **Drain**: in the two success paths (`"recorded"` and empty-diagnosis), replace
   `return "continue"` with `return continueSources()`:
   ```ts
   const continueSources = () =>
     coversUpToId && coversUpToId !== sourceEntriesOfSnapshot.at(-1)?.id && drainRemaining > 0
       ? runObserverStage(
           pi,
           runtime,
           ctx,
           generation,
           resolveModel,
           /*drain*/ true,
           drainRemaining - 1,
         )
       : "continue";
   ```
   - New optional params after `resolveModel` (existing tests call with 5 args — safe):
     `drain = false`, `drainRemaining = OBSERVER_DRAIN_MAX_BATCHES` (**ceiling: 3** module
     constant, not config — config surface churn breaks the example-config completeness test
     and docs gates).
   - `drain = true` bypasses only the `tokens < observeAfterTokens` early return (fork
     behavior). Everything else (generation active, manual pending-skip, serialization,
     attempts loop, fallback) runs per batch.
   - Recursion, not iteration — matches fork, keeps `runObserverStage`'s single-exit shape.
   - Termination proof: each recursion strictly advances the cursor (both success paths call
     `advanceCursor` first) or exits (`!coversUpToId` → return; zero-chunk/empty-tail →
     `sourceEntryIds.length === 0 → return "continue"` **before** the attempts loop, so the
     "trailing entry that renders empty forever" case makes at most one no-op batch and no
     model call → no infinite recursion even without the ceiling; the ceiling covers the
     ordinary huge-backlog case: 4 batches × `observerChunkMaxTokens` per pipeline run, the
     remainder waits for the next `turn_end` with the cursor sitting at the delivered point —
     delay, never loss).
   - Drain condition reads the stage-start `entries` snapshot (`filter(isSourceEntry)`); a
     marker appended mid-run isn't a source entry and entries arriving after the snapshot
     belong to the next run. Recursion re-fetches the branch → sees the advanced cursor.
   - Error inside a drain batch: propagates as today (`"abort"`), cursor already at the
     previous batch's delivered point → no loss.
   - Manual mode: each drain batch saves its own pending observation with its own
     `coversUpToId` → `isObservationChunkPending` compares different ids → no false skip.
   - The `!data` (invalid record) path keeps a plain `return "continue"` (fork parity);
     backlog below threshold is still counted by `rawTokensAfterIndex` next run → fires later.
     No loss either way.
4. **Performance**: recency delay for the newest entries is bounded by the drain ceiling
   (normally zero — a run drains to the tip); CHANGELOG notes the ordering flip (chronological
   batches instead of newest-first).

### Config guard (Tier 1)

- Site: `loadUnifiedConfig` in `src/core/unified-config.ts` (has `onWarn?: WarnFn` → UI
  notify; `console.warn` is the established fallback pattern — `parseConfig` uses it).
- Condition: `observeAfterTokens > observerChunkMaxTokens` → warn, non-fatal, message
  explains observation fires in multiple batches per trigger.
- Deliberately **warn, not clamp**: post-F1 this combination is loss-free (drain covers it),
  so silently rewriting the user's threshold would be worse than informing them. A silent
  clamp would also surprise anyone who _wants_ a high trigger with batched drains.
- Not in `normalizeThresholdKnobs` — that function only scrubs (deletes) values, never warns;
  cross-key checks belong at the load site.

---

## Tests (T1 red-first, T3 branches, T4 specific tokens, T5 one behavior, T6 finally/after)

Order below = implementation order; **each test is written and observed red against untouched
code before its fix lands.** No reverting/stashing to demonstrate red.

1. **F2 completion** — new `tests/worker-completion.test.ts` (adapt fork
   `tests/om-batch-safety.test.ts:75-83`, bun → vitest), `scriptedLoop` pattern from
   `reflector-stream-error.test.ts`, run against the three real agents:
   - `length` terminal → throws, message contains the **unique token**
     `Incomplete agent response (length)` framed per agent (`T4`).
   - `aborted` terminal → same with `(aborted)`.
   - terminal `toolUse` without complete-close and without cap → throws (dropper: cap
     exhausted with candidates → existing turn-cap error **unchanged**; cap exhausted with
     zero candidates → existing empty success **unchanged** → `T3` branch cases).
   - `toolUse` with `closedByCompleteBatch` → kept-close success (existing tests stay green).
   - `signal.aborted` → throws `aborted`.
   - last message is a `toolResult` behind an `error` stopReason → throws (proves the
     reverse-find upgrade; red against current `at(-1)` code → `T1`).
   - Zero-record `length` close → throws with count 0 (existing "empty close still throws").
2. **F2b** — unit test `neverThrow`: sync-throwing fn → refusal stream with `stopReason
"error"`; plus an agent-level test that a bridge sync throw surfaces as `WorkerStreamError`
   (fork `budget-stream-crash` essence).
3. **F1 cap semantics** — rewrite `tests/consolidation.test.ts:1859-1965` `capSourceEntriesToTokens`
   block to prefix expectations (e.g. `["cm-1","cm-2","cm-3"]` instead of
   `["cm-3","cm-4","cm-5"]`; fix the comment at :1962). Flip first → red → implement → green.
4. **F1 stage-level** — extend `tests/consolidation.test.ts` / new
   `tests/observer-coverage.test.ts` (adapt fork `om-input-budget.test.ts:23`, keep only the
   coverage test, no pricing):
   - backlog > `observerChunkMaxTokens` → first batch's arg contains only the **oldest
     prefix** (`observerChunkArg()` helper) and cursor = last sent id, **not** branch tip
     (red against current newest-first code).
   - same run drains to the tip; final cursor = last source entry; below-threshold remainder
     still drained (bypasses `observeAfterTokens`).
   - drain ceiling: huge backlog → at most `OBSERVER_DRAIN_MAX_BATCHES + 1` runObserver calls
     per pipeline run; cursor at last delivered entry; undelivered entries still present in
     backlog (`T3`: covered vs uncovered branch).
   - drain stops on failure: batch 2 fails all attempts → `"abort"`, cursor at batch 1's
     delivered point (no coverage of undelivered).
   - empty-render trailing entry → no infinite recursion, no extra model call.
5. **Config guard** — `loadUnifiedConfig` with `observeAfterTokens > observerChunkMaxTokens`
   → warn fired with unique token; equal/below → no warn (`T3` two cases). Spy +
   `vi.restoreAllMocks` in `afterEach` (`T6`).
6. **Regression sweep**: full `pnpm test` — named risks:
   - cap-block rewrite (item 3) is the only _expected_ red-to-green flip;
   - `observer-anchor`, `big-1` chunk tests, zero-chunk backoff, manual pending,
     `turn-cap`, `dropper-stream-error`, `provider-stream` must stay green untouched —
     any new drain recursion or completion error there means the design is wrong, not the test.

## Implementation order

1. F2: `completion.ts` + three agents (reorder turnCap, `completedByTool` mapping) — tests item 1.
2. F2b: `neverThrow` in `provider-stream.ts` — tests item 2.
3. F1: cap rewrite + `coversUpToId` + drain — tests items 3–4 (rewrite existing block first).
4. Config guard — tests item 5.
5. `pnpm check` + `pnpm test`; CHANGELOG `## [Unreleased]` entries (ordering flip, coverage
   fix, completion strictness, never-throw wrapper, config warning); docs touch only if
   `docs/observational-memory.md` describes the cap order (check during step 3).
6. Conventional commit(s), e.g. `fix(om): never advance observer coverage past unsent entries`
   and `fix(om): treat length/aborted/terminal-toolUse as worker failures`.

## Residual risks (accepted, noted)

- **Retry churn on `length`**: classified retryable, bounded by `MAX_STAGE_ATTEMPTS = 10`;
  accepted (fork identical); not marked `turnCapExhausted` so fallback models stay possible.
- **Single oversized first entry** with no model that fits it → attempts exhaust → abort,
  cursor stuck (fork identical). Config-level remedy only.
- **Drain latency**: up to 3 extra full attempt-loops per pipeline run (model resolution
  included); bounded by design.
- **Recency delay**: newest entries may land in a later batch when the cap engages;
  chronological order is the deliberate trade for correctness.
- **Existing cap tests encode the old contract**: they will be _changed_, not just added
  around — flagged explicitly so review doesn't read it as test tampering.
