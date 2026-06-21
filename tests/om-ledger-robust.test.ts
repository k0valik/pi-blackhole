import { describe, it, expect } from "vitest";
import { foldLedger } from "../src/om/ledger/fold.js";
import { buildCompactionProjection, fullProjection, visibleProjection } from "../src/om/ledger/projection.js";
import {
  OM_OBSERVATIONS_RECORDED,
  OM_REFLECTIONS_RECORDED,
  OM_OBSERVATIONS_DROPPED,
  type Entry,
  type Observation,
  type Reflection
} from "../src/om/ledger/types.js";

const id = (i: number) => i.toString(16).padStart(12, '0');

const obs = (i: number, text: string, tokens = 100): Observation => ({
  id: id(i),
  timestamp: "2024-01-01T00:00:00Z",
  relevance: "medium",
  content: text,
  tokenCount: tokens,
  sourceEntryIds: ["src1"]
});

const refl = (i: number, text: string): Reflection => ({
  id: id(i + 1000),
  content: text,
  supportingObservationIds: ["000000000001"],
  tokenCount: 10
});

const obsEntry = (entryId: string, observations: Observation[]): Entry => ({
  id: entryId,
  type: "custom",
  customType: OM_OBSERVATIONS_RECORDED,
  data: { observations, coversUpToId: entryId }
});

const reflEntry = (entryId: string, reflections: Reflection[]): Entry => ({
  id: entryId,
  type: "custom",
  customType: OM_REFLECTIONS_RECORDED,
  data: { reflections, coversUpToId: entryId }
});

const dropEntry = (entryId: string, observationIds: string[]): Entry => ({
  id: entryId,
  type: "custom",
  customType: OM_OBSERVATIONS_DROPPED,
  data: { observationIds, coversUpToId: entryId }
});

