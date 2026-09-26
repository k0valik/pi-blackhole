/**
 * Observation-pool consistency harness for issue #120.
 *
 * The dropper trigger, the `/blackhole-memory` pool lines, and the footer P
 * gauge must all measure the same live active pool — plus, in manual mode,
 * the pending observation batches the trigger includes. These tests pin that
 * agreement so no surface can silently drift onto a different scope or token
 * basis, and they pin the manual-mode pending breakdown shown to users.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pending state is persisted under the agent dir; redirect it to a temp dir.
const agentDir = mkdtempSync(join(tmpdir(), "pi-blackhole-pool-consistency-"));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, getAgentDir: () => agentDir };
});

import { foldLedger, observationPoolTokens, type Entry } from "../src/om/ledger/index.js";
import { anyStageDue, dropperNewDataFloor } from "../src/om/consolidation.js";
import { Runtime } from "../src/om/runtime.js";
import {
  clearPendingState,
  readPendingState,
  savePendingObservation,
  type PendingOMState,
} from "../src/om/pending.js";
import { registerMemoryCommand } from "../src/commands/memory.js";
import {
  observation,
  observationsDroppedEntry,
  observationsRecordedEntry,
  textCustomMessage,
  type TestEntry,
} from "./fixtures/session.js";

const SESSION = "pool-consistency-session";
const POOL_MAX = 2_800;

afterEach(() => {
  clearPendingState(SESSION);
});
afterAll(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

function asEntries(entries: TestEntry[]): Entry[] {
  return entries as unknown as Entry[];
}

/** Branch with two live observations (700 + 700 = 1,400 tokens). */
function observationBranch(): TestEntry[] {
  return [
    textCustomMessage("raw-1", "x".repeat(400)),
    observationsRecordedEntry("om-obs-1", {
      observations: [
        observation("aaaaaaaaaaaa", { tokenCount: 700 }),
        observation("bbbbbbbbbbbb", { tokenCount: 700 }),
      ],
      coversUpToId: "raw-1",
    }),
  ];
}

function lastId(entries: Entry[]): string {
  const last = entries[entries.length - 1];
  if (!last) throw new Error("expected a non-empty entry list");
  return last.id;
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    observeAfterTokens: 1_000_000,
    reflectAfterTokens: 1,
    compactAfterTokens: 81_000,
    observationsPoolMaxTokens: POOL_MAX,
    dropperPressureThreshold: 1,
    reflectorInputMaxTokens: 1_000_000,
    observerChunkMaxTokens: 40_000,
    passive: false,
    noAutoCompact: false,
    ...overrides,
  };
}

/** Real Runtime wired with the pool config; cursor keeps the reflector quiet. */
function triggerRuntime(overrides: Record<string, unknown> = {}): Runtime {
  const runtime = new Runtime();
  Object.assign(runtime.config, baseConfig(overrides));
  return runtime;
}

function memoryRuntime(config: Record<string, unknown>) {
  return {
    ensureConfig: vi.fn(),
    config,
    consolidationInFlight: false,
    compactInFlight: false,
    compactHookInFlight: false,
    lastObserverError: undefined,
    lastReflectorError: undefined,
    lastDropperError: undefined,
    staleCtxSkippedCompactions: 0,
  };
}

/** Run `/blackhole-memory` (status) and return the notified text. */
async function memoryStatus(entries: Entry[], config: Record<string, unknown>): Promise<string> {
  const handlers = new Map<string, (args: unknown, ctx: unknown) => Promise<void>>();
  const pi = {
    registerCommand: (
      name: string,
      def: { handler: (args: unknown, ctx: unknown) => Promise<void> },
    ) => {
      handlers.set(name, def.handler);
    },
  };
  const ui = { notify: vi.fn() };
  registerMemoryCommand(pi as never, memoryRuntime(config) as never);
  const handler = handlers.get("blackhole-memory");
  if (!handler) throw new Error("blackhole-memory handler not registered");

  await handler([], {
    cwd: "/tmp",
    sessionManager: { getBranch: () => entries, getSessionId: () => SESSION },
    ui,
  });

  const call = ui.notify.mock.calls[0];
  if (!call) throw new Error("blackhole-memory did not notify");
  return String(call[0]);
}

