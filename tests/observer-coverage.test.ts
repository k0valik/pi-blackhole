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
import { beforeEach, afterEach, afterAll, describe, expect, test, vi } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  OBSERVER_DRAIN_MAX_BATCHES,
  anyStageDue,
  runObserverStage,
  type ConsolidationCtx,
} from "../src/om/consolidation.js";
import { Runtime } from "../src/om/runtime.js";
import { WorkerStreamError } from "../src/om/retryable-error.js";
import { clearPendingState, readPendingState, savePendingUnanchored } from "../src/om/pending.js";
import {
  observation,
  observationsRecordedEntry,
  rawMessage,
  type TestEntry,
} from "./fixtures/session.js";

/** Pending writes hit real files, so redirect the agent dir (mirrors consolidation.test.ts). */
const coverageTestDir = join(tmpdir(), `pi-blackhole-observer-coverage-${Date.now()}`);
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, getAgentDir: () => coverageTestDir };
});

interface ObserverStageInput {
  chunk: string;
  allowedSourceEntryIds: string[];
  priorObservations: string[];
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
  pi: any = { appendEntry: vi.fn() },
) {
  const generation = runtime.captureGeneration("test-session");
  return runObserverStage(pi, runtime, ctxWith(entries), generation, resolveModel);
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

/** Agent-level shape for a capped run whose citations form no head-anchored prefix. */
const turnCapError = (count = 1) =>
  new WorkerStreamError(
    `Observer turn cap exhausted: ${count} observation${count === 1 ? "" : "s"} recorded with no complete=true close`,
    count,
    true,
  );

beforeEach(() => {
  runObserverSpy.mockReset();
  runObserverSpy.mockResolvedValue(emptyResult());
});

afterEach(() => {
  clearPendingState("test-session");
});

afterAll(() => {
  rmSync(coverageTestDir, { recursive: true, force: true });
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

  test("a turn-cap checkpoint commits only the cited prefix and drains the rest", async () => {
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
    // coverage advances to the end of the cited prefix (s0) — never to the
    // delivered chunk end, and never past an uncited entry. The drain then
    // resumes from s1 with the remainder.
    expect(observedInput(0).allowedSourceEntryIds).toEqual(["s0", "s1", "s2"]);
    expect(observedInput(1).allowedSourceEntryIds).toEqual(["s1", "s2"]);
    expect(advance.mock.calls).toEqual([
      ["observer", "s0", "recorded"],
      ["observer", "s2", "empty"],
    ]);
    // A turn cap is a config limit, not a model defect: no cooldown is written.
    expect(recordRetryable).not.toHaveBeenCalled();
  });

  test("a turn-cap checkpoint outside the delivered chunk fails closed", async () => {
    const entries = [
      rawMessage("s0", text("OLD-A")),
      rawMessage("s1", text("OLD-B")),
      rawMessage("s2", text("OLD-C")),
    ];
    const runtime = makeRuntime(700, 1000);
    const advance = vi.spyOn(runtime, "advanceCursor");
    const recordRetryable = vi.spyOn(runtime, "recordRetryableError");
    // A partial id the batch never delivered must never be committed: the
    // batch is discarded and the halved retry below also caps, so the run
    // aborts with the cursor unmoved — still with no cooldown.
    runObserverSpy
      .mockResolvedValueOnce({
        observations: [observation("o1", { sourceEntryIds: ["s0"] })],
        partialCoverageId: "bogus-id",
      })
      .mockRejectedValueOnce(turnCapError());

    const outcome = await runStage(runtime, entries);

    // The first attempt delivered [s0..s2]; the retry is halved to [s0] —
    // but "bogus-id" itself is never claimed as coverage.
    expect(observedInput(1).allowedSourceEntryIds).toEqual(["s0"]);
    expect(advance).not.toHaveBeenCalled();
    expect(runtime.getCursor("observer")).toBeUndefined();
    expect(recordRetryable).not.toHaveBeenCalled();
    expect(outcome).toBe("abort");
  });

  test("a turn-cap cut with no head-anchored citation halves the chunk and retries", async () => {
    const entries = [
      rawMessage("s0", text("OLD-A")),
      rawMessage("s1", text("OLD-B")),
      rawMessage("s2", text("OLD-C")),
      rawMessage("s3", text("OLD-D")),
    ];
    // 4 × ~302 ≈ 1208 tokens fits one 2000-token chunk, so the first attempt
    // delivers [s0..s3].
    const runtime = makeRuntime(700, 2000);
    const recordRetryable = vi.spyOn(runtime, "recordRetryableError");
    runObserverSpy
      .mockRejectedValueOnce(turnCapError())
      .mockResolvedValueOnce({
        observations: [observation("o1", { sourceEntryIds: ["s0"] })],
        partialCoverageId: "s0",
      })
      .mockResolvedValueOnce(emptyResult());

    const outcome = await runStage(runtime, entries);

    // No committable prefix on [s0..s3], so the stage halves to [s0, s1] and
    // retries the same model instead of burning the fallback chain on the
    // identical chunk — and never cools the model down for a config limit.
    expect(runObserverSpy).toHaveBeenCalledTimes(3);
    expect(observedInput(0).allowedSourceEntryIds).toEqual(["s0", "s1", "s2", "s3"]);
    expect(observedInput(1).allowedSourceEntryIds).toEqual(["s0", "s1"]);
    expect(recordRetryable).not.toHaveBeenCalled();
    expect(outcome).toBe("continue");
    expect(runtime.getCursor("observer")?.entryId).toBe("s3");
  });

  test("repeated turn-cap cuts halve down to a single entry and advance", async () => {
    const entries = [
      rawMessage("s0", text("OLD-A")),
      rawMessage("s1", text("OLD-B")),
      rawMessage("s2", text("OLD-C")),
      rawMessage("s3", text("OLD-D")),
    ];
    const runtime = makeRuntime(700, 2000);
    runObserverSpy
      .mockRejectedValueOnce(turnCapError())
      .mockRejectedValueOnce(turnCapError())
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(emptyResult());

    const outcome = await runStage(runtime, entries);

    // [s0..s3] → [s0, s1] → [s0]: every cut halves the delivered entries, so
    // the cursor advances within ⌈log2(n)⌉ retries instead of stalling on the
    // identical chunk every cycle.
    expect(runObserverSpy).toHaveBeenCalledTimes(4);
    expect(observedInput(0).allowedSourceEntryIds).toEqual(["s0", "s1", "s2", "s3"]);
    expect(observedInput(1).allowedSourceEntryIds).toEqual(["s0", "s1"]);
    expect(observedInput(2).allowedSourceEntryIds).toEqual(["s0"]);
    expect(outcome).toBe("continue");
    expect(runtime.getCursor("observer")?.entryId).toBe("s3");
  });

  test("a turn-cap cut on a single-entry chunk neither halves nor loops", async () => {
    const entries = [rawMessage("s0", text("ONLY"))];
    const runtime = makeRuntime(100, 10_000);
    runObserverSpy.mockRejectedValueOnce(turnCapError());

    const outcome = await runStage(runtime, entries);

    // Nothing to halve: the existing skip-and-break path runs once and the
    // stage aborts instead of re-offering the same single entry forever.
    expect(runObserverSpy).toHaveBeenCalledTimes(1);
    expect(outcome).toBe("abort");
    expect(runtime.getCursor("observer")).toBeUndefined();
  });

  test("a halved turn-cap retry re-offers the capped candidate instead of skipping it", async () => {
    const entries = [
      rawMessage("s0", text("OLD-A")),
      rawMessage("s1", text("OLD-B")),
      rawMessage("s2", text("OLD-C")),
      rawMessage("s3", text("OLD-D")),
    ];
    const runtime = makeRuntime(700, 2000);
    const candidate = { provider: "test", id: "m" };
    runObserverSpy
      .mockRejectedValueOnce(turnCapError())
      .mockResolvedValueOnce({
        observations: [observation("o1", { sourceEntryIds: ["s0"] })],
        partialCoverageId: "s0",
      })
      .mockResolvedValueOnce(emptyResult());

    // Candidate resolver that ignores in-cycle skips: the point under test is
    // that the stage never records the skip, so the offer sequence alone
    // proves the retry went to the same model on the smaller input.
    const resolveCandidate = async () =>
      ({
        ok: true as const,
        source: "candidate" as const,
        candidateConfig: candidate,
        model: { ...candidate, contextWindow: 100_000 },
        apiKey: "test",
      }) as any;

    const outcome = await runStage(runtime, entries, resolveCandidate);

    expect(observedInput(0).allowedSourceEntryIds).toEqual(["s0", "s1", "s2", "s3"]);
    expect(observedInput(1).allowedSourceEntryIds).toEqual(["s0", "s1"]);
    // The capped model was retried on the smaller input, not benched: no
    // in-cycle skip of either kind.
    expect(runtime.failedInCycle.size).toBe(0);
    expect(runtime.turnCapSkippedInCycle.size).toBe(0);
    expect(outcome).toBe("continue");
  });

  test("a prefix-less turn-cap keeps tail facts as unanchored, moves no cursor, and halves", async () => {
    const entries = [
      rawMessage("s0", text("OLD-A")),
      rawMessage("s1", text("OLD-B")),
      rawMessage("s2", text("OLD-C")),
      rawMessage("s3", text("OLD-D")),
    ];
    // 4 × ~302 ≈ 1208 tokens fits one 2000-token chunk: the first attempt
    // delivers [s0..s3] but cites only the tail.
    const runtime = makeRuntime(700, 2000);
    const pi = { appendEntry: vi.fn() };
    const advance = vi.spyOn(runtime, "advanceCursor");
    const recordRetryable = vi.spyOn(runtime, "recordRetryableError");
    const tailFact = observation("dddddddddddd", { sourceEntryIds: ["s2", "s3"] });
    runObserverSpy
      .mockResolvedValueOnce({ unanchoredObservations: [tailFact] })
      .mockResolvedValueOnce({
        observations: [observation("eeeeeeeeeeee", { sourceEntryIds: ["s0"] })],
        partialCoverageId: "s0",
      })
      .mockResolvedValueOnce(emptyResult());

    const candidate = { provider: "test", id: "m" };
    const resolveCandidate = async () =>
      ({
        ok: true as const,
        source: "candidate" as const,
        candidateConfig: candidate,
        model: { ...candidate, contextWindow: 100_000 },
        apiKey: "test",
      }) as any;

    const outcome = await runStage(runtime, entries, resolveCandidate, pi);

    // The tail fact is stored under the coverage-inert key — no coversUpToId,
    // so no reader can mistake it for a coverage claim.
    const unanchoredWrites = pi.appendEntry.mock.calls.filter(
      ([customType]) => customType === "om.observations.unanchored",
    );
    expect(unanchoredWrites).toHaveLength(1);
    expect(unanchoredWrites[0][1]).toEqual({ observations: [tailFact] });
    // The cursor never moves for kept facts: the first advance is the halved
    // retry's cited prefix, not the tail.
    expect(advance.mock.calls[0]).toEqual(["observer", "s0", "recorded"]);
    // Same-model halve-and-retry on the head half, with no cooldown and no
    // in-cycle skip of either kind.
    expect(observedInput(0).allowedSourceEntryIds).toEqual(["s0", "s1", "s2", "s3"]);
    expect(observedInput(1).allowedSourceEntryIds).toEqual(["s0", "s1"]);
    expect(recordRetryable).not.toHaveBeenCalled();
    expect(runtime.failedInCycle.size).toBe(0);
    expect(runtime.turnCapSkippedInCycle.size).toBe(0);
    expect(outcome).toBe("continue");
    expect(runtime.getCursor("observer")?.entryId).toBe("s3");
  });

  test("a prefix-less turn-cap on a single-entry chunk keeps the fact and aborts without looping", async () => {
    const entries = [rawMessage("s0", text("ONLY"))];
    const runtime = makeRuntime(100, 10_000);
    const pi = { appendEntry: vi.fn() };
    runObserverSpy.mockResolvedValueOnce({
      unanchoredObservations: [observation("dddddddddddd", { sourceEntryIds: ["s0"] })],
    });

    const outcome = await runStage(runtime, entries, resolveModelSession(), pi);

    // Nothing to halve: the fact is kept once and the existing skip-and-break
    // path aborts instead of re-offering the same single entry forever.
    expect(runObserverSpy).toHaveBeenCalledTimes(1);
    const unanchoredWrites = pi.appendEntry.mock.calls.filter(
      ([customType]) => customType === "om.observations.unanchored",
    );
    expect(unanchoredWrites).toHaveLength(1);
    expect(outcome).toBe("abort");
    expect(runtime.getCursor("observer")).toBeUndefined();
  });

  test("a prefix-less turn-cap in manual mode buffers the fact in pending, not the branch", async () => {
    const entries = [
      rawMessage("s0", text("OLD-A")),
      rawMessage("s1", text("OLD-B")),
      rawMessage("s2", text("OLD-C")),
      rawMessage("s3", text("OLD-D")),
    ];
    const runtime = makeRuntime(700, 2000);
    runtime.config.compaction = "manual";
    const pi = { appendEntry: vi.fn() };
    const tailFact = observation("aaaaaaaaaaaa", { sourceEntryIds: ["s2", "s3"] });
    runObserverSpy
      .mockResolvedValueOnce({ unanchoredObservations: [tailFact] })
      .mockResolvedValueOnce({
        observations: [observation("bbbbbbbbbbbb", { sourceEntryIds: ["s0"] })],
        partialCoverageId: "s0",
      })
      .mockResolvedValueOnce(emptyResult());

    await runStage(runtime, entries, resolveModelSession(), pi);

    // Manual mode never appends to the branch: the kept fact lands in the
    // pending file instead, and the halve-and-retry still runs.
    expect(pi.appendEntry).not.toHaveBeenCalled();
    const pending = readPendingState("test-session");
    expect(pending.unanchoredBatches).toHaveLength(1);
    expect(pending.unanchoredBatches?.[0].data).toEqual({ observations: [tailFact] });
    expect(observedInput(1).allowedSourceEntryIds).toEqual(["s0", "s1"]);
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

  test("a turn-cap checkpoint stays visible even when the info gate is spent", async () => {
    const entries = [
      rawMessage("s0", text("OLD-A")),
      rawMessage("s1", text("OLD-B")),
      rawMessage("s2", text("OLD-C")),
    ];
    const runtime = makeRuntime(700, 1000);
    // The "observer running" toast already spent the per-phase gate, so a
    // gated checkpoint would be silently dropped.
    runtime.hasEmittedInfoThisTurn = true;
    const notify = vi.fn();
    const generation = runtime.captureGeneration("test-session");
    runObserverSpy
      .mockResolvedValueOnce({
        observations: [observation("o1", { sourceEntryIds: ["s0"] })],
        partialCoverageId: "s0",
      })
      .mockResolvedValueOnce(emptyResult());
    try {
      await runObserverStage(
        { appendEntry: vi.fn() } as any,
        runtime,
        {
          cwd: "/tmp",
          hasUI: true,
          ui: { notify },
          model: undefined,
          modelRegistry: {
            find: () => undefined,
            getApiKeyAndHeaders: async () => ({ ok: false }),
          },
          sessionManager: {
            getBranch: () => entries,
            getSessionId: () => "test-session",
          },
        } as unknown as ConsolidationCtx,
        generation,
        resolveModelSession(),
      );

      const checkpoint = notify.mock.calls.filter((call) =>
        String(call[0]).includes("checkpointed"),
      );
      expect(checkpoint).toHaveLength(1);
    } finally {
      notify.mockClear();
    }
  });

  test("kept unanchored facts alone launch no pipeline stage", async () => {
    const entries = [
      rawMessage("s0", text("OLD-A")),
      {
        type: "custom",
        id: "om-unanchored-1",
        customType: "om.observations.unanchored",
        data: { observations: [observation("o1", { sourceEntryIds: ["s0"] })] },
      } as unknown as TestEntry,
    ];
    const runtime = makeRuntime(700, 2000);
    runtime.advanceCursor("observer", "s0", "empty");
    runtime.advanceCursor("reflector", "s0", "empty");
    runtime.advanceCursor("dropper", "s0", "empty");

    // Unanchored facts feed worker inputs (pool, preamble, deltas) but are
    // deliberately not a due trigger: they carry no coverage point, so
    // treating them as new-data would re-run the reflector/dropper every
    // cycle until the next recorded batch. Adding the key to the due-check
    // loops flips this test.
    expect(anyStageDue(entries as any, runtime)).toBe(false);
  });

  test("kept unanchored facts steer the next observer run through its preamble", async () => {
    const kept = observation("aaaaaaaaaaaa", {
      content: "kept tail fact",
      sourceEntryIds: ["s1"],
    });
    const entries = [
      rawMessage("s0", text("OLD-A")),
      rawMessage("s1", text("OLD-B")),
      {
        type: "custom",
        id: "om-unanchored-1",
        customType: "om.observations.unanchored",
        data: { observations: [kept] },
      } as unknown as TestEntry,
    ];
    const runtime = makeRuntime(100, 10_000);
    runObserverSpy.mockResolvedValueOnce(emptyResult());

    await runStage(runtime, entries);

    // The payoff: retries spend their turns on the uncovered head instead of
    // redoing tail work, because the kept fact arrives as existing context
    // (plus the prompts.ts no-re-emit instruction).
    expect(observedInput(0).priorObservations.join("\n")).toContain("kept tail fact");
  });

  test("pending unanchored facts steer manual-mode observer runs through the preamble", async () => {
    const entries = [rawMessage("s0", text("OLD-A")), rawMessage("s1", text("OLD-B"))];
    const runtime = makeRuntime(100, 10_000);
    runtime.config.compaction = "manual";
    savePendingUnanchored("test-session", {
      data: {
        observations: [
          observation("bbbbbbbbbbbb", { content: "manual kept fact", tokenCount: 10 }),
        ],
      },
    });
    runObserverSpy.mockResolvedValueOnce(emptyResult());

    await runStage(runtime, entries);

    // Manual mode has no branch markers: without the pending merge the kept
    // fact would sit idle until /blackhole flush.
    expect(observedInput(0).priorObservations.join("\n")).toContain("manual kept fact");
  });

  test("a halve retry re-emitting the kept fact stores no second wrapper", async () => {
    const entries = [
      rawMessage("s0", text("OLD-A")),
      rawMessage("s1", text("OLD-B")),
      rawMessage("s2", text("OLD-C")),
      rawMessage("s3", text("OLD-D")),
    ];
    const runtime = makeRuntime(700, 2000);
    const pi = { appendEntry: vi.fn() };
    // Same content hashes to the same id: the [s0,s1] retry re-emits the fact
    // the full-chunk attempt already kept.
    runObserverSpy
      .mockResolvedValueOnce({
        unanchoredObservations: [observation("dddddddddddd", { sourceEntryIds: ["s2", "s3"] })],
      })
      .mockResolvedValueOnce({
        unanchoredObservations: [observation("dddddddddddd", { sourceEntryIds: ["s1"] })],
      })
      .mockResolvedValueOnce(emptyResult());

    await runStage(runtime, entries, resolveModelSession(), pi);

    // One wrapper, not two — but the halve-and-retry still runs to cover the head.
    const unanchoredWrites = pi.appendEntry.mock.calls.filter(
      ([customType]) => customType === "om.observations.unanchored",
    );
    expect(unanchoredWrites).toHaveLength(1);
    expect(observedInput(1).allowedSourceEntryIds).toEqual(["s0", "s1"]);
  });

  test("a fact already kept on the branch is not stored again", async () => {
    const kept = observation("aaaaaaaaaaaa", {
      content: "kept tail fact",
      sourceEntryIds: ["s2", "s3"],
    });
    const entries = [
      rawMessage("s0", text("OLD-A")),
      rawMessage("s1", text("OLD-B")),
      rawMessage("s2", text("OLD-C")),
      rawMessage("s3", text("OLD-D")),
      {
        type: "custom",
        id: "om-unanchored-1",
        customType: "om.observations.unanchored",
        data: { observations: [kept] },
      } as unknown as TestEntry,
    ];
    const runtime = makeRuntime(700, 2000);
    const pi = { appendEntry: vi.fn() };
    // A later cycle re-offered the same chunk and the model distilled the
    // identical fact: same content, same hash id.
    runObserverSpy
      .mockResolvedValueOnce({
        unanchoredObservations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["s2", "s3"] })],
      })
      .mockResolvedValueOnce(emptyResult());

    await runStage(runtime, entries, resolveModelSession(), pi);

    expect(
      pi.appendEntry.mock.calls.filter(
        ([customType]) => customType === "om.observations.unanchored",
      ),
    ).toHaveLength(0);
    expect(observedInput(1).allowedSourceEntryIds).toEqual(["s0", "s1"]);
  });

  test("an all-duplicate keep stores nothing and halves with the plain line", async () => {
    const kept = observation("aaaaaaaaaaaa", {
      content: "kept tail fact",
      sourceEntryIds: ["s2", "s3"],
    });
    const entries = [
      rawMessage("s0", text("OLD-A")),
      rawMessage("s1", text("OLD-B")),
      rawMessage("s2", text("OLD-C")),
      rawMessage("s3", text("OLD-D")),
      {
        type: "custom",
        id: "om-unanchored-1",
        customType: "om.observations.unanchored",
        data: { observations: [kept] },
      } as unknown as TestEntry,
    ];
    const runtime = makeRuntime(700, 2000);
    const pi = { appendEntry: vi.fn() };
    const workerInfo = vi.spyOn(runtime, "tryEmitWorkerInfo");
    runObserverSpy
      .mockResolvedValueOnce({
        unanchoredObservations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["s2", "s3"] })],
      })
      .mockResolvedValueOnce(emptyResult());

    await runStage(runtime, entries, resolveModelSession(), pi);

    expect(pi.appendEntry).not.toHaveBeenCalled();
    expect(observedInput(1).allowedSourceEntryIds).toEqual(["s0", "s1"]);
    // Nothing was kept, so the toast must not claim a keep: it falls back to
    // the same plain halving line the discard path emits.
    const halveLines = workerInfo.mock.calls
      .map(([, , message]) => String(message))
      .filter((message) => message.includes("halving chunk to 2 entries"));
    expect(halveLines).toHaveLength(1);
    expect(halveLines[0]).not.toContain("kept");
  });

  test("a mixed keep stores only the new fact", async () => {
    const kept = observation("aaaaaaaaaaaa", {
      content: "kept tail fact",
      sourceEntryIds: ["s2", "s3"],
    });
    const entries = [
      rawMessage("s0", text("OLD-A")),
      rawMessage("s1", text("OLD-B")),
      rawMessage("s2", text("OLD-C")),
      rawMessage("s3", text("OLD-D")),
      {
        type: "custom",
        id: "om-unanchored-1",
        customType: "om.observations.unanchored",
        data: { observations: [kept] },
      } as unknown as TestEntry,
    ];
    const runtime = makeRuntime(700, 2000);
    const pi = { appendEntry: vi.fn() };
    runObserverSpy
      .mockResolvedValueOnce({
        unanchoredObservations: [
          observation("aaaaaaaaaaaa", { sourceEntryIds: ["s2", "s3"] }),
          observation("cccccccccccc", { sourceEntryIds: ["s3"] }),
        ],
      })
      .mockResolvedValueOnce(emptyResult());

    await runStage(runtime, entries, resolveModelSession(), pi);

    const unanchoredWrites = pi.appendEntry.mock.calls.filter(
      ([customType]) => customType === "om.observations.unanchored",
    );
    expect(unanchoredWrites).toHaveLength(1);
    expect(unanchoredWrites[0][1]).toEqual({
      observations: [observation("cccccccccccc", { sourceEntryIds: ["s3"] })],
    });
  });

  test("manual mode drops a keep already buffered in pending", async () => {
    const entries = [
      rawMessage("s0", text("OLD-A")),
      rawMessage("s1", text("OLD-B")),
      rawMessage("s2", text("OLD-C")),
      rawMessage("s3", text("OLD-D")),
    ];
    const runtime = makeRuntime(700, 2000);
    runtime.config.compaction = "manual";
    const pi = { appendEntry: vi.fn() };
    savePendingUnanchored("test-session", {
      data: { observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["s2", "s3"] })] },
    });
    runObserverSpy
      .mockResolvedValueOnce({
        unanchoredObservations: [
          observation("aaaaaaaaaaaa", { sourceEntryIds: ["s2", "s3"] }),
          observation("bbbbbbbbbbbb", { sourceEntryIds: ["s3"] }),
        ],
      })
      .mockResolvedValueOnce(emptyResult());

    await runStage(runtime, entries, resolveModelSession(), pi);

    // Manual mode never appends; the buffered dup is filtered before the new
    // batch lands, so the file holds the old batch plus exactly the new fact.
    expect(pi.appendEntry).not.toHaveBeenCalled();
    const pending = readPendingState("test-session");
    expect(pending.unanchoredBatches).toHaveLength(2);
    const secondBatch = pending.unanchoredBatches?.[1];
    if (!secondBatch) throw new Error("expected a second unanchored batch");
    expect((secondBatch.data as any).observations.map((o: any) => o.id)).toEqual(["bbbbbbbbbbbb"]);
  });

  test("manual mode drops a keep already recorded on the branch", async () => {
    const entries = [
      rawMessage("s0", text("OLD-A")),
      rawMessage("s1", text("OLD-B")),
      rawMessage("s2", text("OLD-C")),
      rawMessage("s3", text("OLD-D")),
      observationsRecordedEntry("om-recorded-1", {
        observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["s0"], tokenCount: 10 })],
        coversUpToId: "s0",
      }),
    ];
    const runtime = makeRuntime(700, 2000);
    runtime.config.compaction = "manual";
    const pi = { appendEntry: vi.fn() };
    // Pre-switch leftover: the fact lives in a branch recorded marker while
    // pending is empty. A re-emit must not buffer a redundant batch.
    runObserverSpy
      .mockResolvedValueOnce({
        unanchoredObservations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["s1"] })],
      })
      .mockResolvedValueOnce(emptyResult());

    await runStage(runtime, entries, resolveModelSession(), pi);

    expect(pi.appendEntry).not.toHaveBeenCalled();
    expect(readPendingState("test-session").unanchoredBatches ?? []).toEqual([]);
    // Chunk was [s1, s2, s3]; halving three entries offers the head one.
    expect(observedInput(1).allowedSourceEntryIds).toEqual(["s1"]);
  });
});
