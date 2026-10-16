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

describe("local failure cooldown isolation", () => {
  test.each(["observer", "reflector", "dropper"] as const)(
    "%s active-generation abort skips without cooling",
    async (stage) => {
      const f = fixture(stage);
      workers[stage].mockRejectedValue(new DOMException("The operation was aborted", "AbortError"));
      await f.run();
      expect(workers[stage]).toHaveBeenCalledOnce();
      expect(cooldowns()).toEqual({});
      expect(f.runtime.failedInCycle.has(key)).toBe(true);
    },
  );
  test.each([
    new Error(
      "Observer API error: Cannot find module '/fake/pi-ai/dist/api/openai-completions.js' imported from /fake/pi-ai/dist/api/openai-completions.lazy.js",
    ),
    Object.assign(new Error("Missing dependency"), { code: "ERR_MODULE_NOT_FOUND" }),
    new TypeError("Cannot read properties of undefined (reading 'status')"),
    new ReferenceError("timeout is not defined"),
    new SyntaxError("Unexpected token in local parser"),
  ])("runtime excludes local errors: %s", (error) => {
    const f = fixture();
    f.runtime.recordRetryableError(identity, error, "observer");
    expect(cooldowns()).toEqual({});
    expect(f.runtime.failedInCycle.has(key)).toBe(true);
  });
  test("a later stage can resolve an identity whose earlier request was aborted", async () => {
    const f = fixture();
    workers.observer.mockRejectedValue(new DOMException("The operation was aborted", "AbortError"));
    await f.run();
    expect(workers.observer).toHaveBeenCalledOnce();
    f.runtime.failedInCycle.clear();
    expect(await makeModelResolver(f.runtime, f.ctx, f.generation)("dropper")).toBeDefined();
  });
  test.each([
    new Error("HTTP 401 Unauthorized"),
    new Error("HTTP 404 model not found"),
    new Error("HTTP 503 Service Unavailable"),
    new Error("ECONNRESET"),
    new TypeError("fetch failed"),
    new Error("request timeout"),
    new Error("Reflector API error: Cannot read properties of undefined (reading 'status')"),
    new Error("Dropper API error: timeout is not defined"),
    new TypeError("terminated"),
    Object.assign(new TypeError("body read failed"), { cause: { code: "UND_ERR_BODY_TIMEOUT" } }),
  ])("provider failures still cool: %s", (error) => {
    const f = fixture();
    f.runtime.recordRetryableError(identity, error, "observer");
    expect(cooldowns()[key]?.until).toBe("2026-10-16T01:00:00.000Z");
  });
  test("stale generations never reach the cooldown writer", async () => {
    const f = fixture();
    const write = vi.spyOn(f.runtime, "recordRetryableError");
    workers.observer.mockImplementation(async () => {
      f.runtime.dispose();
      throw new DOMException("The operation was aborted", "AbortError");
    });
    await f.run();
    expect(workers.observer).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    expect(cooldowns()).toEqual({});
  });
  test("local error mentioning HTTP 401 does not cool the session model", () => {
    const f = fixture();
    f.runtime.recordDeterministicError(
      identity,
      new TypeError("Cannot read properties of undefined: HTTP 401"),
      "observer",
    );
    expect(cooldowns()).toEqual({});
    expect(f.runtime.failedInCycle.has(key)).toBe(true);
  });
});
