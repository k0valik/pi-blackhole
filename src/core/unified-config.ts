/**
 * Unified configuration loader — merges pi-vcc + OM settings into one file.
 *
 * Created by pi-vcc-om.
 * Reads ~/.pi/agent/pi-blackhole/pi-blackhole-config.json with legacy fallback support.
 * Model configs support cooldownHours and fallbackModel arrays.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyEnvOverrides, DECLARATIVE_ENV_OVERRIDES } from "./config-env.js";
import { getAgentDir as originalGetAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

// ── getAgentDir with PI_CODING_AGENT_DIR override ───────────────────────────

let __lastAgentDirEnv: string | undefined;
let __cachedAgentDir: string | null = null;

/**
 * Get the canonical pi-agent data directory.
 * Respects the `PI_CODING_AGENT_DIR` environment variable when set.
 * Memoized — only recomputes when the env var changes.
 */
export function getAgentDir(): string {
  const current = process.env.PI_CODING_AGENT_DIR?.trim();
  if (current === __lastAgentDirEnv && __cachedAgentDir !== null)
    return __cachedAgentDir;
  __lastAgentDirEnv = current;
  __cachedAgentDir = current || originalGetAgentDir();
  return __cachedAgentDir;
}

// ── Config path ──────────────────────────────────────────────────────────────

const CONFIG_DIR = "pi-blackhole";
const CONFIG_FILE = "pi-blackhole-config.json";

/** Test-only: override for config directory. Set via __setTestConfigDir(). */
let __testConfigDir: string | undefined;

/** Test-only: set to override config directory. Use in beforeEach/afterEach. */
export function __setTestConfigDir(dir: string | undefined): void {
  __testConfigDir = dir;
}

