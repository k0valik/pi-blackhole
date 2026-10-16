/**
 * Ledger projection: compaction cut that falls inside a recorded run.
 * Shares its helper shapes with projection.test.ts.
 */

import { describe, it, expect } from "vitest";
import type { Entry, Observation } from "../src/om/ledger/types.js";

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

function recordEntry(id: string, observations: Observation[], coversUpToId: string): Entry {
  return makeEntry(id, "custom", {
    customType: "om.observations.recorded",
    data: { observations, coversUpToId },
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

describe("buildCompactionProjection — batch straddling the cut", () => {
  const cfg = { observationsPoolMaxTokens: 20_000 };
  const obs = (label: string, sources: string[]) =>
    makeObservation(hexId(label), { sourceEntryIds: sources });

  it("keeps the observations cited at or before the cut, drops those past it", async () => {
    const { buildCompactionProjection } = await import("../src/om/ledger/projection.js");
    const early = obs("early", ["s1"]);
    const atCut = obs("at-cut", ["s2", "s3"]);
    const late = obs("late", ["s5"]);
    const entries: Entry[] = [
      src("s1"),
      src("s2"),
      src("s3"), // firstKeptEntryId
      src("s4"),
      src("s5"),
      recordEntry("e1", [early, atCut, late], "s5"), // coverage past the cut
    ];
    const result = buildCompactionProjection(entries, "s3", cfg);
    expect(result.observations.map((o) => o.id)).toEqual([early.id, atCut.id]);
    expect(result.details.observations.map((o) => o.id)).toEqual([early.id, atCut.id]);
  });

  it("excludes an observation that mixes pre-cut and post-cut sources", async () => {
    const { buildCompactionProjection } = await import("../src/om/ledger/projection.js");
    const mixed = obs("mixed", ["s1", "s4"]);
    const entries: Entry[] = [src("s1"), src("s2"), src("s3"), src("s4")];
    entries.push(recordEntry("e1", [mixed], "s4"));
    expect(buildCompactionProjection(entries, "s3", cfg).observations).toEqual([]);
  });

  it("excludes observations whose sources cannot be placed in the branch", async () => {
    const { buildCompactionProjection } = await import("../src/om/ledger/projection.js");
    const unknown = obs("unknown", ["not-in-branch"]);
    const nothing = obs("nothing", []);
    const entries: Entry[] = [src("s1"), src("s2"), src("s3")];
    entries.push(recordEntry("e1", [unknown, nothing], "s3"));
    expect(buildCompactionProjection(entries, "s2", cfg).observations).toEqual([]);
  });

  it("still excludes a batch that lies wholly past the cut", async () => {
    const { buildCompactionProjection } = await import("../src/om/ledger/projection.js");
    const entries: Entry[] = [src("s1"), src("s2"), src("s3")];
    entries.push(recordEntry("e1", [obs("late-a", ["s3"])], "s3"));
    expect(buildCompactionProjection(entries, "s2", cfg).observations).toEqual([]);
  });

  it("does not repeat or lose observations on the next compaction", async () => {
    const { buildCompactionProjection } = await import("../src/om/ledger/projection.js");
    const early = obs("early", ["s1"]);
    const late = obs("late", ["s4"]);
    const entries: Entry[] = [
      src("s1"),
      src("s2"),
      src("s3"),
      src("s4"),
      recordEntry("e1", [early, late], "s4"),
    ];
    const first = buildCompactionProjection(entries, "s3", cfg);
    expect(first.observations.map((o) => o.id)).toEqual([early.id]);
    entries.push(compactionEntry("c1", "s3", first.details), src("s5"));
    const second = buildCompactionProjection(entries, "s5", cfg);
    expect(second.observations.map((o) => o.id)).toEqual([early.id, late.id]);
  });

  it("applies to fullProjection and visibleProjection with a boundary", async () => {
    const { fullProjection, visibleProjection } = await import("../src/om/ledger/projection.js");
    const early = obs("early", ["s1"]);
    const late = obs("late", ["s3"]);
    const entries: Entry[] = [src("s1"), src("s2"), src("s3")];
    entries.push(recordEntry("e1", [early, late], "s3"));
    expect(fullProjection(entries, "s2").observations.map((o) => o.id)).toEqual([early.id]);
    expect(visibleProjection(entries, "s2").observations.map((o) => o.id)).toEqual([early.id]);
  });

  it("leaves compact-all and wholly covered batches unchanged", async () => {
    const { buildCompactionProjection } = await import("../src/om/ledger/projection.js");
    const a = obs("a", ["s1"]);
    const b = obs("b", ["s3"]);
    const entries: Entry[] = [src("s1"), src("s2"), src("s3")];
    entries.push(recordEntry("e1", [a, b], "s3"));
    expect(buildCompactionProjection(entries, "", cfg).observations).toHaveLength(2);
    expect(buildCompactionProjection(entries, "s3", cfg).observations).toHaveLength(2);
  });

  it("does not apply drops that are recorded past the cut", async () => {
    const { buildCompactionProjection } = await import("../src/om/ledger/projection.js");
    const early = obs("early", ["s1"]);
    const entries: Entry[] = [src("s1"), src("s2"), src("s3")];
    entries.push(recordEntry("e1", [early], "s3"));
    entries.push(
      makeEntry("d1", "custom", {
        customType: "om.observations.dropped",
        data: { observationIds: [early.id], coversUpToId: "s3" },
      }),
    );
    expect(buildCompactionProjection(entries, "s2", cfg).observations.map((o) => o.id)).toEqual([
      early.id,
    ]);
  });
});
