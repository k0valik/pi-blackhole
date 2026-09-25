/**
 * Reflector agent — uses agentLoop to synthesize reflections from observations.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (src/agents/reflector/agent.ts)
 * Modified by pi-vcc-om: detects agent_end stopReason="error" in the stream
 * and throws if the API errored without collecting any tool results.
 */
import { agentLoop, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { CacheRetention, Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { buildAgentContext } from "../agent-context.js";
import { createTurnCap, type LegacyTurnCapOption } from "../turn-cap.js";
import {
  createBridgeStreamFn,
  createProviderFetch,
  type ProviderFetchOption,
} from "../../provider-stream.js";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import type { Static } from "typebox";
import { hashId } from "../../ids.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { truncateRecordContent } from "../../serialize.js";
import { REFLECTOR_SYSTEM } from "./prompts.js";
import { estimateStringTokens } from "../../tokens.js";
import {
  observationToSummaryLine,
  reflectionToSummaryLine,
  type Observation,
  type Reflection,
} from "../../ledger/index.js";
import type { ReflectionCoverageTier } from "../dropper/coverage.js";

interface RunReflectorArgs {
  model: Model<any>;
  apiKey: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  reflections: Reflection[];
  observations: Observation[];
  /** Compact summary of existing reflections for context (not to re-process). */
  existingReflectionsSummary?: string;
  /** Compact summary of existing observations for context (not to re-process). */
  existingObservationsSummary?: string;
  signal?: AbortSignal;
  agentLoop?: typeof agentLoop;
  /** Optional custom stream function bypassing agentLoop's default streamSimple.
   *  Used by the Symbol.for bridge to access native pi-ai provider registrations
   *  from jiti-loaded consolidation agents. */
  streamFn?: (model: any, context: any, options: any) => any;
  maxTurns?: number;
  thinkingLevel?: ModelThinkingLevel;
  providerIdleTimeoutMs?: number;
  /** Model registry for streamSimple resolution (custom providers, OAuth). */
  modelRegistry?: any;
  /**
   * Pi session id, forwarded through standard stream options
   * (`SimpleStreamOptions.sessionId`). agentLoop spreads the full config into
   * stream opts, so the bridge can derive provider-required headers (e.g.
   * OpenCode `x-opencode-session`) without per-provider branching upstream.
   */
  sessionId?: string;
  /**
   * Provider-neutral prompt-cache retention preference
   * (`SimpleStreamOptions.cacheRetention`). Unset defers to pi's effective
   * setting (provider default `short`); adapters ignore values they do not
   * support.
   */
  cacheRetention?: CacheRetention;
}

const RecordReflectionsSchema = Type.Object({
  reflections: Type.Array(
    Type.Object({
      content: Type.String({ minLength: 1 }),
      supportingObservationIds: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
      }),
    }),
    { minItems: 1 },
  ),
  // Optional on purpose: a model that omits the flag must lose only the
  // early-stop hint, never the batch itself (a required field would fail
  // host-side validation and drop every reflection in the call).
  complete: Type.Optional(
    Type.Boolean({
      description:
        "Whether this batch completes reflection review. Set false when more reflections or corrections remain.",
    }),
  ),
});

type RecordReflectionsArgs = Static<typeof RecordReflectionsSchema>;

function joinOrEmpty(items: string[]): string {
  return items.length ? items.join("\n") : "(none yet)";
}

export function normalizeSupportingObservationIds(
  supportingObservationIds: readonly string[] | undefined,
  allowedObservationIds: readonly string[],
): string[] | undefined {
  if (!supportingObservationIds || supportingObservationIds.length === 0) return undefined;
  const allowedOrder = new Map<string, number>();
  for (let i = 0; i < allowedObservationIds.length; i++) {
    if (!allowedOrder.has(allowedObservationIds[i])) allowedOrder.set(allowedObservationIds[i], i);
  }

  const seen = new Set<string>();
  for (const id of supportingObservationIds) {
    if (!allowedOrder.has(id)) return undefined;
    seen.add(id);
  }
  if (seen.size === 0) return undefined;
  return Array.from(seen).sort((a, b) => (allowedOrder.get(a) ?? 0) - (allowedOrder.get(b) ?? 0));
}

