import { expect, test } from "vitest";
import { selectPressureTail } from "../src/core/context-pressure.js";
import { rawMessage } from "./fixtures/session.js";
const entries = [
  rawMessage("m1", "old".repeat(1000)),
  rawMessage("m2", "middle".repeat(1000)),
  rawMessage("m3", "recent"),
];

test("fitting preferred context is unchanged", () => {
  expect(
    selectPressureTail({
      entries,
      firstKeptEntryId: "m1",
      contextWindow: 10000,
      reserveTokens: 100,
      keepRecentTokens: 100,
      summaryTokens: () => 10,
    }),
  ).toEqual({ ok: true, firstKeptEntryId: "m1", bridgedIds: [] });
});
test("bridges enough old retained tail and bounds recent raw suffix", () => {
  expect(
    selectPressureTail({
      entries,
      firstKeptEntryId: "m1",
      contextWindow: 500,
      reserveTokens: 100,
      keepRecentTokens: 100,
      summaryTokens: () => 10,
    }),
  ).toEqual({ ok: true, firstKeptEntryId: "m3", bridgedIds: ["m1", "m2"] });
});
test("defers when latest user turn alone cannot fit", () => {
  expect(
    selectPressureTail({
      entries: [rawMessage("m1", "huge".repeat(1000))],
      firstKeptEntryId: "m1",
      contextWindow: 500,
      reserveTokens: 100,
      keepRecentTokens: 100,
      summaryTokens: () => 10,
    }),
  ).toMatchObject({ ok: false });
});
test.each([undefined, 0, NaN])("unknown or invalid capacity defers (%s)", (contextWindow) => {
  expect(
    selectPressureTail({
      entries,
      firstKeptEntryId: "m1",
      contextWindow,
      reserveTokens: 100,
      keepRecentTokens: 100,
      summaryTokens: () => 10,
    }),
  ).toMatchObject({ ok: false });
});
test("summary costs are included for each candidate", () => {
  expect(
    selectPressureTail({
      entries,
      firstKeptEntryId: "m1",
      contextWindow: 500,
      reserveTokens: 100,
      keepRecentTokens: 100,
      summaryTokens: () => 1000,
    }),
  ).toMatchObject({ ok: false });
});
test("does not split an oversized tool interaction", () => {
  const toolEntries = [
    rawMessage("m1", "request"),
    rawMessage("m2", "", {
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t", name: "read", arguments: {} }],
      },
    }),
    rawMessage("m3", "", {
      message: {
        role: "toolResult",
        toolCallId: "t",
        toolName: "read",
        content: [{ type: "text", text: "x".repeat(10000) }],
      },
    }),
  ];
  expect(
    selectPressureTail({
      entries: toolEntries,
      firstKeptEntryId: "m1",
      contextWindow: 500,
      reserveTokens: 100,
      keepRecentTokens: 100,
      summaryTokens: () => 10,
    }),
  ).toMatchObject({ ok: false });
});

test("invalid retained anchor defers", () => {
  expect(
    selectPressureTail({
      entries,
      firstKeptEntryId: "missing",
      contextWindow: 10000,
      reserveTokens: 100,
      keepRecentTokens: 100,
      summaryTokens: () => 10,
    }),
  ).toEqual({ ok: false, reason: "invalid_anchor" });
});
test("non-message sources cannot silently disappear into a message-only VCC bridge", () => {
  expect(
    selectPressureTail({
      entries: [
        entries[0],
        { type: "custom_message", id: "custom1", content: "original" },
        ...entries.slice(1),
      ],
      firstKeptEntryId: "m1",
      contextWindow: 500,
      reserveTokens: 100,
      keepRecentTokens: 100,
      summaryTokens: () => 10,
    }),
  ).toEqual({ ok: false, reason: "no_safe_fit" });
});
test("compact-all preferred cut fits only when its summary fits", () => {
  expect(
    selectPressureTail({
      entries,
      firstKeptEntryId: "",
      contextWindow: 500,
      reserveTokens: 100,
      keepRecentTokens: 100,
      summaryTokens: () => 10,
    }),
  ).toEqual({ ok: true, firstKeptEntryId: "", bridgedIds: [] });
});

test("cannot split a tool interaction spanning a user interruption", () => {
  const entries = [
    rawMessage("m1", "start".repeat(1000)),
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
  ];
  expect(
    selectPressureTail({
      entries,
      firstKeptEntryId: "m1",
      contextWindow: 500,
      reserveTokens: 100,
      keepRecentTokens: 100,
      summaryTokens: () => 10,
    }),
  ).toMatchObject({ ok: false });
});
