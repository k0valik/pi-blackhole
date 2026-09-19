/**
 * Unicode script helpers + lazy word segmentation.
 *
 * Extracted from brief.ts so recall query tokenization, BM25 length
 * accounting, and the brief word budget share one segmenter (#106).
 */

// CJK script ranges: CJK punctuation/symbols, kana, ideograph ext A,
// ideographs, compatibility ideographs, hangul, fullwidth forms. Used for
// script detection, token estimation, and BM25 length accounting — NOT a
// precise tokenizer.
const CJK_SCRIPT_RE =
  /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff00-\uff5e]/g;

/** True when the text contains at least one CJK character. */
export const hasCJK = (text: string): boolean => {
  CJK_SCRIPT_RE.lastIndex = 0;
  return CJK_SCRIPT_RE.test(text);
};

/** Number of CJK characters in the text. */
export const cjkCharCount = (text: string): number => {
  CJK_SCRIPT_RE.lastIndex = 0;
  let count = 0;
  while (CJK_SCRIPT_RE.exec(text) !== null) count++;
  return count;
};

/**
 * Approximate word count across scripts: whitespace-delimited words for
 * ASCII/Latin text (unchanged behavior), CJK chars halved (average CJK word
 * ≈ 1.7 chars) and added in. Used for BM25 document length, which needs a
 * comparable scale for CJK docs where `split(/\s+/)` yields 1.
 */
export const estimateWordCount = (text: string): number => {
  const cjk = cjkCharCount(text);
  return text.split(/\s+/).length + Math.floor(cjk / 2);
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
  // _segmenter === undefined: first call — attempt construction
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
