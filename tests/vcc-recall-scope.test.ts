import { describe, it, expect } from "vitest";
import { normalizeRecallScope, parseRecallScope } from "../src/core/recall-scope.js";

describe("normalizeRecallScope", () => {
  it("defaults to active lineage", () => {
    expect(normalizeRecallScope()).toBe("lineage");
    expect(normalizeRecallScope("lineage")).toBe("lineage");
    expect(normalizeRecallScope("unknown")).toBe("lineage");
    expect(normalizeRecallScope(123)).toBe("lineage");
  });

  it("accepts all scope", () => {
    expect(normalizeRecallScope("all")).toBe("all");
    expect(normalizeRecallScope("ALL")).toBe("all");
  });
});

describe("parseRecallScope", () => {
  it("removes scope token from command text", () => {
    expect(parseRecallScope("license scope:all page:2")).toEqual({
      scope: "all",
      text: "license page:2",
    });
  });

  it("defaults to lineage when no scope token is present", () => {
    expect(parseRecallScope("license page:2")).toEqual({
      scope: "lineage",
      text: "license page:2",
    });
  });
});
