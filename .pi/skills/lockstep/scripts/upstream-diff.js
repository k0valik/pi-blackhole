#!/usr/bin/env node
/**
 * upstream-diff.js — Compare our files against upstream equivalents.
 *
 * For each mapped file, fetches the upstream version at HEAD and diffs
 * against our version (stripping comment headers that we added).
 *
 * Usage:
 *   node scripts/upstream-diff.js                       # all upstreams
 *   node scripts/upstream-diff.js --vcc                 # VCC only
 *   node scripts/upstream-diff.js --om                  # OM only
 *   node scripts/upstream-diff.js --only-different      # skip identical files
 *   node scripts/upstream-diff.js --summary             # just counts
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(__dirname, "..");
const REPO_DIR = resolve(SKILL_DIR, "..", "..", "..");

const args = process.argv.slice(2);
const CHECK_VCC = args.includes("--vcc") ? true : args.includes("--om") ? false : true;
const CHECK_OM = args.includes("--om") ? true : args.includes("--vcc") ? false : true;
const ONLY_DIFFERENT = args.includes("--only-different");
const SUMMARY_ONLY = args.includes("--summary");

// ── Load mapping ────────────────────────────────────────────────────────────

const mapping = JSON.parse(readFileSync(resolve(SKILL_DIR, "lockstep-mapping.json"), "utf-8"));

// ── Helpers ─────────────────────────────────────────────────────────────────

function run(cmd) {
  try {
    return execSync(cmd, { cwd: REPO_DIR, encoding: "utf-8", timeout: 10000 }).trim();
  } catch {
    return null;
  }
}

const COLORS = {
  reset: "\x1b[0m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
  blue: "\x1b[34m", cyan: "\x1b[36m", gray: "\x1b[90m", bold: "\x1b[1m",
};
function color(code, text) { return `${COLORS[code] || ""}${text}${COLORS.reset}`; }

/**
 * Fetch upstream file content.
 * Tries configured branch first, falls back to remote HEAD.
 */
function upstreamFileContent(upstreamName, upstreamPath) {
  const info = mapping.upstreams[upstreamName];
  if (!info) return null;
  const remote = `upstream-${upstreamName}`;
  const branch = info.branch;
  let content = run(`git show refs/remotes/${remote}/${branch}:${upstreamPath}`);
  if (content === null) {
    content = run(`git show refs/remotes/${remote}/HEAD:${upstreamPath}`);
  }
  return content; // already .trim()'d by run()
}

/**
 * Normalize both our content and upstream content for comparison:
 * - Strip leading JSDoc comment blocks (our added "Upstream: ..." headers)
 * - Normalize CRLF → LF
 * - Trim leading/trailing whitespace (run() already trims, readFileSync doesn't)
 */
