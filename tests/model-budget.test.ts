/**
 * Model budget tests — context window resolution, token budget helpers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  compactThresholdTokens,
  effectiveContextWindow,
  sessionContextWindow,
} from "../src/om/model-budget.js";

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
      observerModel: {
        provider: "openrouter",
        id: "small-ctx:free",
        contextWindow: 16_384,
      },
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
      observerModel: {
        provider: "openrouter",
        id: "bad:free",
        contextWindow: -1,
      },
    });
    const { loadConfig } = await import("../src/om/config.js");
    const config = loadConfig(testDir);
    expect(config.observerModel).toBeDefined();
    expect(config.observerModel!.contextWindow).toBeUndefined();
  });

  it("rejects NaN contextWindow values during parse", async () => {
    writeConfig({
      observerModel: {
        provider: "openrouter",
        id: "nan:free",
        contextWindow: "invalid",
      },
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

describe("compactThresholdTokens", () => {
  it("explicit compactAfterTokens wins over ratio and reserve", () => {
    expect(
      compactThresholdTokens({ compactAfterTokens: 180_000, compactAfterRatio: 0.65 }, 1_000_000),
    ).toBe(180_000);
    expect(
      compactThresholdTokens(
        { compactAfterTokens: 180_000, compactReserveTokens: 32_768 },
        1_000_000,
      ),
    ).toBe(180_000);
  });

  it("derives floor(window × ratio) when only compactAfterRatio is set", () => {
    expect(compactThresholdTokens({ compactAfterRatio: 0.65 }, 200_000)).toBe(130_000);
    expect(compactThresholdTokens({ compactAfterRatio: 0.65 }, 128_000)).toBe(83_200);
    expect(compactThresholdTokens({ compactAfterRatio: 1 }, 128_000)).toBe(128_000);
  });

  it("ratio floor is clamped to at least 1 token", () => {
    expect(compactThresholdTokens({ compactAfterRatio: 0.5 }, 1)).toBe(1);
    expect(compactThresholdTokens({ compactAfterRatio: 0.01 }, 1)).toBe(1);
  });

  it("derives window − reserve when only compactReserveTokens is set", () => {
    expect(compactThresholdTokens({ compactReserveTokens: 32_768 }, 1_000_000)).toBe(967_232);
    expect(compactThresholdTokens({ compactReserveTokens: 32_768 }, 128_000)).toBe(95_232);
  });

  it("reserve result is clamped to at least 1 token", () => {
    // Reserve >= window leaves no headroom — clamp so the trigger still fires
    // only once real content exists instead of never / always.
    expect(compactThresholdTokens({ compactReserveTokens: 200_000 }, 200_000)).toBe(1);
    expect(compactThresholdTokens({ compactReserveTokens: 500_000 }, 200_000)).toBe(1);
  });

  it("ratio wins over reserve when both are configured (tokens > ratio > reserve)", () => {
    expect(
      compactThresholdTokens({ compactAfterRatio: 0.5, compactReserveTokens: 1_000 }, 200_000),
    ).toBe(100_000);
  });

  it("falls back to the 81000 legacy default when no knob is set", () => {
    expect(compactThresholdTokens({}, 200_000)).toBe(81_000);
    expect(compactThresholdTokens({}, 32_000)).toBe(81_000);
  });
});

describe("sessionContextWindow", () => {
  it("honors a base-model config override when provider+id match", () => {
    const config = { model: { provider: "openrouter", id: "big:free", contextWindow: 64_000 } };
    const model = { provider: "openrouter", id: "big:free", contextWindow: 200_000 };
    expect(sessionContextWindow(model as any, config as any)).toBe(64_000);
  });

  it("honors an OM stage-model (or fallback) override when provider+id match", () => {
    const config = {
      reflectorFallbackModels: [{ provider: "openrouter", id: "big:free", contextWindow: 32_000 }],
    };
    const model = { provider: "openrouter", id: "big:free", contextWindow: 200_000 };
    expect(sessionContextWindow(model as any, config as any)).toBe(32_000);
  });

  it("uses the model registry window when no override matches", () => {
    const config = { model: { provider: "openrouter", id: "other:free", contextWindow: 64_000 } };
    const model = { provider: "openrouter", id: "big:free", contextWindow: 200_000 };
    expect(sessionContextWindow(model as any, config as any)).toBe(200_000);
  });

  it("falls back to 128000 when the model has no window and no override", () => {
    const config = { model: { provider: "openrouter", id: "other:free", contextWindow: 64_000 } };
    const model = { provider: "openrouter", id: "big:free" };
    expect(sessionContextWindow(model as any, config as any)).toBe(128_000);
  });

  it("falls back to 128000 when there is no session model", () => {
    const config = { model: { provider: "openrouter", id: "big:free", contextWindow: 64_000 } };
    expect(sessionContextWindow(undefined, config as any)).toBe(128_000);
  });
});
