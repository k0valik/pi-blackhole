import { afterEach, beforeEach, describe, test, expect, vi } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/om/runtime.js";
import {
  makeModelResolver,
  runConsolidationPipeline,
  capSourceEntriesToTokens,
  anyStageDue,
  type ConsolidationCtx,
} from "../src/om/consolidation.js";
import {
  branchSummary,
  compactionEntry,
  customMessage,
  observation,
  observationsDroppedEntry,
  observationsRecordedEntry,
  rawMessage,
  reflection,
  reflectionsRecordedEntry,
  textCustomMessage,
  type TestEntry,
} from "./fixtures/session.js";
import { createExtensionApiDouble } from "./fixtures/pi-extension-api.js";
import {
  clearPendingState,
  readPendingState,
  savePendingDropped,
  savePendingObservation,
} from "../src/om/pending.js";

/** Cursor round trips write real pending files, so redirect the agent dir. */
const cursorTestDir = join(tmpdir(), `pi-blackhole-consolidation-cursors-${Date.now()}`);
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, getAgentDir: () => cursorTestDir };
});

interface ObserverAgentInput {
  chunk: string;
  allowedSourceEntryIds: string[];
  priorObservations: string[];
  priorReflections: string[];
  model?: { provider?: string; id?: string };
  signal?: AbortSignal;
}

interface DropperAgentInput {
  model: { provider: string; id: string };
  observations: Array<{ id: string }>;
  budgetTokens: number;
  signal?: AbortSignal;
}

const agents = vi.hoisted(() => ({
  runObserver: vi.fn<(input: ObserverAgentInput) => Promise<unknown>>(),
  runReflector: vi.fn(),
  runDropper: vi.fn<(input: DropperAgentInput) => Promise<string[] | undefined>>(),
}));
vi.mock("../src/om/agents/observer/agent.js", () => ({ runObserver: agents.runObserver }));
vi.mock("../src/om/agents/reflector/agent.js", () => ({ runReflector: agents.runReflector }));
vi.mock("../src/om/agents/dropper/agent.js", () => ({ runDropper: agents.runDropper }));

function mockCtx(notifyCalls: Array<{ message: string; level?: string }>): ConsolidationCtx {
  return {
    cwd: "/tmp",
    hasUI: true,
    ui: {
      notify: (message: string, type?: "warning" | "info" | "error") => {
        notifyCalls.push({ message, level: type });
      },
    },
    model: undefined,
    modelRegistry: {
      find: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: false }),
    },
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => "test-session",
    },
  };
}

describe("makeModelResolver — per-stage failure notifications", () => {
  test("each stage shows its own failure notification when no models are available", async () => {
    const runtime = new Runtime("/tmp");
    runtime.config.memory = true;
    // No observer/reflector/dropper models configured → all fail
    runtime.config.observerModel = undefined;
    runtime.config.reflectorModel = undefined;
    runtime.config.dropperModel = undefined;
    runtime.config.observerFallbackModels = [];
    runtime.config.reflectorFallbackModels = [];
    runtime.config.dropperFallbackModels = [];

    const notifyCalls: Array<{ message: string; level?: string }> = [];
    const ctx = mockCtx(notifyCalls);
    const generation = runtime.captureGeneration("test-session");
    const resolver = makeModelResolver(runtime, ctx, generation);

    // Observer stage fails → should show notification
    runtime.consolidationPhase = "observer";
    runtime.resolveFailureNotified = false;
    const observerResult = await resolver("observer");
    expect(observerResult).toBeUndefined();
    expect(notifyCalls.length).toBe(1);
    expect(notifyCalls[0]!.message).toContain("skipping note-taking");

    // Pipeline resets the flag at each stage boundary
    runtime.resolveFailureNotified = false;

    // Reflector stage ALSO fails → should show its own notification
    runtime.consolidationPhase = "reflector";
    const reflectorResult = await resolver("reflector");
    expect(reflectorResult).toBeUndefined();
    expect(notifyCalls.length).toBe(2);
    expect(notifyCalls[1]!.message).toContain("skipping insight-building");
  });
});

describe("anyStageDue with cursors", () => {
  test("observer NOT due when cursor has advanced past all entries", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    // Fake config - observe threshold is 100 tokens
    runtime.config.observeAfterTokens = 100;
    runtime.config.reflectAfterTokens = 100000; // keep reflector/dropper from being due
    runtime.config.observationsPoolMaxTokens = 1000;
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 500;
    // Cursor has advanced past all entries → observer should NOT be due
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "hello world this is a long message that should be over 100 tokens worth of characters",
            },
          ],
        },
      },
    ];
    runtime.advanceCursor("observer", "msg-1", "empty");
    expect(anyStageDue(entries, runtime, undefined)).toBe(false);
  });

  test("observer NOT due when no cursor and tokens below threshold (no observation markers)", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100;
    runtime.config.reflectAfterTokens = 100000;
    runtime.config.observationsPoolMaxTokens = 1000;
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 500;
    // No cursor, tokens over threshold → observer should be due
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "hello world this is a long message that should be over 100 tokens worth of characters and more stuff to make it longer and longer and longer",
            },
          ],
        },
      },
    ];
    expect(anyStageDue(entries, runtime, undefined)).toBe(false); // no observer markers → raw tokens counted from scratch
  });

  test("dropper NOT due when cursor advanced and no new data, no pressure", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 5;
    runtime.config.observationsPoolMaxTokens = 100_000;
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 500;
    // Cursor advanced past all entries, pool < 10%, no new data → dropper NOT due
    const entries = [
      {
        type: "custom",
        id: "obs-1",
        customType: "om.observations.recorded",
        data: {
          observations: [{ id: "o1", content: "a".repeat(100), tokenCount: 25 }],
        },
      },
    ];
    runtime.advanceCursor("dropper", "obs-1", "skipped");
    expect(anyStageDue(entries, runtime, undefined)).toBe(false);
  });

  test("dropper due via the new-data path once the pool clears the constant floor", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 5;
    runtime.config.observationsPoolMaxTokens = 10_000;
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 10_000; // pressure needs 7,000 — pool only has 1,400
    // No dropper cursor → token condition is rawTokensSinceDropCoverage ≥ 5 (msg-1 ≈ 50 tokens).
    // Pool: 2 obs × 700 = 1,400 / 10,000 = 14% ≥ the constant 10% floor → dropper due.
    // Reflector is silenced by advancing its cursor past all entries.
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "a".repeat(200) }],
        },
      },
      {
        type: "custom",
        id: "obs-1",
        customType: "om.observations.recorded",
        data: {
          coversUpToId: "msg-1",
          observations: [
            {
              id: "aaaaaaaaaaaa",
              content: "x".repeat(100),
              timestamp: "2026-08-01T00:00:00.000Z",
              relevance: "low",
              sourceEntryIds: ["msg-1"],
              tokenCount: 700,
            },
            {
              id: "bbbbbbbbbbbb",
              content: "y".repeat(100),
              timestamp: "2026-08-01T00:00:00.001Z",
              relevance: "medium",
              sourceEntryIds: ["msg-1"],
              tokenCount: 700,
            },
          ],
        },
      },
    ];
    runtime.advanceCursor("reflector", "obs-1", "skipped");
    expect(anyStageDue(entries, runtime, undefined)).toBe(true);
  });

  test("dropper NOT due when pool fullness is below the constant floor", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 5;
    runtime.config.observationsPoolMaxTokens = 100_000;
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 10_000; // pressure needs 7,000 — pool only has 1,400
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "a".repeat(200) }],
        },
      },
      {
        type: "custom",
        id: "obs-1",
        customType: "om.observations.recorded",
        data: {
          coversUpToId: "msg-1",
          observations: [
            {
              id: "aaaaaaaaaaaa",
              content: "x".repeat(100),
              timestamp: "2026-08-01T00:00:00.000Z",
              relevance: "low",
              sourceEntryIds: ["msg-1"],
              tokenCount: 700,
            },
            {
              id: "bbbbbbbbbbbb",
              content: "y".repeat(100),
              timestamp: "2026-08-01T00:00:00.001Z",
              relevance: "medium",
              sourceEntryIds: ["msg-1"],
              tokenCount: 700,
            },
          ],
        },
      },
    ];
    runtime.advanceCursor("reflector", "obs-1", "skipped");
    expect(anyStageDue(entries, runtime, undefined)).toBe(false);
  });

  test("reflector due when new observation batches exist AND token threshold met", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 10;
    runtime.config.observationsPoolMaxTokens = 100_000;
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 500;
    // Cursor at msg-1, enough tokens after cursor (msg-2 has 200 chars ~50 tokens) + new obs batch → reflector due
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "cursor here" }],
        },
      },
      {
        type: "message",
        id: "msg-2",
        message: {
          role: "user",
          content: [{ type: "text", text: "x".repeat(200) }],
        },
      },
      {
        type: "custom",
        id: "obs-2",
        customType: "om.observations.recorded",
        data: { observations: [] },
      },
    ];
    runtime.advanceCursor("reflector", "msg-1", "recorded");
    expect(anyStageDue(entries, runtime, undefined)).toBe(true);
  });

  test("reflector NOT due when new obs batch exists but token threshold NOT met", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 500; // need 500 tokens
    runtime.config.observationsPoolMaxTokens = 100_000;
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 500;
    // Cursor at msg-1, only 50 chars (~12 tokens) after cursor (msg-2) → below 500 threshold
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "cursor here" }],
        },
      },
      {
        type: "message",
        id: "msg-2",
        message: { role: "user", content: [{ type: "text", text: "tiny" }] },
      },
      {
        type: "custom",
        id: "obs-2",
        customType: "om.observations.recorded",
        data: { observations: [] },
      },
    ];
    runtime.advanceCursor("reflector", "msg-1", "recorded");
    expect(anyStageDue(entries, runtime, undefined)).toBe(false);
  });
});

