/**
 * Observer agent — uses agentLoop to distill conversation chunks into observations.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (src/agents/observer/agent.ts)
 * Modified by pi-vcc-om: detects agent_end stopReason="error" in the stream
 * and throws if the API errored without collecting any tool results.
 * This allows the consolidation pipeline to fall back to alternative models.
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
import { OBSERVER_SYSTEM } from "./prompts.js";
import { nowTimestamp, truncateRecordContent } from "../../serialize.js";
import type { Observation, Relevance } from "../../ledger/index.js";
import { estimateStringTokens } from "../../tokens.js";

interface RunObserverArgs {
  model: Model<any>;
  apiKey: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  priorReflections: string[];
  priorObservations: string[];
  chunk: string;
  allowedSourceEntryIds: string[];
  /** Entry id -> local display timestamp for the chunk's source entries; used to
   *  timestamp observations programmatically from their cited evidence. */
  sourceEntryTimestamps?: Record<string, string>;
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
      content: Type.String({
        minLength: 1,
        description: "Single-line plain prose. No markdown, no tags, no embedded timestamp.",
      }),
      relevance: RelevanceSchema,
      sourceEntryIds: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description:
          "Exact source entry ids from the chunk that directly support this observation. " +
          "Use only ids shown in '[Source entry id: ...]' labels; never invent ids.",
      }),
    }),
    {
      // The empty batch is the only sanctioned way to close a chunk that yielded
      // nothing, so it is paired with the flag. The previous wording also offered
      // "if the tool is not called at all", which is both self-contradictory (an
      // uncalled tool has no array) and points at the plain-text path the observer
      // stage reports as a tool_not_called warning.
      description:
        "Batch of new observations. May be empty only alongside complete=true, " +
        "which closes a run that found nothing new.",
    },
  ),
  // Optional on purpose: a model that omits the flag must lose only the
  // early-stop hint, never the batch itself (a required field would fail
  // host-side validation and drop every observation in the call).
  complete: Type.Optional(
    Type.Boolean({
      description:
        "Whether this batch completes chunk coverage. Set false when more observations or corrections remain.",
    }),
  ),
});

type RecordObservationsArgs = Static<typeof RecordObservationsSchema>;

/**
 * Derive an observation timestamp from its supporting source entries instead of
 * trusting an LLM-reported time. Uses the LATEST supporting entry (the moment the
 * cited evidence was complete); falls back to the current local time when the
 * chunk carries no usable timestamps. Lexicographic comparison is correct for
 * the fixed-width "YYYY-MM-DD HH:MM" format; placeholder timestamps ("????-??-??")
 * are ignored.
 */
function deriveObservationTimestamp(
  sourceEntryIds: readonly string[],
  sourceEntryTimestamps: Record<string, string> | undefined,
): string {
  let latest: string | undefined;
  if (sourceEntryTimestamps) {
    for (const id of sourceEntryIds) {
      const t = sourceEntryTimestamps[id];
      if (!t || t.startsWith("?")) continue;
      if (!latest || t > latest) latest = t;
    }
  }
  return latest ?? nowTimestamp();
}

function joinOrEmpty(items: string[]): string {
  return items.length ? items.join("\n") : "(none yet)";
}