function normalizeReflectionContent(content: string): string | undefined {
  const normalized = truncateRecordContent(content.trim());
  if (!normalized || /\r|\n/.test(normalized)) return undefined;
  return normalized;
}

export async function runReflector(args: RunReflectorArgs): Promise<Reflection[] | undefined> {
  const { model, apiKey, headers, env, reflections, observations, signal } = args;
  if (observations.length === 0) return undefined;

  const allowedObservationIds = observations.map((observation) => observation.id);
  const existingReflectionIds = new Set(reflections.map((reflection) => reflection.id));
  const accumulated = new Map<string, Reflection>();
  // Cumulative counts for this run, including reflections the model corrected
  // or re-proposed in a later batch. Reported so the model can reconcile what
  // it already sent — they are counter semantics, not work still owed.
  let runRejected = 0;
  let runDuplicates = 0;

  const recordReflections: AgentTool<typeof RecordReflectionsSchema> = {
    name: "record_reflections",
    label: "Record reflections",
    description:
      "Record a batch of new durable reflections with supporting observation ids. " +
      "complete=true ends a fully valid reflection review; set complete=false when more reflections or corrections remain. " +
      "Incomplete or rejected work stays open.",
    parameters: RecordReflectionsSchema,
    execute: async (_id, params: RecordReflectionsArgs) => {
      let added = 0;
      let duplicates = 0;
      let rejected = 0;
      for (const proposal of params.reflections) {
        const content = normalizeReflectionContent(proposal.content);
        const supportingObservationIds = normalizeSupportingObservationIds(
          proposal.supportingObservationIds,
          allowedObservationIds,
        );
        if (!content || !supportingObservationIds) {
          rejected++;
          continue;
        }
        const id = hashId(content);
        if (existingReflectionIds.has(id) || accumulated.has(id)) {
          duplicates++;
          continue;
        }
        accumulated.set(id, {
          id,
          content,
          supportingObservationIds,
          tokenCount: estimateStringTokens(content),
        });
        added++;
      }
      runRejected += rejected;
      runDuplicates += duplicates;
      const terminates = params.complete === true && rejected === 0;
      const rejectionReason =
        rejected > 0 ? " (invalid content or unknown supporting observation ids)" : "";
      const refusal =
        params.complete === true && rejected > 0
          ? ` complete=true was not honored: ${rejected} reflection${rejected === 1 ? "" : "s"} in this batch still ${rejected === 1 ? "needs" : "need"} correcting — re-submit them with supportingObservationIds copied from the observation lines; anything not re-submitted is discarded and will not be recorded.`
          : "";
      // Counter semantics rather than a claim about this receipt, so the
      // sentence stays true on the batch that creates the count. Mirrors the
      // observer's three-way reconciliation: proposals = recorded + duplicates
      // + rejected.
      const totals =
        ` Run totals: ${accumulated.size} recorded, ` +
        `${runDuplicates} duplicate${runDuplicates === 1 ? "" : "s"} skipped, ` +
        `${runRejected} rejected cumulatively across this run ` +
        `(a count above zero does not mean corrections are still owed).`;
      // Suppressed on a refused complete batch: telling the model that
      // complete=true ends the review one sentence before saying complete=true
      // was not honored is the contradiction this branch must never emit.
      const guidance =
        terminates || refusal
          ? ""
          : ` complete=true ends the review; complete=false asks for another batch.`;
      return {
        content: [
          {
            type: "text",
            text:
              `Recorded ${added} reflection${added === 1 ? "" : "s"}; ` +
              `${duplicates} duplicate${duplicates === 1 ? "" : "s"}; ` +
              `${rejected} rejected in this batch${rejectionReason}.` +
              totals +
              guidance +
              refusal,
          },
        ],
        details: { added, duplicates, rejected, total: accumulated.size },
        // Per-batch gate, deliberately not run-scoped: an earlier rejection was
        // reported in its own receipt and stays visible in the cumulative run
        // totals, and a corrected later batch must still be able to close the
        // run — run-wide gating would disable early-stop for the whole run
        // after any single rejected entry, including runs that fixed it.
        terminate: terminates,
      };
    },
  };

  const existingReflectionsContext = args.existingReflectionsSummary
    ? `EXISTING REFLECTIONS (for context only — do NOT re-process these):\n${args.existingReflectionsSummary}\n\n`
    : "";
  const existingObservationsContext = args.existingObservationsSummary
    ? `EXISTING OBSERVATIONS (for context only — do NOT re-process these):\n${args.existingObservationsSummary}\n\n`
    : "";

  const userText = `${existingReflectionsContext}${existingObservationsContext}NEW REFLECTIONS TO PROCESS:\n${joinOrEmpty(reflections.map(reflectionToSummaryLine))}\n\nNEW OBSERVATIONS TO PROCESS:\n${joinOrEmpty(observations.map(observationToSummaryLine))}\n\nCrystallize any missing durable facts or patterns into new reflections. If nothing is stable enough, do not call the tool.`;
  const prompts: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: userText }],
      timestamp: Date.now(),
    },
  ];
  const context = buildAgentContext(REFLECTOR_SYSTEM, [recordReflections as AgentTool<any>]);
  const reasoning = (model as { reasoning?: unknown }).reasoning;
  const thinkingLevel = args.thinkingLevel ?? "low";
  const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : undefined;
  const providerFetch = createProviderFetch(args.providerIdleTimeoutMs);
  const config: AgentLoopConfig & ProviderFetchOption & LegacyTurnCapOption = {
    model,
    apiKey,
    headers,
    env,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.cacheRetention ? { cacheRetention: args.cacheRetention } : {}),
    ...(providerFetch ? { fetch: providerFetch } : {}),
    maxTokens: boundedMaxTokens(model, AGENT_LOOP_MAX_TOKENS),
    convertToLlm: (msgs) => msgs as Message[],
    toolExecution: "sequential",
    ...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
    ...(effectiveMaxTurns !== undefined ? createTurnCap(effectiveMaxTurns) : {}),
  };

  const loop = args.agentLoop ?? agentLoop;
  // ── Bridge stream function ──
  const bridgeStreamFn = createBridgeStreamFn(streamSimple, args.modelRegistry);
  const streamFn = args.streamFn ?? bridgeStreamFn;
  const stream = loop(prompts, context, config, signal, streamFn);
  let agentError: string | undefined;
  for await (const event of stream) {
    // Tool execution collects records.
    if (event.type === "agent_end") {
      const msgs = ((event as any).messages || []) as Array<{
        stopReason?: string;
        errorMessage?: string;
      }>;
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg?.stopReason === "error") {
        agentError = lastMsg.errorMessage ?? "Unknown API error";
      }
    }
  }
  await stream.result();
  if (agentError && accumulated.size === 0) throw new Error(`Reflector API error: ${agentError}`);
  return accumulated.size > 0 ? Array.from(accumulated.values()) : undefined;
}

export function observationToReflectorLine(
  observation: Observation,
  coverage: ReflectionCoverageTier,
): string {
  return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] [coverage: ${coverage}] ${observation.content}`;
}

export function summarizeSupportIdCounts(reflections: readonly Reflection[]): {
  reflectionCount: number;
  totalSupportIds: number;
  minSupportIds: number;
  maxSupportIds: number;
  averageSupportIds: number;
  histogram: Record<string, number>;
} {
  if (reflections.length === 0) {
    return {
      reflectionCount: 0,
      totalSupportIds: 0,
      minSupportIds: 0,
      maxSupportIds: 0,
      averageSupportIds: 0,
      histogram: {},
    };
  }
  const supportIdCounts = reflections.map((r) => r.supportingObservationIds.length);
  const total = supportIdCounts.reduce((sum, c) => sum + c, 0);
  const histogram: Record<string, number> = {};
  for (const count of supportIdCounts) {
    histogram[String(count)] = (histogram[String(count)] || 0) + 1;
  }
  return {
    reflectionCount: reflections.length,
    totalSupportIds: total,
    minSupportIds: Math.min(...supportIdCounts),
    maxSupportIds: Math.max(...supportIdCounts),
    averageSupportIds: total / reflections.length,
    histogram,
  };
}
