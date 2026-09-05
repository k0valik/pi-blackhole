/**
 * config.ts — Unified configuration API for pi extensions.
 *
 * Named-file config (one file per package):
 *   ~/.pi/agent/extensions/<package>-config.json   (global)
 *   <cwd>/.pi/<package>-config.json                 (project-local)
 *
 * Resolution order: defaults ← global file ← project-local file.
 *
 * Test safety: writeConfig / deleteConfig refuse to operate when vitest
 * is detected AND no explicit `configDir` is provided. Pass `configDir`
 * in tests (e.g. a temp dir) to disable the gate.
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { getExtensionsDir } from "./paths.js";

export { getExtensionsDir } from "./paths.js";

interface CacheHit {
  mtime: number;
  size: number;
  data: unknown;
}

const _configCache = new Map<string, CacheHit>();
const CACHE_LIMIT = 128;

function cacheSet(key: string, value: CacheHit): void {
  _configCache.delete(key);
  _configCache.set(key, value);
  if (_configCache.size > CACHE_LIMIT) {
    const firstKey = _configCache.keys().next().value;
    if (firstKey !== undefined) {
      _configCache.delete(firstKey);
    }
  }
}

// ── Path helpers ──────────────────────────────────────────────────────

const PROTECTED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function resolveConfigDir(configDir: string | undefined): string {
  return configDir ?? getExtensionsDir();
}

/** Check if a directory path points to a real user home (not a test temp). */
function isRealDir(dir: string): boolean {
  if (dir.startsWith("/tmp") || dir.startsWith("/var/folders")) return false;
  // Cross-platform: os.tmpdir() is /tmp on Linux, /var/folders/... on macOS,
  // and C:\Users\<user>\AppData\Local\Temp on Windows — the prefix check
  // covers all of them, including paths that don't start with "/tmp".
  const systemTmp = tmpdir();
  return dir !== systemTmp && !dir.startsWith(systemTmp + sep);
}

/**
 * Guard writes/deletes against the real user config directory in tests.
 * Returns true if the operation should proceed.
 */
function guardRealDir(
  filename: string,
  configDir: string | undefined,
  operation: "write" | "delete",
): boolean {
  // Explicit configDir — caller's responsibility
  if (configDir !== undefined) return true;
  // Not in vitest — real pi process, allowed
  if (process.env.VITEST !== "true") return true;

  const dir = resolveConfigDir(configDir);
  if (isRealDir(dir)) {
    console.warn(
      `[pi-base] Blocked ${operation} of "${filename}" — running in vitest ` +
        `without explicit configDir, and the target directory (${dir}) ` +
        `looks like a real user home. ` +
        `Pass an explicit configDir parameter to enable ${operation}s in tests.`,
    );
    return false;
  }
  return true;
}

// ── Read ──────────────────────────────────────────────────────────────

/**
 * Read a named config file. Returns parsed object or null.
 * Optimized with in-memory caching and mtime validation to bypass redundant filesystem checks.
 *
 * @param filename  e.g. "pi-window-title-config.json"
 * @param configDir Directory to read from. Defaults to getExtensionsDir().
 */
export function readConfig<T>(filename: string, configDir?: string): T | null {
  const path = join(resolveConfigDir(configDir), filename);
  try {
    // Utilize { throwIfNoEntry: false } to avoid expensive exceptions when configuration files are missing
    const stats = statSync(path, { throwIfNoEntry: false });
    if (!stats) {
      _configCache.delete(path);
      return null;
    }

    const hit = _configCache.get(path);
    if (hit && hit.mtime === stats.mtimeMs && hit.size === stats.size) {
      // Refresh LRU order on hit
      _configCache.delete(path);
      _configCache.set(path, hit);
      return structuredClone(hit.data) as T;
    }

    const raw = readFileSync(path, "utf-8");
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      cacheSet(path, { data: null, mtime: stats.mtimeMs, size: stats.size });
      return null;
    }
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      cacheSet(path, { data: null, mtime: stats.mtimeMs, size: stats.size });
      return null;
    }

    // Cache the parsed JSON data, validating both mtime and size
    cacheSet(path, {
      data: structuredClone(parsed),
      mtime: stats.mtimeMs,
      size: stats.size,
    });
    return parsed as T;
  } catch {
    _configCache.delete(path);
    return null;
  }
}

// ── Write ─────────────────────────────────────────────────────────────

/**
 * Write a named config file. Returns true on success.
 *
 * Safety gate: in vitest, if no explicit `configDir` is provided,
 * warns and returns false to prevent accidental writes to the real
 * ~/.pi/agent/extensions/ directory.
 *
 * @param filename  e.g. "pi-window-title-config.json"
 * @param data      Object to serialize as JSON
 * @param configDir Directory to write to. Defaults to getExtensionsDir().
 */
