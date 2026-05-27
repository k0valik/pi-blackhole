---
name: lockstep
description: Audit upstream changes from pi-vcc (sting8k/pi-vcc) and pi-observational-memory (elpapi42/pi-observational-memory) against our heavily diverged frankenmerge. Use when user says "check upstream", "lockstep", "what changed upstream", "sync upstream", or when making any change that touches files derived from those repos. Never use for design discussions or new features unrelated to upstream tracking.
---

# Lockstep — upstream change audit for pi-blackhole

Blackhole is a **file-copied** (not git-forked) merge of two upstream repos. No shared git ancestry. All tracking is via stored SHA markers in `.pi/skills/lockstep/`.

## Branch strategy

Lockstep always operates on a **dedicated branch based on `main`** (the canonical npm-published branch). Ported changes are submitted as a **PR against `main`** for review before merging.

```
main ──→ lockstep/YYYY-MM-DD ──(PR)──→ main
```

This keeps lockstep work isolated from feature branches (`feat/*`) and ensures the review trail is visible.

## Setup prerequisites

The lockstep scripts must be run from the **pi-blackhole repo root** (the extension directory).
The agent's CWD is set automatically — for manual runs:

```bash
cd <pi-blackhole-repo-root>
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
| `scripts/lockstep.js` | Create lockstep branch, fetch upstreams, show new commits since last mark, classify each changed file against our mapping table. Use `--create-branch` to auto-setup the branch. Add `--save` to also write the full report to `docs/lockstep-report-<date>.md` (gitignored) for local viewing. |
| `scripts/upstream-diff.js` | Compare our files against upstream HEAD — shows what truly differs (stripping comment headers). Use `--summary` for counts, `--only-different` to skip identical files. |

## Workflow

### Step 1: Create a lockstep branch

Automate the branch setup:

```bash
node .pi/skills/lockstep/scripts/lockstep.js --create-branch
```

This will:
1. Check for a dirty working tree and stash if needed
2. `git checkout main && git pull`
3. `git checkout -b lockstep/YYYY-MM-DD` (auto-named with today's date)
4. Fetch upstreams and run the full audit report

Options:
- `--vcc` — check pi-vcc only
- `--om` — check pi-observational-memory only
- `--branch <name>` — use a custom branch name instead of auto-generating

### Step 2: Inspect audit output

The audit prints every new upstream commit since the last marker. Each changed file is classified against `lockstep-mapping.json` as:

```
SAFE       — can port directly (UNCHANGED or MOVED)
MODIFIED   — we changed this file; review upstream diff carefully
REWRITTEN  — fundamentally different; likely skip
ELIMINATED — file doesn't exist in our repo; skip
DELETED    — upstream deleted it but we still have it; decide
ORPHAN     — no mapping entry; may need mapping update
```

For any commit flagged, drill into the actual differences:

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
5. Commit each ported change with a descriptive message:

```bash
git add src/...
git commit -m "lockstep: port <upstream-hash> — <brief description>"
```

### Step 6: Advance markers after review

Once all decisions are made (port, skip, or defer), advance the marker so future audits only show newer commits:

```bash
node .pi/skills/lockstep/scripts/lockstep.js --update-markers
```

This writes the current upstream HEAD SHA to `.upstream-vcc-head` / `.upstream-om-head` on the lockstep branch.

### Step 7: Update CHANGELOG and commit

Add an entry to `CHANGELOG.md` summarizing what was ported:

```markdown
## [unreleased]

### Lockstep sync — YYYY-MM-DD

- Ported <upstream-hash>: <description> [#classification]
- Skipped <upstream-hash>: <reason>
```

Then commit the marker and changelog updates:

```bash
git add CHANGELOG.md .pi/skills/lockstep/.upstream-*-head
git commit -m "lockstep: advance markers and update CHANGELOG"
```

### Step 8: Generate PR summary and verify checklist

After markers and CHANGELOG are committed, generate the PR summary:

```bash
node .pi/skills/lockstep/scripts/lockstep.js --pr-summary
```

This saves a formatted PR description to `docs/pr-summary-YYYY-MM-DD.md` (gitignored).
Read it and verify the checklist is complete before opening the PR:

- [ ] Each ported change verified with `npx tsc --noEmit`
- [ ] CHANGELOG.md updated with ported/skipped/deferred changes
- [ ] Markers advanced to current upstream HEAD
- [ ] Deferred decisions logged in DEFERRED.md
- [ ] PR summary generated and reviewed

The script auto-checks the first three items — verify the remaining ones manually.

### Step 9: Open a PR

Push the branch and open a pull request against `main`:

```bash
git push origin lockstep/YYYY-MM-DD
```

Use the saved PR description from `docs/pr-summary-YYYY-MM-DD.md` when creating the PR on GitHub.

### Step 10: Check PR reviews

After the PR is opened, reviewers may leave comments. Fetch them all (including line-level suggestions):

```bash
node .pi/skills/lockstep/scripts/lockstep.js --fetch-reviews <pr-number>
```

This auto-detects the PR from the current branch if `<pr-number>` is omitted, and outputs all review bodies and line-level suggestions. Evaluate each suggestion against the actual code — do not blindly apply automated reviews.

## Marker files — what they mean

| File | Tracks | Current value |
|---|---|---|
| `.upstream-vcc-head` | Last audited pi-vcc commit | `1994b26...` (v0.3.15 — our fork point) |
| `.upstream-om-head` | Last audited OM commit | `6777643...` (marker as of last audit) |

Markers are stored on the lockstep branch after review. They advance as upstream releases arrive.

To see what upstream changes are available but not yet reviewed:
```bash
node .pi/skills/lockstep/scripts/lockstep.js --vcc
```

To reset a marker (start over from upstream HEAD):
```bash
cd <pi-blackhole-repo-root>
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
