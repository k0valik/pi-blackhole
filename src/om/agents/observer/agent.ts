/**
 * Observer agent — uses agentLoop to distill conversation chunks into observations.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (src/agents/observer/agent.ts)
 * Modified by pi-vcc-om: detects agent_end stopReason="error" in the stream
 * and throws if the API errored without collecting any tool results.
 * This allows the consolidation pipeline to fall back to alternative models.
 */
import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { hashId } from "../../ids.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { OBSERVER_SYSTEM } from "./prompts.js";
import { nowTimestamp, truncateRecordContent } from "../../serialize.js";
import type { Observation, Relevance } from "../../ledger/index.js";
import { estimateStringTokens } from "../../tokens.js";

interface RunObserverArgs {
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
	priorReflections: string[];
	priorObservations: string[];
	chunk: string;
	allowedSourceEntryIds: string[];
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	maxTurns?: number;
	thinkingLevel?: ModelThinkingLevel;
}

const RelevanceSchema = Type.Union([
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("critical"),
]);

export const OBSERVATION_TIMESTAMP_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$";

const RecordObservationsSchema = Type.Object({
	observations: Type.Array(
		Type.Object({
			timestamp: Type.String({
				pattern: OBSERVATION_TIMESTAMP_PATTERN,
				description: "Observation time in local 'YYYY-MM-DD HH:MM' format.",
			}),
			content: Type.String({
				minLength: 1,
				description: "Single-line plain prose. No markdown, no tags, no embedded timestamp.",
			}),
			relevance: RelevanceSchema,
			sourceEntryIds: Type.Array(
				Type.String({ minLength: 1 }),
				{
					minItems: 1,
					description:
						"Exact source entry ids from the chunk that directly support this observation. " +
						"Use only ids shown in '[Source entry id: ...]' labels; never invent ids.",
				},
			),
		}),
		{ description: "Batch of new observations. May be empty only if the tool is not called at all." },
	),
});

type RecordObservationsArgs = Static<typeof RecordObservationsSchema>;

function joinOrEmpty(items: string[]): string {
	return items.length ? items.join("\n") : "(none yet)";
}

export function normalizeSourceEntryIds(
	sourceEntryIds: readonly string[] | undefined,
	allowedSourceEntryIds: readonly string[],
): string[] | undefined {
	if (!sourceEntryIds || sourceEntryIds.length === 0) return undefined;
	const allowedOrder = new Map<string, number>();
	for (let i = 0; i < allowedSourceEntryIds.length; i++) allowedOrder.set(allowedSourceEntryIds[i], i);

	const seen = new Set<string>();
	for (const id of sourceEntryIds) {
		if (!allowedOrder.has(id)) return undefined;
		seen.add(id);
	}
	if (seen.size === 0) return undefined;
	return Array.from(seen).sort((a, b) => (allowedOrder.get(a) ?? 0) - (allowedOrder.get(b) ?? 0));
}

/** Result returned by runObserver when no observations are recorded. */
export type ObserverEmptyReason =
	| { kind: "no_new_content" }           // model ran but nothing worth recording
	| { kind: "tool_not_called" }          // model didn't call record_observations at all
	| { kind: "all_rejected"; count: number } // tool called but all sourceEntryIds invalid
	| { kind: "all_duplicates"; count: number } // tool called but all already seen
	| { kind: "empty_array"; count: number }; // tool called but returned empty observations array

export interface ObserverResult {
	observations: Observation[] | undefined;
	emptyReason?: ObserverEmptyReason;
}

