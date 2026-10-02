/**
 * Dropper agent — uses agentLoop to propose prunable observations.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (src/agents/dropper/agent.ts)
 * Modified by pi-vcc-om: an agent_end whose run did not complete — stopReason
 * `error`/`aborted`/`length`, a terminal `toolUse` without the turn cap, or an
 * aborted attempt signal — always throws, since the tool has no complete flag
 * to prove the evaluation finished: a prefix of the proposed candidates
 * reported as success would be written under an OM_OBSERVATIONS_DROPPED marker
 * that a cadence run never re-evaluates. The same guard covers a run the agent
 * turn cap cut off.
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
import { debugLog } from "../../debug-log.js";
import {
  withDiscardedCount,
  WorkerStreamError,
  workerStreamErrorMessage,
} from "../../retryable-error.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { reflectionToSummaryLine, type Observation, type Reflection } from "../../ledger/index.js";
import { DROPPER_SYSTEM } from "./prompts.js";
import {
  coverageTierForObservation,
  observationToDropperLine,
  reflectionCoverageMap,
  summarizeCoverageByRelevance,
  summarizeCoverageByRelevanceForIds,
} from "./coverage.js";

interface RunDropperArgs {
  model: Model<any>;
  apiKey: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  reflections: Reflection[];
  observations: Observation[];
  /** Compact summary of existing active observations for context. */
  existingObservationsSummary?: string;
  budgetTokens: number;
  /** Minimum pool fullness (fraction of budget) before dropping is allowed.
   *  Defaults to DROP_SKIP_FULLNESS (0.1) when unset. */
  skipFullness?: number;
  /**
   * Batch-mode pressure override for shrink-to-fit runs: the caller evaluates
   * a subset of the candidate pool per batch but the prompt must still quote
   * the pool-wide pressure numbers (same fullness/urgency/maximum the
   * whole-pool run would show). Unset for normal single runs.
   */
  pressure?: { tokens: number; maxDrops: number };
  /**
   * Batch mode: return the raw proposed ids without applying the
   * deterministic ranker + cap. The caller merges proposals across batches
   * and selects once globally. Unset for normal single runs.
   */
  rawProposals?: boolean;
  /**
   * Generation cap wired by the consolidation stage from the effective window
   * (`workerOutputAllowance`): the dispatched `maxTokens` must equal the output
   * allowance the preflight reserved, or a fitting prompt still overflows at
   * generation time. Absent, the legacy unclamped bound applies.
   */
  maxOutputTokens?: number;
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

export {
  DROP_LOW_URGENCY_FULLNESS,
  DROP_MAX_FULLNESS,
  DROP_MAX_RATIO,
  DROP_MEDIUM_URGENCY_FULLNESS,
  DROP_MIN_RATIO,
  DROP_SKIP_FULLNESS,
  type DropUrgency,
  dropUrgencyForFullness,
  maxDropCountForPool,
  observationPoolFullness,
  selectDropCandidates,
} from "./selection.js";
import {
  dropUrgencyForFullness,
  maxDropCountForPool,
  observationPoolFullness,
  selectDropCandidates,
} from "./selection.js";

import { DropObservationsSchema, type DropObservationsArgs } from "./tool-schema.js";

function joinOrEmpty(items: string[]): string {
  return items.length ? items.join("\n") : "(none yet)";
}

function relevanceCounts(
  observations: readonly Observation[],
): Record<Observation["relevance"], number> {
  return observations.reduce<Record<Observation["relevance"], number>>(
    (counts, observation) => {
      if (observation.relevance in counts) counts[observation.relevance]++;
      return counts;
    },
    { low: 0, medium: 0, high: 0, critical: 0 },
  );
}

export function normalizeDropObservationIds(
  ids: readonly string[] | undefined,
  observations: readonly Observation[],
): string[] | undefined {
  if (!ids || ids.length === 0) return undefined;
  const allowed = new Map(observations.map((observation) => [observation.id, observation]));
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const observation = allowed.get(id);
    if (!observation) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result.length > 0 ? result : undefined;
}