describe("observationPoolTokens", () => {
  it("sums and counts the active observations", () => {
    expect(observationPoolTokens(asEntries(observationBranch()))).toEqual({
      tokens: 1_400,
      count: 2,
    });
  });

  it("excludes tombstoned observations from the sum and count", () => {
    const entries = [
      ...observationBranch(),
      observationsDroppedEntry("om-drop-1", {
        observationIds: ["bbbbbbbbbbbb"],
        coversUpToId: "om-obs-1",
      }),
    ];
    expect(observationPoolTokens(asEntries(entries))).toEqual({ tokens: 700, count: 1 });
  });

  it("does not restore a ledger-tombstoned observation from pending batches", () => {
    const entries = [
      ...observationBranch(),
      observationsDroppedEntry("om-drop-1", {
        observationIds: ["bbbbbbbbbbbb"],
        coversUpToId: "om-obs-1",
      }),
    ];
    savePendingObservation(SESSION, {
      coversUpToId: "raw-1",
      data: { observations: [observation("bbbbbbbbbbbb", { tokenCount: 700 })] },
    });

    expect(observationPoolTokens(asEntries(entries), readPendingState(SESSION))).toEqual({
      tokens: 700,
      count: 1,
    });
  });

  it("adds every pending observation batch when pending is supplied", () => {
    const pending: PendingOMState = {
      observationBatches: [
        {
          coversUpToId: "raw-1",
          data: {
            observations: [observation("cccccccccccc", { tokenCount: 300 })],
          },
        },
        {
          coversUpToId: "raw-1",
          data: {
            observations: [observation("dddddddddddd", { tokenCount: 200 })],
          },
        },
      ],
    };
    expect(observationPoolTokens(asEntries(observationBranch()), pending)).toEqual({
      tokens: 1_900,
      count: 4,
    });
  });

  it("counts an observation recorded in both the branch and pending only once", () => {
    const pending: PendingOMState = {
      observationBatches: [
        {
          coversUpToId: "raw-1",
          data: { observations: [observation("aaaaaaaaaaaa", { tokenCount: 700 })] },
        },
      ],
    };
    expect(observationPoolTokens(asEntries(observationBranch()), pending)).toEqual({
      tokens: 1_400,
      count: 2,
    });
  });

  it("applies pending drop batches to pending observations", () => {
    const pending: PendingOMState = {
      observationBatches: [
        {
          coversUpToId: "raw-1",
          data: { observations: [observation("cccccccccccc", { tokenCount: 300 })] },
        },
      ],
      droppedBatches: [
        {
          coversUpToId: "raw-1",
          data: { coversUpToId: "raw-1", observationIds: ["cccccccccccc"] },
        },
      ],
    };
    expect(observationPoolTokens(asEntries(observationBranch()), pending)).toEqual({
      tokens: 1_400,
      count: 2,
    });
  });

  it("falls back to the singular pending drop when no drop batches exist", () => {
    const pending: PendingOMState = {
      dropped: {
        coversUpToId: "om-obs-1",
        data: { coversUpToId: "om-obs-1", observationIds: ["bbbbbbbbbbbb"] },
      },
    };
    expect(observationPoolTokens(asEntries(observationBranch()), pending)).toEqual({
      tokens: 700,
      count: 1,
    });
  });

  it("skips pending observations without a usable id/content/tokenCount", () => {
    const pending: PendingOMState = {
      observationBatches: [
        {
          coversUpToId: "raw-1",
          data: { observations: [{ id: "cccccccccccc", content: "no token count here" }] },
        },
      ],
    };
    expect(observationPoolTokens(asEntries(observationBranch()), pending)).toEqual({
      tokens: 1_400,
      count: 2,
    });
  });

  it("measures only the branch when pending is omitted", () => {
    const entries = asEntries([textCustomMessage("raw-1", "x".repeat(400))]);
    expect(observationPoolTokens(entries)).toEqual({ tokens: 0, count: 0 });
  });

  it("matches the inline fold sum on a pre-compaction branch (no snapshot)", () => {
    const entries = asEntries(observationBranch());
    const inline = foldLedger(entries).activeObservations.reduce(
      (sum, current) => sum + current.tokenCount,
      0,
    );
    expect(observationPoolTokens(entries).tokens).toBe(inline);
  });
});

