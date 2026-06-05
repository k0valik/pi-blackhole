# Deferred upstream decisions

Changes reviewed but not yet ported. Reviewed and resolved once decided.

## pi-vcc `a156870` — normalization noise cleanup

**Date**: 2026-05-26
**Status**: ⏳ Deferred
**Commit**: `a156870` refactor: remove unused message normalization noise
**Link**: https://github.com/sting8k/pi-vcc/commit/a156870

### What it does
Removes from the VCC compaction pipeline:
- `thinking` blocks (model reasoning) — we had these but they were already stripped before summary output
- `isError` flag + `[tool_error]` sections — we actively use these for error highlighting in compaction output
- `transcriptEntries` JSON format — dead code (defined, never consumed)
- `entryIds` tracking — dead code (returned, never consumed)

### Why deferred
Porting would remove error highlighting (`[tool_error]` sections, `ERROR` prefix on tool results) from compaction output. That's a feature loss. The thinking block removal and dead code cleanup are harmless, but they're bundled with the error-highlighting removal in the same commit.

### Decision needed
Option A: Skip entirely (keep error highlighting)
Option B: Manually extract only the safe parts (thinking removal + dead code cleanup) without touching `isError`

---

## pi-observational-memory — OM pool refactor

### `bf79ff7` — Extract pool metrics into `pool.ts`

Extracts pool metric functions (observationPoolFullness, dropUrgencyForFullness, maxDropCountForPool) from agent.ts into a new pool.ts module. Replaces inline calculations with observationPoolMetrics() call.

**Date**: 2026-05-27 (re-evaluated 2026-06-05)
**Status**: ⏳ Deferred
**Blocking**: Previously blocked by `noautocompact-reflector-dropper` branch (now stale/dropped). Still deferred — touches heavily diverged files (`consolidation.ts`, `runtime.ts`).
**Risk**: HIGH — our `consolidation.ts` and `runtime.ts` have fundamentally different architecture (fallback chains, cooldowns, pending.json).
**Mitigation applied**: `observationsPoolTargetTokens` added as forward-compat no-op config entry in `unified-config.ts`.
**Re-evaluate**: When upstream makes further pool-related changes, or if we refactor our consolidation pipeline.

### `52b5844` — `budgetTokens` → `targetTokens` rename + over-budget algorithm

Renames `budgetTokens` → `targetTokens` in RunDropperArgs interface. Changes pool algorithm from ratio-based (fullness% → urgency → % of pool) to over-budget-based (tokensOverTarget / avgObservationTokens).

**Date**: 2026-05-27 (re-evaluated 2026-06-05)
**Status**: ⏳ Deferred
**Blocking**: Same as `bf79ff7`.
**Risk**: HIGH — field renames would propagate through our custom `unified-config.ts` schema, `consolidation.ts` call site at line 654, and all callers.

### Decision needed (for both)
Option A: Port both commits when consolidation.ts can also be updated (requires coordination)
Option B: Skip permanently — our ratio-based algorithm works, rename is cosmetic
Option C: Port rename only (adapt consolidation.ts call sites) but keep our pool algorithm
