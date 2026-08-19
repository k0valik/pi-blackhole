import { describe, expect, it } from "vitest";
import {
  SOURCE_OMISSION_MARKER,
  renderRecallSourceEntries,
  serializeBranchEntries,
  serializeSourceAddressedBranchEntries,
} from "../src/om/serialize.js";
import {
  branchSummary,
  customMessage,
  rawMessage,
} from "./fixtures/session.js";

describe("serializeSourceAddressedBranchEntries", () => {
  it("serializes renderable source entries oldest-first", () => {
    const entries = [
      rawMessage("m1", "first"),
      rawMessage("m2", "second"),
      customMessage("c1", "custom text"),
      branchSummary("b1", "summary text"),
    ];
    const result = serializeSourceAddressedBranchEntries(entries);
    expect(result.sourceEntryIds).toEqual(["m1", "m2", "c1", "b1"]);
    expect(result.text).toContain("[Source entry id: m1]");
    expect(result.text).toContain("[Source entry id: b1]");
    expect(result.estimatedTokens).toBeGreaterThan(0);
    expect(result.truncatedSourceEntryIds).toEqual([]);
  });

  it("skips non-source and empty-rendered entries", () => {
    const entries = [
      {
        type: "custom",
        id: "skip-me",
        parentId: null,
        timestamp: "2026-05-02T10:00:00.000Z",
        customType: "om.observations.recorded",
        data: { coversUpToId: "m1" },
      },
      rawMessage("m-empty", "", {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "" }],
        },
      }),
      rawMessage("m1", "kept"),
    ];
    const result = serializeSourceAddressedBranchEntries(entries);
    expect(result.sourceEntryIds).toEqual(["m1"]);
    expect(result.text).not.toContain("skip-me");
  });

  it("stops the oldest-first walk once maxTokens is exhausted", () => {
    const entries = [
      rawMessage("m1", "x".repeat(400)), // ~100 tokens
      rawMessage("m2", "y".repeat(400)),
      rawMessage("m3", "z".repeat(400)),
    ];
    const result = serializeSourceAddressedBranchEntries(entries, {
      maxTokens: 110,
    });
    expect(result.sourceEntryIds).toEqual(["m1"]);
    expect(result.text).toContain("m1");
    expect(result.text).not.toContain("m2");
    expect(result.estimatedTokens).toBeLessThanOrEqual(110);
  });

  it("excerpts a first entry that alone exceeds maxTokens", () => {
    const entries = [rawMessage("big", "b".repeat(20_000))];
    const result = serializeSourceAddressedBranchEntries(entries, {
      maxTokens: 300,
    });
    expect(result.sourceEntryIds).toEqual(["big"]);
    expect(result.truncatedSourceEntryIds).toEqual(["big"]);
    expect(result.text).toContain(SOURCE_OMISSION_MARKER);
    expect(result.text).toContain("[Source entry id: big]");
    expect(result.estimatedTokens).toBeLessThanOrEqual(300);
    // Head and tail are both present
    const text = result.text;
    expect(text.slice(0, 100)).toContain("bbbb");
    expect(text.slice(-100)).toContain("bbbb");
  });

  it("returns an empty serialization when fixed parts alone exceed maxTokens", () => {
    const entries = [rawMessage("big", "b".repeat(20_000))];
    const result = serializeSourceAddressedBranchEntries(entries, {
      maxTokens: 1,
    });
    expect(result.text).toBe("");
    expect(result.sourceEntryIds).toEqual([]);
    expect(result.estimatedTokens).toBe(0);
  });
});

describe("chunk content trimming", () => {
  function toolResultEntry(id: string, text: string) {
    return rawMessage(id, "", {
      message: {
        role: "toolResult",
        toolName: "read_file",
        content: [{ type: "text", text }],
      },
    });
  }

  function thinkingEntry(id: string, thinking: string) {
    return rawMessage(id, "", {
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking }],
      },
    });
  }

  it("trims oversized tool-result text blocks when trim is enabled", () => {
    const long = "t".repeat(5_000);
    const entry = toolResultEntry("m1", long);
    const trimmed = serializeBranchEntries([entry], { trim: true });
    expect(trimmed).not.toContain("t".repeat(5_000));
    expect(trimmed).toContain("t".repeat(1_000));
    expect(trimmed).toContain("omitted");
    const untrimmed = serializeBranchEntries([entry]);
    expect(untrimmed).toContain("t".repeat(5_000));
  });

  it("trims oversized thinking blocks to 20%/20% when trim is enabled", () => {
    const entry = thinkingEntry("m1", "k".repeat(5_000));
    const trimmed = serializeBranchEntries([entry], { trim: true });
    expect(trimmed).not.toContain("k".repeat(5_000));
    expect(trimmed).toContain("k".repeat(1_000)); // ceil(5000 * 0.2)
    expect(trimmed).toContain("omitted");
  });

  it("caps the thinking head at 4000 chars", () => {
    const entry = thinkingEntry("m1", "k".repeat(30_000));
    const trimmed = serializeBranchEntries([entry], { trim: true });
    const beforeOmission = trimmed.slice(0, trimmed.indexOf("omitted"));
    expect(beforeOmission).toContain("k".repeat(4_000));
    expect(beforeOmission).not.toContain("k".repeat(4_001));
  });

  it("keeps small blocks untouched", () => {
    const entry = toolResultEntry("m1", "short result");
    expect(serializeBranchEntries([entry], { trim: true })).toContain(
      "short result",
    );
  });

  it("applies trimming inside source-addressed chunks", () => {
    const entries = [toolResultEntry("m1", "t".repeat(5_000))];
    const result = serializeSourceAddressedBranchEntries(entries, {
      trim: true,
    });
    expect(result.text).toContain("omitted");
  });

  it("leaves the recall path untrimmed", () => {
    const long = "r".repeat(5_000);
    const entry = toolResultEntry("m1", long);
    const recalled = renderRecallSourceEntries([entry]);
    expect(recalled).toContain("r".repeat(5_000));
  });
});
