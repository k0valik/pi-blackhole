/**
 * Model budget tests — context window resolution, token budget helpers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BUILTIN_PRESETS,
  compactThresholdTokens,
  effectiveContextWindow,
  effectivePresets,
  presetRatioForWindow,
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

  it("no knob → the built-in default preset governs (no fixed 81000)", () => {
    // The loader always injects compactAfterPreset:"default", so a bare {}
    // resolves identically to the default preset curve.
    expect(compactThresholdTokens({ compactAfterPreset: "default" }, 200_000)).toBe(149_482);
    expect(compactThresholdTokens({ compactAfterPreset: "default" }, 32_768)).toBe(29_491);
    expect(compactThresholdTokens({}, 200_000)).toBe(149_482);
  });
});

describe("presetRatioForWindow", () => {
  const fall = BUILTIN_PRESETS.default;

  it("returns the exact anchor ratio at each anchor", () => {
    expect(presetRatioForWindow(fall, 32_768)).toBeCloseTo(0.9, 10);
    expect(presetRatioForWindow(fall, 131_072)).toBeCloseTo(0.8, 10);
    expect(presetRatioForWindow(fall, 262_144)).toBeCloseTo(0.7, 10);
    expect(presetRatioForWindow(fall, 1_048_576)).toBeCloseTo(0.4, 10);
  });

  it("interpolates linearly between anchors", () => {
    // midpoint of 32768 (0.9) → 131072 (0.8) is 0.85
    expect(presetRatioForWindow(fall, (32_768 + 131_072) / 2)).toBeCloseTo(0.85, 10);
    // 65,536 is 1/3 of the way: 0.9 − (1/3)·0.1
    expect(presetRatioForWindow(fall, 65_536)).toBeCloseTo(0.9 - (1 / 3) * 0.1, 10);
    // midpoint of 262144 (0.7) → 1048576 (0.4) is 0.55
    expect(presetRatioForWindow(fall, (262_144 + 1_048_576) / 2)).toBeCloseTo(0.55, 10);
  });

  it("extrapolates constant below the first and above the last anchor", () => {
    expect(presetRatioForWindow(fall, 8_000)).toBeCloseTo(0.9, 10);
    expect(presetRatioForWindow(fall, 2_000_000)).toBeCloseTo(0.4, 10);
  });

  it("a single anchor is a constant ratio (global-ratio preset)", () => {
    const flat = [{ window: 131_072, ratio: 0.6 }];
    expect(presetRatioForWindow(flat, 32_000)).toBeCloseTo(0.6, 10);
    expect(presetRatioForWindow(flat, 1_000_000)).toBeCloseTo(0.6, 10);
  });
});

describe("compactThresholdTokens — preset curves", () => {
  it("resolves the built-in default curve from the window", () => {
    const preset = { compactAfterPreset: "default" };
    expect(compactThresholdTokens(preset, 32_768)).toBe(Math.floor(32_768 * 0.9)); // 29,491
    expect(compactThresholdTokens(preset, 131_072)).toBe(104_857); // floor(131072 × 0.8)
    expect(compactThresholdTokens(preset, 262_144)).toBe(183_500); // floor(262144 × 0.7)
    // above the last anchor → constant 0.4
    expect(compactThresholdTokens(preset, 2_000_000)).toBe(800_000);
  });

  it("interpolates the threshold for intermediate windows", () => {
    const preset = { compactAfterPreset: "default" };
    // 65,536 → ratio 0.86666… → floor(65536 × 0.86666…) = 56,797
    expect(compactThresholdTokens(preset, 65_536)).toBe(56_797);
    // 1M is between 262144 (0.7) and 1048576 (0.4): ratio ≈ 0.41853 → 418,530
    const t = compactThresholdTokens(preset, 1_000_000);
    expect(t).toBeGreaterThan(400_000);
    expect(t).toBeLessThan(420_000);
  });

  it("falls back to the built-in default preset for an unknown name", () => {
    expect(compactThresholdTokens({ compactAfterPreset: "no-such-preset" }, 131_072)).toBe(104_857);
  });

  it("never returns undefined — always a positive integer", () => {
    const preset = { compactAfterPreset: "default" };
    const t = compactThresholdTokens(preset, 123_456);
    expect(Number.isInteger(t)).toBe(true);
    expect(t).toBeGreaterThan(0);
  });

  it("merges user definitions over built-ins (same-name override + added name)", () => {
    const presets = {
      default: [{ window: 131_072, ratio: 0.5 }],
      early: [{ window: 131_072, ratio: 0.6 }],
    };
    // added user preset "early": constant ratio 0.6
    expect(
      compactThresholdTokens(
        { compactAfterPreset: "early", compactAfterPresets: presets },
        200_000,
      ),
    ).toBe(120_000);
    // built-in "default" overridden by the user file to 0.5 at 131072
    expect(
      compactThresholdTokens(
        { compactAfterPreset: "default", compactAfterPresets: presets },
        131_072,
      ),
    ).toBe(65_536);
  });

  it("numeric knobs still win over the preset", () => {
    expect(
      compactThresholdTokens({ compactAfterPreset: "default", compactAfterRatio: 0.5 }, 200_000),
    ).toBe(100_000);
    expect(
      compactThresholdTokens(
        { compactAfterPreset: "default", compactReserveTokens: 32_768 },
        1_000_000,
      ),
    ).toBe(967_232);
    expect(
      compactThresholdTokens(
        { compactAfterPreset: "default", compactAfterTokens: 180_000 },
        1_000_000,
      ),
    ).toBe(180_000);
  });

  it("effectivePresets overlays built-ins with file definitions only", () => {
    const presets = { early: [{ window: 131_072, ratio: 0.6 }] };
    const merged = effectivePresets({ compactAfterPresets: presets });
    expect(Object.keys(merged).sort()).toEqual(["default", "early"]);
    expect(merged.default).toBe(BUILTIN_PRESETS.default); // untouched reference
    expect(merged.early).toBe(presets.early);
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
