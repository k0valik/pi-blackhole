# Mid-Run Compaction

How Blackhole keeps auto-compaction working during (not just after) agent runs — the two trigger paths, the non-aborting inline mechanism, why the `agent_end` deferral ceremony exists, and how to debug it.

Audience: users configuring `midRunCompaction`, extension authors running subagents, and anyone reading a `debug.ndjson` full of `compaction_trigger.*` events.

> **Last verified:** 2026-09-21 against repo rev `b4e0591` and pi `@earendil-works/pi-coding-agent` 0.87.0 (bundled-host discovery also re-checked against 0.86.1 and 0.85.1). House rule: any claim of the form "Pi does not expose X" in `docs/` must cite the pi version it was checked against — re-check the vendored pi type surface before repeating one.

See also: [[CONFIG.md]] (`midRunCompaction` reference), [[vcc-compaction.md]] (the summary pipeline itself), [[APPEND_COMPACTION.md]] (append-mode summary chains), [[observational-memory.md]] (the OM pipeline that shares the runtime).

## The problem this solves

Pi fires `agent_end` only when a run **exits**. While the agent loops through tool calls, only `turn_start`/`turn_end` fire. A long autonomous run can exceed `compactAfterTokens` many times over without a single threshold evaluation; the only mid-run safety net left is Pi core's overflow-triggered compact-and-retry — i.e. the configured threshold does nothing until the model actually overflows. The `agent_end`-only behavior also defers under continuous interactive use, because the post-run idle wait is aborted by the next `agent_start` ([#31](https://github.com/k0valik/pi-blackhole/issues/31), [#38](https://github.com/k0valik/pi-blackhole/pull/38)).

Blackhole therefore evaluates the threshold on **two paths**:

| Path | Event | When it helps |
|---|---|---|
| Settled compaction | `agent_end` | The run has exited. Uses Pi's interrupting `ctx.compact()` after the agent settles. |
| Mid-run compaction | `turn_end` | After each assistant message + tool-execution cycle, while the run is still active. Mode-dependent. |

## Why `ctx.compact()` needs ceremony (the settling problem)

Pi's `AgentSession.compact()` begins with an internal quiesce: `await this.abort()` plus `_disconnectFromAgent()`. Called at `agent_end`, that abort **propagates through the run signal** — anything still in flight (other extensions' async `agent_end` handlers, e.g. pi-rewind's checkpoint I/O, or a queued next turn) is cancelled as if the user had pressed ESC. This is not an edge case; it is the documented contract of the public API.

Consequences, all visible in the source:

