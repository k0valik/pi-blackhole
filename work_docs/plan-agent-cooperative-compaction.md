# Proposal: agent-cooperative compaction — implementation plan

**Status:** proposal for review, not an approved implementation specification. No runtime changes accompany this document.

**Companion:** [proposed behavioral specification](spec-agent-cooperative-compaction.md). Read the decisions below first; the specification uses the recommendations as provisional defaults.

**Baseline reviewed:** Blackhole `c20421e` on `dev`; installed Pi **1.4.0**; declared Pi peer range `>=0.85.1 <2.0.0`. Investigation date: 2026-11-02.

## Decisions needed from you

| ID  | Decision                                                                                                 | Recommendation and consequence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Is this an experiment, or new default behavior?                                                          | **Experimental opt-in; existing behavior unchanged when off.** One setting, provisionally `agentCompaction: "off"                                                                                                                                                                                                                                                                                                                                                                                                             | "tool" | "cooperative"`, default `"off"`. `tool`exposes the tool without pressure notes;`cooperative` adds pressure notes. Names and enum are proposed, not existing config. |
| D2  | Can an explicitly enabled agent request compact mid-run when `midRunCompaction` is `"off"` or `"pause"`? | **Yes, using the non-aborting inline path for accepted agent requests only.** Enabling this feature explicitly authorizes that path; ordinary threshold compaction keeps its existing mode. Never turn an agent request into an interrupting pause. Alternative: require `midRunCompaction: "resume"`, at the cost of two settings to enable one workflow.                                                                                                                                                                    |
| D3  | Tool only, or also parse a text marker?                                                                  | **Tool only in the first release.** Put the handoff in the tool arguments. Specify the marker alternative now, but do not enable it until its completion/continuation semantics are chosen. A marker in a final reply cannot by itself promise another model request.                                                                                                                                                                                                                                                         |
| D4  | When should the preparation note appear?                                                                 | **A threshold-relative trigger plus window/headroom safeguards**, not an unconditional 70% rule. Proposed starting points: 85% of Blackhole's effective threshold, 70% of a known effective window, or approaching the host's reserved-capacity boundary. See the specification's formulas and size table. In particular, a small window may need preparation much earlier than 70%; a 1M window with the current preset should prepare around 34%, not 70%. These constants require evaluation before promotion to defaults. |
| D5  | May preparation delay normal threshold/overflow compaction?                                              | **No.** Early preparation is best effort. If the model ignores the note, or a tool result jumps past the window, normal compaction wins immediately. No mandatory grace turn, no blocking wait for a handoff, and no additional run after a genuinely final answer. This means not every compaction has a fresh self-handoff.                                                                                                                                                                                                 |
| D6  | How long should the agent's checkpoint survive?                                                          | **Keep only the latest successfully committed checkpoint**, normally carrying it across later Blackhole compactions until a newer checkpoint replaces it. Label it as an older agent-authored snapshot; later user instructions/transcript override it. Never accumulate checkpoints. D10 defines the capacity emergency exception. Alternative: include it only in the immediately resulting compaction, with less stale-state risk but weaker continuity.                                                                   |
| D7  | Should agent compaction work in `manual`/`off`, with Pi's engine, or for skipped providers?              | **No in v1.** Require Blackhole automatic-compaction ownership and normal provider eligibility. `/blackhole` remains the explicit human override. Do not advertise a tool that silently bypasses these settings or takes over another compactor.                                                                                                                                                                                                                                                                              |
| D8  | Fold the old settled-hook migration into this work?                                                      | **Yes, as a separately testable lifecycle phase.** Replace `agent_end` polling with `agent_settled` after host-backed race tests. Keep `turn_end` + the inline adapter for mid-run. Do not combine this with a switch to native compaction drafts. See §5; the old settled plan is not safe to follow verbatim.                                                                                                                                                                                                               |
| D9  | Extra inference or background jobs?                                                                      | **None in v1.** Ask the existing agent during an otherwise-needed request. No second summarizer, provider-payload capture, cache-warmup request, or forced synthetic continuation. The handoff costs some normal-agent output tokens; VCC remains deterministic.                                                                                                                                                                                                                                                              |
| D10 | What if an older checkpoint prevents safety compaction, e.g. after switching to a smaller model?         | **Ordinary safety recovery may omit the old checkpoint from model projection**, preserving its text/provenance as inactive historical metadata and logging why. Do not truncate protected source history instead. A fresh cooperative request that cannot preserve its handoff fails honestly; ordinary recovery can then proceed without that fresh checkpoint. This narrows D6 rather than letting checkpoint retention wedge overflow recovery.                                                                            |

