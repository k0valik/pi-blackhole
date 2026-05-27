#!/usr/bin/env node
/**
 * Lockstep audit — read-only report of upstream changes against our fork.
 *
 * Usage:
 *   node scripts/lockstep.js                         # audit both upstreams
 *   node scripts/lockstep.js --vcc                   # pi-vcc only
 *   node scripts/lockstep.js --om                    # pi-observational-memory only
 *   node scripts/lockstep.js --create-branch         # start lockstep from main on a new branch
 *   node scripts/lockstep.js --create-branch --branch my-custom-name  # custom branch name
 *   node scripts/lockstep.js --create-branch --vcc   # create branch + audit VCC only
 *   node scripts/lockstep.js --update-markers        # update .upstream-*-head after review
 *   node scripts/lockstep.js --pr-summary            # generate PR description from state
 *
 * This script never modifies source code except for marker files (with --update-markers).
 * It fetches upstream commits, classifies changed files against our mapping table,
 * and produces a structured report.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(__dirname, "..");
const REPO_DIR = resolve(SKILL_DIR, "..", "..", ".."); // .pi/skills/lockstep/ → repo root

const args = process.argv.slice(2);
const CHECK_VCC = args.includes("--vcc") || (!args.includes("--om") && !args.includes("--vcc") && !args.includes("--pr-summary"));
const CHECK_OM = args.includes("--om") || (!args.includes("--om") && !args.includes("--vcc") && !args.includes("--pr-summary"));
const UPDATE_MARKERS = args.includes("--update-markers");
const CREATE_BRANCH = args.includes("--create-branch");
const PR_SUMMARY = args.includes("--pr-summary");

// Extract custom branch name from --branch <name>
let customBranch = null;
const branchIdx = args.indexOf("--branch");
if (branchIdx !== -1 && branchIdx < args.length - 1) {
  customBranch = args[branchIdx + 1];
}

// ── Load mapping table ──────────────────────────────────────────────────────

const mappingPath = resolve(SKILL_DIR, "lockstep-mapping.json");
if (!existsSync(mappingPath)) {
  console.error("❌ lockstep-mapping.json not found at", mappingPath);
  process.exit(1);
}
const mapping = JSON.parse(readFileSync(mappingPath, "utf-8"));

// ── Utility helpers ─────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { cwd: REPO_DIR, encoding: "utf-8", ...opts }).trim();
  } catch (e) {
    return null;
  }
}

function heading(label) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${label}`);
  console.log("=".repeat(60));
}

function subheading(label) {
  console.log(`\n  ── ${label} ──`);
}

const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
};

function color(code, text) {
  return `${COLORS[code] || ""}${text}${COLORS.reset}`;
}

function statusTag(status) {
  const map = {
    SAFE: color("green", "  SAFE"),
    UNCHANGED: color("green", "  SAFE"),
    MODIFIED: color("yellow", "MODIFIED"),
    REWRITTEN: color("red", "REWRITTEN"),
    MOVED: color("cyan", "   MOVED"),
    MERGED: color("cyan", "  MERGED"),
    ELIMINATED: color("gray", "ELIMINATED"),
    DELETED: color("red", " DELETED"),
    NEW: color("blue", "    NEW"),
    ORPHAN: color("red", " ORPHAN"),
  };
  return map[status] || color("gray", `  ${status}`);
}

// ── Read/write marker files ─────────────────────────────────────────────────

function readMarker(name) {
  const p = resolve(SKILL_DIR, name);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf-8").trim();
}

function writeMarker(name, hash) {
  writeFileSync(resolve(SKILL_DIR, name), hash + "\n");
}

// ── Branch management ───────────────────────────────────────────────────────

function getCurrentBranch() {
  return run("git rev-parse --abbrev-ref HEAD");
}

function hasDirtyChanges() {
  const status = run("git status --porcelain");
  return status && status.length > 0;
}

function ensureCleanWorkingTree() {
  if (!hasDirtyChanges()) return false;
  const stashResult = run("git stash push -m 'lockstep: auto-stash before branch switch' 2>&1");
  if (stashResult === null) {
    console.error("  ❌ Could not stash dirty changes. Please commit or stash manually.");
    process.exit(1);
  }
  console.log(`  💾 Stashed dirty working tree.`);
  return true;
}

function setupLockstepBranch() {
  const currentBranch = getCurrentBranch();
  console.log(`\n  Current branch: ${color("bold", currentBranch)}`);

  // Generate branch name
  const today = new Date().toISOString().slice(0, 10);
  const branchName = customBranch || `lockstep/${today}`;

  // Check if already on a lockstep branch
  if (currentBranch === branchName) {
    console.log(`  Already on ${color("bold", branchName)} — skipping branch setup.`);
    return true;
  }

  // Stash any dirty changes
  const didStash = ensureCleanWorkingTree();

  // If not on main, check if this is already a lockstep branch
  if (currentBranch !== "main") {
    if (currentBranch.startsWith("lockstep/")) {
      console.log(`  Already on a lockstep branch (${color("bold", currentBranch)}).`);
      console.log(`  To start fresh from main, first switch manually: git checkout main`);
      console.log(`  Then re-run with --create-branch.`);
      return false;
    }
    console.log(`  ⚠ Not on ${color("bold", "main")} — currently on ${color("bold", currentBranch)}.`);
    console.log(`  Will switch to main first.`);
  }

  // Switch to main and pull
  console.log(`\n  Switching to ${color("bold", "main")}...`);
  const checkoutResult = run("git checkout main 2>&1");
  if (checkoutResult === null) {
    console.error("  ❌ Could not switch to main. Check for conflicts.");
    return false;
  }

  const pullResult = run("git pull 2>&1");
  if (pullResult === null) {
    console.warn("  ⚠ Could not pull main (may not have remote tracking). Continuing...");
  } else {
    console.log(`  Pulled latest main.`);
  }

  // Create the lockstep branch
  console.log(`\n  Creating ${color("bold", branchName)}...`);
  const branchResult = run(`git checkout -b ${branchName} 2>&1`);
  if (branchResult === null) {
    // Branch may already exist — try checking it out
    const switchResult = run(`git checkout ${branchName} 2>&1`);
    if (switchResult === null) {
      console.error(`  ❌ Could not create or switch to ${branchName}.`);
      return false;
    }
    console.log(`  Checked out existing branch ${color("bold", branchName)}.`);
  } else {
    console.log(`  Created and switched to ${color("bold", branchName)}.`);
  }

  return true;
}

// ── Fetch upstream ──────────────────────────────────────────────────────────

function fetchUpstream(repo, name) {
  const remote = `upstream-${name}`;
  // Check if remote exists
  const remotes = run(`git remote get-url ${remote} 2>/dev/null`);
  if (!remotes) {
    run(`git remote add ${remote} ${repo} 2>/dev/null`);
    console.log(`  Added remote ${remote} → ${repo}`);
  }
  const result = run(`git fetch ${remote} 2>&1`, { timeout: 30000 });
  if (result === null) {
    console.error(`  ❌ Failed to fetch ${name} from ${repo}`);
    return null;
  }
  return remote;
}

// ── Get commits since last marker ───────────────────────────────────────────

function getNewCommits(remote, branch, marker) {
  // Resolve remote HEAD (try configured branch, fall back to whatever HEAD points to)
  let remoteHead = run(`git rev-parse refs/remotes/${remote}/${branch}`);
  if (!remoteHead) {
    remoteHead = run(`git rev-parse refs/remotes/${remote}/HEAD`);
    if (!remoteHead) {
      console.error(`  ❌ Cannot resolve refs/remotes/${remote}/${branch} or HEAD — fetch may have failed.`);
      return null;
    }
    console.log(`  ⚠ Configured branch '${branch}' not found; using remote HEAD instead.`);
  }

  if (!marker) {
    // First run — show all upstream commits (no baseline yet)
    const allLog = run(`git log --oneline refs/remotes/${remote}/${branch}`);
    console.log(`  ℹ No stored marker — showing all upstream commits.`);
    return { remoteHead, marker: null, log: allLog ? allLog.split("\n") : [] };
  }

  if (marker === remoteHead) {
    return { remoteHead, marker, log: [] };
  }

  // Blackhole has NO git ancestry with upstreams (file-copied fork).
  // We use stored markers instead of merge-base.
  // Try git log <marker>..<remote/HEAD> — works if both SHAs are in object store.
  let log = run(`git log --oneline ${marker}..refs/remotes/${remote}/${branch}`);
  if (log === null) {
    // Marker not found in object store (e.g., marker from before a fetch, or corrupted)
    console.log(`  ⚠ Stored marker ${marker.slice(0, 12)} not found in object store.`);
    console.log(`    Showing all upstream commits. Re-run with --update-markers to set baseline.`);
    log = run(`git log --oneline refs/remotes/${remote}/${branch}`);
  }

  return {
    remoteHead,
    marker,
    log: log ? log.trim().split("\n").filter(Boolean) : [],
  };
}

// ── Get changed files for a commit ─────────────────────────────────────────

function getChangedFiles(commitHash) {
  const output = run(`git diff-tree --no-commit-id -r --name-status ${commitHash}`, { timeout: 10000 });
  if (!output) return [];
  return output.split("\n").filter(Boolean).map((line) => {
    const [status, ...pathParts] = line.split(/\s+/);
    return { status: status || "?", path: pathParts.join(" ") };
  });
}

// ── Get diff stat for a file between two commits ───────────────────────────

function getDiffStat(commitHash, filePath) {
  // Get diff with first parent (or just the commit itself)
  return run(`git diff ${commitHash}^..${commitHash} -- "${filePath}" 2>/dev/null`, { timeout: 10000 });
}

// ── Find file in mapping table ─────────────────────────────────────────────

function findMapping(upstreamName, filePath) {
  return mapping.files.find((f) => f.upstream === upstreamName && f.path === filePath) || null;
}

// ── Collect upstream changes for PR summary ────────────────────────────────

function collectUpstreamChanges(name, markerFile) {
  const upstream = mapping.upstreams[name];
  if (!upstream) return null;

  const remote = `upstream-${name}`;
  const marker = readMarker(markerFile);
  if (!marker) return null;

  const remoteHead = run(`git rev-parse refs/remotes/${remote}/${upstream.branch}`);
  if (!remoteHead || marker === remoteHead) return null;

  const log = run(`git log --oneline ${marker}..refs/remotes/${remote}/${upstream.branch}`);
  if (!log) return null;

  const commits = log.trim().split("\n").filter(Boolean);
  return { upstream: name, remoteHead, marker, commits };
}

// ── Build the audit report ──────────────────────────────────────────────────

function auditUpstream(name, repoUrl, branch, markerFile) {
  heading(`${name}`);

  // Current branch and HEAD
  const branch_name = run("git rev-parse --abbrev-ref HEAD");
  const headHash = run("git rev-parse HEAD");
  console.log(`  Local:    ${color("bold", branch_name)} @ ${headHash.slice(0, 12)}`);
  console.log(`  Upstream: ${repoUrl} (${branch})`);

  // Fetch
  console.log(`\n  Fetching...`);
  const remote = fetchUpstream(repoUrl, name);
  if (!remote) return;

  // Read marker
  const marker = readMarker(markerFile);
  console.log(`  Marker:   ${marker ? marker.slice(0, 12) : "(none — first run)"}`);

  // Get new commits
  const commits = getNewCommits(remote, branch, marker);
  if (!commits) return;

  if (commits.log.length === 0) {
    console.log(`\n  ${color("green", "✓ Up to date — no new commits since marker.")}`);
    return;
  }

  console.log(`\n  ${color("yellow", `${commits.log.length} new commit(s) since last check:`)}`);

  let totalSafe = 0;
  let totalModified = 0;
  let totalRewritten = 0;
  let totalRemoved = 0;
  let totalNew = 0;
  let totalOrphan = 0;

  for (const line of commits.log) {
    const [hash, ...msgParts] = line.split(" ");
    const msg = msgParts.join(" ");
    subheading(`${hash} ${msg}`);

    const files = getChangedFiles(hash);
    if (files.length === 0) {
      console.log(`  (no file changes — merge commit or metadata)`);
      continue;
    }

    for (const { status, path: filePath } of files) {
      const entry = findMapping(name, filePath);
      const op = status === "A" ? "ADDED" : status === "D" ? "DELETED" : status === "M" ? "MODIFIED" : status;

      if (!entry) {
        console.log(`    ${color("red", "ORPHAN")}  ${op}  ${filePath}`);
        console.log(`           ⚠ No mapping entry for this file. Was it added upstream?`);
        totalOrphan++;
        continue;
      }

      const tag = statusTag(entry.status);
      const ours = entry.ours || "(none)";

      if (entry.status === "UNCHANGED" || entry.status === "MOVED") {
        console.log(`    ${tag}  ${op}  ${filePath} → ${ours}`);
        totalSafe++;
      } else if (entry.status === "MODIFIED") {
        console.log(`    ${tag}  ${op}  ${filePath} → ${ours}`);
        if (entry._note) console.log(`           ${color("gray", entry._note)}`);
        // Show diff summary for MODIFIED files where upstream changed the same file
        if (status === "M" || status === "D") {
          const diff = getDiffStat(hash, filePath);
          if (diff && diff.length > 0) {
            const lineCount = diff.split("\n").length - 1;
            if (lineCount > 0 && lineCount < 80) {
              console.log(`           ${color("yellow", "Diff preview:")}`);
              console.log(`           ${diff.split("\n").slice(0, 40).join("\n           ")}`);
            } else {
              console.log(`           ${color("gray", `(${lineCount} lines changed — use 'git diff ${hash}^..${hash} -- "${filePath}"' to view)`)}`);
            }
          }
        }
        totalModified++;
      } else if (entry.status === "REWRITTEN") {
        console.log(`    ${tag}  ${op}  ${filePath} → ${ours}`);
        if (entry._note) console.log(`           ${color("gray", entry._note)}`);
        console.log(`           ${color("red", "⚠ Upstream change may not apply — file was fundamentally rewritten.")}`);
        totalRewritten++;
      } else if (entry.status === "ELIMINATED" || entry.status === "MERGED") {
        if (op === "DELETED") {
          console.log(`    ${color("green", "  SYNCED")}  ${op}  ${filePath} (upstream deleted; we already eliminated it)`);
        } else {
          console.log(`    ${tag}  ${op}  ${filePath}`);
          if (entry._note) console.log(`           ${color("gray", entry._note)}`);
          if (entry.ours) console.log(`           Lives at: ${entry.ours}`);
        }
      } else if (status === "D" && entry.ours) {
        console.log(`    ${color("red", " DELETED")}  ${op}  ${filePath}`);
        console.log(`           ⚠ Upstream deleted this file. We still have it at ${entry.ours}.`);
        console.log(`           Decide: keep our version or follow upstream?`);
        totalRemoved++;
      }
    }
  }

  // Summary
  console.log(`\n  ${color("bold", "Summary:")}`);
  if (totalSafe > 0) console.log(`    ${color("green", `${totalSafe} safe`)}  — files that can be ported directly`);
  if (totalModified > 0) console.log(`    ${color("yellow", `${totalModified} modified`)} — files we changed; review upstream diff`);
  if (totalRewritten > 0) console.log(`    ${color("red", `${totalRewritten} rewritten`)} — fundamentally different; likely skip`);
  if (totalRemoved > 0) console.log(`    ${color("red", `${totalRemoved} removed`)}  — upstream deleted; we still have them`);
  if (totalNew > 0) console.log(`    ${color("blue", `${totalNew} new`)}      — added upstream; evaluate for inclusion`);
  if (totalOrphan > 0) console.log(`    ${color("red", `${totalOrphan} orphan`)}   — no mapping entry; may need mapping update`);

  // Return summary for PR description
  return {
    upstream: name,
    remote,
    branch,
    remoteHead: commits.remoteHead,
    marker: commits.marker,
    newCommits: commits.log.length,
    safe: totalSafe,
    modified: totalModified,
    rewritten: totalRewritten,
    removed: totalRemoved,
    orphan: totalOrphan,
    commits: commits.log,
  };
}

// ── Generate PR description ─────────────────────────────────────────────────

function generatePRSummary() {
  console.log(`${color("bold", "Blackhole Lockstep — PR Summary")}`);
  console.log(`  ${color("gray", `Branch: ${getCurrentBranch()}`)}`);
  console.log(`  ${color("gray", `Date:   ${new Date().toISOString().slice(0, 10)}`)}`);
  console.log();

  const vccChanges = collectUpstreamChanges("pi-vcc", mapping.upstreams["pi-vcc"].marker);
  const omChanges = collectUpstreamChanges("pi-observational-memory", mapping.upstreams["pi-observational-memory"].marker);

  if (!vccChanges && !omChanges) {
    console.log("  No upstream changes since last marker — nothing new to report.");
    console.log();
    console.log("  (Markers are up to date or not yet initialized.)");
    // Still output a template
  }

  console.log("---");
  console.log("## Summary");
  console.log();

  if (vccChanges) {
    console.log(`### From pi-vcc (${mapping.upstreams["pi-vcc"].git})`);
    console.log(`- **Previously reviewed at**: \`${vccChanges.marker.slice(0, 12)}\``);
    console.log(`- **New commits**: ${vccChanges.commits.length}`);
    for (const c of vccChanges.commits) {
      console.log(`  - \`${c}\``);
    }
    console.log();
  }

  if (omChanges) {
    console.log(`### From pi-observational-memory (${mapping.upstreams["pi-observational-memory"].git})`);
    console.log(`- **Previously reviewed at**: \`${omChanges.marker.slice(0, 12)}\``);
    console.log(`- **New commits**: ${omChanges.commits.length}`);
    for (const c of omChanges.commits) {
      console.log(`  - \`${c}\``);
    }
    console.log();
  }

  // Read CHANGELOG for ported entries
  const changelogPath = resolve(REPO_DIR, "CHANGELOG.md");
  if (existsSync(changelogPath)) {
    const changelog = readFileSync(changelogPath, "utf-8");
    // Extract latest unreleased / lockstep section
    const unreleasedMatch = changelog.match(/## \[unreleased\][\s\S]*?(?=## \[|$)/i);
    if (unreleasedMatch) {
      console.log("### Ported changes");
      console.log();
      console.log(unreleasedMatch[0].trim());
      console.log();
    }
  }

  console.log("---");
  console.log();
  console.log("## Checklist");
  console.log();
  console.log("- [ ] Each ported change verified with `npx tsc --noEmit`");
  console.log("- [ ] CHANGELOG.md updated with ported/skipped/deferred changes");
  console.log("- [ ] Markers advanced to current upstream HEAD");
  console.log("- [ ] Deferred decisions logged in DEFERRED.md");
  console.log();
  console.log("## Notes for reviewer");
  console.log();
  console.log("<!-- Add any notes about tricky merges, skipped changes, or decisions here -->");
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // ── PR summary mode ─────────────────────────────────────────────────
  if (PR_SUMMARY) {
    generatePRSummary();
    process.exit(0);
  }

  // ── Branch setup ─────────────────────────────────────────────────────
  if (CREATE_BRANCH) {
    console.log(`${color("bold", "Blackhole Lockstep — Branch Setup")}`);
    const ok = setupLockstepBranch();
    if (!ok) {
      console.error("  ❌ Branch setup failed.");
      process.exit(1);
    }
    console.log(`\n  ${color("green", "✓ Ready on lockstep branch. Running audit...")}`);
  }

  // ── Audit ────────────────────────────────────────────────────────────
  console.log(`${color("bold", "Blackhole Lockstep Audit")}`);
  console.log(`  ${color("gray", `Repo:   ${REPO_DIR}`)}`);
  console.log(`  ${color("gray", `Date:   ${new Date().toISOString().slice(0, 10)}`)}`);
  console.log(`  ${color("gray", `Mode:   read-only (no source changes)`)}`);

  // Read CHANGELOG
  const changelogPath = resolve(REPO_DIR, "CHANGELOG.md");
  if (existsSync(changelogPath)) {
    const changelog = readFileSync(changelogPath, "utf-8");
    // Show only the latest version section
    const latestSection = changelog.split("\n## [")[1];
    if (latestSection) {
      const header = latestSection.split("\n")[0];
      console.log(`\n  Latest release: [${header}`);
    }
  }

  const auditResults = [];

  if (CHECK_VCC) {
    const vcc = mapping.upstreams["pi-vcc"];
    const result = auditUpstream("pi-vcc", vcc.git, vcc.branch, vcc.marker);
    if (result) auditResults.push(result);
  }

  if (CHECK_OM) {
    const om = mapping.upstreams["pi-observational-memory"];
    const result = auditUpstream("pi-observational-memory", om.git, om.branch, om.marker);
    if (result) auditResults.push(result);
  }

  console.log(`${color("bold", "Lockstep audit complete.")}`);

  // ── Next steps ───────────────────────────────────────────────────────
  if (CREATE_BRANCH) {
    const branch = getCurrentBranch();
    console.log(`\n  ${color("bold", "Next steps:")}`);
    console.log(`  1. ${color("cyan", "Review")} each upstream commit flagged above`);
    console.log(`  2. ${color("cyan", "Port")} safe changes with human approval`);
    console.log(`  3. ${color("cyan", "Commit")} ported changes on ${color("bold", branch)}`);
    console.log(`  4. ${color("cyan", "Run")}  node .pi/skills/lockstep/scripts/lockstep.js --update-markers`);
    console.log(`  5. ${color("cyan", "Update")} CHANGELOG.md with ported/skipped/deferred changes`);
    console.log(`  6. ${color("cyan", "Push")}  git push origin ${branch}`);
    console.log(`  7. ${color("cyan", "Open")} a PR against main — use --pr-summary for the description`);
    console.log();
    console.log(`  ${color("gray", "After merging, switch back to your feature branch:")}`);
    console.log(`  ${color("gray", "  git checkout <your-branch>")}`);
    if (hasDirtyChanges()) {
      console.log(`  ${color("gray", "  git stash pop")}`);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
