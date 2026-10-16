/** Real pipeline, resolver and disk persistence; only workers and host directory are faked. */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/om/runtime.js";
import { makeModelResolver, runConsolidationPipeline } from "../src/om/consolidation.js";
import { WorkerStreamError } from "../src/om/retryable-error.js";
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

describe("worker turn-cap cooldown isolation", () => {
  test.each(["observer", "reflector", "dropper"] as const)(
    "%s skips a turn cap only in-cycle",
    async (stage) => {
      const f = fixture(stage);
      workers[stage].mockRejectedValue(
        new WorkerStreamError(`${stage} turn cap exhausted`, 0, true),
      );
      const skip = vi.spyOn(f.runtime, "skipFailedForCycle");
      const cool = vi.spyOn(f.runtime, "recordRetryableError");
      await f.run();
      // Reflector/dropper retain the existing one-item shrink retry after the normal catch.
      expect(workers[stage]).toHaveBeenCalledTimes(stage === "observer" ? 1 : 2);
      expect(cooldowns()).toEqual({});
      expect(skip).toHaveBeenCalledWith(identity, "turn_cap");
      expect(cool).not.toHaveBeenCalled();
      expect(f.runtime.turnCapSkippedInCycle.has(key)).toBe(true);
      f.runtime.failedInCycle.clear();
      f.runtime.turnCapSkippedInCycle.clear();
      const resolve = makeModelResolver(f.runtime, f.ctx, f.generation);
      expect(await resolve(stage)).toBeDefined();
    },
  );
  test.each(["reflector", "dropper"] as const)(
    "%s still cools provider failures",
    async (stage) => {
      const f = fixture(stage);
      workers[stage].mockRejectedValue(new Error("HTTP 503 Service Unavailable"));
      await f.run();
      expect(workers[stage]).toHaveBeenCalledOnce();
      expect(cooldowns()[key]?.reason).toBe("HTTP 503 Service Unavailable");
    },
  );
});
