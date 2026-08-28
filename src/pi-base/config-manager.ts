/**
 * ConfigManager — declarative config management for pi extensions.
 *
 * Packages configure a single `ConfigManager<T>` with their config shape,
 * defaults, field definitions, optional validation, and optional env-var
 * overrides. The manager handles loading, saving, and modal wiring.
 *
 * Scopes default to all three enabled (global, project, session); extensions
 * opt out via `scopes: { global?: boolean; project?: boolean; session?: boolean }`.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { applyEnvOverrides, type EnvParser } from "./core/config-env.js";
export type { EnvParser } from "./core/config-env.js";
import {
  loadConfig,
  writeConfig,
  readConfig,
  deleteConfig,
  getExtensionsDir,
  deepEqual,
  checkConfigFile,
  deepMerge,
  getSessionConfig,
  setSessionConfig,
  clearSessionConfig,
  PENDING_SENTINEL,
  getRawSessionConfig,
} from "./config.js";
import { openConfigFlow, type ExtraSelectorEntry } from "./settings/config-flow.js";
import { validateFieldValue } from "./settings/validate-field.ts";
import type { Field } from "./settings/types.ts";
import type { ExtensionContext, FileEntry } from "@earendil-works/pi-coding-agent";

// ── Types ──────────────────────────────────────────────────────────────

export interface ConfigManagerOptions<T extends object = object> {
  /** Extension identifier — e.g. "bash-timeout" */
  id: string;
  /** Human-readable label shown in the UI */
  label: string;
  /** Config file name — e.g. "bash-timeout-config.json". Derived from `id` if omitted. */
  filename?: string;
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
  /**
   * Enable session-scoped config. Defaults to true. Session config is
   * persisted to the session JSONL via appendEntry and recovered on
   * session_start. It is the highest-priority override layer, isolated
   * per leaf with parent-chain inheritance.
   *
   * Pass an object to customize the JSONL entry type:
   *   - entryType: string — customType for appendEntry (default: "session-config-<id>")
   *
   * Set to false to disable session config entirely.
   */
  sessionConfig?: boolean | { entryType?: string };
  /**
   * Control which config scopes are available. Defaults to all three enabled.
   * Extensions opt out of scopes they don't need.
   */
  scopes?: {
    global?: boolean; // default true
    project?: boolean; // default true
    session?: boolean; // default true
  };
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

export type ConfigLayer = "defaults" | "global" | "project" | "env" | "session";

export interface ConfigInspection<T> {
  /** Per-layer CONTRIBUTIONS (not merged): what each layer explicitly sets. */
  layers: Record<ConfigLayer, Partial<T>>;
  /** Per key: the highest-precedence layer that explicitly sets it. */
  winners: Record<string, ConfigLayer>;
}

export interface ScopeSource {
  /** Config scope */
  scope: "global" | "project" | "session";
  /** Human-readable label */
  label: string;
  /** Absolute path; undefined for session */
  path?: string;
  /** Whether the file exists on disk; false for session */
  exists: boolean;
  /** Human-readable provenance note */
  note: string;
}

// ── ConfigManager ───────────────────────────────────────────────────────

export class ConfigManager<T extends object> {
  private opts: ConfigManagerOptions<T>;
  private _sessionId: string | undefined;
  private _leafId: string | undefined;
  private _entries: FileEntry[] | undefined;
  private _appendEntry: ((type: string, data: unknown) => void) | undefined;
  private _getEntries: (() => FileEntry[]) | undefined;
  private _filename: string;
  // Pending-mode session persistence state
  private _sessionPersist: "persisted" | "pending" | "unavailable" = "unavailable";
  private _sessionManager: SessionManagerFacade | undefined;
  private _pendingCwd: string | undefined;

  constructor(opts: ConfigManagerOptions<T>) {
    this.opts = opts;
    if (!opts.filename && !opts.id) {
      throw new Error(
        "ConfigManager requires either `id` or `filename` in options. " +
          "Provide one so the config file can be resolved.",
      );
    }
    this._filename = opts.filename ?? `${opts.id}-config.json`;
  }

