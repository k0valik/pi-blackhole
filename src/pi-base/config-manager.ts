/**
 * ConfigManager — declarative config management for pi extensions.
 *
 * Packages configure a single `ConfigManager<T>` with their config shape,
 * defaults, field definitions, optional validation, and optional env-var
 * overrides. The manager handles loading, saving, and modal wiring.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  loadConfig,
  readBooleanEnv,
  readPositiveIntEnv,
  writeConfig,
  readConfig,
  deleteConfig,
  getExtensionsDir,
  deepEqual,
  checkConfigFile,
} from "./config.ts";
import { openSettingsModal } from "./settings/index.ts";
import { validateFieldValue } from "./settings/validate-field.ts";
import type { Field } from "./settings/types.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Types ──────────────────────────────────────────────────────────────

export interface ConfigManagerOptions<T extends object = object> {
  /** Extension identifier — e.g. "bash-timeout" */
  id: string;
  /** Human-readable label shown in the UI */
  label: string;
  /** Config file name — e.g. "bash-timeout-config.json" */
  filename: string;
  /** Default config values (the complete object) */
  defaults: T;
  /** Build Field[] from current config values */
  fields: (config: T) => Field[];
  /**
   * Optional validator. Receives raw merged data and returns a fully
   * coerced config. If omitted, the manager does a simple spread merge.
   */
  validate?: (raw: Record<string, unknown>) => T;
  /**
   * Optional env-var overrides. Maps config keys to env var names.
   * Boolean types use `readBooleanEnv`, numeric types use `readPositiveIntEnv`.
   * For custom parsing, use a parser object with a `parse` function.
   */
  env?: Partial<Record<keyof T, string | EnvParser>>;
}

export interface EnvParser {
  /** Env var name */
  var: string;
  /** Custom parse function (receives raw string, returns parsed value) */
  parse: (raw: string, current: unknown) => unknown;
}

export interface ConfigLoadWarning {
  /** Scope where the warning originated */
  scope: "global" | "project";
  /** Human-readable warning message */
  message: string;
  /** Config key involved (if applicable) */
  key?: string;
}

export interface ConfigLoadResult<T> {
  /** Fully resolved config value */
  config: T;
  /** Non-fatal warnings discovered during loading (bad values, unknown keys, etc.) */
  warnings: ConfigLoadWarning[];
}

// ── ConfigManager ───────────────────────────────────────────────────────

export class ConfigManager<T extends object> {
  private opts: ConfigManagerOptions<T>;

  constructor(opts: ConfigManagerOptions<T>) {
    this.opts = opts;
  }

  /**
   * Load config with layered resolution:
   *   defaults ← global file ← project file ← env overrides
   *
   * @param cwd Working directory for project-local override
   * @param configDir Global config directory (defaults to getExtensionsDir())
   */
  load(cwd?: string, configDir?: string): T {
    return this.loadWithWarnings(cwd, configDir).config;
  }

  /**
   * Load config with warnings. Same as `load()` but also returns per-field
   * validation warnings and unknown-key warnings discovered during loading.
   *
   * Extensions that open a modal can surface these warnings in the UI;
   * extensions that load config programmatically can log or inspect them.
   */
  loadWithWarnings(cwd?: string, configDir?: string): ConfigLoadResult<T> {
    const warnings: ConfigLoadWarning[] = [];

    const loaded = loadConfig(this.opts.filename, this.opts.defaults, {
      cwd,
      configDir,
      merge: "deep",
    });

    // Run validate if provided
    const config = this.opts.validate
      ? this.opts.validate(loaded as Record<string, unknown>)
      : (loaded as T);

    // Validate each field value and collect warnings
    try {
      const fields = this.opts.fields(config);
      const scope = "global";
      for (const field of fields) {
        if (field.type === "action" || field.type === "custom") continue;
        const warning = validateFieldValue(field, field.value);
        if (warning) {
          warnings.push({
            scope: scope as "global" | "project",
            key: String(field.key),
            message: `"${field.label}": ${warning}`,
          });
        }
      }
    } catch {
      // Fields function may fail for partial configs; skip validation
    }

    // Apply env overrides
    const final = this.applyEnvOverrides(config);

    return { config: final, warnings };
  }

  private applyEnvOverrides(config: T): T {
    const env = this.opts.env;
    if (!env) return config;

    const result = { ...config } as Record<string, unknown>;

    for (const [key, value] of Object.entries(env)) {
      if (!value) continue;

      const defaultValue = (this.opts.defaults as Record<string, unknown>)[key];

      if (typeof value === "string") {
        // Auto-detect type from default value
        const envName = value;
        if (typeof defaultValue === "boolean") {
          result[key] = readBooleanEnv(
            envName,
            (result[key] as boolean) ?? (defaultValue as boolean),
          );
        } else if (typeof defaultValue === "number") {
          if (Number.isInteger(defaultValue) && defaultValue > 0) {
            result[key] = readPositiveIntEnv(
              envName,
              (result[key] as number) ?? (defaultValue as number),
            );
          } else {
            // Float — parse and preserve
            const raw = process.env[envName]?.trim();
            if (raw) {
              const parsed = Number.parseFloat(raw);
              if (Number.isFinite(parsed)) {
                result[key] = parsed;
              }
            }
          }
        }
      } else {
        // Custom EnvParser
        const parser = value as EnvParser;
        const raw = process.env[parser.var]?.trim();
        if (raw) {
          result[key] = parser.parse(raw, result[key]);
        }
      }
    }

    return result as T;
  }