**Most consequential choices:** D2 (permission boundary), D3 (marker semantics), D4 (injection boundaries), and D6 (checkpoint lifetime). Approving the general idea need not approve the numerical defaults.

## 1. Intended result and non-goals

The model can supply a tiny working-state checkpoint at a deliberate task boundary, then request early compaction. After a safe tool-complete boundary, the same run continues with:

1. Blackhole's normal deterministic VCC summary and recall references;
2. current observational memory, when enabled;
3. the latest agent-authored checkpoint, especially remaining work and immediate next action;
4. the retained raw tail selected by the existing policy.

**Mid-run operation is required, not an optional settled-only approximation.** Parent/child promise identity, pending tool calls, cancellation, and same-run continuation must remain correct. A session that can only compact after the run exits does not meet this requirement.

This does not replace `compile()`, invent an LLM summarizer, change tail defaults, change OM observation coverage, promise provider cache hits, migrate all runtime state, or change `midRunCompaction`'s default. It also does not guarantee that the model writes a handoff before every automatic/overflow compaction.

“Final message survives” is best implemented as **an explicitly preserved handoff payload**, not a promise that the terminal's last arbitrary assistant message stays verbatim. In the recommended tool flow, the payload is the `handoff` argument of `compact_context`; there is no need for a separate final assistant reply before the call.

## 2. What was reviewed

### Blackhole

Read the requested documents in full:

- `docs/mid-run-compaction.md`;
- `docs/architecture.md`;
- `docs/vcc-compaction.md`.

Also reviewed `docs/APPEND_COMPACTION.md`, the existing `work_docs/plan-compaction-agent-settled.md`, and the relevant source contracts:

| Component                                                         | Relevant finding                                                                                                                                                                                                           |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                                                        | Adapter installation is eager; registrations share a runtime. New tool/hook registration must preserve startup ordering.                                                                                                   |
| `src/om/compaction-trigger.ts`                                    | Current `turn_end` uses the inline adapter in resume/non-persisted modes; persisted `off` skips. `agent_end` schedules an idle poll. Gates, threshold derivation and backoff already exist.                                |
| `src/om/inline-compaction.ts`                                     | An inline attempt must run after tool completion. Trailing unpaired calls are rejected. Recognizes the installed 1.4.0 compact shape; preserves the host compaction pipeline and original run.                             |
| `src/hooks/before-compact.ts`                                     | Owns cut selection, VCC, global recall indices, OM, retained-output projection, append details, pressure fallback and final capacity checks. Reuse it.                                                                     |
| `src/core/summarize.ts`                                           | `compile()` does not preserve arbitrary new sections across merges. `Outstanding Context` is intentionally fresh-only. Do not rely on accidental textual preservation.                                                     |
| `src/core/compaction-chain.ts`, `src/hooks/compaction-context.ts` | Append mode replaces an exact matching fallback summary with immutable segments plus one mutable trailing message. A handoff must be represented in both fallback and trailing projections, not frozen into every segment. |
| `src/om/ledger/progress.ts`, `src/om/model-budget.ts`             | Pressure is usage-anchored when possible, estimate-based otherwise. The effective threshold is derived per evaluation, with model-specific window overrides and a size-dependent preset curve.                             |
| `src/om/runtime.ts`                                               | Some existing flags are shared. New requests must be keyed to session identity and branch/generation, not one global pending string.                                                                                       |
| `src/hooks/cosmetic-output.ts`                                    | A display-only pre-compaction copy is not model context. It cannot provide the handoff guarantee.                                                                                                                          |

The architecture overview is incomplete about current hook registrations; it should be corrected during eventual implementation documentation, not used as an exhaustive event map.

### External prefix-cache repository

Cloned into **`/tmp/pi-prefix-cache-compaction`**, reviewed at commit **`27dd09ef7c96d867e21298574fedb59ccdfc6f06`**, package version `0.6.0`:

