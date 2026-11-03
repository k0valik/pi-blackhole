import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";

import { observedPrefixIndex } from "../src/core/observation-boundary.js";
import { latestCoverageIndex } from "../src/om/ledger/progress.js";
import { OM_OBSERVATIONS_RECORDED, type Entry } from "../src/om/ledger/types.js";
import { observation, rawMessage } from "./fixtures/session.js";

const abortedAssistant: AssistantMessage = {
  role: "assistant",
  content: [],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "aborted",
  timestamp: Date.parse("2026-05-02T10:00:00.000Z"),
};

const undeliveredMessages: Array<{ name: string; message: AssistantMessage }> = [
  { name: "an aborted empty assistant message", message: abortedAssistant },
  {
    name: "a redacted-thinking-only assistant message",
    message: {
      ...abortedAssistant,
      content: [{ type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true }],
      stopReason: "stop",
    },
  },
];

describe("persisted observer delivery coverage", () => {
  test.each(undeliveredMessages)("a ranged batch advances past $name", ({ message }) => {
    const entries: Entry[] = [
      rawMessage("covered", "previously delivered context"),
      {
        type: "custom",
        id: "previous-coverage",
        customType: "om.observations.coverage",
        data: { coversFromId: "covered", coversUpToId: "covered" },
      },
      rawMessage("skipped", "", { message }),
      rawMessage("fact", "the next delivered fact"),
      {
        type: "custom",
        id: "recorded",
        customType: OM_OBSERVATIONS_RECORDED,
        data: {
          observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["fact"] })],
          coversFromId: "fact",
          coversUpToId: "fact",
        },
      },
    ];

    expect(observedPrefixIndex(entries)).toBe(3);
  });

  test("a coverage-only range advances past an undelivered source", () => {
    const entries: Entry[] = [
      rawMessage("skipped", "", { message: abortedAssistant }),
      rawMessage("routine", "nothing worth retaining"),
      {
        type: "custom",
        id: "empty-coverage",
        customType: "om.observations.coverage",
        data: { coversFromId: "routine", coversUpToId: "routine" },
      },
    ];

    expect(observedPrefixIndex(entries)).toBe(1);
  });

  test("a ranged batch cannot skip a deliverable source after an undelivered one", () => {
    const entries: Entry[] = [
      rawMessage("skipped", "", { message: abortedAssistant }),
      rawMessage("unobserved", "must still be delivered"),
      rawMessage("fact", "a later fact"),
      {
        type: "custom",
        id: "recorded",
        customType: OM_OBSERVATIONS_RECORDED,
        data: {
          observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["fact"] })],
          coversFromId: "fact",
          coversUpToId: "fact",
        },
      },
    ];

    expect(observedPrefixIndex(entries)).toBe(-1);
  });

  test("a legacy head citation advances past an undelivered source", () => {
    const entries: Entry[] = [
      rawMessage("skipped", "", { message: abortedAssistant }),
      rawMessage("fact", "the first delivered fact"),
      {
        type: "custom",
        id: "legacy-recorded",
        customType: OM_OBSERVATIONS_RECORDED,
        data: {
          observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["fact"] })],
          coversUpToId: "fact",
        },
      },
    ];

    expect(observedPrefixIndex(entries)).toBe(1);
  });

  test("a complete range advances even when the observation cites only a later routine source", () => {
    const entries: Entry[] = [
      rawMessage("routine", "routine context delivered to observer"),
      rawMessage("fact", "the fact worth retaining"),
      {
        type: "custom",
        id: "recorded",
        customType: OM_OBSERVATIONS_RECORDED,
        data: {
          observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["fact"] })],
          coversFromId: "routine",
          coversUpToId: "fact",
        },
      },
    ];

    expect(observedPrefixIndex(entries)).toBe(1);
  });

  test("a successfully delivered empty chunk persists a coverage-only range", () => {
    const entries: Entry[] = [
      rawMessage("routine", "nothing new in this delivered source"),
      {
        type: "custom",
        id: "empty-coverage",
        customType: "om.observations.coverage",
        data: { coversFromId: "routine", coversUpToId: "routine" },
      },
    ];

    expect(observedPrefixIndex(entries)).toBe(0);
    expect(latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED)).toBe(0);
  });

  test("legacy markers without a delivered range still require a head citation", () => {
    const entries: Entry[] = [
      rawMessage("routine", "routine context delivered to observer"),
      rawMessage("fact", "the fact worth retaining"),
      {
        type: "custom",
        id: "legacy-recorded",
        customType: OM_OBSERVATIONS_RECORDED,
        data: {
          observations: [observation("bbbbbbbbbbbb", { sourceEntryIds: ["fact"] })],
          coversUpToId: "fact",
        },
      },
    ];

    expect(observedPrefixIndex(entries)).toBe(-1);
  });
});
