/**
 * Unified configuration loader — merges pi-vcc + OM settings into one file.
 *
 * Created by pi-vcc-om.
 * Reads ~/.pi/agent/pi-blackhole/pi-blackhole-config.json with legacy fallback support.
 * Model configs support cooldownHours and fallbackModel arrays.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

// ── Config path ──────────────────────────────────────────────────────────────

const CONFIG_DIR = "pi-blackhole";
const CONFIG_FILE = "pi-blackhole-config.json";

function configPath(): string {
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
}

export interface UnifiedConfig {
	/** When true, pi-vcc handles all compactions (not just /pi-vcc). */
	overrideDefaultCompaction: boolean;
	/** Write debug snapshots to /tmp/pi-blackhole-debug.json. */
	debug: boolean;

	/** Token threshold for observer runs. */
	observeAfterTokens: number;
	/** Token threshold for reflector and dropper. */
	reflectAfterTokens: number;
	/** Token threshold for proactive auto-compaction. */
	compactAfterTokens: number;
	/** Observation pool token pressure for full fold. */
	observationsPoolMaxTokens: number;
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
	/** Max source entries tokens sent to observer per chunk. */
	observerChunkMaxTokens: number;
	/** Max preamble tokens (CURRENT REFLECTIONS / OBSERVATIONS) in the observer prompt.
	 *  Default 0 means auto-compute from observerChunkMaxTokens (30%). Only applied in
	 *  noAutoCompact mode where accumulated batch history can grow unbounded.
	 *  Set to an explicit value to override the auto-computed budget. */
	observerPreambleMaxTokens: number;
	/** Shared turn cap for background memory agents. */
	agentMaxTurns: number;

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

	/** When true, observations/reflections are saved to pending.json
	 *  instead of appended to the conversation. Auto-compaction is
	 *  disabled.  User triggers /blackhole to flush and compact. */
	noAutoCompact: boolean;
	/** Disables background workers and auto-compaction entirely. */
	passive: boolean;
	/** Enables observational memory (workers + content injection). Set to false for pi-vcc only. */
	memory: boolean;
	/** Writes debug JSONL to agent directory. */
	debugLog: boolean;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULTS: UnifiedConfig = {
	overrideDefaultCompaction: false,
	debug: false,

	observeAfterTokens: 15_000,
	reflectAfterTokens: 25_000,
	compactAfterTokens: 81_000,
	observationsPoolMaxTokens: 20_000,
	observationsPoolTargetTokens: 10_000,
	reflectorInputMaxTokens: 80_000,
	dropperInputMaxTokens: 80_000,
	observerChunkMaxTokens: 40_000,
	observerPreambleMaxTokens: 0,
	agentMaxTurns: 16,

	noAutoCompact: false,
	passive: false,
	memory: true,
	debugLog: false,
};

// ── Parsing helpers ──────────────────────────────────────────────────────────

const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

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

function parseModel(v: unknown): OmModelConfig | undefined {
	if (!isRecord(v)) return undefined;
	const provider = nonEmptyString(v.provider);
	const id = nonEmptyString(v.id);
	if (!provider || !id) return undefined;
	const model: OmModelConfig = { provider, id };
	if (isThinkingLevel(v.thinking)) model.thinking = v.thinking;
	const cooldown = positiveInt(v.cooldownHours);
	if (cooldown !== undefined) model.cooldownHours = cooldown;
	return model;
}

function parseModelArray(v: unknown): OmModelConfig[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const parsed = v.map(parseModel).filter((m): m is OmModelConfig => m !== undefined);
	return parsed.length > 0 ? parsed : undefined;
}

