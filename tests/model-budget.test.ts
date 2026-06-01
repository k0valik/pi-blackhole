/**
 * Model budget tests — context window resolution, token budget helpers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { effectiveContextWindow } from "../src/om/model-budget.js";

const testDir = join(tmpdir(), `pi-blackhole-model-budget-test-${Date.now()}`);

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => testDir,
	estimateTokens: () => 250,
}));

beforeEach(() => {
	mkdirSync(testDir, { recursive: true });
});
afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
});

function writeConfig(data: unknown, filename = "pi-blackhole/pi-blackhole-config.json"): string {
	const dir = join(testDir, filename).replace(/\/[^/]+$/, "");
	mkdirSync(dir, { recursive: true });
	const path = join(testDir, filename);
	writeFileSync(path, JSON.stringify(data, null, 2));
	return path;
}

describe("config parsing — contextWindow on OmModelConfig", () => {
	it("parses contextWindow from model config", async () => {
		writeConfig({
			observerModel: { provider: "openrouter", id: "small-ctx:free", contextWindow: 16_384 },
		});
		const { loadConfig } = await import("../src/om/config.js");
		const config = loadConfig(testDir);
		expect(config.observerModel).toBeDefined();
		expect(config.observerModel!.contextWindow).toBe(16_384);
	});

	it("parses contextWindow on fallback models", async () => {
		writeConfig({
			observerFallbackModels: [
				{ provider: "openrouter", id: "small:free", contextWindow: 32_000 },
				{ provider: "openrouter", id: "large:free" },
			],
		});
		const { loadConfig } = await import("../src/om/config.js");
		const config = loadConfig(testDir);
		expect(config.observerFallbackModels).toBeDefined();
		expect(config.observerFallbackModels![0].contextWindow).toBe(32_000);
		expect(config.observerFallbackModels![1].contextWindow).toBeUndefined();
	});

	it("rejects non-positive contextWindow values during parse", async () => {
		writeConfig({
			observerModel: { provider: "openrouter", id: "bad:free", contextWindow: -1 },
		});
		const { loadConfig } = await import("../src/om/config.js");
		const config = loadConfig(testDir);
		expect(config.observerModel).toBeDefined();
		expect(config.observerModel!.contextWindow).toBeUndefined();
	});

	it("rejects NaN contextWindow values during parse", async () => {
		writeConfig({
			observerModel: { provider: "openrouter", id: "nan:free", contextWindow: "invalid" },
		});
		const { loadConfig } = await import("../src/om/config.js");
		const config = loadConfig(testDir);
		expect(config.observerModel).toBeDefined();
		expect(config.observerModel!.contextWindow).toBeUndefined();
	});
});

describe("effectiveContextWindow", () => {
	it("uses config override when present on OmModelConfig", () => {
		const model = { provider: "test", id: "test", contextWindow: 200_000 };
		const modelConfig = { provider: "test", id: "test", contextWindow: 32_000 };
		expect(effectiveContextWindow(model as any, modelConfig)).toBe(32_000);
	});

	it("inherits from Pi's model registry when no config override", () => {
		const model = { provider: "test", id: "test", contextWindow: 128_000 };
		expect(effectiveContextWindow(model as any, undefined)).toBe(128_000);
	});

	it("falls back to 128000 when neither source has a value", () => {
		const model = {} as any;
		expect(effectiveContextWindow(model, undefined)).toBe(128_000);
	});

	it("config override takes priority even when model has a value", () => {
		const model = { provider: "test", id: "test", contextWindow: 200_000 };
		const modelConfig = { provider: "test", id: "test", contextWindow: 64_000 };
		expect(effectiveContextWindow(model as any, modelConfig)).toBe(64_000);
	});
});
