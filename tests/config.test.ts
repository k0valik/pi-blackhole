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
    expect(config.compactAfterTokens).toBeUndefined(); // legacy fixed default removed
    expect(config.compactAfterPreset).toBe("default"); // preset curve governs out of the box
    expect(config.compactAfterRatio).toBeUndefined();
    expect(config.compactReserveTokens).toBeUndefined();
    expect(config.compactAfterPresets).toBeUndefined();
    expect(config.retainedToolOutputMaxTokens).toBe(20_000);
    expect(config.observationsPoolMaxTokens).toBe(20_000);
    expect(config.agentMaxTurns).toBe(16);
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

describe("retainedToolOutputMaxTokens", () => {
  const envKey = "PI_BLACKHOLE_RETAINED_TOOL_OUTPUT_MAX_TOKENS";

  afterEach(() => {
    delete process.env[envKey];
  });

  it("accepts a positive file override", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ retainedToolOutputMaxTokens: 12_000 });
    expect(loadUnifiedConfig(testDir).retainedToolOutputMaxTokens).toBe(12_000);
  });

  it("accepts 0 as disabled (opt-out)", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ retainedToolOutputMaxTokens: 0 });
    expect(loadUnifiedConfig(testDir).retainedToolOutputMaxTokens).toBe(0);
  });

  it("rejects negative values", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ retainedToolOutputMaxTokens: -5 });
    expect(loadUnifiedConfig(testDir).retainedToolOutputMaxTokens).toBe(20_000);
  });

  it("accepts a positive environment override", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    process.env[envKey] = "9000";
    expect(loadUnifiedConfig(testDir).retainedToolOutputMaxTokens).toBe(9_000);
  });
});

describe("compactAfterRatio / compactReserveTokens (derived threshold)", () => {
  it('derived knobs default to undefined; preset knob defaults to "default"', async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    const config = loadUnifiedConfig(testDir);
    expect(config.compactAfterRatio).toBeUndefined();
    expect(config.compactReserveTokens).toBeUndefined();
    expect(config.compactAfterTokens).toBeUndefined();
    expect(config.compactAfterPreset).toBe("default");
  });

  it("compactAfterRatio opts into derived mode (default tokens dropped)", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ compactAfterRatio: 0.65 });
    const config = loadUnifiedConfig(testDir);
    expect(config.compactAfterRatio).toBe(0.65);
    expect(config.compactReserveTokens).toBeUndefined();
    expect(config.compactAfterTokens).toBeUndefined();
  });

  it("compactReserveTokens opts into derived mode (default tokens dropped)", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ compactReserveTokens: 32_768 });
    const config = loadUnifiedConfig(testDir);
    expect(config.compactReserveTokens).toBe(32_768);
    expect(config.compactAfterTokens).toBeUndefined();
  });

  it("explicit compactAfterTokens keeps token mode even when a derived knob is set", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ compactAfterTokens: 180_000, compactAfterRatio: 0.65 });
    const config = loadUnifiedConfig(testDir);
    expect(config.compactAfterTokens).toBe(180_000);
    expect(config.compactAfterRatio).toBe(0.65);
  });

  it("a DEFAULT-valued compactAfterTokens in the file does not block derived mode", async () => {
    // scaffoldConfig()/the settings modal write full defaults (81000) into the
    // file — that must not count as an explicit choice, or derived mode could
    // never engage for those users.
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ compactAfterTokens: 81_000, compactAfterRatio: 0.65 });
    const config = loadUnifiedConfig(testDir);
    expect(config.compactAfterTokens).toBeUndefined();
    expect(config.compactAfterRatio).toBe(0.65);
  });

  it("rejects out-of-range ratios (no derived knob; preset governs)", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ compactAfterRatio: 1.5 }); // > 1
    let config = loadUnifiedConfig(testDir);
    expect(config.compactAfterRatio).toBeUndefined();
    expect(config.compactAfterTokens).toBeUndefined();

    writeConfig({ compactAfterRatio: 0 }); // must be > 0
    config = loadUnifiedConfig(testDir);
    expect(config.compactAfterRatio).toBeUndefined();
    expect(config.compactAfterTokens).toBeUndefined();

    writeConfig({ compactAfterRatio: "not-a-number" });
    config = loadUnifiedConfig(testDir);
    expect(config.compactAfterRatio).toBeUndefined();
    expect(config.compactAfterTokens).toBeUndefined();
  });

  it("rejects invalid compactReserveTokens (no derived knob; preset governs)", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ compactReserveTokens: -5 });
    let config = loadUnifiedConfig(testDir);
    expect(config.compactReserveTokens).toBeUndefined();
    expect(config.compactAfterTokens).toBeUndefined();

    writeConfig({ compactReserveTokens: 0 });
    config = loadUnifiedConfig(testDir);
    expect(config.compactReserveTokens).toBeUndefined();
    expect(config.compactAfterTokens).toBeUndefined();

    writeConfig({ compactReserveTokens: 10.5 });
    config = loadUnifiedConfig(testDir);
    expect(config.compactReserveTokens).toBeUndefined();
    expect(config.compactAfterTokens).toBeUndefined();
  });

  it("keeps both derived knobs when both are configured (precedence resolved later)", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ compactAfterRatio: 0.5, compactReserveTokens: 1_000 });
    const config = loadUnifiedConfig(testDir);
    expect(config.compactAfterRatio).toBe(0.5);
    expect(config.compactReserveTokens).toBe(1_000);
    expect(config.compactAfterTokens).toBeUndefined();
  });
});

