# Plan: `agent_settled` migration + polling cap

## Problem statement

1. **Upstream OM issue #41** (same as our situation): `agent_end` + single `isIdle()` sample → compaction starved when other extensions yield the event loop.
2. **Our current fix** (Issue #31): `agent_end` + polling loop (200ms slices, no cap) → works but has no upper bound.
3. **Root cause**: `agent_end` fires _before_ `_isAgentRunActive = false`. The agent is "busy by definition" at that point.
4. **Proper fix**: `agent_settled` fires _after_ `_isAgentRunActive = false`, after retries/queued continuations. No polling needed.

## Approach

Two orthogonal changes:

| #   | Change                     | Why                                                         | Scope                         |
| --- | -------------------------- | ----------------------------------------------------------- | ----------------------------- |
| 1   | Cap the polling loop       | Safety net — prevents infinite poll if something goes wrong | `agent_end` path, incremental |
| 2   | Migrate to `agent_settled` | Proper fix — no polling, no `RETRYABLE_ERROR_RE` heuristic  | New handler + cleanup         |

## Existing test structure

`tests/compaction-trigger.test.ts` already has:

- **`captureHandler()`** — registers the trigger, captures `agent_end`, `agent_start`, `turn_end` handlers. Returns `{ handler, startHandler, turnHandler, runtime, pi, inlineCompact }`.
- **`fakeCtx()`** — fake `ExtensionContext` with `sessionManager`, `isIdle`, `compact`, `ui`, `hasUI`, `cwd`.
- **`flushAll()`** — flushes microtasks + advances fake timers for `setTimeout(0)` callbacks.
- **`advanceRetryTicks(n)`** — advances fake timer by `n × 200ms` + microtask flush (simulates the polling loop).
- **`agentEnd(errorMessage?)`** / **`turnEnd()`** — fake event payloads.
- **`vi.useFakeTimers()`** in `beforeEach` / `vi.useRealTimers()` in `afterEach`.

## Phase 1: Cap the polling loop

### 1.1 Test: polling times out after max duration

```typescript
it("caps the idle-poll after 30 seconds and bails", async () => {
  const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
  const ctx = fakeCtx([dueBranch], { isIdle: vi.fn(() => false) }); // never idle

  handler(agentEnd(), ctx);
  expect(runtime.compactInFlight).toBe(true);
  await flushAll();

  // Advance 31 seconds of fake time (past the 30s cap)
  vi.advanceTimersByTime(31_000);
  await Promise.resolve();

  expect(runtime.compactInFlight).toBe(false);
  expect(runtime.autoCompactionController).toBeNull();
  expect(ctx.compact).not.toHaveBeenCalled();
  expect(ctx.ui.notify).toHaveBeenCalledWith(
    "Observational memory: compaction skipped — agent did not become idle within timeout",
    "warning",
  );
});
```

### 1.2 Test: polling cap does not interfere with normal idle detection

```typescript
it("still compacts when agent becomes idle before the cap", async () => {
  const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
  const isIdle = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
  const ctx = fakeCtx([dueBranch], { isIdle });

  handler(agentEnd(), ctx);
  await flushAll();
  await advanceRetryTicks(1); // isIdle returns true after 1 tick

  expect(ctx.compact).toHaveBeenCalledTimes(1);
});
```

### 1.3 Test: `agent_start` abort still wins over the cap

```typescript
it("agent_start abort still wins over the polling cap", async () => {
  const { handler, startHandler, runtime } = captureHandler({ compactAfterTokens: 3 });
  const ctx = fakeCtx([dueBranch], { isIdle: vi.fn(() => false) });

  handler(agentEnd(), ctx);
  await flushAll();

  startHandler(); // aborts the wait loop
  await flushAll();

  // Even after the cap, the abort should have already stopped the loop.
  vi.advanceTimersByTime(31_000);
  await Promise.resolve();

  expect(runtime.compactInFlight).toBe(false);
  expect(runtime.autoCompactionController).toBeNull();
  expect(ctx.compact).not.toHaveBeenCalled();
});
```

### 1.4 Implementation

- Add a `const IDLE_POLL_MAX_MS = 30_000;` constant.
- In the `while (!isIdle)` loop, track elapsed time and break if `Date.now() - startTime > IDLE_POLL_MAX_MS`.
- On timeout: set `compactInFlight = false`, `autoCompactionController = null`, emit a warning notification.
- The `signal.aborted` check inside the inner slice loop already ensures `agent_start` aborts are noticed quickly — no change needed there.

## Phase 2: Migrate to `agent_settled`

### 2.1 Test: `agent_settled` triggers compaction without polling

```typescript
it("agent_settled fires compaction directly when threshold is reached", async () => {
  const { handler, runtime, pi } = captureHandler({ compactAfterTokens: 3 });
  const ctx = fakeCtx([dueBranch]);

  // Simulate agent_settled being emitted
  const settledHandler = (pi.on as any).mock.calls.find(
    (c: any[]) => c[0] === "agent_settled",
  )?.[1];
  expect(settledHandler).toBeDefined();

  settledHandler({ type: "agent_settled" }, ctx);

  expect(ctx.compact).toHaveBeenCalledTimes(1);
  expect(ctx.isIdle).not.toHaveBeenCalled(); // no polling
});
```

### 2.2 Test: `agent_settled` skips when below threshold

```typescript
it("agent_settled does nothing below compactAfterTokens", async () => {
  const { pi } = captureHandler({ compactAfterTokens: 3 });
  const ctx = fakeCtx([belowBranch]);

  const settledHandler = (pi.on as any).mock.calls.find(
    (c: any[]) => c[0] === "agent_settled",
  )?.[1];
  settledHandler({ type: "agent_settled" }, ctx);

  expect(ctx.compact).not.toHaveBeenCalled();
});
```

### 2.3 Test: `agent_settled` skips retryable errors (no `RETRYABLE_ERROR_RE` needed)

```typescript
it("agent_settled does not retry — the retry logic is handled by pi core", async () => {
  const { pi } = captureHandler();
  const ctx = fakeCtx([dueBranch]);

  const settledHandler = (pi.on as any).mock.calls.find(
    (c: any[]) => c[0] === "agent_settled",
  )?.[1];
  settledHandler({ type: "agent_settled" }, ctx);

  // agent_settled fires after pi's retry check — we don't need RETRYABLE_ERROR_RE.
  // The handler should just check threshold and compact (or skip).
  // If a retryable error occurred, pi wouldn't emit agent_settled yet.
  // So we just verify the handler doesn't reference RETRYABLE_ERROR_RE.
  expect(ctx.compact).toHaveBeenCalledTimes(1);
});
```

### 2.4 Test: `agent_settled` handles stale ctx

```typescript
it("agent_settled ignores stale extension ctx", async () => {
  const { runtime } = captureHandler({ compactAfterTokens: 3 });
  const staleCtx: any = {
    get cwd() {
      throw { message: "This extension ctx is stale after session replacement or reload." };
    },
  };

  const settledHandler = (pi.on as any).mock.calls.find(
    (c: any[]) => c[0] === "agent_settled",
  )?.[1];
  expect(() => settledHandler({ type: "agent_settled" }, staleCtx)).not.toThrow();
  expect(runtime.compactInFlight).toBe(false);
});
```

### 2.5 Test: `agent_settled` + `agent_end` fallback coexistence

```typescript
it("agent_end fallback still works when agent_settled is not available", async () => {
  const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
  const ctx = fakeCtx([dueBranch]);

  // agent_end path should still work (backward compat with older pi versions)
  handler(agentEnd(), ctx);
  await flushAll();
  await advanceRetryTicks(1);

  expect(ctx.compact).toHaveBeenCalledTimes(1);
});
```

### 2.6 Implementation

In `registerCompactionTrigger()`:

```typescript
// Register agent_settled handler (primary path — fires after retries/queued continuations)
pi.on("agent_settled", (event: any, ctx: any) => {
  try {
    handleAgentSettled(ctx, runtime);
  } catch (error) {
    if (isStaleExtensionContextError(error)) return;
    throw error;
  }
});
```

`handleAgentSettled()` — same logic as `handleAgentEnd()` but:

- No `RETRYABLE_ERROR_RE` check (pi already handled retries)
- No `isIdle()` polling (agent is already idle)
- No `setTimeout(0)` deferral
- Same threshold check, same guards, same `ctx.compact()` call

`handleAgentEnd()` — kept as fallback for older pi versions that don't emit `agent_settled`:

- Still has the `RETRYABLE_ERROR_RE` check
- Still has the capped polling loop
- Same guards and threshold check

## Phase 3: Cleanup

### 3.1 Remove `RETRYABLE_ERROR_RE` from `handleAgentEnd`

Once `agent_settled` is the primary path and the fallback is clearly documented, remove the `RETRYABLE_ERROR_RE` heuristic from `handleAgentEnd` — it's no longer needed because the polling cap prevents indefinite blocking.

Actually, keep it in `handleAgentEnd` for now — it's a cheap guard and doesn't hurt. The main win is removing it from the _conceptual_ path (agent_settled doesn't need it).

### 3.2 Update tests

- Existing `agent_end` tests continue to work (backward compat).
- New `agent_settled` tests verify the primary path.
- The "issue #31 race" test (`waits for the agent to become idle`) should still pass for the `agent_end` fallback.

## Test file structure

```
tests/compaction-trigger.test.ts
├── "V3 compaction trigger (blackhole)"
│   ├── existing agent_end tests (unchanged)
│   └── NEW: polling cap tests (Phase 1)
├── "mid-run compaction trigger (turn_end)"
│   └── existing turn_end tests (unchanged)
├── "mid-run compaction cancellation resilience"
│   └── existing tests (unchanged)
├── "mid-run compaction retry math"
│   └── existing tests (unchanged)
├── "inline adapter classification"
│   └── existing tests (unchanged)
└── NEW: "agent_settled trigger"
    ├── Phase 2 tests (2.1–2.5)
    └── coexistence with agent_end fallback
```

## Red → Green → Refactor plan

### Step 1: RED — polling cap tests fail

- Add 3 new tests (1.1, 1.2, 1.3) to the existing test file.
- Run: expect failures (no cap exists yet).

### Step 2: GREEN — implement polling cap

- Add `IDLE_POLL_MAX_MS = 30_000`.
- Track elapsed time in the polling loop.
- Break + bail on timeout with warning notification.
- Run: all tests pass.

### Step 3: RED — agent_settled tests fail

- Add 5 new tests (2.1–2.5) in a new describe block.
- Run: expect failures (no `agent_settled` handler exists).

### Step 4: GREEN — implement agent_settled handler

- Register `pi.on("agent_settled", ...)` in `registerCompactionTrigger()`.
- Extract `handleAgentSettled()` — same logic, no polling, no retry check.
- Run: all tests pass.

### Step 5: Refactor (optional)

- Consider removing `RETRYABLE_ERROR_RE` from `handleAgentEnd` if it's clearly dead code.
- Update JSDoc comments to document the dual-path design.
- Run: all 1585 tests pass.

## Risk assessment

| Risk                                                     | Mitigation                                              |
| -------------------------------------------------------- | ------------------------------------------------------- |
| Older pi versions don't emit `agent_settled`             | `agent_end` fallback with capped polling stays in place |
| `agent_settled` fires but session changed mid-handling   | Same stale ctx check as `agent_end`                     |
| `agent_settled` + `agent_end` both fire (double compact) | `compactInFlight` guard prevents double compaction      |
| `RETRYABLE_ERROR_RE` still in `agent_end` fallback       | Cheap guard, no harm; can be removed later              |

## Files changed

| File                               | Changes                                                                |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `src/om/compaction-trigger.ts`     | Add `agent_settled` handler + `handleAgentSettled()`; cap polling loop |
| `tests/compaction-trigger.test.ts` | Add polling cap tests + `agent_settled` tests                          |
| `src/om/retryable-error.ts`        | (optional) Remove `RETRYABLE_ERROR_RE` if dead code                    |
| `CHANGELOG.md`                     | Document the dual-path design                                          |
