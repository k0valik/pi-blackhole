import { describe, it, expect } from "vitest";
import { formatSummary, capBrief } from "../src/core/format.js";
import type { SectionData } from "../src/sections.js";

const empty: SectionData = {
  sessionGoal: [],
  outstandingContext: [],
  filesAndChanges: [],
  commits: [],
  userPreferences: [],
  briefTranscript: "",
};

describe("formatSummary", () => {
  it("returns empty string for all-empty sections", () => {
    expect(formatSummary(empty)).toBe("");
  });

  it("formats a single header section", () => {
    const data = {
      ...empty,
      sessionGoal: ["fix auth bug"],
    };
    const r = formatSummary(data);
    expect(r).toContain("[Session Goal]");
    expect(r).toContain("- fix auth bug");
  });

  it("separates header and brief transcript with ---", () => {
    const data = {
      ...empty,
      sessionGoal: ["goal"],
      briefTranscript: "[user]\ndo something",
    };
    const r = formatSummary(data);
    expect(r).toContain("[Session Goal]");
    expect(r).toContain("---");
    expect(r).toContain("[user]\ndo something");
  });

  it("renders brief transcript alone when no header sections", () => {
    const data = {
      ...empty,
      briefTranscript: "[user]\nhi\n\n[assistant]\nhello",
    };
    const r = formatSummary(data);
    expect(r).toContain("[user]\nhi\n\n[assistant]\nhello");
  });

  it("joins multiple header sections with blank line", () => {
    const data = {
      ...empty,
      sessionGoal: ["goal"],
      outstandingContext: ["blocker"],
    };
    const r = formatSummary(data);
    expect(r).toContain("[Session Goal]");
    expect(r).toContain("[Outstanding Context]");
    expect(r).toContain("\n\n");
  });

  it("wraps long lines so compaction TUI rendering stays bounded", () => {
    const data = {
      ...empty,
      briefTranscript: `[assistant]\n${"word ".repeat(80)}`,
    };
    const r = formatSummary(data);
    expect(Math.max(...r.split("\n").map((line) => line.length))).toBeLessThanOrEqual(120);
  });

  describe("capBrief omission count", () => {
    it("computes omitted after firstHeader trim, not before", () => {
      // Build a brief with 150 lines where the first 20 lines have no header,
      // and the first header appears at line 21. With BRIEF_MAX_LINES=120,
      // the kept window is lines 31-150 (120 lines starting at first header).
      // Old buggy code: omitted = 150 - 120 = 30
      // Fixed code: omitted = 150 - 120 = 30 (same in this case because clean==kept)
      // To expose the bug, we need a case where firstHeader trims MORE lines
      // than BRIEF_MAX_LINES would allow. Let's use 200 lines, first header at 100.
      // BRIEF_MAX_LINES=120, kept = lines[80:200] (120 lines), firstHeader at index 20 in kept.
      // clean = lines[100:200] (100 lines).
      // Old bug: omitted = 200 - 120 = 80 (wrong, should be 200 - 100 = 100)
      const lines = Array.from({ length: 200 }, (_, i) => {
        if (i < 99) return `line ${i}`; // no headers in first 99 lines
        if (i === 99) return "[Session Goal]"; // first header at line 100 (index 99)
        return `line ${i}`;
      });
      const text = lines.join("\n");
      const result = capBrief(text);
      const omittedMatch = result.match(/\(([0-9]+) earlier lines omitted\)/);
      expect(omittedMatch).not.toBeNull();
      const omitted = parseInt(omittedMatch![1], 10);
      // clean = lines[100:200] = 100 lines, so omitted = 200 - 100 = 100
      // Wait: kept = last 120 lines (indices 80-199), firstHeader at index 19 in kept,
      // clean = kept.slice(19) = 101 lines. omitted = 200 - 101 = 99.
      expect(omitted).toBe(99);
    });

    it("omitted count matches actual trimmed lines when no header anchor", () => {
      // Simple case: 150 lines, no headers, BRIEF_MAX_LINES=120
      // kept = last 120 lines, firstHeader = -1, clean = kept
      // omitted = 150 - 120 = 30
      const lines = Array.from({ length: 150 }, (_, i) => `line ${i}`);
      const result = capBrief(lines.join("\n"));
      const omittedMatch = result.match(/\(([0-9]+) earlier lines omitted\)/);
      expect(omittedMatch).not.toBeNull();
      expect(parseInt(omittedMatch![1], 10)).toBe(30);
    });
  });
});
