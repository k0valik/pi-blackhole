import { beforeEach, describe, expect, it, vi } from "vitest";
import { Runtime } from "../src/om/runtime.js";

let imports: string[];
let runObserver: ReturnType<typeof vi.fn>;
let runReflector: ReturnType<typeof vi.fn>;
let runDropper: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  imports = [];
  runObserver = vi.fn(async () => ({ observations: [] }));
  runReflector = vi.fn(async () => []);
  runDropper = vi.fn(async () => []);
  vi.doMock("../src/om/agents/observer/agent.js", () => {
    imports.push("observer");
    return { runObserver };
  });
  vi.doMock("../src/om/agents/reflector/agent.js", () => {
    imports.push("reflector");
    return { runReflector };
  });
  vi.doMock("../src/om/agents/dropper/agent.js", () => {
    imports.push("dropper");
    return { runDropper };
  });
});

function fixture() {
  const runtime = new Runtime();
  runtime.configLoaded = true;
  runtime.config.observeAfterTokens = 1;
  runtime.config.reflectAfterTokens = 1;
  runtime.loadCursorsFromPending = vi.fn();
  runtime.scheduleCursorFlush = vi.fn();
  runtime.resolveModel = vi.fn(async () => ({
    ok: true as const,
    model: { provider: "test", id: "model", contextWindow: 1_000_000 },
    apiKey: "test",
  }));
  runtime.recordRetryableError = vi.fn();
  const entries: any[] = [
    { type: "compaction", id: "c0", summary: "prior work", firstKeptEntryId: "m1" },
    {
      type: "message",
      id: "m1",
      message: { role: "user", content: "new source text ".repeat(100) },
    },
  ];
  const handlers = new Map<string, Function>();
  const pi = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    appendEntry: (customType: string, data: unknown) =>
      entries.push({
        type: "custom",
        id: `entry-${entries.length}`,
        customType,
        data,
      }),
  } as any;
  const ctx = {
    cwd: "/project",
    hasUI: false,
    model: undefined,
    modelRegistry: {},
    sessionManager: { getBranch: () => entries, getSessionId: () => "lazy-workers" },
  };
  return { runtime, entries, pi, ctx, handlers };
}

describe("lazy worker imports", () => {
  it("does not load workers for registration, disabled memory or below-threshold turns", async () => {
    const { registerConsolidationTrigger } = await import("../src/om/consolidation.js");
    const f = fixture();
    registerConsolidationTrigger(f.pi, f.runtime);
    expect(imports).toEqual([]);
    f.runtime.config.memory = false;
    f.handlers.get("agent_start")!({}, f.ctx);
    expect(imports).toEqual([]);
    f.runtime.config.memory = true;
    f.runtime.config.observeAfterTokens = 1_000_000;
    f.runtime.config.reflectAfterTokens = 1_000_000;
    f.handlers.get("turn_end")!({}, f.ctx);
    expect(imports).toEqual([]);
    expect(f.runtime.consolidationInFlight).toBe(false);
  });

  it("does not import a worker when no model can run it", async () => {
    const { runConsolidationPipeline } = await import("../src/om/consolidation.js");
    const f = fixture();
    f.runtime.resolveModel = vi.fn(async () => ({ ok: false, reason: "no model" }));
    await runConsolidationPipeline(f.pi, f.runtime, f.ctx);
    expect(imports).toEqual([]);
  });

  it("loads only the due worker and reuses it on retry", async () => {
    const { runConsolidationPipeline } = await import("../src/om/consolidation.js");
    const f = fixture();
    f.runtime.config.reflectAfterTokens = 1_000_000;
    runObserver.mockRejectedValueOnce(new Error("temporary provider failure"));
    await runConsolidationPipeline(f.pi, f.runtime, f.ctx);
    expect(imports).toEqual(["observer"]);
    expect(runObserver).toHaveBeenCalledTimes(2);
    expect(f.runtime.recordRetryableError).toHaveBeenCalledOnce();
    expect(runReflector).not.toHaveBeenCalled();
    expect(runDropper).not.toHaveBeenCalled();
  });

  it("loads all stages on demand without changing their ledger output", async () => {
    const { runConsolidationPipeline } = await import("../src/om/consolidation.js");
    const f = fixture();
    runObserver.mockResolvedValue({
      observations: [
        {
          id: "aaaaaaaaaaaa",
          content: "Keep the established project convention.",
          timestamp: "2026-09-01 12:00",
          relevance: "high",
          sourceEntryIds: ["m1"],
          tokenCount: 10,
        },
      ],
    });
    runReflector.mockResolvedValue([
      {
        id: "bbbbbbbbbbbb",
        content: "The convention is settled.",
        supportingObservationIds: ["aaaaaaaaaaaa"],
        tokenCount: 6,
      },
    ]);
    runDropper.mockResolvedValue(["aaaaaaaaaaaa"]);
    await runConsolidationPipeline(f.pi, f.runtime, f.ctx);
    expect(imports).toEqual(["observer", "reflector", "dropper"]);
    expect(
      f.entries.filter((entry) => entry.type === "custom").map((entry) => entry.customType),
    ).toEqual(["om.observations.recorded", "om.reflections.recorded", "om.observations.dropped"]);
    expect(runDropper.mock.calls[0][0].reflections).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "bbbbbbbbbbbb" })]),
    );
  });
});
