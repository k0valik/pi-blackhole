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

## pi-observational-memory `bf79ff7` + `52b5844` — pool refactor and budgetTokens→targetTokens rename

**Date**: 2026-05-27
**Status**: ⏳ Deferred
**Commits**:
- `bf79ff7` Use active ledger pressure for dropper
- `52b5844` Gate dropper on target tokens after reflection

### What they do
- `bf79ff7`: Extracts pool metric functions (observationPoolFullness, dropUrgencyForFullness, maxDropCountForPool) from `agent.ts` into a new `pool.ts` module. Replaces inline calculations with `observationPoolMetrics()` call.
- `52b5844`: Renames `budgetTokens` → `targetTokens` in the RunDropperArgs interface, removes `dropUrgencyForFullness` export, adds `tokensOverTarget` metric. Changes the pool algorithm from ratio-based (fullness% → urgency → % of pool) to over-budget-based (tokensOverTarget / avgObservationTokens).

### Why deferred
These commits touch heavily modified ground:
1. The pool refactor extracts shared functions that our `consolidation.ts` call site also uses — porting would conflict with our existing `budgetTokens` call at consolidation.ts:654
2. The rename (`budgetTokens` → `targetTokens`) percolates to `consolidation.ts` which is also modified by local branches (fix/noautocompact-reflector-dropper)
3. The pool algorithm change (ratio-based → over-budget-based) is a behavioral change that needs careful testing against our noAutoCompact mode
4. We have unique features (`existingObservationsSummary`, `observerPreambleMaxTokens`) that interact with the dropper interface

### Mitigation applied
Added `observationsPoolTargetTokens` as a forward-compat no-op config entry (`unified-config.ts`) so the config shape is aligned with upstream even though our code doesn't use it yet. This prevents downstream lockstep divergence on the config schema.

### Decision needed
Option A: Port both commits when we can also update consolidation.ts (requires coordination with fix/noautocompact-reflector-dropper branch)
Option B: Skip permanently — our ratio-based algorithm works, and the rename is cosmetic
Option C: Port the rename only (adapt consolidation.ts call sites) but keep our pool algorithm