export function normalizeSourceEntryIds(
  sourceEntryIds: readonly string[] | undefined,
  allowedSourceEntryIds: readonly string[],
): string[] | undefined {
  if (!sourceEntryIds || sourceEntryIds.length === 0) return undefined;
  const allowedOrder = new Map<string, number>();
  for (let i = 0; i < allowedSourceEntryIds.length; i++)
    allowedOrder.set(allowedSourceEntryIds[i], i);

  // Filter out invalid/unknown IDs instead of rejecting the entire batch.
  // Matches the dropper's normalizeDropObservationIds pattern: one hallucinated
  // ID from the LLM should not discard valid observations.
  const seen = new Set<string>();
  const valid: string[] = [];
  for (const id of sourceEntryIds) {
    if (!allowedOrder.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    valid.push(id);
  }
  if (valid.length === 0) return undefined;
  return valid.sort((a, b) => (allowedOrder.get(a) ?? 0) - (allowedOrder.get(b) ?? 0));
}

/** Result returned by runObserver when no observations are recorded. */
export type ObserverEmptyReason =
  | { kind: "no_new_content" } // model ran but nothing worth recording
  | { kind: "tool_not_called" } // model didn't call record_observations at all
  | { kind: "all_rejected"; count: number } // tool called but all sourceEntryIds invalid
  | { kind: "all_duplicates"; count: number } // tool called but all already seen
  | { kind: "empty_array"; count: number }; // tool called but returned empty observations array

export interface ObserverResult {
  observations: Observation[] | undefined;
  emptyReason?: ObserverEmptyReason;
}

export async function runObserver(args: RunObserverArgs): Promise<ObserverResult> {
  const {
    model,
    apiKey,
    headers,
    env,
    priorReflections,
    priorObservations,
    chunk,
    allowedSourceEntryIds,
    signal,
  } = args;
  const conversation = chunk.trim();
  if (!conversation) return { observations: undefined };

  const accumulated = new Map<string, Observation>();
  let toolCalled = false;
  let totalAdded = 0;
  let totalDuplicates = 0;
  let totalRejected = 0;
  let totalProposed = 0;
  // Whether the most recent batch carried complete=true. An empty complete batch
  // is the model closing a covered chunk that yielded nothing, which is a
  // no_new_content outcome, not the empty_array protocol slip the kind implies.
  let lastBatchComplete = false;
  // Whether any batch in this run was a fully valid complete=true close, i.e.
  // the model declared the chunk covered and the tool honored it. Sticky: a
  // later batch on a host that ignores `terminate` cannot revoke the close. A
  // refused complete=true batch (rejected entries) does not count.
  let closedByCompleteBatch = false;

  const recordObservations: AgentTool<typeof RecordObservationsSchema> = {
    name: "record_observations",
    label: "Record observations",
    description:
      "Record a batch of new observations distilled from the conversation chunk. " +
      "complete=true ends fully valid chunk coverage; use complete=false when more observations or corrections remain. " +
      "Incomplete or rejected work stays open.",
    parameters: RecordObservationsSchema,
    execute: async (_id, params: RecordObservationsArgs) => {
      toolCalled = true;
      lastBatchComplete = params.complete === true;
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
          timestamp: deriveObservationTimestamp(sourceEntryIds, args.sourceEntryTimestamps),
          relevance: obs.relevance as Relevance,
          sourceEntryIds,
          tokenCount: estimateStringTokens(content),
        });
        added++;
      }
      totalAdded += added;
      totalDuplicates += duplicates;
      totalRejected += rejected;
      const rejectedPart =
        rejected > 0
          ? ` ${rejected} observation${rejected === 1 ? "" : "s"} rejected for missing or invalid sourceEntryIds.`
          : "";
      const terminates = params.complete === true && rejected === 0;
      if (terminates) closedByCompleteBatch = true;
      const refusal =
        params.complete === true && rejected > 0
          ? ` complete=true was not honored: ${rejected} observation${rejected === 1 ? "" : "s"} in this batch still ${rejected === 1 ? "needs" : "need"} correcting — re-submit them with sourceEntryIds copied from the chunk; anything not re-submitted is discarded and will not be recorded.`
          : "";
      // The run totals are counter semantics, not a claim about this receipt:
      // stated as what the number means, they stay true on the batch that
      // creates the count as well as on later ones, and they tell the model not
      // to re-propose against a count it already corrected.
      const totals =
        ` Run totals: ${accumulated.size} recorded, ` +
        `${totalDuplicates} duplicate${totalDuplicates === 1 ? "" : "s"} skipped, ` +
        `${totalRejected} rejected cumulatively across this run ` +
        `(a count above zero does not mean corrections are still owed).`;
      const guidance = terminates
        ? ""
        : ` Continue with complete=false while content remains or corrections are needed; use complete=true on the final valid batch.`;
      const ack =
        `Recorded ${added} new observation${added === 1 ? "" : "s"} ` +
        (duplicates > 0
          ? `(${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped).`
          : ".") +
        rejectedPart +
        totals +
        guidance +
        refusal;
      return {
        content: [{ type: "text", text: ack }],
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

  // The system prompt (OBSERVER_SYSTEM) is the append-stable prefix every
  // observer run shares, so prompt-cache retention only pays off if nothing
  // before the per-run chunk varies. The ledger blocks below it do change on
  // every run, and the chunk is per-run by definition — hence the ordering.
  const userText = `CURRENT REFLECTIONS:
${joinOrEmpty(priorReflections)}

CURRENT OBSERVATIONS:
${joinOrEmpty(priorObservations)}

Compress the following new conversation chunk into observations by calling record_observations one or more times. Use complete=false for partial batches or corrections, and use complete=true only on the final valid batch after the chunk is fully covered. If no observations are warranted, close the run with one record_observations call carrying an empty observations array and complete=true. Do not restate facts already present in current reflections or current observations.

NEW CONVERSATION CHUNK:
${conversation}`;

  const prompts: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: userText }],
      timestamp: Date.now(),
    },
  ];

  const context = buildAgentContext(OBSERVER_SYSTEM, [recordObservations as AgentTool<any>]);

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
  // Consolidation agents run via jiti (moduleCache: false) which creates a separate
  // pi-ai instance whose apiProviderRegistry lacks custom providers registered by
  // other extensions (e.g., claude-bridge). The bridge looks up streamSimple functions
  // via modelRegistry (host-composed facade → registered provider config → global map).
  const bridgeStreamFn = createBridgeStreamFn(streamSimple, args.modelRegistry);
  const streamFn = args.streamFn ?? bridgeStreamFn;
  const stream = loop(prompts, context, config, signal, streamFn);
  let agentError: string | undefined;
  for await (const event of stream) {
    // Drain events; the tool's execute already collects records.
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

  // A run that already closed the chunk with a valid complete=true batch that
  // recorded something keeps its result however the loop ended: on a host that
  // ignores `terminate`, a trailing turn that errors after the close must not
  // discard the declared coverage, or the cursor never advances and the stage
  // re-observes the same chunk every cycle. An empty close still throws, as it
  // did before, so a provider failing after every tool call cannot turn each
  // chunk into a silent "nothing new" skip. Any other error means the chunk
  // may be partly covered.
  if (agentError && !(closedByCompleteBatch && accumulated.size > 0)) {
    // The message stays byte-identical: isDeterministicError scans it for bare
    // 4xx codes, so an interpolated observation count could misclassify it.
    throw Object.assign(new Error(`Observer API error: ${agentError}`), {
      discardedObservations: accumulated.size,
    });
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
      // An empty batch flagged complete is the sanctioned "covered, nothing new"
      // close, so it reports as no_new_content (info) rather than the warning an
      // unflagged empty batch earns. The rejected/duplicate branches above keep
      // priority, so an outstanding rejection is never masked by the close.
      emptyReason = lastBatchComplete
        ? { kind: "no_new_content" }
        : { kind: "empty_array", count: 0 };
    } else {
      emptyReason = { kind: "no_new_content" };
    }
    return { observations: undefined, emptyReason };
  }

  return { observations: Array.from(accumulated.values()) };
}
