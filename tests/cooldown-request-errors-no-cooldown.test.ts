/** Real pipeline, resolver and disk persistence; only workers and host directory are faked. */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/om/runtime.js";
import { makeModelResolver, runConsolidationPipeline } from "../src/om/consolidation.js";
import { createExtensionApiDouble } from "./fixtures/pi-extension-api.js";
import { observation, observationsRecordedEntry, rawMessage } from "./fixtures/session.js";

const host = vi.hoisted(() => ({ dir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getAgentDir: () => {
    if (!host.dir) throw new Error("probe agent dir not initialized");
    return host.dir;
  },
}));
const workers = vi.hoisted(() => ({ observer: vi.fn(), reflector: vi.fn(), dropper: vi.fn() }));
vi.mock("../src/om/agents/observer/agent.js", () => ({ runObserver: workers.observer }));
vi.mock("../src/om/agents/reflector/agent.js", () => ({ runReflector: workers.reflector }));
vi.mock("../src/om/agents/dropper/agent.js", () => ({ runDropper: workers.dropper }));

type Stage = "observer" | "reflector" | "dropper";
type Entry = { until: string; reason: string; stage: Stage };
const identity = { provider: "probe", id: "compactor" };
const key = "probe/compactor";
const now = new Date("2026-10-16T00:00:00.000Z");
function cooldowns(): Record<string, Entry> {
  const file = join(host.dir, "pi-blackhole/pi-blackhole-cooldown.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}
function fixture(stage: Stage = "observer", contextWindow = 1_000_000) {
  const runtime = new Runtime(host.dir);
  runtime.configLoaded = true;
  Object.assign(runtime.config, {
    memory: true,
    model: identity,
    observerModel: undefined,
    reflectorModel: undefined,
    dropperModel: undefined,
    observerFallbackModels: [identity],
    reflectorFallbackModels: [identity],
    dropperFallbackModels: [identity],
    sessionFallback: false,
    observeAfterTokens: stage === "observer" ? 100 : 100_000,
    reflectAfterTokens: stage === "observer" ? 1_000_000 : 100,
    observationsPoolMaxTokens: 1_000,
    dropperPoolFullnessThreshold: 0.1,
  });
  const entries = [rawMessage("source", "x".repeat(40_000))];
  if (stage !== "observer") {
    entries.push(
      observationsRecordedEntry("obs", {
        observations: [
          observation("aaaaaaaaaaaa", {
            content: "stored fact ".repeat(100),
            sourceEntryIds: ["source"],
            tokenCount: 500,
          }),
        ],
        coversUpToId: "source",
      }),
    );
  }
  if (stage === "dropper") runtime.advanceCursor("reflector", "source", "empty");
  const model = { ...identity, contextWindow, maxTokens: 16_384 };
  const ctx = {
    cwd: host.dir,
    hasUI: false,
    model: undefined,
    modelRegistry: {
      find: () => model,
      hasConfiguredAuth: () => true,
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "fake-probe-key" }),
    },
    sessionManager: { getBranch: () => entries, getSessionId: () => "cooldown-probe" },
  };
  const generation = runtime.captureGeneration("cooldown-probe");
  return {
    runtime,
    ctx,
    generation,
    run: () => runConsolidationPipeline(createExtensionApiDouble(), runtime, ctx, generation),
  };
}