function parseConfig(raw: Record<string, unknown>): Partial<UnifiedConfig> {
	const c: Partial<UnifiedConfig> = {};

	// Booleans — pi-vcc
	if (typeof raw.overrideDefaultCompaction === "boolean") c.overrideDefaultCompaction = raw.overrideDefaultCompaction;
	if (typeof raw.debug === "boolean") c.debug = raw.debug;

	// Booleans — om
	if (typeof raw.noAutoCompact === "boolean") c.noAutoCompact = raw.noAutoCompact;
	if (typeof raw.passive === "boolean") c.passive = raw.passive;
	if (typeof raw.memory === "boolean") c.memory = raw.memory;
	if (typeof raw.debugLog === "boolean") c.debugLog = raw.debugLog;

	// Positive integers
	const numKeys = ["observeAfterTokens", "reflectAfterTokens", "compactAfterTokens", "observationsPoolMaxTokens", "observationsPoolTargetTokens", "reflectorInputMaxTokens", "dropperInputMaxTokens", "observerChunkMaxTokens", "observerPreambleMaxTokens", "agentMaxTurns"] as const;
	for (const k of numKeys) {
		const v = positiveInt(raw[k]);
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

// ── Load and save ────────────────────────────────────────────────────────────

function readJson(path: string): Record<string, unknown> | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

/**
 * Load unified configuration from ~/.pi/agent/pi-blackhole/pi-blackhole-config.json.
 * Falls back to legacy sources if the unified file doesn't exist.
 */
export function loadUnifiedConfig(cwd: string): UnifiedConfig {
	const path = configPath();
	let raw = readJson(path);

	// Fallback to legacy sources if unified file doesn't exist
	if (!raw) {
		// Try legacy pi-vcc config
		const piVccPath = join(getAgentDir(), "pi-vcc-config.json");
		const piVccRaw = readJson(piVccPath);

		// Try legacy om config from settings.json
		const settingsPath = join(getAgentDir(), "settings.json");
		const settingsRaw = readJson(settingsPath);
		const omRaw = settingsRaw?.["pi-blackhole"] ?? settingsRaw?.["observational-memory"];
		const projectSettingsPath = join(cwd, ".pi", "settings.json");
		const projectRaw = readJson(projectSettingsPath);
		const projectOmRaw = projectRaw?.["pi-blackhole"] ?? projectRaw?.["observational-memory"];

		// Merge legacy sources
		const merged: Record<string, unknown> = {};
		if (piVccRaw && isRecord(piVccRaw)) Object.assign(merged, piVccRaw);
		if (omRaw && isRecord(omRaw)) Object.assign(merged, omRaw);
		if (projectOmRaw && isRecord(projectOmRaw)) Object.assign(merged, projectOmRaw);
		raw = merged;
	}

	const parsed = parseConfig(raw);

	// Env override
	const envPassive = process.env.PI_BLACKHOLE_PASSIVE ?? process.env.PI_VCC_OM_PASSIVE ?? process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE;
	if (envPassive !== undefined) {
		const v = envPassive.trim().toLowerCase();
		if (["1", "true", "yes", "on"].includes(v)) parsed.passive = true;
		else if (["0", "false", "no", "off"].includes(v)) parsed.passive = false;
	}

	// Merge defaults then override
	const merged = { ...DEFAULTS, ...parsed };

	// ── Validate all numeric fields ──
	// Prevents NaN/undefined from leaking into runtime math.
	const NUMERIC_KEYS: ReadonlyArray<keyof UnifiedConfig> = [
		"observeAfterTokens", "reflectAfterTokens", "compactAfterTokens",
		"observationsPoolMaxTokens", "observationsPoolTargetTokens",
		"reflectorInputMaxTokens", "dropperInputMaxTokens",
		"observerChunkMaxTokens", "observerPreambleMaxTokens",
		"agentMaxTurns",
	];
	for (const k of NUMERIC_KEYS) {
		const v = (merged as Record<string, unknown>)[k];
		// observerPreambleMaxTokens=0 means "auto-compute from observerChunkMaxTokens (30%)"
		// so 0 is valid for that field. All other numeric fields must be strictly positive.
		const minVal = k === "observerPreambleMaxTokens" ? 0 : 1;
		if (typeof v !== "number" || !Number.isFinite(v) || v < minVal) {
			(merged as Record<string, unknown>)[k] = DEFAULTS[k];
		}
	}

	// Derive observationsPoolTargetTokens if still unset or invalid (must be < max)
	if (
		merged.observationsPoolTargetTokens === undefined ||
		merged.observationsPoolTargetTokens >= merged.observationsPoolMaxTokens
	) {
		merged.observationsPoolTargetTokens = Math.floor(merged.observationsPoolMaxTokens / 2);
	}

	return merged;
}

/**
 * Write settings back to disk. Preserves unknown keys.
 */
export function saveUnifiedConfig(settings: Partial<UnifiedConfig>): boolean {
	try {
		const path = configPath();
		const dir = dirname(path);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const existing = readJson(path) ?? {};
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
