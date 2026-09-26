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
    expect(config.compaction).toBe("automatic");
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
    expect(config.showWorkerNotifications).toBe(true);
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
    expect(config.compactAfterRatio).toBe(65);
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
    expect(config.compactAfterRatio).toBe(65);
  });

  it("a DEFAULT-valued compactAfterTokens in the file does not block derived mode", async () => {
    // scaffoldConfig()/the settings modal write full defaults (81000) into the
    // file — that must not count as an explicit choice, or derived mode could
    // never engage for those users.
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ compactAfterTokens: 81_000, compactAfterRatio: 65 });
    const config = loadUnifiedConfig(testDir);
    expect(config.compactAfterTokens).toBeUndefined();
    expect(config.compactAfterRatio).toBe(65);
  });

  it("rejects out-of-range ratios (no derived knob; preset governs)", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ compactAfterRatio: 101 }); // > 100
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
    expect(config.compactAfterRatio).toBe(50);
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

describe("workerAttemptTimeoutMs", () => {
  it("leaves the hard deadline disabled when omitted", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    expect(loadUnifiedConfig(testDir).workerAttemptTimeoutMs).toBeUndefined();
  });

  it("accepts a positive hard deadline", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ workerAttemptTimeoutMs: 15_000 });
    expect(loadUnifiedConfig(testDir).workerAttemptTimeoutMs).toBe(15_000);
  });

  it("accepts 0 as explicit disabled", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ workerAttemptTimeoutMs: 0 });
    expect(loadUnifiedConfig(testDir).workerAttemptTimeoutMs).toBe(0);
  });

  it("ignores negative hard deadlines", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ workerAttemptTimeoutMs: -100 });
    expect(loadUnifiedConfig(testDir).workerAttemptTimeoutMs).toBeUndefined();
  });

  it("rejects a file value above Node's maximum timer delay", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ workerAttemptTimeoutMs: 2_147_483_648 });
    expect(loadUnifiedConfig(testDir).workerAttemptTimeoutMs).toBeUndefined();
  });

  it("accepts the maximum timer delay exactly", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ workerAttemptTimeoutMs: 2_147_483_647 });
    expect(loadUnifiedConfig(testDir).workerAttemptTimeoutMs).toBe(2_147_483_647);
  });

  it("rejects a non-integer value", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ workerAttemptTimeoutMs: 1.5 });
    expect(loadUnifiedConfig(testDir).workerAttemptTimeoutMs).toBeUndefined();
  });
});

describe("showWorkerNotifications", () => {
  it("defaults to true when no config file exists", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    expect(loadUnifiedConfig(testDir).showWorkerNotifications).toBe(true);
  });

  it("honors an explicit false from the config file", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ showWorkerNotifications: false });
    expect(loadUnifiedConfig(testDir).showWorkerNotifications).toBe(false);
  });

  it("ignores a non-boolean file value", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ showWorkerNotifications: "no" });
    expect(loadUnifiedConfig(testDir).showWorkerNotifications).toBe(true);
  });

  it("env override wins over the file value", async () => {
    process.env.PI_BLACKHOLE_SHOW_WORKER_NOTIFICATIONS = "false";
    try {
      const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
      writeConfig({ showWorkerNotifications: true });
      expect(loadUnifiedConfig(testDir).showWorkerNotifications).toBe(false);
    } finally {
      delete process.env.PI_BLACKHOLE_SHOW_WORKER_NOTIFICATIONS;
    }
  });
});

