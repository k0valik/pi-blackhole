/**
 * Observer anchor on never-compacted sessions (issue #87).
 *
 * runObserverStage resolves its start anchor as: cursor > observation
 * coverage marker > last compaction entry. With none of those (fresh
 * session, subagent below compaction threshold) the anchor is -1 and the
 * stage must measure the full history (rawTokensAfterIndex clamps -1 to
 * index 0) — not zero it out, which left the observer stuck on not_due
 * forever until the first compaction existed.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

import { Runtime } from "../src/om/runtime.js";
import { anyStageDue, runObserverStage, type ConsolidationCtx } from "../src/om/consolidation.js";
import {
  compactionEntry,
  observation,
  observationsRecordedEntry,
  rawMessage,
  type TestEntry,
} from "./fixtures/session.js";

interface ObserverStageInput {
  chunk: string;
  allowedSourceEntryIds: string[];
}

const runObserverSpy = vi.hoisted(() => vi.fn<(input: ObserverStageInput) => Promise<unknown>>());

vi.mock("../src/om/agents/observer/agent.js", () => ({
  runObserver: runObserverSpy,
}));

function ctxWith(entries: TestEntry[]): ConsolidationCtx {
  return {
    cwd: "/tmp",
    hasUI: false,
    ui: undefined,
    model: undefined,
    modelRegistry: {
      find: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: false }),
    },
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => "test-session",
    },
  } as unknown as ConsolidationCtx;
}

function makeRuntime(observeAfterTokens: number): Runtime {
  const runtime = new Runtime();
  runtime.config.memory = true;
  runtime.config.observeAfterTokens = observeAfterTokens;
  return runtime;
}

// ~300 estimated tokens per entry, above the 100-token test threshold
const text = (sentinel: string) => `${sentinel} ${"x".repeat(1200)}`;

function resolveModelOk() {
  return async () => ({
    ok: true as const,
    source: "candidate" as const,
    candidateConfig: { provider: "test", id: "m" },
    model: { provider: "test", id: "m", contextWindow: 100_000 },
    apiKey: "test",
  });
}

function runStage(runtime: Runtime, entries: TestEntry[]) {
  const generation = runtime.captureGeneration("test-session");
  return runObserverStage(
    { appendEntry: vi.fn() } as any,
    runtime,
    ctxWith(entries),
    generation,
    resolveModelOk(),
  );
}

/** Input of the Nth observer call, failing loudly when the call never happened. */
function observedInput(callIndex = 0): ObserverStageInput {
  const call = runObserverSpy.mock.calls[callIndex];
  if (!call) {
    throw new Error(`observer stage ran ${runObserverSpy.mock.calls.length} time(s)`);
  }
  return call[0];
}

beforeEach(() => {
  runObserverSpy.mockReset();
  runObserverSpy.mockResolvedValue({
    observations: [],
    emptyReason: { kind: "no_new_content" as const },
  });
});

