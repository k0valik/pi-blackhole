/**
 * Observer-side exclusion of `custom_message` entries.
 *
 * Extensions inject recalled memories, rosters, reminders, and one-shot results
 * as `custom_message` entries aimed at the main session model. The OM observer
 * must not treat them as branch conversation: they are either static context
 * repeated between turns or already-stored memory, so observing them re-extracts
 * stored content into new observations (a feedback loop for memory extensions)
 * and spends observer tokens on text that is not conversation.
 *
 * The exclusion is applied at the source-entry definition, BEFORE accounting:
 * token estimation runs on the already-cut data, so no estimator changes and
 * coverage advancement treats excluded entries as never delivered.
 *
 * Deliberately NOT excluded:
 * - recall rendering (searching history still surfaces raw custom messages)
 * - the compaction tail anchor in before-compact (provider-conversation semantic)
 * - estimateEntryTokens pricing of custom_message content (real provider context)
 */
import { describe, expect, test } from "vitest";

import {
  isDeliveredSourceEntry,
  renderRecallSourceEntry,
  serializeBranchEntries,
  serializeSourceAddressedBranchEntries,
} from "../src/om/serialize.js";
import {
  isSourceEntry,
  latestCoverageIndex,
  rawTokensAfterIndex,
  rawTokensSinceObservationCoverage,
} from "../src/om/ledger/progress.js";
import { estimateEntryTokens } from "../src/om/tokens.js";
import { observedPrefixIndex } from "../src/core/observation-boundary.js";
import { selectPressureTail } from "../src/core/context-pressure.js";
import { OM_OBSERVATIONS_RECORDED, type Entry } from "../src/om/ledger/types.js";
import {
  branchSummary,
  compactionEntry,
  customMessage,
  observationsRecordedEntry,
  observation,
  rawMessage,
} from "./fixtures/session.js";

const injection = (id: string, text = "recalled memory " + "x".repeat(400)) =>
  customMessage(id, text, { customType: "hindsight-memory" });

describe("source-entry definition (observer input membership)", () => {
  test("custom_message entries are not observer source entries", () => {
    expect(isSourceEntry(injection("inj-1"))).toBe(false);
  });

  test("messages and branch summaries remain observer source entries", () => {
    expect(isSourceEntry(rawMessage("m-1", "conversation"))).toBe(true);
    expect(isSourceEntry(branchSummary("bs-1", "summary text"))).toBe(true);
  });

  test("ledger and compaction entries remain non-source", () => {
    expect(isSourceEntry(compactionEntry("cmp-1"))).toBe(false);
    expect(
      isSourceEntry(
        observationsRecordedEntry("om-1", {
          observations: [observation("aaaaaaaaaaaa")],
          coversUpToId: "m-1",
        }),
      ),
    ).toBe(false);
  });
});

describe("observer serialization", () => {
  test("serializeBranchEntries renders messages and branch summaries only", () => {
    const text = serializeBranchEntries([
      rawMessage("m-1", "user turn"),
      injection("inj-1"),
      branchSummary("bs-1", "summary"),
    ] as never);
    expect(text).toContain("[User @");
    expect(text).toContain("user turn");
    expect(text).toContain("[Branch summary @");
    expect(text).toContain("summary");
    expect(text).not.toContain("recalled memory");
    expect(text).not.toContain("Custom");
  });

  test("a branch of only custom messages serializes empty", () => {
    expect(serializeBranchEntries([injection("inj-1"), injection("inj-2")] as never)).toBe("");
  });

  test("isDeliveredSourceEntry rejects custom messages", () => {
    expect(isDeliveredSourceEntry(injection("inj-1"))).toBe(false);
  });

  test("custom messages are absent from the source-addressed chunk and its metadata", () => {
    const result = serializeSourceAddressedBranchEntries([
      rawMessage("m-1", "first turn"),
      injection("inj-1"),
      branchSummary("bs-1", "summary"),
      injection("inj-2"),
    ] as never);
    expect(result.text).toContain("first turn");
    expect(result.text).toContain("summary");
    expect(result.text).not.toContain("recalled memory");
    expect(result.sourceEntryIds).toEqual(["m-1", "bs-1"]);
    expect(Object.keys(result.sourceEntryTimestamps).sort()).toEqual(["bs-1", "m-1"]);
  });

  test("coverage cannot claim a trailing custom message", () => {
    // An injection appended after the last real message must not become the
    // coverage tip — the observer was never shown it, and coverage advancing
    // past it would strand nothing (it is unobservable by design), but the tip
    // must still be the last delivered conversation entry.
    const result = serializeSourceAddressedBranchEntries([
      rawMessage("m-1", "turn"),
      injection("inj-1"),
    ] as never);
    expect(result.sourceEntryIds).toEqual(["m-1"]);
  });
});

