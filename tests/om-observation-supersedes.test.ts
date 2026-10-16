/**
 * Observation supersession: a newer observation explicitly retires the stale
 * observation it replaces, so "unresolved X" never sits beside "resolved: X".
 */
import { describe, expect, it } from "vitest";

import { runObserver } from "../src/om/agents/observer/agent.js";
import { OBSERVER_SYSTEM } from "../src/om/agents/observer/prompts.js";
import { RecordObservationsSchema } from "../src/om/agents/observer/tool-schema.js";
import {
  buildCompactionProjection,
  foldLedger,
  fullProjection,
  isObservation,
  livePoolObservations,
  renderSummary,
  type Entry,
} from "../src/om/ledger/index.js";
import {
  observation,
  observationsRecordedEntry,
  textCustomMessage,
  type TestEntry,
} from "./fixtures/session.js";

const STALE = "aaaaaaaaaaaa";
const FRESH = "bbbbbbbbbbbb";
const asEntries = (entries: TestEntry[]): Entry[] => entries as unknown as Entry[];

function branch(freshExtra: Record<string, unknown> = {}): TestEntry[] {
  return [
    textCustomMessage("raw-1", "unresolved"),
    observationsRecordedEntry("om-1", {
      observations: [observation(STALE, { content: "unresolved: build fails" })],
      coversUpToId: "raw-1",
    }),
    textCustomMessage("raw-2", "fixed"),
    observationsRecordedEntry("om-2", {
      observations: [
        { ...observation(FRESH, { content: "resolved: build fails" }), ...freshExtra },
      ],
      coversUpToId: "raw-2",
    }),
  ];
}

const projectionConfig = { observationsPoolMaxTokens: 100_000 };

describe("observation supersession in the ledger", () => {
  it("(a) baseline: a reworded resolution leaves the stale line without supersedes", () => {
    const ids = fullProjection(asEntries(branch())).observations.map((o) => o.id);
    expect(ids).toEqual([STALE, FRESH]);
  });

  it("retires the superseded observation from fold, projection and compaction", () => {
    const entries = asEntries(branch({ supersedes: [STALE] }));
    expect(foldLedger(entries).activeObservations.map((o) => o.id)).toEqual([FRESH]);
    expect(fullProjection(entries).observations.map((o) => o.id)).toEqual([FRESH]);
    const compacted = buildCompactionProjection(entries, "", projectionConfig);
    expect(compacted.observations.map((o) => o.id)).toEqual([FRESH]);
    const summary = renderSummary([], compacted.observations);
    expect(summary).toContain("resolved: build fails");
    expect(summary).not.toContain("unresolved: build fails");
  });

  it("keeps the stale line when the superseder is outside the projection boundary", () => {
    const entries = asEntries(branch({ supersedes: [STALE] }));
    const projection = buildCompactionProjection(entries, "raw-1", projectionConfig);
    expect(projection.observations.map((o) => o.id)).toEqual([STALE]);
  });

  it("(c) ignores unknown, self and malformed supersedes ids", () => {
    const entries = asEntries(
      branch({ supersedes: ["cccccccccccc", FRESH, "not-an-id", 7, STALE.toUpperCase()] }),
    );
    expect(fullProjection(entries).observations.map((o) => o.id)).toEqual([STALE, FRESH]);
    expect(foldLedger(entries).activeObservations.map((o) => o.id)).toEqual([STALE, FRESH]);
  });

  it("(d) legacy observations without supersedes still validate and load", () => {
    expect(isObservation(observation(STALE))).toBe(true);
    expect(isObservation({ ...observation(STALE), supersedes: "garbage" })).toBe(true);
    const entries = asEntries(branch());
    expect(foldLedger(entries).activeObservations).toHaveLength(2);
  });

  it("keeps a superseded fact retired when it is re-emitted later", () => {
    const entries = asEntries([
      ...branch({ supersedes: [STALE] }),
      textCustomMessage("raw-3", "again"),
      observationsRecordedEntry("om-3", {
        observations: [observation(STALE, { content: "unresolved: build fails" })],
        coversUpToId: "raw-3",
      }),
    ]);
    expect(fullProjection(entries).observations.map((o) => o.id)).toEqual([FRESH]);
  });

  it("removes superseded observations from the live pool incl. manual pending batches", () => {
    const entries = asEntries([
      textCustomMessage("raw-1", "x"),
      observationsRecordedEntry("om-1", {
        observations: [observation(STALE)],
        coversUpToId: "raw-1",
      }),
    ]);
    const pending = {
      observationBatches: [
        {
          coversUpToId: "raw-1",
          data: { observations: [{ ...observation(FRESH), supersedes: [STALE] }] },
        },
      ],
    } as any;
    expect(livePoolObservations(entries, pending).map((o) => o.id)).toEqual([FRESH]);
  });
});

describe("observer prompt and tool schema", () => {
  it("observer prompt and schema expose supersedes", () => {
    expect(OBSERVER_SYSTEM).toContain("supersedes");
    const item = (RecordObservationsSchema.properties.observations as any).items;
    expect(Object.keys(item.properties)).toContain("supersedes");
    expect(item.required ?? []).not.toContain("supersedes");
  });
});

describe("runObserver supersedes handling", () => {
  function loopCalling(batch: unknown[]): any {
    return ((_p: any, context: any) => ({
      async *[Symbol.asyncIterator]() {},
      result: async () => {
        await context.tools[0].execute("1", { observations: batch, complete: true });
        return {};
      },
    })) as any;
  }
  const base = {
    model: {} as any,
    apiKey: "k",
    priorReflections: [],
    priorObservations: [`[${STALE}] 2026-01-01 12:00 [medium] unresolved: build fails`],
    priorObservationIds: [STALE],
    chunk: "[Source entry id: e1]\nfixed",
    allowedSourceEntryIds: ["e1"],
  };

  it("keeps only supersedes ids that exist in the shown pool, without failing the batch", async () => {
    const result = await runObserver({
      ...base,
      agentLoop: loopCalling([
        {
          content: "resolved: build fails",
          relevance: "high",
          sourceEntryIds: ["e1"],
          supersedes: [STALE, "cccccccccccc", "bogus"],
        },
      ]),
    });
    expect(result.observations).toHaveLength(1);
    expect(result.observations?.[0]?.supersedes).toEqual([STALE]);
  });

  it("omits the field when nothing valid remains", async () => {
    const result = await runObserver({
      ...base,
      agentLoop: loopCalling([
        {
          content: "resolved: build fails",
          relevance: "high",
          sourceEntryIds: ["e1"],
          supersedes: ["cccccccccccc"],
        },
      ]),
    });
    expect(result.observations).toHaveLength(1);
    expect(result.observations?.[0]).not.toHaveProperty("supersedes");
  });
});
