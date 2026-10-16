/**
 * Reflection retirement: with reflectionSupersedes on, a reflection named by a
 * newer reflection's `supersedes` leaves the compaction projection.
 */
import { describe, expect, it } from "vitest";

import { buildCompactionProjection, renderSummary, type Entry } from "../src/om/ledger/index.js";
import {
  observation,
  observationsRecordedEntry,
  reflection,
  reflectionsRecordedEntry,
  textCustomMessage,
  type TestEntry,
} from "./fixtures/session.js";

const STALE = "aaaaaaaaaaaa";
const asEntries = (entries: TestEntry[]): Entry[] => entries as unknown as Entry[];
const projectionConfig = { observationsPoolMaxTokens: 100_000 };

describe("reflection supersession retires from projection", () => {
  const OLD = "cccccccccccc";
  const NEW = "dddddddddddd";
  const entries = (): Entry[] =>
    asEntries([
      textCustomMessage("raw-1", "x"),
      observationsRecordedEntry("om-1", {
        observations: [observation(STALE)],
        coversUpToId: "raw-1",
      }),
      reflectionsRecordedEntry("rf-1", {
        reflections: [reflection(OLD, [STALE], { content: "Build is failing" })],
        coversUpToId: "raw-1",
      }),
      reflectionsRecordedEntry("rf-2", {
        reflections: [reflection(NEW, [STALE], { content: "Build is fixed", supersedes: [OLD] })],
        coversUpToId: "raw-1",
      }),
    ]);

  it("drops the superseded reflection when reflectionSupersedes is on", () => {
    const projection = buildCompactionProjection(entries(), "", {
      ...projectionConfig,
      reflectionSupersedes: true,
    });
    expect(projection.reflections.map((r) => r.id)).toEqual([NEW]);
  });

  it("keeps every reflection when reflectionSupersedes is off (display-only default)", () => {
    const projection = buildCompactionProjection(entries(), "", projectionConfig);
    expect(projection.reflections.map((r) => r.id)).toEqual([OLD, NEW]);
  });

  it("footer no longer claims superseded reflections remain available", () => {
    const text = renderSummary([reflection(NEW, [STALE], { supersedes: [OLD] })], [], {
      timestamps: false,
      supersedes: true,
    });
    expect(text).not.toContain("all reflections remain available");
  });
});
