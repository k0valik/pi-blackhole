/**
 * Types for the optional compaction quality gate.
 *
 * The quality gate validates pi-blackhole's combined VCC+OM compaction output
 * against the source messages before adoption. It adds one optional LLM call
 * at compaction time (two if repair triggers).
 *
 * See docs/slipstream-minimal-integration.md for full design context.
 */

/** Configuration for the quality gate. */
export interface QualityGateConfig {
	enabled: boolean;
	/**
	 * Judge engine to use.
	 * - "builtin": use pi-blackhole's built-in judge (default, no deps).
	 * - "slipstream": delegate to pi-slipstream-compact (requires package installed).
	 *   INTEGRATION NOT YET SHIPPED — see slipstream-integration.ts for the contract.
	 */
	engine?: "builtin" | "slipstream";
	/** Minimum score (0-10) to accept a summary. Default: 7. */
	judgeThreshold: number;
	/**
	 * Model override for the judge call.
	 * - `null`: use the session's active model.
	 * - `"provider/modelId"`: use a specific model (e.g. "openai/gpt-4.1-mini").
	 */
	judgeModel: string | null;
	/** Allow a single repair pass when the judge rejects. Default: true. */
	repairEnabled: boolean;
	/**
	 * What to do when the gate rejects (even after repair):
	 * - `"warn"`: accept the summary anyway with a notification (default).
	 * - `"reject"`: cancel compaction entirely (falls through to Pi default).
	 */
	onRejected: "warn" | "reject";
}

/** Raw result from a single judge evaluation. */
export interface JudgeResult {
	score: number;
	decision: "accept" | "reject";
	/** Factual accuracy — are source facts preserved without hallucination? */
	faithfulness: number;
	/** Forward intent — are goals and next actions correctly reflected? */
	intentPreservation: number;
	/** How well does the summary capture the current task state? */
	currentState?: number;
	/** Does the summary give correct, specific next steps? */
	nextActionReadiness?: number;
	/** Are user constraints and boundaries preserved? */
	constraintPreservation?: number;
	/** Are stale/superseded claims suppressed vs presented as current? */
	staleStateSuppression?: number;
	/** Critical facts present in source but absent from summary. */
	missing: string[];
	/** Contradictory claims in summary. */
	contradictions: string[];
	diagnosis: string;
}

/** Result of the complete quality gate run (judge + optional repair). */
export interface GateResult {
	/** Final summary (may be repaired or original). */
	summary: string;
	/** Did the final summary pass the threshold? */
	accepted: boolean;
	/** Was the repair pass entered? */
	repaired: boolean;
	/** Final judge score (0-10). */
	score: number;
	faithfulness: number;
	intentPreservation: number;
	missing: string[];
	contradictions: string[];
	diagnosis: string;
	/** Number of repair attempts made. */
	repairCount: number;
}

/** Callback for LLM text completion. The caller controls model resolution. */
export type CompleteTextFn = (
	prompt: string,
	signal?: AbortSignal,
) => Promise<string>;
