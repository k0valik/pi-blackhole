/**
 * Ledger projection: compaction cut that falls inside a recorded run.
 * Shares its helper shapes with projection.test.ts.
 */

import { describe, it, expect } from "vitest";
import type { Entry, Observation, Reflection } from "../src/om/ledger/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeEntry(
  id: string,
  type: string = "message",
  overrides: Record<string, unknown> = {},
): Entry {
  return { id, type, ...overrides } as Entry;
}

function hexId(label: string): string {
  const raw = Array.from(label).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
  return Math.abs(raw).toString(16).padStart(12, "0").slice(0, 12);
}

function makeObservation(id: string, overrides: Partial<Observation> = {}): Observation {
  return {
    id,
    content: `Content ${id}`,
    timestamp: "2026-01-01 12:00",
    relevance: "medium" as const,
    sourceEntryIds: ["aaaaaaaaaaaa"],
    tokenCount: 100,
    ...overrides,
  };
}

function makeReflection(id: string, overrides: Partial<Reflection> = {}): Reflection {
  return {
    id,
    content: `Reflection ${id}`,
    supportingObservationIds: ["aaaaaaaaaaaa"],
    tokenCount: 200,
    ...overrides,
  };
}

function recordEntry(id: string, observations: Observation[], coversUpToId: string): Entry {
  return makeEntry(id, "custom", {
    customType: "om.observations.recorded",
    data: { observations, coversUpToId },
  });
}

function reflectEntry(id: string, reflections: Reflection[], coversUpToId: string): Entry {
  return makeEntry(id, "custom", {
    customType: "om.reflections.recorded",
    data: { reflections, coversUpToId },
  });
}

function compactionEntry(id: string, firstKeptEntryId: string, details?: unknown): Entry {
  return makeEntry(id, "compaction", { firstKeptEntryId, details });
}

/** A "source" entry (message) that serves as a coverage boundary */
function src(id: string): Entry {
  return makeEntry(id, "message", {
    message: { role: "user", content: "test" },
  });
}

// ── Tests ───

describe("buildCompactionProjection — reflection run straddling the cut", () => {
  const cfg = { observationsPoolMaxTokens: 20_000, fullFoldAlways: true };
  const obs = (label: string, sources: string[]) =>
    makeObservation(hexId(label), { sourceEntryIds: sources });
  const refl = (label: string, supports: string[]) =>
    makeReflection(hexId(label), { supportingObservationIds: supports });

  it("keeps reflections supported only by pre-cut observations", async () => {
    const { buildCompactionProjection } = await import("../src/om/ledger/projection.js");
    const early = obs("early", ["s1"]);
    const late = obs("late", ["s4"]);
    const fromEarly = refl("from-early", [early.id]);
    const fromLate = refl("from-late", [late.id]);
    const mixed = refl("mixed", [early.id, late.id]);
    const entries: Entry[] = [src("s1"), src("s2"), src("s3"), src("s4")];
    entries.push(recordEntry("e1", [early, late], "s2"));
    entries.push(reflectEntry("r1", [fromEarly, fromLate, mixed], "s4")); // coverage past the cut
    const result = buildCompactionProjection(entries, "s3", cfg);
    expect(result.reflections.map((r) => r.id)).toEqual([fromEarly.id]);
  });

  it("excludes reflections with unknown or no supporting observations", async () => {
    const { buildCompactionProjection } = await import("../src/om/ledger/projection.js");
    const early = obs("early", ["s1"]);
    const entries: Entry[] = [src("s1"), src("s2"), src("s3")];
    entries.push(recordEntry("e1", [early], "s1"));
    entries.push(reflectEntry("r1", [refl("unknown", ["ffffffffffff"]), refl("none", [])], "s3"));
    expect(buildCompactionProjection(entries, "s2", cfg).reflections).toEqual([]);
  });

  it("stays off without a maintenance boundary (fullFoldAlways false)", async () => {
    const { buildCompactionProjection } = await import("../src/om/ledger/projection.js");
    const early = obs("early", ["s1"]);
    const entries: Entry[] = [src("s1"), src("s2"), src("s3")];
    entries.push(recordEntry("e1", [early], "s1"));
    entries.push(reflectEntry("r1", [refl("from-early", [early.id])], "s3"));
    const result = buildCompactionProjection(entries, "s2", {
      observationsPoolMaxTokens: 20_000,
    });
    expect(result.reflections).toEqual([]);
  });

  it("uses the latest full-fold boundary when one exists", async () => {
    const { buildCompactionProjection } = await import("../src/om/ledger/projection.js");
    const old = obs("old", ["s1"]);
    const newer = obs("newer", ["s3"]);
    const entries: Entry[] = [src("s1"), src("s2"), src("s3"), src("s4"), src("s5")];
    entries.push(recordEntry("e1", [old, newer], "s3"));
    entries.push(
      compactionEntry("c1", "s2", {
        type: "om.folded",
        version: 1,
        fullFold: true,
        observations: [],
        reflections: [],
      }),
    );
    entries.push(
      reflectEntry("r1", [refl("from-old", [old.id]), refl("from-newer", [newer.id])], "s5"),
    );
    const result = buildCompactionProjection(entries, "s4", cfg);
    expect(result.reflections.map((r) => r.id)).toEqual([hexId("from-old")]);
  });

  it("leaves a wholly covered reflection run and compact-all unchanged", async () => {
    const { buildCompactionProjection } = await import("../src/om/ledger/projection.js");
    const early = obs("early", ["s1"]);
    const late = obs("late", ["s3"]);
    const r = refl("from-late", [late.id]);
    const entries: Entry[] = [src("s1"), src("s2"), src("s3")];
    entries.push(recordEntry("e1", [early, late], "s3"));
    entries.push(reflectEntry("r1", [r], "s3"));
    expect(buildCompactionProjection(entries, "s3", cfg).reflections).toHaveLength(1);
    expect(buildCompactionProjection(entries, "", cfg).reflections).toHaveLength(1);
  });

  it("does not repeat a reflection once its run is wholly covered", async () => {
    const { buildCompactionProjection } = await import("../src/om/ledger/projection.js");
    const early = obs("early", ["s1"]);
    const r = refl("from-early", [early.id]);
    const entries: Entry[] = [src("s1"), src("s2"), src("s3"), src("s4")];
    entries.push(recordEntry("e1", [early], "s1"));
    entries.push(reflectEntry("r1", [r], "s4"));
    const first = buildCompactionProjection(entries, "s3", cfg);
    entries.push(compactionEntry("c1", "s3", first.details), src("s5"));
    const second = buildCompactionProjection(entries, "s5", cfg);
    expect(first.reflections.map((x) => x.id)).toEqual([r.id]);
    expect(second.reflections.map((x) => x.id)).toEqual([r.id]);
  });
});