describe("anyStageDue with pending state (manual mode)", () => {
  test("reflector due when pending observation batch exists after cursor", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 10;
    runtime.config.observationsPoolMaxTokens = 100_000;
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 500;
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "x".repeat(200) }],
        },
      },
      {
        type: "message",
        id: "msg-2",
        message: {
          role: "user",
          content: [{ type: "text", text: "x".repeat(200) }],
        },
      },
    ];
    runtime.advanceCursor("reflector", "msg-1", "recorded");
    const pending: any = {
      observationBatches: [{ coversUpToId: "msg-2", data: { observations: [] } }],
    };
    expect(anyStageDue(entries, runtime, pending)).toBe(true);
  });

  test("dropper due when pending pool exceeds threshold (manual mode)", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 100000;
    runtime.config.observationsPoolMaxTokens = 1000;
    runtime.config.dropperPressureThreshold = 0.99;
    runtime.config.reflectorInputMaxTokens = 1000;
    // Branch has conversation entries (normal manual mode), no OM markers.
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "x".repeat(200) }],
        },
      },
    ];
    const pending: any = {
      observationBatches: [
        {
          coversUpToId: "msg-1",
          data: {
            observations: [{ id: "o1", content: "x".repeat(500), tokenCount: 125 }],
          },
        },
      ],
    };
    // No cursors → rawTokensSinceDropCoverage on entries with conversation
    // → some tokens > 0.  Pool from pending: 125/1000 = 12.5% > 10%.
    // Both gates pass → dropper due.
    expect(anyStageDue(entries, runtime, pending)).toBe(true);
  });

  test("pipeline launches when observer not due but pending has new data for reflector", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 5;
    runtime.config.observationsPoolMaxTokens = 100_000;
    runtime.config.dropperPressureThreshold = 0.99;
    runtime.config.reflectorInputMaxTokens = 500;
    // Observer cursor advanced past all entries → not due
    // Reflector cursor is behind (at msg-1), new batch at msg-2
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: { role: "user", content: [{ type: "text", text: "old" }] },
      },
      {
        type: "message",
        id: "msg-2",
        message: {
          role: "user",
          content: [{ type: "text", text: "new message after reflector cursor" }],
        },
      },
    ];
    runtime.advanceCursor("observer", "msg-2", "recorded"); // advanced past all
    runtime.advanceCursor("reflector", "msg-1", "recorded"); // still at msg-1
    // Pending has a NEW batch (coversUpToId after the reflector cursor)
    const pending: any = {
      observationBatches: [
        { coversUpToId: "msg-1", data: { observations: [] } }, // old, cursor is here
        {
          coversUpToId: "msg-2",
          data: {
            observations: [{ id: "o2", content: "fresh", tokenCount: 10 }],
          },
        }, // new!
      ],
    };
    // Reflector should see the new batch at msg-2 (after cursor at msg-1)
    expect(anyStageDue(entries, runtime, pending)).toBe(true);
  });

  test("reflector due when cursor state 'initial' and pending batch exists after cursor", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 10;
    runtime.config.observationsPoolMaxTokens = 100_000;
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 500;

    // Branch entries - cursor fell back to msg-1 coverage marker (state "initial")
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "x".repeat(200) }],
        },
      },
      {
        type: "message",
        id: "msg-2",
        message: {
          role: "user",
          content: [{ type: "text", text: "x".repeat(200) }],
        },
      },
    ];
    runtime.advanceCursor("reflector", "msg-1", "initial");

    // Pending has a new batch at msg-2 (after cursor at msg-1)
    const pending: any = {
      observationBatches: [
        {
          coversUpToId: "msg-2",
          data: {
            observations: [
              {
                id: "a1b2c3d4e5f6",
                content: "fresh",
                timestamp: "2025-01-01T00:00:00Z",
                relevance: "medium",
                sourceEntryIds: ["msg-2"],
                tokenCount: 10,
              },
            ],
          },
        },
      ],
    };

    // Reflector should see new pending batch even when cursor.state is "initial"
    expect(anyStageDue(entries, runtime, pending)).toBe(true);
  });
});

