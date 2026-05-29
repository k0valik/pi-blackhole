import { describe, it, expect } from "vitest";
import { invalidExpandIndices, mergeExpandedIntoSearchResults } from "../src/tools/recall.js";
import type { SearchHit, RenderedEntry } from "../src/core/search-entries.js";

// Re-export type alias for consistency
import type { RenderedEntry as RenderEntry } from "../src/core/render-entries.js";

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

describe("mergeExpandedIntoSearchResults", () => {
  const makeSearchHit = (index: number, summary: string): SearchHit => ({
    index, role: "assistant", summary, id: `s${index}`,
  });
  const makeExpanded = (index: number, summary: string): RenderEntry => ({
    index, role: "assistant", summary, id: `e${index}`,
  });

  it("returns empty when both inputs are empty", () => {
    expect(mergeExpandedIntoSearchResults([], [])).toEqual([]);
  });

  it("returns search results unchanged when no expanded entries", () => {
    const search = [makeSearchHit(0, "short")];
    expect(mergeExpandedIntoSearchResults(search, [])).toEqual(search);
  });

  it("returns expanded entries when no search results", () => {
    const expanded = [makeExpanded(5, "full content here")];
    const merged = mergeExpandedIntoSearchResults([], expanded);
    expect(merged).toHaveLength(1);
    expect(merged[0].index).toBe(5);
    expect(merged[0].summary).toBe("full content here");
  });

  it("replaces search result summary with expanded entry for overlapping indices", () => {
    const search = [makeSearchHit(2, "truncated summary...")];
    const expanded = [makeExpanded(2, "this is the full expanded content")];
    const merged = mergeExpandedIntoSearchResults(search, expanded);
    expect(merged).toHaveLength(1);
    expect(merged[0].index).toBe(2);
    expect(merged[0].summary).toBe("this is the full expanded content");
  });

  it("merges non-overlapping search and expand entries sorted by index", () => {
    const search = [
      makeSearchHit(1, "search result"),
      makeSearchHit(4, "another result"),
    ];
    const expanded = [
      makeExpanded(2, "full entry 2"),
      makeExpanded(5, "full entry 5"),
    ];
    const merged = mergeExpandedIntoSearchResults(search, expanded);
    expect(merged).toHaveLength(4);
    expect(merged.map(r => r.index)).toEqual([1, 2, 4, 5]);
    expect(merged[0].summary).toBe("search result");
    expect(merged[1].summary).toBe("full entry 2");
    expect(merged[2].summary).toBe("another result");
    expect(merged[3].summary).toBe("full entry 5");
  });

  it("handles mixed overlap and non-overlap", () => {
    const search = [
      makeSearchHit(0, "truncated"),
      makeSearchHit(3, "also truncated"),
      makeSearchHit(7, "still truncated"),
    ];
    const expanded = [
      makeExpanded(3, "FULL VERSION"),
      makeExpanded(9, "new full entry"),
    ];
    const merged = mergeExpandedIntoSearchResults(search, expanded);
    expect(merged).toHaveLength(4);
    expect(merged.map(r => r.index)).toEqual([0, 3, 7, 9]);
    // Index 3 got expanded
    expect(merged[1].summary).toBe("FULL VERSION");
    // Unchanged entries keep their summaries
    expect(merged[0].summary).toBe("truncated");
    expect(merged[2].summary).toBe("still truncated");
    // New entry 9 appended
    expect(merged[3].summary).toBe("new full entry");
  });
});
