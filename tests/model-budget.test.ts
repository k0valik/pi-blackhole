/**
 * Model budget tests — context window resolution, token budget helpers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  effectiveContextWindow,
  resolveDropperInputMaxTokens,
  resolveObservationsPoolMaxTokens,
  resolveObserverChunkMaxTokens,
  resolveReflectorInputMaxTokens,
  resolveSessionContextWindow,
  resolveWorkerWindow,
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

function writeConfig(
  data: unknown,
  filename = "pi-blackhole/pi-blackhole-config.json",
): string {
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

describe("resolveSessionContextWindow", () => {
  it("prefers the live context usage window", () => {
    const model = { contextWindow: 200_000 };
    expect(
      resolveSessionContextWindow(model, () => ({ contextWindow: 32_000 })),
    ).toBe(32_000);
  });

  it("falls back to the model window when the thunk returns nothing", () => {
    const model = { contextWindow: 200_000 };
    expect(resolveSessionContextWindow(model, () => undefined)).toBe(200_000);
    expect(resolveSessionContextWindow(model, undefined)).toBe(200_000);
  });

  it("falls back to 128000 when nothing provides a window", () => {
    expect(resolveSessionContextWindow(undefined, () => undefined)).toBe(
      128_000,
    );
    expect(resolveSessionContextWindow({} as any, undefined)).toBe(128_000);
  });

  it("falls through on a throwing (stale) context thunk", () => {
    const model = { contextWindow: 64_000 };
    expect(() =>
      resolveSessionContextWindow(model, () => {
        throw new Error("stale context");
      }),
    ).not.toThrow();
    expect(
      resolveSessionContextWindow(model, () => {
        throw new Error("stale context");
      }),
    ).toBe(64_000);
  });

  it("falls through on non-positive and NaN windows", () => {
    const model = { contextWindow: 64_000 };
    expect(
      resolveSessionContextWindow(model, () => ({ contextWindow: -1 })),
    ).toBe(64_000);
    expect(
      resolveSessionContextWindow(model, () => ({ contextWindow: NaN })),
    ).toBe(64_000);
    expect(
      resolveSessionContextWindow({ contextWindow: 0 } as any, undefined),
    ).toBe(128_000);
  });
});

describe("resolveWorkerWindow", () => {
  it("prefers the stage model window", () => {
    expect(resolveWorkerWindow({ contextWindow: 32_000 }, 200_000)).toBe(
      32_000,
    );
  });

  it("falls back to the session window", () => {
    expect(resolveWorkerWindow(undefined, 200_000)).toBe(200_000);
    expect(resolveWorkerWindow({} as any, 64_000)).toBe(64_000);
  });

  it("falls back to 128000 when both are unusable", () => {
    expect(resolveWorkerWindow({ contextWindow: 0 } as any, 0)).toBe(128_000);
    expect(resolveWorkerWindow(undefined, NaN)).toBe(128_000);
  });
});

describe("resolveObserverChunkMaxTokens", () => {
  it("derives 20% of the worker window when unset", () => {
    expect(resolveObserverChunkMaxTokens(0, 128_000)).toBe(25_600);
    expect(resolveObserverChunkMaxTokens(0, 32_000)).toBe(6_400);
  });

  it("honors explicit values", () => {
    expect(resolveObserverChunkMaxTokens(40_000, 128_000)).toBe(40_000);
    expect(resolveObserverChunkMaxTokens(5_000, 128_000)).toBe(5_000);
  });

  it("clamps both paths to 256 tokens minimum", () => {
    expect(resolveObserverChunkMaxTokens(0, 500)).toBe(256);
    expect(resolveObserverChunkMaxTokens(100, 128_000)).toBe(256);
  });
});

describe("resolveReflectorInputMaxTokens / resolveDropperInputMaxTokens / resolveObservationsPoolMaxTokens", () => {
  it("derives 60% of the worker window when unset", () => {
    expect(resolveReflectorInputMaxTokens(0, 128_000)).toBe(76_800);
    expect(resolveDropperInputMaxTokens(0, 128_000)).toBe(76_800);
  });

  it("derives 15% of the session window for the pool", () => {
    expect(resolveObservationsPoolMaxTokens(0, 128_000)).toBe(19_200);
  });

  it("honors explicit values at or above the minimum", () => {
    expect(resolveReflectorInputMaxTokens(80_000, 128_000)).toBe(80_000);
    expect(resolveDropperInputMaxTokens(80_000, 128_000)).toBe(80_000);
    expect(resolveObservationsPoolMaxTokens(20_000, 128_000)).toBe(20_000);
  });

  it("clamps explicit values below the 1000 minimum", () => {
    expect(resolveReflectorInputMaxTokens(500, 128_000)).toBe(1_000);
    expect(resolveDropperInputMaxTokens(100, 128_000)).toBe(1_000);
    expect(resolveObservationsPoolMaxTokens(0, 500)).toBe(1_000);
  });
});
