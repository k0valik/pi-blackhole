/**
 * Quality gate orchestrator — runs the judge, optionally repairs, returns the result.
 *
 * This is the single entry point called from before-compact.ts.
 * It does NOT make LLM calls directly — the caller provides a `completeText`
 * callback, giving the caller full control over model resolution and error handling.
 *
 * The flow:
 *   1. Build judge prompt from candidate summary + structured source evidence
 *   2. Call completeText → parse JSON verdict
 *   3. If accepted → return result with original summary
 *   4. If rejected + repairEnabled → one-shot repair → re-judge → return best
 *   5. On any catastrophic error → return original with score 0
 */
import type { CompleteTextFn, GateResult, JudgeResult, QualityGateConfig } from "./types.js";
import { buildJudgePrompt, parseJudgeResult, isAccepted, isDegenerate } from "./judge.js";
import type { SourceEvidence } from "./judge.js";
import { buildRepairPrompt } from "./repair.js";

// ── Public entry point ───────────────────────────────────────────────────────

export type { SourceEvidence };

export interface RunQualityGateInput {
	/** Combined VCC + OM compaction summary. */
	candidate: string;
	/** Structured source evidence extracted from messages. */
	sourceEvidence: SourceEvidence;
	/** LLM completion callback (caller provides model resolution). */
	completeText: CompleteTextFn;
	/** Quality gate configuration. */
	config: QualityGateConfig;
	/** Optional abort signal. */
	signal?: AbortSignal;
}

/**
 * Run the quality gate on a compaction candidate.
 *
 * Never throws. Returns a GateResult with the best available summary on all
 * paths, including errors (falls back to original with score 0).
 */
export async function runQualityGate(input: RunQualityGateInput): Promise<GateResult> {
	const { candidate, sourceEvidence, completeText, config, signal } = input;
	const threshold = config.judgeThreshold;
	const repairEnabled = config.repairEnabled;

	// ── Bail out early if the candidate is degenerate ──
	if (isDegenerate(candidate)) {
		return {
			summary: candidate,
			accepted: false,
			repaired: false,
			score: 0,
			faithfulness: 0,
			intentPreservation: 0,
			missing: [],
			contradictions: [],
			diagnosis: "Candidate summary is degenerate (empty or heading-only)",
			repairCount: 0,
		};
	}

	// ── Step 1: Judge the candidate ──
	const judgePrompt = buildJudgePrompt(candidate, sourceEvidence, threshold);
	const judgeRaw = await safeComplete(completeText, judgePrompt, signal);
	const firstResult = parseJudgeResult(judgeRaw);

	// Track all candidates for best-of-N selection
	const candidates: Array<{ summary: string; result: JudgeResult; attempt: number }> = [
		{ summary: candidate, result: firstResult, attempt: 0 },
	];

	let best = pickBest(candidates);

	// ── Step 2: Repair loop (if rejected and repair enabled) ──
	let repaired = false;
	let repairCount = 0;

	if (
		repairEnabled &&
		!isAccepted(firstResult, threshold)
	) {
		repaired = true;

		const repairPrompt = buildRepairPrompt(
			best.summary,
			firstResult,
			sourceEvidence.messageExcerpts,
		);

		const repairRaw = await safeComplete(completeText, repairPrompt, signal);

		// Skip degenerate repairs
		if (!isDegenerate(repairRaw)) {
			repairCount = 1;

			// Re-judge the repaired summary
			const rejudgePrompt = buildJudgePrompt(repairRaw, sourceEvidence, threshold);
			const rejudgeRaw = await safeComplete(completeText, rejudgePrompt, signal);
			const repairResult = parseJudgeResult(rejudgeRaw);

			candidates.push({
				summary: repairRaw,
				result: repairResult,
				attempt: 1,
			});

			best = pickBest(candidates);
		}
	}

	return {
		summary: best.summary,
		accepted: isAccepted(best.result, threshold),
		repaired,
		score: best.result.score,
		faithfulness: best.result.faithfulness,
		intentPreservation: best.result.intentPreservation,
		missing: best.result.missing,
		contradictions: best.result.contradictions,
		diagnosis: best.result.diagnosis,
		repairCount,
	};
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Safe LLM call — never throws, returns empty string on error. */
async function safeComplete(
	fn: CompleteTextFn,
	prompt: string,
	signal?: AbortSignal,
): Promise<string> {
	try {
		return await fn(prompt, signal);
	} catch {
		return "";
	}
}

/** Pick the best candidate: highest score wins, ties go to most recent attempt. */
function pickBest(
	candidates: Array<{ summary: string; result: JudgeResult; attempt: number }>,
): { summary: string; result: JudgeResult; attempt: number } {
	return candidates.reduce((best, c) =>
		c.result.score > best.result.score ? c : best,
	);
}

/** Build a string preview of the gate result for notifications. */
export function formatGateNotification(result: GateResult): string {
	const status = result.accepted
		? result.repaired
			? `repaired (scored ${result.score}/10)`
			: `scored ${result.score}/10`
		: `REJECTED (scored ${result.score}/10)`;
	const details: string[] = [];
	if (result.missing.length > 0) {
		details.push(`missing: ${result.missing.slice(0, 3).join(", ")}${result.missing.length > 3 ? ` (+${result.missing.length - 3} more)` : ""}`);
	}
	if (result.contradictions.length > 0) {
		details.push(`contradictions: ${result.contradictions.slice(0, 2).join(", ")}`);
	}
	if (result.diagnosis) {
		details.push(`diagnosis: ${result.diagnosis}`);
	}
	const detailStr = details.length > 0 ? ` — ${details.join("; ")}` : "";
	return `blackhole: compaction quality gate: ${status}${detailStr}`;
}
