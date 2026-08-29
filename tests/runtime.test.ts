/**
 * Runtime model resolution tests — fallback chain + cooldown.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `pi-blackhole-runtime-test-${Date.now()}`);

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => testDir,
  estimateTokens: () => 250, // ~1 token per 4 chars
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function writeConfig(
  data: unknown,
  filename = "pi-blackhole/pi-blackhole-config.json",
): string {
  const dir = join(testDir, dirname(filename));
  mkdirSync(dir, { recursive: true });
  const path = join(testDir, filename);
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
}

function cooldownFile() {
  return join(testDir, "pi-blackhole", "pi-blackhole-cooldown.json");
}

function readCooldownFile(): Record<string, unknown> {
  const p = cooldownFile();
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf-8"));
}

function makeModel(
  id: string,
  provider = "openrouter",
  overrides: Record<string, unknown> = {},
) {
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
    ...overrides,
  };
}

type RegistryOptions = {
  requestBaseUrl?: string;
  providerBaseUrl?: string;
  env?: Record<string, string>;
};

function makeRegistry(
  models: ReturnType<typeof makeModel>[],
  options: RegistryOptions = {},
) {
  return {
    models,
    find: vi.fn((p: string, id: string) =>
      models.find((m) => m.provider === p && m.id === id),
    ),
    hasConfiguredAuth: vi.fn(() => true),
    getApiKeyAndHeaders: vi.fn(async () => ({
      ok: true,
      apiKey: "sk-test",
      headers: undefined,
      ...(options.env ? { env: options.env } : {}),
      ...(options.requestBaseUrl ? { baseUrl: options.requestBaseUrl } : {}),
    })),
    getProviderAuth: vi.fn(async () =>
      options.providerBaseUrl
        ? { auth: { baseUrl: options.providerBaseUrl } }
        : undefined,
    ),
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
  it("forwards environment substitutions from model auth", async () => {
    writeConfig({
      observerModel: { provider: "cloudflare-workers-ai", id: "model" },
    });
    const model = makeModel("model", "cloudflare-workers-ai");
    const registry = makeRegistry([model], {
      env: { CLOUDFLARE_ACCOUNT_ID: "account-123" },
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: registry,
      hasUI: false,
      stageModel: { provider: "cloudflare-workers-ai", id: "model" },
    });

    expect(result).toMatchObject({
      ok: true,
      env: { CLOUDFLARE_ACCOUNT_ID: "account-123" },
    });
  });

  it("refreshes a stale ambient credential snapshot once", async () => {
    writeConfig({
      observerModel: { provider: "amazon-bedrock", id: "model" },
    });
    const model = makeModel("model", "amazon-bedrock");
    let configured = false;
    const registry = {
      ...makeRegistry([model]),
      hasConfiguredAuth: vi.fn(() => configured),
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true })),
      refresh: vi.fn(async () => {
        configured = true;
      }),
      isUsingOAuth: vi.fn(() => false),
    };
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: registry,
      hasUI: false,
      stageModel: { provider: "amazon-bedrock", id: "model" },
    });

    expect(result.ok).toBe(true);
    expect(registry.refresh).toHaveBeenCalledWith(
      expect.objectContaining({
        allowNetwork: false,
        providers: ["amazon-bedrock"],
      }),
    );
  });
  it("resolves primary stage model when available", async () => {
    writeConfig({
      observerModel: { provider: "openrouter", id: "primary-model:free" },
      observerFallbackModels: [
        { provider: "openrouter", id: "fallback-model:free" },
      ],
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
  it("preserves a credential-resolved endpoint from provider auth on configured candidate", async () => {
    writeConfig({
      observerModel: {
        provider: "github-copilot",
        id: "gpt-5.6-luna",
      },
    });
    const model = makeModel("gpt-5.6-luna", "github-copilot", {
      baseUrl: "https://api.individual.githubcopilot.com",
    });
    const registry = makeRegistry([model], {
      providerBaseUrl: "https://api.enterprise.githubcopilot.com",
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: registry,
      hasUI: false,
      stageModel: {
        provider: "github-copilot",
        id: "gpt-5.6-luna",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.baseUrl).toBe(
        "https://api.enterprise.githubcopilot.com",
      );
    }
    expect(registry.getProviderAuth).toHaveBeenCalledWith("github-copilot");
  });

  it("falls back to provider auth for registries without request baseUrl", async () => {
    writeConfig({
      observerModel: {
        provider: "github-copilot",
        id: "cooled-model",
        cooldownHours: 24,
      },
    });
    const { recordCooldown } = await import("../src/om/cooldown.js");
    recordCooldown(
      {
        provider: "github-copilot",
        id: "cooled-model",
        cooldownHours: 24,
      },
      "test cooldown",
      "observer",
    );
    const sessionModel = makeModel("session-model", "github-copilot", {
      baseUrl: "https://api.individual.githubcopilot.com",
    });
    const registry = makeRegistry([sessionModel], {
      providerBaseUrl: "https://api.enterprise.githubcopilot.com",
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    const result = await runtime.resolveModel({
      model: sessionModel,
      modelRegistry: registry,
      hasUI: false,
      stageModel: {
        provider: "github-copilot",
        id: "cooled-model",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.baseUrl).toBe(
        "https://api.enterprise.githubcopilot.com",
      );
    }
    expect(registry.getProviderAuth).toHaveBeenCalledWith("github-copilot");
  });

  it("returns original model reference when resolved baseUrl equals model.baseUrl", async () => {
    writeConfig({
      observerModel: {
        provider: "github-copilot",
        id: "gpt-5.6-luna",
      },
    });
    const model = makeModel("gpt-5.6-luna", "github-copilot", {
      baseUrl: "https://api.enterprise.githubcopilot.com",
    });
    const registry = makeRegistry([model], {
      providerBaseUrl: "https://api.enterprise.githubcopilot.com",
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: registry,
      hasUI: false,
      stageModel: {
        provider: "github-copilot",
        id: "gpt-5.6-luna",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model).toBe(model);
    }
  });

  it("treats whitespace-only baseUrl from provider auth as absent", async () => {
    writeConfig({
      observerModel: {
        provider: "github-copilot",
        id: "gpt-5.6-luna",
      },
    });
    const model = makeModel("gpt-5.6-luna", "github-copilot", {
      baseUrl: "https://api.individual.githubcopilot.com",
    });
    const registry = makeRegistry([model], {
      providerBaseUrl: "  ",
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: registry,
      hasUI: false,
      stageModel: {
        provider: "github-copilot",
        id: "gpt-5.6-luna",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.baseUrl).toBe(
        "https://api.individual.githubcopilot.com",
      );
      expect(result.model).toBe(model);
    }
  });

  it("gracefully handles getProviderAuth throwing", async () => {
    writeConfig({
      observerModel: {
        provider: "github-copilot",
        id: "gpt-5.6-luna",
      },
    });
    const model = makeModel("gpt-5.6-luna", "github-copilot", {
      baseUrl: "https://api.individual.githubcopilot.com",
    });
    const registry = makeRegistry([model], {});
    registry.getProviderAuth = vi.fn(async () => {
      throw new Error("auth service down");
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: registry,
      hasUI: false,
      stageModel: {
        provider: "github-copilot",
        id: "gpt-5.6-luna",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.baseUrl).toBe(
        "https://api.individual.githubcopilot.com",
      );
      expect(result.model).toBe(model);
    }
  });

  it("skips primary model when in cooldown, uses fallback", async () => {
    writeConfig({
      observerModel: {
        provider: "openrouter",
        id: "primary-model:free",
        cooldownHours: 24,
      },
      observerFallbackModels: [
        { provider: "openrouter", id: "fallback-model:free", cooldownHours: 2 },
      ],
    });

    // Pre-populate cooldown for primary model
    const { recordCooldown } = await import("../src/om/cooldown.js");
    recordCooldown(
      { provider: "openrouter", id: "primary-model:free", cooldownHours: 24 },
      "429 test",
      "observer",
    );

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
      observerModel: {
        provider: "openrouter",
        id: "primary:free",
        cooldownHours: 24,
      },
      observerFallbackModels: [
        { provider: "openrouter", id: "fallback:free", cooldownHours: 24 },
      ],
      model: { provider: "openrouter", id: "base:free", cooldownHours: 1 },
    });

    const { recordCooldown } = await import("../src/om/cooldown.js");
    recordCooldown(
      { provider: "openrouter", id: "primary:free" },
      "429",
      "observer",
    );
    recordCooldown(
      { provider: "openrouter", id: "fallback:free" },
      "429",
      "observer",
    );

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
    recordCooldown(
      { provider: "openrouter", id: "primary:free" },
      "429",
      "observer",
    );

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
    recordCooldown(
      { provider: "openrouter", id: "primary:free" },
      "429",
      "observer",
    );

    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    const registry = makeRegistry([makeModel("primary:free", "openrouter")]);

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
      observerModel: {
        provider: "openrouter",
        id: "primary:free",
        cooldownHours: 0,
      },
      observerFallbackModels: [
        { provider: "openrouter", id: "fallback:free", cooldownHours: 6 },
      ],
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
      stageFallbacks: [
        { provider: "openrouter", id: "fallback:free", cooldownHours: 6 },
      ],
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
      observerModel: {
        provider: "openrouter",
        id: "primary:free",
        cooldownHours: 0,
      },
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

    const registry = makeRegistry([makeModel("primary:free", "openrouter")]);

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
  function createConsolidationContext(
    configOverrides: Record<string, unknown> = {},
  ) {
    let agentStartHandler: ((event: any, ctx: any) => void) | undefined;
    const pi = {
      on: vi.fn((name: string, cb: any) => {
        if (name === "agent_start") agentStartHandler = cb;
      }),
    };
    const launchConsolidationTask = vi.fn();
    const runtime = {
      ensureConfig: vi.fn(),
      resetInfoGate: vi.fn(),
      tryEmitInfo: vi.fn(),
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
          {
            id: "m1",
            type: "message",
            message: {
              role: "user",
              content: [{ type: "text", text: "x".repeat(1000) }],
            },
          },
          {
            id: "m2",
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "y".repeat(1000) }],
            },
          },
        ]),
        getSessionId: vi.fn(() => "test-session"),
      },
    };
    return {
      pi,
      runtime,
      ctx,
      agentStartHandler: () => agentStartHandler!({}, ctx),
    };
  }

  it("T38: memory:false skips consolidation even with sufficient tokens", async () => {
    const { pi, runtime, agentStartHandler } = createConsolidationContext({
      memory: false,
    });
    const { registerConsolidationTrigger } =
      await import("../src/om/consolidation.js");
    registerConsolidationTrigger(pi as any, runtime as any);

    agentStartHandler();

    expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
  });

  it("T39: memory:true + compaction:off runs consolidation", async () => {
    const { pi, runtime, agentStartHandler } = createConsolidationContext({
      memory: true,
      compaction: "off",
    });
    const { registerConsolidationTrigger } =
      await import("../src/om/consolidation.js");
    registerConsolidationTrigger(pi as any, runtime as any);

    agentStartHandler();

    expect(runtime.launchConsolidationTask).toHaveBeenCalled();
  });

  it("T40: passive:true (legacy, no new keys) blocks consolidation via legacy guard", async () => {
    const { pi, runtime, agentStartHandler } = createConsolidationContext({
      passive: true,
      compaction: undefined,
      compactionEngine: undefined,
    });
    const { registerConsolidationTrigger } =
      await import("../src/om/consolidation.js");
    registerConsolidationTrigger(pi as any, runtime as any);

    agentStartHandler();

    expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
  });
});

describe("Runtime — cooldown persistence", () => {
  it("recordCooldown writes to disk", async () => {
    const { recordCooldown } = await import("../src/om/cooldown.js");
    recordCooldown(
      { provider: "openrouter", id: "test-model:free", cooldownHours: 5 },
      "429 Too Many Requests",
      "observer",
    );
    const data = readCooldownFile();
    const key = "openrouter/test-model:free";
    expect(data[key]).toBeDefined();
    expect((data[key] as any).reason).toBe("429 Too Many Requests");
    expect((data[key] as any).stage).toBe("observer");
  });

  it("isCooldownActive returns true for active cooldown", async () => {
    const { recordCooldown, isCooldownActive } =
      await import("../src/om/cooldown.js");
    recordCooldown(
      { provider: "openrouter", id: "cool-model:free", cooldownHours: 24 },
      "429",
      "observer",
    );
    expect(
      isCooldownActive({ provider: "openrouter", id: "cool-model:free" }),
    ).toBe(true);
  });

  it("isCooldownActive returns false when no cooldown entry", async () => {
    const { isCooldownActive } = await import("../src/om/cooldown.js");
    expect(
      isCooldownActive({ provider: "openrouter", id: "never-cooled:free" }),
    ).toBe(false);
  });

  it("expireCooldowns removes expired entries", async () => {
    const { recordCooldown, expireCooldowns, isCooldownActive } =
      await import("../src/om/cooldown.js");
    // Record cooldown with 0 hours → expires immediately
    recordCooldown(
      { provider: "openrouter", id: "expiring:free", cooldownHours: 0 },
      "429",
      "observer",
    );
    // Wait a tick
    await new Promise((r) => setTimeout(r, 10));
    expireCooldowns();
    // Should be expired now
    expect(
      isCooldownActive({ provider: "openrouter", id: "expiring:free" }),
    ).toBe(false);
  });

  it("recordCooldown with cooldownHours: 0 writes nothing to disk", async () => {
    const { recordCooldown } = await import("../src/om/cooldown.js");
    recordCooldown(
      { provider: "openrouter", id: "noop-model:free", cooldownHours: 0 },
      "any error",
      "observer",
    );
    const data = readCooldownFile();
    expect(data["openrouter/noop-model:free"]).toBeUndefined();
    expect(Object.keys(data)).toHaveLength(0);
  });

  it("isCooldownActive with cooldownHours: 0 returns false without disk read", async () => {
    const { isCooldownActive } = await import("../src/om/cooldown.js");
    // No cooldown file exists yet
    expect(
      isCooldownActive({
        provider: "openrouter",
        id: "disabled:free",
        cooldownHours: 0,
      }),
    ).toBe(false);
    // Even with a stale cooldown file, cooldownHours: 0 short-circuits
    const { recordCooldown } = await import("../src/om/cooldown.js");
    recordCooldown(
      { provider: "openrouter", id: "other:free", cooldownHours: 5 },
      "error",
      "observer",
    );
    expect(
      isCooldownActive({
        provider: "openrouter",
        id: "disabled:free",
        cooldownHours: 0,
      }),
    ).toBe(false);
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
      model: undefined,
      modelRegistry: makeRegistry([]),
      hasUI: false,
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
      model: undefined,
      modelRegistry: makeRegistry([]),
      hasUI: false,
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
      model: undefined,
      modelRegistry: makeRegistry([]),
      hasUI: false,
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
      observerModel: {
        provider: "openrouter",
        id: "primary:free",
        cooldownHours: 0,
      },
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
    // The first info notification fires ("failed this cycle"), the
    // second ("sessionFallback disabled") is gated by tryEmitInfo
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]).toEqual([
      expect.stringContaining("failed this cycle"),
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

    const registry = makeRegistry([makeModel("exists:free", "openrouter")]);

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

describe("Runtime.resolveModel — OAuth/ADC auth", () => {
  it("accepts stage candidate with hasConfiguredAuth=true and no static apiKey", async () => {
    writeConfig({
      observerModel: { provider: "vertex", id: "vertex-model" },
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    const registry = {
      models: [makeModel("vertex-model", "vertex", { api: "google-vertex" })],
      find: vi.fn((p: string, id: string) =>
        makeModel(id, p, { api: "google-vertex" }),
      ),
      hasConfiguredAuth: vi.fn(() => true),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true,
        apiKey: undefined,
        headers: undefined,
      })),
    };

    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: registry,
      hasUI: false,
      stageModel: { provider: "vertex", id: "vertex-model" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.id).toBe("vertex-model");
    }
    expect(result.apiKey).toBe(""); // type-safe default when no static key
  });

  it("accepts session model with hasConfiguredAuth=true and no static apiKey", async () => {
    writeConfig({
      observerModel: { provider: "openrouter", id: "primary:free" },
      sessionFallback: true,
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    // Cool down the primary so we fall through to session model
    const { recordCooldown } = await import("../src/om/cooldown.js");
    recordCooldown(
      { provider: "openrouter", id: "primary:free" },
      "429",
      "observer",
    );

    const registry = {
      models: [makeModel("primary:free", "openrouter")],
      find: vi.fn((p: string, id: string) => makeModel(id, p)),
      hasConfiguredAuth: vi.fn(() => true),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true,
        apiKey: undefined,
        headers: undefined,
      })),
    };

    const result = await runtime.resolveModel({
      model: makeModel("session-model", "vertex", { api: "google-vertex" }),
      modelRegistry: registry,
      hasUI: false,
      stageModel: { provider: "openrouter", id: "primary:free" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.id).toBe("session-model");
    }
    expect(result.apiKey).toBe("");
  });

  it("falls through candidate with no configured auth to next candidate", async () => {
    writeConfig({
      observerModel: { provider: "vertex", id: "vertex-no-auth" },
      observerFallbackModels: [{ provider: "openrouter", id: "openrouter-ok" }],
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    const registry = {
      models: [
        makeModel("vertex-no-auth", "vertex", { api: "google-vertex" }),
        makeModel("openrouter-ok", "openrouter"),
      ],
      find: vi.fn((p: string, id: string) => {
        const m = makeModel(id, p);
        if (p === "vertex") m.api = "google-vertex";
        return m;
      }),
      hasConfiguredAuth: vi.fn((m: any) => m.provider === "openrouter"),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true,
        apiKey: "sk-test",
        headers: undefined,
      })),
    };

    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: registry,
      hasUI: false,
      stageModel: { provider: "vertex", id: "vertex-no-auth" },
      stageFallbacks: [{ provider: "openrouter", id: "openrouter-ok" }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.id).toBe("openrouter-ok");
    }
  });

  it("fails session model when it has no configured auth", async () => {
    writeConfig({
      observerModel: { provider: "openrouter", id: "primary:free" },
      sessionFallback: true,
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    // Cool down the primary so we fall through to session model
    const { recordCooldown } = await import("../src/om/cooldown.js");
    recordCooldown(
      { provider: "openrouter", id: "primary:free" },
      "429",
      "observer",
    );

    const registry = {
      models: [makeModel("primary:free", "openrouter")],
      find: vi.fn((p: string, id: string) => makeModel(id, p)),
      hasConfiguredAuth: vi.fn(() => false),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true,
        apiKey: undefined,
        headers: undefined,
      })),
    };

    const result = await runtime.resolveModel({
      model: makeModel("session-model", "vertex", { api: "google-vertex" }),
      modelRegistry: registry,
      hasUI: false,
      stageModel: { provider: "openrouter", id: "primary:free" },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no auth");
  });

  it("rejects candidate when getApiKeyAndHeaders returns ok:false even if hasConfiguredAuth is true", async () => {
    writeConfig({
      observerModel: { provider: "openrouter", id: "primary:free" },
      sessionFallback: true,
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    const registry = makeRegistry([makeModel("primary:free", "openrouter")]);
    // Override: auth call fails — hasConfiguredAuth doesn't bypass ok:false
    registry.getApiKeyAndHeaders = vi.fn(async () => ({
      ok: false,
      error: "network error",
    }));
    registry.hasConfiguredAuth = vi.fn(() => true);

    const result = await runtime.resolveModel({
      model: makeModel("session-model", "openrouter"),
      modelRegistry: registry,
      hasUI: false,
      stageModel: { provider: "openrouter", id: "primary:free" },
    });

    // Candidate rejected (auth.ok:false), then session model also rejected (auth.ok:false)
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no auth");
  });

  it("uses legacy behavior when registry has no hasConfiguredAuth (older pi versions)", async () => {
    writeConfig({
      observerModel: { provider: "openrouter", id: "primary:free" },
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    // Registry without hasConfiguredAuth (pre-0.80.x pi)
    const registry = makeRegistry([makeModel("primary:free", "openrouter")]);
    registry.hasConfiguredAuth = undefined;
    registry.getApiKeyAndHeaders = vi.fn(async () => ({
      ok: true,
      apiKey: "sk-legacy",
      headers: undefined,
    }));

    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: registry,
      hasUI: false,
      stageModel: { provider: "openrouter", id: "primary:free" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.apiKey).toBe("sk-legacy");
    }
  });
});

describe("Runtime pipeline cursors", () => {
  it("starts with no cursors", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    expect(runtime.getCursor("observer")).toBeUndefined();
    expect(runtime.getCursor("reflector")).toBeUndefined();
    expect(runtime.getCursor("dropper")).toBeUndefined();
  });

  it("advances cursor and tracks state", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.advanceCursor("observer", "entry-1", "recorded");
    const cursor = runtime.getCursor("observer");
    expect(cursor).toBeDefined();
    expect(cursor!.entryId).toBe("entry-1");
    expect(cursor!.state).toBe("recorded");
  });

  it("progresses through states correctly", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    // Empty run advances cursor
    runtime.advanceCursor("observer", "entry-2", "empty");
    expect(runtime.getCursor("observer")!.state).toBe("empty");
    // Next run records output
    runtime.advanceCursor("observer", "entry-3", "recorded");
    expect(runtime.getCursor("observer")!.state).toBe("recorded");
    expect(runtime.getCursor("observer")!.entryId).toBe("entry-3");
  });

  it("skipped state is tracked", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.advanceCursor("dropper", "entry-4", "skipped");
    expect(runtime.getCursor("dropper")!.state).toBe("skipped");
  });

  it("each stage cursor is independent", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.advanceCursor("observer", "obs-1", "recorded");
    runtime.advanceCursor("reflector", "ref-1", "empty");
    runtime.advanceCursor("dropper", "drop-1", "skipped");
    expect(runtime.getCursor("observer")!.entryId).toBe("obs-1");
    expect(runtime.getCursor("reflector")!.entryId).toBe("ref-1");
    expect(runtime.getCursor("dropper")!.entryId).toBe("drop-1");
  });
});

it("loads cursors from pending state", async () => {
  const { Runtime } = await import("../src/om/runtime.js");
  // Pre-populate a pending file with cursors
  const pendingDir = join(testDir, "pi-blackhole");
  mkdirSync(pendingDir, { recursive: true });
  const pending = {
    cursors: {
      observer: { entryId: "obs-loaded", state: "recorded" },
      reflector: { entryId: "ref-loaded", state: "empty" },
    },
  };
  writeFileSync(
    join(pendingDir, "test-session-pending.json"),
    JSON.stringify(pending),
  );

  const runtime = new Runtime();
  runtime.loadCursorsFromPending("test-session");
  expect(runtime.getCursor("observer")!.entryId).toBe("obs-loaded");
  expect(runtime.getCursor("observer")!.state).toBe("recorded");
  expect(runtime.getCursor("reflector")!.entryId).toBe("ref-loaded");
  expect(runtime.getCursor("reflector")!.state).toBe("empty");
  expect(runtime.getCursor("dropper")).toBeUndefined();
});

it("saves cursors to pending state", async () => {
  const { Runtime } = await import("../src/om/runtime.js");
  const runtime = new Runtime();
  runtime.advanceCursor("observer", "obs-save", "recorded");
  runtime.advanceCursor("dropper", "drop-save", "skipped");

  // Save cursors synchronously (test helper)
  runtime.saveCursorsToPending("test-session");

  // Read back from file
  const raw = JSON.parse(
    readFileSync(
      join(testDir, "pi-blackhole", "test-session-pending.json"),
      "utf-8",
    ),
  );
  expect(raw.cursors.observer.entryId).toBe("obs-save");
  expect(raw.cursors.observer.state).toBe("recorded");
  expect(raw.cursors.dropper.entryId).toBe("drop-save");
  expect(raw.cursors.dropper.state).toBe("skipped");
  expect(raw.cursors.reflector).toBeUndefined();
});

it("cursor deletion is persisted across save/load", async () => {
  const { Runtime } = await import("../src/om/runtime.js");
  const runtime = new Runtime();
  runtime.advanceCursor("observer", "obs-keep", "recorded");
  runtime.advanceCursor("reflector", "ref-keep", "empty");
  runtime.advanceCursor("dropper", "drop-del", "skipped");
  runtime.saveCursorsToPending("test-session");

  // Simulate validateCursors: after a fork, dropper entryId no longer
  // exists in branch → cursor is deleted from in-memory map.
  delete (runtime as any).cursors.dropper;
  runtime.saveCursorsToPending("test-session");

  // Reload: deletion must be persisted - dropper should be absent.
  // Bug: writePendingCursors does { ...state.cursors, ...cursors }
  // which preserves deleted keys from the old state on disk.
  const fresh = new Runtime();
  fresh.loadCursorsFromPending("test-session");
  expect(fresh.getCursor("observer")!.entryId).toBe("obs-keep");
  expect(fresh.getCursor("reflector")!.entryId).toBe("ref-keep");
  expect(fresh.getCursor("dropper")).toBeUndefined();
});

it("handles corrupt pending file gracefully", async () => {
  const { Runtime } = await import("../src/om/runtime.js");
  const pendingDir = join(testDir, "pi-blackhole");
  mkdirSync(pendingDir, { recursive: true });
  writeFileSync(
    join(pendingDir, "test-session-pending.json"),
    "not valid json",
  );

  const runtime = new Runtime();
  // Should not throw
  expect(() => runtime.loadCursorsFromPending("test-session")).not.toThrow();
  expect(runtime.getCursor("observer")).toBeUndefined();
});

it("handles missing pending file gracefully", async () => {
  const { Runtime } = await import("../src/om/runtime.js");
  const runtime = new Runtime();
  expect(() =>
    runtime.loadCursorsFromPending("nonexistent-session"),
  ).not.toThrow();
  expect(runtime.getCursor("observer")).toBeUndefined();
});
