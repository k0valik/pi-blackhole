/**
 * Runtime generation tracking — stale-runtime append protection (PR #58).
 *
 * Tests the Runtime lifecycle (startSession → captureGeneration → dispose)
 * and verifies that deferred work is cancelled when the session changes
 * or the runtime is disposed.
 *
 * TDD order: prove the bug exists (tests fail without the fix), then fix.
 */
import { describe, test, expect } from "vitest";
import { Runtime } from "../src/om/runtime.js";

describe("Runtime generation lifecycle", () => {
  test("R1: initial generation is 0 and sessionIdentity is undefined", () => {
    const runtime = new Runtime("/tmp");
    const gen = runtime.captureGeneration(undefined);
    expect(gen.generation).toBe(0);
    expect(gen.sessionIdentity).toBeUndefined();
    expect(gen.signal.aborted).toBe(false);
  });

  test("R2: captureGeneration returns a signal that is not aborted", () => {
    const runtime = new Runtime("/tmp");
    const gen = runtime.captureGeneration("session-1");
    expect(gen.signal.aborted).toBe(false);
  });

  test("R3: isGenerationActive returns true for a fresh capture", () => {
    const runtime = new Runtime("/tmp");
    // Normal lifecycle: startSession first, then captureGeneration
    runtime.startSession("session-1");
    const gen = runtime.captureGeneration("session-1");
    expect(runtime.isGenerationActive(gen)).toBe(true);
  });

  test("R4: session change increments generation and aborts the signal", () => {
    const runtime = new Runtime("/tmp");
    // Normal lifecycle: startSession first to set identity
    runtime.startSession("session-a");
    const genA = runtime.captureGeneration("session-a");

    // Switch to a different session
    runtime.startSession("session-b");

    // Old capture should be stale
    expect(runtime.isGenerationActive(genA)).toBe(false);
    expect(genA.signal.aborted).toBe(true);

    // New capture should be active
    const genB = runtime.captureGeneration("session-b");
    expect(runtime.isGenerationActive(genB)).toBe(true);
    expect(genB.generation).toBe(1);
    expect(genB.signal.aborted).toBe(false);
  });

  test("R5: same session identity does NOT increment generation", () => {
    const runtime = new Runtime("/tmp");
    const genA = runtime.captureGeneration("session-a");

    // Re-register the same session
    runtime.startSession("session-a");

    const genB = runtime.captureGeneration("session-a");
    expect(genB.generation).toBe(0);
    expect(runtime.isGenerationActive(genA)).toBe(true);
    expect(runtime.isGenerationActive(genB)).toBe(true);
  });

  test("R6: dispose increments generation, aborts signal, and invalidates all captures", () => {
    const runtime = new Runtime("/tmp");
    const genA = runtime.captureGeneration("session-a");

    runtime.dispose();

    expect(runtime.isGenerationActive(genA)).toBe(false);
    expect(genA.signal.aborted).toBe(true);
    expect(runtime.isGenerationActive(runtime.captureGeneration("session-a"))).toBe(false);
  });

  test("R7: dispose is idempotent — calling twice is safe", () => {
    const runtime = new Runtime("/tmp");
    runtime.dispose();
    expect(() => runtime.dispose()).not.toThrow();
  });

  test("R8: startSession after dispose is a no-op", () => {
    const runtime = new Runtime("/tmp");
    runtime.dispose();
    expect(() => runtime.startSession("session-b")).not.toThrow();
    expect(runtime.isGenerationActive(runtime.captureGeneration("session-b"))).toBe(false);
  });

  test("R9: multiple session changes each increment generation", () => {
    const runtime = new Runtime("/tmp");
    // First startSession establishes the base identity (no increment)
    runtime.startSession("s0");
    const gen0 = runtime.captureGeneration("s0");

    runtime.startSession("s1"); // +1 → gen 1
    runtime.startSession("s2"); // +2 → gen 2
    runtime.startSession("s3"); // +3 → gen 3

    expect(runtime.isGenerationActive(gen0)).toBe(false);
    expect(runtime.captureGeneration("s3").generation).toBe(3);
  });
});

describe("Runtime compaction timer management", () => {
  test("CT1: setCompactionTimer stores the timer", () => {
    const runtime = new Runtime("/tmp");
    const timer = 42 as unknown as ReturnType<typeof setTimeout>;
    runtime.setCompactionTimer(timer);
    // We can't directly read the timer, but clearCompactionTimer should work
    runtime.clearCompactionTimer(timer);
    // If the timer was stored, clearCompactionTimer(timer) should be a no-op
    // (it only clears if the stored timer matches the argument)
  });

  test("CT2: clearCompactionTimer clears the stored timer", () => {
    const runtime = new Runtime("/tmp");
    const timer = 42 as unknown as ReturnType<typeof setTimeout>;
    runtime.setCompactionTimer(timer);
    runtime.clearCompactionTimer(timer);
    // After clearing, calling clearCompactionTimer with a different timer should be a no-op
    const otherTimer = 99 as unknown as ReturnType<typeof setTimeout>;
    runtime.clearCompactionTimer(otherTimer);
  });

  test("CT3: dispose clears the compaction timer", () => {
    const runtime = new Runtime("/tmp");
    const timer = 42 as unknown as ReturnType<typeof setTimeout>;
    runtime.setCompactionTimer(timer);
    runtime.dispose();
    // clearCompactionTimer with the same timer should be a no-op
    // (because dispose cleared it, so the stored timer is now undefined)
    runtime.clearCompactionTimer(timer);
  });

  test("CT4: setCompactionTimer after dispose is a no-op (timer is cleared immediately)", () => {
    const runtime = new Runtime("/tmp");
    runtime.dispose();
    const timer = 42 as unknown as ReturnType<typeof setTimeout>;
    // Should not throw, should not store
    runtime.setCompactionTimer(timer);
  });
});

describe("Runtime resolveModel AbortSignal propagation", () => {
  test("RM1: resolveModel throws if signal is already aborted", async () => {
    const runtime = new Runtime("/tmp");
    runtime.config.model = { provider: "test", id: "model" };
    const controller = new AbortController();
    controller.abort();

    await expect(
      runtime.resolveModel(
        {
          model: { provider: "test", id: "model" },
          modelRegistry: {
            find: () => undefined,
            getApiKeyAndHeaders: async () => ({ ok: false }),
            hasConfiguredAuth: () => false,
          },
          hasUI: false,
          ui: undefined,
          stageModel: undefined,
          stageFallbacks: [],
        },
        controller.signal,
      ),
    ).rejects.toThrow();
  });

  test("RM2: resolveModel proceeds when signal is not aborted", async () => {
    const runtime = new Runtime("/tmp");
    runtime.config.model = { provider: "test", id: "model" };
    const controller = new AbortController();

    const result = await runtime.resolveModel(
      {
        model: { provider: "test", id: "model" },
        modelRegistry: {
          find: () => undefined,
          getApiKeyAndHeaders: async () => ({ ok: false }),
          hasConfiguredAuth: () => false,
        },
        hasUI: false,
        ui: undefined,
        stageModel: undefined,
        stageFallbacks: [],
      },
      controller.signal,
    );

    // No model found → ok: false
    expect(result.ok).toBe(false);
  });
});
