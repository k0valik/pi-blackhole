import { describe, it, expect } from "vitest";
import { compile } from "../src/core/summarize.js";
import { userMsg, assistantText, assistantWithToolCall } from "./vcc-fixtures.js";

describe("compile", () => {
  it("returns empty string for no messages", () => {
    expect(compile({ messages: [] })).toBe("");
  });

  it("produces hybrid output with header + brief transcript", () => {
    const r = compile({
      messages: [
        userMsg("Fix login bug"),
        assistantWithToolCall("Read", { path: "auth.ts" }),
        assistantText("Found the issue.\n1. Fix validation"),
      ],
    });
    expect(r).toContain("[Session Goal]");
    expect(r).toContain("Fix login bug");
    expect(r).toContain("---");
    expect(r).toContain("[user]\nFix login bug");
    expect(r).toContain('* Read "auth.ts"');
    expect(r).toContain("Found the issue.");
  });

  it("merges previous summary goals", () => {
    const r = compile({
      messages: [userMsg("New task")],
      previousSummary: "[Session Goal]\n- Original goal\n\n---\n\n[user]\nOriginal goal",
    });
    expect(r).toContain("- Original goal");
    expect(r).toContain("- New task");
  });

  it("appends brief transcript on merge", () => {
    const previousSummary = [
      "[Session Goal]\n- Original goal",
      "---",
      '[user]\nOriginal goal\n\n[assistant]\n* Read "old.ts"',
    ].join("\n\n");
    const r = compile({
      previousSummary,
      messages: [userMsg("Next step"), assistantWithToolCall("Read", { path: "new.ts" })],
    });
    expect(r).toContain('* Read "old.ts"');
    expect(r).toContain('* Read "new.ts"');
    expect(r).toContain("Next step");
  });

  describe("headerless summaries (#216)", () => {
    // >200 chars on one line: extractGoals drops it, so the fresh compile has
    // no [Session Goal] (or any other) header and is transcript-only.
    const longPreamble =
      "Delegation stance: implement. Build everything yourself; read-only helpers are fine. ".repeat(
        8,
      );

    it("keeps a headerless previous transcript on the next compile", () => {
      const first = compile({
        messages: [userMsg(longPreamble), assistantText("Looking at the retry code now.")],
      });
      expect(first).not.toContain("[Session Goal]");
      expect(first).toContain("[user]");

      const second = compile({
        messages: [
          userMsg("Also add a regression test."),
          assistantText("Added the regression test."),
        ],
        previousSummary: first,
      });
      expect(second).toContain("Delegation stance");
      expect(second).toContain("Looking at the retry code now.");
      expect(second).toContain("Also add a regression test.");
      expect(second).toContain("Added the regression test.");
    });

    it("keeps a headerless fresh transcript when the previous summary has goals", () => {
      const previousSummary =
        "[Session Goal]\n- Fix the billing webhook retry bug\n\n---\n\n[user]\nFix the billing webhook retry bug";
      const merged = compile({
        messages: [userMsg(longPreamble), assistantText("Background reading done.")],
        previousSummary,
      });
      expect(merged).toContain("Fix the billing webhook retry bug");
      expect(merged).toContain("Delegation stance");
      expect(merged).toContain("Background reading done.");
    });

    it("keeps headerless transcripts across repeated merges without duplicating them", () => {
      const first = compile({
        messages: [userMsg(longPreamble), assistantText("First reply.")],
      });
      const second = compile({
        messages: [userMsg("Second short message."), assistantText("Second reply.")],
        previousSummary: first,
      });
      const third = compile({
        messages: [userMsg("Third short message."), assistantText("Third reply.")],
        previousSummary: second,
      });

      for (const text of [
        "Delegation stance",
        "First reply.",
        "Second short message.",
        "Second reply.",
        "Third short message.",
        "Third reply.",
      ]) {
        expect(third, text).toContain(text);
      }
      expect(third.match(/First reply\./g)).toHaveLength(1);
      expect(third.match(/Second reply\./g)).toHaveLength(1);
    });
  });

  it("outstanding context is volatile (fresh only)", () => {
    const previousSummary = "[Outstanding Context]\n- old blocker\n\n---\n\n[user]\nhi";
    const r = compile({
      previousSummary,
      messages: [userMsg("continue")],
    });
    expect(r).not.toContain("old blocker");
  });

  it("caps long brief transcript with rolling window", () => {
    // Build a very long previous transcript
    const longTranscript = Array.from({ length: 200 }, (_, i) => `[user]\nmessage ${i}`).join(
      "\n\n",
    );
    const previousSummary = `[Session Goal]\n- goal\n\n---\n\n${longTranscript}`;
    const r = compile({
      previousSummary,
      messages: [userMsg("latest")],
    });
    expect(r).toContain("earlier lines omitted");
    expect(r).toContain("latest");
  });

  it("wraps final output with reasonable line lengths", () => {
    const r = compile({
      messages: [userMsg("check final summary wrapping")],
    });
    // RECALL_NOTE is appended by compile() itself (wrapped with the rest).
    const maxLineLength = Math.max(...r.split("\n").map((line) => line.length));
    expect(maxLineLength).toBeLessThanOrEqual(120);
  });

  describe("compile — recall-note deduplication", () => {
    it("strips a wrapped recall note from the previous summary", () => {
      // Simulate a previous summary where wrapLongLines broke the recall note
      // into multiple lines, so lastIndexOf(RECALL_NOTE) cannot find it.
      const previousSummary = [
        "[Session Goal]",
        "- goal",
        "",
        "---",
        "",
        "[user]",
        "hi",
        "",
        "The conversation before this point has been compacted into the summary above.",
        "Details not captured here — exact code, error messages, file paths — are only",
        "recoverable via `recall`. Use `recall` to search the session history. Do not",
        "redo work already completed.",
      ].join("\n");

      const r = compile({
        messages: [userMsg("next")],
        previousSummary,
      });

      const occurrences = (r.match(/The conversation before this point has been compacted/g) || [])
        .length;
      expect(occurrences).toBe(1);
    });

    it("strips OM content and recall notes from previous summary in the correct order", () => {
      // Realistic stored summary: VCC part (with wrapped recall note) followed
      // by OM sections appended by the before-compact hook.
      const previousSummary = [
        "[Session Goal]",
        "- goal",
        "",
        "---",
        "",
        "[user]",
        "hi",
        "",
        "The conversation before this point has been compacted into the summary above.",
        "Details not captured here — exact code, error messages, file paths — are only",
        "recoverable via `recall`. Use `recall` to search the session history. Do not",
        "redo work already completed.",
        "",
        "## Reflections",
        "- Old reflection",
        "",
        "## Observations",
        "- Old observation",
      ].join("\n");

      const r = compile({
        messages: [userMsg("next")],
        previousSummary,
      });

      // Stale OM content must not survive into the merged brief.
      expect(r).not.toContain("Old reflection");
      expect(r).not.toContain("Old observation");

      // Exactly one recall note in the final output.
      const occurrences = (r.match(/The conversation before this point has been compacted/g) || [])
        .length;
      expect(occurrences).toBe(1);
    });

    it("deduplicates recall notes across three compaction cycles", () => {
      // Cycle 1: fresh compile → 1 recall note
      const cycle1 = compile({
        messages: [userMsg("first")],
      });
      expect(
        (cycle1.match(/The conversation before this point has been compacted/g) || []).length,
      ).toBe(1);

      // Cycle 2: merge cycle1 as previous summary.
      // Without the fix, the wrapped recall note from cycle1 survives and
      // a second one is appended → 2 total.
      const cycle2 = compile({
        messages: [userMsg("second")],
        previousSummary: cycle1,
      });
      expect(
        (cycle2.match(/The conversation before this point has been compacted/g) || []).length,
      ).toBe(1);

      // Cycle 3: same pattern — must still be exactly 1.
      const cycle3 = compile({
        messages: [userMsg("third")],
        previousSummary: cycle2,
      });
      expect(
        (cycle3.match(/The conversation before this point has been compacted/g) || []).length,
      ).toBe(1);
    });
  });
});