<https://github.com/jagdeepsinghdev/pi-prefix-cache-compaction>

Reviewed `README.md`, `src/index.ts`, `src/core.ts`, tests and smoke-harness descriptions. Its mechanism is different from this proposal:

- Capture the real provider request, append a summary instruction without changing its prefix, and stream a separate LLM summary.
- Optional background work starts at 70% of the window; the summarized request is anchored to session entries and everything after its boundary is retained.
- Optionally pre-warm the projected post-compaction context.
- Check model identity, stale captures, branch anchors, room for summary output, cancellation, and whether a background summary has become too old/large to use.

**Reuse the principles**, not the implementation: early preparation, identity/branch anchoring, bounded freshness, no duplicate work, and validating the complete post-compaction context. Its 70% default is not evidence that 70% fits Blackhole's threshold presets or every context size. Its performance measurements apply to its separate summarizer, not this feature.

**Do not port** wire-format request replay, HTTP/SSE/auth handling, full-payload persistence, warm-up requests, or a background LLM job. Blackhole already produces its main summary without an LLM call. Running both extensions as competing summary owners is not a supported composition for this proposal.

Verification performed: `node --test test/core.test.ts` in the clone: **40 passed, 0 failed**. A preceding `pnpm --dir ... test` invocation attempted dependency auto-install and failed its ignored-build policy before running tests; the direct Node suite above then succeeded. No real provider/cache experiment was run.

### pi-vcc PR #62

Reviewed the open PR, its metadata and full diff at head **`b9e54e266a24ce655ba8d0c2b45f5b80a9e82ce0`**:

<https://github.com/sting8k/pi-vcc/pull/62>

At review time there were no issue comments, inline comments or submitted reviews returned by GitHub. The PR is not a merged compatibility contract. It includes the shared-builder extraction from stacked PR #61.

Useful ideas:

- opt-in `compact_context` tool;
- tool records intent rather than compacting inside `execute()`;
- execute at a complete turn boundary;
- use the same summary construction as normal compaction;
- refuse invalid/empty compactions without discarding context.

Do **not** copy these details uncritically:

- The PR's single closure-level pending string is not sufficient for Blackhole's session/lifecycle requirements.
- Its optional instructions are a leading textual line that the next merge intentionally drops; that is not a durable self-handoff design.
- Its boundary cut is its own policy, not Blackhole's tail/OM/pressure policy. Advancing a cut forward past a tool result keeps _less_ history; it is not proof of a minimum recent-token guarantee.
- Its active-tool “self-heal” can override deliberate user loadouts. Do not force-enable tools the user explicitly disabled, or assume one process-wide repair covers multiple sessions.
- Native boundary compaction drafts skip important host hooks, as described next.

## 3. Current Pi changes: what to adopt and what not to adopt

These findings were checked against the installed **Pi 1.4.0 source**, not inferred from the older Blackhole documentation. Historical introduction dates come from Pi's changelog; exercise the oldest supported host in integration tests before release.

### Adopt: `agent_settled` for the settled backstop

Pi's changelog places `agent_settled` in **0.80.4**, below Blackhole's **0.85.1** peer floor. On 1.4.0, `AgentSession._emitAgentSettled` sets `_isAgentRunActive = false` before dispatch; post-run retries, overflow recovery and queued continuations are processed first. It is not a TUI-only event.

Calling public `ctx.compact()` here does not have the `agent_end` self-wait/deadlock problem: `isIdle()` is already true and the extension API starts compaction asynchronously. This is the hook remembered in `docs/mid-run-compaction.md` and `work_docs/plan-compaction-agent-settled.md`.

However, “settled” is a notification, **not an exclusive lock**. Other settled handlers may queue a new run. See §5 for the migration's race gate.

### Retain: the inline adapter for mid-run compaction

`compactInlineAtTurnBoundary()` works with the inspected 1.4.0 compact shape, including `_refreshFinalizedContext()` one level below `compact()`. Existing host-backed tests in `tests/inline-compaction.test.ts` cover the original-run continuation pattern. This review inspected those tests; it did not rerun them or perform a live soak.

Using this adapter preserves `session_before_compact`, `session_compact` and `session_compact_failed`, including Blackhole's existing summary and failure handling. The new feature should use it, not introduce a second compactor.

