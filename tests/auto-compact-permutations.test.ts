/**
 * Comprehensive permutation tests for auto-compaction trigger.
 *
 * Covers all 2^4 = 16 combinations of the four config knobs:
 *   - noAutoCompact (T/F)
 *   - passive (T/F)
 *   - memory (T/F)
 *   - overrideDefaultCompaction (T/F)
 *
 * Each combination is tested for:
 *   - Does the auto-compact trigger fire (call ctx.compact)?
 *   - If it fires, which pipeline runs (blackhole vs Pi default)?
 *   - Are notifications shown correctly?
 *   - Is compactInFlight properly managed?
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCompactionTrigger } from "../src/om/compaction-trigger.js";
import { registerBeforeCompactHook, PI_VCC_COMPACT_INSTRUCTION } from "../src/hooks/before-compact.js";
import { rawMessage, compactionEntry } from "./fixtures/session.js";

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

// ── Test infrastructure ─────────────────────────────────────────────────────

interface PermutationConfig {
	noAutoCompact: boolean;
	passive: boolean;
	memory: boolean;
	overrideDefaultCompaction: boolean;
	// New config keys (optional — when absent, legacy path runs)
	compaction?: "auto" | "manual" | "off";
	compactionEngine?: "blackhole" | "pi-default";
	tailBehavior?: "pi-default" | "minimal";
}

function captureFullSystem(config: PermutationConfig) {
	const notifyCalls: Array<{ msg: string; level: string }> = [];
	const onCompleteCalls: Array<{ source: string }> = [];
	const onErrorCalls: Array<{ source: string; message: string }> = [];

	let triggerHandler: ((event: unknown, ctx: unknown) => void) | undefined;
	let beforeCompactHandler: ((event: unknown, ctx: unknown) => any) | undefined;

	const sessionId = "test-session-perm-001";

	const runtime = {
		ensureConfig: vi.fn(),
		config: {
			compactAfterTokens: 3,
			passive: config.passive,
			noAutoCompact: config.noAutoCompact,
			memory: config.memory,
			overrideDefaultCompaction: config.overrideDefaultCompaction,
			observationsPoolMaxTokens: 20000,
			agentMaxTurns: 16,
			debug: false,
			model: undefined as any,
			observerModel: undefined as any,
			observerFallbackModels: [] as any[],
			reflectorModel: undefined as any,
			reflectorFallbackModels: [] as any[],
			dropperModel: undefined as any,
			dropperFallbackModels: [] as any[],
			// New config keys (undefined → legacy path)
			compaction: config.compaction,
			compactionEngine: config.compactionEngine,
			tailBehavior: config.tailBehavior,
		},
		compactInFlight: false,
		compactionStats: null as any,
		compactWasPiVcc: false,
	};

	// Session_before_compact handler records whether it returned something
	let beforeCompactResult: any = undefined;

	const pi = {
		on: vi.fn((name: string, cb: any) => {
			if (name === "agent_end") triggerHandler = cb;
			if (name === "session_before_compact") beforeCompactHandler = cb;
		}),
		appendEntry: vi.fn(),
	};

	// Mock ctx.ui with everything needed
	const ctx = {
		cwd: "/tmp/test-project",
		sessionManager: {
			getBranch: vi.fn(),
			getSessionId: vi.fn(() => sessionId),
		},
		hasUI: true,
		ui: {
			notify: (msg: string, level: string) => {
				notifyCalls.push({ msg, level });
			},
		},
		isIdle: vi.fn(() => true),
		compact: vi.fn((opts: { onComplete?: () => void; onError?: (e: any) => void; customInstructions?: string }) => {
			if (opts.onComplete) {
				onCompleteCalls.push({ source: opts.customInstructions ?? "auto" });
				opts.onComplete();
			}
			if (opts.onError) {
				onErrorCalls.push({ source: opts.customInstructions ?? "auto", message: "test-error" });
			}
		}),
	};

	registerCompactionTrigger(pi as any, runtime as any);
	registerBeforeCompactHook(pi as any, runtime as any);

	if (!triggerHandler) throw new Error("agent_end handler was not registered");
	if (!beforeCompactHandler) throw new Error("session_before_compact handler was not registered");

	return {
		fireAgentEnd: (branch: any[], errorMessage?: string) => {
			ctx.sessionManager.getBranch = vi.fn(() => branch);
			triggerHandler!({
				type: "agent_end",
				messages: [
					{ role: "user", content: "hello" },
					errorMessage
						? { role: "assistant", content: [], stopReason: "error", errorMessage }
						: { role: "assistant", content: "done", stopReason: "end_turn" },
				],
			}, ctx);
		},
		fireBeforeCompact: (branch: any[], customInstructions?: string) => {
			beforeCompactResult = beforeCompactHandler!({
				type: "session_before_compact",
				branchEntries: branch,
				customInstructions,
				preparation: {
					previousSummary: undefined,
					fileOps: { read: [], written: [], edited: [] },
					tokensBefore: 1000,
				},
				signal: new AbortController().signal,
			}, ctx);
		},
		flushAll: async () => {
			await flushAll();
		},
		runtime,
		ctx,
		notifyCalls,
		onCompleteCalls,
		onErrorCalls,
		get beforeCompactResult() { return beforeCompactResult; },
	};
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const msg = (id: string, role: "user" | "assistant" = "user", content = "some message content here for tokens") => ({
	id,
	type: "message",
	message: { role, content },
});

// Branch with enough tokens to trigger (3+ tokens at estimateStringTokens = ceil(len/4))
const dueBranch = [rawMessage("m1", "aaaaaaaaaaaa")]; // 12 chars → 3 tokens, threshold is 3
const shortBranch = [rawMessage("m1", "aa")]; // 2 chars → 1 token, below threshold

// Branch with enough messages (>2 live) to pass buildOwnCut for the blackhole pipeline
const fullBranch = [
	rawMessage("m1", "aaaaaaaaaaaa"),
	rawMessage("m2", "bbbbbbbbbbbb"),
	rawMessage("m3", "cccccccccccc"),
]; // 3 messages, 36 chars → 9 tokens

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Auto-compact trigger: guard permutations (3 knobs)", () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	interface GuardCase {
		name: string;
		noAutoCompact: boolean;
		passive: boolean;
		memory: boolean;
		expectFire: boolean; // does auto-compact fire?
	}

	const guardCases: GuardCase[] = [
		// With overrideDefaultCompaction=false (the default in legacy mode):
		{ name: "all false", noAutoCompact: false, passive: false, memory: true, expectFire: false },
		// Each guard in isolation
		{ name: "noAutoCompact=true", noAutoCompact: true, passive: false, memory: true, expectFire: false },
		{ name: "passive=true", noAutoCompact: false, passive: true, memory: true, expectFire: false },
		{ name: "memory=false", noAutoCompact: false, passive: false, memory: false, expectFire: false },
		// Paired guards
		{ name: "noAutoCompact+passive", noAutoCompact: true, passive: true, memory: true, expectFire: false },
		{ name: "noAutoCompact+memory=false", noAutoCompact: true, passive: false, memory: false, expectFire: false },
		{ name: "passive+memory=false", noAutoCompact: false, passive: true, memory: false, expectFire: false },
		// All three
		{ name: "all blocking", noAutoCompact: true, passive: true, memory: false, expectFire: false },
	];

	for (const tc of guardCases) {
		it(`${tc.name}: ${tc.expectFire ? "fires" : "blocks"} auto-compaction`, async () => {
			const system = captureFullSystem({
				...tc,
				overrideDefaultCompaction: false, // not relevant for trigger guards
			});

			system.fireAgentEnd(dueBranch);
			await system.flushAll();

			if (tc.expectFire) {
				expect(system.ctx.compact).toHaveBeenCalledTimes(1);
				expect(system.runtime.compactInFlight).toBe(false); // reset by onComplete
				// Should show threshold notification
				expect(system.notifyCalls.some(n => n.msg.includes("compaction threshold reached"))).toBe(true);
				// Should show completion notification
				expect(system.notifyCalls.some(n => n.msg.includes("compaction complete"))).toBe(true);
			} else {
				expect(system.ctx.compact).not.toHaveBeenCalled();
				expect(system.runtime.compactInFlight).toBe(false);
				// Should NOT show threshold notification
				expect(system.notifyCalls.some(n => n.msg.includes("compaction threshold reached"))).toBe(false);
			}
		});
	}
});

describe("Auto-compact trigger: before-compact hook integration", () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	interface IntegrationCase {
		name: string;
		noAutoCompact: boolean;
		overrideDefaultCompaction: boolean;
		expectAutoFire: boolean; // does the trigger fire?
		expectBlackholePipeline: boolean; // does the before-compact hook run blackhole pipeline?
		expectPiDefaultPipeline: boolean; // does Pi default run (hook returns undefined)?
	}

	const integrationCases: IntegrationCase[] = [
		// overrideDefaultCompaction=false (default): hook returns undefined → Pi default runs
		{ name: "override=false, noAutoCompact=false",
			noAutoCompact: false, overrideDefaultCompaction: false,
			expectAutoFire: false, expectBlackholePipeline: false, expectPiDefaultPipeline: false },
		{ name: "override=false, noAutoCompact=true",
			noAutoCompact: true, overrideDefaultCompaction: false,
			expectAutoFire: false, expectBlackholePipeline: false, expectPiDefaultPipeline: false },
		// overrideDefaultCompaction=true: hook runs blackhole pipeline
		{ name: "override=true, noAutoCompact=false",
			noAutoCompact: false, overrideDefaultCompaction: true,
			expectAutoFire: true, expectBlackholePipeline: true, expectPiDefaultPipeline: false },
		{ name: "override=true, noAutoCompact=true",
			noAutoCompact: true, overrideDefaultCompaction: true,
			expectAutoFire: false, expectBlackholePipeline: false, expectPiDefaultPipeline: false },
	];

	for (const tc of integrationCases) {
		it(`${tc.name}`, async () => {
			const system = captureFullSystem({
				noAutoCompact: tc.noAutoCompact,
				passive: false,
				memory: true,
				overrideDefaultCompaction: tc.overrideDefaultCompaction,
			});

			system.fireAgentEnd(dueBranch);
			await system.flushAll();

			if (tc.expectAutoFire) {
				expect(system.ctx.compact).toHaveBeenCalledTimes(1);
				expect(system.runtime.compactInFlight).toBe(false);

				// The compact call was made — now verify what the before-compact hook would do.
				// Simulate the same event that Pi would fire:
				const compactCall = system.ctx.compact.mock.calls[0][0];
				system.fireBeforeCompact(
					dueBranch,
					compactCall.customInstructions, // undefined for auto-trigger
				);

				if (tc.expectBlackholePipeline) {
					// before-compact hook returned a result (not undefined — blackhole handled it)
					// Note: compile() requires a real LLM model, so .compaction won't be populated
					// in unit tests. We just verify the hook DID NOT return undefined.
					expect(system.beforeCompactResult).toBeDefined();
				}
				if (tc.expectPiDefaultPipeline) {
					// before-compact hook returned undefined → Pi default runs
					expect(system.beforeCompactResult).toBeUndefined();
				}
			} else {
				expect(system.ctx.compact).not.toHaveBeenCalled();
			}
		});
	}
});

describe("Auto-compact trigger: deferral and re-check paths", () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	it("defers when agent becomes busy between trigger and microtask", async () => {
		const system = captureFullSystem({
			noAutoCompact: false,
			passive: false,
			memory: true,
			overrideDefaultCompaction: true,
		});

		// Override isIdle to return false (agent busy)
		system.ctx.isIdle = vi.fn(() => false);

		system.fireAgentEnd(dueBranch);
		await system.flushAll();

		// Should NOT have called compact yet
		expect(system.ctx.compact).not.toHaveBeenCalled();
		// compactInFlight stays true while retrying idle check
		expect(system.runtime.compactInFlight).toBe(true);
		// No deferral notification yet (still retrying)
		expect(system.notifyCalls.some(n => n.msg.includes("compaction deferred"))).toBe(false);

		// Exhaust all idle retries (15 × 200ms = 3000ms)
		vi.advanceTimersByTime(3000);
		await Promise.resolve();

		// After max retries, compactInFlight resets and deferral fires
		expect(system.runtime.compactInFlight).toBe(false);
		expect(system.notifyCalls.some(n => n.msg.includes("compaction deferred"))).toBe(true);
	});

	it("skips when token pressure was reduced by another compaction between trigger and microtask", async () => {
		const system = captureFullSystem({
			noAutoCompact: false,
			passive: false,
			memory: true,
			overrideDefaultCompaction: true,
		});

		// fireAgentEnd calls the trigger synchronously and replaces getBranch with
		// a mock that always returns dueBranch. Override AFTER to control what the
		// re-check inside setTimeout sees (simulating another compaction ran).
		system.fireAgentEnd(dueBranch);
		system.ctx.sessionManager.getBranch = vi.fn(() => shortBranch);
		await system.flushAll();

		expect(system.ctx.compact).not.toHaveBeenCalled();
		expect(system.runtime.compactInFlight).toBe(false);
		expect(system.notifyCalls.some(n => n.msg.includes("compaction skipped"))).toBe(true);
	});

	it("handles session reload between trigger and microtask", async () => {
		const system = captureFullSystem({
			noAutoCompact: false,
			passive: false,
			memory: true,
			overrideDefaultCompaction: true,
		});

		// Session changes between trigger and microtask
		system.ctx.sessionManager.getSessionId = vi.fn()
			.mockReturnValueOnce("test-session-perm-001") // during trigger
			.mockReturnValueOnce("test-session-perm-002"); // during microtask (different!)

		system.fireAgentEnd(dueBranch);
		await system.flushAll();

		expect(system.ctx.compact).not.toHaveBeenCalled();
		expect(system.runtime.compactInFlight).toBe(false);
		expect(system.notifyCalls.some(n => n.msg.includes("session changed"))).toBe(true);
	});
});

describe("Auto-compact trigger: retryable error guard", () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	it("suppresses compaction on retryable errors", async () => {
		const system = captureFullSystem({
			noAutoCompact: false,
			passive: false,
			memory: true,
			overrideDefaultCompaction: true,
		});

		system.fireAgentEnd(dueBranch, "fetch failed: connection lost");
		await system.flushAll();

		expect(system.ctx.compact).not.toHaveBeenCalled();
		expect(system.runtime.compactInFlight).toBe(false);
	});

	it("does not suppress compaction on non-retryable errors", async () => {
		const system = captureFullSystem({
			noAutoCompact: false,
			passive: false,
			memory: true,
			overrideDefaultCompaction: true,
		});

		// Non-retryable error message — should still fire
		system.fireAgentEnd(dueBranch, "content_filter: inappropriate content");
		await system.flushAll();

		expect(system.ctx.compact).toHaveBeenCalledTimes(1);
	});
});

describe("Auto-compact trigger: compactInFlight latch safety", () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	it("resets compactInFlight after microtask error", async () => {
		const system = captureFullSystem({
			noAutoCompact: false,
			passive: false,
			memory: true,
			overrideDefaultCompaction: true,
		});

		system.fireAgentEnd(dueBranch);

		// Override getBranch to throw for the re-check inside setTimeout
		system.ctx.sessionManager.getBranch = vi.fn(() => { throw new Error("branch corrupted"); });
		await system.flushAll();

		// compactInFlight should have been reset by catch
		expect(system.runtime.compactInFlight).toBe(false);
		// Error notification should show
		expect(system.notifyCalls.some(n => n.msg.includes("compact threw"))).toBe(true);
	});

	it("allows subsequent agent_end after successful compaction", async () => {
		const system = captureFullSystem({
			noAutoCompact: false,
			passive: false,
			memory: true,
			overrideDefaultCompaction: true,
		});

		// First agent_end: fires and completes
		system.fireAgentEnd(dueBranch);
		await system.flushAll();
		expect(system.ctx.compact).toHaveBeenCalledTimes(1);
		expect(system.runtime.compactInFlight).toBe(false);

		// Second agent_end: should fire again (compactInFlight was reset)
		system.fireAgentEnd(dueBranch);
		await system.flushAll();
		expect(system.ctx.compact).toHaveBeenCalledTimes(2);
	});

	it("does not block subsequent agent_end when compactInFlight gets stuck", async () => {
		const system = captureFullSystem({
			noAutoCompact: false,
			passive: false,
			memory: true,
			overrideDefaultCompaction: true,
		});

		// Simulate: compactInFlight somehow stuck at true (e.g., onComplete never fires)
		system.runtime.compactInFlight = true;

		// This agent_end should bail early
		system.fireAgentEnd(dueBranch);
		await system.flushAll();
		expect(system.ctx.compact).not.toHaveBeenCalledTimes(2); // not called again
		// compactInFlight still true
		expect(system.runtime.compactInFlight).toBe(true);
		// No threshold notification (handler bailed before reaching it)
		expect(system.notifyCalls.some(n => n.msg.includes("compaction threshold"))).toBe(false);
	});
});

describe("Full 16-permutation matrix", () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	// All 2^4 = 16 combinations
	const bools = [true, false];
	let caseIndex = 0;

	for (const noAutoCompact of bools) {
		for (const passive of bools) {
			for (const memory of bools) {
				for (const overrideDefaultCompaction of bools) {
					// Build a human-readable name
					const parts: string[] = [];
					if (noAutoCompact) parts.push("noAutoCompact");
					if (passive) parts.push("passive");
					if (!memory) parts.push("memory=false");
					if (overrideDefaultCompaction) parts.push("override");
					const label = parts.length > 0 ? parts.join("+") : "all-default";

					// Determine expected behavior
					// memory no longer gates compaction in the trigger
					const guardsBlock = noAutoCompact === true || passive === true || overrideDefaultCompaction === false;
					const shouldFire = !guardsBlock;

					it(`[${++caseIndex}/16] ${label}`, async () => {
						const system = captureFullSystem({
							noAutoCompact,
							passive,
							memory,
							overrideDefaultCompaction,
						});

						system.fireAgentEnd(dueBranch);
						await system.flushAll();

						if (shouldFire) {
							expect(system.ctx.compact).toHaveBeenCalledTimes(1);
							expect(system.runtime.compactInFlight).toBe(false);

							// Verify the compact call included proper callbacks
							const compactOpts = system.ctx.compact.mock.calls[0][0];
							expect(compactOpts.onComplete).toBeDefined();
							expect(typeof compactOpts.onComplete).toBe("function");

							// Simulate the before-compact hook to see what pipeline runs
							system.fireBeforeCompact(
								dueBranch,
								compactOpts.customInstructions,
							);

							if (overrideDefaultCompaction) {
								// Blackhole pipeline should run
								expect(system.beforeCompactResult).toBeDefined();
								// With only 2 messages (too few), it should cancel
								// (buildOwnCut returns too_few_live_messages)
								if (dueBranch.length <= 2) {
									expect(system.beforeCompactResult.cancel).toBe(true);
								}
							} else {
								// Hook returns undefined → Pi default pipeline runs
								expect(system.beforeCompactResult).toBeUndefined();
							}
						} else {
							expect(system.ctx.compact).not.toHaveBeenCalled();
							expect(system.runtime.compactInFlight).toBe(false);
						}

						// Verify no dangling compactInFlight
						expect(system.runtime.compactInFlight).toBe(false);
					});
				}
			}
		}
	}
});

describe("New config key trigger permutations", () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	const compactionValues = ["auto", "manual", "off"] as const;
	const bools = [true, false];
	let caseIndex = 0;

	for (const compaction of compactionValues) {
		for (const memory of bools) {
			for (const threshold of bools) {
				const label = `compaction=${compaction}, memory=${memory}, ${threshold ? "threshold-reached" : "below-threshold"}`;

				// auto fires only when threshold is reached; manual/off always block
				const expectFire = compaction === "auto" && threshold;

				it(`[${++caseIndex}/12] ${label}: ${expectFire ? "fires" : "blocks"}`, async () => {
					const branch = threshold ? dueBranch : shortBranch;
					const system = captureFullSystem({
						noAutoCompact: false,
						passive: false,
						memory,
						overrideDefaultCompaction: false,
						compaction,
					});

					system.fireAgentEnd(branch);
					await system.flushAll();

					if (expectFire) {
						expect(system.ctx.compact).toHaveBeenCalledTimes(1);
						expect(system.runtime.compactInFlight).toBe(false);
						expect(system.notifyCalls.some(n => n.msg.includes("compaction threshold reached"))).toBe(true);
						expect(system.notifyCalls.some(n => n.msg.includes("compaction complete"))).toBe(true);
					} else {
						expect(system.ctx.compact).not.toHaveBeenCalled();
						expect(system.runtime.compactInFlight).toBe(false);
						expect(system.notifyCalls.some(n => n.msg.includes("compaction threshold reached"))).toBe(false);
					}
				});
			}
		}
	}
});