  /**
   * Save config scoped to global or project directory.
   *
   * Writes only the fields that differ from the existing file content
   * (diff-based save against the file). This means:
   *
   * - **First save** (no file exists): writes ALL fields — the file is
   *   fully populated with every value the user confirmed.
   * - **Subsequent saves**: only the fields that actually changed in the
   *   current session are written. Everything else stays untouched.
   * - **Unknown keys** (hand-edited extras outside the schema) are
   *   automatically preserved by the read-patch-write cycle.
   * - **No automatic removal**: only explicit reset/delete removes keys
   *   from the file.
   *
   * Reads the existing file, patches it with the deltas, and writes the
   * merged result. This prevents accidental overwrites of fields the user
   * never touched while keeping the file consistent with the UI.
   *
   * @param config Config to persist
   * @param scope Target scope
   * @param cwd Working directory (required for "project" scope)
   * @param configDir Override the global config dir (for tests)
   */
  save(config: T, scope: "global" | "project", cwd?: string, configDir?: string): void {
    if (scope === "project" && !cwd) {
      throw new Error("cwd is required for project-scoped config save");
    }

    const dir = scope === "project" && cwd ? join(cwd, ".pi") : (configDir ?? getExtensionsDir());
    const knownKeys = new Set(Object.keys(this.opts.defaults));

    // Read the existing file. If none exists, start from an empty object.
    const existing = readConfig<Record<string, unknown>>(this.opts.filename, dir) ?? {};

    // Build field map for validation
    const fieldMap = new Map<string, Field>();
    try {
      const fields = this.opts.fields(config);
      for (const f of fields) fieldMap.set(String(f.key), f);
    } catch {
      // Fields function may fail for partial configs; skip validation
    }

    // Compute diff: compare each known key's modal value against the
    // existing file value. Only fields that actually changed are written.
    const diff: Record<string, unknown> = {};
    let hasDiff = false;

    for (const key of Object.keys(this.opts.defaults) as (keyof T)[]) {
      const modalVal = config[key];
      const fileVal = existing[String(key)];

      if (deepEqual(modalVal, fileVal)) continue;

      // Validate before persisting — skip invalid values to repair
      // config files (invalid values fall back to defaults next load).
      const field = fieldMap.get(String(key));
      if (field && !(field.type === "action" || field.type === "custom")) {
        const warning = validateFieldValue(field, modalVal);
        if (warning) continue;
      }

      diff[String(key)] = modalVal;
      hasDiff = true;
    }

    // Preserve unknown keys from the existing file.
    for (const [key, val] of Object.entries(existing)) {
      if (!knownKeys.has(key)) {
        diff[key] = val;
        hasDiff = true;
      }
    }

    if (!hasDiff) return;

    // Merge: start from the existing file, overlay the diff. This keeps
    // every untouched key exactly where it was while updating only the
    // fields the user actually changed in this session.
    const merged = { ...existing, ...diff };
    const wrote = writeConfig(this.opts.filename, merged as Partial<T>, dir);
    if (!wrote) {
      throw new Error(
        `Failed to save ${this.opts.filename} — the config file may be read-only (e.g., managed by Nix). ` +
        `Runtime state was updated for this session only.`,
      );
    }
  }

  /**
   * Open the settings modal with scope tabs, auto-generated onSave, etc.
   *
   * Before opening the modal, checks global and project-local config files
   * for malformed JSON. If either is invalid, a warning notification is
   * shown so the user knows their config couldn't be fully loaded.
   *
   * @param ctx Extension context
   * @param cwd Working directory for project-local override
   * @param onSave Called with the validated config after the user saves
   * @param configDir Override the global config dir (for tests)
   */
  /**
   * Open the settings modal with scope tabs, auto-generated onSave, scope
   * actions (reset/delete), etc.
   *
   * Before opening the modal, checks global and project-local config files
   * for malformed JSON. If either is invalid, a warning notification is
   * shown so the user knows their config couldn't be fully loaded.
   *
   * @param ctx Extension context
   * @param cwd Working directory for project-local override
   * @param onSave Called with the validated config after the user saves
   * @param configDir Override the global config dir (for tests)
   * @param onChange Optional per-field change handler passed through to
   *                 the settings modal. Called synchronously when any
   *                 field value changes (including in buffered mode).
   */
  async openSettings(
    ctx: ExtensionContext,
    cwd: string,
    onSave: (updated: T) => void,
    configDir?: string,
    onChange?: (key: string, value: unknown) => void,
  ): Promise<void> {
    // Check for malformed config files before opening the modal
    this.warnOnMalformedConfig(ctx, cwd, configDir);

    const config = this.load(cwd, configDir);
    const fields = this.opts.fields(config);

    // Auto-populate field-level defaults from the config defaults so
    // field-level reset (ctrl+r/ctrl+d) works without every extension
    // manually setting `default` on each field definition.
    const configDefaults = this.opts.defaults as Record<string, unknown>;
    for (const field of fields) {
      if (field.type === "action" || field.type === "custom") continue;
      if (field.default === undefined) {
        const key = String(field.key);
        if (key in configDefaults) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (field as any).default = configDefaults[key];
        }
      }
    }