describe("anyStageDue cursor vs branch-marker coversUpToId (auto mode)", () => {
  test("reflector NOT due: marker after cursor but coversUpToId IS the cursor entry", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 10;
    runtime.config.observationsPoolMaxTokens = 100_000;
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 500;

    // Cursor at msg-1. There's an OM_OBSERVATIONS_RECORDED marker AFTER msg-1
    // in the branch, but its coversUpToId IS msg-1 - data was already processed.
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "x".repeat(200) }],
        },
      },
      {
        type: "custom",
        id: "obs-1",
        customType: "om.observations.recorded",
        data: {
          coversUpToId: "msg-1",
          observations: [{ id: "o1", content: "test", tokenCount: 10 }],
        },
      },
    ];
    runtime.advanceCursor("reflector", "msg-1", "empty");
    expect(anyStageDue(entries, runtime, undefined)).toBe(false);
  });

  test("reflector IS due: marker after cursor with coversUpToId truly past cursor", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 10;
    runtime.config.observationsPoolMaxTokens = 100_000;
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 500;

    // Cursor at msg-1. Marker's coversUpToId is msg-2 (truly after cursor) → new data.
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "x".repeat(200) }],
        },
      },
      {
        type: "message",
        id: "msg-2",
        message: {
          role: "user",
          content: [{ type: "text", text: "x".repeat(200) }],
        },
      },
      {
        type: "custom",
        id: "obs-1",
        customType: "om.observations.recorded",
        data: {
          coversUpToId: "msg-2",
          observations: [{ id: "o1", content: "test", tokenCount: 10 }],
        },
      },
    ];
    runtime.advanceCursor("reflector", "msg-1", "empty");
    expect(anyStageDue(entries, runtime, undefined)).toBe(true);
  });

  test("dropper NOT due: marker after cursor but coversUpToId at cursor, pool too low", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 100000;
    runtime.config.observationsPoolMaxTokens = 100_000;
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 500;

    // Cursor at obs-1. Marker at obs-2 after it, but coversUpToId is obs-1.
    // Observer + reflector not due → dropper check runs.
    // Pool is tiny → below 10% → dropper NOT due.
    const entries = [
      {
        type: "custom",
        id: "obs-1",
        customType: "om.observations.recorded",
        data: {
          coversUpToId: "msg-0",
          observations: [{ id: "o1", content: "a", tokenCount: 1 }],
        },
      },
      {
        type: "custom",
        id: "obs-2",
        customType: "om.observations.recorded",
        data: {
          coversUpToId: "obs-1",
          observations: [{ id: "o2", content: "b", tokenCount: 1 }],
        },
      },
    ];
    runtime.advanceCursor("dropper", "obs-1", "empty");
    expect(anyStageDue(entries, runtime, undefined)).toBe(false);
  });

  test("dropper IS due: marker coversUpToId truly after cursor AND pool above threshold", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 5; // low enough that 6 tokens (> msg-2) passes the guard
    runtime.config.observationsPoolMaxTokens = 1000;
    runtime.config.dropperPressureThreshold = 0.99;
    runtime.config.reflectorInputMaxTokens = 1000;

    // Cursor at msg-1, new obs batch at obs-1 with coversUpToId msg-2 (after cursor).
    // tokensSince ≈ 6 > reflectAfterTokens(5) → passes token guard.
    // Pool: 500 tokens / 1000 max = 50% > 10% → dropper due.
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: { role: "user", content: [{ type: "text", text: "old" }] },
      },
      {
        type: "message",
        id: "msg-2",
        message: {
          role: "user",
          content: [{ type: "text", text: "new data after cursor" }],
        },
      },
      {
        type: "custom",
        id: "obs-1",
        customType: "om.observations.recorded",
        data: {
          coversUpToId: "msg-2",
          observations: [
            {
              id: "a1b2c3d4e5f6",
              content: "x".repeat(2000),
              timestamp: "2025-01-01T00:00:00Z",
              relevance: "medium",
              sourceEntryIds: ["msg-2"],
              tokenCount: 500,
            },
          ],
        },
      },
    ];
    runtime.advanceCursor("dropper", "msg-1", "empty");
    expect(anyStageDue(entries, runtime, undefined)).toBe(true);
  });

  test("dropper NOT due: new batches exist after cursor but token threshold not met", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 500; // need 500 tokens to pass guard
    runtime.config.observationsPoolMaxTokens = 1000;
    runtime.config.dropperPressureThreshold = 0.99;
    runtime.config.reflectorInputMaxTokens = 1000;

    // Cursor at msg-1. New obs batch at obs-1 with coversUpToId msg-2 (truly after cursor).
    // Pool: 500/1000 = 50% > 10%.
    // But only ~6 tokens since cursor < reflectAfterTokens(500) → dropper NOT due.
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: { role: "user", content: [{ type: "text", text: "old" }] },
      },
      {
        type: "message",
        id: "msg-2",
        message: {
          role: "user",
          content: [{ type: "text", text: "new data after cursor" }],
        },
      },
      {
        type: "custom",
        id: "obs-1",
        customType: "om.observations.recorded",
        data: {
          coversUpToId: "msg-2",
          observations: [
            {
              id: "a1b2c3d4e5f6",
              content: "x".repeat(2000),
              timestamp: "2025-01-01T00:00:00Z",
              relevance: "medium",
              sourceEntryIds: ["msg-2"],
              tokenCount: 500,
            },
          ],
        },
      },
    ];
    runtime.advanceCursor("dropper", "msg-1", "empty");
    expect(anyStageDue(entries, runtime, undefined)).toBe(false);
  });
  test("reflector NOT due when state 'empty' and marker coversUpToId at cursor (exact production scenario)", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 10;
    runtime.config.observationsPoolMaxTokens = 100_000;
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 500;

    // Production scenario: cursor at source entry aea5b9b7 (state 'empty'),
    // observation marker 13c906d0 exists AFTER it but has coversUpToId: aea5b9b7.
    // The reflector already processed this data → should NOT be due.
    const entries = [
      {
        type: "message",
        id: "source-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "x".repeat(200) }],
        },
      },
      {
        type: "custom",
        id: "ref-1",
        customType: "om.reflections.recorded",
        data: { coversUpToId: "first-obs", reflections: [] },
      },
      {
        type: "custom",
        id: "obs-1",
        customType: "om.observations.recorded",
        data: {
          coversUpToId: "source-1",
          observations: [{ id: "o1", content: "test", tokenCount: 10 }],
        },
      },
    ];
    runtime.advanceCursor("reflector", "source-1", "empty");
    expect(anyStageDue(entries, runtime, undefined)).toBe(false);
  });
});

describe("observer zero-chunk backoff", () => {
  /**
   * TDD validation: Can the zero-chunk observer re-fire bug manifest in our codebase?
   *
   * Analysis: The upstream test (PR #57) uses getContextUsage() to report provider-
   * reported token growth, making the observer due despite zero source tokens.
   * Our codebase does NOT have getContextUsage — we only check source entry tokens
   * via rawTokensAfterIndex(). This means:
   *
   * - Zero-chunk entries (empty content) = 0 source tokens
   * - Observer is due only when source tokens >= observeAfterTokens
   * - These are contradictory: you can't be due AND have zero tokens
   *
   * Therefore: the zero-chunk re-fire bug CANNOT manifest in our current architecture.
   * The observer never runs on zero-token entries, so it never re-fires on them.
   *
   * Verdict: Fix 3 (zero-chunk backoff) is NOT needed for our codebase.
   * The upstream only needs it because they have getContextUsage-based triggering.
   */
  test("zero-chunk re-fire bug cannot manifest — observer not due on zero-token entries", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const { observationsRecordedEntry, rawMessage } = await import("../tests/fixtures/session.js");

    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 5;
    runtime.config.reflectAfterTokens = 999999;
    runtime.config.observationsPoolMaxTokens = 1000;
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 500;

    // Entries: raw-1 (10 tokens) + raw-2 (assistant with EMPTY content = 0 tokens) + obs-marker
    // Cursor at raw-1 → rawTokensAfterIndex counts 0 tokens from raw-2
    const entries = [
      rawMessage("raw-1", "a".repeat(40)), // ~10 tokens
      rawMessage("raw-2", "", {
        message: { role: "assistant", content: [], stopReason: "end_turn" },
      }),
      observationsRecordedEntry("obs-marker", {
        observations: [{ id: "o1", content: "test", tokenCount: 10 }],
        coversUpToId: "raw-1",
      }),
    ];

    // Cursor at raw-1 (index 0)
    runtime.advanceCursor("observer", "raw-1", "recorded");

    // Observer should NOT be due — rawTokensAfterIndex from cursor = 0 tokens
    expect(anyStageDue(entries, runtime, undefined)).toBe(false);
  });
});

// ── Repeated pipeline cycles over append-only source entries ────────────────

interface PipelineFixture {
  runtime: Runtime;
  entries: TestEntry[];
  run(): Promise<void>;
}

/**
 * Full `runConsolidationPipeline` fixture with stubbed workers and model
 * resolution. Only the observer is configured below threshold, so each cycle
 * exercises real cursor resolution, coverage measurement and cursor advance
 * without reflect/drop work.
 */
function makePipelineFixture(options: {
  observeAfterTokens: number;
  runtime?: Runtime;
  entries?: TestEntry[];
  modelRegistry?: ConsolidationCtx["modelRegistry"];
  useRuntimeModelResolver?: boolean;
  sessionModel?: ConsolidationCtx["model"];
  /** When set, the ctx exposes a UI so notifications are collected here. */
  notify?: (message: string, level?: string) => void;
}): PipelineFixture {
  const runtime = options.runtime ?? new Runtime();
  runtime.configLoaded = true;
  runtime.config.memory = true;
  runtime.config.observeAfterTokens = options.observeAfterTokens;
  runtime.config.reflectAfterTokens = 1_000_000;
  if (!options.useRuntimeModelResolver) {
    runtime.resolveModel = async () => ({
      ok: true as const,
      source: "candidate" as const,
      candidateConfig: { provider: "test", id: "model" },
      model: { provider: "test", id: "model", contextWindow: 1_000_000 },
      apiKey: "test",
    });
  }
  const entries = options.entries ?? [];
  const pi = createExtensionApiDouble({
    appendEntry: (customType, data) => {
      entries.push({
        type: "custom",
        id: `appended-${entries.length}`,
        parentId: entries.at(-1)?.id ?? null,
        timestamp: "2026-05-02T10:00:00.000Z",
        customType,
        data,
      });
    },
  });
  const ctx = {
    cwd: "/tmp",
    hasUI: options.notify !== undefined,
    ui: options.notify ? { notify: options.notify } : undefined,
    model: options.sessionModel,
    modelRegistry: options.modelRegistry ?? {},
    sessionManager: { getBranch: () => entries, getSessionId: () => "cursor-session" },
  };
  return {
    runtime,
    entries,
    run: async () => {
      await runConsolidationPipeline(pi, runtime, ctx, runtime.captureGeneration("cursor-session"));
    },
  };
}

