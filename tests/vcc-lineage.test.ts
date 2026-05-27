import { describe, it, expect } from "vitest";
import { getActiveLineageEntryIds } from "../src/core/lineage.js";

describe("getActiveLineageEntryIds", () => {
  it("returns IDs from active branch", () => {
    const ids = getActiveLineageEntryIds({
      getBranch: () => [{ id: "a" }, { id: "b" }, { id: "c" }],
    });
    expect([...ids]).toEqual(["a", "b", "c"]);
  });

  it("falls back to getEntries when getBranch throws", () => {
    const ids = getActiveLineageEntryIds({
      getBranch: () => {
        throw new Error("boom");
      },
      getEntries: () => [{ id: "x" }, { id: "y" }],
    });
    expect([...ids]).toEqual(["x", "y"]);
  });

  it("returns empty set when both branch and entries are unavailable", () => {
    const ids = getActiveLineageEntryIds({
      getBranch: () => {
        throw new Error("boom");
      },
      getEntries: () => {
        throw new Error("boom2");
      },
    });
    expect(ids.size).toBe(0);
  });
});