  /** Resolved scope availability (opts.scopes with defaults applied). */
  getScopes(): { global: boolean; project: boolean; session: boolean } {
    const s = this.opts.scopes ?? {
      global: true,
      project: true,
      session: true,
    };
    return {
      global: s.global !== false,
      project: s.project !== false,
      session: s.session !== false && this.opts.sessionConfig !== false,
    };
  }

  /** True when session config scope is available (persisted or pending). */
  hasSession(): boolean {
    return this._sessionPersist === "persisted" || this._sessionPersist === "pending";
  }

  /**
   * Lazily detect and initialize session state from the live context.
   *
   * Persistence states:
   * - "persisted": JSONL exists, leafId known, appendEntry available.
   *   Session config is keyed to the real leafId and appended to JSONL on save.
   * - "pending": session file path is known but not yet persistable
   *   (file missing, leafId null, or appendEntry absent). Session scope is
   *   available; saves go to the in-memory store under PENDING_SENTINEL.
   *   _tryFlushSession() migrates the pending config to the real leafId
   *   exactly once once the session file materializes.
   * - "unavailable": inMemory session or session opt-out. Session scope
   *   is hidden from the selector.
   *
   * Identity change guard: if we already hold session state for a DIFFERENT
   * sessionId (user switched sessions in-process), reset persistence state
   * and re-detect for the new session.
   */
  private _ensureSession(ctx: ExtensionContext, cwd: string): boolean {
    // Identity change guard for lazy-detected state: runs before any
    // early return so it survives the persisted branch too (F1).
    if (this._sessionManager && this._sessionId) {
      const currentSessionId = ctx.sessionManager?.getSessionId?.();
      if (currentSessionId && this._sessionId !== currentSessionId) {
        const oldSessionId = this._sessionId;
        const oldPendingCwd = this._pendingCwd ?? process.cwd();
        clearSessionConfig(this._getEntryType(), oldPendingCwd, oldSessionId, PENDING_SENTINEL);
        this._sessionId = undefined;
        this._leafId = undefined;
        this._entries = undefined;
        this._appendEntry = undefined;
        this._getEntries = undefined;
        this._sessionPersist = "unavailable";
        this._sessionManager = undefined;
        this._pendingCwd = undefined;
      }
    }

    // Direct initSession() state: fixed identity, no stored facade.
    // Keep this state anchored to the sessionId passed to initSession.
    if (this._sessionPersist === "persisted" && !this._sessionManager) {
      this._tryFlushSession(cwd);
      return true;
    }

    // Lazy-detected state: _sessionManager is stored from a prior ctx-based
    // detection. Identity already checked above; flush and keep current state.
    if (this._sessionPersist !== "unavailable" && this._sessionManager) {
      const sm = ctx.sessionManager;
      if (!sm) {
        // Unreachable in production: ExtensionContext.sessionManager is
        // non-optional and always the live SessionManager (ExtensionRunner
        // binds it at construction). Kept as a safety net for unit-test
        // ctx stubs — keep current state rather than resetting.
        return true;
      }
      // Same identity — flush any pending data and keep current state
      this._tryFlushSession(cwd);
      return true;
    }

    const sm = ctx.sessionManager;
    if (!sm) {
      this._sessionPersist = "unavailable";
      return false;
    }

    if (this.opts.scopes?.session === false || this.opts.sessionConfig === false) {
      this._sessionPersist = "unavailable";
      return false;
    }

    const file = sm.getSessionFile?.();

    // In-memory session: no file path at all → unavailable
    if (typeof file !== "string") {
      this._sessionPersist = "unavailable";
      return false;
    }

    const leafId = sm.getLeafId?.() ?? null;

    // Facade cast: ctx.sessionManager is ReadonlySessionManager but is
    // always the live SessionManager at runtime (pi invariant).
    const mutable = sm as unknown as SessionManagerFacade;
    const hasAppend = typeof mutable.appendCustomEntry === "function";

    // Persistable = file on disk + leafId known + appendEntry available
    const persistable = existsSync(file) && leafId != null && hasAppend;

    if (persistable) {
      // Fully initialize — persisted mode
      const appendEntryFn = (type: string, data: unknown) => {
        mutable.appendCustomEntry(type, data);
      };
      this.initSession(sm.getSessionId()!, leafId, sm.getEntries?.() ?? [], appendEntryFn, () =>
        sm.getEntries?.(),
      );
      this._sessionPersist = "persisted";
      this._sessionManager = mutable; // keep facade for identity guard (F1)
      this._pendingCwd = cwd;
      return true;
    }

    // NOT persistable → pending mode
    // Session scope is available; saves go to the in-memory store under
    // PENDING_SENTINEL. _tryFlushSession() migrates once the session
    // file materializes and all persistability conditions are met.
    //
    // Side-effect-on-read: _tryFlushSession is called from load/openSettings
    // so that a brand-new session's config is appended to the JSONL as soon
    // as the file materializes — even if the user has not explicitly saved
    // again. This prevents config loss on process exit.
    const appendEntryFn = hasAppend
      ? (type: string, data: unknown) => {
          mutable.appendCustomEntry(type, data);
        }
      : undefined;

    this._sessionId = sm.getSessionId() ?? undefined;
    this._leafId = PENDING_SENTINEL;
    this._entries = sm.getEntries?.();
    this._appendEntry = appendEntryFn;
    this._getEntries = () => sm.getEntries?.() ?? [];
    this._sessionPersist = "pending";
    this._sessionManager = mutable;
    this._pendingCwd = cwd;

    // Attempt flush immediately (conditions may already be met)
    this._tryFlushSession(cwd);

    return true;
  }