describe("providerIdleTimeoutMs", () => {
  it("uses the provider default when omitted", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    expect(loadUnifiedConfig(testDir).providerIdleTimeoutMs).toBeUndefined();
  });

  it("accepts a positive timeout", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ providerIdleTimeoutMs: 120_000 });
    expect(loadUnifiedConfig(testDir).providerIdleTimeoutMs).toBe(120_000);
  });

  it("accepts 0 as explicit disabled", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ providerIdleTimeoutMs: 0 });
    expect(loadUnifiedConfig(testDir).providerIdleTimeoutMs).toBe(0);
  });

  it("ignores negative timeouts", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ providerIdleTimeoutMs: -100 });
    expect(loadUnifiedConfig(testDir).providerIdleTimeoutMs).toBeUndefined();
  });
});

describe("dropperPressureThreshold", () => {
  it("defaults to 0.70 when no config file exists", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    const config = loadUnifiedConfig(testDir);
    expect(config.dropperPressureThreshold).toBe(0.7);
  });

  it("can be overridden via config file", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ dropperPressureThreshold: 0.5 });
    const config = loadUnifiedConfig(testDir);
    expect(config.dropperPressureThreshold).toBe(0.5);
  });

  it("falls back to default for invalid values", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ dropperPressureThreshold: 1.5 }); // > 1
    const config = loadUnifiedConfig(testDir);
    expect(config.dropperPressureThreshold).toBe(0.7);
  });

  it("accepts 1.0 to disable pressure-driven dropper", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ dropperPressureThreshold: 1.0 });
    const config = loadUnifiedConfig(testDir);
    expect(config.dropperPressureThreshold).toBe(1.0);
  });
});

