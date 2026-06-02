/**
 * Runtime model resolution tests — fallback chain + cooldown.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `pi-blackhole-runtime-test-${Date.now()}`);

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => testDir,
	estimateTokens: () => 250, // ~1 token per 4 chars
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function writeConfig(data: unknown, filename = "pi-blackhole/pi-blackhole-config.json"): string {
	const dir = join(testDir, dirname(filename));
	mkdirSync(dir, { recursive: true });
	const path = join(testDir, filename);
	writeFileSync(path, JSON.stringify(data, null, 2));
	return path;
}

function cooldownFile() { return join(testDir, "pi-blackhole", "pi-blackhole-cooldown.json"); }

function readCooldownFile(): Record<string, unknown> {
	const p = cooldownFile();
	if (!existsSync(p)) return {};
	return JSON.parse(readFileSync(p, "utf-8"));
}

function makeModel(id: string, provider = "openrouter", overrides: Record<string, unknown> = {}) {
	return {
		id, name: id, api: "openai-completions", provider,
		baseUrl: "https://openrouter.ai/api/v1", reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000, maxTokens: 16384,
		...overrides,
	};
}

function makeRegistry(models: ReturnType<typeof makeModel>[]) {
	return {
		models,
		find: vi.fn((p: string, id: string) => models.find((m) => m.provider === p && m.id === id)),
		hasConfiguredAuth: vi.fn(() => true),
		getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "sk-test", headers: undefined })),
	};
}

beforeEach(() => {
	mkdirSync(testDir, { recursive: true });
});
afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
	vi.resetAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Runtime.resolveModel — fallback chain", () => {
	it("resolves primary stage model when available", async () => {
		writeConfig({
			observerModel: { provider: "openrouter", id: "primary-model:free" },
			observerFallbackModels: [{ provider: "openrouter", id: "fallback-model:free" }],
		});
		const { Runtime } = await import("../src/om/runtime.js");
		const runtime = new Runtime();
		runtime.ensureConfig(testDir);

		const registry = makeRegistry([
			makeModel("primary-model:free", "openrouter"),
			makeModel("fallback-model:free", "openrouter"),
		]);

		const result = await runtime.resolveModel({
			model: undefined,
			modelRegistry: registry,
			hasUI: false,
			stageModel: { provider: "openrouter", id: "primary-model:free" },
			stageFallbacks: [{ provider: "openrouter", id: "fallback-model:free" }],
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.model.id).toBe("primary-model:free");
		}
	});

	it("skips primary model when in cooldown, uses fallback", async () => {
		writeConfig({
			observerModel: { provider: "openrouter", id: "primary-model:free", cooldownHours: 24 },
			observerFallbackModels: [{ provider: "openrouter", id: "fallback-model:free", cooldownHours: 2 }],
		});

		// Pre-populate cooldown for primary model
		const { recordCooldown } = await import("../src/om/cooldown.js");
		recordCooldown({ provider: "openrouter", id: "primary-model:free", cooldownHours: 24 }, "429 test", "observer");

		const { Runtime } = await import("../src/om/runtime.js");
		const runtime = new Runtime();
		runtime.ensureConfig(testDir);

		const registry = makeRegistry([
			makeModel("primary-model:free", "openrouter"),
			makeModel("fallback-model:free", "openrouter"),
		]);

		const result = await runtime.resolveModel({
			model: undefined,
			modelRegistry: registry,
			hasUI: false,
			stageModel: { provider: "openrouter", id: "primary-model:free" },
			stageFallbacks: [{ provider: "openrouter", id: "fallback-model:free" }],
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.model.id).toBe("fallback-model:free");
		}
	});

	it("falls through to config.model when all stage models cooled down", async () => {
		writeConfig({
			observerModel: { provider: "openrouter", id: "primary:free", cooldownHours: 24 },
			observerFallbackModels: [{ provider: "openrouter", id: "fallback:free", cooldownHours: 24 }],
			model: { provider: "openrouter", id: "base:free", cooldownHours: 1 },
		});

		const { recordCooldown } = await import("../src/om/cooldown.js");
		recordCooldown({ provider: "openrouter", id: "primary:free" }, "429", "observer");
		recordCooldown({ provider: "openrouter", id: "fallback:free" }, "429", "observer");

		const { Runtime } = await import("../src/om/runtime.js");
		const runtime = new Runtime();
		runtime.ensureConfig(testDir);

		const registry = makeRegistry([
			makeModel("primary:free", "openrouter"),
			makeModel("fallback:free", "openrouter"),
			makeModel("base:free", "openrouter"),
		]);

		const result = await runtime.resolveModel({
			model: undefined,
			modelRegistry: registry,
			hasUI: false,
			stageModel: { provider: "openrouter", id: "primary:free" },
			stageFallbacks: [{ provider: "openrouter", id: "fallback:free" }],
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.model.id).toBe("base:free");
		}
	});

	it("falls through to session model when all candidates exhausted", async () => {
		writeConfig({
			observerModel: { provider: "openrouter", id: "primary:free" },
		});

		const { recordCooldown } = await import("../src/om/cooldown.js");
		recordCooldown({ provider: "openrouter", id: "primary:free" }, "429", "observer");

		const { Runtime } = await import("../src/om/runtime.js");
		const runtime = new Runtime();
		runtime.ensureConfig(testDir);

		const registry = makeRegistry([
			makeModel("primary:free", "openrouter"),
			makeModel("session-model", "openrouter"),
		]);

		const result = await runtime.resolveModel({
			model: makeModel("session-model", "openrouter"),
			modelRegistry: registry,
			hasUI: false,
			stageModel: { provider: "openrouter", id: "primary:free" },
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.model.id).toBe("session-model");
		}
	});

	it("skips session model fallback when sessionFallback is false", async () => {
		writeConfig({
			observerModel: { provider: "openrouter", id: "primary:free" },
			sessionFallback: false,
		});

		const { recordCooldown } = await import("../src/om/cooldown.js");
		recordCooldown({ provider: "openrouter", id: "primary:free" }, "429", "observer");

		const { Runtime } = await import("../src/om/runtime.js");
		const runtime = new Runtime();
		runtime.ensureConfig(testDir);

		const registry = makeRegistry([
			makeModel("primary:free", "openrouter"),
		]);

		const result = await runtime.resolveModel({
			model: makeModel("session-model", "openrouter"),
			modelRegistry: registry,
			hasUI: false,
			stageModel: { provider: "openrouter", id: "primary:free" },
		});

		// Should NOT fall through to session model — returns ok: false
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("sessionFallback disabled");
		}
	});

	it("skips model in failedInCycle (cooldown 0, failed this cycle), uses fallback", async () => {
		writeConfig({
			observerModel: { provider: "openrouter", id: "primary:free", cooldownHours: 0 },
			observerFallbackModels: [{ provider: "openrouter", id: "fallback:free", cooldownHours: 6 }],
		});

		const { Runtime } = await import("../src/om/runtime.js");
		const runtime = new Runtime();
		runtime.ensureConfig(testDir);

		// Simulate: primary model failed this cycle → tracked in-memory
		runtime.recordRetryableError(
			{ provider: "openrouter", id: "primary:free", cooldownHours: 0 },
			new Error("connection error"),
			"observer",
		);

		const registry = makeRegistry([
			makeModel("primary:free", "openrouter"),
			makeModel("fallback:free", "openrouter"),
		]);

		const result = await runtime.resolveModel({
			model: undefined,
			modelRegistry: registry,
			hasUI: false,
			stageModel: { provider: "openrouter", id: "primary:free" },
			stageFallbacks: [{ provider: "openrouter", id: "fallback:free", cooldownHours: 6 }],
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			// Should skip primary (in failedInCycle) and use fallback
			expect(result.model.id).toBe("fallback:free");
		}
		// No cooldown was written to disk for the primary model
		const data = readCooldownFile();
		expect(data["openrouter/primary:free"]).toBeUndefined();
	});

	it("clears failedInCycle between stages so model retried fresh", async () => {
		writeConfig({
			observerModel: { provider: "openrouter", id: "primary:free", cooldownHours: 0 },
		});

		const { Runtime } = await import("../src/om/runtime.js");
		const runtime = new Runtime();
		runtime.ensureConfig(testDir);

		// Simulate failure in observer stage
		runtime.recordRetryableError(
			{ provider: "openrouter", id: "primary:free", cooldownHours: 0 },
			new Error("observer error"),
			"observer",
		);
		expect(runtime.failedInCycle.has("openrouter/primary:free")).toBe(true);

		// Clear as pipeline does between stages
		runtime.failedInCycle.clear();

		const registry = makeRegistry([
			makeModel("primary:free", "openrouter"),
		]);

		// After clear, primary should be available again
		const result = await runtime.resolveModel({
			model: undefined,
			modelRegistry: registry,
			hasUI: false,
			stageModel: { provider: "openrouter", id: "primary:free" },
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.model.id).toBe("primary:free");
		}
	});
});

// ── Phase 9: Consolidation trigger guards ─────────────────────────────────

describe("Consolidation trigger — guards with new config keys", () => {
	function createConsolidationContext(configOverrides: Record<string, unknown> = {}) {
		let agentStartHandler: ((event: any, ctx: any) => void) | undefined;
		let turnEndHandler: ((event: any, ctx: any) => void) | undefined;
		const pi = {
			on: vi.fn((name: string, cb: any) => {
				if (name === "agent_start") agentStartHandler = cb;
				if (name === "turn_end") turnEndHandler = cb;
			}),
		};
		const launchConsolidationTask = vi.fn();
		const runtime = {
			ensureConfig: vi.fn(),
			config: {
				memory: true,
				observeAfterTokens: 1, // always due
				reflectAfterTokens: 999999, // never due
				compactAfterTokens: 1000,
				passive: false,
				noAutoCompact: false,
				debugLog: true,
				observerChunkMaxTokens: 10000,
				observerPreambleMaxTokens: 500,
				observationsPoolMaxTokens: 50000,
				reflectorInputMaxTokens: 10000,
				dropperInputMaxTokens: 10000,
				agentMaxTurns: 5,
				model: undefined,
				observerModel: undefined,
				observerFallbackModels: [],
				reflectorModel: undefined,
				reflectorFallbackModels: [],
				dropperModel: undefined,
				dropperFallbackModels: [],
				...configOverrides,
			},
			consolidationInFlight: false,
			isConsolidationRetryGated: vi.fn(() => false),
			launchConsolidationTask,
		};
		const ctx = {
			cwd: testDir,
			hasUI: false,
			sessionManager: {
				getBranch: vi.fn(() => [
					{ id: "m1", type: "message", message: { role: "user", content: [{ type: "text", text: "x".repeat(1000) }] } },
					{ id: "m2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "y".repeat(1000) }] } },
				]),
				getSessionId: vi.fn(() => "test-session"),
			},
		};
		return { pi, runtime, ctx, agentStartHandler: () => agentStartHandler!({}, ctx) };
	}

	it("T38: memory:false skips consolidation even with sufficient tokens", async () => {
		const { pi, runtime, ctx, agentStartHandler } = createConsolidationContext({
			memory: false,
		});
		const { registerConsolidationTrigger } = await import("../src/om/consolidation.js");
		registerConsolidationTrigger(pi as any, runtime as any);

		agentStartHandler();

		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("T39: memory:true + compaction:off runs consolidation", async () => {
		const { pi, runtime, ctx, agentStartHandler } = createConsolidationContext({
			memory: true,
			compaction: "off",
		});
		const { registerConsolidationTrigger } = await import("../src/om/consolidation.js");
		registerConsolidationTrigger(pi as any, runtime as any);

		agentStartHandler();

		expect(runtime.launchConsolidationTask).toHaveBeenCalled();
	});

	it("T40: passive:true (legacy, no new keys) blocks consolidation via legacy guard", async () => {
		const { pi, runtime, ctx, agentStartHandler } = createConsolidationContext({
			passive: true,
			compaction: undefined,
			compactionEngine: undefined,
		});
		const { registerConsolidationTrigger } = await import("../src/om/consolidation.js");
		registerConsolidationTrigger(pi as any, runtime as any);

		agentStartHandler();

		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});
});

describe("Runtime — cooldown persistence", () => {
	it("recordCooldown writes to disk", async () => {
		const { recordCooldown } = await import("../src/om/cooldown.js");
		recordCooldown({ provider: "openrouter", id: "test-model:free", cooldownHours: 5 }, "429 Too Many Requests", "observer");
		const data = readCooldownFile();
		const key = "openrouter/test-model:free";
		expect(data[key]).toBeDefined();
		expect((data[key] as any).reason).toBe("429 Too Many Requests");
		expect((data[key] as any).stage).toBe("observer");
	});

	it("isCooldownActive returns true for active cooldown", async () => {
		const { recordCooldown, isCooldownActive } = await import("../src/om/cooldown.js");
		recordCooldown({ provider: "openrouter", id: "cool-model:free", cooldownHours: 24 }, "429", "observer");
		expect(isCooldownActive({ provider: "openrouter", id: "cool-model:free" })).toBe(true);
	});

	it("isCooldownActive returns false when no cooldown entry", async () => {
		const { isCooldownActive } = await import("../src/om/cooldown.js");
		expect(isCooldownActive({ provider: "openrouter", id: "never-cooled:free" })).toBe(false);
	});

	it("expireCooldowns removes expired entries", async () => {
		const { recordCooldown, expireCooldowns, isCooldownActive } = await import("../src/om/cooldown.js");
		// Record cooldown with 0 hours → expires immediately
		recordCooldown({ provider: "openrouter", id: "expiring:free", cooldownHours: 0 }, "429", "observer");
		// Wait a tick
		await new Promise((r) => setTimeout(r, 10));
		expireCooldowns();
		// Should be expired now
		expect(isCooldownActive({ provider: "openrouter", id: "expiring:free" })).toBe(false);
	});

	it("recordCooldown with cooldownHours: 0 writes nothing to disk", async () => {
		const { recordCooldown } = await import("../src/om/cooldown.js");
		recordCooldown({ provider: "openrouter", id: "noop-model:free", cooldownHours: 0 }, "any error", "observer");
		const data = readCooldownFile();
		expect(data["openrouter/noop-model:free"]).toBeUndefined();
		expect(Object.keys(data)).toHaveLength(0);
	});

	it("isCooldownActive with cooldownHours: 0 returns false without disk read", async () => {
		const { isCooldownActive } = await import("../src/om/cooldown.js");
		// No cooldown file exists yet
		expect(isCooldownActive({ provider: "openrouter", id: "disabled:free", cooldownHours: 0 })).toBe(false);
		// Even with a stale cooldown file, cooldownHours: 0 short-circuits
		const { recordCooldown } = await import("../src/om/cooldown.js");
		recordCooldown({ provider: "openrouter", id: "other:free", cooldownHours: 5 }, "error", "observer");
		expect(isCooldownActive({ provider: "openrouter", id: "disabled:free", cooldownHours: 0 })).toBe(false);
	});
});

describe("Runtime — retry gating", () => {
	it("isConsolidationRetryGated returns false initially", async () => {
		const { Runtime } = await import("../src/om/runtime.js");
		const runtime = new Runtime();
		expect(runtime.isConsolidationRetryGated()).toBe(false);
	});

	it("isConsolidationRetryGated returns true after markConsolidationError", async () => {
		const { Runtime } = await import("../src/om/runtime.js");
		const runtime = new Runtime();
		runtime.markConsolidationError();
		expect(runtime.isConsolidationRetryGated()).toBe(true);
	});

	it("markConsolidationError also sets recorded error on Runtime state", async () => {
		const { Runtime } = await import("../src/om/runtime.js");
		const runtime = new Runtime();
		expect(runtime.lastConsolidationErrorAt).toBeUndefined();
		runtime.markConsolidationError();
		expect(runtime.lastConsolidationErrorAt).toBeGreaterThan(0);
	});
});

describe("Runtime — findCandidateConfig", () => {
	it("finds matching candidate from stage model list", async () => {
		writeConfig({
			observerModel: { provider: "openrouter", id: "obs-primary:free" },
		});
		const { Runtime } = await import("../src/om/runtime.js");
		const runtime = new Runtime();
		runtime.ensureConfig(testDir);

		const resolved = makeModel("obs-primary:free", "openrouter");
		const candidate = runtime.findCandidateConfig(resolved, {
			model: undefined, modelRegistry: makeRegistry([]), hasUI: false,
			stageModel: { provider: "openrouter", id: "obs-primary:free" },
		});
		expect(candidate).toBeDefined();
		expect(candidate!.id).toBe("obs-primary:free");
	});

	it("finds matching candidate from base config.model", async () => {
		writeConfig({
			model: { provider: "openrouter", id: "base-fallback:free" },
		});
		const { Runtime } = await import("../src/om/runtime.js");
		const runtime = new Runtime();
		runtime.ensureConfig(testDir);

		const resolved = makeModel("base-fallback:free", "openrouter");
		const candidate = runtime.findCandidateConfig(resolved, {
			model: undefined, modelRegistry: makeRegistry([]), hasUI: false,
		});
		expect(candidate).toBeDefined();
		expect(candidate!.id).toBe("base-fallback:free");
	});

	it("returns undefined for session model", async () => {
		const { Runtime } = await import("../src/om/runtime.js");
		const runtime = new Runtime();
		runtime.ensureConfig(testDir);

		const resolved = makeModel("session-only", "openrouter");
		const candidate = runtime.findCandidateConfig(resolved, {
			model: undefined, modelRegistry: makeRegistry([]), hasUI: false,
		});
		expect(candidate).toBeUndefined();
	});
});

describe("Runtime — recordRetryableError", () => {
	it("persists cooldown for a candidate model", async () => {
		const { Runtime } = await import("../src/om/runtime.js");
		const runtime = new Runtime();
		runtime.ensureConfig(testDir);

		runtime.recordRetryableError(
			{ provider: "openrouter", id: "to-cool:free", cooldownHours: 5 },
			new Error("429 Too Many Requests"),
			"observer",
		);
		const data = readCooldownFile();
		expect(data["openrouter/to-cool:free"]).toBeDefined();
	});

	it("skips cooldown record when modelConfig is undefined (session model)", async () => {
		const { Runtime } = await import("../src/om/runtime.js");
		const runtime = new Runtime();
		runtime.ensureConfig(testDir);

		// Should not throw or write
		runtime.recordRetryableError(undefined, new Error("429"), "observer");
		expect(readCooldownFile()).toEqual({});
	});

	it("cooldownHours: 0 tracks in failedInCycle, does not write to disk", async () => {
		const { Runtime } = await import("../src/om/runtime.js");
		const runtime = new Runtime();
		runtime.ensureConfig(testDir);

		runtime.recordRetryableError(
			{ provider: "openrouter", id: "no-persist:free", cooldownHours: 0 },
			new Error("connection refused"),
			"observer",
		);

		// No disk write
		const data = readCooldownFile();
		expect(data["openrouter/no-persist:free"]).toBeUndefined();

		// But tracked in-memory
		expect(runtime.failedInCycle.has("openrouter/no-persist:free")).toBe(true);
	});

	it("cooldownHours > 0 persists to disk and does NOT add to failedInCycle", async () => {
		const { Runtime } = await import("../src/om/runtime.js");
		const runtime = new Runtime();
		runtime.ensureConfig(testDir);

		runtime.recordRetryableError(
			{ provider: "openrouter", id: "persist:free", cooldownHours: 6 },
			new Error("rate limited"),
			"observer",
		);

		// Disk write happened
		const data = readCooldownFile();
		expect(data["openrouter/persist:free"]).toBeDefined();

		// NOT in in-memory set
		expect(runtime.failedInCycle.has("openrouter/persist:free")).toBe(false);
	});
});

describe("Runtime — sessionFallback notification", () => {
	it("fires info notification when sessionFallback disabled and cooldown-disabled models exhausted chain", async () => {
		writeConfig({
			observerModel: { provider: "openrouter", id: "primary:free", cooldownHours: 0 },
			sessionFallback: false,
		});

		const { Runtime } = await import("../src/om/runtime.js");
		const runtime = new Runtime();
		runtime.ensureConfig(testDir);

		// Simulate: primary model failed → added to failedInCycle
		runtime.recordRetryableError(
			{ provider: "openrouter", id: "primary:free", cooldownHours: 0 },
			new Error("connection error"),
			"observer",
		);

		const notify = vi.fn();
		const registry = makeRegistry([]);

		const result = await runtime.resolveModel({
			model: makeModel("session-model", "openrouter"),
			modelRegistry: registry,
			hasUI: true,
			ui: { notify },
			stageModel: { provider: "openrouter", id: "primary:free" },
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("sessionFallback disabled");
		expect(notify).toHaveBeenCalledTimes(2);
		expect(notify.mock.calls[1]).toEqual([
			expect.stringContaining("sessionFallback disabled"),
			"info",
		]);
	});
});

describe("Runtime — model not found in registry (falls to next)", () => {
	it("skips candidate not found in registry, uses next available", async () => {
		writeConfig({
			observerModel: { provider: "openrouter", id: "nonexistent:free" },
			observerFallbackModels: [{ provider: "openrouter", id: "exists:free" }],
		});
		const { Runtime } = await import("../src/om/runtime.js");
		const runtime = new Runtime();
		runtime.ensureConfig(testDir);

		const registry = makeRegistry([
			makeModel("exists:free", "openrouter"),
		]);

		const result = await runtime.resolveModel({
			model: undefined,
			modelRegistry: registry,
			hasUI: false,
			stageModel: { provider: "openrouter", id: "nonexistent:free" },
			stageFallbacks: [{ provider: "openrouter", id: "exists:free" }],
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.model.id).toBe("exists:free");
		}
	});
});
