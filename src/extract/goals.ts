import type { NormalizedBlock } from "../types";
import { nonEmptyLines, clip } from "../core/content";
import { collapseSkillLines } from "../core/skill-collapse";
import { estimateWordCount } from "../core/segment.js";

const SCOPE_CHANGE_RE =
  /\b(instead|actually|change of plan|forget that|new task|switch to|now I want|pivot|let'?s do|stop .* and)\b/i;

const TASK_RE =
  /\b(fix|implement|add|create|build|refactor|debug|investigate|update|remove|delete|migrate|deploy|test|write|set up)\b/i;

const NOISE_SHORT_RE = /^(ok|yes|no|sure|yeah|yep|go|hi|hey|thx|thanks|ok\b.*|y|n|k)\s*[.!?]*$/i;

// Reject lines that are clearly not user goals (pasted output, code, paths, tool dumps)
// or meta-prompt boilerplate (command templates like `/issues` that start with "For each issue:"
// followed by numbered "Read the issue in full..." steps).
const NON_GOAL_RE =
  /^\s*[[│├└─╭╰]|```|^\s*(=[A-Z]+\(|function |const |let |var |import |export |class )|^(https?:|file:|\/[A-Za-z])|\\n|^\s*For each\b|\bin full\b[^\n]*\b(comments|issue|issues|PRs?|linked)\b/;

// Signals that the rest of the user message is a command template (e.g. /issues),
// in which case we should stop collecting goals at the signal line.
const TEMPLATE_SIGNAL_RE =
  /^\s*(For each\b|Do NOT implement\b|Analyze and propose\b|If Task\/context\b|Output:\s*$)/i;

const truncateAtTemplate = (lines: string[]): string[] => {
  const idx = lines.findIndex((l) => TEMPLATE_SIGNAL_RE.test(l));
  return idx >= 0 ? lines.slice(0, idx) : lines;
};

const stripLeadingBullet = (line: string): string =>
  line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim();

const MAX_GOAL_CHARS = 200;

/** Total goal lines kept per summary section (shared with the merge cap). */
export const MAX_GOALS = 10;

/** Minimum word count for a long prose line to become a fallback goal. */
const LONG_GOAL_MIN_WORDS = 20;

const isSubstantiveGoal = (text: string): boolean => {
  const t = text.trim();
  if (t.length <= 5) return false;
  if (t.length > MAX_GOAL_CHARS) return false;
  if (NOISE_SHORT_RE.test(t)) return false;
  if (NON_GOAL_RE.test(t)) return false;
  return true;
};

/**
 * A single long prose line can be the only instruction in the window (an
 * injected preamble or a one-paragraph brief). Goals reject >200-char lines to
 * avoid pasted dumps, but dropping the only user line leaves the summary
 * headerless. Keep a clipped prefix as a durable anchor; the caller appends the
 * `(#N)` ref so the full entry stays recoverable via recall.
 */
const longLineGoal = (line: string): string | null => {
  const text = stripLeadingBullet(line).trim();
  if (text.length <= MAX_GOAL_CHARS) return null;
  if (NON_GOAL_RE.test(text)) return null;
  if (estimateWordCount(text) < LONG_GOAL_MIN_WORDS) return null;
  // Prose is mostly letters/numbers/whitespace. Reject symbol-heavy data
  // (minified JSON, encoded blobs) that happens to contain a few spaces.
  const proseChars = text.match(/[\p{L}\p{N}\s]/gu)?.length ?? 0;
  if (proseChars / text.length < 0.7) return null;
  return clip(text, MAX_GOAL_CHARS - 1).trimEnd() + "…";
};

const FIRST_MSG_CLIP = 200;

const indexSuffix = (sourceIndex?: number): string =>
  sourceIndex != null ? ` (#${sourceIndex})` : "";

// Test scope-change / task intent only on the leading portion of a user block
// so that pasted outputs below the actual instruction do not trigger matches.
const LEADING_CHARS = 200;

export const extractGoals = (blocks: NormalizedBlock[]): string[] => {
  const goals: string[] = [];
  let latestScopeChange: string[] | null = null;
  let latestScopeIndex: number | undefined;
  let scopeMarkerIndex = -1;

  for (const b of blocks) {
    if (b.kind !== "user") continue;
    const rawLines = nonEmptyLines(b.text);
    const truncated = truncateAtTemplate(rawLines);
    const collapsed = collapseSkillLines(truncated);
    const lines = collapsed
      .filter(isSubstantiveGoal)
      .map(stripLeadingBullet)
      .filter((l) => l.length > 5);
    if (lines.length === 0) {
      // No short goal line. A long prose-only message still deserves an anchor,
      // but only while there is no founding goal yet — a long line alongside a
      // real short goal must not consume a second slot.
      if (goals.length === 0) {
        for (const line of collapsed) {
          const fallback = longLineGoal(line);
          if (fallback) {
            goals.push(fallback + indexSuffix(b.sourceIndex));
            break;
          }
        }
      }
      continue;
    }

    if (goals.length === 0) {
      goals.push(
        ...lines.slice(0, 6).map((l) => clip(l, FIRST_MSG_CLIP) + indexSuffix(b.sourceIndex)),
      );
      continue;
    }

    const leading = b.text.slice(0, LEADING_CHARS);
    if (SCOPE_CHANGE_RE.test(leading)) {
      latestScopeChange = lines.slice(0, 3).map((l) => clip(l, MAX_GOAL_CHARS));
      latestScopeIndex = b.sourceIndex;
    } else if (TASK_RE.test(leading) && lines[0].length > 15) {
      latestScopeChange = lines.slice(0, 2).map((l) => clip(l, MAX_GOAL_CHARS));
      latestScopeIndex = b.sourceIndex;
    }
  }

  // Only emit the [Scope change] marker when we actually captured bullets.
  // Remember where it was added: searching the rendered text later would
  // misfire if a founding goal itself starts with the marker text.
  if (latestScopeChange && latestScopeChange.length > 0) {
    scopeMarkerIndex = goals.length;
    goals.push("[Scope change]" + indexSuffix(latestScopeIndex));
    for (const line of latestScopeChange) {
      goals.push(line + indexSuffix(latestScopeIndex));
    }
  }

  // Cap at MAX_GOALS goals but never truncate the latest scope change: the
  // first user block can contribute up to 6 lines, so a plain slice(0, MAX_GOALS)
  // would drop the fresh pivot off the end and reintroduce goal drift. Markers
  // label goals and are not goals themselves, so they do not consume a slot.
  const goalCount = scopeMarkerIndex >= 0 ? goals.length - 1 : goals.length;
  if (goalCount <= MAX_GOALS) return goals;
  if (scopeMarkerIndex < 0) return goals.slice(0, MAX_GOALS);
  const tail = goals.slice(scopeMarkerIndex);
  const head = goals.slice(0, scopeMarkerIndex);
  const tailGoalCount = tail.length - 1;
  // Keep the latest founding lines, matching the recency rule used by the
  // compaction merge.
  return [...head.slice(Math.max(0, head.length - (MAX_GOALS - tailGoalCount))), ...tail];
};
