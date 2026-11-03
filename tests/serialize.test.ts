import { describe, expect, test } from "vitest";
import {
  isDeliveredSourceEntry,
  serializeSourceAddressedBranchEntries,
} from "../src/om/serialize.js";
import { branchSummary, customMessage, rawMessage } from "./fixtures/session.js";

describe("isDeliveredSourceEntry", () => {
  test("rejects a renderable source without an id", () => {
    expect(isDeliveredSourceEntry({ type: "custom_message", content: "no address" })).toBe(false);
  });

  test("rejects an empty id", () => {
    expect(isDeliveredSourceEntry(customMessage("", "no address"))).toBe(false);
  });

  test("rejects a non-source entry", () => {
    expect(isDeliveredSourceEntry({ type: "custom", id: "ledger" })).toBe(false);
  });

  test("rejects an assistant entry that renders empty", () => {
    expect(
      isDeliveredSourceEntry(
        rawMessage("empty", "", { message: { role: "assistant", content: [] } }),
      ),
    ).toBe(false);
  });

  test("rejects an assistant entry containing only redacted thinking", () => {
    expect(
      isDeliveredSourceEntry(
        rawMessage("redacted", "", {
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true },
            ],
          },
        }),
      ),
    ).toBe(false);
  });

  test("accepts a delivered message", () => {
    expect(isDeliveredSourceEntry(rawMessage("message", "visible text"))).toBe(true);
  });

  test("accepts a delivered custom message", () => {
    expect(isDeliveredSourceEntry(customMessage("custom", "visible text"))).toBe(true);
  });

  test("accepts a delivered branch summary", () => {
    expect(isDeliveredSourceEntry(branchSummary("summary", "visible summary"))).toBe(true);
  });
});

describe("serializeSourceAddressedBranchEntries", () => {
  test("preserves exact text and source metadata while omitting undelivered entries", () => {
    expect(
      serializeSourceAddressedBranchEntries([
        { type: "custom_message", content: "no id" },
        { type: "custom", id: "ledger" },
        rawMessage("empty", "", { message: { role: "assistant", content: [] } }),
        rawMessage("redacted", "", {
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true },
            ],
          },
        }),
        rawMessage("message", "visible text"),
        customMessage("custom", "custom text", { timestamp: "invalid" }),
        branchSummary("summary", "branch text", { timestamp: "invalid" }),
      ]),
    ).toEqual({
      text: [
        "[Source entry id: message]\n[User @ ????-??-?? ??:??]: visible text",
        "[Source entry id: custom]\n[Custom @ ????-??-?? ??:??]: custom text",
        "[Source entry id: summary]\n[Branch summary @ ????-??-?? ??:??]: branch text",
      ].join("\n\n"),
      sourceEntryIds: ["message", "custom", "summary"],
      sourceEntryTimestamps: {
        message: "????-??-?? ??:??",
        custom: "????-??-?? ??:??",
        summary: "????-??-?? ??:??",
      },
    });
  });
});