/** One pipeline observer call input, failing loudly when the call never happened. */
function observerChunkArg(callIndex = 0): ObserverAgentInput {
  const call = agents.runObserver.mock.calls[callIndex];
  if (!call) {
    throw new Error(`observer ran ${agents.runObserver.mock.calls.length} time(s)`);
  }
  return call[0];
}

function dropperCallArg(callIndex = 0): DropperAgentInput {
  const call = agents.runDropper.mock.calls[callIndex];
  if (!call) throw new Error(`dropper ran ${agents.runDropper.mock.calls.length} time(s)`);
  return call[0];
}

const smallSource = (id: string) => rawMessage(id, `SMALL-${id} ${"x".repeat(120)}`);

beforeEach(() => {
  agents.runObserver.mockReset();
  agents.runObserver.mockResolvedValue({
    observations: [],
    emptyReason: { kind: "no_new_content" as const },
  });
  agents.runReflector.mockReset();
  agents.runDropper.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(cursorTestDir, { recursive: true, force: true });
});

describe("worker attempt hard timeout", () => {
  test("observer falls through to the next model after the deadline", async () => {
    vi.useFakeTimers();
    const fixture = makePipelineFixture({
      observeAfterTokens: 100,
      useRuntimeModelResolver: true,
      modelRegistry: {
        find: (provider: string, id: string) => ({ provider, id, contextWindow: 1_000_000 }),
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
        hasConfiguredAuth: () => true,
      },
    });
    fixture.runtime.config.workerAttemptTimeoutMs = 100;
    // cooldownHours: 0 tracks the stalled primary in-memory for this stage
    // only (no cooldown-file writes); the real resolver then skips it.
    fixture.runtime.config.observerModel = { provider: "test", id: "stalled", cooldownHours: 0 };
    fixture.runtime.config.observerFallbackModels = [{ provider: "test", id: "fallback" }];
    agents.runObserver
      .mockImplementationOnce((input) => {
        const signal = input.signal;
        if (!signal) return Promise.reject(new Error("observer did not receive an attempt signal"));
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      })
      .mockResolvedValueOnce({
        observations: [],
        emptyReason: { kind: "no_new_content" as const },
      });
    fixture.entries.push(rawMessage("source-1", "x".repeat(40_000)));

    const pipeline = fixture.run();
    await vi.advanceTimersByTimeAsync(100);
    await pipeline;

    // The real resolver only skips "stalled" because its timeout was tracked
    // in-cycle, so this call sequence proves the fallback chain engaged.
    expect(agents.runObserver.mock.calls.map(([input]) => input.model?.id)).toEqual([
      "stalled",
      "fallback",
    ]);
  });

  test("a configured timeout still falls through when config changes mid-attempt", async () => {
    vi.useFakeTimers();
    let signalAuthStarted: (() => void) | undefined;
    let releaseAuth: (() => void) | undefined;
    const authStarted = new Promise<void>((resolve) => {
      signalAuthStarted = resolve;
    });
    const authGate = new Promise<void>((resolve) => {
      releaseAuth = resolve;
    });
    const fixture = makePipelineFixture({
      observeAfterTokens: 100,
      useRuntimeModelResolver: true,
      modelRegistry: {
        find: (provider: string, id: string) => ({ provider, id, contextWindow: 1_000_000 }),
        getApiKeyAndHeaders: async () => {
          signalAuthStarted?.();
          await authGate;
          return { ok: true, apiKey: "test" };
        },
        hasConfiguredAuth: () => true,
      },
    });
    fixture.runtime.config.workerAttemptTimeoutMs = 100;
    fixture.runtime.config.observerModel = {
      provider: "test",
      id: "stalled",
      cooldownHours: 0,
    };
    agents.runObserver
      .mockImplementationOnce((input) => {
        const signal = input.signal;
        if (!signal) return Promise.reject(new Error("observer did not receive an attempt signal"));
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      })
      .mockResolvedValueOnce({
        observations: [],
        emptyReason: { kind: "no_new_content" as const },
      });
    fixture.entries.push(rawMessage("source-1", "x".repeat(40_000)));

    const pipeline = fixture.run();
    await authStarted;
    fixture.runtime.config.observerModel = { provider: "test", id: "replacement" };
    releaseAuth?.();
    await vi.advanceTimersByTimeAsync(100);
    await pipeline;

    expect(agents.runObserver.mock.calls.map(([input]) => input.model?.id)).toEqual([
      "stalled",
      "replacement",
    ]);
  });

  test("session cancellation does not resolve a fallback model", async () => {
    const fixture = makePipelineFixture({ observeAfterTokens: 100 });
    fixture.runtime.startSession("cursor-session");
    fixture.runtime.config.workerAttemptTimeoutMs = 60_000;
    const resolveModel = vi.fn(async () => ({
      ok: true as const,
      source: "candidate" as const,
      candidateConfig: { provider: "test", id: "stalled" },
      model: { provider: "test", id: "stalled", contextWindow: 1_000_000 },
      apiKey: "test",
    }));
    fixture.runtime.resolveModel = resolveModel;
    agents.runObserver.mockImplementationOnce(async () => await new Promise<never>(() => {}));
    fixture.entries.push(rawMessage("source-1", "x".repeat(40_000)));

    const pipeline = fixture.run();
    await vi.waitFor(() => expect(agents.runObserver).toHaveBeenCalledOnce());
    fixture.runtime.startSession("next-session");
    await pipeline;

    expect(resolveModel).toHaveBeenCalledOnce();
  });

  test("a timed-out session model is not retried within the same stage", async () => {
    vi.useFakeTimers();
    const fixture = makePipelineFixture({
      observeAfterTokens: 100,
      useRuntimeModelResolver: true,
      sessionModel: { provider: "test", id: "session-model", contextWindow: 1_000_000 },
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
        hasConfiguredAuth: () => true,
      },
    });
    fixture.runtime.config.workerAttemptTimeoutMs = 100;
    const resolveModel = vi.spyOn(fixture.runtime, "resolveModel");
    agents.runObserver.mockImplementation((input) => {
      const signal = input.signal;
      if (!signal) return Promise.reject(new Error("observer did not receive an attempt signal"));
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    fixture.entries.push(rawMessage("source-1", "x".repeat(40_000)));

    const pipeline = fixture.run();
    // Buggy behavior: every one of the MAX_STAGE_ATTEMPTS retries burns the
    // full 100 ms deadline, so all attempts complete within 2 s of fake time.
    await vi.advanceTimersByTimeAsync(2_000);
    await pipeline;

    // The session model has no fallback chain — a timeout must exhaust the
    // stage immediately instead of re-running the same stalled model.
    expect(agents.runObserver).toHaveBeenCalledTimes(1);
    expect(resolveModel).toHaveBeenCalledTimes(1);
  });

  test("a timed-out candidate identical to the session model is not retried via session fallback", async () => {
    vi.useFakeTimers();
    const fixture = makePipelineFixture({
      observeAfterTokens: 100,
      useRuntimeModelResolver: true,
      sessionModel: { provider: "test", id: "stalled" },
      modelRegistry: {
        find: (provider: string, id: string) => ({ provider, id, contextWindow: 1_000_000 }),
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
        hasConfiguredAuth: () => true,
      },
    });
    fixture.runtime.config.workerAttemptTimeoutMs = 100;
    // Configured candidate shares provider/id with the session model. Its
    // timeout is tracked in-cycle (cooldownHours: 0); without the fix the
    // resolver's session fallback returned the identical stalled model and
    // findCandidateConfig matched the configured entry — ten retries.
    fixture.runtime.config.observerModel = { provider: "test", id: "stalled", cooldownHours: 0 };
    fixture.runtime.config.observerFallbackModels = [];
    agents.runObserver.mockImplementation((input) => {
      const signal = input.signal;
      if (!signal) return Promise.reject(new Error("observer did not receive an attempt signal"));
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    fixture.entries.push(rawMessage("source-1", "x".repeat(40_000)));

    const pipeline = fixture.run();
    await vi.advanceTimersByTimeAsync(2_000);
    await pipeline;

    expect(agents.runObserver).toHaveBeenCalledTimes(1);
  });

  test("a timed-out session model is not retried in the reflector stage", async () => {
    vi.useFakeTimers();
    const fixture = makePipelineFixture({
      observeAfterTokens: 100_000,
      useRuntimeModelResolver: true,
      sessionModel: { provider: "test", id: "session-model", contextWindow: 1_000_000 },
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
        hasConfiguredAuth: () => true,
      },
      entries: [
        rawMessage("big-1", "x".repeat(40_000)),
        {
          type: "custom",
          id: "obs-1",
          customType: "om.observations.recorded",
          data: {
            coversUpToId: "big-1",
            observations: [{ id: "o1", content: "a".repeat(100), tokenCount: 25 }],
          },
        },
      ],
    });
    fixture.runtime.config.reflectAfterTokens = 100;
    fixture.runtime.config.workerAttemptTimeoutMs = 100;
    const resolveModel = vi.spyOn(fixture.runtime, "resolveModel");
    agents.runReflector.mockImplementation((input) => {
      const signal = input.signal;
      if (!signal) return Promise.reject(new Error("reflector did not receive an attempt signal"));
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });

    const pipeline = fixture.run();
    await vi.advanceTimersByTimeAsync(2_000);
    await pipeline;

    expect(agents.runObserver).not.toHaveBeenCalled();
    expect(agents.runReflector).toHaveBeenCalledTimes(1);
    expect(resolveModel).toHaveBeenCalledTimes(1);
  });

  test("a timed-out session model is not retried in the dropper stage", async () => {
    vi.useFakeTimers();
    const fixture = makePipelineFixture({
      observeAfterTokens: 100_000,
      useRuntimeModelResolver: true,
      sessionModel: { provider: "test", id: "session-model", contextWindow: 1_000_000 },
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
        hasConfiguredAuth: () => true,
      },
      entries: [
        rawMessage("big-1", "x".repeat(40_000)),
        {
          type: "custom",
          id: "obs-1",
          customType: "om.observations.recorded",
          data: {
            coversUpToId: "big-1",
            observations: [{ id: "o1", content: "a".repeat(100), tokenCount: 25 }],
          },
        },
      ],
    });
    fixture.runtime.config.reflectAfterTokens = 100;
    fixture.runtime.config.workerAttemptTimeoutMs = 100;
    // Reflector resolves and completes empty so the pipeline reaches the dropper.
    agents.runReflector.mockResolvedValue([]);
    agents.runDropper.mockImplementation((input) => {
      const signal = input.signal;
      if (!signal) return Promise.reject(new Error("dropper did not receive an attempt signal"));
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });

    const pipeline = fixture.run();
    await vi.advanceTimersByTimeAsync(2_000);
    await pipeline;

    expect(agents.runReflector).toHaveBeenCalledTimes(1);
    expect(agents.runDropper).toHaveBeenCalledTimes(1);
  });
});

describe("worker stream options", () => {
  test("forwards the session id and cache retention to every memory worker", async () => {
    const fixture = makePipelineFixture({
      observeAfterTokens: 100,
      entries: [rawMessage("big-1", "x".repeat(40_000))],
    });
    fixture.runtime.config.reflectAfterTokens = 100;
    fixture.runtime.config.cacheRetention = "long";
    agents.runObserver.mockResolvedValue({
      observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["big-1"], tokenCount: 8_000 })],
    });
    agents.runReflector.mockResolvedValue([reflection("rrrrrrrrrrrr", ["aaaaaaaaaaaa"])]);
    agents.runDropper.mockResolvedValue([]);

    await fixture.run();

    expect(agents.runObserver).toHaveBeenCalledOnce();
    expect(agents.runReflector).toHaveBeenCalledOnce();
    expect(agents.runDropper).toHaveBeenCalledOnce();
    for (const calls of [
      agents.runObserver.mock.calls,
      agents.runReflector.mock.calls,
      agents.runDropper.mock.calls,
    ]) {
      expect(calls[0]?.[0]).toMatchObject({
        sessionId: "cursor-session",
        cacheRetention: "long",
      });
    }
  });
});