    // Validate loaded field values and warn about inconsistencies.
    // Per-field warnings are also shown inline in the modal UI.
    const loadWarnings: string[] = [];
    for (const field of fields) {
      if (field.type === "action" || field.type === "custom") continue;
      const warning = validateFieldValue(field, field.value);
      if (warning) loadWarnings.push(`"${field.label}": ${warning}`);
    }
    if (loadWarnings.length > 0) {
      const msg =
        loadWarnings.length === 1
          ? `Config warning: ${loadWarnings[0]}`
          : `Config has ${loadWarnings.length} warnings. First: ${loadWarnings[0]}`;
      ctx.ui.notify(msg, "warning");
    }

    await openSettingsModal(ctx, {
      title: this.opts.label,
      configFilename: this.opts.filename,
      mode: "buffered",
      defaults: this.opts.defaults as unknown as Record<string, unknown>,
      globalConfigDir: configDir,
      inferDefaultScope: () =>
        existsSync(join(cwd, ".pi", this.opts.filename)) ? "project" : "global",
      fields,
      onChange,
      onSave: async (values: Record<string, unknown>, scope: "global" | "project") => {
        const merged = { ...config, ...values };
        const updated = this.opts.validate
          ? this.opts.validate(merged as Record<string, unknown>)
          : (merged as T);
        this.save(updated, scope, cwd, configDir);
        onSave(updated);
      },
      onResetScope: async (scope) => {
        this.resetScope(scope, cwd, configDir);
      },
      onDeleteScope: async (scope) => {
        this.deleteScope(scope, cwd, configDir);
      },
    });
  }

  /**
   * Reset a scope's configuration to defaults. Known config keys
   * (those defined in the schema) are removed from the file; unknown
   * keys (from future versions or user additions) are preserved so
   * forward-compatibility is maintained. Next load will use defaults
   * for all known fields.
   *
   * After this call, the file contains only unknown keys. If no
   * unknown keys exist, the file is deleted entirely.
   */
  resetScope(scope: "global" | "project", cwd?: string, configDir?: string): void {
    if (scope === "project" && !cwd) {
      throw new Error("cwd is required for project-scoped config reset");
    }
    const dir = scope === "project" && cwd ? join(cwd, ".pi") : (configDir ?? getExtensionsDir());
    const knownKeys = new Set(Object.keys(this.opts.defaults));
    const existing = readConfig<Record<string, unknown>>(this.opts.filename, dir);
    const unknownKeys: Record<string, unknown> = {};
    if (existing && typeof existing === "object") {
      for (const [key, val] of Object.entries(existing)) {
        if (!knownKeys.has(key)) unknownKeys[key] = val;
      }
    }
    if (Object.keys(unknownKeys).length > 0) {
      writeConfig(this.opts.filename, unknownKeys as T, dir);
    } else {
      deleteConfig(this.opts.filename, dir);
    }
  }

  /**
   * Delete the entire config file for a scope. Unlike `resetScope`,
   * this removes unknown keys as well — the file is completely gone.
   * Next load will use nothing but defaults.
   */
  deleteScope(scope: "global" | "project", cwd?: string, configDir?: string): void {
    if (scope === "project" && !cwd) {
      throw new Error("cwd is required for project-scoped config delete");
    }
    const dir = scope === "project" && cwd ? join(cwd, ".pi") : (configDir ?? getExtensionsDir());
    deleteConfig(this.opts.filename, dir);
  }

  /**
   * Check global and project-local config files for malformed JSON.
   * Warns via ctx.ui.notify if any are found.
   */
  private warnOnMalformedConfig(ctx: ExtensionContext, cwd: string, configDir?: string): void {
    const filename = this.opts.filename;

    const globalStatus = checkConfigFile(filename, configDir);
    if (globalStatus.exists && !globalStatus.valid) {
      ctx.ui.notify(
        `Config file "${filename}" is ${globalStatus.error}. Using defaults.`,
        "warning",
      );
    }

    const projectDir = join(cwd, ".pi");
    const projectStatus = checkConfigFile(filename, projectDir);
    if (projectStatus.exists && !projectStatus.valid) {
      ctx.ui.notify(
        `Project config file ".pi/${filename}" is ${projectStatus.error}. Using defaults.`,
        "warning",
      );
    }
  }
}
