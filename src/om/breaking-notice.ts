/**
 * One-time breaking-change notice (plan-03, D10).
 *
 * The token-rework release switches trigger/budget counting from chars/4
 * estimates to real model usage with auto-derived thresholds.  The shift for
 * custom-threshold users is content- and provider-dependent (archive
 * decomposition: coverage-stage density 0.5–4×+, compaction scope overhead
 * median ~+90k), so the notice points at the status display and the
 * PI_BLACKHOLE_LEGACY_ESTIMATE escape hatch instead of a flat multiplier.
 *
 * Persistence pattern mirrors cooldown.ts: a small JSON state file under
 * `~/.pi/agent/pi-blackhole/last-seen-version.json` records the last
 * extension version the user saw; the notice fires once per upgrade that
 * crosses BREAKING_SINCE.  Persistence happens only after the notice is
 * actually shown (gated on hasUI) so a headless-first run never swallows
 * the one-time notice for that install.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Release version that ships usage-based token counting. Keep in sync with
 *  the version bump for the release carrying plan-03. */
export const BREAKING_SINCE = "0.5.0";

const CONFIG_DIR = "pi-blackhole";
const LAST_SEEN_FILE = "last-seen-version.json";

function lastSeenPath(): string {
  return join(getAgentDir(), CONFIG_DIR, LAST_SEEN_FILE);
}

function readLastSeenVersion(): string | undefined {
  const path = lastSeenPath();
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return typeof (parsed as { version?: unknown })?.version === "string"
      ? (parsed as { version: string }).version
      : undefined;
  } catch {
    return undefined;
  }
}

function writeLastSeenVersion(version: string): void {
  try {
    const path = lastSeenPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify({ version }, null, 2)}\n`);
  } catch {
    // Best-effort: losing the state means the notice may repeat once.
    // No data loss, no crash.
  }
}

/** Numeric-segment semver compare: 0 if equal, <0 if a < b, >0 if a > b. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((s) => parseInt(s, 10) || 0);
  const pb = b.split(".").map((s) => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/**
 * Show the one-time breaking-change warning on the first agent_start at or
 * after the BREAKING_SINCE version.  Registered once at startup; agent_start
 * provides a live ui context.
 */
export function registerBreakingNotice(pi: ExtensionAPI): void {
  pi.on("agent_start", (_event: unknown, ctx: any) => {
    const lastSeen = readLastSeenVersion();
    if (
      lastSeen !== undefined &&
      compareVersions(lastSeen, BREAKING_SINCE) >= 0
    ) {
      return;
    }
    // Show the notice first (hasUI-gated), then persist — a headless-first
    // run must not swallow the one-time notice for this install.
    if (!ctx?.hasUI) return;
    try {
      ctx.ui?.notify(
        "pi-blackhole: token counting now uses real model usage; thresholds auto-derive from your model's context window. Custom thresholds keep working but now count real tokens — the shift vs old chars/4 estimates is content- and provider-dependent, so re-tune from /blackhole-memory if cadence changed. Set PI_BLACKHOLE_LEGACY_ESTIMATE=1 to restore the old counting until you migrate (removed in a future release).",
        "warning",
      );
      writeLastSeenVersion(BREAKING_SINCE);
    } catch {
      // stale ctx — nothing persisted, the notice repeats on the next start
    }
  });
}