function normalizeContent(raw) {
  return raw
    .replace(/^\/\*\*[\s\S]*?\*\//, "")   // strip leading /** ... */
    .replace(/\r\n/g, "\n")                // normalize line endings
    .trim();
}

// ── Diff a single file ──────────────────────────────────────────────────────

function diffFile(entry) {
  const upstreamPath = entry.path;
  const ourRelPath = entry.ours || entry.path;
  const ourAbsPath = resolve(REPO_DIR, ourRelPath);

  // Fetch upstream
  const upstreamContent = upstreamFileContent(entry.upstream, upstreamPath);
  if (upstreamContent === null) {
    return { status: "FETCH_FAILED", reason: `git show failed for ${upstreamPath}` };
  }

  // Our file
  if (!existsSync(ourAbsPath)) {
    return { status: "OUR_FILE_MISSING", reason: `${ourRelPath} not found` };
  }
  const ourContent = readFileSync(ourAbsPath, "utf-8");

  // Normalize both
  const ourNorm = normalizeContent(ourContent);
  const upNorm = normalizeContent(upstreamContent);

  // Compare
  if (ourNorm === upNorm) {
    return { status: "IDENTICAL" };
  }

  // Generate unified diff for display
  const tmpDir = "/tmp/pi-blackhole-upstream-diff";
  run(`mkdir -p ${tmpDir}`);
  const safeName = ourRelPath.replace(/\//g, "_");
  const ourTmp = `${tmpDir}/our_${safeName}`;
  const upTmp = `${tmpDir}/up_${safeName}`;
  writeFileSync(ourTmp, ourContent);
  writeFileSync(upTmp, upstreamContent + "\n"); // add trailing newline for clean diff
  const diffOutput = run(`diff -u "${upTmp}" "${ourTmp}"`);

  return {
    status: "DIFFERENT",
    diff: diffOutput,
    ourLines: ourContent.split("\n").length,
    upstreamLines: upstreamContent.split("\n").length,
  };
}

// ── Report ───────────────────────────────────────────────────────────────────

function printSummary(results) {
  const counts = {};
  for (const r of results) {
    const s = r.result.status;
    counts[s] = (counts[s] || 0) + 1;
  }

  console.log(`\n${color("bold", "Summary:")}`);
  if (counts.IDENTICAL) console.log(`  ${color("green", `${counts.IDENTICAL} identical`)}`);
  if (counts.DIFFERENT) console.log(`  ${color("yellow", `${counts.DIFFERENT} different`)}`);
  if (counts.FETCH_FAILED) console.log(`  ${color("red", `${counts.FETCH_FAILED} fetch failed`)}`);
  if (counts.OUR_FILE_MISSING) console.log(`  ${color("red", `${counts.OUR_FILE_MISSING} missing`)}`);
  console.log();
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log(`${color("bold", "Upstream file comparison")}`);
  console.log(`  ${color("gray", `Mode: ${ONLY_DIFFERENT ? "only differences" : "all files"} | ${SUMMARY_ONLY ? "summary" : "full diffs"}`)}\n`);

  const results = [];
  const entries = mapping.files.filter((entry) => {
    // Filter by upstream
    if (entry.upstream === "pi-vcc" && !CHECK_VCC) return false;
    if (entry.upstream === "pi-observational-memory" && !CHECK_OM) return false;

    // Skip entries that have no upstream counterpart
    if (["ELIMINATED", "MERGED", "UNIQUE"].includes(entry.status)) return false;

    // Skip entries with no our-path that aren't DELETED
    if (!entry.ours && entry.status !== "DELETED") return false;

    return true;
  });

  for (const entry of entries) {
    const displayPath = entry.ours || entry.path;
    const isRewritten = entry.status === "REWRITTEN";

    const result = diffFile(entry);
    results.push({ entry, result });

    if (ONLY_DIFFERENT && result.status !== "DIFFERENT") continue;

    if (result.status === "IDENTICAL") {
      if (SUMMARY_ONLY) continue;
      console.log(`  ${color("green", "✓")} ${displayPath} — matches upstream HEAD`);
    } else if (result.status === "DIFFERENT") {
      if (SUMMARY_ONLY) {
        console.log(`  ${color("yellow", "Δ")} ${displayPath}`);
        continue;
      }
      const tag = isRewritten ? color("red", "REWRITTEN") : color("yellow", "MODIFIED");
      console.log(`\n  ${color("yellow", "Δ")} ${displayPath} ${tag}`);
      if (entry._note) console.log(`    ${color("gray", entry._note)}`);

      // Show diff (first 45 lines)
      if (result.diff) {
        const lines = result.diff.split("\n");
        const shown = lines.slice(0, 45).join("\n");
        console.log(`    ${color("cyan", "Diff (upstream → our):")}`);
        console.log(`    ${shown.replace(/\n/g, "\n    ")}`);
        if (lines.length > 45) {
          console.log(`    ${color("gray", `... ${lines.length - 45} more lines`)}`);
        }
      }
    } else if (result.status === "FETCH_FAILED") {
      console.log(`  ${color("red", "⚠")} ${displayPath} — upstream file not found at ${entry.path}`);
    } else if (result.status === "OUR_FILE_MISSING") {
      console.log(`  ${color("red", "⚠")} ${displayPath} — our file not found`);
    }
  }

  printSummary(results);
}

main();
