/**
 * Debug logging — writes JSONL to ~/.pi/agent/pi-blackhole/debug.ndjson.
 *
 * Uses a memory buffer flushed asynchronously on a timer to avoid blocking
 * the event loop with synchronous disk I/O on every event.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (src/debug-log.ts)
 * Modified: path changed from observational-memory/ to pi-blackhole/; async buffered.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, appendFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const DEBUG_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEBUG_LOG_RELATIVE_PATH = join("pi-blackhole", "debug.ndjson");

interface DebugLogContext {
	enabled: boolean;
	cwd?: string;
	runId?: string;
}

const storage = new AsyncLocalStorage<DebugLogContext>();

export function withDebugLogContext<T>(context: DebugLogContext, fn: () => T): T {
	const parent = storage.getStore();
	return storage.run({ ...parent, ...context }, fn);
}

// ── Async buffer ────────────────────────────────────────────────────────────

const BUFFER_FLUSH_MS = 1_000;
let buffer: string[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushScheduled = false;
let flushing = false;

function ensureFlushTimer(): void {
	if (flushTimer) return;
	flushTimer = setInterval(() => {
		flushBuffer();
	}, BUFFER_FLUSH_MS);
	// Don't prevent process exit
	if (flushTimer && typeof flushTimer === "object" && "unref" in flushTimer) {
		flushTimer.unref();
	}
}

async function flushBuffer(): Promise<void> {
	if (flushing) return;
	if (buffer.length === 0) return;
	flushing = true;
	// Drain the buffer atomically so flushDebugLog doesn't split entries
	const batch = buffer;
	buffer = [];
	try {
		const path = join(getAgentDir(), DEBUG_LOG_RELATIVE_PATH);
		mkdirSync(dirname(path), { recursive: true });
		rotateIfNeeded(path);
		await appendFile(path, batch.join(""), "utf-8");
	} catch (error) {
		console.error("blackhole: debug log write failed", error);
	}
	flushing = false;
}

// Flush remaining buffer on exit
process.on("beforeExit", () => {
	if (buffer.length > 0) {
		flushBuffer().catch(() => {});
	}
});

export function debugLog(event: string, data: Record<string, unknown> = {}, forceEnabled?: boolean): void {
	const context = storage.getStore();
	const enabled = forceEnabled ?? context?.enabled ?? false;
	if (enabled !== true) return;

	const payload = {
		ts: new Date().toISOString(),
		event,
		cwd: context?.cwd,
		runId: context?.runId,
		data,
	};
	buffer.push(JSON.stringify(payload) + "\n");
	ensureFlushTimer();
}

/**
 * Synchronously flush the buffer to disk. Used by tests to verify written content.
 * Skips if an async flush is in progress to avoid splitting the buffer.
 * In production, the background timer handles flushing automatically.
 */
export function flushDebugLog(): void {
	if (flushing || buffer.length === 0) return;
	const batch = buffer;
	buffer = [];
	try {
		const path = join(getAgentDir(), DEBUG_LOG_RELATIVE_PATH);
		mkdirSync(dirname(path), { recursive: true });
		rotateIfNeeded(path);
		appendFileSync(path, batch.join(""), "utf-8");
	} catch (error) {
		console.error("blackhole: debug log flush failed", error);
	}
}

function rotateIfNeeded(path: string): void {
	if (!existsSync(path)) return;
	if (statSync(path).size < DEBUG_LOG_MAX_BYTES) return;
	const backupPath = `${path}.1`;
	if (existsSync(backupPath)) unlinkSync(backupPath);
	renameSync(path, backupPath);
}