### Do not adopt here: native boundary `compaction` drafts

Pi >=0.87 adds actionable `turn_end` and `agent_before_settle`: handlers can propose entries and request continuation. PR #62 uses this. On inspected Pi 1.4.0:

- `_applyBoundaryDrafts()` appends the compaction directly; it does **not** invoke `session_before_compact` or emit the normal compaction success/failure hooks.
- The draft path does not perform Blackhole's or the normal compaction preparer's cut selection/tool-pair validation for the extension.
- Entries can commit before a requested continuation is rejected by the final `canContinue` check. A final assistant-text turn does not automatically become a continuable turn merely because a compaction draft was appended.

A public API is desirable, but this path would require rebuilding the integration we already have and explicitly handling different lifecycle semantics. Version >=0.87 alone does not make it a drop-in replacement. Reconsider only with a separately verified host contract that preserves the lifecycle or a deliberate project-wide migration.

`agent_before_settle` is not a substitute for idle settled compaction either: the session still considers the run active. Public `ctx.compact()` can mark that run aborted and suppress the boundary's requested continuation.

## 4. Recommended architecture: one coordinator, one compactor

```text
normal next model request
  context projection -> optional bounded preparation note
  agent -> compact_context({ handoff })
               |
               v
       requestContextCompaction(...)  [validate and stage only]
               |
       paired tool results finish
               |
               v
  existing turn_end coordinator
       request ready? -> inline compaction, even below normal threshold
       otherwise     -> existing mode/threshold behavior
               |
               v
  host native compact pipeline through inline adapter
       session_before_compact
          existing cut + compile + OM
          explicit handoff composition and full capacity accounting
          append details when enabled
       session_compact / session_compact_failed
               |
       same original run continues; no synthetic restart

agent_settled -> ordinary settled backstop, no idle polling
```

### Module boundary

Introduce a small cohesive module, provisionally `src/om/agent-compaction.ts`, responsible for preparation/request/checkpoint state and policy. Its callable request function is used by the tool and, if later approved, the marker handler. This is an internal callable integration point, **not a new public event bus or plugin SDK**.

`compile()` stays the deterministic VCC producer. The handoff is a separately typed component composed alongside VCC and OM in `session_before_compact`. No agent API, scheduling, mutable runtime, or model call enters the pure compile pipeline.

Keep three distinct concepts:

1. **Preparation episode:** an ephemeral note inviting a checkpoint, at most once per compaction cycle.
2. **Pending request:** validated intent for one safe boundary, scoped to a particular session/branch/run; not durable authorization to compact after restart.
3. **Committed checkpoint:** bounded payload on the successful compaction details, recoverable on resume and projected into context. It is data, never a pending action.

No extra on-disk queue is needed for v1. The tool call/result already records the request in session history; persist the accepted checkpoint with the compaction entry. Restart does not replay tool calls as actions.

### Integrate at the existing policy boundary

The trigger must arbitrate pending agent intent and ordinary threshold compaction in **one `turn_end` coordinator**. Do not add a competing compactor handler or assume cross-handler timing. Once the complete tool cycle is persisted, prefer a valid agent request over the threshold branch and publish at most one successful compaction. If fresh-handoff-specific validation/capacity rejects it without mutation, execute any already-due ordinary decision at the **same boundary**, using that decision's existing mode (resume/non-persisted inline, persisted pause interrupting, persisted off no ordinary mid-run attempt). Do not let a handoff-specific veto set backoff that suppresses this fallback; actual adapter/host failures retain normal backoff. Never run parallel attempts. Only the request's normal-threshold and ordinary-mode checks differ (D2).

Record origin independently from the existing `/blackhole` instruction marker. An agent request must not accidentally bypass ownership guards, inherit a manual forced-rebase policy, or be attributed as an explicit human command.

The tool result says **recorded, pending boundary validation**, not unconditionally scheduled or compacted. A later rejection must be visible once on the next otherwise-needed model request, surviving any intervening compaction; do not start a run solely to deliver status. Host failures also use normal failure hooks and diagnostics. Do not make success assertions before the boundary runs.

## 5. Settled migration, folded into this plan

The old `work_docs/plan-compaction-agent-settled.md` remains historical. This proposal supersedes its migration assumptions if approved:

- `agent_settled` is already within the entire declared peer range; an `agent_end` fallback is not justified merely by the 0.85.1 floor.
- Two always-enabled trigger paths are not safe deduplication: `compactInFlight` prevents overlap, not sequential duplicate compactions after a fast completion.
- Do not copy the old tests' unsafe casts/non-null assertions or hardcoded suite counts.

### Proposed migration behavior

1. Keep `agent_start` notice reset/config loading and adapter warnings; separate them from removal of the obsolete idle-wait cancellation logic.
2. Move the settled **compaction decision** to `agent_settled`. Retain any genuinely run-end notice-flush behavior on `agent_end` if required; do not compact there too.
3. Re-evaluate session/branch identity, config ownership, busy/in-flight state, pressure, backoff and eligibility at dispatch, not from the earlier `agent_end` snapshot.
4. Prefer synchronous decision and `ctx.compact()` dispatch inside the settled handler, with **no await before dispatch**. On inspected 1.4.0 the initial abort decision then happens before deferred settled actions start a new run. A single idle check may defensively reject a genuinely busy context; do not poll.
5. Capture session/run generation and the prior compaction epoch. Revalidate these inside the matching `session_before_compact` attempt and cancel stale work. These vetoes prevent stale decisions; they are **not proof** that no other run or native compaction can interleave after a hook returns. `ctx.compact()` is fire-and-forget and continuation after its initial abort is asynchronous.
6. Test another settled listener's immediate `triggerTurn`, both handler orders, and host-native compaction before accepting migration. Do not delete useful invalidation guards or assert exclusive quiescence without evidence. A bounded yield is a fallback design to evaluate only if needed; it introduces its own new-run race and is not the default recommendation. If neither approach passes, keep migration blocked.
7. Remove the 200ms/50ms polling machinery, pending-poll-specific controller state and retryable-error heuristic **only after** the new path passes. Keep unrelated retry detection and in-flight/backoff semantics.
8. Do not relax non-persisted-session protection: their reliable path remains inline at `turn_end`. A later settled notification is not a fix for a parent disposing the session at `agent_end`.

### Acceptance gates specific to the migration

Use real `AgentSession` + fake provider tests, not captured callbacks alone:

- idle is true during settled; no self-wait or prompt deadlock;
- retry and queued continuation complete before settled compaction;
- normal, aborted, failed/retry-exhausted and empty runs do not cause endless compaction;
- another settled listener's `triggerTurn` cannot be aborted or have its active context unexpectedly swapped by a detached settled attempt;
- reload/session switch/branch movement invalidates scheduled work;
- one compaction per decision, including very fast completion and reentrant events;
- file-backed, headless and in-memory host behavior are exercised;
- oldest supported host and 1.4.0 both emit the event as expected.

If the other-extension race cannot be solved through current public API plus bounded scheduling, record the exact host limitation and retain the existing settled path until a host change is available. **That does not justify dropping mid-run support from the cooperative feature.**

## 6. Change surface for eventual implementation

These are proposed changes only; none are made in this planning commit.

| Location                                        | Work                                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New `src/om/agent-compaction.ts`                | Policy, scoped state, request validation, checkpoint selection/rendering. Keep pure calculations testable. Split rendering only if size/cohesion warrants it.       |
| New `src/tools/compact-context.ts`              | Typed tool schema, bounded handoff input, honest scheduling result and opt-in exposure.                                                                             |
| `index.ts`                                      | Registration and lifecycle wiring; preserve eager adapter install.                                                                                                  |
| `src/om/compaction-trigger.ts`                  | One arbitration path for agent requests and normal threshold attempts; settled migration; retain existing inline safety/backoff.                                    |
| `src/om/runtime.ts`                             | Minimal session-keyed preparation/request state, generation invalidation; no naked process-global pending request.                                                  |
| `src/hooks/before-compact.ts`                   | Compose explicit checkpoint in fallback and append trailing text; include it in every applicable estimate; do not bypass cut/OM/pressure logic.                     |
| `src/details.ts`                                | Optional validated namespaced checkpoint metadata on both legacy and append details. Preserve existing versions and compatibility where additive metadata suffices. |
| `src/core/compaction-chain.ts` and context hook | Only changes needed to budget/project one latest checkpoint, not rewrite immutable segments.                                                                        |
| `src/core/summarize.ts`                         | At most strip known generated checkpoint rendering at the hook boundary before compiling a prior fallback. Prefer no scheduling/state additions here.               |
| Unified config/env/settings + fixtures          | Enum validation/resolution, UI, env override, example config and config-completeness tests. Avoid unrelated vendored settings refactors.                            |
| Tests                                           | New policy/request/render tests plus trigger, hook, append, lifecycle and real-host integration suites. Update factory registration mocks.                          |
| Product docs/CHANGELOG                          | Explain costs, permission override, lifecycle, no-handoff fallback and limits; align README/CONFIG/llms defaults. Correct stale lifecycle overview.                 |

