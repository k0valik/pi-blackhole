/**
 * Thinking-only model entries (issue #153).
 *
 * Allows `{ "thinking": "low" }` without provider/id as a pure
 * thinking-level modifier while the stage tracks the session model.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `pi-blackhole-thinking-only-${Date.now()}-${Math.random()}`);

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => testDir,
  estimateTokens: () => 250,
}));

function writeConfig(data: unknown): void {
  const dir = join(testDir, "pi-blackhole");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pi-blackhole-config.json"), JSON.stringify(data, null, 2));
}

function makeModel(id: string, provider = "openrouter") {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}

function makeRegistry(models: ReturnType<typeof makeModel>[]) {
  return {
    models,
    find: vi.fn((p: string, id: string) => models.find((m) => m.provider === p && m.id === id)),
    hasConfiguredAuth: vi.fn(() => true),
    getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "sk-test", headers: undefined })),
    getProviderAuth: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
});
afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  vi.resetAllMocks();
});

describe("thinking-only model entries", () => {
  it("parses observerModel with only thinking", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ observerModel: { thinking: "low" } });
    const config = loadUnifiedConfig(testDir);
    expect(config.observerModel?.thinking).toBe("low");
    expect(config.observerModel?.provider).toBeUndefined();
    expect(config.observerModel?.id).toBeUndefined();
  });

  it("parses thinking-only for all three stages", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({
      observerModel: { thinking: "low" },
      reflectorModel: { thinking: "medium" },
      dropperModel: { thinking: "off" },
    });
    const config = loadUnifiedConfig(testDir);
    expect(config.observerModel?.thinking).toBe("low");
    expect(config.reflectorModel?.thinking).toBe("medium");
    expect(config.dropperModel?.thinking).toBe("off");
  });

  it("rejects half-present identity even with valid thinking", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ observerModel: { provider: "openai", thinking: "low" } });
    const config = loadUnifiedConfig(testDir);
    expect(config.observerModel).toBeUndefined();
  });

  it("rejects id-only entry even with valid thinking", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ observerModel: { id: "gpt-4o", thinking: "low" } });
    const config = loadUnifiedConfig(testDir);
    expect(config.observerModel).toBeUndefined();
  });

  it("rejects empty and invalid-thinking entries", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ observerModel: {} });
    expect(loadUnifiedConfig(testDir).observerModel).toBeUndefined();
    writeConfig({ observerModel: { thinking: "bogus" } });
    expect(loadUnifiedConfig(testDir).observerModel).toBeUndefined();
  });

  it("full entries still parse unchanged", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({
      observerModel: { provider: "openai", id: "gpt-4o", thinking: "minimal" },
    });
    const config = loadUnifiedConfig(testDir);
    expect(config.observerModel).toMatchObject({
      provider: "openai",
      id: "gpt-4o",
      thinking: "minimal",
    });
  });

  it("thinking-only stage is skipped as candidate and falls back to session model", async () => {
    writeConfig({ observerModel: { thinking: "medium" } });
    const sessionModel = makeModel("session-model", "llama.cpp");
    const registry = makeRegistry([sessionModel]);
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);
    try {
      const result = await runtime.resolveModel({
        model: sessionModel,
        modelRegistry: registry,
        hasUI: false,
        stageModel: runtime.config.observerModel,
        stageFallbacks: [],
      });
      expect(registry.find).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
      if (result.ok && result.source === "session") {
        expect(result.model.id).toBe("session-model");
      } else {
        throw new Error("expected session fallback");
      }
    } finally {
      runtime.dispose();
    }
  });

  it("session fallback still applies stage thinking level", async () => {
    writeConfig({ observerModel: { thinking: "medium" } });
    const { Runtime } = await import("../src/om/runtime.js");
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);
    try {
      // stageThinkingLevel is internal; verify via config shape that the
      // thinking modifier survived load and would be read on session path.
      const config = loadUnifiedConfig(testDir);
      expect(config.observerModel?.thinking).toBe("medium");
      expect(runtime.config.observerModel?.thinking).toBe("medium");
    } finally {
      runtime.dispose();
    }
  });

  it("filters thinking-only entries out of fallback arrays, keeps full entries", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({
      observerFallbackModels: [
        { thinking: "low" },
        { provider: "openai", id: "gpt-4o", thinking: "minimal" },
      ],
    });
    const config = loadUnifiedConfig(testDir);
    // Both parse (array non-empty), runtime skips the partial as candidate.
    expect(config.observerFallbackModels).toHaveLength(2);
    expect(config.observerFallbackModels?.[0].thinking).toBe("low");
    expect(config.observerFallbackModels?.[1].id).toBe("gpt-4o");
  });

  it("thinking-only stage still tries full fallback before session", async () => {
    writeConfig({
      observerModel: { thinking: "medium" },
      observerFallbackModels: [{ provider: "openai", id: "gpt-4o" }],
    });
    const sessionModel = makeModel("session-model", "llama.cpp");
    const fallbackModel = makeModel("gpt-4o", "openai");
    const registry = makeRegistry([fallbackModel, sessionModel]);
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);
    try {
      const result = await runtime.resolveModel({
        model: sessionModel,
        modelRegistry: registry,
        hasUI: false,
        stageModel: runtime.config.observerModel,
        stageFallbacks: runtime.config.observerFallbackModels,
      });
      expect(result.ok).toBe(true);
      if (result.ok && result.source === "candidate") {
        expect(result.candidateConfig.id).toBe("gpt-4o");
      } else {
        throw new Error("expected fallback candidate");
      }
      expect(registry.find).toHaveBeenCalledWith("openai", "gpt-4o");
    } finally {
      runtime.dispose();
    }
  });

  it("thinking-only fallback entries are never passed to the registry", async () => {
    writeConfig({
      observerFallbackModels: [{ thinking: "low" }],
    });
    const sessionModel = makeModel("session-model", "llama.cpp");
    const registry = makeRegistry([sessionModel]);
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);
    try {
      const result = await runtime.resolveModel({
        model: sessionModel,
        modelRegistry: registry,
        hasUI: false,
        stageModel: undefined,
        stageFallbacks: runtime.config.observerFallbackModels,
      });
      expect(result.ok).toBe(true);
      // Only the session model is resolvable; find is never called because
      // the candidate list is empty after filtering.
      expect(registry.find).not.toHaveBeenCalled();
    } finally {
      runtime.dispose();
    }
  });

  it("thinking-only with sessionFallback false skips the stage", async () => {
    writeConfig({ observerModel: { thinking: "medium" }, sessionFallback: false });
    const sessionModel = makeModel("session-model", "llama.cpp");
    const registry = makeRegistry([sessionModel]);
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);
    try {
      const result = await runtime.resolveModel({
        model: sessionModel,
        modelRegistry: registry,
        hasUI: false,
        stageModel: runtime.config.observerModel,
        stageFallbacks: [],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("sessionFallback disabled");
      }
    } finally {
      runtime.dispose();
    }
  });
});

describe("thinking-only stageThinkingLevel precedence", () => {
  it("session path uses stage thinking-only modifier", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { stageThinkingLevel } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    try {
      runtime.config = {
        ...runtime.config,
        observerModel: { thinking: "medium" },
        model: undefined,
      };
      expect(stageThinkingLevel(runtime, "observer", undefined)).toBe("medium");
    } finally {
      runtime.dispose();
    }
  });

  it("running candidate explicit thinking wins over stage modifier", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { stageThinkingLevel } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    try {
      runtime.config = {
        ...runtime.config,
        observerModel: { thinking: "medium" },
        model: undefined,
      };
      expect(
        stageThinkingLevel(runtime, "observer", {
          provider: "openai",
          id: "gpt-4o",
          thinking: "off",
        }),
      ).toBe("off");
    } finally {
      runtime.dispose();
    }
  });

  it("fallback without thinking inherits stage modifier, not default", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { stageThinkingLevel } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    try {
      runtime.config = {
        ...runtime.config,
        observerModel: { thinking: "medium" },
        model: undefined,
      };
      expect(stageThinkingLevel(runtime, "observer", { provider: "openai", id: "gpt-4o" })).toBe(
        "medium",
      );
    } finally {
      runtime.dispose();
    }
  });

  it("base thinking-only modifier supplies fallback level", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { stageThinkingLevel } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    try {
      runtime.config = {
        ...runtime.config,
        observerModel: undefined,
        model: { thinking: "high" },
      };
      expect(stageThinkingLevel(runtime, "observer", undefined)).toBe("high");
    } finally {
      runtime.dispose();
    }
  });

  it("defaults to low when nothing configured", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { stageThinkingLevel } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    try {
      runtime.config = { ...runtime.config, observerModel: undefined, model: undefined };
      expect(stageThinkingLevel(runtime, "observer", undefined)).toBe("low");
    } finally {
      runtime.dispose();
    }
  });
});

describe("cooldown helpers require model identity", () => {
  it("direct cooldown helpers ignore partial model configs", async () => {
    const { isCooldownActive, recordCooldown, getCooldownEntry } =
      await import("../src/om/cooldown.js");
    const partial = { thinking: "low" } as { provider?: string; id?: string; thinking: "low" };
    expect(isCooldownActive(partial as never)).toBe(false);
    expect(getCooldownEntry(partial as never)).toBeUndefined();
    // Must not throw and must not create a cooldown file entry.
    recordCooldown(partial as never, "429 Too Many Requests", "observer");
    expect(isCooldownActive(partial as never)).toBe(false);
  });

  it("recordRetryableError ignores partial configs", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    try {
      expect(() =>
        runtime.recordRetryableError(
          { thinking: "low" } as never,
          new Error("429 Too Many Requests"),
          "observer",
        ),
      ).not.toThrow();
      expect(runtime.failedInCycle.size).toBe(0);
    } finally {
      runtime.dispose();
    }
  });
});