beforeEach(() => {
  host.dir = mkdtempSync(join(tmpdir(), "blackhole-cooldown-probe-"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  workers.observer
    .mockReset()
    .mockResolvedValue({ observations: [], emptyReason: { kind: "no_new_content" } });
  workers.reflector.mockReset().mockResolvedValue({ reflections: [] });
  workers.dropper.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(host.dir, { recursive: true, force: true });
  host.dir = "";
});

describe("request-local cooldown isolation", () => {
  const requestErrors = [
    new Error(
      'Observer API error: {"error":{"code":400,"message":"The input token count (265330) exceeds the maximum number of tokens allowed (262144)","status":"INVALID_ARGUMENT"}}',
    ),
    new Error(
      'Observer API error: got status: INVALID_ARGUMENT. {"error":{"code":400,"message":"invalid thinking level","status":"INVALID_ARGUMENT"}}',
    ),
    // Exact pi-ai flattened body forms; see linked primary reports in the classifier.
    new Error(
      'Observer API error: 400: {"message":"Unsupported value: \'reasoning_effort\' does not support \'xhigh\' with this model.","type":"invalid_request_error","param":null,"code":"unsupported_value"}',
    ),
    new Error(
      'Observer API error: OpenAI API error (400): {"message":"Unsupported value: \'none\' is not supported with the \'gpt-6-astra\' model.","param":"reasoning.effort","code":"unsupported_value"}',
    ),
    // Provider error text survives workerStreamErrorMessage; SDK fields do not.
    new Error(
      "Observer API error: 400 Unsupported value: 'reasoning_effort' does not support 'xhigh' with this model.",
    ),
    new Error(
      'Reflector API error: 400 {"error":{"message":"Unsupported value","param":"reasoning.effort","code":"unsupported_value"}}',
    ),
    new Error(
      "Observer API error: OpenAI API error (400): Your input exceeds the context window of this model",
    ),
    new Error("400 Input length (265330) exceeds model's maximum context length (262144)."),

    new Error("HTTP 400 Bad Request: payload too large"),
    new Error("HTTP 400 Bad Request: invalid thinking level"),
    new Error("HTTP 400 Bad Request: maximum context length is 8192 tokens"),
    new Error('400 {"error":{"code":"context_length_exceeded","message":"too long"}}'),
    Object.assign(new Error("Unsupported value"), {
      status: 400,
      error: { param: "reasoning_effort", code: "unsupported_value" },
    }),
    Object.assign(new Error("Request rejected"), { status: 413 }),
  ];
  test.each(requestErrors)(
    "candidate request incompatibility is not provider unavailability: %s",
    async (error) => {
      const f = fixture();
      workers.observer.mockRejectedValue(error);
      await f.run();
      expect(workers.observer).toHaveBeenCalledOnce();
      expect(cooldowns()).toEqual({});
      expect(f.runtime.failedInCycle.has(key)).toBe(true);
      f.runtime.failedInCycle.clear();
      expect(await makeModelResolver(f.runtime, f.ctx, f.generation)("dropper")).toBeDefined();
    },
  );
  test.each(requestErrors)("session request incompatibility skips in-cycle too: %s", (error) => {
    const f = fixture();
    f.runtime.recordDeterministicError(identity, error, "observer");
    expect(cooldowns()).toEqual({});
    expect(f.runtime.failedInCycle.has(key)).toBe(true);
  });
  test.each([
    "HTTP 401 Unauthorized",
    "HTTP 404 model not found",
    "HTTP 503 Service Unavailable",
    "ECONNRESET",
    '400: {"type":"MissingSessionID","message":"Request is missing x-opencode-session"}',
    "HTTP 400 Bad Request",
    "400 status code (no body)",
    "503 Service Unavailable: upstream status 400: prompt is too long",
    "HTTP 503 Service Unavailable: upstream status 400: prompt is too long",
    "HTTP 422 invalid provider configuration",
    "HTTP 401 Unauthorized: payload too large",
    "HTTP 503 invalid thinking level",
    "HTTP 400 Bad Request: context service unavailable",
  ])("does not blindly suppress status codes or keywords: %s", (message) => {
    const f = fixture();
    f.runtime.recordRetryableError(identity, new Error(message), "observer");
    expect(cooldowns()[key]?.until).toBe("2026-10-16T01:00:00.000Z");
  });
  test("a useful close is kept without a misleading cooldown notice", async () => {
    const f = fixture();
    const notify = vi.fn();
    const ctx = { ...f.ctx, hasUI: true, ui: { notify } };
    workers.observer.mockResolvedValue({
      observations: [observation("bbbbbbbbbbbb", { sourceEntryIds: ["source"] })],
      errorAfterClose: "HTTP 400 Bad Request: payload too large",
    });
    await runConsolidationPipeline(createExtensionApiDouble(), f.runtime, ctx, f.generation);
    expect(workers.observer).toHaveBeenCalledOnce();
    expect(f.runtime.getCursor("observer")?.state).toBe("recorded");
    expect(cooldowns()).toEqual({});
    expect(notify.mock.calls.some(([message]) => message.includes("model cooled down"))).toBe(
      false,
    );
  });
});