export async function runDropper(args: RunDropperArgs): Promise<string[] | undefined> {
  const {
    model,
    apiKey,
    headers,
    env,
    reflections,
    observations,
    budgetTokens,
    skipFullness,
    signal,
  } = args;
  if (observations.length === 0) return undefined;

  // Candidate-scoped, not the live pool as such: `observations` is exactly the
  // set the caller chose to evaluate — the post-last-drop delta for cadence
  // runs, the whole live pool (`livePoolObservations`) for pressure runs. So
  // this measures that candidate set; widening the scope here would change
  // which observations the dropper is allowed to drop. A batch-mode pressure
  // override replaces the numbers (but never the candidate set) so every
  // batch quotes the pool-wide pressure the whole-pool run would show.
  const observationTokens =
    args.pressure?.tokens ??
    observations.reduce((sum, observation) => sum + observation.tokenCount, 0);
  const fullness = observationPoolFullness(observationTokens, budgetTokens);
  const urgency = dropUrgencyForFullness(fullness);
  const maxDropsAllowed =
    args.pressure?.maxDrops ??
    maxDropCountForPool(observations, observationTokens, budgetTokens, skipFullness);
  const coverageById = reflectionCoverageMap(observations, reflections);
  const coverageSummaryByRelevance = summarizeCoverageByRelevance(observations, coverageById);
  debugLog("dropper.agent_start", {
    activeObservationCount: observations.length,
    reflectionCount: reflections.length,
    observationTokens,
    budgetTokens,
    fullness,
    urgency,
    maxDropsAllowed,
    relevanceCounts: relevanceCounts(observations),
    coverageSummaryByRelevance,
  });
  if (maxDropsAllowed <= 0 && !args.rawProposals) {
    debugLog("dropper.result", {
      reason: "not_over_target",
      toolCallCount: 0,
      rawRequestedIdsCount: 0,
      acceptedCandidateCount: 0,
      selectedDropsCount: 0,
      selectedDropTokens: 0,
      selectedCoverageSummaryByRelevance: summarizeCoverageByRelevanceForIds(
        [],
        observations,
        coverageById,
      ),
      maxDropsAllowed,
    });
    return undefined;
  }

  const proposedDropIds: string[] = [];
  const proposed = new Set<string>();
  const allowed = new Map(observations.map((observation) => [observation.id, observation]));
  let toolCallCount = 0;
  let rawRequestedIdsCount = 0;
  let missingIdsCount = 0;
  let criticalCandidateIdsCount = 0;
  let duplicateInRequestCount = 0;
  let duplicateInRunCount = 0;

  const dropObservations: AgentTool<typeof DropObservationsSchema> = {
    name: "drop_observations",
    label: "Drop observations",
    description: "Propose active observation ids that are safe to remove from compacted memory.",
    parameters: DropObservationsSchema,
    execute: async (_id, params: DropObservationsArgs) => {
      toolCallCount++;
      rawRequestedIdsCount += params.ids.length;
      const seenInRequest = new Set<string>();
      let added = 0;
      let requestMissingIds = 0;
      let requestCriticalCandidateIds = 0;
      let requestDuplicateIds = 0;
      let requestDuplicateInRunIds = 0;
      for (const id of params.ids) {
        const observation = allowed.get(id);
        if (!observation) {
          missingIdsCount++;
          requestMissingIds++;
          continue;
        }
        if (seenInRequest.has(id)) {
          duplicateInRequestCount++;
          requestDuplicateIds++;
          continue;
        }
        seenInRequest.add(id);
        if (proposed.has(id)) {
          duplicateInRunCount++;
          requestDuplicateInRunIds++;
          continue;
        }
        proposed.add(id);
        proposedDropIds.push(id);
        if (observation.relevance === "critical") {
          criticalCandidateIdsCount++;
          requestCriticalCandidateIds++;
        }
        added++;
      }
      debugLog("dropper.tool_call", {
        toolCallCount,
        rawRequestedIdsCount: params.ids.length,
        acceptedIdsCount: added,
        missingIdsCount: requestMissingIds,
        criticalCandidateIdsCount: requestCriticalCandidateIds,
        duplicateInRequestCount: requestDuplicateIds,
        duplicateInRunCount: requestDuplicateInRunIds,
        totalCandidates: proposedDropIds.length,
        maxDropsAllowed,
      });
      return {
        content: [
          {
            type: "text",
            text: `Queued ${added} drop candidate${added === 1 ? "" : "s"}. Candidates this run: ${proposedDropIds.length}. Maximum drops allowed: ${maxDropsAllowed}.`,
          },
        ],
        details: {
          added,
          totalCandidates: proposedDropIds.length,
          maxDropsAllowed,
        },
      };
    },
  };

  const fullnessPercent = Math.round(fullness * 100);
  const existingObservationsContext = args.existingObservationsSummary
    ? `EXISTING ACTIVE OBSERVATIONS (for context only — these are NOT candidates for dropping):\n${args.existingObservationsSummary}\n\n`
    : "";

  const userText = `CURRENT REFLECTIONS:\n${joinOrEmpty(reflections.map(reflectionToSummaryLine))}\n\n${existingObservationsContext}NEW OBSERVATIONS TO EVALUATE FOR DROPPING:\n${joinOrEmpty(observations.map((observation) => observationToDropperLine(observation, coverageTierForObservation(observation, coverageById))))}\n\nObservation pool pressure: ~${observationTokens.toLocaleString()} tokens; target budget: ~${budgetTokens.toLocaleString()} tokens; fullness: ~${fullnessPercent.toLocaleString()}%.\nDrop urgency: ${urgency}.\nMaximum drops allowed this run: ${maxDropsAllowed.toLocaleString()} observation${maxDropsAllowed === 1 ? "" : "s"}.\nThis maximum is a hard upper bound, not a target. Drop fewer or none if fewer observations are clearly safe.`;
  const prompts: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: userText }],
      timestamp: Date.now(),
    },
  ];
  const context = buildAgentContext(DROPPER_SYSTEM, [dropObservations as AgentTool<any>]);
  const reasoning = (model as { reasoning?: unknown }).reasoning;
  const thinkingLevel = args.thinkingLevel ?? "low";
  const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : undefined;
  // Kept in scope past the config so the run can tell "the model stopped" from
  // "the cap cut the model off".
  const turnCap = effectiveMaxTurns !== undefined ? createTurnCap(effectiveMaxTurns) : undefined;
  const providerFetch = createProviderFetch(args.providerIdleTimeoutMs);
  // The stage wires this from the effective window, but the option is only
  // nullish-guarded by default: 0, NaN, and negatives would reach the
  // provider verbatim (`maxTokens: 0` reads as empty success with coverage
  // advanced on some providers). Validate at the boundary instead.
  const maxOutputTokens =
    typeof args.maxOutputTokens === "number" &&
    Number.isFinite(args.maxOutputTokens) &&
    args.maxOutputTokens > 0
      ? Math.floor(args.maxOutputTokens)
      : boundedMaxTokens(model, AGENT_LOOP_MAX_TOKENS);
  const config: AgentLoopConfig & ProviderFetchOption & LegacyTurnCapOption = {
    model,
    apiKey,
    headers,
    env,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.cacheRetention ? { cacheRetention: args.cacheRetention } : {}),
    ...(providerFetch ? { fetch: providerFetch } : {}),
    maxTokens: maxOutputTokens,
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
      // Tool execution collects candidate ids.
      if (event.type === "agent_end") {
        const msgs = ((event as any).messages || []) as Array<{
          stopReason?: string;
          errorMessage?: string;
        }>;
        // `length`/`aborted`/terminal `toolUse` are not completions either: the
        // stage writes an OM_OBSERVATIONS_DROPPED marker over the whole window,
        // so a cut-off evaluation reported as success would never revisit the
        // observations past the cut. `drop_observations` carries no complete
        // flag, so only a turn-cap end on a tool-work turn is exempt.
        agentError = agentCompletionError(msgs, signal, turnCap?.exhausted);
        failureKind = agentFailureStopReason(msgs);
      }
    }
    await stream.result();
  } catch (error) {
    // A stream that breaks outright never emits agent_end, so the guard below
    // never sees it — yet the run still holds every candidate proposed so far.
    throw withDiscardedCount(error, proposedDropIds.length);
  }

  // The cap ended the run mid-evaluation for the same reason. The message names
  // no status code: this is a config limit rather than a provider failure, so it
  // must not cool a session model as deterministic. This check runs BEFORE the
  // completion check below: a length cut can land on the same turn the cap
  // fires (turn-cap.ts only exempts error/aborted turns), and the stage's
  // session-model break-glass keys on turnCapExhausted. A provider `error` is
  // carved out: it keeps its own classification, and error turns never spend
  // budget, so the cap did not cause it. A cap firing before any
  // candidate was proposed is still an empty success (returns undefined).
  if (turnCap?.exhausted && proposedDropIds.length > 0 && failureKind !== "error") {
    throw new WorkerStreamError(
      `Dropper turn cap exhausted: ${proposedDropIds.length} drop candidate${proposedDropIds.length === 1 ? "" : "s"} recorded before the run ended`,
      proposedDropIds.length,
      true,
    );
  }

  // `drop_observations` carries no complete flag, so no batch can prove the
  // evaluation finished. The stage writes an OM_OBSERVATIONS_DROPPED marker over
  // the whole observation window and a cadence run never revisits what it
  // covers, so a failure discards the prefix rather than publishing it as a
  // finished evaluation.
  if (agentError) {
    // A `length` terminal marks the run output-capped (input-size-dependent,
    // not a broken model) so the stage can break the session retry loop
    // instead of burning every attempt on an identical outcome.
    throw new WorkerStreamError(
      workerStreamErrorMessage("Dropper", agentError),
      proposedDropIds.length,
      false,
      failureKind === "length",
    );
  }

  // Batch mode: hand the raw proposals to the caller, which merges across
  // batches and applies the ranker + global cap once. Record the per-batch
  // result first so multi-batch runs keep their audit trail.
  if (args.rawProposals) {
    debugLog("dropper.result", {
      reason: "raw_batch_proposals",
      toolCallCount,
      rawRequestedIdsCount,
      missingIdsCount,
      criticalCandidateIdsCount,
      duplicateInRequestCount,
      duplicateInRunCount,
      acceptedCandidateCount: proposedDropIds.length,
      selectedDropsCount: 0,
      selectedDropTokens: 0,
      selectedCoverageSummaryByRelevance: summarizeCoverageByRelevanceForIds(
        [],
        observations,
        coverageById,
      ),
      maxDropsAllowed,
    });
    return proposedDropIds;
  }

  const droppedIds = selectDropCandidates(
    proposedDropIds,
    observations,
    maxDropsAllowed,
    reflections,
  );
  const reason =
    droppedIds.length > 0
      ? "selected_nonempty"
      : toolCallCount === 0
        ? "no_tool_call"
        : proposedDropIds.length === 0
          ? "all_filtered"
          : "selected_empty";
  const selectedDropTokens = droppedIds.reduce(
    (sum, id) => sum + (allowed.get(id)?.tokenCount ?? 0),
    0,
  );
  debugLog("dropper.result", {
    reason,
    toolCallCount,
    rawRequestedIdsCount,
    missingIdsCount,
    criticalCandidateIdsCount,
    duplicateInRequestCount,
    duplicateInRunCount,
    acceptedCandidateCount: proposedDropIds.length,
    selectedDropsCount: droppedIds.length,
    selectedDropTokens,
    selectedCoverageSummaryByRelevance: summarizeCoverageByRelevanceForIds(
      droppedIds,
      observations,
      coverageById,
    ),
    maxDropsAllowed,
  });
  return droppedIds.length > 0 ? droppedIds : undefined;
}