describe("repeated consolidation pipeline cycles", () => {
  test("never observes below threshold, then covers every accumulated source entry", async () => {
    const fixture = makePipelineFixture({ observeAfterTokens: 5_000 });

    for (let cycle = 0; cycle < 5; cycle += 1) {
      fixture.entries.push(smallSource(`small-${cycle}`));
      await fixture.run();
      expect(agents.runObserver).not.toHaveBeenCalled();
      // Nothing measured yet: no cursor may claim the small additions as done.
      expect(fixture.runtime.getCursor("observer")).toBeUndefined();
    }

    const lowTokens = fixture.entries.map((entry) => entry.id);
    fixture.entries.push(rawMessage("big-1", `BIG-1 ${"y".repeat(40_000)}`));
    await fixture.run();

    expect(agents.runObserver).toHaveBeenCalledTimes(1);
    const input = observerChunkArg();
    // The earliest small addition is still observed once the threshold is crossed.
    expect(input.chunk).toContain("SMALL-small-0");
    expect(input.chunk).toContain("BIG-1");
    expect(input.allowedSourceEntryIds).toEqual([...lowTokens, "big-1"]);
    // Empty outcome: coverage advances to the last measured source entry.
    expect(fixture.runtime.getCursor("observer")).toEqual({ entryId: "big-1", state: "empty" });
  });

  test("a not-due cycle keeps later small additions pending for the next due cycle", async () => {
    const fixture = makePipelineFixture({ observeAfterTokens: 5_000 });
    fixture.entries.push(rawMessage("big-1", `BIG-1 ${"y".repeat(40_000)}`));
    await fixture.run();
    expect(agents.runObserver).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.getCursor("observer")).toEqual({ entryId: "big-1", state: "empty" });

    // Below threshold again: the not-due branch anchors on measured coverage only.
    fixture.entries.push(smallSource("pending"));
    await fixture.run();
    expect(agents.runObserver).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.getCursor("observer")).toEqual({ entryId: "big-1", state: "not_due" });

    fixture.entries.push(rawMessage("big-2", `BIG-2 ${"z".repeat(40_000)}`));
    await fixture.run();

    expect(agents.runObserver).toHaveBeenCalledTimes(2);
    const input = observerChunkArg(1);
    // The small addition skipped by the not-due cycle is observed, not dropped.
    expect(input.chunk).toContain("SMALL-pending");
    expect(input.chunk).toContain("BIG-2");
    expect(input.allowedSourceEntryIds).toEqual(["pending", "big-2"]);
  });

  test("records coverage from a recorded outcome and does not re-observe it", async () => {
    const fixture = makePipelineFixture({ observeAfterTokens: 5_000 });
    agents.runObserver.mockResolvedValue({
      observations: [
        {
          id: "aaaaaaaaaaaa",
          content: "Coverage for the first measured chunk",
          timestamp: "2026-05-02T10:00:00.000Z",
          relevance: "medium",
          sourceEntryIds: ["big-1"],
          supportingObservationIds: ["aaaaaaaaaaaa"],
          tokenCount: 6,
        },
      ],
    });
    fixture.entries.push(rawMessage("big-1", `BIG-1 ${"y".repeat(40_000)}`));
    await fixture.run();

    expect(agents.runObserver).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.getCursor("observer")).toEqual({ entryId: "big-1", state: "recorded" });
    const recorded = fixture.entries.filter(
      (entry) => entry.customType === "om.observations.recorded",
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.data).toMatchObject({ coversUpToId: "big-1" });

    await fixture.run();
    expect(agents.runObserver).toHaveBeenCalledTimes(1);
  });

  test("a restored not-due cursor still owns its unobserved backlog", async () => {
    const entries: TestEntry[] = [
      compactionEntry("c0", { firstKeptEntryId: "m1", summary: "prior work" }),
      smallSource("m1"),
    ];
    const first = makePipelineFixture({ observeAfterTokens: 5_000, entries });
    await first.run();

    expect(agents.runObserver).not.toHaveBeenCalled();
    // The compaction anchor keeps the below-threshold addition pending.
    expect(first.runtime.getCursor("observer")).toEqual({ entryId: "c0", state: "not_due" });
    first.runtime.saveCursorsToPending("cursor-session");

    // A fresh runtime restores the persisted cursor before the next cycle.
    const restored = makePipelineFixture({ observeAfterTokens: 5_000, entries });
    restored.runtime.loadCursorsFromPending("cursor-session");
    expect(restored.runtime.getCursor("observer")).toEqual({ entryId: "c0", state: "not_due" });

    entries.push(rawMessage("big-1", `BIG-1 ${"y".repeat(40_000)}`));
    await restored.run();

    expect(agents.runObserver).toHaveBeenCalledTimes(1);
    const input = observerChunkArg();
    expect(input.chunk).toContain("SMALL-m1");
    expect(input.chunk).toContain("BIG-1");
    expect(input.allowedSourceEntryIds).toEqual(["m1", "big-1"]);
    expect(restored.runtime.getCursor("observer")).toEqual({ entryId: "big-1", state: "empty" });
  });
});

