import type { NormalizedBlock } from "../types";
import { clip, nonEmptyLines } from "../core/content";

// Tightened patterns: require a clear preference construction, not bare keywords.
const PREF_PATTERNS = [
  /\bprefer(?:s|red|ring)?\s+\w/i,
  /\bdon'?t want\b/i,
  /\balways (?:use|do|run|prefer|keep|make|format|write|add|set|put|prefix|start|include|append)\b/i,
  /\bnever (?:use|do|run|push|commit|write|ignore|add|set|put|remove|delete|include|deploy)\b/i,
  /\bplease (?:use|avoid|keep|make|don'?t|do not|format|write)\b/i,
  /\b(?:style|format|language|naming)\s*[:=]\s*\S/i,
  // Correction anchors — directive/negation markers rather than preference
  // verbs. English.
  /\bstop (?:doing|using|adding|running|writing|committing|pushing)\b/i,
  /\b(?:that's|this is) wrong\b/i,
  /\b(?:revert|undo) (?:that|this|the|it|your)\b/i,
  // Correction anchors — common CJK directive/negation markers. CJK has no
  // word boundaries, so no \b. Deliberately excludes broad negatives (不行,
  // 不对, 别) that occur in conversational chatter (如果不行的话, 别人).
  /不要|不用|别再|回退|错了|停止/,
  // Standing-instruction markers — 以后/下次/必须 scope future behavior, so
  // they are preference signals by construction. 记住 fires unless followed
  // by an acknowledgement particle: 记住了/记住吧/记住哦 acknowledges a
  // previous message rather than directing future work.
  /以后|下次|必须|记住(?!了|吧|哦)/,
];

// Information-question openers — a line starting with one of these and ending
// with `?`/`？` asks for information rather than directing work. Directive
// questions ("Can you always run tests before pushing?") start with modals and
// survive.
//
// CJK interrogatives match anywhere, not just at the start: CJK questions
// commonly front a time scope before the interrogative ("以后怎么提交代码？",
// "为什么以后要用 pnpm？"), and a `？`-ending line containing one is asking
// something even when it also matches a standing-instruction marker.
const INTERROGATIVE_START_RE = /^(?:what|where|when|who|whom|whose|why|how|which)\b/i;
const CJK_INTERROGATIVE_RE = /为什么|怎么|如何|什么|哪里|哪儿|哪个|哪些|怎样|咋/;

export const extractPreferences = (blocks: NormalizedBlock[]): string[] => {
  const prefs: string[] = [];
  const seen = new Set<string>();

  for (const b of blocks) {
    if (b.kind !== "user") continue;

    let perBlock = 0;
    for (const line of nonEmptyLines(b.text)) {
      const trimmed = line.trim();
      // CJK conveys ~2-3x the information per char — a bare 2-char
      // correction (回退) is a complete directive where 5 ASCII chars would
      // be a fragment. Markers are all 2+ chars, so a floor of 2 for CJK
      // lines cannot admit single-char noise.
      const minLength = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(trimmed) ? 2 : 5;
      if (!trimmed || trimmed.length < minLength) continue;
      if (trimmed.length > 200) continue;
      // Reject information questions only; directive questions survive.
      if (
        (trimmed.endsWith("?") || trimmed.endsWith("？")) &&
        (INTERROGATIVE_START_RE.test(trimmed) || CJK_INTERROGATIVE_RE.test(trimmed))
      )
        continue;
      if (!PREF_PATTERNS.some((p) => p.test(trimmed))) continue;

      const clipped = clip(trimmed, 200);
      const key = clipped.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      prefs.push(clipped);

      // Cap per user block to avoid pasting long rule lists as many prefs.
      if (++perBlock >= 1) break;
    }
  }

  return prefs.slice(0, 10);
};

/**
 * Remove preferences that duplicate goals (case-insensitive, trimmed).
 * Called by `buildSections` so that the two sections do not overlap.
 */
export const dedupPreferencesAgainstGoals = (prefs: string[], goals: string[]): string[] => {
  const norm = (s: string) => s.trim().toLowerCase();
  const goalSet = new Set(goals.map(norm));
  return prefs.filter((p) => !goalSet.has(norm(p)));
};
