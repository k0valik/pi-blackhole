/**
 * Tests for blackhole's debug-log (single-file rotation approach).
 *
 * Upstream pi-observational-memory uses per-session debug files; ours is a
 * single ndjson file at ~/.pi/agent/pi-blackhole/debug.ndjson with rotation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync, renameSync, appendFileSync } from "node:fs";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testRoot = join(tmpdir(), `pi-blackhole-debug-test-${process.pid}-${Date.now()}`);
const agentDir = join(testRoot, "agent");

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => agentDir,
}));

import {
	DEBUG_LOG_MAX_BYTES,
	DEBUG_LOG_RELATIVE_PATH,
	debugLog,
	withDebugLogContext,
} from "../src/om/debug-log.js";

describe("debug-log", () => {
	beforeEach(() => {
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testRoot, { recursive: true, force: true });
	});

	function readLog(): any[] {
		const logPath = join(agentDir, DEBUG_LOG_RELATIVE_PATH);
		if (!existsSync(logPath)) return [];
		return readFileSync(logPath, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	}

	it("does not write when context is not enabled", () => {
		debugLog("test.event", { key: "value" });
		expect(readLog()).toEqual([]);
	});

	it("writes enabled events with context metadata", () => {
		withDebugLogContext({ enabled: true, cwd: "/tmp/project", runId: "run-1" }, () => {
			debugLog("test.event", { reason: "something" });
		});

		const entries = readLog();
		expect(entries).toHaveLength(1);
		expect(entries[0].event).toBe("test.event");
		expect(entries[0].cwd).toBe("/tmp/project");
		expect(entries[0].runId).toBe("run-1");
		expect(entries[0].data).toEqual({ reason: "something" });
		expect(entries[0]).toHaveProperty("ts");
	});

	it("appends multiple events to the same file", () => {
		withDebugLogContext({ enabled: true, sessionId: "session-1" }, () => {
			debugLog("obs.start");
			debugLog("ref.start");
		});

		const entries = readLog();
		expect(entries).toHaveLength(2);
		expect(entries[0].event).toBe("obs.start");
		expect(entries[1].event).toBe("ref.start");
	});

	it("uses different log entries for different contexts (inherits parent)", () => {
		withDebugLogContext({ enabled: true, runId: "parent" }, () => {
			debugLog("outer");
			withDebugLogContext({ runId: "child" }, () => {
				debugLog("inner");
			});
		});

		const entries = readLog();
		expect(entries).toHaveLength(2);
		expect(entries[0].runId).toBe("parent");
		// inner context inherits parent's enabled flag and merges runId
		expect(entries[1].runId).toBe("child");
	});

	it("writes to debug.ndjson path", () => {
		withDebugLogContext({ enabled: true }, () => {
			debugLog("check.path");
		});
		expect(existsSync(join(agentDir, "pi-blackhole", "debug.ndjson"))).toBe(true);
	});

	it("never throws on write failure", () => {
		const spy = vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
			throw new Error("Write failure");
		});
		expect(() => {
			withDebugLogContext({ enabled: true }, () => {
				debugLog("test.event");
			});
		}).not.toThrow();
		spy.mockRestore();
	});

	it("exports known constants", () => {
		expect(DEBUG_LOG_MAX_BYTES).toBe(10 * 1024 * 1024);
		expect(DEBUG_LOG_RELATIVE_PATH).toBe(join("pi-blackhole", "debug.ndjson"));
	});
});
