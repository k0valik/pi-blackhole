/**
 * Ported from upstream pi-observational-memory
 * Changes: import path from session-ledger/ → om/ledger/
 *
 * Tests V3 progress helpers — token counting, coverage tracking, index lookups.
 */
import { describe, expect, it } from "vitest";

import {
  earlierCoverageMarkerId,
  entryIndexById,
  firstValidUsageIndex,
  isSourceEntry,
  lastValidUsageIndex,
  latestCoverageIndex,
  latestCoverageMarkerId,
  measureSinceAnchor,
  rawTokensAfterIndex,
  rawTokensSinceDropCoverage,
  rawTokensSinceLastCompaction,
  rawTokensSinceObservationCoverage,
  rawTokensSinceReflectionCoverage,
  realContextTokens,
  realTokensAtAnchor,
  realTokensSinceAnchor,
} from "../src/om/ledger/index.js";
import {
  V3_OBSERVATIONS_DROPPED,
  V3_OBSERVATIONS_RECORDED,
  V3_REFLECTIONS_RECORDED,
  branchSummary,
  compactionEntry,
  observation,
  observationsDroppedEntry,
  observationsRecordedEntry,
  oldV2ObservationEntry,
  rawMessage,
  reflection,
  reflectionsRecordedEntry,
  textCustomMessage,
} from "./fixtures/session.js";