Do not extract all of the large before-compact hook into a second builder merely to imitate the PR. The existing host pipeline already calls that hook for us. A small shared composition/cost helper is warranted if candidate and final budget paths need it to avoid inconsistent accounting.

## 7. Staged delivery and review checkpoints

### Phase A — host lifecycle proof, before feature work

- Add failing tests for settled migration against untouched source, then migrate only after the failures are witnessed.
- Prove the tool-complete boundary and original-run continuation on both supported host shapes.
- Run the competing-settled-extension race test. Decide bounded scheduling vs host blocker.
- Review lifecycle changes independently. Do not mix a default-mode flip into this phase.
- **Independent exit gates:** a failed settled-migration race test keeps the existing settled implementation and records the blocker. It does not block Phases B–D if their existing inline path is independently verified. Conversely, a successful settled migration cannot substitute for working mid-run compaction.

### Phase B — checkpoint composition and persistence

- Define optional metadata, bounded rendering and latest-only selection.
- Add red tests for compact-all loss, summary merge loss and append trailing omission, then implement.
- Include handoff tokens in pressure-tail candidate selection, fallback/append projections and final capacity checks.
- Verify repeated compactions, restart and branch navigation before adding agent automation.

### Phase C — tool-driven early mid-run compaction

- Add the opt-in tool and callable request API.
- Wire accepted requests into the existing `turn_end` arbitration path.
- Cover ownership/mode/cancellation/backoff/loadout permutations.
- Reject unsupported adapters honestly; no pause/restart/settled-only imitation of success.

### Phase D — cooperative pressure note

- Implement the specification's pressure predicates, capacity confidence and one-episode injection rules.
- Add cross-window tests and model-switch/burst-result tests first.
- Evaluate note and handoff sizes using recorded fixtures; keep constants provisional until results are reviewed.
- No marker parsing unless D3 explicitly changes.

### Phase E — release gates

- Run targeted tests, then CI order: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format:check`.
- Review all defaults and config documentation against `src/core/unified-config.ts`.
- Live soak with real TUI, RPC/SDK and parent/child/flow traffic, with and without OM; verify no truncated `completed` results, orphan continuations, parent stalls or abort propagation.
- Compare context before/after, checkpoint exactness, compaction cadence, extra tokens and task continuation quality across window sizes. Do not judge success by free tokens alone.
- Keep the feature experimental/off until these checks pass. An unavailable live environment is incomplete verification, not a reason to assert safety.

## 8. Evidence map and review limitations

Primary host evidence (paths relative to `node_modules/@earendil-works/pi-coding-agent/`):

- `CHANGELOG.md`: 0.80.4 `agent_settled`; 0.87 actionable boundaries.
- `dist/core/extensions/types.d.ts`: context, tool, boundary, messaging and settled interfaces.
- `dist/core/agent-session.js`: `_dispatchTurnEndBoundary`, `_applyBoundaryDrafts`, `_buildBoundaryContext`, `_emitAgentSettled`, `_handlePostAgentRun`, `_runBeforeSettleBoundary`, `compact`, extension `compact` binding.
- `dist/core/session-manager.js`: projection/cut behavior.
- Pi extension/event/messaging documentation and linked references reviewed by the host-contract investigation.

Source inspection establishes integration constraints, not a live traffic safety proof. Neither Blackhole's suite nor provider smoke/soak tests were run for this planning-only work. The external repository's 40-test core suite is the only behavioral test suite executed during research.

The detailed proposed contract, including numerical examples, injection eligibility, request state transitions, checkpoint persistence and the verification matrix, is in [the specification](spec-agent-cooperative-compaction.md).
