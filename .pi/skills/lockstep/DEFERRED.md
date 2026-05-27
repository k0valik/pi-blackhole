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
