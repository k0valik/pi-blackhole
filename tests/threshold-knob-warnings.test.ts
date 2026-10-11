/**
 * normalizeThresholdKnobs warnings (plan-11 §2): a threshold key is deleted
 * rather than rejected, so every silent deletion that changes which shape wins
 * has to say so out loud at least once per process.
 *
 * Fresh module registry per file, so the once-flags are still false when the
 * first test asserts "warns about nothing".
 */
import { describe, it, expect, vi } from "vitest";
import { normalizeThresholdKnobs } from "../src/core/unified-config.js";

describe("normalizeThresholdKnobs warnings", () => {
  it("a valid selector with its own value key warns about nothing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rec: Record<string, unknown> = { compactAfterBy: "percent", compactAfterRatio: 65 };
      normalizeThresholdKnobs(rec);
      expect(rec.compactAfterBy).toBe("percent");
      expect(rec.compactAfterRatio).toBe(65);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("an unrecognized selector is dropped and named in a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rec: Record<string, unknown> = { compactAfterBy: "window", compactAfterRatio: 65 };
      normalizeThresholdKnobs(rec);
      expect(rec.compactAfterBy).toBeUndefined();
      // The value keys take over silently otherwise.
      expect(warn.mock.calls.flat().join("\n")).toContain("unrecognized compactAfterBy");
      expect(warn.mock.calls.flat().join("\n")).toContain('"window"');
    } finally {
      warn.mockRestore();
    }
  });

  it("an explicit preset beside a pinned value key warns that it is ignored", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rec: Record<string, unknown> = {
        compactAfterBy: "preset",
        compactAfterTokens: 40_000,
      };
      normalizeThresholdKnobs(rec);
      // The selector is authoritative: shapeThreshold never reads the value.
      expect(rec.compactAfterBy).toBe("preset");
      expect(rec.compactAfterTokens).toBe(40_000);
      expect(warn.mock.calls.flat().join("\n")).toContain("compactAfterBy=preset");
    } finally {
      warn.mockRestore();
    }
  });
});