describe("trigger accounting on the cut data", () => {
  test("rawTokensAfterIndex excludes custom message weight", () => {
    const entries = [
      rawMessage("m-1", "x".repeat(200)),
      injection("inj-1"), // 100+ tokens of injection weight
      branchSummary("bs-1", "y".repeat(400)), // exactly 100 tokens
    ] as never as Entry[];
    // Only bs-1 sits after index 0 once the injection is cut.
    expect(rawTokensAfterIndex(entries, 0)).toBe(100);
  });

  test("observation coverage accounting ignores injected memory between turns", () => {
    const entries = [
      rawMessage("m-1", "covered turn"),
      observationsRecordedEntry("om-1", {
        observations: [observation("aaaaaaaaaaaa")],
        coversUpToId: "m-1",
      }),
      rawMessage("m-2", "y".repeat(400)),
      injection("inj-1"), // 100+ tokens
      rawMessage("m-3", "z".repeat(400)),
    ] as never as Entry[];
    expect(latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED)).toBe(0);
    // m-2 and m-3 only — the injection costs zero source tokens.
    expect(rawTokensSinceObservationCoverage(entries)).toBe(200);
  });
});

describe("pricing contract (real provider context)", () => {
  test("estimateEntryTokens still prices custom message content", () => {
    // Custom messages enter real provider context; the pressure tail pricing
    // walks ALL entries, so the estimator must keep counting them even though
    // the observer no longer does.
    expect(estimateEntryTokens({ type: "custom_message", content: "x".repeat(400) })).toBe(100);
  });
});

describe("legacy coverage anchors", () => {
  test("a marker anchored at a custom message no longer validates", () => {
    // Pre-change sessions could anchor coversUpToId at a custom_message. Those
    // anchors fail source validation, so the boundary lands earlier and the
    // prefix is re-observed once (accepted upgrade cost).
    const entries = [
      rawMessage("m-1", "covered turn"),
      injection("inj-1"),
      {
        type: "custom",
        id: "legacy-recorded",
        customType: OM_OBSERVATIONS_RECORDED,
        data: {
          observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["m-1"] })],
          coversFromId: "m-1",
          coversUpToId: "inj-1",
        },
      },
    ] as never as Entry[];
    expect(observedPrefixIndex(entries)).toBe(-1);
  });

  test("a marker anchored at a message still validates", () => {
    const entries = [
      rawMessage("m-1", "covered turn"),
      injection("inj-1"),
      rawMessage("m-2", "next turn"),
      observationsRecordedEntry("recorded", {
        observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["m-1", "m-2"] })],
        coversFromId: "m-1",
        coversUpToId: "m-2",
      }),
    ] as never as Entry[];
    expect(observedPrefixIndex(entries)).toBe(2);
  });
});

describe("recall keeps rendering custom messages", () => {
  test("renderRecallSourceEntry still renders injected memory with its type", () => {
    const rendered = renderRecallSourceEntry(injection("inj-1", "stored memory") as never);
    expect(rendered).toContain("stored memory");
    expect(rendered).toContain("hindsight-memory");
  });
});

describe("pressure bridging", () => {
  const base = {
    firstKeptEntryId: "m1",
    contextWindow: 500,
    reserveTokens: 100,
    keepRecentTokens: 100,
    summaryTokens: () => 10,
  };

  test("an injected custom message in the bridged range no longer blocks", () => {
    expect(
      selectPressureTail({
        entries: [
          rawMessage("m1", "old".repeat(1000)),
          injection("inj-1"),
          rawMessage("m3", "recent"),
        ] as never,
        ...base,
      }),
    ).toEqual({ ok: true, firstKeptEntryId: "m3", bridgedIds: ["m1"] });
  });

  test("a branch summary in the bridged range still blocks", () => {
    expect(
      selectPressureTail({
        entries: [
          rawMessage("m1", "old".repeat(1000)),
          branchSummary("bs-1", "compacted summary"),
          rawMessage("m3", "recent"),
        ] as never,
        ...base,
      }),
    ).toEqual({ ok: false, reason: "no_safe_fit" });
  });
});
