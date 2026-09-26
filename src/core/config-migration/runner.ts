/**
 * Two-phase, verified config-file migration runner (plan-10 §3–§4, hardened in
 * plan-11).
 *
 * Per file:
 *  1. read + parse; invalid JSON → warn + skip (never rewrite corrupt files)
 *  2. already stamped at the current version with nothing left to clean → no-op
 *     (the version is the gate; a stamped file with leftover keys is a
 *     crash-window retry, not a no-op)
 *  3. project the migration in memory; unrecognized values are skipped + reported
 *  4. no owned legacy key present → no-op ("no silent rewrites")
 *  5. BACKUP: on first migration create `.bak` (write-once), re-read it, and
 *     verify it matches the original — bail before the first write if it cannot
 *     be produced
 *  6. PHASE 1: atomically write the new keys, keeping the old keys, then
 *     re-read to verify the projection landed
 *  7. PHASE 2: only after verification (or in the remove-only case), atomically
 *     write again with the consumed keys deleted
 *  8. stamp `configVersion` ONLY when nothing was skipped, so a partial
 *     migration retries (and re-warns) on the next load
 *
 * A crash between phases is self-healing: the next load sees both the new and
 * old keys and takes the remove-only path. Read-only filesystems are a
 * first-class case: the write throws, the runner warns, keeps the old keys, and
 * returns the in-memory projection so the current load still behaves migrated.
 */

import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { configPath } from "../unified-config.js";
import { CONFIG_VERSION, type MigrationWarning, projectConfig } from "./steps.js";

const CONFIG_FILE = "pi-blackhole-config.json";

export interface MigrateFileDeps {
  /** Override the atomic writer (tests). */
  write?: (path: string, text: string) => Promise<void>;
  /** Override the disk reader used for the initial read + verification (tests). */
  readText?: (path: string) => Promise<string>;
  /** Override the verified backup (tests). Throwing aborts the migration. */
  backup?: (path: string) => Promise<void>;
  /** Override the warning sink (tests). */
  warn?: (message: string, error?: unknown) => void;
  /** User-facing notification sink (tests / UI). */
  notify?: (message: string, level?: "info" | "warning") => void;
}

export interface MigrateFileResult {
  path: string;
  /** True when owned legacy keys were present (a rewrite was warranted). */
  changed: boolean;
  /** True when the rewrite reached disk. */
  persisted: boolean;
  /** True when the file already carried the config version (gate hit). */
  gated: boolean;
  /** Ids of migration steps that changed a value. */
  applied: string[];
  messages: string[];
  /** Unrecognized values that were skipped (their keys were left in place). */
  warnings: MigrationWarning[];
  /** In-memory projected config (old keys retained when not persisted). */
  config?: Record<string, unknown>;
  error?: string;
}

// ── Write helpers ────────────────────────────────────────────────────────────

/**
 * Write `text` to `path` atomically: temp file in the same directory, best-effort
 * fsync, rename over the target. The temp inherits the target's permission bits
 * so migration cannot widen a restricted config. On any failure the original
 * file stays intact and the temp is removed.
 */