- The settled path schedules a deferred microtask and **polls `ctx.isIdle()`** (200ms cadence, 50ms abort-sensitive slices) until the agent truly settles before calling `ctx.compact()` [[src/om/compaction-trigger.ts]]. The `setTimeout(0)` yield exists so other `agent_end` listeners run first.
- A new `agent_start` **aborts the pending wait** (`runtime.autoCompactionController`) — a user typing during the wait must never be interrupted by compaction; the new run's own `agent_end` re-evaluates.
- A session identity check inside the wait loop bails on session replacement (`/resume`, `/new`).
- The `agent_settled` event was proposed (in [#38](https://github.com/k0valik/pi-blackhole/pull/38)) as a Pi-side fix that would remove the polling entirely. **Correction:** `agent_settled` does exist in every pi version Blackhole supports (verified in the vendored pi 0.85.1 type surface; semantics per pi's own docs: fired when the run has ended *and* no auto-retry, auto-compact, or queued continuation will run). Migrating the settled path onto it remains future work — it would delete the `isIdle` poll and the `RETRYABLE_ERROR_RE` heuristic — but it is a behavior change that needs its own tests and soak, and `agent_settled` emission for headless/in-memory sessions must be verified first, not assumed. Until then, the poll is the workaround.

**The inline path needs none of this ceremony**, because it never calls `ctx.compact()` — see the adapter section below.

## History

The mechanism was rebuilt twice; knowing which era produced a behavior helps when reading old issues.

1. **`agent_end` only** — original behavior. Threshold effectively decorative under continuous use ([#31](https://github.com/k0valik/pi-blackhole/issues/31) reported the `not_idle` bail; fixed by the wait-then-compact poll).
2. **`turn_end` via abort + synthetic resume** ([#38](https://github.com/k0valik/pi-blackhole/pull/38)) — evaluated the threshold at `turn_end`, called the aborting `ctx.compact()`, then injected a `blackhole-resume` custom message with `triggerTurn` to restart the task. Default `"resume"`.
3. **Subagent breakage** ([#40](https://github.com/k0valik/pi-blackhole/issues/40)) — the abort propagated into subagent extensions on both sides: parents stalled until ESC; child runners were aborted mid-run, their partial progress reported to the parent as `completed`, and orphan child sessions kept writing after the parent moved on. Default flipped to `"off"` until Pi offered a non-aborting path.
4. **The inline adapter** (a4da099, "compact mid-run without aborting active runs") — `"resume"` reimplemented without abort: Pi's native compaction pipeline runs **inline from the awaited `turn_end` handler**, the compaction method's internal quiesce is **suppressed**, the low-level loop is refreshed from the compacted messages, and execution **continues inside the original `session.prompt()` promise**. No abort, no synthetic message, no detached run. Hardening followed: the `Working` indicator restoration ([#52](https://github.com/k0valik/pi-blackhole/issues/52)), exponential backoff for failed attempts (1s → 30s cap), and permanent-vs-retryable unavailability classification. **Thirty minutes later the same author flipped the default back** (7d7197b, "harden inline compaction adapter"): default → `"off"`, with `"resume"` relabeled an experimental opt-in. The current `"off"` default is therefore **twice-decided** (#40's breakage + adapter-hardening caution), not an oversight — do not "restore" `"resume"` as a default. The pinning test lives at `tests/config-simplification.test.ts:70` (`midRunCompaction` defaults to `"off"`); a future default flip breaks it loudly.
5. **Eligibility + host binding** — eligibility checks (host `prepareCompaction` + the session's effective settings) were added to every trigger path in [#86](https://github.com/k0valik/pi-blackhole/pull/86); [#98](https://github.com/k0valik/pi-blackhole/pull/98)/[#99](https://github.com/k0valik/pi-blackhole/pull/99) then made discovery reliable on Pi's unbundled layout and bound each host's helper per session, so a session never borrows another host's helper.
6. **Non-persisted sessions** ([#92](https://github.com/k0valik/pi-blackhole/issues/92)) — in-memory subagent/SDK sessions disposed right after `agent_end` always lost the deferred-compaction race (stale-ctx bail, silently). Now: scheduled auto-compactions lost to a stale ctx are counted + warned once per session, non-persisted sessions resolve every `midRunCompaction` value to the inline path at `turn_end`, and a non-persisted session with an unsupported adapter skips the settled `agent_end` path too (fail-closed, `inline_adapter_unsupported`).

## The inline adapter (what makes mid-run safe)

Entry points: [[src/om/inline-compaction.ts]] (`compactInlineAtTurnBoundary`, `installHostInlineCompactionAdapter`). The adapter wraps the host's own compaction so the run is not interrupted:

- **Host discovery at startup**: stack frames of the entrypoint are resolved to pi package roots; per root, the already-loaded bundled runtime chunk is tried first (~0–10ms), falling back to the modular `dist/index.js` barrel (~400–500ms) only when the chunk does not export `AgentSession`. Discovered hosts are patched at the class prototype level (`_bindExtensionCore`), so every session instance — including in-memory ones — is captured.
- **Per-host helper binding**: each discovered host binds its own `prepareCompaction`; a session never borrows another host's helper for eligibility checks.
- **Quiesce suppression with a verified invariant**: during the inline attempt, the session's `abort` (and `disconnect` on older shapes) is intercepted and suppressed; if the compaction internals did not invoke the expected hooks, the attempt **throws instead of proceeding** — no half-suppressed state.
- **Boundary validation**: unpaired tool calls in the active branch abort/reject the attempt before any mutation; completed tool calls must stay paired for provider replay.
- **Fail-closed shapes**: only known Pi compact shapes are recognized — `compact()` must call `this.abort()` exactly once, reference `appendCompaction`, and repoint `agent.state.messages` at the finalized context, either inline (0.81 legacy, 0.84 connected-listener, 0.85/0.86) or through a method defined on the class's own prototype, one call level deep (0.87's `_refreshFinalizedContext()`). Inherited helpers and deeper indirection stay fail-closed. Internal drift → `InlineCompactionUnavailableError`, the current run stays alive, and the mode degrades (see matrix below). It never falls back to the abort + `blackhole-resume` path.
- **Eligibility**: before any mid-run attempt, `isCompactionEligible` consults the host's `prepareCompaction` with the session's effective compaction settings (`enabled`, `reserveTokens`, `keepRecentTokens`). Ineligible (e.g. "Nothing to compact (session too small)" territory) → skip, no LLM call, no backoff ([#86](https://github.com/k0valik/pi-blackhole/pull/86)).

## Config matrix

Effective behavior per session kind. The shared gates — `compaction: off/manual`, legacy `passive`/`noAutoCompact`/`overrideDefaultCompaction`/`compactionEngine` guards, `compactInFlight`, threshold, retry backoff, eligibility — apply identically on both paths. The aborted-run-signal check (`signal.aborted`) exists **only on the `turn_end` path**; the settled path instead relies on the `isIdle()` wait and the `agent_start` abort of the pending wait. Every permutation therefore stays coherent, with the mode decision made after the shared gates:

| `midRunCompaction` | Persisted (TUI, file-backed) | Non-persisted (`SessionManager.inMemory()`) |
|---|---|---|
| `"resume"` | Transparent inline compaction at `turn_end`; same-run continuation | Transparent inline compaction at `turn_end` |
| `"pause"` | Interrupting `ctx.compact()` at `turn_end`; run stops, user continues | **Inline** (an interrupting compact has no user to hand control back to) |
| `"off"` *(default)* | `turn_end` skipped; settled `agent_end` path only | **Inline** at `turn_end` (see [#92](https://github.com/k0valik/pi-blackhole/issues/92)) |

Why the non-persisted column collapses to inline: those sessions are typically disposed by their parent right after `agent_end`, so the deferred settled compaction reliably loses the race and bails on a stale ctx — under `"off"` they would never compact; and `"pause"`'s run-interrupting compact is pure [#40](https://github.com/k0valik/pi-blackhole/issues/40) child-side breakage headless. Persisted sessions never change semantics.

The settled `agent_end` path remains unchanged for persisted sessions, and serves as the backstop for pressure that only crosses the threshold on a run's final turn (where no further `turn_end` occurs).

### Threshold

Derived per evaluation (issue [#60](https://github.com/k0valik/pi-blackhole/issues/60)): the `compactAfterBy` shape (`preset` curve, `percent` × window, fixed `tokens`, or `window − reserve`) clamped to `compactAfterMinTokens` / `compactAfterMaxTokens`. A legacy file-level `81000` is treated as scaffold residue and dropped. The threshold is re-derived on every event, so a mid-session `/model` switch is picked up on the next check.

### Retry / backoff

Failed mid-run attempts back off exponentially (1s, 2s, … capped at 30s) so a persistent failure doesn't thrash the run at every turn. Successful compactions and pressure relief reset it. Adapter unavailability is classified once as permanent and never retried at that pressure level.

## What users see

- `info` notices (one per turn, gated): threshold reached, compaction complete/paused.
- `warning` notices: mid-run compaction unavailable (once per process), scheduled compaction skipped due to a stale ctx (once per session). Both are UI-only (`ui.notify`): headless sessions (subagents, flows) have no channel back to the operator — a `console.warn` would leak into the subagent transcript where nothing can act on it, and the parent session cannot be reached without knowing which subagent host is in use. Headless operators must watch `debug.ndjson` (`inline_adapter_unsupported`, `inline_adapter_unavailable`, `microtask.bail { reason: "stale_ctx" }`) instead.
- `/blackhole-memory` status: `Skipped compactions (disposed ctx): N` — process-wide counter of stale-ctx skips, so a parent TUI surfaces nested in-memory session skips. Line appears only when nonzero.
- After a mid-run inline compaction, Pi's native `Working` indicator is restored while the run continues ([#52](https://github.com/k0valik/pi-blackhole/issues/52)).

## Debugging

Enable with `debugLog: true` → `~/.pi/agent/pi-blackhole/debug.ndjson`. The event vocabulary (prefix `compaction_trigger.`):

| Event | Meaning |
|---|---|
| `agent_end` (event) | Settled-path evaluation started. Its skips emit as **`compaction_trigger.skip`** (no `agent_end.skip` event exists) with `reason`: config guards, `compactInFlight`, `below_threshold`, `mid_run_retry_backoff`, `not_eligible` |
| `turn_end.skip` | Mid-run evaluation skipped; same gate family plus `midRunCompaction_off`, `active_run_aborted`, `inline_retry_backoff`, `inline_adapter_unsupported` |
| `threshold_reached` | Pressure crossed (settled path carries `tokens`/`sessionId`/`hasUI`; mid-run carries `tokens`/`threshold`/`mode`/`nonPersisted`) |
| `scheduled` / `microtask.*` | Settled path: deferral armed; `idle_check`, `session_check`, `recheck_tokens`, `bail` (`aborted_agent_start`, `session_changed`, `pressure_relieved`, `not_eligible`, **`stale_ctx`**) |
| `calling_compact` / `onComplete` / `onError` | `ctx.compact()` lifecycle |
| `inline_complete` / `inline_error` / `inline_adapter_unavailable` | Inline attempt lifecycle |

Common symptoms:

- **`microtask.bail { reason: "stale_ctx" }`** on a session with no file under `~/.pi/agent/sessions/` — an in-memory session disposed by its parent before the deferred compaction ran. This used to be fully silent; it is now counted and warned once per session. If the parent is a subagent/SDK flow, the non-persisted `turn_end` fallback should have compacted earlier — check for `inline_adapter_unsupported` (adapter couldn't discover the host) which fail-closes to skips.
- **`turn_end.skip { reason: "inline_adapter_unsupported" }`** every turn while over threshold — the adapter never became available for this host. Only surfaced once via the startup warning; per-turn skips are debug-logged deliberately (they would inflate a counter denominated in scheduled compactions).
- **`inline_retry_backoff`** repeating — the inline attempt keeps failing (e.g. provider errors); backoff self-heals, but check `inline_error` messages for the root cause.
- **Parent saw a truncated `completed` subagent result** — the #38-era abort mechanism. Should be impossible on the inline path; if reproducible, it is a regression and needs the reproduction steps from [#40](https://github.com/k0valik/pi-blackhole/issues/40).

## Verification boundary

The trigger paths and adapter are covered by unit tests against synthetic hosts and captured-handler harnesses (see `tests/compaction-trigger.test.ts`, `tests/inline-compaction.test.ts`). Synthetic doubles cannot reproduce live runner-lifecycle dynamics — the #38 → #40 history is the proof. **Standing rule:** any change that alters when or how compaction runs against a live runner (new trigger path, new session-kind gate, mechanism swap) must be soak-tested on real subagent/flow traffic before release, with the [#40](https://github.com/k0valik/pi-blackhole/issues/40) symptom list as acceptance criteria: no truncated `completed` results, no orphan continuations, no parent stalls.
