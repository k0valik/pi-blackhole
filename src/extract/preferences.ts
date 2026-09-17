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
];

// Information-question openers — a line starting with one of these and ending
// with `?`/`？` asks for information rather than directing work. Directive
// questions ("Can you always run tests before pushing?") start with modals and
// survive.
const INTERROGATIVE_START_RE = /^(?:what|where|when|who|whom|whose|why|how|which)\b/i;

export const extractPreferences = (blocks: NormalizedBlock[]): string[] => {
  const prefs: string[] = [];
  const seen = new Set<string>();

  for (const b of blocks) {
    if (b.kind !== "user") continue;

    let perBlock = 0;
    for (const line of nonEmptyLines(b.text)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length < 5) continue;
      if (trimmed.length > 200) continue;
      // Reject information questions only; directive questions survive.
      if ((trimmed.endsWith("?") || trimmed.endsWith("？")) && INTERROGATIVE_START_RE.test(trimmed))
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