describe("cacheRetention", () => {
  const envKey = "PI_BLACKHOLE_CACHE_RETENTION";
  const mgrDir = join(testDir, "mgr-cache-retention");

  afterEach(() => {
    delete process.env[envKey];
    rmSync(mgrDir, { recursive: true, force: true });
  });

  async function modalCacheRetention(data: Record<string, unknown>): Promise<unknown> {
    const { config } = await import("../src/pi-base/blackhole-settings.js");
    mkdirSync(mgrDir, { recursive: true });
    writeFileSync(join(mgrDir, "pi-blackhole-config.json"), JSON.stringify(data, null, 2));
    const loaded = config.loadWithWarnings(undefined, mgrDir).config as {
      cacheRetention?: unknown;
    };
    return loaded.cacheRetention;
  }

  it("stays unset by default so pi's own retention applies", async () => {
    const { loadUnifiedConfig, DEFAULTS } = await import("../src/core/unified-config.js");
    expect(DEFAULTS.cacheRetention).toBeUndefined();
    expect(loadUnifiedConfig(testDir).cacheRetention).toBeUndefined();
  });

  it("accepts every supported retention value from the file", async () => {
    const { loadUnifiedConfig, CACHE_RETENTION_VALUES } =
      await import("../src/core/unified-config.js");
    for (const cacheRetention of CACHE_RETENTION_VALUES) {
      writeConfig({ cacheRetention });
      expect(loadUnifiedConfig(testDir).cacheRetention).toBe(cacheRetention);
    }
  });

  it("ignores an unsupported file value", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ cacheRetention: "forever" });
    expect(loadUnifiedConfig(testDir).cacheRetention).toBeUndefined();
  });

  it("normalizes letter case from the file", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ cacheRetention: "LONG" });
    expect(loadUnifiedConfig(testDir).cacheRetention).toBe("long");
  });

  it("normalizes letter case from the env var", async () => {
    process.env[envKey] = "LoNg";
    try {
      const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
      writeConfig({ cacheRetention: "none" });
      expect(loadUnifiedConfig(testDir).cacheRetention).toBe("long");
    } finally {
      delete process.env[envKey];
    }
  });

  it("normalizes letter case on the settings-modal loader too", async () => {
    expect(await modalCacheRetention({ cacheRetention: "SHORT" })).toBe("short");
  });

  it("env override wins over the file value", async () => {
    process.env[envKey] = "long";
    try {
      const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
      writeConfig({ cacheRetention: "none" });
      expect(loadUnifiedConfig(testDir).cacheRetention).toBe("long");
    } finally {
      delete process.env[envKey];
    }
  });

  it("an unsupported env value leaves the file value in place", async () => {
    process.env[envKey] = "forever";
    try {
      const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
      writeConfig({ cacheRetention: "short" });
      expect(loadUnifiedConfig(testDir).cacheRetention).toBe("short");
    } finally {
      delete process.env[envKey];
    }
  });

  it("resolves identically on the file loader and the settings-modal loader", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    for (const data of [
      { cacheRetention: "long" },
      { cacheRetention: "forever" },
      // Modal "unset" sentinel must never survive into an effective value.
      { cacheRetention: "unset" },
      {},
    ]) {
      writeConfig(data);
      const viaFileLoader = loadUnifiedConfig(testDir).cacheRetention;
      expect(await modalCacheRetention(data)).toBe(viaFileLoader);
    }
    writeConfig({ cacheRetention: "long" });
    expect(await modalCacheRetention({ cacheRetention: "long" })).toBe("long");
  });
});

describe("dropperPressureThreshold", () => {
  it("defaults to 0.70 when no config file exists", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    const config = loadUnifiedConfig(testDir);
    expect(config.dropperPressureThreshold).toBe(0.7);
  });

  it.each([0.01, 0.1, 0.25, 0.5, 0.6, 0.7, 0.9, 0.99, 1])(
    "round-trips a valid fraction %s",
    async (threshold) => {
      const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
      writeConfig({ dropperPressureThreshold: threshold });
      expect(loadUnifiedConfig(testDir).dropperPressureThreshold).toBe(threshold);
    },
  );

  it.each([1.0001, 1.5, 2, 0, -0.1])("falls back to default for invalid value %s", async (v) => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ dropperPressureThreshold: v });
    expect(loadUnifiedConfig(testDir).dropperPressureThreshold).toBe(0.7);
  });

  it("accepts 1.0 to disable pressure-driven dropper", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ dropperPressureThreshold: 1.0 });
    const config = loadUnifiedConfig(testDir);
    expect(config.dropperPressureThreshold).toBe(1.0);
  });
});

