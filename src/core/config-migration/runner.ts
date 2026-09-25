/**
 * Two-phase, verified config-file migration runner (plan-10 §3–§4).
 *
 * Per file:
 *  1. read + parse; invalid JSON → warn + skip (never rewrite corrupt files)
 *  2. project the migration in memory; an unrecognized consumed value aborts
 *  3. no owned legacy key present → no-op ("no silent rewrites")
 *  4. PHASE 1: back up once, atomically write the new keys (+ version stamp),
 *     keeping the old keys, then re-read to verify the projection landed
 *  5. PHASE 2: only after verification (or in the remove-only case), atomically
 *     write again with the consumed keys deleted
 *
 * A crash between phases is self-healing: the next load sees both the new and
 * old keys and takes the remove-only path. Read-only filesystems are a
 * first-class case: the write throws, the runner warns, keeps the old keys, and
 * returns the in-memory projection so the current load still behaves migrated.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { configPath } from "../unified-config.js";
import { CONFIG_VERSION, projectConfig } from "./steps.js";

const CONFIG_FILE = "pi-blackhole-config.json";

export interface MigrateFileDeps {
  /** Override the atomic writer (tests). */
  write?: (path: string, text: string) => Promise<void>;
  /** Override the disk reader used for the initial read + verification (tests). */
  readText?: (path: string) => Promise<string>;
  /** Override the one-time backup (tests). */
  backup?: (path: string) => Promise<void>;
  /** Override the warning sink (tests). */
  warn?: (message: string, error?: unknown) => void;
}

export interface MigrateFileResult {
  path: string;
  /** True when owned legacy keys were present (a rewrite was warranted). */
  changed: boolean;
  /** True when the rewrite reached disk. */
  persisted: boolean;
  /** Ids of migration steps that changed a value. */
  applied: string[];
  messages: string[];
  /** In-memory projected config (old keys retained when not persisted). */
  config?: Record<string, unknown>;
  error?: string;
}

// ── Write helpers ────────────────────────────────────────────────────────────

/**
 * Write `text` to `path` atomically: temp file in the same directory, best-effort
 * fsync, rename over the target. On failure the original file stays intact and
 * the temp is removed.
 */
export async function atomicWrite(path: string, text: string): Promise<void> {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(tmp, text, "utf-8");
  try {
    const fh = await open(tmp, "r");
    await fh.sync();
    await fh.close();
  } catch {
    /* fsync is best-effort */
  }
  try {
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

/** One-time `.bak` before the first write; skipped silently when unwritable. */
async function defaultBackup(path: string): Promise<void> {
  const bak = `${path}.bak`;
  try {
    await stat(bak);
    return; // already backed up
  } catch {
    /* no backup yet */
  }
  try {
    await copyFile(path, bak);
  } catch {
    /* best-effort: a read-only dir must not block the migration attempt */
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

// ── Per-file runner ──────────────────────────────────────────────────────────

/**
 * Migrate a single config file. Never throws; read-only filesystems and corrupt
 * JSON are reported via the result (and `warn`), not exceptions.
 */
export async function migrateConfigFile(
  path: string,
  deps: MigrateFileDeps = {},
): Promise<MigrateFileResult> {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const readText = deps.readText ?? ((p: string) => readFile(p, "utf-8"));
  const write = deps.write ?? atomicWrite;
  const backup = deps.backup ?? defaultBackup;
  const base: MigrateFileResult = {
    path,
    changed: false,
    persisted: false,
    applied: [],
    messages: [],
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
  if (proj.error) {
    warn(`blackhole: config migration aborted for ${path} — ${proj.error}`);
    return { ...base, error: proj.error };
  }
  // No value change and nothing to delete → no rewrite ("no silent rewrites").
  if (!proj.valueChanged && proj.consumedToDelete.length === 0) return base;

  const stamp = raw.configVersion ?? CONFIG_VERSION;
  const phase2: Record<string, unknown> = structuredClone(proj.config);
  for (const k of proj.consumedToDelete) delete phase2[k];
  phase2.configVersion = stamp;

  // Remove-only: the new keys are already present, so only delete the old ones.
  if (!proj.valueChanged) {
    try {
      await write(path, serialize(phase2));
      return {
        path,
        changed: true,
        persisted: true,
        applied: proj.applied,
        messages: proj.messages,
        config: phase2,
      };
    } catch (error) {
      warn(`blackhole: could not migrate ${path} (read-only?) — ${String(error)}`);
      return {
        path,
        changed: true,
        persisted: false,
        applied: proj.applied,
        messages: proj.messages,
        config: proj.config,
        error: String(error),
      };
    }
  }

  // PHASE 1 — write the new keys, keep the old ones.
  const phase1: Record<string, unknown> = { ...proj.config, configVersion: stamp };
  try {
    await backup(path);
    await write(path, serialize(phase1));
  } catch (error) {
    const suffix = isReadOnlyError(error) ? "read-only filesystem" : String(error);
    warn(`blackhole: could not write migrated config to ${path} (${suffix})`);
    return {
      path,
      changed: true,
      persisted: false,
      applied: proj.applied,
      messages: proj.messages,
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
      path,
      changed: true,
      persisted: true,
      applied: proj.applied,
      messages: proj.messages,
      config: proj.config,
      error: "verification failed",
    };
  }

  // PHASE 2 — now it is safe to delete the consumed keys. When there is
  // nothing to delete, phase 1 is already final.
  if (proj.consumedToDelete.length === 0) {
    return {
      path,
      changed: true,
      persisted: true,
      applied: proj.applied,
      messages: proj.messages,
      config: phase1,
    };
  }
  try {
    await write(path, serialize(phase2));
  } catch (error) {
    const suffix = isReadOnlyError(error) ? "read-only filesystem" : String(error);
    warn(`blackhole: could not remove legacy keys from ${path} (${suffix})`);
    return {
      path,
      changed: true,
      persisted: false,
      applied: proj.applied,
      messages: proj.messages,
      config: proj.config,
      error: String(error),
    };
  }

  return {
    path,
    changed: true,
    persisted: true,
    applied: proj.applied,
    messages: proj.messages,
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
