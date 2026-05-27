---
name: lockstep
description: Audit upstream changes from pi-vcc (sting8k/pi-vcc) and pi-observational-memory (elpapi42/pi-observational-memory) against our heavily diverged frankenmerge. Use when user says &quot;check upstream&quot;, &quot;lockstep&quot;, &quot;what changed upstream&quot;, &quot;sync upstream&quot;, or when making any change that touches files derived from those repos. Never use for design discussions or new features unrelated to upstream tracking.
---

# Lockstep — upstream change audit for pi-blackhole

Blackhole is a **file-copied** (not git-forked) merge of two upstream repos. No shared git ancestry. All tracking is via stored SHA markers in `.pi/skills/lockstep/`.

## Setup prerequisites

The lockstep scripts must be run from the **pi-blackhole repo root** (the extension directory):

```bash
cd /home/kovalik/.pi/agent/extensions/pi-blackhole
git fetch upstream-pi-vcc                     # one-time setup
git fetch upstream-pi-observational-memory    # one-time setup
```

Remotes are auto-created on first script run, but a manual fetch ensures they exist.

## ⚠ CRITICAL: Human-approval-only workflow

**You MUST show me everything — every upstream commit, every changed file, every diff — and wait for my explicit approval before acting on anything. No exceptions.**

Even after I approve porting a specific fix or feature, you must then:

1. **Study the code carefully** — read the upstream diff, then read our corresponding file in full
2. **Trace downstream impacts** — does this change affect any of our unique features? (cooldown, pending.json, noAutoCompact, fallback chains, unified-config, reverse-recall)
3. **Check for conflicts** — does it touch lines we modified? If so, does the fix still apply correctly given our changes?
4. **Present your analysis** — explain the proposed change, what it fixes, what files it touches, and why it's safe (or why it's risky)
5. **Wait for approval** — I will say "yes, port it" or "skip it" explicitly
6. **Only then write code** — never assume approval, never pre-write changes "in case I agree"

**Nothing gets ported without a human decision.**

## Available scripts

| Script | Purpose |
|---|---|
| `scripts/lockstep.js` | Fetch upstreams, show new commits since last mark, classify each changed file against our mapping table |
| `scripts/upstream-diff.js` | Compare our files against upstream HEAD — shows what truly differs (stripping comment headers). Use `--summary` for counts, `--only-different` to skip identical files |

## Workflow

### Step 1: Run the audit

```bash
node .pi/skills/lockstep/scripts/lockstep.js
```

This reads CHANGELOG.md, shows current branch/HEAD, fetches upstreams, and prints every new commit since our last review mark. Each changed file is classified as SAFE, MODIFIED, REWRITTEN, etc. against the mapping table.

Options:
- `--vcc` — check pi-vcc only
- `--om` — check observational-memory only

### Step 2: Inspect actual differences

For any commit the audit flagged, drill into the actual file differences:

```bash
# Show the upstream diff for a specific commit
git show <hash>

# Or compare our file directly against upstream HEAD
node .pi/skills/lockstep/scripts/upstream-diff.js --only-different
```

### Step 3: Classify each changed file

For every file the upstream changed, consult `lockstep-mapping.json`:

```
Is it in the mapping table?
├── NO  → "ORPHAN" — update lockstep-mapping.json
└── YES → check status in mapping:

    UNCHANGED ──→ SAFE to port
        Same path, unmodified. Apply upstream diff directly.
        Verify with: npx tsc --noEmit
    
    MOVED ──→ SAFE to port
        e.g., session-ledger/fold.ts → om/ledger/fold.ts.
        Apply upstream diff to our moved path.
    
    MODIFIED ──→ REVIEW carefully
        Same path, we changed it.
        1. Read the upstream diff
        2. Read our file — does the change touch our additions or different areas?
        3. If different functions/lines → straightforward port
        4. If same lines → evaluate whether fix still applies
    
    REWRITTEN ──→ SKIP
        Examples: consolidation.ts, runtime.ts, config.ts, before-compact.ts
        Our versions have fundamentally different architecture.
    
    ELIMINATED/MERGED ──→ SKIP
        File no longer exists in our repo (settings.ts, report.ts, compaction-hook.ts, etc.)
    
    DELETED ──→ DECIDE
        Upstream deleted it but we still have it. Keep intentionally or delete.
```