describe("runObserverStage anchor (issue #87)", () => {
  test("observer runs on a never-compacted session (anchor -1 → full history)", async () => {
    const entries = [rawMessage("e1", text("EARLY-BACKLOG")), rawMessage("e2", text("LATER"))];
    const runtime = makeRuntime(100);

    const outcome = await runStage(runtime, entries);

    expect(outcome).toBe("continue");
    // Red before the fix: stage bailed at tokens=0 and never called the model.
    expect(runObserverSpy).toHaveBeenCalledTimes(1);
    // T4: the chunk must cover the backlog from the very first entry.
    const input = observedInput();
    expect(input.chunk).toContain("EARLY-BACKLOG");
    expect(input.chunk).toContain("LATER");
    expect(input.allowedSourceEntryIds).toEqual(["e1", "e2"]);
  });

  test("observer stays not_due below threshold on a never-compacted session", async () => {
    const entries = [rawMessage("e1", "short")];
    const runtime = makeRuntime(100);

    const outcome = await runStage(runtime, entries);

    expect(outcome).toBe("continue");
    expect(runObserverSpy).not.toHaveBeenCalled();
    // The below-threshold entry stays unobserved: with nothing measured yet the
    // stage must not create a cursor that hides it from later checks.
    expect(runtime.getCursor("observer")).toBeUndefined();
  });

  test("small additions accumulate until the observer threshold is reached", async () => {
    const runtime = makeRuntime(100);
    const entries: TestEntry[] = [];
    for (let i = 0; i < 6 && runObserverSpy.mock.calls.length === 0; i += 1) {
      entries.push(rawMessage(`small-${i}`, `SMALL-SENTINEL-${i} ${"x".repeat(110)}`));
      await runStage(runtime, entries);
    }

    expect(runObserverSpy).toHaveBeenCalledTimes(1);
    // The first addition is only ~32 tokens; it must still be observed once the
    // accumulated total crosses the threshold.
    const input = observedInput();
    expect(input.chunk).toContain("SMALL-SENTINEL-0");
    expect(input.allowedSourceEntryIds).toEqual(entries.map((entry) => entry.id));
  });

  test("keeps unobserved content when another due stage launches the pipeline", async () => {
    const runtime = makeRuntime(100);
    runtime.config.reflectAfterTokens = 1;
    const marker = observationsRecordedEntry("m1", {
      observations: [observation("o1", { sourceEntryIds: ["old1"] })],
      coversUpToId: "old1",
    });
    const first = [rawMessage("old1", "OLD-COVERED"), marker, rawMessage("new1", "NEW-UNOBSERVED")];

    // The reflector is due, so the pipeline launches although the observer is not.
    expect(anyStageDue(first, runtime, undefined)).toBe(true);
    await runStage(runtime, first);
    expect(runObserverSpy).not.toHaveBeenCalled();

    const second = [...first, rawMessage("new2", text("BIG-ADDITION"))];
    await runStage(runtime, second);

    expect(runObserverSpy).toHaveBeenCalledTimes(1);
    const input = observedInput();
    expect(input.chunk).toContain("NEW-UNOBSERVED");
    expect(input.chunk).toContain("BIG-ADDITION");
    expect(input.allowedSourceEntryIds).toEqual(["new1", "new2"]);
  });

  test("does not re-observe the same entries after an empty observer outcome", async () => {
    const entries = [rawMessage("e1", text("ONLY-CHUNK"))];
    const runtime = makeRuntime(100);

    await runStage(runtime, entries);
    expect(runObserverSpy).toHaveBeenCalledTimes(1);
    expect(runtime.getCursor("observer")).toEqual({ entryId: "e1", state: "empty" });

    await runStage(runtime, entries);
    expect(runObserverSpy).toHaveBeenCalledTimes(1);
  });

  test("falls back to the full history when the observer cursor entry no longer exists", async () => {
    const runtime = makeRuntime(100);
    runtime.advanceCursor("observer", "missing-entry", "recorded");
    const entries = [rawMessage("e1", text("STALE-FALLBACK"))];

    await runStage(runtime, entries);

    expect(runObserverSpy).toHaveBeenCalledTimes(1);
    const input = observedInput();
    expect(input.chunk).toContain("STALE-FALLBACK");
    expect(input.allowedSourceEntryIds).toEqual(["e1"]);
  });

  test("falls back to the compaction anchor when the observer cursor is stale", async () => {
    const runtime = makeRuntime(100);
    runtime.advanceCursor("observer", "gone-before-compaction", "recorded");
    const entries = [
      rawMessage("pre1", text("PRE-COMPACTION")),
      compactionEntry("c1", { firstKeptEntryId: "post1", summary: "summary" }),
      rawMessage("post1", text("POST-COMPACTION")),
    ];

    await runStage(runtime, entries);

    expect(runObserverSpy).toHaveBeenCalledTimes(1);
    const input = observedInput();
    // Post-compaction content is measured from the compaction anchor; the
    // summarized pre-compaction branch is not re-observed.
    expect(input.chunk).toContain("POST-COMPACTION");
    expect(input.chunk).not.toContain("PRE-COMPACTION");
    expect(input.allowedSourceEntryIds).toEqual(["post1"]);
  });

  test("observer still anchors to the last compaction entry when one exists", async () => {
    const entries = [
      rawMessage("pre1", text("PRE-COMPACTION")),
      compactionEntry("c1", { firstKeptEntryId: "post1", summary: "summary" }),
      rawMessage("post1", text("POST-COMPACTION")),
    ];
    const runtime = makeRuntime(100);

    await runStage(runtime, entries);

    expect(runObserverSpy).toHaveBeenCalledTimes(1);
    const input = observedInput();
    // Post-compaction content is processed…
    expect(input.chunk).toContain("POST-COMPACTION");
    // …pre-compaction content is not (unchanged anchoring behavior).
    expect(input.chunk).not.toContain("PRE-COMPACTION");
  });

  test("observer still anchors to the observation coverage marker when one exists", async () => {
    const marker = observationsRecordedEntry("m1", {
      observations: [observation("o1", { sourceEntryIds: ["old1"] })],
      coversUpToId: "old1",
    });
    const entries = [
      rawMessage("old1", text("OLD-COVERED")),
      marker,
      rawMessage("new1", text("NEW-UNCOVERED")),
    ];
    const runtime = makeRuntime(100);

    await runStage(runtime, entries);

    expect(runObserverSpy).toHaveBeenCalledTimes(1);
    const input = observedInput();
    expect(input.chunk).toContain("NEW-UNCOVERED");
    expect(input.chunk).not.toContain("OLD-COVERED");
  });
});