export function configPath(): string {
  if (__testConfigDir) {
    return join(__testConfigDir, CONFIG_DIR, CONFIG_FILE);
  }
  return join(getAgentDir(), CONFIG_DIR, CONFIG_FILE);
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface OmModelConfig {
  provider: string;
  id: string;
  thinking?: ModelThinkingLevel;
  /** Cooldown duration in hours after a retryable error (429/5xx/timeout).
   *  Defaults to 1 hour when omitted. */
  cooldownHours?: number;
  /** Context window override for this model. Inherits from Pi's model registry when unset. */
  contextWindow?: number;
}

export interface UnifiedConfig {
  /** @deprecated Use compactionEngine instead. */
  overrideDefaultCompaction?: boolean;
  /** Write debug snapshots to /tmp/pi-blackhole-debug.json. */
  debug: boolean;

  // ── New config surface — compaction, engine, tail behavior ──

  /** Unified compaction control: "auto" | "manual" | "off".
   *  "auto"   — auto-trigger on compactAfterTokens threshold
   *  "manual"  — only via /blackhole command
   *  "off"    — never compact (disables auto + blocks /blackhole) */
  compaction: "auto" | "manual" | "off";

  /** Which engine handles compaction.
   *  "blackhole"  — blackhole's compile() + OM injection
   *  "pi-default" — Pi's built-in summarization */
  compactionEngine: "blackhole" | "pi-default";

  /** How Blackhole exposes compaction summaries to the provider.
   *  "default"    — current one-summary replacement behavior
   *  "append"     — immutable VCC segments; explicit /blackhole rebases */
  compactionSummaryMode: "default" | "append";

  /**
   * Providers for which blackhole steps aside entirely (no compaction, no
   * observational-memory consolidation) — used for multi-engine coordination
   * (e.g. OpenAI Codex sessions must use native Codex remote compaction).
   * Entries are provider ids, optionally "provider:api" for precision.
   */
  skipForProviders: string[];

  /** Mid-run auto-compaction (turn_end trigger, fires while the agent is still
   *  executing tool loops — agent_end alone never fires during long runs).
   *  "resume" — compact transparently at the turn boundary; the same run continues (opt-in)
   *  "pause"  — use Pi's interrupting compaction; user continues manually
   *  "off"    — only evaluate the threshold when the agent finishes a run (default) */
  midRunCompaction: "resume" | "pause" | "off";

  /** How much recent transcript to keep visible after compaction.
   *  "pi-default" — use Pi's firstKeptEntryId (respects Pi's keepRecentTokens)
   *  "minimal"    — keep only last user message (current agressive pi-vcc behavior)
   *  ONLY applies when compactionEngine: "blackhole" */
  tailBehavior: "pi-default" | "minimal";

  /** Token threshold for observer runs. */
  observeAfterTokens: number;
  /** Token threshold for reflector and dropper. */
  reflectAfterTokens: number;
  /** Token threshold for proactive auto-compaction. */
  compactAfterTokens: number;
  /** Observation pool token pressure for full fold. */
  observationsPoolMaxTokens: number;
  /** Treat every compaction as a full-fold boundary so early reflections/drops
   *  survive the first compaction in a fresh session. Default true. */
  fullFoldAlways: boolean;
  /** Target token budget for the observation pool (dropper aims here).
   *  Optional; defaults to half of observationsPoolMaxTokens when unset.
   *  Must be less than observationsPoolMaxTokens.
   *
   *  NOTE: Ported from upstream as forward-compat (no-op in our pool algorithm).
   *  Upstream renamed budgetTokens→targetTokens (52b5844) and uses this
   *  for their tokensOverTarget / avgTokensPerObservation drop calculation.
   *  We keep our ratio-based urgency algorithm; this knob exists so future
   *  lockstep iterations don't diverge on the config shape. */
  observationsPoolTargetTokens: number;
  /** Max prompt tokens for reflector model input (rolling window cap). */
  reflectorInputMaxTokens: number;
  /** Max prompt tokens for dropper model input (rolling window cap). */
  dropperInputMaxTokens: number;
  /** Pressure threshold for dropper.  When active observation pool tokens exceed
   *  this fraction of reflectorInputMaxTokens, the dropper runs even without new
   *  observations/reflections (to keep the pool pruned).
   *  Default 0.70 (70%). Must be in range (0, 1]. */
  dropperPressureThreshold: number;
  /** Minimum observation-pool fullness (fraction of observationsPoolMaxTokens)
   *  before the dropper may run. Prevents churn on a nearly empty pool.
   *  Default 0.10 (10%). Must be in range (0, 1]. */
  dropperPoolFullnessThreshold: number;
  /** Max source entries tokens sent to observer per chunk. */
  observerChunkMaxTokens: number;
  /** Max preamble tokens (CURRENT REFLECTIONS / OBSERVATIONS) in the observer prompt.
   *  Default 0 means auto-compute from observerChunkMaxTokens (30%). Only applied in
   *  noAutoCompact mode where accumulated batch history can grow unbounded.
   *  Set to an explicit value to override the auto-computed budget. */
  observerPreambleMaxTokens: number;
  /** Shared turn cap for background memory agents. */
  agentMaxTurns: number;
  /** Body-idle timeout for background provider streams. Uses pi's default when unset;
   *  set to 0 to explicitly disable the wrapper. */
  providerIdleTimeoutMs?: number;

  /** Base model override for all memory workers. */
  model?: OmModelConfig;
  /** Model override for observer (most frequent worker). */
  observerModel?: OmModelConfig;
  /** Model override for reflector (synthesizes durable facts). */
  reflectorModel?: OmModelConfig;
  /** Model override for dropper (prunes observations). */
  dropperModel?: OmModelConfig;

  /** Fallback models for observer, tried in order after primary model fails. */
  observerFallbackModels?: OmModelConfig[];
  /** Fallback models for reflector, tried in order after primary model fails. */
  reflectorFallbackModels?: OmModelConfig[];
  /** Fallback models for dropper, tried in order after primary model fails. */
  dropperFallbackModels?: OmModelConfig[];

  /** When false, skip session model fallback when all OM model candidates are exhausted.
   *  Default true for backward compatibility. */
  sessionFallback?: boolean;

  /** @deprecated Use compaction instead. */
  noAutoCompact?: boolean;
  /** @deprecated Use compaction + memory instead. */
  passive?: boolean;
  /** Enables observational memory (workers + content injection). Set to false for pi-vcc only. */
  memory: boolean;
  /** Writes debug JSONL to agent directory. */
  debugLog: boolean;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULTS: UnifiedConfig = {
  debug: false,
  sessionFallback: true,

  // New config surface
  compaction: "auto",
  compactionEngine: "blackhole",
  compactionSummaryMode: "default",

  skipForProviders: [],
  tailBehavior: "minimal",
  midRunCompaction: "off",

  observeAfterTokens: 15_000,
  reflectAfterTokens: 25_000,
  compactAfterTokens: 81_000,
  observationsPoolMaxTokens: 20_000,
  fullFoldAlways: true,
  observationsPoolTargetTokens: 10_000,
  reflectorInputMaxTokens: 80_000,
  dropperInputMaxTokens: 80_000,
  dropperPressureThreshold: 0.7,
  dropperPoolFullnessThreshold: 0.1,
  observerChunkMaxTokens: 40_000,
  observerPreambleMaxTokens: 0,
  agentMaxTurns: 16,

  memory: true,
  debugLog: false,
};

// ── Parsing helpers ──────────────────────────────────────────────────────────

const THINKING_LEVELS: readonly string[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

// String enums for new config surface
const COMPACTION_VALUES = ["auto", "manual", "off"] as const;
const COMPACTION_ENGINE_VALUES = ["blackhole", "pi-default"] as const;
const COMPACTION_SUMMARY_MODE_VALUES = ["default", "append"] as const;

const TAIL_BEHAVIOR_VALUES = ["pi-default", "minimal"] as const;
const MID_RUN_COMPACTION_VALUES = ["resume", "pause", "off"] as const;

function isCompaction(v: unknown): v is "auto" | "manual" | "off" {
  return (
    typeof v === "string" &&
    (COMPACTION_VALUES as readonly string[]).includes(v)
  );
}
function isCompactionEngine(v: unknown): v is "blackhole" | "pi-default" {
  return (
    typeof v === "string" &&
    (COMPACTION_ENGINE_VALUES as readonly string[]).includes(v)
  );
}
function isCompactionSummaryMode(v: unknown): v is "default" | "append" {
  return (
    typeof v === "string" &&
    (COMPACTION_SUMMARY_MODE_VALUES as readonly string[]).includes(v)
  );
}
function isTailBehavior(v: unknown): v is "pi-default" | "minimal" {
  return (
    typeof v === "string" &&
    (TAIL_BEHAVIOR_VALUES as readonly string[]).includes(v)
  );
}
function isMidRunCompaction(v: unknown): v is "resume" | "pause" | "off" {
  return (
    typeof v === "string" &&
    (MID_RUN_COMPACTION_VALUES as readonly string[]).includes(v)
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function isThinkingLevel(v: unknown): v is ModelThinkingLevel {
  return typeof v === "string" && THINKING_LEVELS.includes(v);
}

function positiveInt(v: unknown): number | undefined {
  return Number.isInteger(v) && typeof v === "number" && v > 0 ? v : undefined;
}

/** Like positiveInt but allows 0. Used for cooldownHours where 0 means "disabled". */
function nonNegativeInt(v: unknown): number | undefined {
  return Number.isInteger(v) && typeof v === "number" && v >= 0 ? v : undefined;
}

function parseModel(v: unknown): OmModelConfig | undefined {
  if (!isRecord(v)) return undefined;
  const provider = nonEmptyString(v.provider);
  const id = nonEmptyString(v.id);
  if (!provider || !id) return undefined;
  const model: OmModelConfig = { provider, id };
  if (isThinkingLevel(v.thinking)) model.thinking = v.thinking;
  const cooldown = nonNegativeInt(v.cooldownHours);
  if (cooldown !== undefined) model.cooldownHours = cooldown;
  const ctxWindow = positiveInt(v.contextWindow);
  if (ctxWindow !== undefined) model.contextWindow = ctxWindow;
  return model;
}

function parseModelArray(v: unknown): OmModelConfig[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const parsed = v
    .map(parseModel)
    .filter((m): m is OmModelConfig => m !== undefined);
  return parsed.length > 0 ? parsed : undefined;
}

function parseConfig(raw: Record<string, unknown>): Partial<UnifiedConfig> {
  const c: Partial<UnifiedConfig> = {};

  // String enums — compaction surface
  if (isCompaction(raw.compaction)) c.compaction = raw.compaction;
  if (isCompactionEngine(raw.compactionEngine))
    c.compactionEngine = raw.compactionEngine;
  if (isCompactionSummaryMode(raw.compactionSummaryMode))
    c.compactionSummaryMode = raw.compactionSummaryMode;
  if (isTailBehavior(raw.tailBehavior)) c.tailBehavior = raw.tailBehavior;
  if (isMidRunCompaction(raw.midRunCompaction))
    c.midRunCompaction = raw.midRunCompaction;

  // Provider-aware skip list (entries: provider or "provider:api")
  if (Array.isArray(raw.skipForProviders)) {
    const list = raw.skipForProviders
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    if (list.length > 0) c.skipForProviders = list;
  }

  // Booleans — pi-vcc
  if (typeof raw.overrideDefaultCompaction === "boolean")
    c.overrideDefaultCompaction = raw.overrideDefaultCompaction;
  if (typeof raw.debug === "boolean") c.debug = raw.debug;

  // Booleans — om
  if (typeof raw.sessionFallback === "boolean")
    c.sessionFallback = raw.sessionFallback;
  if (typeof raw.noAutoCompact === "boolean")
    c.noAutoCompact = raw.noAutoCompact;
  if (typeof raw.passive === "boolean") c.passive = raw.passive;
  if (typeof raw.memory === "boolean") c.memory = raw.memory;
  if (typeof raw.fullFoldAlways === "boolean")
    c.fullFoldAlways = raw.fullFoldAlways;
  if (typeof raw.debugLog === "boolean") c.debugLog = raw.debugLog;

  // Numeric fields — use nonNegativeInt for observerPreambleMaxTokens (0 = auto)
  const numKeys = [
    "observeAfterTokens",
    "reflectAfterTokens",
    "compactAfterTokens",
    "observationsPoolMaxTokens",
    "observationsPoolTargetTokens",
    "reflectorInputMaxTokens",
    "dropperInputMaxTokens",
    "observerChunkMaxTokens",
    "observerPreambleMaxTokens",
    "agentMaxTurns",
    "providerIdleTimeoutMs",
  ] as const;

  // dropperPressureThreshold: fractional, must be in (0, 1]
  if (
    typeof raw.dropperPressureThreshold === "number" &&
    Number.isFinite(raw.dropperPressureThreshold) &&
    raw.dropperPressureThreshold > 0 &&
    raw.dropperPressureThreshold <= 1
  ) {
    c.dropperPressureThreshold = raw.dropperPressureThreshold;
  }
  // dropperPoolFullnessThreshold: fractional, must be in (0, 1]
  if (
    typeof raw.dropperPoolFullnessThreshold === "number" &&
    Number.isFinite(raw.dropperPoolFullnessThreshold) &&
    raw.dropperPoolFullnessThreshold > 0 &&
    raw.dropperPoolFullnessThreshold <= 1
  ) {
    c.dropperPoolFullnessThreshold = raw.dropperPoolFullnessThreshold;
  }
  for (const k of numKeys) {
    // observerPreambleMaxTokens and providerIdleTimeoutMs accept 0 (disabled/inherit);
    // everything else must be > 0.
    const validator =
      k === "observerPreambleMaxTokens" || k === "providerIdleTimeoutMs"
        ? nonNegativeInt
        : positiveInt;
    const v = validator(raw[k]);
    if (v !== undefined) (c as Record<string, unknown>)[k] = v;
  }

  // Models
  const model = parseModel(raw.model);
  if (model) c.model = model;
  const obsModel = parseModel(raw.observerModel);
  if (obsModel) c.observerModel = obsModel;
  const refModel = parseModel(raw.reflectorModel);
  if (refModel) c.reflectorModel = refModel;
  const dropModel = parseModel(raw.dropperModel);
  if (dropModel) c.dropperModel = dropModel;

  // Fallback model arrays
  const obsFallback = parseModelArray(raw.observerFallbackModels);
  if (obsFallback) c.observerFallbackModels = obsFallback;
  const refFallback = parseModelArray(raw.reflectorFallbackModels);
  if (refFallback) c.reflectorFallbackModels = refFallback;
  const dropFallback = parseModelArray(raw.dropperFallbackModels);
  if (dropFallback) c.dropperFallbackModels = dropFallback;

  return c;
}

// ── Migration ────────────────────────────────────────────────────────────────

/**
 * Migrate legacy config knobs to new unified surface.
 * Operates on the in-memory parsed object each time loadUnifiedConfig() is called;
 * old keys are removed from this copy. Does NOT mutate the on-disk config file.
 * Idempotent — safe to call repeatedly.
 */
function migrateOldKnobs(parsed: Record<string, unknown>): void {
  // Only run if new keys are absent AND old keys are present
  if (
    parsed.compaction !== undefined ||
    parsed.compactionEngine !== undefined
  ) {
    return; // new keys already set — no migration
  }

  // passive → compaction: "off" + memory: false
  if (parsed.passive === true) {
    parsed.compaction = "off";
    parsed.memory = false;
  }
  // noAutoCompact → compaction: "manual"
  else if (parsed.noAutoCompact === true) {
    parsed.compaction = "manual";
  }
  // overrideDefaultCompaction → compactionEngine + tailBehavior
  if (parsed.overrideDefaultCompaction === true) {
    parsed.compactionEngine = "blackhole";
    // Preserve aggressive cut for existing users
    if (parsed.tailBehavior === undefined) {
      parsed.tailBehavior = "minimal";
    }
  } else if (parsed.overrideDefaultCompaction === false) {
    parsed.compactionEngine = "pi-default";
  }

  // Remove old keys so migration runs only once
  delete parsed.passive;
  delete parsed.noAutoCompact;
  delete parsed.overrideDefaultCompaction;
}

// ── Load and save ────────────────────────────────────────────────────────────

function readJson(path: string): {
  data: Record<string, unknown> | null;
  error: string | null;
} {
  if (!existsSync(path)) return { data: null, error: null };
  try {
    return { data: JSON.parse(readFileSync(path, "utf-8")), error: null };
  } catch (e) {
    const msg = `blackhole: config file at ${path} has invalid JSON: ${(e as Error).message}. Using defaults.`;
    console.warn(msg);
    return { data: null, error: msg };
  }
}

/** Optional warning callback invoked when the primary config file has invalid JSON.
 * Receives the warning message string. Used by callers with UI access to surface
 * the error via ctx.ui.notify(message, "warning").
 */
type WarnFn = (message: string) => void;

/**
 * Load unified configuration from ~/.pi/agent/pi-blackhole/pi-blackhole-config.json.
 * Falls back to legacy sources if the unified file doesn't exist.
 */
export function loadUnifiedConfig(cwd: string, onWarn?: WarnFn): UnifiedConfig {
  const path = configPath();
  let raw: Record<string, unknown> | null;
  let primaryError: string | null = null;
  const result = readJson(path);
  raw = result.data;
  primaryError = result.error;
  if (primaryError && onWarn) onWarn(primaryError);

  // Fallback to legacy sources if unified file doesn't exist
  if (!raw) {
    // Try legacy pi-vcc config
    const piVccPath = join(getAgentDir(), "pi-vcc-config.json");
    const piVccResult = readJson(piVccPath);
    const piVccRaw = piVccResult.data;
    if (piVccResult.error && onWarn) onWarn(piVccResult.error);

    // Try legacy om config from settings.json
    const settingsPath = join(getAgentDir(), "settings.json");
    const settingsResult = readJson(settingsPath);
    const settingsRaw = settingsResult.data;
    if (settingsResult.error && onWarn) onWarn(settingsResult.error);
    const omRaw =
      settingsRaw?.["pi-blackhole"] ?? settingsRaw?.["observational-memory"];
    const projectSettingsPath = join(cwd, ".pi", "settings.json");
    const projectResult = readJson(projectSettingsPath);
    const projectRaw = projectResult.data;
    if (projectResult.error && onWarn) onWarn(projectResult.error);
    const projectOmRaw =
      projectRaw?.["pi-blackhole"] ?? projectRaw?.["observational-memory"];

    // Merge legacy sources
    const merged: Record<string, unknown> = {};
    if (piVccRaw && isRecord(piVccRaw)) Object.assign(merged, piVccRaw);
    if (omRaw && isRecord(omRaw)) Object.assign(merged, omRaw);
    if (projectOmRaw && isRecord(projectOmRaw))
      Object.assign(merged, projectOmRaw);
    raw = merged;
  }

  // Project-local override: <cwd>/.pi/pi-blackhole-config.json
  const projectConfigPath = join(cwd, ".pi", CONFIG_FILE);
  const projectResult = readJson(projectConfigPath);
  const projectRaw = projectResult.data;
  if (projectResult.error && onWarn) onWarn(projectResult.error);
  if (projectRaw && isRecord(projectRaw)) {
    raw = { ...raw, ...projectRaw };
  }

  const parsed = parseConfig(raw);

  // ── Migration: old → new knobs ──
  migrateOldKnobs(parsed);

  // Env override — legacy passive env vars
  const envPassive =
    process.env.PI_BLACKHOLE_PASSIVE ??
    process.env.PI_VCC_OM_PASSIVE ??
    process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE;
  if (envPassive !== undefined) {
    const v = envPassive.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(v)) {
      parsed.compaction = "off";
      parsed.memory = false;
    } else if (["0", "false", "no", "off"].includes(v)) {
      // Falsy env override: undo passive migration when config relied on legacy key
      if (raw?.passive === true) {
        delete parsed.compaction;
        delete parsed.memory;
      }
    }
  }

  // Merge defaults then override
  const merged = { ...DEFAULTS, ...parsed };

  // ── Env override — compaction ──
  const envCompaction = process.env.PI_BLACKHOLE_COMPACTION;
  if (envCompaction !== undefined) {
    const trimmed = envCompaction.trim().toLowerCase();
    if (isCompaction(trimmed)) {
      merged.compaction = trimmed as "auto" | "manual" | "off";
    } else {
      console.warn(
        `blackhole: invalid PI_BLACKHOLE_COMPACTION value "${envCompaction}"; ignoring`,
      );
    }
  }

  // ── Env override — compaction engine ──
  const envCompactionEngine = process.env.PI_BLACKHOLE_COMPACTION_ENGINE;
  if (envCompactionEngine !== undefined) {
    const trimmed = envCompactionEngine.trim().toLowerCase();
    if (isCompactionEngine(trimmed)) {
      merged.compactionEngine = trimmed as "blackhole" | "pi-default";
    } else {
      console.warn(
        `blackhole: invalid PI_BLACKHOLE_COMPACTION_ENGINE value "${envCompactionEngine}"; ignoring`,
      );
    }
  }

  // ── Env override — mid-run compaction ──
  const envMidRunCompaction = process.env.PI_BLACKHOLE_MID_RUN_COMPACTION;
  if (envMidRunCompaction !== undefined) {
    const trimmed = envMidRunCompaction.trim().toLowerCase();
    if (isMidRunCompaction(trimmed)) {
      merged.midRunCompaction = trimmed as "resume" | "pause" | "off";
    } else {
      console.warn(
        `blackhole: invalid PI_BLACKHOLE_MID_RUN_COMPACTION value "${envMidRunCompaction}"; ignoring`,
      );
    }
  }

  // ── Declarative PI_BLACKHOLE_* overrides ──
  // Same env map as the ConfigManager modal path, so env overrides apply
  // to the RUNTIME config, not just the modal. Overrides any file value.
  const withEnv = applyEnvOverrides(
    merged,
    DECLARATIVE_ENV_OVERRIDES,
    DEFAULTS as unknown as Record<string, unknown>,
  );

  return withEnv;
}

/**
 * Write settings back to disk. Preserves unknown keys.
 */
export function saveUnifiedConfig(settings: Partial<UnifiedConfig>): boolean {
  try {
    const path = configPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const existingResult = readJson(path);
    const existing = existingResult.data ?? {};
    if (existingResult.error) {
      console.warn("blackhole: overwriting corrupt config file at " + path);
    }
    const next = { ...existing, ...settings };
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write settings back to disk for a specific scope.
 *
 * - global: writes to `<agentDir>/pi-blackhole/pi-blackhole-config.json`
 * - project: writes to `<cwd>/.pi/pi-blackhole-config.json`
 *
 * Preserves unknown keys in the target file.
 */
export function saveUnifiedConfigScoped(
  settings: Partial<UnifiedConfig>,
  scope: "global" | "project",
  cwd: string,
): boolean {
  try {
    const dir =
      scope === "project"
        ? join(cwd, ".pi")
        : join(getAgentDir(), "pi-blackhole");
    const path = join(dir, CONFIG_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const existingResult = readJson(path);
    const existing = existingResult.data ?? {};
    if (existingResult.error) {
      console.warn("blackhole: overwriting corrupt config file at " + path);
    }
    const next = { ...existing, ...settings };
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure ~/.pi/agent/pi-blackhole/pi-blackhole-config.json exists with defaults.
 *
 * Only creates the file if it doesn't exist. Missing keys are filled at read
 * time by loadUnifiedConfig() via { ...DEFAULTS, ...parsed } merge, so there
 * is no need to keep the on-disk file "complete". This avoids a crash on
 * read-only filesystems where the config is managed externally (e.g., Nix).
 */
export function scaffoldConfig(): void {
  try {
    const path = configPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (!existsSync(path)) {
      writeFileSync(path, `${JSON.stringify(DEFAULTS, null, 2)}\n`);
    }
  } catch (e) {
    console.error("blackhole: config scaffold failed", e);
  }
}

// ── Migration detection ───────────────────────────────────────────────────────

/**
 * Check if the on-disk config file still uses legacy keys (needs migration).
 * Returns true when the file exists, has no new keys, but has old keys.
 * Used to prompt users to save their config with the new keys.
 */
export function configFileNeedsMigration(): boolean {
  try {
    const path = configPath();
    if (!existsSync(path)) return false;
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<
      string,
      unknown
    >;
    if (
      raw.compaction !== undefined ||
      raw.compactionEngine !== undefined ||
      raw.tailBehavior !== undefined
    ) {
      return false; // already has new keys
    }
    return (
      raw.passive !== undefined ||
      raw.noAutoCompact !== undefined ||
      raw.overrideDefaultCompaction !== undefined
    );
  } catch {
    return false;
  }
}

/**
 * Check whether the OM pipeline is in manual mode.
 *
 * In manual mode, observations/reflections/dropped are saved to the
 * per-session pending file instead of being appended to the branch.
 * On `/blackhole`, pending entries are flushed to the branch and
 * the pending file is cleared.
 *
 * Handles both the new `compaction: "manual"` key and the legacy
 * `noAutoCompact: true` key for backward compatibility.
 *
 * @param config — The current runtime config (may include legacy noAutoCompact)
 */
export function isManualMode(config: {
  compaction?: string;
  noAutoCompact?: boolean;
}): boolean {
  return config.compaction === "manual" || config.noAutoCompact === true;
}
