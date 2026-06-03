/**
 * Judge — builds the validation prompt and parses the LLM's JSON verdict.
 *
 * Uses a multi-criteria rubric inspired by pi-slipstream-compact's prompt
 * engineering, adapted for source-grounded validation (no continuation
 * evidence, no artifact store, no snapshot pipeline).
 *
 * The judge evaluates these dimensions:
 *   - faithfulness (factual accuracy)
 *   - intentPreservation (forward intent)
 *   - currentState (task state capture)
 *   - nextActionReadiness (next step clarity)
 *   - constraintPreservation (user boundaries)
 *   - staleStateSuppression (outdated claims marked)
 */
import type { JudgeResult } from "./types.js";

// ── Prompt builder ───────────────────────────────────────────────────────────

export interface SourceEvidence {
	messageExcerpts: string[];
	filesModified: string[];
	unresolvedErrors: string[];
	userDecisions: string[];
	constraints: string[];
}

/** Build the judge prompt from a candidate summary and structured source evidence. */
export function buildJudgePrompt(
	candidate: string,
	evidence: SourceEvidence,
	threshold: number,
): string {
	const excerpts = evidence.messageExcerpts.length > 0
		? evidence.messageExcerpts.join("\n\n---\n\n")
		: "(no source messages available)";

	return `You are validating a compaction summary for an AI coding agent session.
The summary will REPLACE the source conversation below. It must faithfully
preserve critical information for safe continuation.

[CANDIDATE SUMMARY]
${candidate}

[SOURCE MESSAGES — newest first, abbreviated]
${excerpts}

[PROTECTED FACTS — extracted from source]

Files modified:
${listOrNone(evidence.filesModified)}

Unresolved errors:
${listOrNone(evidence.unresolvedErrors)}

User decisions:
${listOrNone(evidence.userDecisions)}

Active constraints:
${listOrNone(evidence.constraints)}

Score the candidate on these criteria (0-10 each):

1. FAITHFULNESS: Are ALL concrete facts (blockers, errors, file changes,
   decisions, constraints, test outcomes) from the source accurately
   preserved? Are there ANY hallucinated facts not in source? Penalize
   omissions and fabrications heavily.

2. INTENT PRESERVATION: Do the session goals, outstanding context, and
   next-action signals correctly reflect the source? Are stale or
   superseded items marked as such?

3. CURRENT STATE: Does the summary capture the latest task status,
   what changed, and what's pending? Surface-level recaps score low.

4. NEXT ACTION READINESS: Does it give correct, specific next steps
   that a continuation agent can act on immediately?

5. CONSTRAINT PRESERVATION: Are user constraints, workflow boundaries,
   and product-scope limits preserved?

6. STALE STATE SUPPRESSION: Are superseded branches, outdated plans,
   and resolved blockers labeled as stale instead of presented as
   current state?

Overall score = round(0.3 * faithfulness + 0.2 * intentPreservation + 0.15 * currentState + 0.15 * nextActionReadiness + 0.1 * constraintPreservation + 0.1 * staleStateSuppression).

Respond with ONLY valid JSON (no markdown fences, no extra text):
{"score":<0-10>,"decision":"accept"|"reject","faithfulness":<0-10>,"intentPreservation":<0-10>,"currentState":<0-10>,"nextActionReadiness":<0-10>,"constraintPreservation":<0-10>,"staleStateSuppression":<0-10>,"missing":["fact1","fact2"],"contradictions":["..."],"diagnosis":"<one sentence>"}

Rules:
- Accept only if score >= ${threshold}.
- "missing": list concrete facts from source absent from summary.
  These drive the repair pass. Be specific. Omit items that are genuinely
  not required for safe continuation.
- "contradictions": list claims in summary that contradict source or are
  internally inconsistent. Empty array if none.
- Be strict. A summary that drops critical blockers, inverts intent, or
  presents stale state as current should score 4-6 and be rejected.
- A safe-but-weak summary should score 6 and be rejected (repair improves it).
- A summary that is both faithful and clearly actionable should score 7+ and be accepted.`;
}