### Step 4: Dependency audit — check for feature loss

**Before porting any commit that removes code**, verify we don't depend on the removed feature:

```bash
# Example: check if "isError" is used anywhere in our codebase
grep -rn "isError" src/ --include="*.ts"

# Check if a removed type/function/field is referenced
grep -rn "transcriptEntries" src/ --include="*.ts"
grep -rn "entryIds" src/ --include="*.ts"
```

If the removed feature is used by us, porting would cause **feature loss** and should be skipped (or adapted to preserve our usage).

### Step 5: Port safe changes

For SAFE and compatible MODIFIED changes:

1. Read the upstream diff: `git show <hash> -- <upstream-filepath>`
2. Apply equivalent change to our file (use `edit` tool)
3. Verify: `npx tsc --noEmit`
4. Run tests if they exist: `npx vitest run tests/<relevant-file>`

### Step 6: Advance markers after review

Once all decisions are made (port, skip, or defer), advance the marker so future audits only show newer commits:

```bash
node .pi/skills/lockstep/scripts/lockstep.js --update-markers
```

This writes the current upstream HEAD SHA to `.upstream-vcc-head` / `.upstream-om-head`.

## Marker files — what they mean

| File | Tracks | Current value |
|---|---|---|
| `.upstream-vcc-head` | Last audited pi-vcc commit | `1994b26...` (v0.3.15 — our fork point) |
| `.upstream-om-head` | Last audited OM commit | `6777643...` (HEAD — already reviewed) |

The VCC marker is set to v0.3.15 because that's the version we file-copied. The 2 commits after it (`a156870` + `b4c9099`) are the normalization cleanup — skip/port decision pending.

To see what upstream changes are available but not yet reviewed:
```bash
node .pi/skills/lockstep/scripts/lockstep.js --vcc
```

To reset a marker (start over from upstream HEAD):
```bash
git rev-parse refs/remotes/upstream-pi-vcc/master > .pi/skills/lockstep/.upstream-vcc-head
```

## What to prioritize

| Priority | What | Why |
|---|---|---|
| 1 | **Bug fixes** | Edge cases in compaction, orphan recovery, tool result handling |
| 2 | **Prompt improvements** | Our prompts are unmodified — upstream improvements apply directly |
| 3 | **Token counting / progress** | `om/ledger/progress.ts` — low risk, shared core logic |
| 4 | **Ledger folding** | `om/ledger/fold.ts` — identical to upstream, safe to port fixes |
| 5 | **Peer dep bumps** | Package version compatibility |

## What to skip (usually)

| File | Reason |
|---|---|
| `src/hooks/before-compact.ts` | We inject OM content after VCC compile. Upstream VCC changes won't include OM injection. |
| `src/om/consolidation.ts` | Completely rewritten with fallback chains, cooldowns, pending.json. Upstream version is unrecognizably different. |
| `src/om/runtime.ts` | Heavily extended. |
| `src/om/config.ts` | Just re-exports from unified-config.ts. |
| `src/core/settings.ts` (upstream) | Eliminated — replaced by unified-config.ts. |
| `src/core/report.ts` (upstream) | Eliminated — dead code. |
| `src/commands/status.ts` / `view.ts` (upstream) | Eliminated — replaced by memory.ts. |

## Prior deferred decisions

Check [DEFERRED.md](DEFERRED.md) for upstream changes that were reviewed but not yet decided on. If a deferred decision is still pending when a new upstream commit touches the same area, flag it as potentially relevant.

## Reference

- [LOCKSTEP_REFERENCE.md](LOCKSTEP_REFERENCE.md) — full file topology, fork point details, file-by-file risk assessment
- [DEFERRED.md](DEFERRED.md) — upstream changes reviewed but not yet ported/skipped
- `lockstep-mapping.json` — machine-readable bijection table (72 entries) used by both scripts
