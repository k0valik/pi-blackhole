/**
 * Tests for the footer status bar (src/om/status-bar.ts).
 *
 * Covers: gauge rendering (fill, warning state), worker lifecycle derived
 * from runtime state (running spinner, settled ✓ +N, silent skip, 5s clear),
 * the session_compact event note, the statusBar config gate, and shutdown
 * cleanup. Timers run under vi.useFakeTimers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/om/debug-log.js", () => ({
  debugLog: vi.fn(),
}));

import { registerStatusBar } from "../src/om/status-bar.js";
import {
  OM_OBSERVATIONS_DROPPED,
  OM_OBSERVATIONS_RECORDED,
  OM_REFLECTIONS_RECORDED,
  observationPoolTokens,
} from "../src/om/ledger/index.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

function msg(id: string, tokens: number) {
  return { type: "custom_message", id, content: "x".repeat(tokens * 4) };
}

function observation(id: string, tokenCount: number) {
  return {
    id,
    content: `obs ${id}`,
    timestamp: "2025-01-01T00:00:00.000Z",
    relevance: "medium",
    sourceEntryIds: ["e1"],
    tokenCount,
  };
}

function reflection(id: string, tokenCount: number) {
  return { id, content: `ref ${id}`, supportingObservationIds: ["aabbccddeeff"], tokenCount };
}

function obsRecorded(id: string, coversUpToId: string, observations: unknown[]) {
  return {
    type: "custom",
    id,
    customType: OM_OBSERVATIONS_RECORDED,
    data: { coversUpToId, observations },
  };
}

function refRecorded(id: string, coversUpToId: string, reflections: unknown[]) {
  return {
    type: "custom",
    id,
    customType: OM_REFLECTIONS_RECORDED,
    data: { coversUpToId, reflections },
  };
}

function obsDropped(id: string, coversUpToId: string, observationIds: string[]) {
  return {
    type: "custom",
    id,
    customType: OM_OBSERVATIONS_DROPPED,
    data: { coversUpToId, observationIds },
  };
}

interface Harness {
  fire: (event: string, ...args: unknown[]) => Promise<void>;
  runtime: {
    config: Record<string, unknown>;
    consolidationInFlight: boolean;
    consolidationPhase: string | undefined;
  };
  setStatus: ReturnType<typeof vi.fn>;
  ctx: Record<string, unknown>;
  entries: () => unknown[];
  setEntries: (entries: unknown[]) => void;
  lastStatus: () => string | undefined;
  /** Last status with the fake theme's "style:" markers removed. */
  plain: () => string | undefined;
}

