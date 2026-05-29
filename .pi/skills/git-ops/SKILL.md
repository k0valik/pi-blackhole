---
name: git-ops
description: Safe local git housekeeping — branch safety checks, diff analysis, stash verification, and cleanup confirmation without touching remotes. Use when switching branches, cleaning up stale branches, diffing branches before merging, or checking if progress would be lost before any destructive git operation.
---

# Git Ops

## Hard Rules

- **Never** touch remote/online branches — no deletions, no force pushes, no main merges.
- **Never** push to main without explicit user approval.
- All operations are local unless the user explicitly asks otherwise.

## Safety Checklist (before any branch switch or destructive operation)

Run these **before** `git checkout`, `git branch -d`, `git reset`, `git rebase`, or `git stash drop`:

```bash
# 1. Any unstaged/uncommitted changes?
git status --short

# 2. Check stash
git stash list

# 3. Confirm target branch exists
git rev-parse --verify <branch-name> 2>/dev/null || echo "NO SUCH BRANCH"

# 4. Will switching lose anything?
git diff --stat HEAD..<target-branch> | tail -5
```

## Branch Safety Checks

### Is a branch fully merged (safe to delete locally)?

```bash
# Check 1: unique commits ahead of main
git rev-list --count main..<branch>

# Check 2: is tip an ancestor of main? (all work already on main)
git merge-base --is-ancestor <branch> main && echo "SAFE - ancestor of main" || echo "NOT SAFE"

# Check 3: any unique files not on main?
diff <(git ls-tree -r --name-only <branch> | sort) <(git ls-tree -r --name-only main | sort) | grep '^<' || echo "no unique files"

# Check 4: show unique commits
git log --oneline main..<branch>
```

A branch is **safe to delete locally** when ALL of:
- 0 commits ahead of main
- Tip is ancestor of main
- No unique files

### What unique work is on a branch?

```bash
# Summary
git diff --stat main..<branch>

# Only meaningful source/test files (filter noise)
git diff --stat main..<branch> -- src/ tests/

# Individual commits
git log --oneline main..<branch>
```

### Merge-base (where did it diverge?)

```bash
git merge-base main <branch>
```

## Local Cleanup Workflow

1. **Verify** the branch is safe (run the "fully merged" checks above)
2. **Show** the user the summary — let them confirm
3. **Delete** only locally: `git branch -d <branch>`
4. **Confirm** deletion: `git branch`

## Stash Management

```bash
# List all stashes
git stash list

# Show what's in the latest stash without applying
git stash show -p stash@{0} | head -40

# Show file list in a stash
git stash show stash@{0}
```

Never `git stash drop` or `git stash clear` without first showing the user what's in the stash.

## Branch State Summary

Run this to get the full picture:

```bash
for b in $(git branch --format='%(refname:short)' | grep -v '^\*'); do
  echo "--- $b ---"
  ahead=$(git rev-list --count main..$b 2>/dev/null || echo "?")
  behind=$(git rev-list --count $b..main 2>/dev/null || echo "?")
  echo "AHEAD: $ahead, BEHIND: $behind"
  tip_ancestor=$(git merge-base --is-ancestor $b main 2>/dev/null && echo "yes" || echo "no")
  echo "Ancestor of main: $tip_ancestor"
done
```

## What NOT To Do

- ❌ `git push --delete origin <branch>` — never without explicit approval
- ❌ `git push --force` — never without explicit approval
- ❌ `git push origin main` — never without explicit approval
- ❌ `git branch -D` (force delete) — never use `-D`, always `-d` (which refuses if unmerged)
- ❌ `git stash drop` / `git stash clear` — never without showing user first
