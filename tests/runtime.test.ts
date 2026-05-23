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
