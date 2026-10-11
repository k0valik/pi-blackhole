/**
 * One-time config-migration notice (release gate).
 *
 * The config-surface reorg (`work_docs/plan-09`, `plan-10`, `plan-11`) rewrites
 * users' on-disk config files at startup. This module tells each user exactly
 * once that the surface changed, and separately whether their config was
 * migrated — so a read-only install (or a clean file) is still informed.
 *
 * Two gates, both required:
 *  1. **Version** — the running package version (via `getPackageVersion()`,
 *     same precedence as the changelog viewer) must be at least
 *     `MIGRATION_NOTICE_VERSION`. Comparing numerically (`0.6.0` <= `0.6.1`
 *     <= `0.7.0`, with a prerelease suffix ignored) instead of by string
 *     equality means a patch bump or an `-rc` of the release that ships the
 *     migration still fires, while a release cut at a lower version does not.
 *  2. **Stamp** — a small file in the config directory records that the notice
 *     was shown, so "exactly once" means once per *install*, not once per pi
 *     process. Writing it is best-effort: on a read-only filesystem the write
 *     fails silently and the process-level guard below is the only gate, so
 *     read-only installs degrade to once-per-session instead of never.
 *
 * Release step: set `MIGRATION_NOTICE_VERSION` to the earliest version that
 * ships the config migration (and the CHANGELOG section for it). Until a build
 * at or past that version runs, this module is inert.
 */

import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configPath } from "../core/unified-config.js";
import { getPackageVersion } from "./changelog.js";

/** The earliest package version whose release carries the config migration. */
export const MIGRATION_NOTICE_VERSION = "0.6.0";

/** What the on-disk migration actually did this session. */
export type MigrationOutcome = "migrated" | "none" | "blocked";

/**
 * Neutral on purpose: it is emitted for every outcome, including a fresh
 * install where nothing was rewritten, so it must never claim the *user's*
 * configuration was upgraded. The outcome line below carries that.
 */
const UPGRADE_MESSAGE =
  "pi-blackhole: the configuration surface changed — the compaction engine is now " +
  "part of `compaction`, the auto-compaction threshold is a shape plus an optional floor/ceiling, " +
  "and redundant memory knobs were merged. Review your settings: /blackhole settings. " +
  "Upgrade guide: docs/MIGRATION-GUIDE.md. Details: /blackhole changelog.";

const OUTCOME_MESSAGE: Record<MigrationOutcome, string> = {
  migrated: "blackhole: your config file was migrated to the new surface.",
  none: "blackhole: your config needed no migration.",
  blocked:
    "blackhole: your config could not be written (read-only?) — it is running migrated in memory " +
    "this session.",
};

/** Subset of the extension session_start context the notice needs. */
export interface MigrationNoticeCtx {
  hasUI?: boolean;
  ui?: { notify?: (message: string, level?: string) => void };
}

export interface MigrationNoticeDeps {
  /** Override the running package version (tests). Default: getPackageVersion(). */
  version?: string;
  /** Override the notify sink (tests). Default: ctx.ui.notify. */
  notify?: (message: string, level: string) => void;
  /** Override the stamp file location (tests). Default: next to the config. */
  stampPath?: string;
}

let notifiedThisProcess = false;

/** Numeric `major.minor.patch` compare; a prerelease suffix is ignored. */
function versionAtLeast(version: string, atLeast: string): boolean {
  const parse = (v: string): [number, number, number] | undefined => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
  };
  const running = parse(version);
  const floor = parse(atLeast);
  if (!running || !floor) return false;
  for (let i = 0; i < 3; i++) {
    if (running[i] !== floor[i]) return running[i] > floor[i];
  }
  return true;
}

/** Where "this notice was already shown" is recorded, next to the config. */
function stampPath(override?: string): string {
  return override ?? join(dirname(configPath()), "pi-blackhole-migration-notice.json");
}

function stampExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function writeStamp(path: string): void {
  try {
    writeFileSync(path, `${JSON.stringify({ shownAt: new Date().toISOString() })}\n`, {
      flag: "w",
    });
  } catch {
    /* read-only filesystem — the once-per-process guard still applies */
  }
}

/**
 * Show the config-migration notice at most once per install when the running
 * package version is at least `MIGRATION_NOTICE_VERSION`. Emits two
 * notifications: the surface-change notice, then the outcome. Returns true when
 * a notification was attempted. The process guard is set before the first send —
 * a stale extension context must never cause a retry nag — but each send has its
 * own try/catch, so one throwing sink cannot swallow the outcome line (the only
 * notice a blocked install gets).
 */
export function maybeNotifyConfigMigration(
  ctx: MigrationNoticeCtx | undefined,
  outcome: MigrationOutcome,
  deps: MigrationNoticeDeps = {},
): boolean {
  if (notifiedThisProcess) return false;
  const version = deps.version ?? getPackageVersion();
  if (!version || !versionAtLeast(version, MIGRATION_NOTICE_VERSION)) return false;
  if (!ctx?.hasUI) return false;

  const notify = deps.notify ?? ctx.ui?.notify?.bind(ctx.ui);
  if (typeof notify !== "function") return false;

  const stamp = stampPath(deps.stampPath);
  if (stampExists(stamp)) return false;

  notifiedThisProcess = true;
  writeStamp(stamp);
  const send = (message: string): void => {
    try {
      notify(message, "info");
    } catch {
      // Stale extension context — harmless; the guard stays set.
    }
  };
  send(UPGRADE_MESSAGE);
  send(OUTCOME_MESSAGE[outcome] ?? OUTCOME_MESSAGE.none);
  return true;
}

/** Test isolation: clear the once-per-process guard. */
export function resetMigrationNoticeForTests(): void {
  notifiedThisProcess = false;
}
