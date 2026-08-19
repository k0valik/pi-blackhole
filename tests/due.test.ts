/**
 * Tests for the truthful stage-due measurement core (plan-03).
 *
 * Covers threshold resolution (explicit vs auto-derived, scale, clamps),
 * the worker-window upper bound (D7), and the per-stage measurement
 * functions (usage basis, estimate fallback, anchor resolution).
 */
import { describe, test, expect, beforeEach } from "vitest";
import { Runtime } from "../src/om/runtime.js";
import {
  COMPACT_THRESHOLD_RATIO,
  DERIVED_THRESHOLD_MIN_TOKENS,
  measureDropperDue,
  measureObserverDue,
  measureReflectorDue,
  resolveCompactThreshold,
  resolveTriggerThresholds,
  STAGE_OVERHEAD,
  AGENT_LOOP_RESERVE,
} from "../src/om/due.js";
import {
  compactionEntry,
  observation,
  observationsRecordedEntry,
  reflection,
  reflectionsRecordedEntry,
  observationsDroppedEntry,
  rawMessage,
} from "./fixtures/session.js";

/** Assistant entry with a valid usage payload (real token count). */
function assistantEntry(
  id: string,
  text: string,
  usageTokens: number,
  stopReason = "stop",
) {
  return rawMessage(id, text, {
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: usageTokens,
      },
    },
  });
}

function userEntry(id: string, text: string) {
  return rawMessage(id, text);
}

const DUE_CTX = { model: { contextWindow: 128_000 } };

describe("resolveTriggerThresholds", () => {
  test("auto-derives from the session window with plan ratios", () => {
    const runtime = new Runtime();
    const t = resolveTriggerThresholds(runtime.config, 128_000);
    expect(t.observeAfterTokens).toBe(Math.floor(128_000 * 0.25));
    expect(t.reflectAfterTokens).toBe(Math.floor(128_000 * 0.4));
    expect(t.compactAfterTokens).toBe(Math.floor(128_000 * 0.65));
  });

  test("explicit config values are honored verbatim", () => {
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 500;
    runtime.config.reflectAfterTokens = 1_234;
    runtime.config.compactAfterTokens = 99_000;
    const t = resolveTriggerThresholds(runtime.config, 128_000);
    expect(t).toEqual({
      observeAfterTokens: 500,
      reflectAfterTokens: 1_234,
      compactAfterTokens: 99_000,
    });
  });

  test("thresholdScale multiplies auto-derived values only", () => {
    const runtime = new Runtime();
    runtime.config.thresholdScale = 0.5;
    runtime.config.observeAfterTokens = 500; // explicit — scale ignored
    const t = resolveTriggerThresholds(runtime.config, 128_000);
    expect(t.observeAfterTokens).toBe(500);
    expect(t.reflectAfterTokens).toBe(Math.floor(128_000 * 0.4 * 0.5));
    expect(t.compactAfterTokens).toBe(Math.floor(128_000 * 0.65 * 0.5));
  });

  test("derived thresholds clamp to a minimum of 1000", () => {
    const runtime = new Runtime();
    const t = resolveTriggerThresholds(runtime.config, 2_000);
    expect(t.observeAfterTokens).toBe(DERIVED_THRESHOLD_MIN_TOKENS);
    expect(t.reflectAfterTokens).toBe(DERIVED_THRESHOLD_MIN_TOKENS);
    expect(t.compactAfterTokens).toBe(
      Math.max(Math.floor(2_000 * COMPACT_THRESHOLD_RATIO), 1_000),
    );
  });

  test("resolveCompactThreshold returns the compaction leg", () => {
    const runtime = new Runtime();
    runtime.config.compactAfterTokens = 0;
    runtime.config.thresholdScale = 2;
    expect(resolveCompactThreshold(runtime.config, 128_000)).toBe(
      Math.floor(128_000 * 0.65 * 2),
    );
    runtime.config.compactAfterTokens = 77_000;
    expect(resolveCompactThreshold(runtime.config, 128_000)).toBe(77_000);
  });
});