  /**
   * Attempt to flush pending session config to the session JSONL.
   *
   * Only acts when _sessionPersist === "pending". The flush reads the
   * pending config from the in-memory store (keyed under PENDING_SENTINEL),
   * writes it to the real leafId via setSessionConfig, APPENDS a single
   * custom entry to the JSONL via appendCustomEntry, clears the sentinel
   * key, and transitions to persisted. Returns true only when an append
   * actually occurred (so callers can fall back to their own append when
   * flush transitioned without content).
   *
   * NEVER reads/scans the JSONL (existsSync only). The appended entry
   * uses appendCustomEntry which creates "custom" entries excluded from
   * LLM context. appendCustomMessageEntry is never used.
   *
   * Side-effect-on-read: called from _ensureSession (via load/openSettings)
   * so that config is appended to JSONL as soon as the session file
   * materializes — even without an explicit user save.
   *
   * The exactly-once guard is the _sessionPersist transition: once
   * "persisted", subsequent calls return immediately.
   *
   * @param cwd Working directory for the pending store key. Callers pass
   *   their resolved cwd (save passes its explicit targetCwd;
   *   loadWithWarnings/layerValues pass their cwd; _ensureSession passes
   *   its detection cwd).
   */
  private _tryFlushSession(cwd?: string): boolean {
    if (this._sessionPersist !== "pending") return false;
    if (!this._sessionManager) return false;

    const sm = this._sessionManager;

    // Re-resolve appendEntry wrapper from the live facade. The method does
    // not change at runtime, but re-resolve for uniformity and to pick up
    // newly-added facade methods (e.g. appendCustomEntry appearing after
    // initial detection). Update _appendEntry so that save() can append on
    // the next call even if the file hasn't materialized yet.
    const hasAppend = typeof sm.appendCustomEntry === "function";
    const appendEntryFn = hasAppend
      ? (type: string, data: unknown) => {
          sm.appendCustomEntry(type, data);
        }
      : undefined;
    this._appendEntry = appendEntryFn;

    const file = sm.getSessionFile();
    if (typeof file !== "string" || !existsSync(file)) return false;

    const leaf = sm.getLeafId();
    if (leaf == null) return false;

    if (!appendEntryFn) return false; // Stay pending until facade provides appendEntry

    const targetCwd = cwd ?? this._pendingCwd ?? process.cwd();
    const pendingConfig =
      getRawSessionConfig(this._getEntryType(), targetCwd, this._sessionId!, PENDING_SENTINEL) ??
      {};

    if (Object.keys(pendingConfig).length > 0) {
      // Migrate pending config to the real leafId (in-memory store).
      setSessionConfig(this._getEntryType(), targetCwd, this._sessionId!, leaf, pendingConfig);
      clearSessionConfig(this._getEntryType(), targetCwd, this._sessionId!, PENDING_SENTINEL);
      // Append the migrated config to JSONL — flush appends only real
      // pending content (no empty {} entries).
      appendEntryFn(this._getEntryType(), {
        leafId: leaf,
        config: pendingConfig,
      });
    }

    // Transition to persisted — this is the exactly-once guard.
    // _sessionManager and _pendingCwd are intentionally kept: the identity
    // guard at the top of _ensureSession needs _sessionManager to survive
    // into persisted mode (F1).
    this._leafId = leaf;
    this._sessionPersist = "persisted";
    return Object.keys(pendingConfig).length > 0;
  }
  initSession(
    sessionId: string,
    leafId: string,
    entries: FileEntry[],
    appendEntry?: (type: string, data: unknown) => void,
    getEntries?: () => FileEntry[],
  ): void {
    if (this.opts.scopes?.session === false || this.opts.sessionConfig === false) return;
    this._sessionId = sessionId;
    this._leafId = leafId;
    this._entries = entries;
    this._appendEntry = appendEntry;
    this._getEntries = getEntries;
    // Direct initSession() calls (from extensions or tests) set the
    // persistence state so hasSession() returns true and the session
    // tab appears in the Display All view. _sessionManager stays undefined
    // so _tryFlushSession is a no-op (no stored facade to resolve appendEntry
    // from) — flush only happens when _ensureSession stores the live ctx.
    this._sessionPersist = "persisted";
    this._sessionManager = undefined;
    this._pendingCwd = undefined;

    // Recover session config from JSONL entries — scan backwards for
    // the latest entry matching (entryType, leafId). First match wins.
    const entryType = this._getEntryType();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "custom" && entry.customType === entryType) {
        const data = entry.data as { leafId: string; config: Record<string, unknown> } | undefined;
        if (data && data.leafId === leafId) {
          setSessionConfig(entryType, process.cwd(), sessionId, leafId, data.config);
          break;
        }
      }
    }
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

    const loaded = loadConfig(this._filename, this.opts.defaults, {
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
    const withEnv = this.applyEnvOverrides(config);

    // Layer 5: session overrides (highest priority)
    const scopes = this.opts.scopes ?? {
      global: true,
      project: true,
      session: true,
    };
    const sessionEnabled = this.opts.sessionConfig !== false && scopes.session !== false;
    const namespace = this._getEntryType();
    const final = sessionEnabled ? this.applySessionOverrides(withEnv, cwd, namespace) : withEnv;

    // Attempt to flush pending session config if the session file has materialized.
    this._tryFlushSession(cwd);

    return { config: final, warnings };
  }

  private applyEnvOverrides(config: T): T {
    const env = this.opts.env;
    if (!env) return config;
    return applyEnvOverrides(
      config,
      env as Record<string, EnvParser | string>,
      this.opts.defaults as Record<string, unknown>,
    );
  }

  private applySessionOverrides(config: T, cwd: string | undefined, namespace: string): T {
    const sessionId = this._sessionId;
    const leafId = this._leafId;
    // Use fresh entries if a refresh function was provided; otherwise
    // fall back to the snapshot captured at initSession time.
    const entries = this._getEntries?.() ?? this._entries;
    if (!sessionId || !leafId || !entries) return config;

    // Pending mode: leafId is PENDING_SENTINEL. Read the pending config
    // directly from the in-memory store (no ancestor chain walk — the
    // sentinel has no entry in the JSONL).
    let session: Record<string, unknown>;
    if (leafId === PENDING_SENTINEL) {
      session =
        getRawSessionConfig(namespace, cwd ?? process.cwd(), sessionId, PENDING_SENTINEL) ?? {};
    } else {
      session = getSessionConfig(namespace, cwd ?? process.cwd(), sessionId, leafId, entries);
    }

    const merged = deepMerge(
      config as Record<string, unknown>,
      session as Record<string, unknown>,
    ) as T;

    // Re-validate after session merge so invalid session values are clamped
    return this.opts.validate ? this.opts.validate(merged as Record<string, unknown>) : merged;
  }

  private _applyValidation(config: T): T {
    return this.opts.validate ? this.opts.validate(config as Record<string, unknown>) : config;
  }

  /**
   * Return merged config values up to and including the given scope.
   *
   * Composition:
   *   "global"  = defaults ← global file
   *   "project" = layerValues("global") ← project file
   *   "env"     = layerValues("project") ← env overrides
   *   "session" = layerValues("env") ← session store
   */
  layerValues(
    scope: "global" | "project" | "env" | "session",
    cwd?: string,
    configDir?: string,
  ): T {
    const dir = configDir ?? getExtensionsDir();
    const defaults = this.opts.defaults as Record<string, unknown>;

    // Base: defaults ← global
    let result: Record<string, unknown> = { ...defaults };
    const globalData = readConfig<Record<string, unknown>>(this._filename, dir) ?? {};
    result = deepMerge(result, globalData) as Record<string, unknown>;

    if (scope === "global") {
      return this._applyValidation(result as T);
    }

    // Layer 2: project
    if (cwd) {
      const projectDir = join(cwd, ".pi");
      const projectData = readConfig<Record<string, unknown>>(this._filename, projectDir) ?? {};
      result = deepMerge(result, projectData) as Record<string, unknown>;
    }

    if (scope === "project" && !cwd) {
      throw new Error("cwd is required for project-scoped layerValues");
    }

    if (scope === "project") {
      return this._applyValidation(result as T);
    }

    // Layer 3: env
    if (this.opts.env) {
      const envResult = applyEnvOverrides(
        result as T,
        this.opts.env as Record<string, EnvParser | string>,
        this.opts.defaults as Record<string, unknown>,
      );
      result = envResult as Record<string, unknown>;
    }

    if (scope === "env") {
      return this._applyValidation(result as T);
    }

    // Layer 4: session (highest priority)
    const scopes = this.opts.scopes ?? {
      global: true,
      project: true,
      session: true,
    };
    const sessionEnabled = this.opts.sessionConfig !== false && scopes.session !== false;
    const namespace = this._getEntryType();
    if (sessionEnabled) {
      const sessionResult = this.applySessionOverrides(result as T, cwd, namespace);
      result = sessionResult as Record<string, unknown>;
    }

    // Attempt to flush pending session config if the session file has materialized.
    this._tryFlushSession(cwd);

    return this._applyValidation(result as T);
  }

  /**
   * Inspect per-layer contributions and per-key winners.
   */
  inspect(cwd?: string, configDir?: string): ConfigInspection<T> {
    const dir = configDir ?? getExtensionsDir();

    const defaultsLayer = { ...this.opts.defaults } as Partial<T>;
    const globalLayer = (readConfig<Record<string, unknown>>(this._filename, dir) ??
      {}) as Partial<T>;
    const projectLayer = cwd
      ? ((readConfig<Record<string, unknown>>(this._filename, join(cwd, ".pi")) ??
          {}) as Partial<T>)
      : ({} as Partial<T>);

    // Env layer: only keys whose env var is set AND parses.
    const envLayer: Partial<T> = {} as Partial<T>;
    if (this.opts.env) {
      const envApplied = applyEnvOverrides(
        projectLayer as T,
        this.opts.env as Record<string, EnvParser | string>,
        this.opts.defaults as Record<string, unknown>,
      );
      const envRecord = envApplied as Record<string, unknown>;
      for (const [key, value] of Object.entries(
        this.opts.env as Record<string, EnvParser | string>,
      )) {
        if (this._envKeyIsActive(key, value, this.opts.defaults as Record<string, unknown>)) {
          (envLayer as Record<string, unknown>)[key] = envRecord[key];
        }
      }
    }

    // Session layer: current leaf's session config, or {} when opted out / uninitialized.
    const sessionLayer: Partial<T> = {} as Partial<T>;
    const scopes = this.opts.scopes ?? {
      global: true,
      project: true,
      session: true,
    };
    const sessionEnabled = this.opts.sessionConfig !== false && scopes.session !== false;
    const namespace = this._getEntryType();
    if (sessionEnabled && this._sessionId && this._leafId) {
      let sessionConfig: Record<string, unknown>;
      if (this._leafId === PENDING_SENTINEL) {
        sessionConfig =
          getRawSessionConfig(namespace, cwd ?? process.cwd(), this._sessionId, PENDING_SENTINEL) ??
          {};
      } else {
        sessionConfig = getSessionConfig(
          namespace,
          cwd ?? process.cwd(),
          this._sessionId,
          this._leafId,
          this._getEntries?.() ?? this._entries ?? [],
        );
      }
      Object.assign(sessionLayer as Record<string, unknown>, sessionConfig);
    }

    const layers: Record<ConfigLayer, Partial<T>> = {
      defaults: defaultsLayer,
      global: globalLayer,
      project: projectLayer,
      env: envLayer,
      session: sessionLayer,
    };

    const allKeys = new Set<string>();
    for (const layer of Object.values(layers)) {
      for (const key of Object.keys(layer as Record<string, unknown>)) {
        allKeys.add(key);
      }
    }

    const winners: Record<string, ConfigLayer> = {};
    const precedence: ConfigLayer[] = ["session", "env", "project", "global", "defaults"];
    for (const key of allKeys) {
      for (const layer of precedence) {
        if (key in (layers[layer] as Record<string, unknown>)) {
          winners[key] = layer;
          break;
        }
      }
    }

    return { layers, winners };
  }

  /**
   * Return provenance sources for enabled scopes.
   */
  scopeSources(cwd?: string, configDir?: string): ScopeSource[] {
    const sources: ScopeSource[] = [];
    const scopes = this.opts.scopes ?? {
      global: true,
      project: true,
      session: true,
    };

    if (scopes.global !== false) {
      const globalDir = configDir ?? getExtensionsDir();
      const globalPath = join(globalDir, this._filename);
      const globalExists = existsSync(globalPath);
      sources.push({
        scope: "global",
        label: "Global",
        path: globalPath,
        exists: globalExists,
        note: globalExists ? globalPath : "(nonexistent — will be created on save)",
      });
    }

    if (scopes.project !== false && cwd) {
      const projectPath = join(cwd, ".pi", this._filename);
      const projectExists = existsSync(projectPath);
      sources.push({
        scope: "project",
        label: "Project Local",
        path: projectPath,
        exists: projectExists,
        note: projectExists ? projectPath : "(nonexistent — will be created on save)",
      });
    }

    if (scopes.session !== false && this.opts.sessionConfig !== false) {
      const entryType = this._getEntryType();
      const sessionFile = this._sessionManager?.getSessionFile?.();
      const pending = this._sessionPersist === "pending";
      sources.push({
        scope: "session",
        label: "Session",
        exists: false,
        path: sessionFile,
        note: pending
          ? sessionFile
            ? `in-memory until session file exists — will persist automatically`
            : "in-memory until session file exists — will persist automatically"
          : `in-memory per-leaf overrides (persisted to session JSONL as ${entryType})`,
      });
    }

    return sources;
  }

  private _envKeyIsActive(
    key: string,
    envValue: string | EnvParser,
    defaults: Record<string, unknown>,
  ): boolean {
    if (typeof envValue === "string") {
      const raw = process.env[envValue]?.trim();
      if (!raw) return false;
      const defaultValue = defaults[key];
      if (typeof defaultValue === "boolean") {
        return ["1", "true", "yes", "on", "0", "false", "no", "off"].includes(raw.toLowerCase());
      }
      if (typeof defaultValue === "number") {
        if (Number.isInteger(defaultValue) && defaultValue > 0) {
          const parsed = Number.parseInt(raw, 10);
          return Number.isFinite(parsed) && parsed > 0;
        }
        const parsed = Number.parseFloat(raw);
        return Number.isFinite(parsed);
      }
      return false;
    } else {
      const raw = process.env[envValue.var]?.trim();
      if (!raw) return false;
      try {
        return envValue.parse(raw, undefined) !== undefined;
      } catch {
        return false;
      }
    }
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
  save(
    config: T,
    scope: "global" | "project" | "session",
    cwd?: string,
    configDir?: string,
  ): { path: string; created: boolean; changed: boolean } {
    if (scope === "session") {
      if (!this._sessionId) {
        throw new Error(
          "Cannot save session config: session not initialized. Call initSession() first.",
        );
      }
      const targetCwd = cwd ?? process.cwd();
      setSessionConfig(
        this._getEntryType(),
        targetCwd,
        this._sessionId,
        this._leafId!,
        config as Record<string, unknown>,
      );
      this._pendingCwd = targetCwd;

      // Attempt flush after store update: if the session file materialized,
      // _tryFlushSession migrates pending config to the real leafId and
      // appends exactly once. Order matters: setSessionConfig first ensures
      // the pending store holds the latest config when the flush reads it.
      const flushed = this._tryFlushSession(targetCwd);

      // Append to session JSONL only in persisted mode AND flush did not
      // already append. The in-memory store is already updated above.
      // Flush from load/openSettings also appends — side-effect-on-read is
      // intentional: config must not be lost on process exit.
      if (!flushed && this._sessionPersist === "persisted" && this._appendEntry) {
        this._appendEntry(this._getEntryType(), {
          leafId: this._leafId!,
          config: config as Record<string, unknown>,
        });
      }
      return { path: "", created: false, changed: true };
    }
    if (scope === "project" && !cwd) {
      throw new Error("cwd is required for project-scoped config save");
    }

    const dir = scope === "project" && cwd ? join(cwd, ".pi") : (configDir ?? getExtensionsDir());
    const targetPath = join(dir, this._filename);
    const created = !existsSync(targetPath);

    const knownKeys = new Set(Object.keys(this.opts.defaults));

    // Read the existing file. If none exists, start from an empty object.
    const existing = readConfig<Record<string, unknown>>(this._filename, dir) ?? {};

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

    if (!hasDiff) {
      return { path: targetPath, created, changed: false };
    }

    // Merge: start from the existing file, overlay the diff. This keeps
    // every untouched key exactly where it was while updating only the
    // fields the user actually changed in this session.
    const merged = { ...existing, ...diff };
    const wrote = writeConfig(this._filename, merged as Partial<T>, dir);
    if (!wrote) {
      throw new Error(
        `Failed to save ${this._filename} — the config file may be read-only (e.g., managed by Nix). ` +
          `Runtime state was updated for this session only.`,
      );
    }

    return { path: targetPath, created, changed: true };
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
  private _getEntryType(): string {
    if (typeof this.opts.sessionConfig === "object" && this.opts.sessionConfig.entryType) {
      return this.opts.sessionConfig.entryType;
    }
    return `session-config-${this.opts.id}`;
  }

  /**
   * Open the settings with the config flow (pre-selector →
   * edit mode / display-all).
   *
   * Signature is stable. Before opening, checks global and
   * project-local config files for malformed JSON and warns.
   *
   * The consumer's `onSave` is called with the validated config
   * after persist. Validation runs inside the save wrapper.
   *
   * @param ctx Extension context
   * @param cwd Working directory for project-local override
   * @param onSave Called with the validated config after the user saves
   * @param configDir Override the global config dir (for tests)
   * @param onChange Optional per-field change handler passed through
   */
  async openSettings(
    ctx: ExtensionContext,
    cwd: string,
    onSave: (updated: T) => void,
    configDir?: string,
    onChange?: (key: string, value: unknown) => void,
    extraEntries?: ExtraSelectorEntry[],
    onExtraSelect?: (id: string) => Promise<void> | void,
  ): Promise<void> {
    this.warnOnMalformedConfig(ctx, cwd, configDir);
    const scopes = this.getScopes();
    const sessionInitialized = this._ensureSession(ctx, cwd);
    const sources = this.scopeSources(cwd, configDir);
    await openConfigFlow(
      {
        label: this.opts.label,
        ctx,
        cwd,
        scopes,
        sessionInitialized,
        sessionNote: sources.find((s) => s.scope === "session")?.note ?? "",
        defaults: this.opts.defaults as Record<string, unknown>,
        env: this.opts.env as Record<string, string | EnvParser> | undefined,
        buildFields: (values) => {
          const fields = this.opts.fields(values as T);
          const configDefaults = this.opts.defaults as Record<string, unknown>;
          for (const field of fields) {
            if (field.type === "action" || field.type === "custom") continue;
            if ((field as { default?: unknown }).default === undefined) {
              const key = String(field.key);
              if (key in configDefaults) {
                (field as { default?: unknown }).default = configDefaults[key];
              }
            }
          }
          return fields;
        },
        layerValues: (s) => this.layerValues(s, cwd, configDir) as Record<string, unknown>,
        inspect: () => this.inspect(cwd, configDir),
        scopeSources: () => this.scopeSources(cwd, configDir),
        save: async (values, scope) => {
          const updated = this.opts.validate
            ? this.opts.validate(values as Record<string, unknown>)
            : (values as T);
          const res = this.save(updated, scope, cwd, configDir);
          onSave(updated);
          return res;
        },
        resetScope: (scope) => this.resetScope(scope, cwd, configDir),
        deleteScope: (scope) => this.deleteScope(scope, cwd, configDir),
        onSaved: () => {},
        onChange,
      },
      extraEntries,
      onExtraSelect,
    );
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
  resetScope(scope: "global" | "project" | "session", cwd?: string, configDir?: string): void {
    if (scope === "session") {
      if (!this._sessionId) {
        throw new Error("Cannot reset session config: session not initialized.");
      }
      const targetCwd = cwd ?? process.cwd();
      if (this._sessionPersist === "pending") {
        clearSessionConfig(this._getEntryType(), targetCwd, this._sessionId, PENDING_SENTINEL);
      } else {
        clearSessionConfig(this._getEntryType(), targetCwd, this._sessionId, this._leafId!);
      }
      return;
    }
    if (scope === "project" && !cwd) {
      throw new Error("cwd is required for project-scoped config reset");
    }
    const dir = scope === "project" && cwd ? join(cwd, ".pi") : (configDir ?? getExtensionsDir());
    const knownKeys = new Set(Object.keys(this.opts.defaults));
    const existing = readConfig<Record<string, unknown>>(this._filename, dir);
    const unknownKeys: Record<string, unknown> = {};
    if (existing && typeof existing === "object") {
      for (const [key, val] of Object.entries(existing)) {
        if (!knownKeys.has(key)) unknownKeys[key] = val;
      }
    }
    if (Object.keys(unknownKeys).length > 0) {
      writeConfig(this._filename, unknownKeys as T, dir);
    } else {
      deleteConfig(this._filename, dir);
    }
  }

  /**
   * Delete the entire config file for a scope. Unlike `resetScope`,
   * this removes unknown keys as well — the file is completely gone.
   * Next load will use nothing but defaults.
   */
  deleteScope(scope: "global" | "project" | "session", cwd?: string, configDir?: string): void {
    if (scope === "session") {
      if (!this._sessionId) {
        throw new Error("Cannot delete session config: session not initialized.");
      }
      const targetCwd = cwd ?? process.cwd();
      if (this._sessionPersist === "pending") {
        clearSessionConfig(this._getEntryType(), targetCwd, this._sessionId, PENDING_SENTINEL);
      } else {
        clearSessionConfig(this._getEntryType(), targetCwd, this._sessionId, this._leafId!);
      }
      return;
    }
    if (scope === "project" && !cwd) {
      throw new Error("cwd is required for project-scoped config delete");
    }
    const dir = scope === "project" && cwd ? join(cwd, ".pi") : (configDir ?? getExtensionsDir());
    deleteConfig(this._filename, dir);
  }

  /**
   * Check global and project-local config files for malformed JSON.
   * Warns via ctx.ui.notify if any are found.
   */
  private warnOnMalformedConfig(ctx: ExtensionContext, cwd: string, configDir?: string): void {
    const filename = this._filename;

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

// Facade for a live SessionManager (pi runtime invariant: ctx.sessionManager is
// ReadonlySessionManager typed but always the mutable SessionManager instance).
// Only the members actually used by ConfigManager are declared here.
interface SessionManagerFacade {
  getSessionFile(): string | undefined;
  getLeafId(): string | null | undefined;
  getSessionId(): string | undefined;
  getEntries(): FileEntry[];
  appendCustomEntry(customType: string, data?: unknown): string;
}
