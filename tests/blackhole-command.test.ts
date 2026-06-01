/**
 * Tests for /blackhole command — compaction trigger, om-off/om-on, noAutoCompact flush.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testRoot = join(tmpdir(), `pi-blackhole-cmd-test-${process.pid}-${Date.now()}`);

// Mock the pi SDK before importing our module
vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => join(testRoot, "agent"),
}));

import { registerPiVccCommand } from "../src/commands/pi-vcc.js";

function createMockEnvironment() {
	const compactCalls: Array<{ customInstructions: string; onComplete: () => void; onError: (err: Error) => void }> = [];
	const appendEntryCalls: Array<{ customType: string; data: unknown }> = [];
	const notifyCalls: Array<{ msg: string; level: string }> = [];

	const pi = {
		registerCommand: vi.fn((name: string, def: { handler: (args: unknown, ctx: unknown) => Promise<void> }) => {
			handlerMap.set(name, def.handler as any);
		}),
		appendEntry: vi.fn((customType: string, data: unknown) => {
			appendEntryCalls.push({ customType, data });
		}),
	};

	const handlerMap = new Map<string, (args: unknown, ctx: unknown) => Promise<void>>();

	const runtime: any = {
		ensureConfig: vi.fn(),
		config: {
			memory: true,
			noAutoCompact: false,
		},
		compactionStats: null,
	};

	function makeHandlerArgs(overrides: Record<string, unknown> = {}) {
		const base = {
			cwd: testRoot,
			sessionManager: {
				getBranch: vi.fn(() => []),
				getSessionId: vi.fn(() => "test-session"),
			},
			compact: vi.fn((opts: { customInstructions?: string; onComplete?: () => void; onError?: (err: Error) => void }) => {
				compactCalls.push({
					customInstructions: opts.customInstructions ?? "",
					onComplete: opts.onComplete ?? (() => {}),
					onError: opts.onError ?? (() => {}),
				});
			}),
			ui: {
				notify: vi.fn((msg: string, level: string) => {
					notifyCalls.push({ msg, level });
				}),
			},
			...overrides,
		};
		return base as any;
	}

	return { pi, runtime, handlerMap, makeHandlerArgs, compactCalls, appendEntryCalls, notifyCalls };
}

describe("/blackhole command", () => {
	beforeEach(() => {
		mkdirSync(join(testRoot, "agent", "pi-blackhole"), { recursive: true });
	});

	afterEach(() => {
		rmSync(testRoot, { recursive: true, force: true });
	});

	it("registers the blackhole command", () => {
		const { pi, runtime } = createMockEnvironment();
		registerPiVccCommand(pi as any, runtime as any);
		expect(pi.registerCommand).toHaveBeenCalledWith("blackhole", expect.objectContaining({
			description: expect.stringContaining("Compact"),
		}));
	});

	it("calls ctx.compact with PI_VCC_COMPACT_INSTRUCTION", async () => {
		const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
		registerPiVccCommand(pi as any, runtime as any);

		const ctx = makeHandlerArgs();
		await handlerMap.get("blackhole")!("", ctx);

		expect(ctx.compact).toHaveBeenCalledTimes(1);
		const call = ctx.compact.mock.calls[0][0];
		expect(call.customInstructions).toBe("__pi_vcc__");
	});

	it("sends onComplete notification with stats when available", async () => {
		const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
		runtime.compactionStats = { summarized: 42, kept: 10, keptTokensEst: 5000 };
		registerPiVccCommand(pi as any, runtime as any);

		const ctx = makeHandlerArgs();
		await handlerMap.get("blackhole")!("", ctx);

		const call = ctx.compact.mock.calls[0][0];
		call.onComplete();

		expect(notifyCalls[notifyCalls.length - 1].msg).toContain("42 source entries");
		expect(notifyCalls[notifyCalls.length - 1].msg).toContain("5.0k tok");
	});

	it("sends onComplete fallback notification without stats", async () => {
		const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
		registerPiVccCommand(pi as any, runtime as any);

		const ctx = makeHandlerArgs();
		await handlerMap.get("blackhole")!("", ctx);

		const call = ctx.compact.mock.calls[0][0];
		call.onComplete();

		expect(notifyCalls[notifyCalls.length - 1].msg).toContain("Compacted with blackhole");
	});

	it("handles onError for cancellation", async () => {
		const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
		registerPiVccCommand(pi as any, runtime as any);

		const ctx = makeHandlerArgs();
		await handlerMap.get("blackhole")!("", ctx);

		const call = ctx.compact.mock.calls[0][0];
		call.onError(new Error("Compaction cancelled"));

		expect(notifyCalls[notifyCalls.length - 1].level).toBe("warning");
		expect(notifyCalls[notifyCalls.length - 1].msg).toContain("Nothing to compact");
	});

	it("handles onError for general failure", async () => {
		const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
		registerPiVccCommand(pi as any, runtime as any);

		const ctx = makeHandlerArgs();
		await handlerMap.get("blackhole")!("", ctx);

		const call = ctx.compact.mock.calls[0][0];
		call.onError(new Error("Model API error"));

		expect(notifyCalls[notifyCalls.length - 1].level).toBe("error");
		expect(notifyCalls[notifyCalls.length - 1].msg).toContain("Compaction failed: Model API error");
	});

	it("/blackhole om-off disables memory and saves config", async () => {
		const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
		registerPiVccCommand(pi as any, runtime as any);
		runtime.config.memory = true;

		const ctx = makeHandlerArgs();
		await handlerMap.get("blackhole")!("om-off", ctx);

		expect(runtime.config.memory).toBe(false);
		expect(notifyCalls[0].msg).toContain("Observational memory disabled");
	});

	it("/blackhole om-on enables memory and saves config", async () => {
		const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
		registerPiVccCommand(pi as any, runtime as any);
		runtime.config.memory = false;

		const ctx = makeHandlerArgs();
		await handlerMap.get("blackhole")!("om-on", ctx);

		expect(runtime.config.memory).toBe(true);
		expect(notifyCalls[0].msg).toContain("Observational memory enabled");
	});

	it("flush pending entries when noAutoCompact is active and pending data exists", async () => {
		const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
		runtime.config.compaction = "manual";
		registerPiVccCommand(pi as any, runtime as any);

		// Write a pending state file — name pattern is <sessionId>-pending.json
		const pendingDir = join(testRoot, "agent", "pi-blackhole");
		const pendingFile = join(pendingDir, "test-session-pending.json");
		writeFileSync(pendingFile, JSON.stringify({
			// isPendingOMState checks for .observation/.reflection with coversUpToId
			observation: { coversUpToId: "raw-1", data: { observations: [{ id: "aaaaaaaaaaaa", content: "test obs" }] } },
			reflection: { coversUpToId: "raw-1", data: { reflections: [{ id: "eeeeeeeeeeee", content: "test ref", supportingObservationIds: ["aaaaaaaaaaaa"] }] } },
			observationBatches: [{
				data: { observations: [{ id: "aaaaaaaaaaaa", content: "test obs" }], coversUpToId: "raw-1" },
			}],
			reflectionBatches: [{
				data: { reflections: [{ id: "eeeeeeeeeeee", content: "test ref", supportingObservationIds: ["aaaaaaaaaaaa"] }], coversUpToId: "raw-1" },
			}],
		}));

		const ctx = makeHandlerArgs();
		await handlerMap.get("blackhole")!("", ctx);

		expect(notifyCalls[0].msg).toContain("pending entries flushed");
		expect(existsSync(pendingFile)).toBe(false); // cleared after flush
		// Should call compact after flush
		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});
});
