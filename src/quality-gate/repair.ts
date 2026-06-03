/**
 * Repair — builds the repair prompt that fixes gaps identified by the judge.
 *
 * Uses a structured output template referencing pi-blackhole's known
 * section headers ([Session Goal], [Files And Changes], [Commits],
 * [Outstanding Context], [User Preferences]) so the repair model
 * knows exactly where to insert missing facts.
 */
import type { JudgeResult } from "./types.js";

/** Build a repair prompt given the current summary, judge feedback, and source. */
export function buildRepairPrompt(
	currentSummary: string,
	judgeResult: JudgeResult,
	sourceExcerpts: string[],
): string {
	const excerpts = sourceExcerpts.length > 0
		? sourceExcerpts.join("\n\n---\n\n")
		: "(no source messages available)";

	const missingList = judgeResult.missing.length > 0
		? judgeResult.missing.map((m) => `- ${m}`).join("\n")
		: "- (none specified)";

	const contradictionsList = judgeResult.contradictions.length > 0
		? judgeResult.contradictions.map((c) => `- ${c}`).join("\n")
		: "- (none)";

	return `The following compaction summary was REJECTED because it misses critical facts or contains contradictions.

[CURRENT SUMMARY]
${currentSummary}

[JUDGE DIAGNOSIS]
${judgeResult.diagnosis}

Missing facts to add:
${missingList}

Contradictions to resolve:
${contradictionsList}

[SOURCE MESSAGES — for fact-checking]
${excerpts}

Rewrite the summary to fix the specific issues above.
Follow these rules strictly:

1. Keep the existing section header structure. The summary uses these headers:
   - [Session Goal] — the main objectives and what was accomplished
   - [Files And Changes] — files modified, created, or read during the session
   - [Commits] — git commits made
   - [Outstanding Context] — unresolved blockers, pending decisions, active constraints
   - [User Preferences] — user-specified preferences and style guidelines

2. Add the missing facts into the appropriate sections.
   - Errors go into [Outstanding Context]
   - File changes go into [Files And Changes]
   - Decisions and constraints go into [Outstanding Context] or [Session Goal]
   - User preferences go into [User Preferences]

3. Remove or correct any contradictory claims.

4. Do NOT remove correct content that addresses existing needs.

5. Preserve the original summary's length and tone — just fix the gaps.

6. For stale/superseded items in [Outstanding Context], mark them clearly
   with "(stale)" or "(superseded)" instead of deleting them entirely,
   so the next agent knows they should not be acted on.

Output only the full rewritten summary with no extra commentary.`;
}
