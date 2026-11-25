import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch } from "../src/ui/fuzzy.js";

describe("fuzzyMatch — contiguous and exact matches", () => {
  it("scores a contiguous run inside longer text", () => {
    const result = fuzzyMatch("abc", "xxabcxx");
    expect(result.matches).toBe(true);
    expect(result.score).toBeCloseTo(-14.1, 5);
  });

  it("lowercases both query and text", () => {
    expect(fuzzyMatch("ABC", "xxabcxx").score).toBeCloseTo(-14.1, 5);
    expect(fuzzyMatch("abc", "xxABCxx").score).toBeCloseTo(-14.1, 5);
  });

  it("applies the -100 identity bonus only when the normalized query equals the text", () => {
    expect(fuzzyMatch("abc", "ABC").score).toBeCloseTo(-139.7, 5);
  });

  it("withholds the identity bonus when the text is longer than the query", () => {
    expect(fuzzyMatch("abc", "abcd").score).toBeCloseTo(-39.7, 5);
  });

  it("rewards a word-boundary start over an in-token start", () => {
    expect(fuzzyMatch("abc", "xx abc xx").score).toBeCloseTo(-23.8, 5);
  });
});

describe("fuzzyMatch — order-only matches", () => {
  it("matches characters that appear in order but are not adjacent", () => {
    const result = fuzzyMatch("ac", "abc");
    expect(result.matches).toBe(true);
    expect(result.score).toBeCloseTo(-12.8, 5);
  });

  it("rejects out-of-order queries", () => {
    expect(fuzzyMatch("ca", "abc")).toEqual({ matches: false, score: 0 });
  });

  it("rejects when a query character is absent", () => {
    expect(fuzzyMatch("ax", "abc")).toEqual({ matches: false, score: 0 });
  });

  it("requires repeated query characters to occur repeatedly, in order", () => {
    expect(fuzzyMatch("aa", "abca").score).toBeCloseTo(-10.7, 5);
    expect(fuzzyMatch("aa", "aaca").score).toBeCloseTo(-24.9, 5);
    expect(fuzzyMatch("aa", "abc")).toEqual({ matches: false, score: 0 });
    expect(fuzzyMatch("aa", "caa").score).toBeCloseTo(-4.7, 5);
  });

  it("reports a non-match as score 0 rather than a negative score", () => {
    expect(fuzzyMatch("zz", "abc")).toEqual({ matches: false, score: 0 });
  });
});

describe("fuzzyMatch — scoring", () => {
  it("rewards consecutive runs more than the same letters spread apart", () => {
    expect(fuzzyMatch("abd", "abcdefg").score).toBeCloseTo(-22.6, 5);
    expect(fuzzyMatch("ad", "abcdefg").score).toBeCloseTo(-10.7, 5);
  });

  it("penalizes gap length once the run breaks", () => {
    expect(fuzzyMatch("ac", "axc").score).toBeCloseTo(-12.8, 5);
    expect(fuzzyMatch("ac", "axxxzc").score).toBeCloseTo(-6.5, 5);
  });

  it("charges a positional penalty proportional to match index", () => {
    expect(fuzzyMatch("z", "az").score).toBeCloseTo(0.1, 5);
    expect(fuzzyMatch("z", "abcz").score).toBeCloseTo(0.3, 5);
  });

  it("prefers a boundary-aligned single character over an in-token one", () => {
    expect(fuzzyMatch("b", "a-b").score).toBeCloseTo(-9.8, 5);
    expect(fuzzyMatch("b", "ab-").score).toBeCloseTo(0.1, 5);
  });

  it("keeps the best contiguous alignment instead of the greedy scatter", () => {
    // Greedy takes o, p, u from "openrouter"; the later "opus" run wins.
    const result = fuzzyMatch("opus", "openrouter openrouter/anthropic/claude-opus");
    expect(result.matches).toBe(true);
    expect(result.score).toBeCloseTo(-23.8, 5);
  });

  it("ranks candidates best-first by ascending score", () => {
    const candidates = ["openrouter/anthropic/claude-opus", "opus-open", "xopuy"];
    const ranked = [...candidates].sort(
      (a, b) => fuzzyMatch("opus", a).score - fuzzyMatch("opus", b).score,
    );
    expect(ranked).toEqual(["opus-open", "openrouter/anthropic/claude-opus", "xopuy"]);
  });

  it("leaves unmatched candidates at score 0 so they sort last", () => {
    expect(fuzzyMatch("opus", "xopuy").matches).toBe(false);
  });
});

describe("fuzzyMatch — digit/letter swap", () => {
  it("matches a letters-then-digits query against digits-then-letters text", () => {
    const swapped = fuzzyMatch("gpt4", "4gpt");
    expect(swapped.matches).toBe(true);
    expect(swapped.score).toBeCloseTo(-154.4, 5);
  });

  it("mirrors the same score for the reversed spelling", () => {
    expect(fuzzyMatch("4gpt", "gpt4").score).toBeCloseTo(-154.4, 5);
  });

  it("does not swap queries with more than two runs", () => {
    expect(fuzzyMatch("gpt4x", "4xgpt")).toEqual({ matches: false, score: 0 });
  });
});

describe("fuzzyMatch — empty query", () => {
  it("matches empty text with score 0", () => {
    expect(fuzzyMatch("", "")).toEqual({ matches: true, score: 0 });
  });

  it("matches any non-empty text with score 0", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ matches: true, score: 0 });
  });

  it("fails when the query is longer than the text", () => {
    expect(fuzzyMatch("abcd", "abc")).toEqual({ matches: false, score: 0 });
  });

  it("treats a whitespace query as an ordinary character", () => {
    expect(fuzzyMatch(" ", "abc").matches).toBe(false);
    expect(fuzzyMatch(" ", "a c").score).toBeCloseTo(0.1, 5);
  });
});

describe("fuzzyFilter", () => {
  it("returns items untouched for an empty query", () => {
    expect(fuzzyFilter(["b", "a"], "", (i) => i)).toEqual(["b", "a"]);
  });

  it("returns items untouched for a whitespace-only query", () => {
    expect(fuzzyFilter(["b", "a"], "   ", (i) => i)).toEqual(["b", "a"]);
  });

  it("requires every space-separated token to match", () => {
    const items = ["openai/gpt-4o", "anthropic/claude-opus"];
    expect(fuzzyFilter(items, "an op", (i) => i)).toEqual(["anthropic/claude-opus"]);
  });

  it("drops items missing any token", () => {
    const items = ["openai/gpt-4o", "anthropic/claude-opus"];
    expect(fuzzyFilter(items, "an zzz", (i) => i)).toEqual([]);
  });

  it("sorts by summed token score, best first", () => {
    expect(fuzzyFilter(["xx abc xx", "abc"], "abc", (i) => i)).toEqual(["abc", "xx abc xx"]);
  });
});
