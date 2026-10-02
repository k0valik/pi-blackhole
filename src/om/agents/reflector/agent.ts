/**
 * Reflector agent — uses agentLoop to synthesize reflections from observations.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (src/agents/reflector/agent.ts)
 * Modified by pi-vcc-om: detects agent_end stopReason="error" in the stream
 * and throws unless the run already closed the review with a valid
 * complete=true batch that recorded reflections, so the stage cannot advance
 * the reflector cursor over observations that were never crystallized. The
 * same guard covers a run the agent turn cap cut off mid-review. A trailing
 * failure after a kept close is returned as `errorAfterClose` (mirroring the
 * observer) so the stage can cool a deterministically broken model instead of
 * only debug-logging it.
 */
import { agentLoop, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { CacheRetention, Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { agentCompletionError, agentFailureStopReason } from "../completion.js";
import { buildAgentContext } from "../agent-context.js";
import { createTurnCap, type LegacyTurnCapOption } from "../turn-cap.js";
import {
  createBridgeStreamFn,
  createProviderFetch,
  neverThrow,
  type ProviderFetchOption,
} from "../../provider-stream.js";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { hashId } from "../../ids.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { truncateRecordContent } from "../../serialize.js";
import { REFLECTOR_SYSTEM } from "./prompts.js";
import { RecordReflectionsSchema, type RecordReflectionsArgs } from "./tool-schema.js";
import { estimateStringTokens } from "../../tokens.js";
import {
  observationToSummaryLine,
  reflectionToSummaryLine,
  type Observation,
  type Reflection,
} from "../../ledger/index.js";
import type { ReflectionCoverageTier } from "../dropper/coverage.js";
import {
  withDiscardedCount,
  WorkerStreamError,
  workerStreamErrorMessage,
} from "../../retryable-error.js";

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
  /**
   * Generation cap wired by the consolidation stage from the effective window
   * (`workerOutputAllowance`): the dispatched `maxTokens` must equal the output
   * allowance the preflight reserved, or a fitting prompt still overflows at
   * generation time. Absent, the legacy unclamped bound applies.
   */
  maxOutputTokens?: number;
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

export interface ReflectorResult {
  reflections: Reflection[] | undefined;
  /**
   * Provider error from a turn after a valid complete=true close. The run kept
   * its result (the review was declared finished); the caller classifies and
   * records it the same way the observer stage handles its own kept close.
   */
  errorAfterClose?: string;
}

export async function runReflector(args: RunReflectorArgs): Promise<ReflectorResult> {
  const { model, apiKey, headers, env, reflections, observations, signal } = args;
  if (observations.length === 0) return { reflections: undefined };

  const allowedObservationIds = observations.map((observation) => observation.id);
  const existingReflectionIds = new Set(reflections.map((reflection) => reflection.id));
  const accumulated = new Map<string, Reflection>();
  // Cumulative counts for this run, including reflections the model corrected
  // or re-proposed in a later batch. Reported so the model can reconcile what
  // it already sent — they are counter semantics, not work still owed.
  let runRejected = 0;
  let runDuplicates = 0;
  // Whether the run closed the review with a valid complete=true batch that
  // recorded reflections. Same rule as the observer: a later clean close keeps
  // it, a later batch that records or rejects anything retracts it, and a
  // batch that only re-proposes already-recorded reflections changes nothing.
  // An empty closing batch after a partial batch still counts as coverage —
  // complete=true is what declares the review finished, not the size of the
  // closing batch — but a close from a run that recorded nothing at all still
  // throws, so a failing provider cannot turn each review into a silent skip.
  let closedByCompleteBatch = false;

  const recordReflections: AgentTool<typeof RecordReflectionsSchema> = {
    name: "record_reflections",
    label: "Record reflections",
    description:
      "Record a batch of new durable reflections with supporting observation ids. " +
      "complete=true ends a fully valid reflection review; set complete=false when more reflections or corrections remain. " +
      "Incomplete or rejected work stays open. " +
      // The reflector's batch carries minItems: 1, so unlike the observer it has
      // no empty close — say so, or a model mirroring the observer's protocol
      // emits a batch the host rejects and burns turns on it.
      "May not be empty: when nothing is stable enough, do not call the tool and reply briefly instead.",
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
      if (terminates) closedByCompleteBatch = true;
      else if (added > 0 || rejected > 0) closedByCompleteBatch = false;
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

  const userText = `${existingReflectionsContext}${existingObservationsContext}NEW REFLECTIONS TO PROCESS:\n${joinOrEmpty(reflections.map(reflectionToSummaryLine))}\n\nNEW OBSERVATIONS TO PROCESS:\n${joinOrEmpty(observations.map(observationToSummaryLine))}\n\nCrystallize any missing durable facts or patterns into new reflections. Use complete=false for a partial batch or a correction, and use complete=true only on the final valid batch once every active observation has been reviewed. If nothing is stable enough, do not call the tool.`;
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
  // Kept in scope past the config so the run can tell "the model stopped" from
  // "the cap cut the model off".
  const turnCap = effectiveMaxTurns !== undefined ? createTurnCap(effectiveMaxTurns) : undefined;
  const providerFetch = createProviderFetch(args.providerIdleTimeoutMs);
  const config: AgentLoopConfig & ProviderFetchOption & LegacyTurnCapOption = {
    model,
    apiKey,
    headers,
    env,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.cacheRetention ? { cacheRetention: args.cacheRetention } : {}),
    ...(providerFetch ? { fetch: providerFetch } : {}),
    maxTokens: args.maxOutputTokens ?? boundedMaxTokens(model, AGENT_LOOP_MAX_TOKENS),
    convertToLlm: (msgs) => msgs as Message[],
    toolExecution: "sequential",
    ...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
    ...(turnCap
      ? { shouldStopAfterTurn: turnCap.shouldStopAfterTurn, finishTurn: turnCap.finishTurn }
      : {}),
  };

  const loop = args.agentLoop ?? agentLoop;
  // ── Bridge stream function ──
  const bridgeStreamFn = createBridgeStreamFn(streamSimple, args.modelRegistry);
  // Never throws: pi's loop is fire-and-forget, so a sync throw or rejection
  // here would become an unhandled rejection plus a run that hangs on an open
  // event stream. Failures arrive as an error stream the completion check
  // classifies like any provider error.
  const streamFn = neverThrow(args.streamFn ?? bridgeStreamFn);
  const stream = loop(prompts, context, config, signal, streamFn);
  let agentError: string | undefined;
  let failureKind: string | undefined;
  try {
    for await (const event of stream) {
      // Tool execution collects records.
      if (event.type === "agent_end") {
        const msgs = ((event as any).messages || []) as Array<{
          stopReason?: string;
          errorMessage?: string;
        }>;
        // `length`/`aborted`/terminal `toolUse` are not completions either: a
        // partial review reported as success would advance the reflector cursor
        // over observations that were never crystallized. The complete=true
        // close and a turn-cap end on a tool-work turn are the two sanctioned
        // endings.
        agentError = agentCompletionError(
          msgs,
          signal,
          closedByCompleteBatch || turnCap?.exhausted,
        );
        failureKind = agentFailureStopReason(msgs);
      }
    }
    await stream.result();
  } catch (error) {
    // A stream that breaks outright never emits agent_end, so the guard below
    // never sees it — yet the run still holds everything recorded so far.
    throw withDiscardedCount(error, accumulated.size);
  }

  // The cap ended the run before the model closed the review. Throwing keeps
  // the cursor where it is; the message names no status code, because this is a
  // config limit rather than a provider failure and must not cool a session
  // model as deterministic. This check runs BEFORE the completion check below:
  // a length cut can land on the same turn the cap fires (turn-cap.ts only
  // exempts error/aborted turns), and the stage's session-model break-glass
  // keys on turnCapExhausted. A provider `error` is carved out: it keeps its
  // own classification, and error turns never spend budget, so the cap did
  // not cause it. A cap firing before anything was recorded is still
  // an empty success (the stage advances the cursor as "empty").
  if (
    turnCap?.exhausted &&
    accumulated.size > 0 &&
    !closedByCompleteBatch &&
    failureKind !== "error"
  ) {
    throw new WorkerStreamError(
      `Reflector turn cap exhausted: ${accumulated.size} reflection${accumulated.size === 1 ? "" : "s"} recorded with no complete=true close`,
      accumulated.size,
      true,
    );
  }

  // The stage records these reflections and advances the reflector cursor to
  // the observation coverage marker, so a partial review reported as success
  // would leave the rest of those observations uncrystallized forever. Only a
  // valid complete=true close from a run that recorded something proves the
  // review actually finished.
  if (agentError && !(closedByCompleteBatch && accumulated.size > 0)) {
    // Byte-identical to the pre-existing message: isDeterministicError scans it
    // for bare 4xx codes, so an interpolated count could misclassify it.
    throw new WorkerStreamError(
      workerStreamErrorMessage("Reflector", agentError),
      accumulated.size,
    );
  }

  // A kept close is a kept result with a surfaced failure: return the trailing
  // error alongside the reflections so the stage can classify it with the same
  // framing the throw path uses and cool a deterministically broken model. A
  // cap firing before anything was recorded is still an empty success (the
  // stage advances the cursor as "empty"); with recordings but no close the
  // run throws above.
  if (accumulated.size === 0) return { reflections: undefined };

  return {
    reflections: Array.from(accumulated.values()),
    ...(agentError ? { errorAfterClose: agentError } : {}),
  };
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