describe("dropperPoolFullnessThreshold (removed in plan-09 §3.3)", () => {
  it("is ignored now that the two dropper fractions are merged", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ dropperPoolFullnessThreshold: 0.05 });
    const config = loadUnifiedConfig(testDir);
    expect((config as Record<string, unknown>).dropperPoolFullnessThreshold).toBeUndefined();
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
    // Legacy overrideDefaultCompaction:true → compaction:automatic + tailBehavior:minimal
    expect(config.compaction).toBe("automatic");
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
    delete process.env.PI_BLACKHOLE_COMPACTION_ENGINE;
    delete process.env.PI_BLACKHOLE_COMPACTION;
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
    expect(config.compaction).toBe("automatic");
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

  it("falsy PI_VCC_OM_PASSIVE undoes a project-layer passive:true", async () => {
    process.env.PI_VCC_OM_PASSIVE = "false";
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ passive: true }, ".pi/pi-blackhole-config.json");
    const config = loadUnifiedConfig(testDir);
    expect(config.compaction).toBe("automatic");
    expect(config.memory).toBe(true);
  });

  it("legacy PI_BLACKHOLE_COMPACTION_ENGINE=pi-default still keeps blackhole out", async () => {
    process.env.PI_BLACKHOLE_COMPACTION_ENGINE = "pi-default";
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({});
    const config = loadUnifiedConfig(testDir);
    expect(config.compaction).toBe("off");
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
    delete process.env.PI_BLACKHOLE_WORKER_ATTEMPT_TIMEOUT_MS;
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

  it("worker attempt timeout env override wins over the file value", async () => {
    process.env.PI_BLACKHOLE_WORKER_ATTEMPT_TIMEOUT_MS = "15000";
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ workerAttemptTimeoutMs: 60_000 });
    const config = loadUnifiedConfig(testDir);
    expect(config.workerAttemptTimeoutMs).toBe(15_000);
  });

  it("worker attempt timeout env override accepts 0 as disabled", async () => {
    process.env.PI_BLACKHOLE_WORKER_ATTEMPT_TIMEOUT_MS = "0";
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ workerAttemptTimeoutMs: 60_000 });
    const config = loadUnifiedConfig(testDir);
    expect(config.workerAttemptTimeoutMs).toBe(0);
  });

  it("invalid worker attempt timeout env override keeps the file value", async () => {
    process.env.PI_BLACKHOLE_WORKER_ATTEMPT_TIMEOUT_MS = "soon";
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ workerAttemptTimeoutMs: 60_000 });
    const config = loadUnifiedConfig(testDir);
    expect(config.workerAttemptTimeoutMs).toBe(60_000);
  });

  it("env override above the timer maximum keeps the file value", async () => {
    process.env.PI_BLACKHOLE_WORKER_ATTEMPT_TIMEOUT_MS = "2147483648";
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ workerAttemptTimeoutMs: 60_000 });
    const config = loadUnifiedConfig(testDir);
    expect(config.workerAttemptTimeoutMs).toBe(60_000);
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
    expect(config.compactAfterRatio).toBe(50);
    expect(config.compactAfterTokens).toBeUndefined();
  });

  it("invalid env compactAfterRatio is rejected (keeps configured state)", async () => {
    process.env.PI_BLACKHOLE_COMPACT_AFTER_RATIO = "150";
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
    expect(config.compactAfterRatio).toBe(65);
  });

  it("lets a project layer's threshold shape override the global one", async () => {
    // Layer merge is override semantics: the project's selector is authoritative,
    // so a project reserve is not silently outranked by a global token pin.
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ compactAfterTokens: 100_000 });
    writeConfig({ compactReserveTokens: 32_768 }, ".pi/pi-blackhole-config.json");
    const config = loadUnifiedConfig(testDir);
    expect(config.compactAfterBy).toBe("reserve");
    expect(config.compactReserveTokens).toBe(32_768);
  });

  it("lets a project-supplied threshold value select its shape over a global selector", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ compactAfterBy: "percent", compactAfterRatio: 50 });
    writeConfig({ compactAfterTokens: 150_000 }, ".pi/pi-blackhole-config.json");
    const config = loadUnifiedConfig(testDir);
    expect(config.compactAfterBy).toBe("tokens");
    expect(config.compactAfterTokens).toBe(150_000);
  });

  it("preserves a valid global selector when the project supplies no threshold", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ compactAfterBy: "percent", compactAfterRatio: 50 });
    writeConfig({ memory: false }, ".pi/pi-blackhole-config.json");
    const config = loadUnifiedConfig(testDir);
    expect(config.compactAfterBy).toBe("percent");
    expect(config.compactAfterRatio).toBe(50);
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
    expect(config.compactAfterRatio).toBe(65);
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