describe("session-ledger V3 progress helpers", () => {
  it("detects only raw/source entries as source entries", () => {
    expect(isSourceEntry(textCustomMessage("raw-1", "abcd"))).toBe(true);
    expect(isSourceEntry(branchSummary("sum-1", "abcd"))).toBe(true);
    expect(
      isSourceEntry(
        observationsRecordedEntry("om-1", {
          observations: [observation("aaaaaaaaaaaa")],
          coversUpToId: "raw-1",
        }),
      ),
    ).toBe(false);
    expect(isSourceEntry(compactionEntry("cmp-1"))).toBe(false);
  });

  it("builds a branch id to index map", () => {
    const entries = [
      textCustomMessage("raw-1", "abcd"),
      textCustomMessage("raw-2", "efgh"),
    ];
    expect(entryIndexById(entries).get("raw-1")).toBe(0);
    expect(entryIndexById(entries).get("raw-2")).toBe(1);
  });

  it("counts raw tokens after a branch index and ignores memory/compaction entries", () => {
    const entries = [
      textCustomMessage("raw-1", "aaaa"),
      observationsRecordedEntry("om-1", {
        observations: [observation("aaaaaaaaaaaa")],
        coversUpToId: "raw-1",
      }),
      textCustomMessage("raw-2", "bbbbbbbb"),
      compactionEntry("cmp-1", { firstKeptEntryId: "raw-2" }),
      branchSummary("sum-1", "cccccccccccc"),
    ];

    expect(rawTokensAfterIndex(entries, 0)).toBe(5); // raw-2: 2 + sum-1: 3
    expect(rawTokensAfterIndex(entries, 1)).toBe(5);
    expect(rawTokensAfterIndex(entries, 2)).toBe(3);
  });

  it("uses independent coverage clocks for observations, reflections, and drops", () => {
    const entries = [
      textCustomMessage("raw-1", "aaaa"),
      observationsRecordedEntry("om-aaaaaaaaaaaa", {
        observations: [observation("aaaaaaaaaaaa")],
        coversUpToId: "raw-1",
      }),
      textCustomMessage("raw-2", "bbbbbbbb"),
      reflectionsRecordedEntry("om-eeeeeeeeeeee", {
        reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
        coversUpToId: "raw-2",
      }),
      textCustomMessage("raw-3", "cccccccccccc"),
      observationsDroppedEntry("om-drop-1", {
        observationIds: ["aaaaaaaaaaaa"],
        coversUpToId: "om-eeeeeeeeeeee",
      }),
      textCustomMessage("raw-4", "dddddddddddddddd"),
    ];

    expect(rawTokensSinceObservationCoverage(entries)).toBe(9); // raw-2 + raw-3 + raw-4
    expect(rawTokensSinceReflectionCoverage(entries)).toBe(7); // raw-3 + raw-4
    expect(rawTokensSinceDropCoverage(entries)).toBe(7); // covers ledger entry om-eeeeeeeeeeee, raw after it
  });

  it("lets coversUpToId point to a memory ledger entry", () => {
    const entries = [
      textCustomMessage("raw-1", "aaaa"),
      reflectionsRecordedEntry("om-eeeeeeeeeeee", {
        reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
        coversUpToId: "raw-1",
      }),
      observationsDroppedEntry("om-drop-1", {
        observationIds: ["aaaaaaaaaaaa"],
        coversUpToId: "om-eeeeeeeeeeee",
      }),
      textCustomMessage("raw-2", "bbbbbbbb"),
    ];

    expect(latestCoverageIndex(entries, V3_OBSERVATIONS_DROPPED)).toBe(1);
    expect(rawTokensSinceDropCoverage(entries)).toBe(2);
  });

  it("chooses the max covered branch position, not merely latest ledger entry order", () => {
    const entries = [
      textCustomMessage("raw-1", "aaaa"),
      textCustomMessage("raw-2", "bbbbbbbb"),
      observationsRecordedEntry("om-aaaaaaaaaaaa", {
        observations: [observation("aaaaaaaaaaaa")],
        coversUpToId: "raw-2",
      }),
      observationsRecordedEntry("om-bbbbbbbbbbbb", {
        observations: [observation("bbbbbbbbbbbb")],
        coversUpToId: "raw-1",
      }),
      textCustomMessage("raw-3", "cccccccccccc"),
    ];

    expect(latestCoverageIndex(entries, V3_OBSERVATIONS_RECORDED)).toBe(1);
    expect(latestCoverageMarkerId(entries, V3_OBSERVATIONS_RECORDED)).toBe(
      "raw-2",
    );
    expect(rawTokensSinceObservationCoverage(entries)).toBe(3);
  });

  it("returns latest inner coverage marker and earlier marker by branch index", () => {
    const entries = [
      textCustomMessage("raw-1", "aaaa"),
      textCustomMessage("raw-2", "bbbbbbbb"),
      textCustomMessage("raw-3", "cccccccccccc"),
      observationsRecordedEntry("om-obs", {
        observations: [observation("aaaaaaaaaaaa")],
        coversUpToId: "raw-3",
      }),
      reflectionsRecordedEntry("om-ref", {
        reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
        coversUpToId: "raw-2",
      }),
    ];

    expect(latestCoverageMarkerId(entries, V3_OBSERVATIONS_RECORDED)).toBe(
      "raw-3",
    );
    expect(latestCoverageMarkerId(entries, V3_REFLECTIONS_RECORDED)).toBe(
      "raw-2",
    );
    expect(earlierCoverageMarkerId(entries, "raw-3", "raw-2")).toBe("raw-2");
    expect(earlierCoverageMarkerId(entries, "raw-1", undefined)).toBe("raw-1");
    expect(earlierCoverageMarkerId(entries, "missing", "raw-2")).toBe("raw-2");
    expect(
      earlierCoverageMarkerId(entries, "missing-a", "missing-b"),
    ).toBeUndefined();
  });

  it("ignores invalid coverage markers and old V2 markers without throwing", () => {
    const entries = [
      textCustomMessage("raw-1", "aaaa"),
      oldV2ObservationEntry("v2-obs"),
      observationsRecordedEntry("om-obs-invalid", {
        observations: [observation("aaaaaaaaaaaa")],
        coversUpToId: "missing",
      }),
      textCustomMessage("raw-2", "bbbbbbbb"),
    ];

    expect(() => rawTokensSinceObservationCoverage(entries)).not.toThrow();
    expect(rawTokensSinceObservationCoverage(entries)).toBe(3);
    expect(latestCoverageIndex(entries, V3_REFLECTIONS_RECORDED)).toBe(-1);
  });

  it("counts raw tokens since the latest Pi compaction without throwing on old memory details", () => {
    const entries = [
      textCustomMessage("raw-1", "aaaa"),
      compactionEntry("cmp-1", { firstKeptEntryId: "raw-1" }),
      oldV2ObservationEntry("v2-obs"),
      textCustomMessage("raw-2", "bbbbbbbb"),
    ];

    expect(rawTokensSinceLastCompaction(entries)).toBe(3); // raw-1 + raw-2 from live tail starting at firstKeptEntryId
  });
});

