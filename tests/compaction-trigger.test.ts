/**
 * Ported from upstream pi-observational-memory
 * Changes:
 *   - Import path: hooks/compaction-trigger.js → om/compaction-trigger.js
 *   - Adapted for blackhole's queueMicrotask-based deferral (upstream uses setTimeout)
 *   - Added noAutoCompact, memory, ensureConfig to runtime mock
 *   - Added getSessionId to sessionManager mock
 *   - Uses await flushAll() instead of vi.runAllTimersAsync()
 *   - Skipped "does not await observer/reflect promises" test (not applicable)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerCompactionTrigger } from "../src/om/compaction-trigger.js";
import { compactionEntry, textCustomMessage, type TestEntry } from "./fixtures/session.js";

/** Flush microtasks AND fire pending fake timers (setTimeout callbacks).
 * With vi.useFakeTimers(), setTimeout callbacks don't fire automatically.
 * We need to advance timers manually after flushing microtasks. */
async function flushAll(): Promise<void> {
	// Flush microtask queue (Promise callbacks)
	await Promise.resolve();
	// Fire any setTimeout(..., 0) callbacks scheduled by the trigger
	vi.advanceTimersByTime(0);
	// Flush any chained microtasks from those callbacks
	await Promise.resolve();
}

function captureHandler(args: {
	overrideDefaultCompaction?: boolean;
	compactAfterTokens?: number;
	passive?: boolean;
	compactInFlight?: boolean;
	noAutoCompact?: boolean;
	memory?: boolean;
	/** NEW: Unified compaction control */
	compaction?: "auto" | "manual" | "off";
	/** NEW: Which engine handles compaction */
	compactionEngine?: "blackhole" | "pi-default";
} = {}) {
	let endHandler: ((event: unknown, ctx: unknown) => void) | undefined;
	let startHandler: (() => void) | undefined;
	const pi = {
		on: vi.fn((name: string, cb: any) => {
			if (name === "agent_end") endHandler = cb;
			if (name === "agent_start") startHandler = cb;
		}),
	};
	const runtime = {
		ensureConfig: vi.fn(),
		config: {
			overrideDefaultCompaction: args.overrideDefaultCompaction ?? true,
			compactAfterTokens: args.compactAfterTokens ?? 3,
			passive: args.passive ?? false,
			noAutoCompact: args.noAutoCompact ?? false,
			memory: args.memory ?? true,
			/** NEW: Unified compaction control */
			compaction: args.compaction,
			/** NEW: Which engine handles compaction */
			compactionEngine: args.compactionEngine,
			debugLog: true,
		},
		compactInFlight: args.compactInFlight ?? false,
		autoCompactionController: null,
	};
	registerCompactionTrigger(pi as any, runtime as any);
	if (!endHandler) throw new Error("agent_end handler was not registered");
	if (!startHandler) throw new Error("agent_start handler was not registered");
	return { handler: endHandler, startHandler, runtime };
}

function agentEnd(errorMessage?: string) {
	return {
		type: "agent_end",
		messages: [
			{ role: "user", content: "hello" },
			errorMessage
				? { role: "assistant", content: [], stopReason: "error", errorMessage }
				: { role: "assistant", content: "done", stopReason: "end_turn" },
		],
	};
}

function fakeCtx(branches: TestEntry[][], overrides: Record<string, unknown> = {}) {
	let branchIndex = 0;
	const sessionId = "test-session-001";
	const getBranch = vi.fn(() => branches[Math.min(branchIndex++, branches.length - 1)]);
	return {
		cwd: "/tmp/project",
		sessionManager: {
			getBranch,
			getSessionId: vi.fn(() => sessionId),
		},
		hasUI: true,
		ui: { notify: vi.fn() },
		isIdle: vi.fn(() => true),
		compact: vi.fn(),
		...overrides,
	};
}

const dueBranch = [textCustomMessage("raw-1", "aaaaaaaaaaaa")]; // 3 tokens
const belowBranch = [textCustomMessage("raw-1", "aaaa")]; // 1 token