export async function atomicWrite(path: string, text: string): Promise<void> {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  let mode: number | undefined;
  try {
    mode = (await stat(path)).mode & 0o777;
  } catch {
    /* target does not exist yet — use the process default */
  }
  try {
    await writeFile(tmp, text, "utf-8");
    if (mode !== undefined) {
      try {
        await chmod(tmp, mode);
      } catch {
        /* best-effort mode preservation */
      }
    }
    try {
      const fh = await open(tmp, "r");
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
    } catch {
      /* fsync is best-effort */
    }
    await rename(tmp, path);
  } catch (error) {
    try {
      await unlink(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw error;
  }
}

/**
 * One-time `.bak` before the first write. Write-once: an existing *restorable*
 * backup is the pristine pre-migration snapshot and is never clobbered by a
 * half-migrated file on a later retry. A backup that is not restorable (a
 * partial copy left by an earlier crash) does not count — the gate must not be
 * silently disabled by a corrupt residue. When it has to be created, it is
 * verified byte-identical to the original, and a failure abandons the migration
 * before any write.
 */
async function defaultBackup(path: string): Promise<void> {
  const bak = `${path}.bak`;
  try {
    const existing = await readFile(bak, "utf-8");
    if (isRestorable(existing)) return; // write-once — keep the original snapshot
  } catch {
    /* no backup yet */
  }
  const original = await readFile(path, "utf-8");
  await copyFile(path, bak);
  const written = await readFile(bak, "utf-8");
  if (written !== original) {
    throw new Error("backup verification failed");
  }
}

/**
 * A backup we can restore from: parseable JSON object. A pristine config always
 * is one, so anything else is a corrupt/partial residue and may be replaced.
 */
function isRestorable(text: string): boolean {
  if (text.length === 0) return false;
  try {
    return isRecord(JSON.parse(text));
  } catch {
    return false;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function isReadOnlyError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EROFS" || code === "EACCES" || code === "EPERM";
}

function serialize(config: Record<string, unknown>): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** One aggregated message per file, so a file with N bad keys is one toast. */
function warningMessage(path: string, warnings: MigrationWarning[]): string {
  const keys = warnings.map((w) => `${w.key}=${JSON.stringify(w.value)}`).join(", ");
  return (
    `blackhole: unrecognized config value${warnings.length === 1 ? "" : "s"} in ${path}: ` +
    `${keys} — left untouched. Fix in /blackhole settings.`
  );
}

// ── Per-file runner ──────────────────────────────────────────────────────────

/**
 * Migrate a single config file. Never throws; read-only filesystems, corrupt
 * JSON, unrecognized values, and backup failures are reported via the result
 * (and `warn` / `notify`), not exceptions.
 */
export async function migrateConfigFile(
  path: string,
  deps: MigrateFileDeps = {},
): Promise<MigrateFileResult> {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const readText = deps.readText ?? ((p: string) => readFile(p, "utf-8"));
  const write = deps.write ?? atomicWrite;
  const backup = deps.backup ?? defaultBackup;
  const notify = deps.notify;
  const base: MigrateFileResult = {
    path,
    changed: false,
    persisted: false,
    gated: false,
    applied: [],
    messages: [],
    warnings: [],
  };

  if (!existsSync(path)) return base;

  let rawText: string;
  try {
    rawText = await readText(path);
  } catch {
    return base;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    warn(`blackhole: config migration skipped — ${path} is not valid JSON`);
    return { ...base, error: "invalid JSON" };
  }
  if (!isRecord(raw)) {
    warn(`blackhole: config migration skipped — ${path} is not a JSON object`);
    return { ...base, error: "not an object" };
  }

  const proj = projectConfig(raw);

  // Version gate: a file stamped at the current (or a newer) version with no
  // owned legacy keys left is done. A stamped file that still has consumed keys
  // is a crash-window leftover (phase 1 landed, phase 2 did not) and must take
  // the remove-only path, so it is NOT gated. Comparing the version (not mere
  // presence) lets a future CONFIG_VERSION re-run against older stamps.
  const stamped = typeof raw.configVersion === "number" && raw.configVersion >= CONFIG_VERSION;
  if (stamped && proj.consumedToDelete.length === 0) {
    return { ...base, gated: true };
  }

  if (proj.warnings.length > 0) {
    const msg = warningMessage(path, proj.warnings);
    warn(msg);
    notify?.(msg, "warning");
  }

  // No owned legacy key, and no value change / cleanup → no rewrite.
  if (!proj.consumedPresent) return { ...base, warnings: proj.warnings };
  if (!proj.valueChanged && proj.consumedToDelete.length === 0) {
    return { ...base, warnings: proj.warnings };
  }

  // Stamp only a clean migration; a partial one retries on the next load. An
  // existing (possibly newer) stamp is never downgraded.
  const existingStamp = typeof raw.configVersion === "number" ? raw.configVersion : undefined;
  const stamp =
    proj.warnings.length === 0
      ? existingStamp !== undefined
        ? Math.max(existingStamp, CONFIG_VERSION)
        : CONFIG_VERSION
      : undefined;
  const phase2: Record<string, unknown> = structuredClone(proj.config);
  for (const k of proj.consumedToDelete) delete phase2[k];
  if (stamp !== undefined) phase2.configVersion = stamp;

  // BACKUP GATE — verified on both the value-changing and remove-only paths.
  try {
    await backup(path);
  } catch (error) {
    warn(
      `blackhole: could not create a verified backup of ${path} — leaving it unchanged (${String(error)})`,
    );
    notify?.("blackhole: could not back up your config, so it was left unchanged.", "warning");
    return {
      ...base,
      changed: true,
      applied: proj.applied,
      messages: proj.messages,
      warnings: proj.warnings,
      config: proj.config,
      error: "backup failed",
    };
  }

  // Remove-only: the new keys are already present, so only delete the old ones.
  if (!proj.valueChanged) {
    try {
      await write(path, serialize(phase2));
      return {
        ...base,
        changed: true,
        persisted: true,
        applied: proj.applied,
        messages: proj.messages,
        warnings: proj.warnings,
        config: phase2,
      };
    } catch (error) {
      const suffix = isReadOnlyError(error) ? "read-only filesystem" : String(error);
      warn(`blackhole: could not migrate ${path} (${suffix})`);
      notify?.(
        `blackhole: could not write your config (${suffix}); migrated in memory only.`,
        "warning",
      );
      return {
        ...base,
        changed: true,
        applied: proj.applied,
        messages: proj.messages,
        warnings: proj.warnings,
        config: proj.config,
        error: String(error),
      };
    }
  }

  // PHASE 1 — write the new keys, keep the old ones.
  const phase1: Record<string, unknown> = { ...proj.config };
  if (stamp !== undefined) phase1.configVersion = stamp;
  try {
    await write(path, serialize(phase1));
  } catch (error) {
    const suffix = isReadOnlyError(error) ? "read-only filesystem" : String(error);
    warn(`blackhole: could not write migrated config to ${path} (${suffix})`);
    notify?.(
      `blackhole: could not write your config (${suffix}); migrated in memory only.`,
      "warning",
    );
    return {
      ...base,
      changed: true,
      applied: proj.applied,
      messages: proj.messages,
      warnings: proj.warnings,
      config: proj.config,
      error: String(error),
    };
  }

  // VERIFY — every changed key must be readable back before we delete anything.
  const changedKeys = Object.keys(phase1).filter((k) => !deepEqual(phase1[k], raw[k]));
  let verified = false;
  try {
    const reRead = JSON.parse(await readText(path));
    verified = isRecord(reRead) && changedKeys.every((k) => deepEqual(reRead[k], phase1[k]));
  } catch {
    verified = false;
  }
  if (!verified) {
    warn(
      `blackhole: config migration verification failed for ${path}; keeping the old keys (will retry next load)`,
    );
    return {
      ...base,
      changed: true,
      persisted: true,
      applied: proj.applied,
      messages: proj.messages,
      warnings: proj.warnings,
      config: proj.config,
      error: "verification failed",
    };
  }

  // PHASE 2 — now it is safe to delete the consumed keys. When there is
  // nothing to delete, phase 1 is already final.
  if (proj.consumedToDelete.length === 0) {
    return {
      ...base,
      changed: true,
      persisted: true,
      applied: proj.applied,
      messages: proj.messages,
      warnings: proj.warnings,
      config: phase1,
    };
  }
  try {
    await write(path, serialize(phase2));
  } catch (error) {
    const suffix = isReadOnlyError(error) ? "read-only filesystem" : String(error);
    warn(`blackhole: could not remove legacy keys from ${path} (${suffix})`);
    notify?.(`blackhole: could not finish writing your config (${suffix}).`, "warning");
    return {
      ...base,
      changed: true,
      persisted: false,
      applied: proj.applied,
      messages: proj.messages,
      warnings: proj.warnings,
      config: proj.config,
      error: String(error),
    };
  }

  return {
    ...base,
    changed: true,
    persisted: true,
    applied: proj.applied,
    messages: proj.messages,
    warnings: proj.warnings,
    config: phase2,
  };
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Migrate the global and project-local config files independently (plan-10 §6).
 * A tracked project config is the user's problem (plan-10 §8.5).
 */
export async function migrateConfigFiles(
  cwd: string,
  deps: MigrateFileDeps = {},
): Promise<MigrateFileResult[]> {
  const paths = [...new Set([configPath(), join(cwd, ".pi", CONFIG_FILE)])];
  const results: MigrateFileResult[] = [];
  for (const p of paths) {
    results.push(await migrateConfigFile(p, deps));
  }
  return results;
}
