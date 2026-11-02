# Proposal: agent-cooperative compaction — behavioral specification

**Status:** proposed contract, not implemented or approved. Numerical values below are review candidates, not current Blackhole defaults.

## Decisions to review first

The decision register is at the top of [the implementation plan](plan-agent-cooperative-compaction.md#decisions-needed-from-you). This specification provisionally assumes:

- D1: opt-in `off` / `tool` / `cooperative` modes;
- D2: accepted agent requests use non-aborting inline compaction regardless of the ordinary mid-run mode;
- D3: tool first, marker deferred;
- D4–D5: size-aware early invitation, without delaying ordinary safety compaction;
- D6: one latest committed checkpoint, carried forward and explicitly labeled as historical;
- D7: Blackhole automatic ownership required;
- D8: separately verified `agent_settled` migration;
- D9: no extra summarizer, background model job or forced continuation;
- D10: ordinary safety compaction may suspend an older checkpoint's projection rather than wedge recovery.

The words **must**, **should** and **may** describe the proposed implementation, not a claim about existing behavior. A changed decision must be reflected in both documents before implementation.

## 1. Invariants

1. **One compactor:** every agent-requested attempt uses the existing host compaction pipeline through Blackhole's inline adapter and `session_before_compact`.
2. **Same-run mid-run operation:** no abort + restart, detached `prompt()`, fabricated `blackhole-resume`, or parent-visible premature completion.
3. **Tool safety:** a tool never compacts inside `execute()`. All calls/results in the assistant cycle must finish and be paired before mutation.
4. **No new permission bypass:** normal ownership, provider and cancellation guards still apply. Only the early-request threshold and ordinary mode exceptions in D2 differ.
5. **Explicit preservation:** an accepted handoff included in a successful Blackhole compaction is present in both persisted fallback context and the model's append/default projection.
6. **No coverage fiction:** checkpointing and VCC do not advance observer coverage, flush the observer, or replace source history with observations.
7. **One latest checkpoint:** no growing stack of agent summaries and no permanent pending-action replay. Carry-forward is subject to the explicit safety exception in §8; retaining historical metadata does not require projecting it forever.
8. **Bounded invitation:** no note appended after every tool call or reissued every run while pressure remains high.
9. **Safety compaction wins:** a handoff is optional; handoff-specific rejection cannot delay an ordinary compaction already due at this boundary under the existing mode. Never add a grace turn or enable ordinary inline compaction in persisted `off` merely to recover from a rejected handoff.
10. **Fail without losing context:** invalid input, unsupported adapter, invalid branch, unsafe cut, capacity failure or compilation failure cannot publish a partial replacement or delete the previous checkpoint.

## 2. Proposed modes and permission matrix

Proposed single setting:

```text
agentCompaction = off | tool | cooperative
initial default = off
```

- `off`: no new tool exposure or preparation notes. Existing Blackhole semantics remain unchanged.
- `tool`: agent may explicitly request compaction at a useful phase boundary; no pressure invitation.
- `cooperative`: same tool plus a pressure preparation note on otherwise-needed model requests.

Do not add separate public settings for every ratio, byte cap, timing, marker and retry policy in v1. Keep policy constants centralized and testable; expose additional knobs only if evaluation shows a concrete need. This does not prevent revising the proposed defaults during review.

| Situation                                                               | Tool request               | Preparation note                     | Normal compaction                                                             |
| ----------------------------------------------------------------------- | -------------------------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| Feature off                                                             | Not exposed                | None                                 | Unchanged                                                                     |
| Feature tool/cooperative + Blackhole auto ownership + supported adapter | Allowed if safe/useful     | Cooperative only                     | Unchanged                                                                     |
| `compaction: off` or `manual`                                           | Reject/inactive            | None                                 | Existing semantics                                                            |
| `compactionEngine: pi-default`                                          | Reject/inactive            | None                                 | Pi owns it                                                                    |
| Provider skipped by Blackhole                                           | Reject/inactive            | None                                 | Other engine owns it                                                          |
| `memory: false`                                                         | Allowed                    | Allowed                              | VCC without OM                                                                |
| Persisted `midRunCompaction: off` or `pause`                            | Allowed **inline**, per D2 | Allowed                              | Ordinary threshold path retains off/pause behavior                            |
| Non-persisted session                                                   | Allowed inline             | Allowed when explicitly enabled      | Existing forced-inline protection remains                                     |
| Unsupported inline adapter                                              | Reject with reason         | None                                 | Existing fallback/degradation remains; do not claim cooperative mid-run works |
| Active signal aborted / shutdown / stale context                        | Reject/cancel              | None                                 | Existing cancellation semantics                                               |
| Tools intentionally disabled by user/loadout                            | Do not force-enable        | Do not advertise an unavailable tool | Unchanged                                                                     |

Provider/config eligibility must be checked when showing the note, when accepting a request, and again at execution because settings/model/provider may change. Share only the relevant gate calculation; do not accidentally change `/blackhole`'s human override semantics.

Tool registration, activation and prompt advertising are separate concerns. Use the supported host's normal loadout behavior, preserve intentional exclusions and test restored sessions on old and current hosts. If consistent dynamic exposure requires reload, document that limitation rather than mutating every user's loadout on every run. An already exposed tool must still reject after feature disablement.

## 3. Pressure model: do not confuse two token quantities

### Inputs

For each relevant request/boundary, resolve:

- **`W`**: known effective context window for the current model, honoring Blackhole's model-window overrides.
- **`T`**: current `autoCompactThreshold(config, model)` with existing precedence: explicit tokens, ratio, reserve derivation, selected preset.
- **`B`**: `rawTokensSinceLastCompaction(branch)`, the existing trigger's pressure measure. Prefer the helper unchanged over a new competing token counter.
- **`P`**: current whole-request/window occupancy estimate, with provenance. Prefer trustworthy host context usage, supplemented by current known message deltas as needed; validate its relationship to Blackhole's window override. Do not call stale last-request usage “current exact tokens.”
- **`R`**: the session's effective host compaction reserve, not the separate `compactReserveTokens` threshold configuration.
- **`N`**: estimated rendered preparation-note tokens, computed from the actual note.
- **`H`**: advisory handoff-output allowance; proposed **1,024 estimated tokens** for eligibility accounting, including slack above the requested short text.
- **`E`**: preparation lead margin beyond the host reserve; proposed **2,048 estimated tokens** for a first evaluation.

The current `B` helper is usage-anchored where possible and can resemble whole-context usage then; its fallback counts source history and may omit fixed overhead/summary components. **Do not add the system prompt again to an already whole-request usage baseline, and do not claim `B` and `P` are identical.**

`getContextUsage()` is useful evidence, but its percentage can refer to a different registered window than Blackhole's per-model override. Prefer its usable token count and normalize to `W` when comparing percentages; otherwise record the disagreement and use a conservative bound. Tool schemas, provider wrappers, multimodal costs and reasoning/output accounting must be handled according to the verified host API, not guessed from characters.

### Confidence and unknown values

The implementation spike must document which quantities are available on each supported host shape. Proposed rules:

- A finite positive registry/override window is **known**; the token helper's generic 128k fallback is not evidence of the real model capacity.
- A valid current usage baseline with accounted deltas is the preferred estimate. After compaction, do not reuse pre-compaction provider usage as a current baseline.
- If a complete conservative projected request estimate is available, it may substitute for `P`, labeled estimated.
- If only a raw-history count or an unknown window is available, do not inject a cooperative note that claims safe headroom. Ordinary compaction remains available. Explicit tool requests may still proceed only when existing eligibility and the candidate's safety checks establish a useful safe attempt.
- Unknown `R` must not silently become zero in the preparation-capacity policy. Suppress the note or use a verified host-default contract, with tests for that host.

The feature must not require a full unbounded history scan on every request. Reuse the existing branch/baseline inputs and bounded episode state. No second usage-accounting subsystem is part of this proposal.

## 4. Proposed invitation boundaries

### Pressure predicates

Enter preparation eligibility when **any** of these is true:

```text
thresholdApproaching: B >= floor(0.85 * T)
windowApproaching:    P >= floor(0.70 * W)
reserveApproaching:   P >= W - R - E
```

The predicates operate in their own measurement domains. They are **not** implemented by taking one minimum and comparing it blindly to `B`.

Then require all of:

```text
feature mode is cooperative
Blackhole owns automatic compaction for this session/provider
compact_context is actually callable by the agent
inline adapter is supported for this host/session
normal cancellation / session / in-flight gates pass
no prior invitation in the current compaction cycle
known positive capacity and useful compaction eligibility
P + N + H <= W - R
```

If pressure is already at/above `T` on a path that would compact normally now, execute the ordinary path rather than add a grace turn. A previously accepted handoff request can be included in that same attempt. In persisted `midRunCompaction: off`, do not silently enable ordinary threshold inline compaction; D2 authorizes the explicit agent request, not a blanket mode change.

**Interpretation of reserve predicate:** it invites preparation _before_ consuming the spare room intended for output/recovery. It does not subtract `R` from the physical context twice. `E` is lead margin, `H` is the proposed invitation response allowance, and `N` is real note cost. If `W - R - E <= 0`, disable that predicate and diagnose the missing lead margin; do not clamp it to zero and invite immediately. The threshold/window predicates can still qualify, subject to the actual `P + N + H <= W - R` headroom test. For example, `W=20,000`, `R=18,000` leaves 2,000 tokens of prompt allowance despite a negative reserve-preparation boundary; it is not automatically proof that every invitation is impossible.

**No hard output guarantee:** `H` is not a provider-enforced maximum. The model can spend more on reasoning or ignore the requested length. Existing per-request generation limits, reserve and overflow recovery remain authoritative. If an enforceable small response budget requires mutating model output/thinking settings or issuing a separate request, that is a separate design decision, not hidden in this feature.

### Worked context-size examples

The following table is **illustrative**, assuming `B ≈ P`, adequate eligibility and known capacity, the current built-in preset curve, `R = 16,384`, and `E = 2,048`. Real code evaluates separate predicates above. Native compaction may intervene earlier; this table is not a promise about Pi's settings on every installation.

| Window `W` | Blackhole threshold `T` | 85% of `T` | 70% of `W` | `W - R - E` | Earliest illustrative invitation | % of window |
| ---------: | ----------------------: | ---------: | ---------: | ----------: | -------------------------------: | ----------: |
|     32,768 |                  29,491 |     25,067 |     22,937 |      14,336 |                           14,336 |       43.8% |
|     65,536 |                  56,797 |     48,277 |     45,875 |      47,104 |                           45,875 |       70.0% |
|    131,072 |                 104,857 |     89,128 |     91,750 |     112,640 |                           89,128 |       68.0% |
|    200,000 |                 149,482 |    127,059 |    140,000 |     181,568 |                          127,059 |       63.5% |
|    262,144 |                 183,500 |    155,975 |    183,500 |     243,712 |                          155,975 |       59.5% |
|  1,048,576 |                 419,430 |    356,515 |    734,003 |   1,030,144 |                          356,515 |       34.0% |

These numbers were computed from the actual piecewise-linear preset anchors, not rounded conceptual ratios. In particular, 200k's current preset is about **74.7%**, not 77%.

For the 32k row, reducing reserve to 4,096 would move the illustrative invitation to 22,937 (70%). The same fixed note policy therefore behaves differently with the same window and different host reserves. This is intentional and must be visible in diagnostics.

Other mandatory examples:

- **Explicit early token threshold:** `T = 20,000`, large known `W`: the threshold predicate invites at `B = 17,000`; do not wait until 70% of the large window.
- **Threshold beyond usable capacity:** an explicit threshold greater than the window must not disable window/reserve protection. Do not rewrite the user's threshold silently.
- **Very low threshold:** if no useful safe cut exists before the threshold, skip invitation; no loop trying to compact a tiny session.
- **Huge system prompt/tools:** whole-window/reserve predicates may fire while `B`'s fallback is low. Preserve the distinction rather than misreporting that Blackhole's own threshold was crossed.
- **Unknown/overridden window:** never issue a confident “70% full” note using the generic 128k fallback or a percentage normalized to the wrong window.
- **Burst crossing:** one large tool result may jump from below all preparation predicates to no safe headroom. Skip the note and let normal threshold/overflow behavior run; do not demand a handoff from an already overflowing request.

### Why these are still review candidates

A 70% trigger alone misses large-window Blackhole thresholds and can be too late on a small window with substantial reserves. A threshold fraction alone can miss fixed prompt/tool overhead and bad explicit thresholds. The combined predicates address both, but the reserve predicate can invite noticeably early on small contexts, and early requests may increase compaction frequency.

Evaluate the table, observed request growth and task completion quality before accepting the constants. Candidate alternatives for review: threshold-relative only with a capacity veto (simpler but can miss preparation), or configurable token lead margin. Do not add a rate-of-growth predictor or per-model tuning database without evidence that the simpler policy fails.

## 5. Synthetic-note injection contract

### Recommended carrier

Use an **ephemeral `context` projection** on a normal agent request, after Blackhole's existing append/tool-output projection. Append a small typed custom context message at a provider-safe boundary. Do not persist it as a user message and do not mutate the base system prompt every turn.

Why:

- `before_agent_start` runs once per run and cannot detect pressure rising inside a long tool loop.
- `sendMessage(..., { triggerTurn: true })` can start/extend work and change final-answer semantics.
- steering/follow-up messages are real queued context, may affect lifecycle, and persist injected policy into the session/observer inputs;
- a new top-of-prefix system instruction unnecessarily changes earlier cacheable input;
- `context` can add a suffix only on an already-required model request.

Ephemeral does **not** mean zero-cost or cache-neutral. It consumes request tokens; its later disappearance can change a suffix. No provider cache-hit guarantee is made. Test representative provider converters, including Anthropic-style tool-result grouping and OpenAI-style ordering.

### Safety and lifecycle

1. Inject only on an ordinary agent request with a complete replayable message sequence. Never between an assistant tool call and any required result.
2. Do not append a synthetic user/custom message to an incomplete assistant prefix or use it to make an otherwise non-continuable final response continuable.
3. Use original persisted source evidence for pressure and marker parsing, not synthetic projected notes. No feedback loop where the note itself rearms preparation.
4. Mark the invitation delivered at the verified request-projection/send stage. At minimum, the same event must not receive two notes from repeated transformation. If the host can project and then abandon a request, document the exact once-attempted vs once-sent semantics; do not invent a provider acknowledgement.
5. At most **one invitation per compaction cycle**, not per `agent_start`. One long high-pressure session spanning many user runs must not get a note each run.
6. If the agent ignores the note, do not remind at every boundary. Ordinary safety compaction remains the backstop.
7. A successful compaction resets the preparation cycle, but does not immediately rearm an identical invitation. Proposed renewal rule: record the first trustworthy **post-compaction** `P` baseline and require growth of at least `G = max(1,024, min(8,192, floor(0.05 * T)))` estimated tokens before another invitation, plus normal useful-cut eligibility. Never compare pre-compaction usage with the post-compaction baseline. Until a new trustworthy baseline exists, suppress renewed invitations. On model/window changes, re-establish the baseline rather than comparing incompatible measurements. This additional review-candidate constant prevents a retained high tail from driving invitation/compaction loops; explicit tool requests remain possible if safe/useful.
8. A model/window/config change invalidates the pressure snapshot and requires recomputation. It is not by itself permission to emit another identical note during the same cycle.
9. Session replacement, branch navigation or shutdown discards ephemeral preparation/request state for the old scope. Do not leak a parent's note into a child.
10. No forced extra request after a final answer. If the model finishes without calling the tool, its answer remains a final answer.

### Proposed note text

Keep the final rendered note short (target **<=160 estimated tokens**); actual accounting uses its rendered content.

```text
Blackhole context checkpoint opportunity: context is approaching the configured
compaction boundary. At your next safe stopping point, call compact_context
with a very short handoff: one line on completed work, then remaining work,
blockers, and the immediate next action. Aim for 80–150 words; preserve only
critical paths/IDs. Call it alone, after outstanding work has completed. The
request is applied after tool results finish and you continue in the same run.
If the task is already finished, give your normal final answer instead. Normal
safety compaction may happen without waiting for this handoff.
```

Use wording consistent with the actual trigger reason: do not say “configured threshold” if only whole-window reserve pressure fired. A fixed neutral “context pressure” variant is acceptable and cheaper. Avoid asserting an exact percent based on estimates. Do not request chain-of-thought; only operational state and verifiable outcomes.

## 6. `compact_context` tool contract

Proposed input:

```typescript
{
  handoff: string; // required, concise operational checkpoint
}
```

Do not call this field `instructions`: it is **data to preserve**, not a request to run an alternate summarizer. Do not offer free-form cut positions or authority to disable safety guards.

### Validation

- Nonempty after trimming; reject NUL/unsupported control characters.
- Proposed maximum: **2,048 UTF-8 bytes** and **768 estimated tokens**, both checked with existing token utilities. The dual limits bound storage and estimated context cost; neither proves exact provider tokenization.
- Ask for 80–150 words, but do not enforce language-specific word counts.
- Reject oversized payloads with an actionable correction; do not silently truncate away the “remaining work” section.
- Preserve paths, IDs and ordinary formatting. Quote/prefix data when rendering so payload headings cannot impersonate VCC/OM sections or terminate generated delimiters.
- Validate tool availability, ownership, session identity, active signal, inline support, backoff and likely useful compaction eligibility. Recheck authoritative facts at `turn_end`.
- Require `compact_context` to be the only **top-level** call in its assistant tool cycle for v1. Instruct this in the tool prompt and validate the persisted cycle at the boundary. Mixed calls are rejected/deferred without mutation; otherwise the checkpoint could predate a concurrently finishing edit or subagent result. Do not count nested implementation calls as separate top-level calls.

Do not scan tool-result text for an authorization marker. A web page or a file must not be able to request compaction by containing a string.

### Result semantics

Accepted scheduling result:

```text
Checkpoint request recorded, pending validation of this completed tool cycle.
Compaction has not run yet. It will be attempted only if this was the sole
top-level tool call and all safety checks pass. If successful, your next normal
step continues in this same run with the checkpoint and Blackhole summary.
No additional handoff reply is needed.
```

Rejected result: machine-readable status/reason in details plus short text (`disabled`, `not_owner`, `unsupported_inline`, `cancelled`, `nothing_useful_to_compact`, `retry_backoff`, `invalid_handoff`, `request_pending`, etc.). Match host error/result conventions rather than throwing an operational failure as a programming error.

- No success or unconditional scheduling claim before the boundary.
- A later boundary rejection (especially a mixed-tool cycle) must produce one definite, bounded model-visible status on the next otherwise-needed request, not merely an optional operator log. If there is no next request, retain diagnostics but do not start a run solely to deliver this status. If normal compaction intervenes first, carry this short status into the resulting next-request projection so it cannot silently disappear.
- No `ctx.compact()`, adapter call, session append, prompt, steering or synthetic resume inside `execute()`.
- Idempotency by tool-call ID. Duplicate delivery must not schedule twice.
- Distinct repeated calls in the same pending cycle are rejected rather than last-writer-wins.
- Requesting before the invitation is valid in tool/cooperative modes if there is a useful safe cut; no hardcoded 70% minimum.
- An automatic threshold already due and an accepted request normally produce one attempt containing the checkpoint. Publish at most one successful compaction. A handoff-specific veto without mutation allows the same-boundary ordinary fallback in §7; it must not cause an extra un-compacted model request where ordinary compaction was already due.

## 7. State and arbitration

### Minimal scoped state

The concrete types should be small, but must represent:

```text
scope: session ID + runtime generation + active branch anchor
preparation: cycle anchor, delivered/request-attempted flag, pressure snapshot
pending request: tool-call ID, source assistant/cycle ID, handoff, scope, origin
attempt: expected previous compaction ID, origin, request ID, completion state
committed checkpoint: read from validated latest applicable compaction details
```

Use an active-branch anchor/ancestry check rather than requiring the leaf ID never change: tool results and OM custom entries can legitimately append after request acceptance. A sibling branch is not a legitimate continuation. Keep state bounded and remove entries when their session ends; do not let a long-lived SDK process accumulate dead sessions indefinitely.

### Boundary transition

```text
DISABLED / INELIGIBLE
  no invitation; request rejected

ELIGIBLE, no invitation this cycle
  pressure predicates + capacity pass -> invite on next normal safe request

REQUEST_STAGED
  complete matching tool cycle + current scope + all gates pass
    -> ATTEMPTING via inline adapter
  cancelled/stale/mixed-tool-cycle/config changed
    -> reject pending request, no mutation

ATTEMPTING
  successful Blackhole compaction with matching checkpoint
    -> checkpoint committed; clear pending action; reset preparation carefully
  cancelled/failed/delegated/native fallback
    -> no new checkpoint commit; preserve previous checkpoint; clear pending action
       retain ordinary retry/backoff as applicable; expose failure once
```

V1 does not leave an early request armed indefinitely across later user runs or restart. On failure, a new explicit call or ordinary safety compaction can retry; the last accepted action is not replayed automatically forever. Existing normal-threshold retries remain independent.

### Execution ordering

At the existing `turn_end` coordinator:

1. Resolve current config/ownership and scope. Reject stale or aborted requests.
2. Check whether a staged request belongs to this completed tool cycle; do not consume a different session's request.
3. Validate sole top-level call and paired results, backoff, adapter support, host eligibility and useful cut conditions.
4. If ready, reserve the per-attempt state/lock and execute inline regardless of ordinary threshold and ordinary off/pause mode (D2).
5. Otherwise evaluate existing ordinary mode/threshold behavior without delaying it for an invitation. If a staged request is rejected specifically because its handoff is invalid/stale/mixed-cycle/too large, or the cooperative hook vetoes its fresh handoff before publishing anything, fall through to any **already-due ordinary decision at this same boundary**. Resume/non-persisted keeps inline behavior; persisted pause keeps its interrupting behavior; persisted off still has no ordinary turn-end attempt and awaits its normal settled/host safety path. This exception permits a failed no-mutation cooperative evaluation followed by one ordinary attempt, not two published compactions.
6. Both branches must share arbitration: one pending attempt cannot race another Blackhole threshold attempt. Handoff-specific vetoes must not arm shared transient-failure backoff that blocks the same-boundary ordinary fallback. Real adapter/host/operational failures still obey existing backoff; do not blindly rerun a failed host operation as “fallback.”
7. Clear only this attempt's state in completion/failure cleanup. A stale callback must not clear a newer attempt's lock or checkpoint.

A callback or hook observing a new compaction epoch/session generation cancels a stale attempt. This is stronger than assuming one shared boolean protects against sequential or cross-session work. Reuse existing lifecycle facilities where suitable, without turning this feature into a wholesale runtime redesign.

## 8. Handoff preservation and summary composition

### Source of truth

The committed compaction entry carries optional namespaced checkpoint metadata on **both** existing details shapes. Proposed contents:

```text
schema version
request/source tool-call ID and source assistant entry ID
bounded handoff text
source timestamp / compaction identity as available
origin: tool (or marker if separately approved)
```

Store provenance, not generated chain-of-thought. Validate restored metadata at the session trust boundary. Older details without metadata remain valid. Unknown/malformed checkpoint metadata is ignored diagnostically without invalidating an otherwise valid legacy/append chain.

A pending request is runtime-only. Its successful entry is the durable checkpoint source. No separate persisted custom entry or sidecar queue is required unless implementation discovers a concrete host limitation.

### Rendering

Render exactly one labeled component such as:

```text
## Agent working-state checkpoint
Agent-authored snapshot at <source time>; newer user instructions and later
messages take precedence. This is working state, not verified completion.

> Done: ...
> Remaining: ...
> Next: ...
```

Render from bounded typed data; quote all payload lines or use an equivalently safe wrapper. Do not allow an embedded heading/recall-note phrase to become VCC/OM structure. “Preserved” means handoff content is available without algorithmic clipping; deterministic quoting/escaping is allowed and tested.

### Required representation paths

- **Default mode:** fallback summary contains VCC + current OM/recall + checkpoint component.
- **Append mode:** complete fallback contains it; the latest mutable `trailingSummary` contains it; immutable VCC segments do **not** contain a copy on every compaction.
- **Rebase:** retain only the current checkpoint alongside the rebased chain. Rebase cannot resurrect a superseded checkpoint from old segment text.
- **Compact-all / no retained user prompt:** checkpoint remains in the summary even when no raw message survives.
- **Unobserved tail / pressure fallback:** keep existing protected raw-history and source-continuity rules. The handoff does not authorize dropping an unobserved backlog.
- **Restart/resume:** latest applicable validated **active** checkpoint is rendered; no compaction is scheduled merely because it exists. An inactive/suspended checkpoint is authoritative suppression state: do not search back to an older active ancestor and resurrect it.
- **Branch/fork navigation:** select from the active lineage. A checkpoint on an abandoned sibling branch cannot enter current context. An inherited ancestor checkpoint may remain, clearly historical.

### Merge and duplication rules

Do not insert the only authoritative copy into `compile()`'s arbitrary text sections or `Outstanding Context`. Before compiling a previous fallback, remove only the known generated checkpoint envelope, using typed provenance/rendering boundaries where available; carry the payload independently. Avoid a broad regex that removes user text with a similar heading.

For fresh source messages, prevent the same known checkpoint payload from becoming another authoritative handoff inside the VCC brief. Omit or abbreviate only this feature's recognized request envelope where appropriate; do not filter arbitrary assistant text by matching a phrase. The original tool call/result remains recallable by its normal session reference.

A single surviving raw tool call can contain the same text as the rendered checkpoint. Do not move the raw cut unsafely to deduplicate it. The requirement is **one canonical projected checkpoint**, not destruction of retained source evidence to make a global substring count equal one.

On a subsequent compaction with no fresh handoff, D6 normally carries forward the latest successful checkpoint, unchanged apart from the generated wrapper. Newer transcript/user work overrides it. Do not infer “still pending” from an old checkpoint, mark work done without evidence, or merge contradictory checkpoints into a synthetic plan. Capacity emergencies follow the precedence below.

### Capacity accounting

Every applicable candidate and final estimate must include the rendered checkpoint:

- preferred pressure-tail candidate;
- pressure-bridged candidate;
- fallback summary;
- append trailing message and rebase candidate;
- unobserved-tail check;
- final provider-visible summary + retained raw tail + fixed prompt/tool overhead estimates.

Budget before choosing the cut, and validate the final projection again. Do not append handoff text after the last capacity check. Do not count it twice in append projection or omit it from fallback validation.

**Capacity precedence (D10):**

1. For a **fresh cooperative request**, if its handoff cannot fit while respecting the protected tail, reject it without committing the fresh checkpoint. Report why and perform the **same-boundary ordinary fallback** defined in §7 whenever that ordinary action is already due and permitted by its existing mode. Do not return to the model first, require another tool call, or apply handoff-specific backoff to delay this ordinary decision. Persisted off does not acquire an ordinary inline attempt, and persisted pause retains pause semantics.
2. For **ordinary safety compaction carrying an older checkpoint**, first evaluate the normal candidate with that checkpoint. If the checkpoint is what makes the candidate exceed capacity, retry candidate selection **without its rendered projection**, never by dropping protected source history. Mark the checkpoint inactive with reason `capacity` in the new details, retaining bounded text/provenance as historical metadata. No active checkpoint section goes into fallback or append trailing text for that entry.
3. Inactive historical metadata remains inactive on subsequent compactions; do not automatically resurrect a stale checkpoint when capacity returns. A fresh successful request can replace it. It remains inspectable through session history/recall; diagnostics report the suspension.
4. If the candidate still does not fit without the checkpoint, preserve existing protected-tail deferral and native recovery/error semantics. This feature does not promise to solve an intrinsically oversized protected newest turn.

Thus the strong guarantee is preservation in the **successful cooperative compaction**, not unconditional projection through every later model/window change. The handoff is never permission to truncate raw output protected by another mode. Existing estimates remain estimates, not proof of provider acceptance.

If the existing hook would delegate to native summarization because VCC and OM contain no useful summary, the cooperative attempt must not commit a checkpoint-only “successful compaction” or silently claim preservation through native fallback. Either reject that attempt and leave ordinary recovery in control, or explicitly design/test a preserving native path in a later revision. Existing non-cooperative native-fallback behavior stays unchanged.

## 9. Optional marker protocol — specified alternative, not recommended v1

If D3 changes, use the **same** request API, gates, composer and boundary coordinator. The literal example `---PRE-COMPACTION---` alone is insufficient as an authorization protocol.

Minimum safe protocol:

- An outstanding preparation episode issues a short unpredictable/request-unique ID.
- The instruction asks for an exact standalone opening marker containing that ID, a bounded handoff body, and an exact closing marker.
- Parse only a successfully finalized **assistant text** message in the active session/episode, not thinking, deltas, user text, quoted tool output, compaction summaries or old history.
- Require an exact framing position, not substring search; reject fenced examples, malformed/multiple blocks, wrong/expired IDs, empty/oversized bodies and mixed tool-call messages.
- Inspect at final message completion; stage intent only. Execute at the safe `turn_end` coordinator. Do not mutate during streaming.
- Invalidate on new conflicting user instructions, session/branch change, cancellation or an already consumed episode.
- Tool and marker duplicates in one episode resolve to one request; prefer the explicit tool call.
- Leave the source transcript intact for replay/recall. Any UI hiding is a separate feature, not silent history rewriting.

**Unresolved semantic choice:** a marker-only final assistant message normally ends the run. Inline compaction can preserve it, but compaction does not create a need for another model request. Choose either:

1. marker compacts without forcing continuation; it may be a final reply, or
2. a narrowly defined queued continuation is part of the protocol, with explicit user authorization and tests that it cannot turn completed subagent output into hidden extra work.

The recommendation is neither extra mechanism in v1: use a tool call when a same-run continuation is wanted. Do not use `continue: true` boundary compaction drafts as a shortcut; inspected Pi 1.4.0 can commit their entries yet reject continuation, and they bypass the Blackhole hook chain.

## 10. Failure, cancellation and observability

| Event                                                     | Required outcome                                                                                                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model ignores invitation / normal final answer            | No forced new run; normal compaction rules remain                                                                                                        |
| Large tool result skips preparation interval              | No late unsafe note; normal threshold/overflow path                                                                                                      |
| Request arrives while another attempt is active           | Honest busy/pending result; no second compactor                                                                                                          |
| Tool shares a cycle with edits or subagent calls          | Do not commit a potentially stale checkpoint; report mixed-cycle rejection                                                                               |
| User abort during request/attempt                         | No restart; pending action cancelled, existing committed checkpoint retained                                                                             |
| Adapter permanently unsupported                           | No invitation; request rejected, no interrupting fallback masquerading as success                                                                        |
| Transient compaction failure                              | Preserve context/checkpoint; bounded backoff; no perpetual pending authorization                                                                         |
| Host says no useful cut / too few messages                | No mutation or success claim; no retry every identical turn                                                                                              |
| Protected tail or final projection cannot fit             | Fresh request fails; ordinary safety can suspend an older checkpoint projection per D10. Existing protected-tail deferral remains if it still cannot fit |
| Another extension owns summary/provider                   | Decline request; do not force the `/blackhole` marker                                                                                                    |
| Native fallback or cancelled hook                         | Not a committed new checkpoint unless its preservation is explicitly verified                                                                            |
| Session replacement / reload / fork / stale callback      | Old action cannot mutate or clear new session state                                                                                                      |
| Successful unrelated/manual/overflow Blackhole compaction | Carry current checkpoint per D6 and invalidate obsolete preparation/request scope appropriately                                                          |
| Other compactor writes a non-Blackhole entry              | Do not claim it preserved the checkpoint; do not inject stale pending intent into that engine                                                            |

Proposed structured diagnostics (names provisional):

```text
agent_compaction.prepare_evaluate / prepare_injected / prepare_skip
agent_compaction.request_accepted / request_rejected
agent_compaction.attempt_start / committed / failed / cancelled
agent_compaction.checkpoint_restored / checkpoint_invalid
compaction_trigger.agent_settled.*
```

Log session/run/request/compaction identity, trigger reason, `B`, `P` and confidence, `W`, `T`, `R`, note/checkpoint estimated tokens, effective mode, chosen mechanism and skip/failure reason. **Do not log the full handoff text by default.** Preserve useful existing stats and origin attribution without calling the tool a human `/blackhole` invocation.

A diagnostic is not a model instruction. Use the existing UI/debug channels for operator status; do not leak `console.warn` into child completion text. A later failure status shown to the model must be small, once-only and honest, not a recurring instruction to retry forever.

## 11. Verification matrix for implementation

Follow repository T1–T8: write new regression tests against unchanged code and witness red before fixing; arm all preconditions; separate branches into individual test cases; clean up in after-hooks/finally; use realistic wrapped output and typed/null-safe fixtures. No historical red reconstruction.

### Pure policy / request tests

- Every example row in §4; equality at each threshold and one token below.
- Explicit token/ratio/reserve/preset precedence, custom curves and model overrides.
- Known vs fallback window; missing/invalid `P`, `R`, negative available capacity and inconsistent host percentage.
- Current usage vs source-only fallback; no double-added system overhead; stale usage after compaction.
- Note exactly fits vs exceeds capacity; actual note size counted; negative reserve-predicate boundary with other predicates/headroom passing.
- Model reasoning/output exceeding advisory allowance remains a known non-guarantee, not a passing “safe” assertion.
- One invitation per cycle across multiple runs, ignored invitation, provider retry, abandoned request projection, compaction without meaningful relief, model/config changes.
- UTF-8 byte/token boundaries, whitespace, controls, ordinary headings, delimiter/recall-note impersonation, non-English text.
- Duplicate tool-call ID, distinct duplicate requests, mixed top-level tool cycle, nested call shape, stale branch and parent/child isolation.

### Compaction composition tests

- Fresh checkpoint + nonempty VCC; fresh checkpoint with OM on/off; no checkpoint.
- Compact-all single-prompt autonomous session; retained user tail; orphan recovery.
- Default rewrite; append projection; manual rebase; malformed-chain fallback.
- Latest checkpoint replaced, previous checkpoint carried per D6, failed replacement retains old checkpoint.
- Large-to-small model switch: ordinary safety suspends a checkpoint that prevents fit; historical metadata is retained but not reactivated; a fresh oversized cooperative request cannot wedge normal recovery.
- Restart restores data but never replays intent; sibling branch excludes checkpoint; ancestor inheritance.
- Unobserved and pressure fallback, both candidate and final budget boundaries; no observer coverage advancement.
- Empty VCC/OM native delegation cannot be falsely reported as a preserved cooperative result.
- Raw retained request duplication does not lead to two canonical checkpoint sections or unsafe cut movement.
- Recall indices continue to address original entries; no session number shift from persistent synthetic invitations.

### Trigger and host-backed integration tests

- Tool `execute()` returns before any compact call; paired result exists before the adapter runs.
- Mixed-cycle boundary rejection is delivered exactly once to the next model request, including when ordinary compaction intervenes; no extra run solely for status delivery.
- Early request below threshold; readiness and normal threshold coincide; at most one successful compaction. Fresh handoff capacity failure falls through at the same boundary to an already-due ordinary decision, without handoff-specific backoff, for each ordinary mid-run mode; actual adapter failures do not trigger blind immediate reattempts.
- `midRunCompaction` off/pause/resume × persisted/in-memory × feature mode.
- `compaction` auto/manual/off × engine × provider skip × memory enabled/disabled.
- Active cancellation, failure backoff, retry after relief, unsupported/permanent adapter failure.
- Same original `session.prompt()` resolves once; next request sees VCC + checkpoint; no abort, synthetic restart, truncated child completion or orphan tool result.
- `context` note is ephemeral, follows existing projection, and converters preserve provider tool-call/result ordering.
- Latest supported host and oldest declared peer; synthetic hosts alone are insufficient.
- Settled migration: single path, no poll; idle at dispatch; retries/queues drain first; aborted flag absent on old peers; other settled listener starts a new run; no concurrent/double compaction; no stale-context mutation.

### Live release acceptance

A planning document cannot certify these tests. Before release, soak real TUI/RPC/SDK and subagent/flow runs at small/medium/large windows with both quick and bursty tool output. Measure note cost, handoff size, actual compaction frequency, retained checkpoint correctness, useful context reduction and task continuation quality. Include OM off/on, append/default and protected-tail modes. The #40 symptoms (parent stalls, orphan continuations, truncated `completed` results) are release blockers.

## 12. Explicit unresolved implementation-spike questions

1. Which effective host reserve/context-usage inputs can be read through stable APIs on **all** supported hosts without duplicating the private adapter's discovery? Reuse its per-host binding if a narrow read-only accessor is necessary; do not guess host defaults.
2. Does the final safe `context` injection point have a trustworthy current whole-request estimate after preceding projection hooks, or must the policy use a conservative reconstruction? Precisely document remaining provider/tool-schema uncertainty.
3. Does the proposed post-compaction growth rule in §5 prevent repeated invitations without withholding useful preparation on small contexts? Evaluate its 1k/8k/5% bounds using fixtures; revise the constants rather than introducing a tuning subsystem.
4. Can synchronous settled dispatch plus epoch/generation vetoes prevent both Blackhole and host-native concurrent compactions when another settled listener immediately starts a run? This is a **migration release gate**, not assumed solved by `compactInFlight`.
5. Can checkpoint metadata be added compatibly to both details types and their validators without changing existing persisted version semantics? Prefer additive namespaced data; prove old/new fallback compatibility.
6. What does supported-host tool activation do on restore and explicit exclusion? Do not inherit PR #62's blanket loadout repair.

These questions are bounded implementation research, not permission to ship placeholder behavior. If a required safety boundary cannot be verified, revise this proposal or leave that phase blocked.