describe("dropper pool pressure", () => {
  function pressureRuntime(pressure: number, poolMax = POOL_MAX): Runtime {
    return triggerRuntime({
      reflectAfterTokens: 1_000_000,
      reflectorInputMaxTokens: 1_000_000,
      observationsPoolMaxTokens: poolMax,
      dropperPressureThreshold: pressure,
    });
  }

  it("uses observationsPoolMaxTokens as the pressure basis", () => {
    const entries = asEntries(observationBranch()); // 1,400 / 2,800 tokens
    const runtime = pressureRuntime(0.49); // threshold 1,372
    runtime.advanceCursor("dropper", lastId(entries), "skipped");
    expect(anyStageDue(entries, runtime, undefined)).toBe(true);
  });

  it("stays idle below the pressure threshold", () => {
    const entries = asEntries(observationBranch());
    const runtime = pressureRuntime(0.51); // threshold 1,428
    runtime.advanceCursor("dropper", lastId(entries), "skipped");
    expect(anyStageDue(entries, runtime, undefined)).toBe(false);
  });

  it.each([
    ["0.01", 0.01],
    ["0.1", 0.1],
    ["0.3", 0.3],
    ["0.49", 0.49],
    ["0.5 (at the boundary)", 0.5],
  ])(
    "fires when the pool fraction is at or above the pressure line (%s threshold)",
    (_name, threshold) => {
      const entries = asEntries(observationBranch()); // 1,400 / 2,800 = 50%
      const runtime = pressureRuntime(threshold);
      // Advance the dropper cursor so only the pressure path can fire.
      runtime.advanceCursor("dropper", lastId(entries), "skipped");
      expect(anyStageDue(entries, runtime, undefined)).toBe(true);
    },
  );

  it.each([
    ["0.51", 0.51],
    ["0.7", 0.7],
    ["0.9", 0.9],
    ["0.99", 0.99],
  ])("stays idle when the pool fraction is below the pressure line (%s)", (_name, threshold) => {
    const entries = asEntries(observationBranch());
    const runtime = pressureRuntime(threshold);
    runtime.advanceCursor("dropper", lastId(entries), "skipped");
    expect(anyStageDue(entries, runtime, undefined)).toBe(false);
  });

  it("treats a threshold of 1 as pressure disabled", () => {
    const entries = asEntries(observationBranch());
    const runtime = pressureRuntime(1, 1_400);
    runtime.advanceCursor("dropper", lastId(entries), "skipped");
    expect(anyStageDue(entries, runtime, undefined)).toBe(false);
  });
});

describe("dropper new-data floor (plan-09 §3.3 / plan-11 §4)", () => {
  // Pool is 1,400 tokens; observationsPoolMaxTokens moves the fullness fraction.
  function floorRuntime(poolMax: number): Runtime {
    return triggerRuntime({
      reflectAfterTokens: 1,
      reflectorInputMaxTokens: 1_000_000,
      observationsPoolMaxTokens: poolMax,
      dropperPressureThreshold: 1, // disable pressure to isolate the new-data path
    });
  }

  it.each([
    ["9% (below the floor)", 15_556, false],
    ["10% (at the floor)", 14_000, true],
    ["11% (above the floor)", 12_727, true],
    ["50% (well above)", 2_800, true],
  ])("new data with %s pool fullness → due=%s", (_name, poolMax, expected) => {
    const entries = asEntries(observationBranch());
    const runtime = floorRuntime(poolMax);
    // Silence the reflector so the dropper short-circuit does not fire it.
    runtime.advanceCursor("reflector", lastId(entries), "skipped");
    // No dropper cursor → the new-data path uses tokens since last drop coverage.
    expect(anyStageDue(entries, runtime, undefined)).toBe(expected);
  });

  it("a threshold of 1 disables pressure but leaves the new-data path intact", () => {
    const entries = asEntries(observationBranch());
    const runtime = floorRuntime(POOL_MAX);
    runtime.advanceCursor("reflector", lastId(entries), "skipped");
    expect(anyStageDue(entries, runtime, undefined)).toBe(true);
    runtime.advanceCursor("dropper", lastId(entries), "skipped");
    expect(anyStageDue(entries, runtime, undefined)).toBe(false);
  });
});

