/**
 * Configuration parsing and loading tests.
 *
 * Covers: unified config loader, legacy fallback, env overrides,
 * model config with complex IDs (slashes, colons), defaults.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `pi-blackhole-config-test-${Date.now()}`);

// Mock getAgentDir to point to our test directory
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

// ── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
	mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
	vi.resetAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Config defaults", () => {
	it("uses all defaults when no config file exists", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		const config = loadUnifiedConfig(testDir);
		// New config surface defaults
		expect(config.compaction).toBe("auto");
		expect(config.compactionEngine).toBe("blackhole");
		expect(config.tailBehavior).toBe("minimal");
		expect(config.debug).toBe(false);
		expect(config.observeAfterTokens).toBe(15_000);
		expect(config.reflectAfterTokens).toBe(25_000);
		expect(config.compactAfterTokens).toBe(81_000);
		expect(config.observationsPoolMaxTokens).toBe(20_000);
		expect(config.agentMaxTurns).toBe(16);
		expect(config.agentLoopReserve).toBe(8_000);
		expect(config.memory).toBe(true);
		expect(config.debugLog).toBe(false);
		expect(config.model).toBeUndefined();
		expect(config.observerModel).toBeUndefined();
		expect(config.reflectorModel).toBeUndefined();
		expect(config.dropperModel).toBeUndefined();
		// Legacy fields are deleted during migration so not present
		expect((config as any).overrideDefaultCompaction).toBeUndefined();
		expect((config as any).passive).toBeUndefined();
	});
});

describe("Config with model IDs containing slashes and colons", () => {
	it("parses OpenRouter-style model IDs (slash + colon)", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({
			observerModel: {
				provider: "openrouter",
				id: "google/gemma-4-26b-a4b-it:free",
			},
			reflectorModel: {
				provider: "openrouter",
				id: "google/gemini-2.5-pro:extended",
			},
			dropperModel: {
				provider: "openrouter",
				id: "openrouter/auto",
			},
		});
		const config = loadUnifiedConfig(testDir);

		// Observer model
		expect(config.observerModel).toBeDefined();
		expect(config.observerModel!.provider).toBe("openrouter");
		expect(config.observerModel!.id).toBe("google/gemma-4-26b-a4b-it:free");
		expect(config.observerModel!.thinking).toBeUndefined();

		// Reflector model
		expect(config.reflectorModel).toBeDefined();
		expect(config.reflectorModel!.provider).toBe("openrouter");
		expect(config.reflectorModel!.id).toBe("google/gemini-2.5-pro:extended");

		// Dropper model
		expect(config.dropperModel).toBeDefined();
		expect(config.dropperModel!.provider).toBe("openrouter");
		expect(config.dropperModel!.id).toBe("openrouter/auto");
	});

	it("parses model with thinking level", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({
			observerModel: {
				provider: "openai",
				id: "gpt-5.4",
				thinking: "low",
			},
		});
		const config = loadUnifiedConfig(testDir);
		expect(config.observerModel!.thinking).toBe("low");
	});

	it("rejects model without provider (falls back to undefined)", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({
			observerModel: {
				id: "google/gemma-4-26b-a4b-it:free",
			},
		});
		const config = loadUnifiedConfig(testDir);
		// Missing provider → model block is ignored
		expect(config.observerModel).toBeUndefined();
	});

	it("rejects model without id (falls back to undefined)", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({
			observerModel: {
				provider: "openrouter",
			},
		});
		const config = loadUnifiedConfig(testDir);
		expect(config.observerModel).toBeUndefined();
	});

	it("rejects model with empty-string provider", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({
			observerModel: {
				provider: "",
				id: "some-model",
			},
		});
		const config = loadUnifiedConfig(testDir);
		expect(config.observerModel).toBeUndefined();
	});

	it("parses cooldownHours on model config", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({
			observerModel: {
				provider: "openrouter",
				id: "google/gemma-4-26b-a4b-it:free",
				cooldownHours: 12,
			},
		});
		const config = loadUnifiedConfig(testDir);
		expect(config.observerModel!.cooldownHours).toBe(12);
	});

	it("parses fallback model arrays", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({
			observerFallbackModels: [
				{ provider: "openrouter", id: "fb1:free", cooldownHours: 6 },
				{ provider: "openrouter", id: "fb2:free", cooldownHours: 2 },
			],
			reflectorFallbackModels: [
				{ provider: "cerebras", id: "llama-3.3-70b", thinking: "low" },
			],
			dropperFallbackModels: [],
		});
		const config = loadUnifiedConfig(testDir);
		expect(config.observerFallbackModels).toHaveLength(2);
		expect(config.observerFallbackModels![0].id).toBe("fb1:free");
		expect(config.observerFallbackModels![0].cooldownHours).toBe(6);
		expect(config.observerFallbackModels![1].id).toBe("fb2:free");
		expect(config.reflectorFallbackModels).toHaveLength(1);
		expect(config.reflectorFallbackModels![0].thinking).toBe("low");
		// Empty array is not stored (parseModelArray returns undefined for empty)
		expect(config.dropperFallbackModels).toBeUndefined();
	});

	it("ignores invalid entries in fallback array (missing provider)", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({
			observerFallbackModels: [
				{ provider: "openrouter", id: "valid:free" },
				{ id: "no-provider" },
				{ provider: "openrouter", id: "also-valid:free" },
			],
		});
		const config = loadUnifiedConfig(testDir);
		expect(config.observerFallbackModels).toHaveLength(2);
		expect(config.observerFallbackModels![0].id).toBe("valid:free");
		expect(config.observerFallbackModels![1].id).toBe("also-valid:free");
	});
});

describe("Legacy config fallback", () => {
	it("loads from legacy pi-vcc-config.json and migrates to new keys", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({ overrideDefaultCompaction: true, debug: true }, "pi-vcc-config.json");
		const config = loadUnifiedConfig(testDir);
		// Legacy overrideDefaultCompaction:true → compactionEngine:blackhole + tailBehavior:minimal
		expect(config.compactionEngine).toBe("blackhole");
		expect(config.tailBehavior).toBe("minimal");
		expect(config.debug).toBe(true);
		expect((config as any).overrideDefaultCompaction).toBeUndefined();
	});

	it("prefers unified config over legacy", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		// Write legacy file with just debug (new keys would block migration)
		writeConfig({ debug: true }, "pi-vcc-config.json");
		// Write unified file — new keys present so no migration runs
		writeConfig({ compaction: "off", compactionEngine: "pi-default", debug: false }, "pi-blackhole/pi-blackhole-config.json");
		const config = loadUnifiedConfig(testDir);
		expect(config.compaction).toBe("off");
		expect(config.compactionEngine).toBe("pi-default");
		expect(config.debug).toBe(false);
	});

	it("loads legacy om config from settings.json under pi-blackhole key and migrates", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({
			"pi-blackhole": {
				passive: true,
				debugLog: true,
				observeAfterTokens: 5_000,
			},
		}, "settings.json");
		const config = loadUnifiedConfig(testDir);
		expect(config.compaction).toBe("off");
		expect(config.memory).toBe(false);
		expect(config.debugLog).toBe(true);
		expect(config.observeAfterTokens).toBe(5_000);
		expect((config as any).passive).toBeUndefined();
	});

	it("loads from observational-memory legacy key and migrates", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({
			"observational-memory": {
				passive: true,
			},
		}, "settings.json");
		const config = loadUnifiedConfig(testDir);
		expect(config.compaction).toBe("off");
		expect(config.memory).toBe(false);
		expect((config as any).passive).toBeUndefined();
	});
});

describe("Env overrides", () => {
	afterEach(() => {
		delete process.env.PI_VCC_OM_PASSIVE;
		delete process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE;
	});

	it("env PI_VCC_OM_PASSIVE=true forces compaction:off + memory:false", async () => {
		process.env.PI_VCC_OM_PASSIVE = "true";
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({ passive: false });
		const config = loadUnifiedConfig(testDir);
		expect(config.compaction).toBe("off");
		expect(config.memory).toBe(false);
	});

	it("env PI_VCC_OM_PASSIVE=false does not force passive", async () => {
		process.env.PI_VCC_OM_PASSIVE = "false";
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({ passive: true });
		const config = loadUnifiedConfig(testDir);
		// passive:true in config is migrated → compaction:off + memory:false
		expect(config.compaction).toBe("off");
		expect(config.memory).toBe(false);
	});

	it("env PI_OBSERVATIONAL_MEMORY_PASSIVE also works (legacy)", async () => {
		process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE = "1";
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({ passive: false });
		const config = loadUnifiedConfig(testDir);
		expect(config.compaction).toBe("off");
		expect(config.memory).toBe(false);
	});
});

describe("Integer fields are validated as positive integers", () => {
	it("rejects negative token values, falls back to defaults", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({
			observeAfterTokens: -100,
			reflectAfterTokens: 0,
			compactAfterTokens: 81_000,
		});
		const config = loadUnifiedConfig(testDir);
		expect(config.observeAfterTokens).toBe(15_000); // blackhole default (upstream is 10_000)
		expect(config.reflectAfterTokens).toBe(25_000); // blackhole default (upstream is 20_000)
		expect(config.compactAfterTokens).toBe(81_000); // from config
	});
});

describe("saveUnifiedConfig", () => {
	it("writes config to disk", async () => {
		const { saveUnifiedConfig, loadUnifiedConfig } = await import("../src/core/unified-config.js");
		const result = saveUnifiedConfig({ compaction: "manual", debug: true });
		expect(result).toBe(true);

		const config = loadUnifiedConfig(testDir);
		expect(config.compaction).toBe("manual");
		expect(config.debug).toBe(true);
	});

	it("preserves existing keys when saving partial config", async () => {
		const { saveUnifiedConfig, loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({ compaction: "off", memory: false });
		saveUnifiedConfig({ memory: true });
		const config = loadUnifiedConfig(testDir);
		expect(config.compaction).toBe("off");
		expect(config.memory).toBe(true);
		expect(config.debug).toBe(false);
	});
});