describe("capSourceEntriesToTokens", () => {
  test("custom_message with string content contributes tokens (not 0)", () => {
    // Before the fix, custom_message counted as 0 tokens, so the cap
    // would keep all of these. After the fix, each custom_message is sized
    // correctly and the cap drops older ones once the budget is exceeded.
    const entries = [
      rawMessage("m0", "x".repeat(200)),
      textCustomMessage("cm-1", "y".repeat(100)),
      textCustomMessage("cm-2", "y".repeat(100)),
      textCustomMessage("cm-3", "y".repeat(100)),
      textCustomMessage("cm-4", "y".repeat(100)),
      textCustomMessage("cm-5", "y".repeat(100)),
    ];
    const result = capSourceEntriesToTokens(entries, 80);
    // 5 custom_message entries × ~25 tokens each = 125 tokens. rawMessage ≈ 50 tokens.
    // Total ≈ 175 > 80. Newest (cm-5) always kept; cm-4 → 50; cm-3 → 75;
    // cm-2 would push to 100 > 80 and kept.length > 0 → stop.
    expect(result.map((e) => e.id)).toEqual(["cm-3", "cm-4", "cm-5"]);
  });

  test("custom_message with array content contributes tokens", () => {
    const entries = [
      rawMessage("m0", "x".repeat(200)),
      customMessage("cm-1", [
        { type: "text", text: "part one " },
        { type: "text", text: "part two" },
      ]),
      customMessage("cm-2", [
        { type: "text", text: "part three " },
        { type: "text", text: "part four" },
      ]),
    ];
    const result = capSourceEntriesToTokens(entries, 8);
    // Each array custom_message ≈ 5 tokens. rawMessage ≈ 50 tokens.
    // Budget 8: cm-2 (5) kept; cm-1 would push to 10 > 8 → stop.
    expect(result.map((e) => e.id)).toEqual(["cm-2"]);
  });

  test("message entries are still capped correctly", () => {
    const entries = [
      rawMessage("old", "ignored old message"),
      rawMessage("new", "x".repeat(1200)), // ~300 tokens
    ];
    const result = capSourceEntriesToTokens(entries, 100);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("new");
  });

  test("branch_summary entries are still capped correctly", () => {
    const entries = [
      rawMessage("old", "ignored old message"),
      branchSummary("bs-1", "x".repeat(800)), // ~200 tokens
    ];
    const result = capSourceEntriesToTokens(entries, 100);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("bs-1");
  });

  test("cap respects maxTokens across mixed entry types", () => {
    const entries = [
      rawMessage("m1", "a".repeat(400)), // ~100 tokens
      textCustomMessage("cm1", "b".repeat(400)), // ~100 tokens
      branchSummary("bs1", "c".repeat(400)), // ~100 tokens
      rawMessage("m2", "d".repeat(400)), // ~100 tokens — newest, should be kept
    ];
    // 300 token budget: newest (m2) always kept, then walk backwards
    const result = capSourceEntriesToTokens(entries, 300);
    expect(result.map((e) => e.id)).toEqual(["cm1", "bs1", "m2"]);
  });

  test("oversized newest entry is still included (first-entry guard)", () => {
    const entries = [
      rawMessage("old", "ignored"),
      rawMessage("new", "x".repeat(12_000)), // ~3000 tokens, far exceeds budget
    ];
    const result = capSourceEntriesToTokens(entries, 100);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("new");
  });

  test("blackhole-pre-compaction-output custom entries contribute 0 tokens", () => {
    // PR #103 cosmetic entries are plain `custom` entries, never `custom_message`.
    // They must not add to the token budget, even if present in the input.
    const cosmeticEntry = {
      type: "custom" as const,
      id: "cosmetic-1",
      parentId: null,
      timestamp: "2026-09-19T16:00:00.000Z",
      customType: "blackhole-pre-compaction-output",
      data: {
        text: "x".repeat(4000),
        sourceEntryId: "src-1",
        compactionEntryId: "c1",
        truncated: true,
      },
    };
    const entries = [
      rawMessage("old", "y".repeat(200)), // ~50 tokens
      cosmeticEntry, // 0 tokens
      rawMessage("new", "x".repeat(200)), // ~50 tokens
    ];
    const result = capSourceEntriesToTokens(entries, 50);
    // cosmeticEntry contributes 0 tokens, so it does not displace the new message.
    // The cap keeps the newest source entry; older source entries are dropped once
    // the budget is exceeded.
    expect(result.map((e) => e.id)).toEqual(["cosmetic-1", "new"]);
  });
});

