/**
 * Observer coverage cursor — F1 of work_docs/plan-observer-coverage-completion.md.
 *
 * The stage claims coverage (`coversUpToId`) only for what the model was
 * actually shown. With the old newest-first cap the cursor jumped to the
 * branch tip while older entries were silently dropped from the chunk, so
 * those entries were never observed again — coverage advanced past unseen
 * source entries. The fix: cap to the OLDEST contiguous prefix, derive
 * coversUpToId from the ids the serializer really emitted, and drain the
 * remainder within the same run (bounded by OBSERVER_DRAIN_MAX_BATCHES) even
 * when what is left has fallen below `observeAfterTokens`.
 *
 * Harness mirrors tests/observer-anchor.test.ts: real Runtime, real stage,
 * module-mocked worker.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  OBSERVER_DRAIN_MAX_BATCHES,
  runObserverStage,
  type ConsolidationCtx,
} from "../src/om/consolidation.js";
import { Runtime } from "../src/om/runtime.js";
import { WorkerStreamError } from "../src/om/retryable-error.js";
import { observation, rawMessage, type TestEntry } from "./fixtures/session.js";

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

function makeRuntime(observeAfterTokens: number, chunkMaxTokens: number): Runtime {
  const runtime = new Runtime();
  runtime.config.memory = true;
  runtime.config.observeAfterTokens = observeAfterTokens;
  runtime.config.observerChunkMaxTokens = chunkMaxTokens;
  return runtime;
}

/** ~300 estimated tokens (sentinel + 1200 chars). */
const text = (sentinel: string) => `${sentinel} ${"x".repeat(1200)}`;

/** Always-healthy resolver: no candidate config, so failures never cool models. */
function resolveModelSession() {
  return async () =>
    ({
      ok: true as const,
      source: "session" as const,
      model: { provider: "test", id: "m", contextWindow: 100_000 },
      apiKey: "test",
    }) as any;
}

