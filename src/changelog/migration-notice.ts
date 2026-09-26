/**
 * One-time config-migration notice (release gate).
 *
 * The config-surface reorg (`work_docs/plan-09`, `plan-10`, `plan-11`) rewrites
 * users' on-disk config files at startup. This module tells each user exactly
 * once that the surface changed, and separately whether their config was
 * migrated — so a read-only install (or a clean file) is still informed.
 *
 * Gated by the RUNNING PACKAGE VERSION (via `getPackageVersion()`, same
 * precedence as the changelog viewer — works for npm installs, git installs,
 * and jiti/direct-ts alike) equal to `MIGRATION_NOTICE_VERSION`. Bumping the
 * package version past it self-noops this module; no flag file is ever written,
 * so read-only filesystems are unaffected.
 *
 * Release step: set `MIGRATION_NOTICE_VERSION` to the version that ships the
 * config migration (and the CHANGELOG section for it). Until then this module
 * is inert.
 */

import { getPackageVersion } from "./changelog.js";

/** The package version whose release carries the config migration. */
export const MIGRATION_NOTICE_VERSION = "0.6.0";

/** What the on-disk migration actually did this session. */
export type MigrationOutcome = "migrated" | "none" | "blocked";

const UPGRADE_MESSAGE =
  "pi-blackhole: your configuration was upgraded to the new surface — the compaction engine is now " +
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
}

let notifiedThisProcess = false;

/**
 * Show the config-migration notice at most once per pi process when the running
 * package version is exactly `MIGRATION_NOTICE_VERSION`. Emits two
 * notifications: the upgrade notice, then the outcome. Returns true when a
 * notification was attempted. The guard is set even if the sink throws — a
 * stale extension context must never cause a retry nag.
 */
export function maybeNotifyConfigMigration(
  ctx: MigrationNoticeCtx | undefined,
  outcome: MigrationOutcome,
  deps: MigrationNoticeDeps = {},
): boolean {
  if (notifiedThisProcess) return false;
  const version = deps.version ?? getPackageVersion();
  if (version !== MIGRATION_NOTICE_VERSION) return false;
  if (!ctx?.hasUI) return false;

  const notify = deps.notify ?? ctx.ui?.notify?.bind(ctx.ui);
  if (typeof notify !== "function") return false;

  notifiedThisProcess = true;
  try {
    notify(UPGRADE_MESSAGE, "info");
    notify(OUTCOME_MESSAGE[outcome], "info");
  } catch {
    // Stale extension context — harmless; the guard stays set.
  }
  return true;
}

/** Test isolation: clear the once-per-process guard. */
export function resetMigrationNoticeForTests(): void {
  notifiedThisProcess = false;
}
