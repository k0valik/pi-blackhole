import { describe, expect, test } from "vitest";
import {
  isDeliveredSourceEntry,
  serializeSourceAddressedBranchEntries,
} from "../src/om/serialize.js";
import { branchSummary, customMessage, rawMessage } from "./fixtures/session.js";

describe("isDeliveredSourceEntry", () => {
  test("rejects a renderable source without an id", () => {
    expect(
      isDeliveredSourceEntry({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "no address" }] },
      } as never),
    ).toBe(false);
  });

  test("rejects an empty id", () => {
    expect(isDeliveredSourceEntry(rawMessage("", "no address"))).toBe(false);
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

  test("rejects a delivered custom message (observer input excludes injections)", () => {
    expect(isDeliveredSourceEntry(customMessage("custom", "visible text"))).toBe(false);
  });

  test("accepts a delivered branch summary", () => {
    expect(isDeliveredSourceEntry(branchSummary("summary", "visible summary"))).toBe(true);
  });
});

describe("serializeSourceAddressedBranchEntries", () => {
  test("preserves exact text and source metadata while omitting undelivered and excluded entries", () => {
    expect(
      serializeSourceAddressedBranchEntries([
        { type: "custom_message", content: "no id" },
        { type: "custom", id: "ledger" },
        customMessage("custom", "injected text", { timestamp: "invalid" }),
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
        branchSummary("summary", "branch text", { timestamp: "invalid" }),
      ]),
    ).toEqual({
      text: [
        "[Source entry id: message]\n[User @ ????-??-?? ??:??]: visible text",
        "[Source entry id: summary]\n[Branch summary @ ????-??-?? ??:??]: branch text",
      ].join("\n\n"),
      sourceEntryIds: ["message", "summary"],
      sourceEntryTimestamps: {
        message: "????-??-?? ??:??",
        summary: "????-??-?? ??:??",
      },
    });
  });
});