function runStage(
  runtime: Runtime,
  entries: TestEntry[],
  resolveModel: () => Promise<any> = resolveModelSession(),
) {
  const generation = runtime.captureGeneration("test-session");
  return runObserverStage(
    { appendEntry: vi.fn() } as any,
    runtime,
    ctxWith(entries),
    generation,
    resolveModel,
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

const emptyResult = () => ({
  observations: [],
  emptyReason: { kind: "no_new_content" as const },
});

beforeEach(() => {
  runObserverSpy.mockReset();
  runObserverSpy.mockResolvedValue(emptyResult());
});

describe("observer never covers source entries it was never shown", () => {
  test("the first batch is the oldest prefix, not the branch tip", async () => {
    const entries = [
      rawMessage("s0", text("OLD-A")),
      rawMessage("s1", text("OLD-B")),
      rawMessage("s2", text("OLD-C")),
    ];
    const runtime = makeRuntime(100, 100);
    const advance = vi.spyOn(runtime, "advanceCursor");

    await runStage(runtime, entries);

    // T4: the chunk sent first must be exactly the prefix the budget allows —
    // one ~300-token entry. The old suffix cap sent only "s2" and then claimed
    // coverage up to it, orphaning s0 and s1 forever.
    expect(observedInput(0).allowedSourceEntryIds).toEqual(["s0"]);
    // The first coverage claim is the last entry actually delivered.
    expect(advance.mock.calls[0]).toEqual(["observer", "s0", "empty"]);
  });

  test("one run drains the backlog even when the remainder falls below the trigger", async () => {
    const entries = [
      rawMessage("s0", text("OLD-A")),
      rawMessage("s1", text("OLD-B")),
      rawMessage("s2", text("OLD-C")),
    ];
    // 3 × ~302 = 906 ≥ 700 → due; after s0 the remaining 604 < 700 would be
    // not_due without the drain bypass.
    const runtime = makeRuntime(700, 400);
    // Recorded-path variant: a run that records observations must drain too
    // (the empty-diagnosis path is exercised by the other cases).
    let recorded = 0;
    runObserverSpy.mockImplementation(async (input) => ({
      observations: [
        observation(`o-${recorded++}`, { sourceEntryIds: input.allowedSourceEntryIds }),
      ],
    }));

    await runStage(runtime, entries);

    const seen = runObserverSpy.mock.calls.flatMap((call) => call[0].allowedSourceEntryIds);
    expect(seen).toEqual(["s0", "s1", "s2"]);
    expect(runtime.getCursor("observer")?.entryId).toBe("s2");
  });

  test("a turn-cap checkpoint commits only the last cited entry and drains the rest", async () => {
    const entries = [
      rawMessage("s0", text("OLD-A")),
      rawMessage("s1", text("OLD-B")),
      rawMessage("s2", text("OLD-C")),
    ];
    // 3 × ~302 = ~906 tokens fits one 1000-token chunk, so the first batch is
    // [s0, s1, s2] and its delivered chunk end (s2) is NOT the partial point.
    const runtime = makeRuntime(700, 1000);
    const advance = vi.spyOn(runtime, "advanceCursor");
    const recordRetryable = vi.spyOn(runtime, "recordRetryableError");
    runObserverSpy
      .mockResolvedValueOnce({
        observations: [observation("o1", { sourceEntryIds: ["s0"] })],
        partialCoverageId: "s0",
      })
      .mockResolvedValueOnce(emptyResult());

    await runStage(runtime, entries);

    // The first batch delivered [s0, s1, s2] but only s0 was cited, so
    // coverage advances to s0 — never to the delivered chunk end. The drain
    // then resumes from s1 with the remainder.
    expect(observedInput(0).allowedSourceEntryIds).toEqual(["s0", "s1", "s2"]);
    expect(observedInput(1).allowedSourceEntryIds).toEqual(["s1", "s2"]);
    expect(advance.mock.calls).toEqual([
      ["observer", "s0", "recorded"],
      ["observer", "s2", "empty"],
    ]);
    // A turn cap is a config limit, not a model defect: no cooldown is written.
    expect(recordRetryable).not.toHaveBeenCalled();
  });

  test("the drain is bounded so an oversized backlog waits for the next cycle", async () => {
    const entries: TestEntry[] = [];
    for (let i = 0; i < 8; i += 1) {
      entries.push(rawMessage(`s${i}`, text(`BIG-${i}`)));
    }
    const runtime = makeRuntime(100, 100);

    await runStage(runtime, entries);

    // Initial batch plus at most OBSERVER_DRAIN_MAX_BATCHES (3) drain batches…
    expect(runObserverSpy).toHaveBeenCalledTimes(1 + OBSERVER_DRAIN_MAX_BATCHES);
    const seen = runObserverSpy.mock.calls.flatMap((call) => call[0].allowedSourceEntryIds);
    expect(seen).toEqual(["s0", "s1", "s2", "s3"]);
    // …and the cursor stops at the last DELIVERED entry: s4–s7 are still
    // pending in the backlog for the next cycle, never silently covered.
    expect(runtime.getCursor("observer")?.entryId).toBe("s3");
  });

  test("a failed drain batch leaves the cursor at the delivered point", async () => {
    const entries = [
      rawMessage("s0", text("OLD-A")),
      rawMessage("s1", text("OLD-B")),
      rawMessage("s2", text("OLD-C")),
    ];
    const runtime = makeRuntime(100, 100);
    const advance = vi.spyOn(runtime, "advanceCursor");
    runObserverSpy
      .mockResolvedValueOnce(emptyResult())
      .mockRejectedValue(new WorkerStreamError("Observer API error: stream failed mid-drain", 0));

    const outcome = await runStage(runtime, entries);

    // The first batch succeeded and claimed s0; the failing drain batch must
    // not move coverage. The stage exhausts its attempts and aborts.
    expect(outcome).toBe("abort");
    expect(advance.mock.calls).toEqual([["observer", "s0", "empty"]]);
    expect(runtime.getCursor("observer")?.entryId).toBe("s0");
  });

  test("an unrenderable trailing entry neither blocks coverage nor loops the drain", async () => {
    const entries = [
      rawMessage("s0", text("SENT")),
      // An assistant message with an empty body renders to nothing, so the
      // serializer drops it and it is never sent (a user-role message would
      // still render its timestamp header and count as sent).
      rawMessage("s1", "", { message: { role: "assistant", content: [] } }),
    ];
    const runtime = makeRuntime(100, 10_000);

    const outcome = await runStage(runtime, entries);

    // One model call: the serializer skips the empty entry, so the drain's
    // second batch has nothing to send and returns before resolving a model
    // (termination proof — an infinite drain would exhaust the vitest timeout).
    expect(outcome).toBe("continue");
    expect(runObserverSpy).toHaveBeenCalledTimes(1);
    expect(observedInput(0).allowedSourceEntryIds).toEqual(["s0"]);
    // Coverage claims the last SENT id; the unsent tail stays beyond the
    // cursor and is re-measured next cycle.
    expect(runtime.getCursor("observer")?.entryId).toBe("s0");
  });
});
