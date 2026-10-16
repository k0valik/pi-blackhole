import { describe, expect, test } from "vitest";
import { buildOwnCut } from "../src/hooks/before-compact.js";
import {
  observation,
  observationsRecordedEntry,
  rawMessage,
  compactionEntry,
} from "./fixtures/session.js";

const covered = (id = "m2") =>
  observationsRecordedEntry("om1", {
    coversUpToId: id,
    observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["m1", "m2"] })],
  });
const history = () => [
  rawMessage("m1", "old request"),
  rawMessage("m2", "old answer", { message: { role: "assistant", content: "old answer" } }),
  rawMessage("m3", "pending request"),
  rawMessage("m4", "pending answer", { message: { role: "assistant", content: "pending answer" } }),
  rawMessage("m5", "latest request"),
];

describe("unobserved tail", () => {
  test("cuts only completed OM coverage, not Pi's later cut", () => {
    expect(buildOwnCut([...history(), covered()], "m5", "unobserved")).toMatchObject({
      ok: true,
      firstKeptEntryId: "m3",
      selectedIds: ["m1", "m2"],
    });
  });
  test.each([undefined, "missing", "om1"])(
    "without a valid source coverage anchor (%s), retains all originals",
    (id) => {
      const entries = history();
      if (id) entries.push(covered(id));
      expect(buildOwnCut(entries, "m5", "unobserved")).toMatchObject({
        ok: true,
        firstKeptEntryId: "m1",
        selectedIds: [],
      });
    },
  );
  test("compaction never advances observation coverage", () => {
    expect(
      buildOwnCut(
        [
          ...history(),
          compactionEntry("c1", { firstKeptEntryId: "m5" }),
          compactionEntry("c2", { firstKeptEntryId: "m5" }),
        ],
        "m5",
        "unobserved",
      ),
    ).toMatchObject({ ok: true, firstKeptEntryId: "m1", selectedIds: [] });
  });
  test("backs up to user turn rather than splitting tool call/result", () => {
    const entries = history();
    entries[1] = rawMessage("m2", "", {
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call1", name: "read", arguments: {} }],
      },
    });
    entries[2] = rawMessage("m3", "", {
      message: {
        role: "toolResult",
        toolCallId: "call1",
        toolName: "read",
        content: [{ type: "text", text: "result" }],
      },
    });
    expect(buildOwnCut([...entries, covered()], "m5", "unobserved")).toMatchObject({
      ok: true,
      firstKeptEntryId: "m1",
      selectedIds: [],
    });
  });
  test("unanchored facts do not count as completed coverage", () => {
    const marker = covered();
    marker.customType = "om.observations.unanchored";
    expect(buildOwnCut([...history(), marker], "m5", "unobserved")).toMatchObject({
      ok: true,
      firstKeptEntryId: "m1",
    });
  });
  test("empty history cancels", () => {
    expect(buildOwnCut([], undefined, "unobserved")).toEqual({
      ok: false,
      reason: "no_live_messages",
    });
  });
});

test("disconnected completed batch cannot skip an earlier unobserved source", () => {
  const marker = observationsRecordedEntry("om1", {
    coversUpToId: "m4",
    observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["m3", "m4"] })],
  });
  expect(buildOwnCut([...history(), marker], "m5", "unobserved")).toMatchObject({
    firstKeptEntryId: "m1",
    selectedIds: [],
  });
});
test("pending custom source before first message stays in the raw suffix", () => {
  const entries = [
    { id: "custom1", type: "custom_message", content: "pending original", customType: "test" },
    ...history(),
  ];
  expect(buildOwnCut(entries, "m5", "unobserved")).toMatchObject({
    firstKeptEntryId: "custom1",
    selectedIds: [],
  });
});

test("a user message inside an unfinished tool interaction is not a safe cut", () => {
  const entries = [
    rawMessage("m1", "start"),
    rawMessage("m2", "", {
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t", name: "read", arguments: {} }],
      },
    }),
    rawMessage("m3", "interruption"),
    rawMessage("m4", "", {
      message: {
        role: "toolResult",
        toolCallId: "t",
        toolName: "read",
        content: [{ type: "text", text: "result" }],
      },
    }),
    covered(),
  ];
  expect(buildOwnCut(entries, "m3", "unobserved")).toMatchObject({
    firstKeptEntryId: "m1",
    selectedIds: [],
  });
});