// ── Result parser ────────────────────────────────────────────────────────────

const FALLBACK_REJECT: JudgeResult = {
	score: 0,
	decision: "reject",
	faithfulness: 0,
	intentPreservation: 0,
	missing: [],
	contradictions: [],
	diagnosis: "Could not parse judge response",
};

/** Parse the judge's JSON response with lenient error handling. */
export function parseJudgeResult(raw: string): JudgeResult {
	const trimmed = raw.trim();
	if (!trimmed) return { ...FALLBACK_REJECT, diagnosis: "Empty judge response" };

	// Try to extract JSON (handle markdown fences or trailing noise)
	let jsonText = trimmed;
	const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
	if (fenceMatch) {
		jsonText = fenceMatch[1].trim();
	} else {
		const braceStart = trimmed.indexOf("{");
		const braceEnd = trimmed.lastIndexOf("}");
		if (braceStart >= 0 && braceEnd > braceStart) {
			jsonText = trimmed.slice(braceStart, braceEnd + 1);
		}
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(jsonText) as Record<string, unknown>;
	} catch {
		return { ...FALLBACK_REJECT, diagnosis: "Judge response was not valid JSON" };
	}

	return {
		score: clampScore(parsed.score),
		decision: parsed.decision === "accept" ? "accept" : "reject",
		faithfulness: clampScore(parsed.faithfulness),
		intentPreservation: clampScore(parsed.intentPreservation),
		currentState: clampScore(parsed.currentState),
		nextActionReadiness: clampScore(parsed.nextActionReadiness),
		constraintPreservation: clampScore(parsed.constraintPreservation),
		staleStateSuppression: clampScore(parsed.staleStateSuppression),
		missing: Array.isArray(parsed.missing)
			? parsed.missing.filter((m): m is string => typeof m === "string")
			: [],
		contradictions: Array.isArray(parsed.contradictions)
			? parsed.contradictions.filter((c): c is string => typeof c === "string")
			: [],
		diagnosis: typeof parsed.diagnosis === "string" ? parsed.diagnosis : "",
	};
}

// ── Acceptance check ─────────────────────────────────────────────────────────

/**
 * Patterns that indicate a missing item or contradiction is a non-blocking
 * note rather than a critical rejection trigger. Matches pi-slipstream-compact's
 * approach of filtering "not required for safe continuation" items.
 */
const NON_BLOCKING_PATTERNS = [
	/not (?:required|necessary|needed|critical|acceptance-blocking) for safe continuation/i,
	/not acceptance-blocking/i,
	/optional/i,
	/nice-to-have/i,
	/mitigat(?:e|ed|es)/i,
	/would be beneficial but not required/i,
];

function isNonBlocking(text: string): boolean {
	return NON_BLOCKING_PATTERNS.some((p) => p.test(text));
}

/** Check if a judge result meets the acceptance criteria.
 *  Filters out non-blocking notes from missing/contradictions before checking. */
export function isAccepted(result: JudgeResult, threshold: number): boolean {
	const criticalMissing = result.missing.filter((m) => !isNonBlocking(m));
	const criticalContradictions = result.contradictions.filter((c) => !isNonBlocking(c));
	return (
		result.decision === "accept" &&
		result.score >= threshold &&
		criticalMissing.length === 0 &&
		criticalContradictions.length === 0
	);
}

// ── Degenerate check ─────────────────────────────────────────────────────────

/** Check if a summary is degenerate (empty or heading-only). */
export function isDegenerate(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return true;
	const lines = trimmed.split("\n").filter((l) => l.trim());
	if (lines.length === 0) return true;
	return lines.every((l) => /^#{1,3}\s/.test(l.trim()) || !l.trim());
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function listOrNone(items: string[]): string {
	return items.length > 0 ? items.map((s) => `- ${s}`).join("\n") : "- (none)";
}

function clampScore(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(10, Math.round(value)));
}
