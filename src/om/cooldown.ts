/**
 * Model cooldown persistence.
 *
 * When a model returns a retryable error (429, 5xx, timeout),
 * we record a cooldown so it won't be retried for the configured duration.
 * Cooldowns are persisted to `~/.pi/agent/pi-blackhole/pi-blackhole-cooldown.json`.
 */

/**
 * Cooldown persistence for retryable API errors.
 * 
 * Created by pi-vcc-om. Records per-model cooldowns to disk so rate-limited
 * or down models are skipped until their cooldown window expires.
 *
 * Key design:
 * - isCooldownActive reads from disk every call (no in-memory cache needed).
 * - recordCooldown writes to disk synchronously.
 * - Cooldowns survive pi restarts via pi-blackhole/pi-blackhole-cooldown.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { OmModelConfig } from "../core/unified-config.js";

// ── Persistence ─────────────────────────────────────────────────────────────

const CONFIG_DIR = "pi-blackhole";
const COOLDOWN_FILE = "pi-blackhole-cooldown.json";

function cooldownPath(): string {
	return join(getAgentDir(), CONFIG_DIR, COOLDOWN_FILE);
}

export interface CooldownEntry {
	until: string; // ISO 8601 timestamp
	reason: string;
	stage: string; // "observer" | "reflector" | "dropper"
}

type CooldownMap = Record<string, CooldownEntry>;

/** Provider/id key for cooldown lookup. */
export function modelKey(model: OmModelConfig): string {
	return `${model.provider}/${model.id}`;
}

// ── Load / save ─────────────────────────────────────────────────────────────

function readCooldownMap(): CooldownMap {
	const path = cooldownPath();
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return {};
	}
}

function writeCooldownMap(map: CooldownMap): void {
	try {
		const path = cooldownPath();
		const dir = dirname(path);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(path, `${JSON.stringify(map, null, 2)}\n`);
	} catch {
		// Best-effort: cooldowns are advisory. Losing them means a rate-limited
		// model might be retried before its cooldown window expires — slightly
		// more API traffic, no data loss. This also prevents a process crash
		// on read-only filesystems.
	}
}

// ── API ─────────────────────────────────────────────────────────────────────

/**
 * Check whether a model is currently cooled down.
 * Expired entries are cleaned up lazily.
 *
 * When cooldownHours is explicitly 0, cooldown is disabled — always returns false.
 */
export function isCooldownActive(model: OmModelConfig, now: Date = new Date()): boolean {
	return getCooldownEntry(model, now) !== undefined;
}

/**
 * Returns the active cooldown entry for a model, or undefined if not cooled down.
 * Expired entries are cleaned up lazily.
 */
export function getCooldownEntry(model: OmModelConfig, now: Date = new Date()): CooldownEntry | undefined {
	// cooldownHours === 0 means cooldown disabled
	if (model.cooldownHours === 0) return undefined;

	const map = readCooldownMap();
	const key = modelKey(model);
	const entry = map[key];
	if (!entry) return undefined;

	const until = new Date(entry.until);
	if (isNaN(until.getTime())) return undefined;

	if (now >= until) {
		// Expired — clean up
		delete map[key];
		writeCooldownMap(map);
		return undefined;
	}
	return entry;
}

/**
 * Record a cooldown for a model after a retryable error.
 *
 * When cooldownHours is explicitly 0, cooldown is disabled — no-op.
 *
 * @param model   The model that failed.
 * @param reason  Human-readable error reason (e.g. "429 Too Many Requests").
 * @param stage   Which pipeline stage failed ("observer" | "reflector" | "dropper").
 */
export function recordCooldown(model: OmModelConfig, reason: string, stage: string): void {
	// cooldownHours === 0 means cooldown disabled
	if (model.cooldownHours === 0) return;

	const hours = model.cooldownHours ?? 1;
	const until = new Date(Date.now() + hours * 3_600_000).toISOString();
	const map = readCooldownMap();
	map[modelKey(model)] = { until, reason, stage };
	writeCooldownMap(map);
}

/**
 * Expire all cooldowns whose duration has passed.
 * Call on session_start or config reload to clean up.
 */
export function expireCooldowns(): void {
	const map = readCooldownMap();
	const now = new Date();
	let changed = false;
	for (const [key, entry] of Object.entries(map)) {
		const until = new Date(entry.until);
		if (isNaN(until.getTime()) || now >= until) {
			delete map[key];
			changed = true;
		}
	}
	if (changed) writeCooldownMap(map);
}

import { isRetryableError } from "./retryable-error.js";

export { isRetryableError };
