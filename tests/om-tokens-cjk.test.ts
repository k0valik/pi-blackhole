/**
 * CJK-aware token estimation (#106).
 *
 * estimateStringTokens was `ceil(chars/4)` — an ASCII assumption that
 * under-counts CJK text ~3x (CJK ideographs/kana/hangul are ~1 token/char in
 * BPE vocabularies). Every OM pool budget, render cap, tool-output retention
 * cap, and worker context pre-check flows through this estimate.
 */
import { describe, expect, it } from "vitest";

import { estimateStringTokens } from "../src/om/tokens.js";

describe("estimateStringTokens — CJK script awareness (#106)", () => {
  it("counts pure CJK ideographs at ~1 token per char (was ~0.25)", () => {
    expect(estimateStringTokens("这是一段中文")).toBe(6);
  });

  it("counts kana at ~1 token per char", () => {
    expect(estimateStringTokens("カタカナ")).toBe(4);
  });

  it("counts hangul at ~1 token per char", () => {
    expect(estimateStringTokens("한국어")).toBe(3);
  });

  it("counts CJK punctuation at ~1 token per char", () => {
    expect(estimateStringTokens("。！？")).toBe(3);
  });

  it("leaves pure ASCII at chars/4 (unchanged behavior)", () => {
    expect(estimateStringTokens("This is English")).toBe(4);
    expect(estimateStringTokens("hello world")).toBe(3);
  });

  it("blends mixed CJK + ASCII text", () => {
    // "the 面板 shows": 12 chars, 2 CJK, 10 ASCII → ceil(2 + 10/4) = 5
    expect(estimateStringTokens("the 面板 shows")).toBe(5);
  });

  it("returns 0 for empty text", () => {
    expect(estimateStringTokens("")).toBe(0);
  });

  it("counts supplementary Han (astral plane) at ~1 token per code point", () => {
    // U+20BB7 𠮷 occupies 2 UTF-16 units; the /4 path would credit 0.5 tokens
    expect(estimateStringTokens("𠮷")).toBe(1);
    expect(estimateStringTokens("a𠮷b")).toBe(2);
  });
});