describe("V3 compaction trigger (blackhole)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does nothing below compactAfterTokens", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([belowBranch]);

		handler(agentEnd(), ctx);
		await flushAll();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("calls compact when compactAfterTokens is reached", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		expect(runtime.compactInFlight).toBe(true);
		await flushAll();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction threshold reached (~3 tokens); triggering compaction",
			"info",
		);
	});

	it("compaction:auto + compactionEngine:pi-default skips trigger (pi-default means Pi handles timing too)", async () => {
		const { handler, runtime } = captureHandler({ compaction: "auto", compactionEngine: "pi-default", compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		expect(runtime.compactInFlight).toBe(false);
		await flushAll();

		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("LEGACY-BACKWARD: overrideDefaultCompaction:false with no new keys — legacy guard fires, no trigger", async () => {
		const { handler, runtime } = captureHandler({ overrideDefaultCompaction: false, compaction: undefined, compactionEngine: undefined });
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		await flushAll();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("LEGACY-BACKWARD: passive:true with no new keys — legacy guard fires, no trigger", async () => {
		const { handler, runtime } = captureHandler({ passive: true, compaction: undefined, compactionEngine: undefined });
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		await flushAll();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("skips when compaction is already in flight", async () => {
		const { handler } = captureHandler({ compactInFlight: true });
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		await flushAll();

		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("skips retryable assistant errors", async () => {
		const { handler, runtime } = captureHandler();
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd("fetch failed: connection lost"), ctx);
		await flushAll();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("ignores stale extension ctx during agent_end", async () => {
		const { handler, runtime } = captureHandler();
		const staleCtx = {
			get cwd() {
				throw { message: "This extension ctx is stale after session replacement or reload." };
			},
		};

		expect(() => handler(agentEnd(), staleCtx)).not.toThrow();
		await flushAll();

		expect(runtime.ensureConfig).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
	});

	it("cancels deferred compaction if ctx becomes stale before the timer fires", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		expect(runtime.compactInFlight).toBe(true);
		ctx.sessionManager.getSessionId.mockImplementation(() => {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		});
		await flushAll();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("ignores stale notification errors in async compaction callbacks", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		await flushAll();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
		const compactOptions = ctx.compact.mock.calls[0][0];
		ctx.ui.notify.mockImplementation(() => {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		});

		runtime.compactInFlight = true;
		expect(() => compactOptions.onComplete({})).not.toThrow();
		expect(runtime.compactInFlight).toBe(false);

		runtime.compactInFlight = true;
		expect(() => compactOptions.onError({ message: "test failure" })).not.toThrow();
		expect(runtime.compactInFlight).toBe(false);
	});

	it("defers compaction if context is never idle after max retries", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch], { isIdle: vi.fn(() => false) });

		handler(agentEnd(), ctx);
		await flushAll();
		// Yield to the first setTimeout(..., 0)
		vi.advanceTimersByTime(0);
		await Promise.resolve();

		// Now we are in the retry loop. Exhaust all retries (1500 × 200ms = 300,000ms = 5 minutes)
		for (let i = 0; i < 1500; i++) {
			vi.advanceTimersByTime(200);
			await Promise.resolve();
		}

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction deferred — agent busy; will retry at next agent_end",
			"info",
		);
	});

	it("retries idle check and compacts when agent becomes idle", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const isIdle = vi.fn()
			.mockReturnValueOnce(false)
			.mockReturnValueOnce(false)
			.mockReturnValueOnce(false)
			.mockReturnValue(true);
		const ctx = fakeCtx([dueBranch], { isIdle });

		handler(agentEnd(), ctx);
		expect(runtime.compactInFlight).toBe(true);
		await flushAll();

		// isIdle: false × 3, then true on 4th check (600ms = 3 × 200ms)
		for (let i = 0; i < 4; i++) {
			vi.advanceTimersByTime(200);
			await Promise.resolve();
		}

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("re-checks threshold after deferral and skips if another compaction already reduced pressure", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch, belowBranch]);

		handler(agentEnd(), ctx);
		await flushAll();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction skipped — another compaction already ran before deferred compaction",
			"info",
		);
	});

	it("counts raw tokens since the latest Pi compaction using V3 progress helpers", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = [
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-2" }),
			textCustomMessage("raw-2", "aaaa"),
			textCustomMessage("raw-3", "bbbbbbbb"),
		];
		const ctx = fakeCtx([branch]);

		handler(agentEnd(), ctx);
		await flushAll();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	// ── Phase 7: New config key guards ─────────────────────────────────

	it("T13: compaction:auto calls compact when threshold reached", async () => {
		const { handler } = captureHandler({
			compaction: "auto",
			compactAfterTokens: 3,
		});
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		await flushAll();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("T14: compaction:auto does nothing below threshold", async () => {
		const { handler, runtime } = captureHandler({
			compaction: "auto",
			compactAfterTokens: 3,
		});
		const ctx = fakeCtx([belowBranch]);

		handler(agentEnd(), ctx);
		await flushAll();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("T15: compaction:manual skips threshold check entirely", async () => {
		const { handler, runtime } = captureHandler({
			compaction: "manual",
			compactAfterTokens: 3,
		});
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		await flushAll();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("T16: compaction:off skips threshold check entirely", async () => {
		const { handler, runtime } = captureHandler({
			compaction: "off",
			compactAfterTokens: 3,
		});
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		await flushAll();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("T17: memory:false + compaction:auto still compacts when threshold reached", async () => {
		const { handler, runtime } = captureHandler({
			compaction: "auto",
			memory: false,
			compactAfterTokens: 3,
		});
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		await flushAll();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("T18: compaction:manual with retryable error skips before threshold check", async () => {
		const { handler, runtime } = captureHandler({
			compaction: "manual",
			compactAfterTokens: 3,
		});
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd("fetch failed: connection lost"), ctx);
		await flushAll();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("cancels auto-compaction on agent_start", async () => {
		const { handler, startHandler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch], { isIdle: vi.fn(() => false) });

		handler(agentEnd(), ctx);
		await flushAll();
		expect(runtime.compactInFlight).toBe(true);
		expect(runtime.autoCompactionController).not.toBeNull();

		startHandler();
		expect(runtime.compactInFlight).toBe(false);
		expect(runtime.autoCompactionController).toBeNull();

		vi.advanceTimersByTime(200);
		await Promise.resolve();
		// Should not call isIdle again because it was aborted
		expect(ctx.isIdle).toHaveBeenCalledTimes(1);
	});
});