describe("usage-aware progress helpers (plan-01)", () => {
  function assistantEntry(
    id: string,
    text: string,
    usageTokens: number,
    stopReason = "stop",
  ) {
    return rawEntryWithMessage(id, {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason,
      usage: {
        input: Math.floor(usageTokens / 2),
        output: Math.ceil(usageTokens / 2),
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: usageTokens,
      },
    });
  }

  function rawEntryWithMessage(id: string, message: unknown) {
    return rawMessage(id, "x", { message } as never);
  }

  function userEntry(id: string, text: string) {
    return rawEntryWithMessage(id, {
      role: "user",
      content: [{ type: "text", text }],
    });
  }

  describe("lastValidUsageIndex / firstValidUsageIndex", () => {
    it("finds the last valid usage at or before an index", () => {
      const entries = [
        assistantEntry("a1", "one", 100),
        userEntry("u1", "two"),
        assistantEntry("a2", "three", 200),
        userEntry("u2", "four"),
      ];
      expect(lastValidUsageIndex(entries, 3)).toBe(2);
      expect(lastValidUsageIndex(entries, 1)).toBe(0);
      expect(lastValidUsageIndex(entries, 0)).toBe(0);
    });

    it("skips error and aborted assistant messages", () => {
      const entries = [
        assistantEntry("a1", "one", 100),
        assistantEntry("a2", "two", 200, "error"),
        assistantEntry("a3", "three", 300, "aborted"),
      ];
      expect(lastValidUsageIndex(entries, 2)).toBe(0);
      expect(firstValidUsageIndex(entries, 0)).toBe(0);
      expect(firstValidUsageIndex(entries, 1)).toBe(-1);
    });

    it("returns -1 when nothing is usable", () => {
      const entries = [userEntry("u1", "one"), userEntry("u2", "two")];
      expect(lastValidUsageIndex(entries, 1)).toBe(-1);
      expect(firstValidUsageIndex(entries, 0)).toBe(-1);
      expect(lastValidUsageIndex([], -1)).toBe(-1);
    });
  });

  describe("realContextTokens", () => {
    it("sums the last valid usage plus trailing estimate when no compaction", () => {
      const entries = [
        userEntry("u1", "aaaa"), // 1 token, before usage
        assistantEntry("a1", "one", 100),
        userEntry("u2", "bbbbbbbb"), // 2 tokens after usage
      ];
      expect(realContextTokens(entries)).toBe(102);
    });

    it("anchors strictly after the latest compaction entry", () => {
      const entries = [
        assistantEntry("a-pre", "pre", 999), // pre-compaction usage ignored
        compactionEntry("cmp-1", { firstKeptEntryId: "a-pre" }),
        userEntry("u1", "aaaa"),
        assistantEntry("a-post", "post", 50),
        userEntry("u2", "bbbbbbbb"),
      ];
      expect(realContextTokens(entries)).toBe(52);
    });

    it("returns undefined with a compaction and no post-compaction assistant", () => {
      const entries = [
        assistantEntry("a-pre", "pre", 999),
        compactionEntry("cmp-1", { firstKeptEntryId: "a-pre" }),
        userEntry("u1", "after"),
      ];
      expect(realContextTokens(entries)).toBeUndefined();
    });

    it("returns undefined when only error/aborted assistant usage exists", () => {
      const entries = [
        assistantEntry("a1", "boom", 100, "error"),
        assistantEntry("a2", "cut", 200, "aborted"),
      ];
      expect(realContextTokens(entries)).toBeUndefined();
    });

    it("returns undefined when no usage exists anywhere", () => {
      const entries = [userEntry("u1", "one"), userEntry("u2", "two")];
      expect(realContextTokens(entries)).toBeUndefined();
    });
  });

  describe("realTokensAtAnchor", () => {
    it("uses the last valid usage at or before the anchor", () => {
      const entries = [
        assistantEntry("a1", "one", 100),
        userEntry("u1", "two"),
        assistantEntry("a2", "three", 200),
      ];
      expect(realTokensAtAnchor(entries, 1)).toBe(100);
      expect(realTokensAtAnchor(entries, 2)).toBe(200);
    });

    it("returns undefined when no usage at or before the anchor", () => {
      const entries = [
        userEntry("u1", "one"),
        assistantEntry("a1", "two", 100),
      ];
      expect(realTokensAtAnchor(entries, 0)).toBeUndefined();
    });
  });

  describe("realTokensSinceAnchor", () => {
    it("measures a usage delta from a coverage anchor after the compaction", () => {
      const entries = [
        assistantEntry("a-pre", "pre", 900),
        compactionEntry("cmp-1", { firstKeptEntryId: "a-pre" }),
        assistantEntry("a-anchor", "anchor", 100),
        userEntry("u1", "bbbbbbbb"),
        assistantEntry("a-later", "later", 260),
      ];
      // current = 260; anchor at a-anchor (index 2, after compaction) → baseline 100 → delta 160
      expect(realTokensSinceAnchor(entries, 2)).toBe(160);
    });

    it("baselines at the first usage strictly after the compaction when the anchor predates it", () => {
      const entries = [
        assistantEntry("a-anchor", "anchor", 100),
        assistantEntry("a-pre", "pre", 900),
        compactionEntry("cmp-1", { firstKeptEntryId: "a-pre" }),
        assistantEntry("a-post", "post", 200),
        userEntry("u1", "bbbbbbbb"),
        assistantEntry("a-later", "later", 300),
      ];
      // anchor (index 0) predates compaction (index 2) → baseline = 200 (first usage after compaction)
      expect(realTokensSinceAnchor(entries, 0)).toBe(100);
    });

    it("returns undefined on a negative delta", () => {
      const entries = [
        assistantEntry("a1", "one", 300),
        assistantEntry("a2", "two", 100),
      ];
      expect(realTokensSinceAnchor(entries, 0)).toBeUndefined();
    });

    it("returns 0 delta for no anchor and no compaction", () => {
      const entries = [
        assistantEntry("a1", "one", 100),
        userEntry("u1", "bbbbbbbb"),
      ];
      expect(realTokensSinceAnchor(entries, -1)).toBe(0);
    });

    it("returns undefined when real context is unmeasurable", () => {
      const entries = [userEntry("u1", "one")];
      expect(realTokensSinceAnchor(entries, -1)).toBeUndefined();
    });
  });

  describe("measureSinceAnchor", () => {
    it("reports usage basis when a usage delta is measurable", () => {
      const entries = [
        assistantEntry("a1", "one", 100),
        userEntry("u1", "bbbbbbbb"),
        assistantEntry("a2", "two", 150),
      ];
      expect(measureSinceAnchor(entries, 0)).toEqual({
        tokens: 50,
        basis: "usage",
      });
    });

    it("falls back to the estimate basis equal to rawTokensAfterIndex", () => {
      const entries = [userEntry("u1", "one"), userEntry("u2", "bbbbbbbb")];
      expect(measureSinceAnchor(entries, 0)).toEqual({
        tokens: rawTokensAfterIndex(entries, 0),
        basis: "estimate",
      });
      expect(measureSinceAnchor(entries, 0).tokens).toBe(2); // only u2 counts after index 0
    });
  });
});