describe("loader parity: file bytes → same effective threshold on both loaders", () => {
  // The runtime hot paths use loadUnifiedConfig, but a settings-modal save
  // repopulates runtime.config through the ConfigManager path
  // (config.loadWithWarnings). Both must resolve the same threshold for the
  // same file, or behavior flaps between a modal save and the next restart.
  const mgrDir = join(testDir, "mgr-parity");
  const envKeys = [
    "PI_BLACKHOLE_COMPACT_AFTER_TOKENS",
    "PI_BLACKHOLE_COMPACT_AFTER_RATIO",
    "PI_BLACKHOLE_COMPACT_RESERVE_TOKENS",
    "PI_BLACKHOLE_COMPACT_AFTER_PRESET",
  ];

  async function thresholdsForFile(data: Record<string, unknown>): Promise<{
    viaFileLoader: number;
    viaModalLoader: number;
  }> {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    const { config } = await import("../src/pi-base/blackhole-settings.js");
    const { autoCompactThreshold } = await import("../src/om/model-budget.js");
    writeConfig(data);
    mkdirSync(mgrDir, { recursive: true });
    writeFileSync(join(mgrDir, "pi-blackhole-config.json"), JSON.stringify(data, null, 2));
    // undefined model → 128k fallback window on both paths.
    return {
      viaFileLoader: autoCompactThreshold(loadUnifiedConfig(testDir), undefined),
      viaModalLoader: autoCompactThreshold(
        config.loadWithWarnings(undefined, mgrDir).config as never,
        undefined,
      ),
    };
  }

  beforeEach(() => {
    for (const k of envKeys) delete process.env[k];
  });

  afterEach(() => {
    for (const k of envKeys) delete process.env[k];
  });

  it("empty file resolves to the default preset curve on both loaders", async () => {
    const t = await thresholdsForFile({});
    expect(t.viaFileLoader).toBe(102_800);
    expect(t.viaModalLoader).toBe(t.viaFileLoader);
  });

  it("zeroed knobs (modal 'not set') resolve to the preset curve on both loaders", async () => {
    const t = await thresholdsForFile({
      compactAfterTokens: 0,
      compactAfterRatio: 0,
      compactReserveTokens: 0,
    });
    expect(t.viaFileLoader).toBe(102_800);
    expect(t.viaModalLoader).toBe(t.viaFileLoader);
  });

  it("legacy 81000 residue resolves to the preset curve on both loaders", async () => {
    const t = await thresholdsForFile({ compactAfterTokens: 81_000 });
    expect(t.viaFileLoader).toBe(102_800);
    expect(t.viaModalLoader).toBe(t.viaFileLoader);
  });

  it("out-of-range ratio resolves to the preset curve on both loaders", async () => {
    const t = await thresholdsForFile({ compactAfterRatio: 101 });
    expect(t.viaFileLoader).toBe(102_800);
    expect(t.viaModalLoader).toBe(t.viaFileLoader);
  });

  it("valid knobs resolve identically on both loaders", async () => {
    expect((await thresholdsForFile({ compactAfterTokens: 180_000 })).viaModalLoader).toBe(180_000);
    const ratio = await thresholdsForFile({ compactAfterRatio: 65 });
    expect(ratio.viaFileLoader).toBe(83_200);
    expect(ratio.viaModalLoader).toBe(ratio.viaFileLoader);
    const reserve = await thresholdsForFile({ compactReserveTokens: 32_768 });
    expect(reserve.viaFileLoader).toBe(95_232);
    expect(reserve.viaModalLoader).toBe(reserve.viaFileLoader);
  });

  it("invalid preset definitions fall back to the built-in curve on both loaders", async () => {
    const t = await thresholdsForFile({
      compactAfterPresets: { broken: [{ window: -1, ratio: 5 }] },
    });
    expect(t.viaFileLoader).toBe(102_800);
    expect(t.viaModalLoader).toBe(t.viaFileLoader);
  });

  it("unsorted hand-edited anchors resolve identically on both loaders", async () => {
    const t = await thresholdsForFile({
      compactAfterPreset: "custom",
      compactAfterPresets: {
        custom: [
          { window: 262_144, ratio: 0.7 },
          { window: 32_768, ratio: 0.9 },
        ],
      },
    });
    expect(t.viaFileLoader).toBe(104_571);
    expect(t.viaModalLoader).toBe(t.viaFileLoader);
  });
});

describe("configFileNeedsMigration", () => {
  it("treats compactionEngine as a legacy key, not a new one", async () => {
    const { configFileNeedsMigration } = await import("../src/core/unified-config.js");
    writeConfig({ compactionEngine: "pi-default" });
    expect(configFileNeedsMigration()).toBe(true);
  });

  it("returns false once a new key is present", async () => {
    const { configFileNeedsMigration } = await import("../src/core/unified-config.js");
    writeConfig({ compaction: "off" });
    expect(configFileNeedsMigration()).toBe(false);
  });

  it("returns true for a legacy value that still needs repairing", async () => {
    const { configFileNeedsMigration } = await import("../src/core/unified-config.js");
    writeConfig({ compactAfterRatio: 0.8 }); // fraction -> percent + selector
    expect(configFileNeedsMigration()).toBe(true);
  });
});