describe("dropperPoolFullnessThreshold", () => {
  it("defaults to 0.10 when no config file exists", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    const config = loadUnifiedConfig(testDir);
    expect(config.dropperPoolFullnessThreshold).toBe(0.1);
  });

  it("can be overridden via config file", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ dropperPoolFullnessThreshold: 0.05 });
    const config = loadUnifiedConfig(testDir);
    expect(config.dropperPoolFullnessThreshold).toBe(0.05);
  });

  it("falls back to default for invalid values", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ dropperPoolFullnessThreshold: 1.5 }); // > 1
    const config = loadUnifiedConfig(testDir);
    expect(config.dropperPoolFullnessThreshold).toBe(0.1);
  });

  it("accepts 1.0 to disable the fullness gate", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ dropperPoolFullnessThreshold: 1.0 });
    const config = loadUnifiedConfig(testDir);
    expect(config.dropperPoolFullnessThreshold).toBe(1.0);
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

  it("accepts max thinking level", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({
      observerModel: {
        provider: "openai",
        id: "gpt-5.4",
        thinking: "max",
      },
    });
    const config = loadUnifiedConfig(testDir);
    expect(config.observerModel!.thinking).toBe("max");
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

  it("parses cooldownHours: 0 as valid (cooldown disabled)", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({
      observerModel: {
        provider: "openrouter",
        id: "some-model:free",
        cooldownHours: 0,
      },
    });
    const config = loadUnifiedConfig(testDir);
    expect(config.observerModel!.cooldownHours).toBe(0);
  });

  it("parses fallback model arrays", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({
      observerFallbackModels: [
        { provider: "openrouter", id: "fb1:free", cooldownHours: 6 },
        { provider: "openrouter", id: "fb2:free", cooldownHours: 2 },
      ],
      reflectorFallbackModels: [{ provider: "cerebras", id: "llama-3.3-70b", thinking: "low" }],
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
    writeConfig(
      { compaction: "off", compactionEngine: "pi-default", debug: false },
      "pi-blackhole/pi-blackhole-config.json",
    );
    const config = loadUnifiedConfig(testDir);
    expect(config.compaction).toBe("off");
    expect(config.compactionEngine).toBe("pi-default");
    expect(config.debug).toBe(false);
  });

  it("loads legacy om config from settings.json under pi-blackhole key and migrates", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig(
      {
        "pi-blackhole": {
          passive: true,
          debugLog: true,
          observeAfterTokens: 5_000,
        },
      },
      "settings.json",
    );
    const config = loadUnifiedConfig(testDir);
    expect(config.compaction).toBe("off");
    expect(config.memory).toBe(false);
    expect(config.debugLog).toBe(true);
    expect(config.observeAfterTokens).toBe(5_000);
    expect((config as any).passive).toBeUndefined();
  });

  it("loads from observational-memory legacy key and migrates", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig(
      {
        "observational-memory": {
          passive: true,
        },
      },
      "settings.json",
    );
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

  it("env PI_VCC_OM_PASSIVE=false undoes passive migration", async () => {
    process.env.PI_VCC_OM_PASSIVE = "false";
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ passive: true });
    const config = loadUnifiedConfig(testDir);
    // Falsy env override undoes the passive migration, falling back to defaults
    expect(config.compaction).toBe("auto");
    expect(config.memory).toBe(true);
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

describe("Declarative env overrides apply at runtime", () => {
  afterEach(() => {
    // Clean up every env var this block may set.
    delete process.env.PI_BLACKHOLE_COMPACT_AFTER_TOKENS;
    delete process.env.PI_BLACKHOLE_COMPACT_AFTER_RATIO;
    delete process.env.PI_BLACKHOLE_COMPACT_RESERVE_TOKENS;
    delete process.env.PI_BLACKHOLE_COMPACT_AFTER_PRESET;
    delete process.env.PI_BLACKHOLE_DEBUG;
    delete process.env.PI_BLACKHOLE_DROPPER_PRESSURE_THRESHOLD;
    delete process.env.PI_BLACKHOLE_OBSERVE_AFTER_TOKENS;
  });

  it("int override wins over the file value (runtime path)", async () => {
    process.env.PI_BLACKHOLE_COMPACT_AFTER_TOKENS = "200000";
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ compactAfterTokens: 185_000 });
    const config = loadUnifiedConfig(testDir);
    expect(config.compactAfterTokens).toBe(200_000);
  });

  it("boolean override applies", async () => {
    process.env.PI_BLACKHOLE_DEBUG = "true";
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ debug: false });
    const config = loadUnifiedConfig(testDir);
    expect(config.debug).toBe(true);
  });

  it("invalid int falls back to the configured value", async () => {
    process.env.PI_BLACKHOLE_COMPACT_AFTER_TOKENS = "not-a-number";
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ compactAfterTokens: 185_000 });
    const config = loadUnifiedConfig(testDir);
    expect(config.compactAfterTokens).toBe(185_000);
  });

  it("float override (dropperPressureThreshold) applies", async () => {
    process.env.PI_BLACKHOLE_DROPPER_PRESSURE_THRESHOLD = "0.5";
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ dropperPressureThreshold: 0.7 });
    const config = loadUnifiedConfig(testDir);
    expect(config.dropperPressureThreshold).toBe(0.5);
  });

  it("out-of-range float is rejected (keeps configured value)", async () => {
    process.env.PI_BLACKHOLE_DROPPER_PRESSURE_THRESHOLD = "2.0";
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ dropperPressureThreshold: 0.7 });
    const config = loadUnifiedConfig(testDir);
    expect(config.dropperPressureThreshold).toBe(0.7);
  });

  it("env compactAfterRatio opts into derived mode", async () => {
    process.env.PI_BLACKHOLE_COMPACT_AFTER_RATIO = "0.5";
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    const config = loadUnifiedConfig(testDir);
    expect(config.compactAfterRatio).toBe(0.5);
    expect(config.compactAfterTokens).toBeUndefined();
  });

  it("invalid env compactAfterRatio is rejected (keeps configured state)", async () => {
    process.env.PI_BLACKHOLE_COMPACT_AFTER_RATIO = "1.5";
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    const config = loadUnifiedConfig(testDir);
    expect(config.compactAfterRatio).toBeUndefined();
    expect(config.compactAfterTokens).toBeUndefined();
  });

  it("env compactAfterPreset engages a preset selection", async () => {
    process.env.PI_BLACKHOLE_COMPACT_AFTER_PRESET = "balanced";
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    const config = loadUnifiedConfig(testDir);
    expect(config.compactAfterPreset).toBe("balanced");
  });

  it("blank env compactAfterPreset is ignored (keeps the configured name)", async () => {
    process.env.PI_BLACKHOLE_COMPACT_AFTER_PRESET = "   ";
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ compactAfterPreset: "early" });
    const config = loadUnifiedConfig(testDir);
    expect(config.compactAfterPreset).toBe("early");
  });

  it("env compactReserveTokens opts into derived mode", async () => {
    process.env.PI_BLACKHOLE_COMPACT_RESERVE_TOKENS = "32768";
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    const config = loadUnifiedConfig(testDir);
    expect(config.compactReserveTokens).toBe(32_768);
    expect(config.compactAfterTokens).toBeUndefined();
  });

  it("env compactAfterTokens still wins over a file-derived ratio", async () => {
    process.env.PI_BLACKHOLE_COMPACT_AFTER_TOKENS = "180000";
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ compactAfterRatio: 0.65 });
    const config = loadUnifiedConfig(testDir);
    expect(config.compactAfterTokens).toBe(180_000);
    expect(config.compactAfterRatio).toBe(0.65);
  });
});