/** The observer preamble cap must apply in auto/off mode, not only manual mode. */
describe("observer preamble cap", () => {
  test("caps priorObservations in auto mode to 30% of the reading batch", async () => {
    const fixture = makePipelineFixture({ observeAfterTokens: 100 });
    fixture.runtime.config.compaction = "auto";
    fixture.runtime.config.observerChunkMaxTokens = 2_000; // 30% = 600-token preamble

    const observations = Array.from({ length: 20 }, (_, i) => ({
      id: Math.abs(i).toString(16).padStart(12, "0"),
      content: `Observation ${i} ` + "x".repeat(200),
      timestamp: "2026-05-02 10:00",
      relevance: "medium" as const,
      sourceEntryIds: ["src-1"],
      tokenCount: 0,
    }));
    fixture.entries.push(rawMessage("src-1", "Source entry " + "y".repeat(100_000)));
    fixture.entries.push(
      observationsRecordedEntry("obs-marker", {
        observations,
        coversUpToId: "src-1",
      }),
    );
    // Add a second source entry so there is unobserved content after the marker.
    fixture.entries.push(rawMessage("src-2", "More source " + "z".repeat(100_000)));

    await fixture.run();

    expect(agents.runObserver).toHaveBeenCalledTimes(1);
    const input = observerChunkArg();
    // 20 medium observations would exceed the 600-token preamble budget;
    // the auto-mode cap must trim them down.
    expect(input.priorObservations.length).toBeLessThan(observations.length);
    expect(input.priorObservations.length).toBeGreaterThan(0);
  });

  test("caps priorReflections in auto mode to 30% of the reading batch", async () => {
    const fixture = makePipelineFixture({ observeAfterTokens: 100 });
    fixture.runtime.config.compaction = "auto";
    fixture.runtime.config.observerChunkMaxTokens = 2_000; // 30% = 600-token preamble

    const reflections = Array.from({ length: 20 }, (_, i) =>
      reflection((100 + i).toString(16).padStart(12, "0"), ["src-1"], {
        content: `Reflection ${i} ` + "x".repeat(200),
      }),
    );
    fixture.entries.push(rawMessage("src-1", "Source entry " + "y".repeat(100_000)));
    fixture.entries.push(
      reflectionsRecordedEntry("refl-marker", {
        reflections,
        coversUpToId: "src-1",
      }),
    );
    // Add a second source entry so there is unobserved content after the marker.
    fixture.entries.push(rawMessage("src-2", "More source " + "z".repeat(100_000)));

    await fixture.run();

    expect(agents.runObserver).toHaveBeenCalledTimes(1);
    const input = observerChunkArg();
    // 20 reflections at ~60 tokens each would exceed the 600-token preamble
    // budget; the newest-first cap must trim them down without emptying them.
    expect(input.priorReflections.length).toBeLessThan(reflections.length);
    expect(input.priorReflections.length).toBeGreaterThan(0);
  });

  test("skips observer when chunk fits but full prompt with preamble exceeds context window", async () => {
    const fixture = makePipelineFixture({ observeAfterTokens: 100 });
    fixture.runtime.config.compaction = "auto";
    fixture.runtime.config.observerChunkMaxTokens = 10_000;
    // Small model window: chunk (~600 tokens) + 8k reserve fits in 11k, but
    // adding the 30%-of-chunk preamble (~3000 tokens) and the ~3.3k system
    // prompt does not. The old chunk-only guard would have passed this through.
    fixture.runtime.resolveModel = async () => ({
      ok: true as const,
      source: "candidate" as const,
      candidateConfig: { provider: "test", id: "model" },
      model: { provider: "test", id: "model", contextWindow: 11_000 },
      apiKey: "test",
    });

    const observations = Array.from({ length: 20 }, (_, i) => ({
      id: Math.abs(i).toString(16).padStart(12, "0"),
      content: `Observation ${i} ` + "x".repeat(200),
      timestamp: "2026-05-02 10:00",
      relevance: "medium" as const,
      sourceEntryIds: ["src-1"],
      tokenCount: 0,
    }));
    fixture.entries.push(rawMessage("src-1", "Source entry " + "y".repeat(100_000)));
    fixture.entries.push(
      observationsRecordedEntry("obs-marker", {
        observations,
        coversUpToId: "src-1",
      }),
    );
    // Small follow-up chunk: ~600 tokens, well under the window on its own.
    fixture.entries.push(rawMessage("src-2", "More source " + "z".repeat(2400)));

    await fixture.run();

    expect(agents.runObserver).not.toHaveBeenCalled();
  });
});

describe("dropper pressure valve", () => {
  function pressureFixture(
    options: {
      observations?: ReturnType<typeof observation>[];
      poolMaxTokens?: number;
    } = {},
  ): PipelineFixture {
    const fixture = makePipelineFixture({
      observeAfterTokens: 1_000_000,
      entries: [
        rawMessage("big-1", "x".repeat(400)),
        observationsRecordedEntry("obs-1", {
          coversUpToId: "big-1",
          observations: options.observations ?? [
            observation("aaaaaaaaaaaa", { tokenCount: 800, sourceEntryIds: ["big-1"] }),
            observation("bbbbbbbbbbbb", { tokenCount: 200, sourceEntryIds: ["big-1"] }),
          ],
        }),
        observationsDroppedEntry("drop-0", {
          coversUpToId: "obs-1",
          observationIds: ["older-observation"],
        }),
      ],
    });
    fixture.runtime.config.reflectAfterTokens = 1_000_000;
    fixture.runtime.config.observationsPoolMaxTokens = options.poolMaxTokens ?? 1_000;
    fixture.runtime.config.dropperPressureThreshold = 0.7;
    fixture.runtime.advanceCursor("dropper", "obs-1", "skipped");
    return fixture;
  }

  test("the pressure threshold blocks the dropper when the pool is below it", async () => {
    // Pool is 1,000 / 2,000 tokens (50%): under the configured 60% pressure
    // threshold, so the no-new-data pressure path must not fire.
    const fixture = pressureFixture({ poolMaxTokens: 2_000 });
    fixture.runtime.config.dropperPressureThreshold = 0.6;
    agents.runDropper.mockResolvedValue([]);

    await fixture.run();

    expect(agents.runDropper).not.toHaveBeenCalled();
  });

  test("the due-check applies the same pressure threshold as the stage", async () => {
    const fixture = pressureFixture({ poolMaxTokens: 2_000 });
    fixture.runtime.config.dropperPressureThreshold = 0.6;

    expect(anyStageDue(fixture.entries, fixture.runtime)).toBe(false);

    fixture.runtime.config.dropperPressureThreshold = 0.4;
    expect(anyStageDue(fixture.entries, fixture.runtime)).toBe(true);
  });

  test("pressure runs over the full live pool when the post-drop delta is empty", async () => {
    const fixture = pressureFixture();
    agents.runDropper.mockResolvedValue(["aaaaaaaaaaaa"]);

    await fixture.run();

    expect(agents.runDropper).toHaveBeenCalledOnce();
    expect(dropperCallArg().observations.map((observation) => observation.id)).toEqual([
      "aaaaaaaaaaaa",
      "bbbbbbbbbbbb",
    ]);
    expect(
      fixture.entries.filter(
        (entry) => entry.customType === "om.observations.dropped" && entry.id !== "drop-0",
      ),
    ).toHaveLength(1);
  });

  test("skips an undersized primary model for an uncapped pressure prompt and uses fallback", async () => {
    const fixture = pressureFixture({
      poolMaxTokens: 5_000,
      observations: [
        observation("aaaaaaaaaaaa", {
          content: "x".repeat(20_000),
          tokenCount: 5_000,
          sourceEntryIds: ["big-1"],
        }),
      ],
    });
    fixture.runtime.config.reflectorInputMaxTokens = 1_000;
    fixture.runtime.config.dropperModel = { provider: "test", id: "primary", cooldownHours: 0 };
    fixture.runtime.config.dropperFallbackModels = [{ provider: "test", id: "fallback" }];
    let resolutionCount = 0;
    const resolveModel = vi.fn(async () => ({
      ok: true as const,
      model:
        resolutionCount++ === 0
          ? { provider: "test", id: "primary", contextWindow: 10_000 }
          : { provider: "test", id: "fallback", contextWindow: 20_000 },
      apiKey: "test",
    }));
    fixture.runtime.resolveModel = resolveModel;
    agents.runDropper.mockResolvedValue([]);

    await fixture.run();

    expect({
      resolutionCount: resolveModel.mock.calls.length,
      dropperModels: agents.runDropper.mock.calls.map(([input]) => input.model.id),
    }).toEqual({ resolutionCount: 2, dropperModels: ["fallback"] });
  });

  test("does not retry an empty pressure run against the unchanged active pool", async () => {
    const fixture = pressureFixture();
    agents.runDropper.mockResolvedValue([]);

    await fixture.run();
    expect(anyStageDue(fixture.entries, fixture.runtime)).toBe(false);
    await fixture.run();
    await fixture.run();

    expect(agents.runDropper).toHaveBeenCalledOnce();
  });

  function expectPressureRerunWithChangedPool(): void {
    expect(agents.runDropper).toHaveBeenCalledTimes(2);
    expect(dropperCallArg(1).observations.map((observation) => observation.id)).toEqual([
      "aaaaaaaaaaaa",
      "bbbbbbbbbbbb",
      "cccccccccccc",
    ]);
  }

  test("re-enables pressure after the automatic active pool changes", async () => {
    const fixture = pressureFixture();
    agents.runDropper.mockResolvedValue([]);
    await fixture.run();

    fixture.entries.push(
      observationsRecordedEntry("obs-2", {
        coversUpToId: "big-1",
        observations: [observation("cccccccccccc", { tokenCount: 100, sourceEntryIds: ["big-1"] })],
      }),
    );
    expect(anyStageDue(fixture.entries, fixture.runtime)).toBe(true);
    await fixture.run();

    expectPressureRerunWithChangedPool();
  });

  test("re-enables pressure after the manual pending pool changes", async () => {
    clearPendingState("cursor-session");
    const fixture = pressureFixture();
    fixture.runtime.config.compaction = "manual";
    agents.runDropper.mockResolvedValue([]);
    await fixture.run();

    savePendingObservation("cursor-session", {
      coversUpToId: "big-1",
      data: {
        observations: [observation("cccccccccccc", { tokenCount: 100, sourceEntryIds: ["big-1"] })],
      },
    });
    expect(anyStageDue(fixture.entries, fixture.runtime, readPendingState("cursor-session"))).toBe(
      true,
    );
    await fixture.run();

    expectPressureRerunWithChangedPool();
  });

  test("manual pressure bypasses covered-data gates and records the drop", async () => {
    clearPendingState("cursor-session");
    const fixture = makePipelineFixture({ observeAfterTokens: 1_000_000 });
    fixture.entries.push(rawMessage("raw-1", "x".repeat(400)));
    fixture.runtime.config.compaction = "manual";
    fixture.runtime.config.reflectAfterTokens = 1_000_000;
    fixture.runtime.config.observationsPoolMaxTokens = 1_000;
    fixture.runtime.config.dropperPressureThreshold = 0.7;
    savePendingObservation("cursor-session", {
      coversUpToId: "raw-1",
      data: {
        observations: [
          observation("aaaaaaaaaaaa", { tokenCount: 800, sourceEntryIds: ["raw-1"] }),
          observation("bbbbbbbbbbbb", { tokenCount: 200, sourceEntryIds: ["raw-1"] }),
        ],
      },
    });
    savePendingDropped("cursor-session", {
      coversUpToId: "raw-1",
      data: { coversUpToId: "raw-1", observationIds: ["older-observation"] },
    });
    fixture.runtime.advanceCursor("dropper", "raw-1", "skipped");
    agents.runDropper.mockResolvedValue(["aaaaaaaaaaaa"]);

    await fixture.run();

    expect(dropperCallArg().observations.map((observation) => observation.id)).toEqual([
      "aaaaaaaaaaaa",
      "bbbbbbbbbbbb",
    ]);
    expect(readPendingState("cursor-session").dropped?.data).toMatchObject({
      coversUpToId: "raw-1",
      observationIds: ["aaaaaaaaaaaa"],
    });
    await fixture.run();
    expect(agents.runDropper).toHaveBeenCalledOnce();
  });
});