export async function runObserver(args: RunObserverArgs): Promise<ObserverResult> {
	const { model, apiKey, headers, priorReflections, priorObservations, chunk, allowedSourceEntryIds, signal } = args;
	const conversation = chunk.trim();
	if (!conversation) return { observations: undefined };

	const accumulated = new Map<string, Observation>();
	let toolCalled = false;
	let totalAdded = 0;
	let totalDuplicates = 0;
	let totalRejected = 0;
	let totalProposed = 0;

	const recordObservations: AgentTool<typeof RecordObservationsSchema> = {
		name: "record_observations",
		label: "Record observations",
		description:
			"Record a batch of new observations distilled from the conversation chunk. " +
			"Call this multiple times as you work through the chunk. Stop calling when coverage is complete, " +
			"then emit a short plain-text confirmation to end the run.",
		parameters: RecordObservationsSchema,
		execute: async (_id, params: RecordObservationsArgs) => {
			toolCalled = true;
			let added = 0;
			let duplicates = 0;
			let rejected = 0;
			for (const obs of params.observations) {
				totalProposed++;
				const sourceEntryIds = normalizeSourceEntryIds(obs.sourceEntryIds, allowedSourceEntryIds);
				if (!sourceEntryIds) {
					rejected++;
					continue;
				}
				const content = truncateRecordContent(obs.content);
				const id = hashId(content);
				if (accumulated.has(id)) {
					duplicates++;
					continue;
				}
				accumulated.set(id, {
					id,
					content,
					timestamp: obs.timestamp,
					relevance: obs.relevance as Relevance,
					sourceEntryIds,
					tokenCount: estimateStringTokens(content),
				});
				added++;
			}
			totalAdded += added;
			totalDuplicates += duplicates;
			totalRejected += rejected;
			const rejectedPart = rejected > 0
				? ` ${rejected} observation${rejected === 1 ? "" : "s"} rejected for missing or invalid sourceEntryIds.`
				: "";
			const ack =
				`Recorded ${added} new observation${added === 1 ? "" : "s"} ` +
				(duplicates > 0 ? `(${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped).` : ".") +
				rejectedPart +
				` Total so far this run: ${accumulated.size}. ` +
				`Continue if the chunk still has uncovered content; otherwise stop calling the tool and emit a short plain-text confirmation.`;
			return { content: [{ type: "text", text: ack }], details: { added, duplicates, rejected, total: accumulated.size } };
		},
	};

	const now = nowTimestamp();
	const userText = `Current local time: ${now}

CURRENT REFLECTIONS:
${joinOrEmpty(priorReflections)}

CURRENT OBSERVATIONS:
${joinOrEmpty(priorObservations)}

Compress the following new conversation chunk into observations by calling record_observations one or more times. Do not restate facts already present in current reflections or current observations. Prefer inline conversation timestamps when assigning times; fall back to the current local time above only if no message timestamp applies. Stop calling the tool and reply with a short plain-text confirmation once the chunk is fully covered.

NEW CONVERSATION CHUNK:
${conversation}`;

	const prompts: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: userText }],
			timestamp: Date.now(),
		},
	];

	const context: AgentContext = {
		systemPrompt: OBSERVER_SYSTEM,
		messages: [],
		tools: [recordObservations as AgentTool<any>],
	};

	const reasoning = (model as { reasoning?: unknown }).reasoning;
	const thinkingLevel = args.thinkingLevel ?? "low";
	const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : undefined;
	let turnCount = 0;
	const config: AgentLoopConfig = {
		model,
		apiKey,
		headers,
		maxTokens: boundedMaxTokens(model, AGENT_LOOP_MAX_TOKENS),
		convertToLlm: (msgs) => msgs as Message[],
		toolExecution: "sequential",
		...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
		...(effectiveMaxTurns !== undefined
			? {
				shouldStopAfterTurn: () => {
					turnCount++;
					return turnCount >= effectiveMaxTurns;
				},
			}
			: {}),
	};

	const loop = args.agentLoop ?? agentLoop;
	const stream = loop(prompts, context, config, signal);
	let agentError: string | undefined;
	for await (const event of stream) {
		// Drain events; the tool's execute already collects records.
		if (event.type === "agent_end") {
			const msgs = ((event as any).messages || []) as Array<{ stopReason?: string; errorMessage?: string }>;
			const lastMsg = msgs[msgs.length - 1];
			if (lastMsg?.stopReason === "error") {
				agentError = lastMsg.errorMessage ?? "Unknown API error";
			}
		}
	}
	await stream.result();

	if (agentError && accumulated.size === 0) {
		throw new Error(`Observer API error: ${agentError}`);
	}

	if (accumulated.size === 0) {
		// Determine why no observations were recorded
		let emptyReason: ObserverEmptyReason;
		if (!toolCalled) {
			emptyReason = { kind: "tool_not_called" };
		} else if (totalRejected > 0 && totalAdded === 0) {
			emptyReason = { kind: "all_rejected", count: totalRejected };
		} else if (totalDuplicates > 0 && totalAdded === 0) {
			emptyReason = { kind: "all_duplicates", count: totalDuplicates };
		} else if (totalProposed === 0) {
			emptyReason = { kind: "empty_array", count: 0 };
		} else {
			emptyReason = { kind: "no_new_content" };
		}
		return { observations: undefined, emptyReason };
	}

	return { observations: Array.from(accumulated.values()) };
}