describe("dropper derived new-data floor (plan-11 §4)", () => {
  it.each([
    [0.01, 0.02],
    [0.2, 0.03],
    [0.4, 0.06],
    [0.5, 0.075],
    [0.7, 0.1],
    [1, 0.1],
    [Number.NaN, 0.1],
  ])("pressure %s → floor %s", (pressure, expected) => {
    expect(dropperNewDataFloor(pressure)).toBeCloseTo(expected, 10);
  });

  it("a lowered pressure lowers the floor, so new-data pruning can start earlier", () => {
    // 5% pool fullness: below the old 0.10 constant floor, above the derived
    // floor for pressure 0.2 (0.03). The pressure path (20%) is not reached.
    const runtime = triggerRuntime({
      reflectAfterTokens: 1,
      reflectorInputMaxTokens: 1_000_000,
      observationsPoolMaxTokens: 28_000,
      dropperPressureThreshold: 0.2,
    });
    const entries = asEntries(observationBranch());
    runtime.advanceCursor("reflector", lastId(entries), "skipped");
    expect(anyStageDue(entries, runtime, undefined)).toBe(true);
  });
});

describe("trigger / display pool agreement", () => {
  it("auto mode: the trigger gate and the memory pool line share the live pool fraction", async () => {
    const entries = asEntries(observationBranch());
    const tip = lastId(entries);
    // Pool is 1,400 / 2,800 = 50%.
    expect(observationPoolTokens(entries).tokens).toBe(1_400);

    const below = triggerRuntime({ dropperPressureThreshold: 0.49 });
    below.advanceCursor("reflector", tip, "skipped");
    below.advanceCursor("dropper", tip, "skipped");
    expect(anyStageDue(entries, below, undefined)).toBe(true);

    const above = triggerRuntime({ dropperPressureThreshold: 0.51 });
    above.advanceCursor("reflector", tip, "skipped");
    above.advanceCursor("dropper", tip, "skipped");
    expect(anyStageDue(entries, above, undefined)).toBe(false);

    const message = await memoryStatus(entries, baseConfig());
    expect(message).toContain("~1,400 / 2,800 tokens (50%)");
    // Auto mode has no pending state, so no pending breakdown is printed.
    expect(message).not.toContain("pending 1,400");
  });

  it("manual mode: the trigger and the memory pool line both include pending batches", async () => {
    const entries = asEntries([textCustomMessage("raw-1", "x".repeat(400))]);
    savePendingObservation(SESSION, {
      coversUpToId: "raw-1",
      data: {
        observations: [
          observation("aaaaaaaaaaaa", { tokenCount: 700 }),
          observation("bbbbbbbbbbbb", { tokenCount: 700 }),
        ],
      },
    });
    const pending = readPendingState(SESSION);
    // Branch pool is empty; the whole 1,400-token pool lives in pending.
    expect(observationPoolTokens(entries).tokens).toBe(0);
    expect(observationPoolTokens(entries, pending).tokens).toBe(1_400);

    const config = baseConfig({ compaction: "manual", dropperPressureThreshold: 0.49 });
    const runtime = triggerRuntime(config);
    runtime.advanceCursor("reflector", "raw-1", "skipped");
    expect(anyStageDue(entries, runtime, pending)).toBe(true);

    const message = await memoryStatus(entries, config);
    expect(message).toContain("~1,400 / 2,800 tokens (50%)");
    expect(message).toContain("· branch 0 + pending 1,400");
  });
});
