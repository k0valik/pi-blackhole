/**
 * Unicode script helpers + lazy word segmentation.
 *
 * Extracted from brief.ts so recall query tokenization, BM25 length
 * accounting, and the brief word budget share one segmenter (#106).
 */

// CJK script ranges: CJK punctuation/symbols, kana, ideograph ext A,
// ideographs, compatibility ideographs, hangul, fullwidth forms, plus
// supplementary Han (ext B–F, compat supplement, ext G–H — astral, hence the
// u flag). Used for script detection, token estimation, and BM25 length
// accounting — NOT a precise tokenizer.
const CJK_SCRIPT_CLASS =
  "[\\u3000-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af\\uff00-\\uff5e\\u{20000}-\\u{2fa1f}\\u{30000}-\\u{323af}]";
// Non-global: test() never advances lastIndex, no reset needed
const CJK_SCRIPT_RE = new RegExp(CJK_SCRIPT_CLASS, "u");
// Global: matchAll iterates code points (u flag), each match is one code point
const CJK_SCRIPT_GLOBAL_RE = new RegExp(CJK_SCRIPT_CLASS, "gu");

/** True when the text contains at least one CJK character. */
export const hasCJK = (text: string): boolean => CJK_SCRIPT_RE.test(text);

/**
 * CJK coverage of the text, both ways that matter: `count` = CJK code points
 * (astral chars count once), `units` = UTF-16 code units they occupy (astral
 * chars count twice). `text.length - units` is the non-CJK remainder.
 */
export const cjkScriptStats = (text: string): { count: number; units: number } => {
  let count = 0;
  let units = 0;
  for (const m of text.matchAll(CJK_SCRIPT_GLOBAL_RE)) {
    count++;
    units += m[0].length;
  }
  return { count, units };
};

/** Korean syllables — Hangul. Korean is space-separated (eojool), so word
 * counts must NOT add a halved CJK term for it. */
const HANGUL_RE = /[\uac00-\ud7af]/g;

/**
 * Approximate word count across scripts: whitespace-delimited words for
 * ASCII/Latin text (unchanged behavior), non-Hangul CJK chars halved (average
 * CJK word ≈ 1.7 chars) and added in. Hangul is excluded — Korean words are
 * already whitespace-delimited, and the added term would inflate them. Used
 * for BM25 document length, which needs a comparable scale for CJK docs where
 * `split(/\s+/)` yields 1; the approximation is fine because BM25 only uses
 * the ratio dl/avgDl, so a uniform per-language skew cancels.
 */
export const estimateWordCount = (text: string): number => {
  const { count } = cjkScriptStats(text);
  const hangul = (text.match(HANGUL_RE) ?? []).length;
  return text.split(/\s+/).length + Math.floor((count - hangul) / 2);
};

// Unicode-aware word segmentation via Intl.Segmenter with lazy init & fallback
let _segmenter: Intl.Segmenter | null | undefined = undefined;
export const wordSegments = (
  text: string,
): Array<{ segment: string; index: number; isWordLike?: boolean }> => {
  // Available: fast path
  if (_segmenter) return Array.from(_segmenter.segment(text));
  // Fallback already established: don't retry the constructor
  if (_segmenter === null) {
    const parts: Array<{
      segment: string;
      index: number;
      isWordLike?: boolean;
    }> = [];
    let idx = 0;
    for (const part of text.split(/(\s+)/)) {
      if (!part) continue;
      parts.push({ segment: part, index: idx, isWordLike: /\S/.test(part) });
      idx += part.length;
    }
    return parts;
  }
  // _segmenter === undefined: first call — attempt construction. Locale is
  // left undefined (runtime default): ICU dictionary-breaking segments CJK
  // identically under any locale (verified: undefined/en-US/zh/ja/ko produce
  // the same zh/ja/ko word boundaries), so script-based locale picking would
  // add complexity without changing behavior.
  try {
    _segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
    return Array.from(_segmenter.segment(text));
  } catch {
    _segmenter = null; // permanently fallback
    const parts: Array<{
      segment: string;
      index: number;
      isWordLike?: boolean;
    }> = [];
    let idx = 0;
    for (const part of text.split(/(\s+)/)) {
      if (!part) continue;
      parts.push({ segment: part, index: idx, isWordLike: /\S/.test(part) });
      idx += part.length;
    }
    return parts;
  }
};

/**
 * Check if segment is a word (Bun's isWordLike is unreliable for
 * alphanumeric tokens).
 */
export const isWordSegment = (seg: { segment: string; isWordLike?: boolean }): boolean =>
  !!seg.isWordLike || /[\p{L}\p{N}]/u.test(seg.segment);