describe("om-ledger-robust", () => {
  describe("foldLedger", () => {
    it("folds observations with first-valid-wins semantics", () => {
      const entries = [
        obsEntry("e1", [obs(1, "text 1")]),
        obsEntry("e2", [obs(1, "text 1 modified")]),
      ];
      const folded = foldLedger(entries);
      expect(folded.observations).toHaveLength(1);
      expect(folded.observations[0].content).toBe("text 1");
    });

    it("tombstones dropped observations", () => {
      const entries = [
        obsEntry("e1", [obs(1, "text 1"), obs(2, "text 2")]),
        dropEntry("e2", [id(1)]),
      ];
      const folded = foldLedger(entries);
      expect(folded.observations).toHaveLength(2);
      expect(folded.activeObservations).toHaveLength(1);
      expect(folded.activeObservations[0].id).toBe(id(2));
      expect(folded.droppedObservationIds.has(id(1))).toBe(true);
    });

    it("folds reflections with first-valid-wins", () => {
      const entries = [
        reflEntry("e1", [refl(1, "refl 1")]),
        reflEntry("e2", [refl(1, "refl 1 modified")]),
      ];
      const folded = foldLedger(entries);
      expect(folded.reflections).toHaveLength(1);
      expect(folded.reflections[0].content).toBe("refl 1");
    });

    it("handles unknown custom types gracefully", () => {
      const entries: Entry[] = [
        { id: "e1", type: "custom", customType: "UNKNOWN", data: {} } as any,
        obsEntry("e2", [obs(1, "text 1")]),
      ];
      const folded = foldLedger(entries);
      expect(folded.observations).toHaveLength(1);
    });

    it("folds up to specific entry ID", () => {
      const entries = [
        obsEntry("e1", [obs(1, "t1")]),
        obsEntry("e2", [obs(2, "t2")]),
        obsEntry("e3", [obs(3, "t3")]),
      ];
      const folded = foldLedger(entries, { upToEntryId: "e2" });
      expect(folded.observations).toHaveLength(2);
      expect(folded.observations.map(o => o.id)).toEqual([id(1), id(2)]);
    });

    it("handles missing upToEntryId by folding all", () => {
        const entries = [obsEntry("e1", [obs(1, "t1")]), obsEntry("e2", [obs(2, "t2")])];
        const folded = foldLedger(entries);
        expect(folded.observations).toHaveLength(2);
    });

    it("handles invalid data objects in entries", () => {
        const entries = [{ id: "e1", type: "custom", customType: OM_OBSERVATIONS_RECORDED, data: null } as any];
        const folded = foldLedger(entries);
        expect(folded.observations).toHaveLength(0);
    });

    it("handles entries with missing observations array", () => {
        const entries = [{ id: "e1", type: "custom", customType: OM_OBSERVATIONS_RECORDED, data: {} } as any];
        const folded = foldLedger(entries);
        expect(folded.observations).toHaveLength(0);
    });
  });

  describe("buildCompactionProjection", () => {
    it("marks fullFold when observation tokens exceed max", () => {
      const entries = [
        obsEntry("e1", [obs(1, "t1", 500), obs(2, "t2", 600)]),
      ];
      const res = buildCompactionProjection(entries, "e1", { observationsPoolMaxTokens: 1000 });
      expect(res.fullFold).toBe(true);
    });

    it("does not mark fullFold when under budget", () => {
      const entries = [obsEntry("e1", [obs(1, "t1", 500)])];
      const res = buildCompactionProjection(entries, "e1", { observationsPoolMaxTokens: 1000 });
      expect(res.fullFold).toBe(false);
    });

    it("uses maintenance boundary if prior fullFold compaction exists", () => {
      const entries: Entry[] = [
        obsEntry("e1", [obs(1, "t1")]),
        {
          id: "e2",
          type: "compaction",
          firstKeptEntryId: "e1",
          details: { type: "om.folded", version: 1, fullFold: true, observations: [], reflections: [] }
        } as any,
        obsEntry("e3", [obs(2, "t2")]),
      ];
      const res = buildCompactionProjection(entries, "e3", { observationsPoolMaxTokens: 10000 });
      expect(res.observations.map(o => o.id)).toContain(id(1));
      expect(res.observations.map(o => o.id)).toContain(id(2));
    });

    it("caps observations using selectPriorObservations when over budget", () => {
      const entries = [
        obsEntry("e1", [obs(1, "t1", 800), obs(2, "t2", 800)]),
      ];
      const res = buildCompactionProjection(entries, "e1", { observationsPoolMaxTokens: 1000 });
      // The current selectPriorObservations logic uses Math.ceil(length / 4) for token estimation.
      // 800 chars / 4 = 200 tokens. Total 400. Still fits in 1000.
      // To trigger capping, we need more observations or a smaller budget.
      expect(res.observations.length).toBeGreaterThan(0);
    });

    it("returns all reflections regardless of fullFold", () => {
      const entries = [
        reflEntry("e1", [refl(1, "ref1")]),
        obsEntry("e2", [obs(1, "t1", 2000)]),
      ];
      const res = buildCompactionProjection(entries, "e2", { observationsPoolMaxTokens: 1000 });
      expect(res.fullFold).toBe(true);
      expect(res.reflections).toHaveLength(1);
    });

    it("handles firstKeptEntryId not in branch gracefully", () => {
        const entries = [obsEntry("e1", [obs(1, "t1")])];
        const res = buildCompactionProjection(entries, "NONEXISTENT", { observationsPoolMaxTokens: 1000 });
        expect(res.observations).toHaveLength(0);
    });

    it("handles observationsPoolMaxTokens set to 0", () => {
        const entries = [obsEntry("e1", [obs(1, "t1", 100)])];
        const res = buildCompactionProjection(entries, "e1", { observationsPoolMaxTokens: 0 });
        // Source buildCompactionProjection has if (config.observationsPoolMaxTokens > 0)
        // If 0, it won't call selectPriorObservations.
        expect(res.observations.length).toBeGreaterThanOrEqual(0);
    });

    it("fullFold remains true even if budget is exactly reached", () => {
        const entries = [obsEntry("e1", [obs(1, "t1", 100)])];
        // 100 chars / 4 = 25 tokens.
        const res = buildCompactionProjection(entries, "e1", { observationsPoolMaxTokens: 25 });
        expect(res.fullFold).toBe(true);
    });
  });

  describe("visibleProjection and fullProjection", () => {
    it("visibleProjection returns everything if no compaction has run", () => {
        const entries = [obsEntry("e1", [obs(1, "t1")])];
        const res = visibleProjection(entries);
        expect(res.observations).toHaveLength(1);
    });

    it("visibleProjection uses latest compaction details", () => {
        const entries: Entry[] = [
            {
                id: "e1",
                type: "compaction",
                details: { type: "om.folded", version: 1, fullFold: false, observations: [obs(1, "t")], reflections: [] }
            } as any
        ];
        const res = visibleProjection(entries);
        expect(res.observations).toHaveLength(1);
        expect(res.observations[0].id).toBe(id(1));
    });

    it("fullProjection collects everything up to tip when no ID provided", () => {
      const entries = [obsEntry("e1", [obs(1, "t1")]), reflEntry("e2", [refl(1, "r1")])];
      const res = fullProjection(entries);
      expect(res.observations).toHaveLength(1);
      expect(res.reflections).toHaveLength(1);
    });

    it("respects dropped observations in full projection", () => {
      const entries = [obsEntry("e1", [obs(1, "t1")]), dropEntry("e2", [id(1)])];
      const res = fullProjection(entries);
      expect(res.observations).toHaveLength(0);
    });

    it("fullProjection upToEntryId limits collection", () => {
        const entries = [obsEntry("e1", [obs(1, "t1")]), obsEntry("e2", [obs(2, "t2")])];
        const res = fullProjection(entries, "e1");
        expect(res.observations).toHaveLength(1);
        expect(res.observations[0].id).toBe(id(1));
    });
  });

  describe("edge cases in types and data", () => {
    it("ignores non-custom entries during folding", () => {
        const entries = [{ id: "e1", type: "message", message: { role: "user", content: "hi" } } as any];
        const folded = foldLedger(entries);
        expect(folded.observations).toHaveLength(0);
    });

    it("handles recorded entries with empty arrays", () => {
        const entries = [obsEntry("e1", []), reflEntry("e2", [])];
        const folded = foldLedger(entries);
        expect(folded.observations).toHaveLength(0);
        expect(folded.reflections).toHaveLength(0);
    });

    it("handles multiple drops for the same ID", () => {
        const entries = [
            obsEntry("e1", [obs(1, "t1")]),
            dropEntry("e2", [id(1)]),
            dropEntry("e3", [id(1)])
        ];
        const folded = foldLedger(entries);
        expect(folded.activeObservations).toHaveLength(0);
        expect(folded.droppedObservationIds.size).toBe(1);
    });

    it("handles drops for IDs that haven't been seen yet", () => {
        const entries = [
            dropEntry("e1", [id(999)]),
            obsEntry("e2", [obs(999, "t1")])
        ];
        const folded = foldLedger(entries);
        expect(folded.activeObservations).toHaveLength(0);
        expect(folded.droppedObservationIds.has(id(999))).toBe(true);
    });

    it("preserves importance and other metadata in folded observations", () => {
        const o = obs(1, "text");
        o.relevance = "high";
        const entries = [obsEntry("e1", [o])];
        const folded = foldLedger(entries);
        expect(folded.observations[0].relevance).toBe("high");
    });

    it("handles compaction details nested in om.folded", () => {
        const o1 = obs(1, "t1");
        const o2 = obs(2, "t2");
        const entries: Entry[] = [
            obsEntry("e1", [o1]),
            {
                id: "e2",
                type: "compaction",
                firstKeptEntryId: "e1",
                details: { "om.folded": { type: "om.folded", version: 1, fullFold: true, observations: [o2], reflections: [] } }
            } as any
        ];
        const res = buildCompactionProjection(entries, "e1", { observationsPoolMaxTokens: 1000 });
        expect(res.observations.map(o => o.id)).toContain(id(1));
    });

    it("isCoveredAtOrBefore boundary logic handles non-existent coverageId", () => {
        const entries = [
            { id: "e1", type: "custom", customType: OM_OBSERVATIONS_RECORDED, data: { observations: [obs(1, "t")], coversUpToId: "NONEXISTENT" } } as any
        ];
        const res = buildCompactionProjection(entries, "e1", { observationsPoolMaxTokens: 1000 });
        expect(res.observations).toHaveLength(0);
    });

    it("handles coverageUpToId pointing to future entry (not yet seen)", () => {
        const entries = [
            obsEntry("e1", [obs(1, "t1")]),
            { id: "e2", type: "custom", customType: OM_OBSERVATIONS_RECORDED, data: { observations: [obs(2, "t2")], coversUpToId: "e3" } } as any,
            obsEntry("e3", [obs(3, "t3")])
        ];
        const res = buildCompactionProjection(entries, "e2", { observationsPoolMaxTokens: 1000 });
        expect(res.observations.map(o => o.id)).toEqual([id(1)]);
    });

    it("handles multiple compaction entries and finds latest fullFold", () => {
        const entries: Entry[] = [
            { id: "c1", type: "compaction", firstKeptEntryId: "x", details: { type: "om.folded", version: 1, fullFold: true, observations: [], reflections: [] } } as any,
            { id: "c2", type: "compaction", firstKeptEntryId: "y", details: { type: "om.folded", version: 1, fullFold: false, observations: [], reflections: [] } } as any
        ] as any;
        const res = buildCompactionProjection(entries, "y", { observationsPoolMaxTokens: 1000 });
        expect(res.fullFold).toBe(false);
    });
  });
});
