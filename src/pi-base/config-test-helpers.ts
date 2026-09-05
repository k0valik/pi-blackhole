/**
 * Test-only helpers for ConfigManager-based config tests.
 *
 * These utilities help tests avoid accidentally reading from or writing to
 * the real ~/.pi/agent/extensions/ directory.
 */

// Narrowly-typed vitest global. This module is bundled into pi-base's dist
// (exported via the barrel), so `vitest` cannot be imported here — bundling
// it would break runtime loading outside tests. Declared instead; every use
// is guarded by `typeof vi !== "undefined"` for non-vitest environments.
declare const vi: { resetModules: () => void };

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigManager, type ConfigManagerOptions } from "./config-manager.js";
import { clearConfigFileCache, clearAllSessionConfigs, getExtensionsDir } from "./config.js";
import { resetPiAgentDirCache } from "./paths.js";

/**
 * Create a temporary config directory with a fixture config file.
 *
 * This is the recommended way to set up isolated config state for tests.
 * It creates a temp directory, writes the config file with optional overrides,
 * and returns the directory path to pass as `configDir` to `ConfigManager.load()`.
 *
 * @param filename Config filename, e.g. "my-ext-config.json"
 * @param overrides Optional values to write into the config file
 * @returns Absolute path to the temp config directory
 */
export function createTestConfigDir(
  filename: string,
  overrides: Record<string, unknown> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-config-test-"));
  const dst = join(dir, filename);
  writeFileSync(dst, JSON.stringify(overrides, null, 2) + "\n");
  return dir;
}

/**
 * Create a ConfigManager pre-wired with a temp configDir.
 *
 * This factory creates a temp directory with a fixture config file and
 * returns a ConfigManager instance whose `configDir` option points at it —
 * plain `manager.load()` / `manager.save()` read and write the temp dir with
 * no per-call arguments. The caller is responsible for cleaning up the temp
 * directory after the test.
 *
 * @param opts ConfigManager options
 * @param overrides Optional initial config values written to the fixture file
 * @returns Object with the ConfigManager instance and the temp directory path
 */
export function createTestConfigManager<T extends object>(
  opts: ConfigManagerOptions<T>,
  overrides: Record<string, unknown> = {},
): { manager: ConfigManager<T>; configDir: string } {
  const configDir = createTestConfigDir(opts.filename ?? `${opts.id}-config.json`, overrides);
  return {
    manager: new ConfigManager<T>({ ...opts, configDir }),
    configDir,
  };
}

/**
 * Reset all pi-base test state: config file cache and session config store.
 *
 * Call this in afterEach when your tests exercise config loading, saving,
 * or session config across multiple cases.
 */
export function resetConfigTestState(): void {
  clearConfigFileCache();
  clearAllSessionConfigs();
}

/**
 * Create an isolated temp PI_CODING_AGENT_DIR for tests.
 *
 * This sets `PI_CODING_AGENT_DIR` to a temp directory, resets the vitest
 * module cache and pi-base path cache so imports pick up the new value,
 * and returns a cleanup function to restore the original state.
 *
 * Prefer this over manual `process.env.PI_CODING_AGENT_DIR = ...` in tests
 * so the env change is always paired with cleanup and cache reset.
 *
 * @param name Prefix for the temp directory (default: "pi-agent-test-")
 * @returns Object with the temp directory path and a cleanup function
 */
export function createTestAgentDir(name = "pi-agent-test-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), name));
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;

  if (typeof vi !== "undefined" && typeof vi.resetModules === "function") {
    vi.resetModules();
  }

  resetPiAgentDirCache();
  void getExtensionsDir();

  return {
    dir,
    cleanup: () => {
      if (original === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = original;
      }

      if (typeof vi !== "undefined" && typeof vi.resetModules === "function") {
        vi.resetModules();
      }

      resetPiAgentDirCache();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