describe("measureObserverDue", () => {
  beforeEach(() => {
    // Default config has all-zero thresholds → auto-derive from window.
  });

  test("fresh session with usage reports real context (usage basis)", () => {
    const runtime = new Runtime();
    const entries = [
      userEntry("u1", "aaaaaaaa"),
      assistantEntry("a1", "bbbbbbbb", 40_000),
    ];
    const m = measureObserverDue(entries, runtime, DUE_CTX);
    expect(m.basis).toBe("usage");
    expect(m.progress).toBe(40_000);
    expect(m.anchorIndex).toBe(-1);
    // 40_000 ≥ floor(128_000 × 0.25) = 32_000 → due
    expect(m.due).toBe(true);
  });

  test("fresh session without usage falls back to the chars/4 estimate", () => {
    const runtime = new Runtime();
    const entries = [userEntry("u1", "x".repeat(400))];
    const m = measureObserverDue(entries, runtime, DUE_CTX);
    expect(m.basis).toBe("estimate");
    expect(m.progress).toBe(100);
    expect(m.due).toBe(false);
  });

  test("cursor anchor measures the delta since the cursor entry", () => {
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 40;
    const entries = [
      userEntry("u1", "x".repeat(200)),
      userEntry("u2", "x".repeat(200)),
    ];
    runtime.advanceCursor("observer", "u1", "empty");
    const m = measureObserverDue(entries, runtime, DUE_CTX);
    expect(m.anchorIndex).toBe(0);
    expect(m.basis).toBe("estimate");
    expect(m.progress).toBe(50); // u2 only
    expect(m.due).toBe(true);
  });

  test("cold start anchors at the latest compaction entry", () => {
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 5_000;
    const entries = [
      compactionEntry("c1"),
      assistantEntry("a1", "bbbbbbbb", 50_000),
      userEntry("u1", "x".repeat(400)),
      assistantEntry("a2", "cccccccc", 60_000),
    ];
    const m = measureObserverDue(entries, runtime, DUE_CTX);
    expect(m.anchorIndex).toBe(0); // compaction entry
    expect(m.basis).toBe("usage");
    // Baseline = usage strictly after compaction (50_000); delta = 10_000.
    expect(m.progress).toBe(10_000);
    expect(m.due).toBe(true);
  });

  test("coverage marker anchors when no cursor exists", () => {
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 40;
    const entries = [
      userEntry("u1", "x".repeat(200)),
      observationsRecordedEntry("om-obs", {
        observations: [observation("aaaaaaaaaaaa", { relevance: "medium" })],
        coversUpToId: "u1",
      }),
      userEntry("u2", "x".repeat(200)),
    ];
    const m = measureObserverDue(entries, runtime, DUE_CTX);
    expect(m.anchorIndex).toBe(0); // index of the covered entry (u1)
    expect(m.progress).toBe(50); // u2 only
    expect(m.due).toBe(true);
  });

  test("worker-window upper bound caps the threshold (D7)", () => {
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100_000;
    runtime.config.observerModel = { contextWindow: 20_000 };
    const entries = [
      userEntry("u1", "x".repeat(400)),
      assistantEntry("a1", "bbbbbbbb", 10_000),
    ];
    const m = measureObserverDue(entries, runtime, DUE_CTX);
    const upperBound = 20_000 - AGENT_LOOP_RESERVE - STAGE_OVERHEAD;
    expect(m.upperBoundApplied).toBe(true);
    expect(m.threshold).toBe(upperBound);
    expect(m.due).toBe(true); // 10_000 ≥ upperBound(8_000)
  });

  test("upper bound can also suppress a due stage", () => {
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100_000;
    runtime.config.observerModel = { contextWindow: 20_000 };
    const entries = [assistantEntry("a1", "bbbbbbbb", 5_000)];
    const m = measureObserverDue(entries, runtime, DUE_CTX);
    expect(m.upperBoundApplied).toBe(true);
    expect(m.due).toBe(false); // 5_000 < 8_000
  });
});

describe("measureReflectorDue / measureDropperDue", () => {
  test("reflector uses reflectAfterTokens and reflections-recorded coverage", () => {
    const runtime = new Runtime();
    runtime.config.reflectAfterTokens = 40;
    const entries = [
      userEntry("u1", "x".repeat(200)),
      reflectionsRecordedEntry("om-ref", {
        reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
        coversUpToId: "u1",
      }),
      userEntry("u2", "x".repeat(200)),
    ];
    const m = measureReflectorDue(entries, runtime, DUE_CTX);
    expect(m.anchorIndex).toBe(0); // index of the covered entry (u1)
    expect(m.progress).toBe(50);
    expect(m.due).toBe(true);
  });

  test("dropper uses reflectAfterTokens and observations-dropped coverage", () => {
    const runtime = new Runtime();
    runtime.config.reflectAfterTokens = 40;
    const entries = [
      userEntry("u1", "x".repeat(200)),
      observationsDroppedEntry("om-drop", {
        observationIds: ["aaaaaaaaaaaa"],
        coversUpToId: "u1",
      }),
      userEntry("u2", "x".repeat(200)),
    ];
    const m = measureDropperDue(entries, runtime, DUE_CTX);
    expect(m.anchorIndex).toBe(0); // index of the covered entry (u1)
    expect(m.progress).toBe(50);
    expect(m.due).toBe(true);
  });

  test("dropper worker window comes from dropperModel", () => {
    const runtime = new Runtime();
    runtime.config.reflectAfterTokens = 100_000;
    runtime.config.dropperModel = { contextWindow: 20_000 };
    const entries = [assistantEntry("a1", "bbbbbbbb", 9_000)];
    const m = measureDropperDue(entries, runtime, DUE_CTX);
    expect(m.upperBoundApplied).toBe(true);
    expect(m.due).toBe(true);
  });

  test("unmeasurable baseline falls back to estimate basis", () => {
    const runtime = new Runtime();
    runtime.config.reflectAfterTokens = 40;
    const entries = [
      compactionEntry("c1"),
      userEntry("u1", "x".repeat(200)),
      userEntry("u2", "x".repeat(200)),
    ];
    const m = measureReflectorDue(entries, runtime, DUE_CTX);
    expect(m.basis).toBe("estimate");
    expect(m.progress).toBe(100); // both entries after compaction
    expect(m.due).toBe(true);
  });

  test("getContextUsage thunk wins over model.contextWindow", () => {
    const runtime = new Runtime();
    runtime.config.reflectAfterTokens = 0; // auto-derive from window
    const entries = [assistantEntry("a1", "bbbbbbbb", 64_000)];
    // getContextUsage reports 100k window → derived threshold 40_000.
    const m = measureReflectorDue(entries, runtime, {
      model: { contextWindow: 128_000 },
      getContextUsage: () => ({ contextWindow: 100_000 }),
    });
    expect(m.threshold).toBe(Math.floor(100_000 * 0.4));
    expect(m.due).toBe(true);
  });
});