export function writeConfig<T>(filename: string, data: T, configDir?: string): boolean {
  if (!guardRealDir(filename, configDir, "write")) return false;
  const path = join(resolveConfigDir(configDir), filename);
  _configCache.delete(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
    return true;
  } catch (error) {
    console.warn(
      `[pi-base] Failed to write "${path}": ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

// ── Delete ────────────────────────────────────────────────────────────

/**
 * Delete a named config file. No-op if the file doesn't exist.
 */
export function deleteConfig(filename: string, configDir?: string): void {
  if (!guardRealDir(filename, configDir, "delete")) return;
  const path = join(resolveConfigDir(configDir), filename);
  _configCache.delete(path);
  try {
    rmSync(path, { force: true });
  } catch {
    // No-op if file doesn't exist or can't be deleted
  }
}

/** Clear the config file cache. Exposed for testing. */
export function clearConfigFileCache(): void {
  _configCache.clear();
}

// ── deepMerge ─────────────────────────────────────────────────────────

/**
 * Recursively merge `overrides` into `base`.
 *
 * - Plain objects are recursively merged (not replaced).
 * - `null` in overrides replaces the base value (explicit reset).
 * - `undefined` in overrides leaves the base value unchanged.
 * - Arrays, primitives, and non-plain objects are replaced wholesale.
 * - Does not mutate the base object (returns a new object).
 */
export function deepMerge<T extends Record<string, unknown>>(base: T, overrides: Partial<T>): T {
  if (!overrides || typeof overrides !== "object") {
    return { ...base };
  }
  const result = { ...base };

  for (const key of Object.keys(overrides)) {
    if (PROTECTED_KEYS.has(key)) continue;

    const overrideVal = (overrides as Record<string, unknown>)[key];

    if (overrideVal === undefined) {
      continue;
    }

    if (overrideVal === null) {
      (result as Record<string, unknown>)[key] = null;
      continue;
    }

    const baseVal = (result as Record<string, unknown>)[key];

    if (isPlainObject(baseVal) && isPlainObject(overrideVal)) {
      (result as Record<string, unknown>)[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      );
    } else {
      (result as Record<string, unknown>)[key] = overrideVal;
    }
  }

  return result as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { getAncestorChain } from "./session.js";

/** Separator between key parts. NUL cannot appear in paths or session IDs. */
const SESSION_KEY_SEP = "\x00";

/** LeafId sentinel for pending-mode session config.
 *  Used as the leafId key in the in-memory store while the session JSONL
 *  has not yet materialized. Once the file exists and getLeafId() returns
 *  a real id, _tryFlushSession() migrates the config to the real leaf and
 *  clears this sentinel key.
 */
export const PENDING_SENTINEL = "__pending__";

const _sessionConfigs = new Map<string, Record<string, unknown>>();

/** Max entries in the session config cache. Evicts oldest (FIFO) when exceeded.
 *  Prevents unbounded growth in long-running processes that see many sessions. */
const MAX_SESSION_CONFIGS = 500;

function sessionKey(namespace: string, cwd: string, sessionId: string, leafId: string): string {
  return `${namespace}${SESSION_KEY_SEP}${cwd}${SESSION_KEY_SEP}${sessionId}${SESSION_KEY_SEP}${leafId}`;
}

/**
 * Get session config for a specific leaf, walking up parentId chain
 * using pi's own session entry tree. First match wins — children
 * inherit parent config automatically. Returns empty object if no
 * session config exists for this leaf or any ancestor.
 */
export function getSessionConfig(
  namespace: string,
  cwd: string,
  sessionId: string,
  leafId: string,
  entries: FileEntry[],
): Record<string, unknown> {
  const chain = getAncestorChain(entries, leafId);
  for (const id of chain) {
    const key = sessionKey(namespace, cwd, sessionId, id);
    const found = _sessionConfigs.get(key);
    if (found) return found;
  }
  return {};
}

/**
 * Set session config for a specific leaf. Overwrites any existing config
 * for that leaf. Does NOT affect parent or sibling leaves.
 */
export function setSessionConfig(
  namespace: string,
  cwd: string,
  sessionId: string,
  leafId: string,
  config: Record<string, unknown>,
): void {
  const key = sessionKey(namespace, cwd, sessionId, leafId);
  _sessionConfigs.set(key, structuredClone(config));
  // FIFO eviction: prevent unbounded growth across many sessions.
  // clearAllSessionConfigs() resets the Map entirely, so tests
  // and callers that want a hard reset still get it.
  if (_sessionConfigs.size > MAX_SESSION_CONFIGS) {
    const oldestKey = _sessionConfigs.keys().next().value!;
    _sessionConfigs.delete(oldestKey);
  }
}

/** Read a session config entry directly by key, without walking the entry tree.
 *  Returns undefined if no config exists for that (cwd, sessionId, leafId) triple.
 *  Used by ConfigManager._tryFlushSession to read the pending sentinel entry
 *  without incurring the cost of getAncestorChain.
 */
export function getRawSessionConfig(
  namespace: string,
  cwd: string,
  sessionId: string,
  leafId: string,
): Record<string, unknown> | undefined {
  return _sessionConfigs.get(sessionKey(namespace, cwd, sessionId, leafId));
}

/**
 * Clear session config for a specific leaf. After this, the leaf will
 * inherit from its parent chain (or get clean defaults if no ancestor
 * has config).
 */
export function clearSessionConfig(
  namespace: string,
  cwd: string,
  sessionId: string,
  leafId: string,
): void {
  _sessionConfigs.delete(sessionKey(namespace, cwd, sessionId, leafId));
}

/** Clear ALL session config entries. Used for testing. */
export function clearAllSessionConfigs(): void {
  _sessionConfigs.clear();
}

// ── deepEqual ─────────────────────────────────────────────────────────

/**
 * Deep equality check for two values.
 * - Handles primitives, Date, RegExp, Map, Set, arrays, and plain objects.
 * - Non-plain-object instances are compared by reference (strict equality).
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;

  if (a === null || b === null || typeof a !== typeof b) return false;

  // Date
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  // RegExp
  if (a instanceof RegExp && b instanceof RegExp) {
    return a.source === b.source && a.flags === b.flags;
  }

  // Map
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !deepEqual(v, b.get(k))) return false;
    }
    return true;
  }

  // Set
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const v of a) {
      if (!b.has(v)) return false;
    }
    return true;
  }

  // Arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  // Plain objects
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }

  return false;
}

// ── checkConfigFile ───────────────────────────────────────────────────

export interface ConfigFileStatus {
  /** Whether the file exists on disk */
  exists: boolean;
  /** Whether the file contains valid config data (valid JSON + a plain object) */
  valid: boolean;
  /** Human-readable error description when valid is false */
  error?: string;
}

/**
 * Check whether a config file exists and has valid JSON content.
 * Does NOT cache — every call reads the file header / full content.
 *
 * Use this before `readConfig` to distinguish "file not found" from
 * "file exists but is malformed".
 */
export function checkConfigFile(filename: string, configDir?: string): ConfigFileStatus {
  const path = join(resolveConfigDir(configDir), filename);
  try {
    const stats = statSync(path, { throwIfNoEntry: false });
    if (!stats) {
      return { exists: false, valid: true };
    }

    const raw = readFileSync(path, "utf-8");
    const trimmed = raw.trim();

    if (trimmed.length === 0) {
      return { exists: true, valid: false, error: "Config file is empty" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      return {
        exists: true,
        valid: false,
        error: `Invalid JSON: ${(e as Error).message}`,
      };
    }

    if (!isPlainObject(parsed)) {
      return {
        exists: true,
        valid: false,
        error: "Config file must contain a plain JSON object at the top level",
      };
    }

    return { exists: true, valid: true };
  } catch {
    return { exists: true, valid: false, error: "Cannot read config file" };
  }
}

// ── loadConfig ────────────────────────────────────────────────────────

export interface LoadConfigOptions {
  /**
   * Working directory for project-local overrides.
   * When set, reads from `<cwd>/.pi/<filename>` in addition to global.
   */
  cwd?: string;

  /**
   * Merge strategy for combining defaults ← global ← project.
   * - "shallow" (default): `{ ...defaults, ...global, ...project }`
   * - "deep": recursively merges nested objects.
   */
  merge?: "shallow" | "deep";

  /**
   * Explicit config directory. Defaults to getExtensionsDir().
   * Use in tests to read/write from a temporary or fixture directory.
   */
  configDir?: string;
}

/**
 * Load configuration with defaults, global file, and optional project-local override.
 *
 * Resolution order: defaults ← global file ← project-local file.
 * Each layer shallow-merges (or deep-merges if `merge: "deep"`).
 *
 * Always returns a full config object — null is never returned.
 * Missing keys fall back to defaults.
 */
export function loadConfig<T extends object>(
  filename: string,
  defaults: T,
  opts: LoadConfigOptions = {},
): T {
  const dir = resolveConfigDir(opts.configDir);
  const mergeFn =
    opts.merge === "deep"
      ? (base: T, over: Partial<T>) =>
          deepMerge(
            base as Record<string, unknown>,
            over as Record<string, unknown>,
          ) as unknown as T
      : shallowMerge<T>;

  let config = defaults;

  // Layer 1: global
  config = mergeFn(config, readConfig<Partial<T>>(filename, dir) ?? ({} as Partial<T>));

  // Layer 2: project-local
  if (opts.cwd) {
    const projectDir = join(opts.cwd, ".pi");
    config = mergeFn(config, readConfig<Partial<T>>(filename, projectDir) ?? ({} as Partial<T>));
  }

  return config;
}

function shallowMerge<T extends object>(base: T, overrides: Partial<T>): T {
  const result = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(overrides as Record<string, unknown>)) {
    if (PROTECTED_KEYS.has(key)) continue;
    const val = (overrides as Record<string, unknown>)[key];
    if (val !== undefined) {
      result[key] = val;
    }
  }
  return result as unknown as T;
}

// ── Env helpers ───────────────────────────────────────────────────────

export function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

export function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
