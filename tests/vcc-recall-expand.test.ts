import { describe, it, expect } from "vitest";
import { invalidExpandIndices } from "../src/tools/recall.js";

describe("invalidExpandIndices", () => {
  it("returns indices that are not in available lineage index set", () => {
    const available = new Set([0, 2, 5]);
    expect(invalidExpandIndices([0, 2], available)).toEqual([]);
    expect(invalidExpandIndices([1, 2, 7], available)).toEqual([1, 7]);
  });

  it("rejects non-integer indices", () => {
    const available = new Set([0, 1, 2]);
    expect(invalidExpandIndices([1.5, 2], available)).toEqual([1.5]);
  });
});