describe("Integer fields are validated as positive integers", () => {
  it("rejects negative token values, falls back to defaults", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({
      observeAfterTokens: -100,
      reflectAfterTokens: 0,
      compactAfterTokens: 180_000,
    });
    const config = loadUnifiedConfig(testDir);
    expect(config.observeAfterTokens).toBe(15_000); // blackhole default (upstream is 10_000)
    expect(config.reflectAfterTokens).toBe(25_000); // blackhole default (upstream is 20_000)
    expect(config.compactAfterTokens).toBe(180_000); // explicit non-legacy value survives
  });
});

describe("compactAfterPreset / compactAfterPresets (window-curve presets)", () => {
  it('knob defaults to the built-in "default" preset; definitions surface undefined', async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    const config = loadUnifiedConfig(testDir);
    expect(config.compactAfterPreset).toBe("default");
    expect(config.compactAfterPresets).toBeUndefined();
  });

  it("parses a file preset selection knob (any non-empty name)", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ compactAfterPreset: "early-1m" });
    const config = loadUnifiedConfig(testDir);
    expect(config.compactAfterPreset).toBe("early-1m");
  });

  it("parses preset definitions, dropping invalid anchors and sorting", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({
      compactAfterPresets: {
        mixed: [
          { window: 1_048_576, ratio: 0.4 },
          { window: 32_768, ratio: 0.9 },
          { window: 32_768, ratio: 0.8 }, // duplicate window — last wins
          { window: 0, ratio: 0.5 }, // invalid window — dropped
          { window: 131_072, ratio: 0 }, // invalid ratio — dropped
          { window: 131_072, ratio: 1.2 }, // invalid ratio — dropped
        ],
      },
    });
    const config = loadUnifiedConfig(testDir);
    expect(config.compactAfterPresets).toEqual({
      mixed: [
        { window: 32_768, ratio: 0.8 },
        { window: 1_048_576, ratio: 0.4 },
      ],
    });
  });

  it("drops presets with no valid anchors or a non-array body (warn)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({
      compactAfterPresets: {
        empty: [],
        garbage: "not-an-array",
        bad: [{ window: 0, ratio: 0.5 }],
        good: [{ window: 131_072, ratio: 0.7 }],
      },
    });
    const config = loadUnifiedConfig(testDir);
    expect(config.compactAfterPresets).toEqual({
      good: [{ window: 131_072, ratio: 0.7 }],
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("drops a scaffolded legacy 81000 as default-posture residue", async () => {
    // scaffoldConfig()/the modal used to materialize the old fixed default into
    // the file; 81000 always meant "the default", never a true pin — it now
    // yields to the built-in preset curve (spec §10).
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ compactAfterTokens: 81_000 });
    const config = loadUnifiedConfig(testDir);
    expect(config.compactAfterTokens).toBeUndefined();
    expect(config.compactAfterPreset).toBe("default");
  });

  it("keeps an explicit non-legacy fixed token threshold", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ compactAfterTokens: 80_000 });
    const config = loadUnifiedConfig(testDir);
    expect(config.compactAfterTokens).toBe(80_000);
  });

  it("scaffolded 81000 still yields to a file-derived ratio (issue #60 parity)", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ compactAfterTokens: 81_000, compactAfterRatio: 0.65 });
    const config = loadUnifiedConfig(testDir);
    expect(config.compactAfterRatio).toBe(0.65);
    expect(config.compactAfterTokens).toBeUndefined();
  });

  it("an env-set compactAfterTokens is never treated as residue", async () => {
    process.env.PI_BLACKHOLE_COMPACT_AFTER_TOKENS = "81000";
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({});
    const config = loadUnifiedConfig(testDir);
    expect(config.compactAfterTokens).toBe(81_000);
    delete process.env.PI_BLACKHOLE_COMPACT_AFTER_TOKENS;
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