function setup(configOverrides: Record<string, unknown> = {}): Harness {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const pi = {
    on: vi.fn((name: string, cb: (...args: unknown[]) => unknown) => {
      handlers[name] = cb;
    }),
  };
  const runtime = {
    config: {
      statusBar: true,
      observeAfterTokens: 15_000,
      observationsPoolMaxTokens: 20_000,
      compactAfterTokens: 100_000,
      ...configOverrides,
    },
    consolidationInFlight: false,
    consolidationPhase: undefined,
  };
  registerStatusBar(pi as never, runtime as never);

  const setStatus = vi.fn();
  // Theme records the style name so tests can assert warning vs dim.
  const theme = { fg: (style: string, text: string) => `${style}:${text}` };
  let branch: unknown[] = [];
  const ctx = {
    ui: { setStatus, theme },
    sessionManager: { getBranch: () => branch },
    model: { contextWindow: 200_000 },
  };
  const start = handlers["session_start"];
  if (!start) throw new Error("session_start handler was not registered");
  const lastStatus = () => {
    const calls = setStatus.mock.calls;
    const last = calls[calls.length - 1] as [string, string | undefined] | undefined;
    return last?.[1];
  };
  return {
    fire: async (event: string, ...args: unknown[]) => {
      const handler = handlers[event];
      if (!handler) throw new Error(`no handler registered for ${event}`);
      await handler(...args);
    },
    runtime,
    setStatus,
    ctx,
    entries: () => branch,
    setEntries: (e: unknown[]) => {
      branch = e;
    },
    lastStatus,
    plain: () => lastStatus()?.replace(/(muted|dim|warning|success|accent):/g, ""),
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("status bar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("gauges", () => {
    it("renders the bar with three gauges on session_start", async () => {
      const h = setup();
      h.setEntries([msg("e1", 20_000)]);
      await h.fire("session_start", {}, h.ctx);
      const s = h.lastStatus();
      expect(s).toContain("success:bh");
      expect(s).toContain("muted:O");
      expect(s).toContain("muted:P");
      expect(s).toContain("muted:X");
    });

    it("colors gauges by fill tier: dim under 80%, warning to 100%, error at full", async () => {
      const h = setup();
      // O gauge 13k/15k = 87% → warning tier; pool gauge 0% → dim.
      h.setEntries([msg("e1", 13_000)]);
      await h.fire("session_start", {}, h.ctx);
      const s = h.plain();
      const raw = h.lastStatus()!;
      const oSection = s!.slice(s!.indexOf("O"), s!.indexOf("P"));
      const pSection = raw.slice(raw.indexOf("muted:P"), raw.indexOf("muted:X"));
      expect(h.lastStatus()).toContain("warning:█");
      expect(oSection).toContain("▕███████░▏");
      expect(pSection).toContain("dim:▕");
    });

    it("marks a gauge error-colored at or above 100%", async () => {
      const h = setup();
      // 20k tokens since coverage: O gauge 20k/15k ≥ 100% → error fill.
      h.setEntries([msg("e1", 20_000)]);
      await h.fire("session_start", {}, h.ctx);
      const s = h.lastStatus();
      // O gauge fill uses error; the pool gauge (0 tokens) stays dim.
      expect(s).toContain("error:█");
      expect(s).toContain("dim:░");
      const oSection = s!.slice(s!.indexOf("muted:O"), s!.indexOf("muted:P"));
      expect(oSection).toContain("error");
    });

    it("P gauge counts undropped observation tokens", async () => {
      const h = setup();
      h.setEntries([
        msg("e1", 100),
        obsRecorded("m1", "e1", [
          observation("aabbccddeeff", 5_000),
          observation("112233445566", 3_000),
        ]),
        obsDropped("m2", "e1", ["112233445566"]),
      ]);
      await h.fire("session_start", {}, h.ctx);
      // Pool = 5000/20000 = 25% → 2 filled cells, all dim.
      const pSection = h.plain()!.slice(h.plain()!.indexOf("P"), h.plain()!.indexOf("X"));
      expect(pSection).toContain("▕██░░░░░░▏");
    });

    it("P gauge fill equals the shared observationPoolTokens measurement", async () => {
      const h = setup();
      const entries = [
        msg("e1", 100),
        obsRecorded("m1", "e1", [
          observation("aabbccddeeff", 6_000),
          observation("112233445566", 4_000),
          observation("778899aabbcc", 3_000),
        ]),
        obsDropped("m2", "e1", ["778899aabbcc"]),
      ];
      h.setEntries(entries);
      await h.fire("session_start", {}, h.ctx);
      // Helper pool = 6,000 + 4,000 = 10,000 → 10k/20k = 50% → 4 filled cells.
      expect(observationPoolTokens(entries as never).tokens).toBe(10_000);
      const pSection = h.plain()!.slice(h.plain()!.indexOf("P"), h.plain()!.indexOf("X"));
      expect(pSection).toContain("▕████░░░░▏");
    });

    it("X gauge counts tokens since the last compaction", async () => {
      const h = setup();
      h.setEntries([msg("old", 90_000), { type: "compaction", id: "c1" }, msg("e1", 50_000)]);
      await h.fire("session_start", {}, h.ctx);
      // X = 50k/100k = 50% → 4 filled dim cells.
      const xSection = h.plain()!.slice(h.plain()!.indexOf("X"));
      expect(xSection).toContain("▕████░░░░▏");
    });
  });

  describe("worker lifecycle", () => {
    async function startWithObserver(h: Harness) {
      h.setEntries([msg("e1", 1_000)]);
      await h.fire("session_start", {}, h.ctx);
      h.runtime.consolidationInFlight = true;
      h.runtime.consolidationPhase = "observer";
      await h.fire("agent_end", {}, h.ctx);
    }

    it("runs the idle poller only between session_start and session_shutdown", async () => {
      const h = setup();
      expect(vi.getTimerCount()).toBe(0);
      h.setEntries([msg("e1", 1_000)]);
      await h.fire("session_start", {}, h.ctx);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      await h.fire("session_shutdown");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not re-write the status when idle polls see no change", async () => {
      const h = setup();
      h.setEntries([msg("e1", 1_000)]);
      await h.fire("session_start", {}, h.ctx);
      const before = h.setStatus.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.setStatus.mock.calls.length).toBe(before);
    });

    it("re-writes the status on a new session even when the string matches", async () => {
      const h = setup();
      h.setEntries([msg("e1", 1_000)]);
      await h.fire("session_start", {}, h.ctx);
      await h.fire("session_shutdown");
      await h.fire("session_start", {}, h.ctx);
      expect(h.lastStatus()).toContain("success:bh");
    });

    it("renders again when statusBar is re-enabled with an unchanged string", async () => {
      const h = setup({ statusBar: false });
      h.setEntries([msg("e1", 1_000)]);
      await h.fire("session_start", {}, h.ctx);
      h.runtime.config.statusBar = true;
      await h.fire("agent_end", {}, h.ctx);
      expect(h.lastStatus()).toContain("success:bh");
    });

    it("keeps writing status when spinner frames advance", async () => {
      const h = setup();
      h.setEntries([msg("e1", 1_000)]);
      await h.fire("session_start", {}, h.ctx);
      h.runtime.consolidationInFlight = true;
      h.runtime.consolidationPhase = "observer";
      await h.fire("agent_end", {}, h.ctx);
      const before = h.setStatus.mock.calls.length;
      await vi.advanceTimersByTimeAsync(480);
      expect(h.setStatus.mock.calls.length).toBeGreaterThan(before);
    });

    it("picks up a pipeline launched between events, with no event after it", async () => {
      // Regression: pi may run the status-bar agent_start handler before the
      // consolidation trigger launches the pipeline. The bar must notice the
      // launch by polling, not only by events.
      const h = setup();
      h.setEntries([msg("e1", 1_000)]);
      await h.fire("session_start", {}, h.ctx);
      h.runtime.consolidationInFlight = true;
      h.runtime.consolidationPhase = "observer";
      await vi.advanceTimersByTimeAsync(1_000);
      const s = h.lastStatus();
      expect(s).toMatch(/[◐◓◑◒]/);
      expect(s).toContain("accent:[observer]");
    });

    it("shows a spinner entry while a stage runs", async () => {
      const h = setup();
      await startWithObserver(h);
      const s = h.lastStatus();
      expect(s).toMatch(/[◐◓◑◒]/);
      expect(s).toContain("accent:[observer]");
    });

    it("shows ✓ +N when the stage advances after adding observations", async () => {
      const h = setup();
      await startWithObserver(h);
      const branch = [...h.entries(), obsRecorded("m1", "e1", [observation("aabbccddeeff", 100)])];
      h.setEntries(branch);
      h.runtime.consolidationPhase = "reflector";
      await h.fire("agent_end", {}, h.ctx);
      const s = h.lastStatus();
      expect(s).toContain("✓".replace("✓", "success:✓"));
      expect(s).toContain("muted:[observer]");
      expect(s).toContain("success:+1");
    });

    it("shows no ✓ for a stage that skipped itself", async () => {
      const h = setup();
      await startWithObserver(h);
      // Branch unchanged (stage added nothing) — reflector phase starts.
      h.runtime.consolidationPhase = "reflector";
      await h.fire("agent_end", {}, h.ctx);
      const s = h.lastStatus();
      expect(s).not.toContain("success:✓");
      expect(s).not.toContain("[observer]");
      expect(s).toContain("accent:[reflector]");
    });

    it("settles the last stage when the pipeline finishes", async () => {
      const h = setup();
      await startWithObserver(h);
      const branch = [...h.entries(), obsRecorded("m1", "e1", [observation("aabbccddeeff", 100)])];
      h.setEntries(branch);
      h.runtime.consolidationInFlight = false;
      h.runtime.consolidationPhase = undefined;
      await h.fire("agent_end", {}, h.ctx);
      const s = h.lastStatus();
      expect(s).toContain("success:✓");
      expect(s).toContain("success:+1");
      expect(s).not.toMatch(/[◐◓◑◒]/);
    });

    it("clears a settled worker after 5 seconds", async () => {
      const h = setup();
      await startWithObserver(h);
      const branch = [...h.entries(), obsRecorded("m1", "e1", [observation("aabbccddeeff", 100)])];
      h.setEntries(branch);
      h.runtime.consolidationInFlight = false;
      h.runtime.consolidationPhase = undefined;
      await h.fire("agent_end", {}, h.ctx);
      expect(h.lastStatus()).toContain("success:✓");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.lastStatus()).not.toContain("success:✓");
    });

    it("advances the spinner frame while a worker runs", async () => {
      const h = setup();
      await startWithObserver(h);
      const before = h.lastStatus();
      await vi.advanceTimersByTimeAsync(120);
      const after = h.lastStatus();
      const frameOf = (s: string) => /[◐◓◑◒]/.exec(s)![0];
      expect(frameOf(after!)).not.toBe(frameOf(before!));
    });

    it("starts the spinner when the pipeline launches mid-turn (phase not set yet)", async () => {
      const h = setup();
      h.setEntries([msg("e1", 1_000)]);
      await h.fire("session_start", {}, h.ctx);
      // Consolidation triggers launch on agent_start; the pipeline names its
      // first stage a moment later.
      h.runtime.consolidationInFlight = true;
      await h.fire("agent_start", {}, h.ctx);
      expect(h.lastStatus()).not.toMatch(/[◐◓◑◒]/);
      h.runtime.consolidationPhase = "observer";
      await vi.advanceTimersByTimeAsync(120);
      expect(h.lastStatus()).toContain("accent:[observer]");
    });

    it("catches stage transitions during a turn without waiting for agent_end", async () => {
      const h = setup();
      h.setEntries([msg("e1", 1_000)]);
      await h.fire("session_start", {}, h.ctx);
      h.runtime.consolidationInFlight = true;
      h.runtime.consolidationPhase = "observer";
      await h.fire("agent_start", {}, h.ctx);
      const branch = [...h.entries(), obsRecorded("m1", "e1", [observation("aabbccddeeff", 100)])];
      h.setEntries(branch);
      h.runtime.consolidationPhase = "reflector";
      await vi.advanceTimersByTimeAsync(120);
      expect(h.lastStatus()).toContain("muted:[observer]");
      expect(h.lastStatus()).toContain("success:+1");
    });

    it("shows ✓ +N when the reflector stage advances after adding reflections", async () => {
      const h = setup();
      h.setEntries([msg("e1", 1_000)]);
      await h.fire("session_start", {}, h.ctx);
      h.runtime.consolidationInFlight = true;
      h.runtime.consolidationPhase = "reflector";
      await h.fire("agent_end", {}, h.ctx);
      const branch = [...h.entries(), refRecorded("m1", "e1", [reflection("aabbccddeeff", 50)])];
      h.setEntries(branch);
      h.runtime.consolidationPhase = "dropper";
      await h.fire("agent_end", {}, h.ctx);
      const s = h.lastStatus();
      expect(s).toContain("muted:[reflector]");
      expect(s).toContain("success:+1");
    });

    it("shows ✓ +N when the dropper stage finishes after dropping", async () => {
      const h = setup();
      h.setEntries([msg("e1", 1_000), obsRecorded("m0", "e1", [observation("aabbccddeeff", 100)])]);
      await h.fire("session_start", {}, h.ctx);
      h.runtime.consolidationInFlight = true;
      h.runtime.consolidationPhase = "dropper";
      await h.fire("agent_end", {}, h.ctx);
      const branch = [...h.entries(), obsDropped("m1", "e1", ["aabbccddeeff"])];
      h.setEntries(branch);
      h.runtime.consolidationInFlight = false;
      h.runtime.consolidationPhase = undefined;
      await h.fire("agent_end", {}, h.ctx);
      const s = h.lastStatus();
      expect(s).toContain("muted:[dropper]");
      expect(s).toContain("success:+1");
    });
  });

  describe("session_compact", () => {
    it("shows a settled compact event with its reason", async () => {
      const h = setup();
      h.setEntries([msg("e1", 1_000)]);
      await h.fire("session_start", {}, h.ctx);
      await h.fire("session_compact", { reason: "threshold" }, h.ctx);
      const s = h.lastStatus();
      expect(s).toContain("muted:[compact]");
      expect(s).toContain("muted:threshold");
    });

    it("clears the compact event after 5 seconds", async () => {
      const h = setup();
      h.setEntries([msg("e1", 1_000)]);
      await h.fire("session_start", {}, h.ctx);
      await h.fire("session_compact", { reason: "manual" }, h.ctx);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.lastStatus()).not.toContain("[compact]");
    });
  });

  describe("config gate and lifecycle", () => {
    it("writes nothing while statusBar is false", async () => {
      const h = setup({ statusBar: false });
      h.setEntries([msg("e1", 1_000)]);
      await h.fire("session_start", {}, h.ctx);
      await h.fire("agent_end", {}, h.ctx);
      for (const call of h.setStatus.mock.calls) expect(call[1]).toBeUndefined();
    });

    it("clears the footer when statusBar is turned off mid-session", async () => {
      const h = setup();
      h.setEntries([msg("e1", 1_000)]);
      await h.fire("session_start", {}, h.ctx);
      expect(h.lastStatus()).toContain("success:bh");
      h.runtime.config.statusBar = false;
      await h.fire("agent_end", {}, h.ctx);
      expect(h.lastStatus()).toBeUndefined();
    });

    it("clears the footer on session_shutdown", async () => {
      const h = setup();
      h.setEntries([msg("e1", 1_000)]);
      await h.fire("session_start", {}, h.ctx);
      await h.fire("session_shutdown", {});
      expect(h.lastStatus()).toBeUndefined();
    });

    it("does not render or start polling when ctx.hasUI is false", async () => {
      const h = setup();
      h.setEntries([msg("e1", 1_000)]);
      const timersBefore = vi.getTimerCount();
      await h.fire("session_start", {}, { ...h.ctx, hasUI: false });
      expect(h.setStatus).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(timersBefore);
    });

    it("does not render or start polling when ctx.ui is undefined", async () => {
      const h = setup();
      h.setEntries([msg("e1", 1_000)]);
      const timersBefore = vi.getTimerCount();
      await h.fire("session_start", {}, { ...h.ctx, ui: undefined });
      expect(h.setStatus).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(timersBefore);
    });
  });
});
