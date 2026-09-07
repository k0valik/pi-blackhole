/**
 * One-time migration notice for the 0.5.2 release cycle.
 *
 * Users whose config pins a flat `compactAfterTokens` threshold never see the
 * context-window preset curve that became the no-knob default in 0.5.2 — their
 * explicit pin keeps overriding it. This module nudges those users exactly
 * once per pi process, via `ctx.ui.notify` on `session_start`.
 *
 * Ship scope: gated by the RUNNING PACKAGE VERSION (via `getPackageVersion()`,
 * same precedence as the changelog viewer — works for npm installs, git
 * installs, and jiti/direct-ts alike) equal to MIGRATION_NOTICE_VERSION.
 * Bumping the package version beyond 0.5.2 self-noops this module; no flag
 * file is ever written, so read-only filesystems are unaffected.
 *
 * TODO(0.5.3): remove this module, its session_start hook in index.ts, its
 * tests (tests/migration-notice.test.ts), and the changelog line. Forgetting
 * is harmless — from 0.5.3 on the version gate is always false.
 */

import { getPackageVersion } from "./changelog.js";

/** The only version this notice fires on. */
export const MIGRATION_NOTICE_VERSION = "0.5.2";

const MESSAGE =
  "pi-blackhole: auto-compaction can now derive its threshold from your model's context window. " +
  "Your compactAfterTokens pin overrides it — clear it in /blackhole settings → Compaction, " +
  "or set compactAfterRatio. Details: /blackhole changelog.";

// ── Types ────────────────────────────────────────────────────────────────

/** The subset of UnifiedConfig the candidate check needs. */
export interface MigrationNoticeConfig {
  compaction?: "auto" | "manual" | "off";
  compactionEngine?: "blackhole" | "pi-default";
  compactAfterTokens?: number;
  compactAfterRatio?: number;
  compactReserveTokens?: number;
  compactAfterPreset?: string;
  compactAfterPresets?: Record<string, unknown>;
}

/** Subset of the extension session_start context the notice needs. */
export interface MigrationNoticeCtx {
  hasUI?: boolean;
  ui?: { notify?: (message: string, level?: string) => void };
}

export interface MigrationNoticeDeps {
  /** Override the running package version (tests). Default: getPackageVersion(). */
  version?: string;
  /** Override the notify sink (tests). Default: ctx.ui.notify. */
  notify?: (message: string, level: "info") => void;
}

// ── Candidate check ──────────────────────────────────────────────────────

/**
 * True when the user is pinned to the legacy flat threshold with no
 * window-derived knob engaged. The loader (loadUnifiedConfig) already strips
 * a literal 81000 as scaffold residue and never strips env values, so a
 * post-load `compactAfterTokens` is always a deliberate pin.
 */
export function isThresholdMigrationCandidate(config: MigrationNoticeConfig): boolean {
  if (config.compaction !== "auto") return false;
  if (config.compactionEngine !== "blackhole") return false;
  if (typeof config.compactAfterTokens !== "number") return false;
  // Any derived knob engaged → the user already adopted the new model.
  if (config.compactAfterRatio !== undefined) return false;
  if (config.compactReserveTokens !== undefined) return false;
  if (config.compactAfterPreset !== undefined && config.compactAfterPreset !== "default") {
    return false;
  }
  if (
    config.compactAfterPresets !== undefined &&
    Object.keys(config.compactAfterPresets).length > 0
  ) {
    return false;
  }
  return true;
}

// ── Notice ───────────────────────────────────────────────────────────────

let notifiedThisProcess = false;

/**
 * Show the migration notice at most once per pi process when the running
 * package version is exactly MIGRATION_NOTICE_VERSION. Returns true when a
 * notification was attempted. The guard is set even if the sink throws —
 * a stale extension context must never cause a retry nag.
 */
export function maybeNotifyThresholdMigration(
  ctx: MigrationNoticeCtx | undefined,
  config: MigrationNoticeConfig,
  deps: MigrationNoticeDeps = {},
): boolean {
  if (notifiedThisProcess) return false;
  const version = deps.version ?? getPackageVersion();
  if (version !== MIGRATION_NOTICE_VERSION) return false;
  if (!isThresholdMigrationCandidate(config)) return false;
  if (!ctx?.hasUI) return false;

  const notify = deps.notify ?? ctx.ui?.notify?.bind(ctx.ui);
  if (typeof notify !== "function") return false;

  notifiedThisProcess = true;
  try {
    notify(MESSAGE, "info");
  } catch {
    // Stale extension context — harmless; the guard stays set.
  }
  return true;
}

/** Test isolation: clear the once-per-process guard. */
export function resetMigrationNoticeForTests(): void {
  notifiedThisProcess = false;
}