// ── showWorkerNotifications — routine worker progress toasts ────────────────

/** Every info-level toast collected from the fixture's UI notify spy. */
function infoCalls(notify: ReturnType<typeof vi.fn>): unknown[][] {
  return notify.mock.calls.filter(([, level]) => level === "info");
}

describe("showWorkerNotifications", () => {
  function observerFixture(notify: (message: string, level?: string) => void): PipelineFixture {
    const fixture = makePipelineFixture({ observeAfterTokens: 5_000, notify });
    fixture.entries.push(rawMessage("big-1", `BIG-1 ${"y".repeat(40_000)}`));
    return fixture;
  }

  /** Reflector due, observer not due: the reflector toast is the first info. */
  function reflectorFixture(notify: (message: string, level?: string) => void): PipelineFixture {
    const fixture = makePipelineFixture({
      observeAfterTokens: 100_000,
      notify,
      entries: [
        rawMessage("big-1", `BIG-1 ${"y".repeat(40_000)}`),
        observationsRecordedEntry("obs-1", {
          coversUpToId: "big-1",
          observations: [
            observation("aaaaaaaaaaaa", { tokenCount: 25, sourceEntryIds: ["big-1"] }),
          ],
        }),
      ],
    });
    fixture.runtime.config.reflectAfterTokens = 100;
    return fixture;
  }

  /** Dropper due via pool pressure; observer and reflector both not due. */
  function dropperFixture(notify: (message: string, level?: string) => void): PipelineFixture {
    const fixture = makePipelineFixture({
      observeAfterTokens: 1_000_000,
      notify,
      entries: [
        rawMessage("big-1", "x".repeat(400)),
        observationsRecordedEntry("obs-1", {
          coversUpToId: "big-1",
          observations: [
            observation("aaaaaaaaaaaa", { tokenCount: 800, sourceEntryIds: ["big-1"] }),
            observation("bbbbbbbbbbbb", { tokenCount: 200, sourceEntryIds: ["big-1"] }),
          ],
        }),
      ],
    });
    fixture.runtime.config.reflectAfterTokens = 1_000_000;
    fixture.runtime.config.observationsPoolMaxTokens = 1_000;
    fixture.runtime.config.dropperPressureThreshold = 0.7;
    fixture.runtime.advanceCursor("dropper", "obs-1", "skipped");
    return fixture;
  }

  test("emits the observer progress toast by default", async () => {
    const notify = vi.fn();
    const fixture = observerFixture(notify);

    await fixture.run();

    expect(agents.runObserver).toHaveBeenCalledOnce();
    expect(infoCalls(notify).map(([message]) => message)).toEqual([
      expect.stringContaining("blackhole: reading recent conversation for notes (~"),
    ]);
  });

  test("suppresses the observer progress toast when disabled, without skipping the worker", async () => {
    const notify = vi.fn();
    const fixture = observerFixture(notify);
    fixture.runtime.config.showWorkerNotifications = false;

    await fixture.run();

    expect(agents.runObserver).toHaveBeenCalledOnce();
    expect(infoCalls(notify)).toEqual([]);
  });

  test("keeps warning-level worker notices visible when disabled", async () => {
    const notify = vi.fn();
    const fixture = observerFixture(notify);
    fixture.runtime.config.showWorkerNotifications = false;
    agents.runObserver.mockResolvedValue({
      observations: [],
      emptyReason: { kind: "all_rejected" as const, count: 2 },
    });

    await fixture.run();

    expect(notify).toHaveBeenCalledWith(
      "blackhole: no new notes — 2 note(s) referenced unknown conversation entries",
      "warning",
    );
  });

  test("emits the reflector progress toast by default", async () => {
    const notify = vi.fn();
    const fixture = reflectorFixture(notify);
    agents.runReflector.mockResolvedValue([]);

    await fixture.run();

    expect(agents.runObserver).not.toHaveBeenCalled();
    expect(agents.runReflector).toHaveBeenCalledOnce();
    expect(infoCalls(notify).map(([message]) => message)).toEqual([
      expect.stringContaining("blackhole: building insights from saved notes (~"),
    ]);
  });

  test("suppresses the reflector progress toast when disabled", async () => {
    const notify = vi.fn();
    const fixture = reflectorFixture(notify);
    fixture.runtime.config.showWorkerNotifications = false;
    agents.runReflector.mockResolvedValue([]);

    await fixture.run();

    expect(agents.runReflector).toHaveBeenCalledOnce();
    expect(infoCalls(notify)).toEqual([]);
  });

  test("emits the dropper progress toast by default", async () => {
    const notify = vi.fn();
    const fixture = dropperFixture(notify);
    agents.runDropper.mockResolvedValue([]);

    await fixture.run();

    expect(agents.runObserver).not.toHaveBeenCalled();
    expect(agents.runReflector).not.toHaveBeenCalled();
    expect(agents.runDropper).toHaveBeenCalledOnce();
    expect(infoCalls(notify).map(([message]) => message)).toEqual([
      expect.stringContaining("blackhole: pruning low-value notes (~"),
    ]);
  });

  test("suppresses the dropper progress toast when disabled", async () => {
    const notify = vi.fn();
    const fixture = dropperFixture(notify);
    fixture.runtime.config.showWorkerNotifications = false;
    agents.runDropper.mockResolvedValue([]);

    await fixture.run();

    expect(agents.runDropper).toHaveBeenCalledOnce();
    expect(infoCalls(notify)).toEqual([]);
  });
});
