/**
 * Summary rendering — formats observations/reflections for compaction output.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (src/session-ledger/render-summary.ts)
 * Modified: separator-aware whole-record output caps.
 */
import type { Observation, Reflection } from "./types.js";
import { estimateStringTokens } from "../tokens.js";

const OM_INSTRUCTIONS_FULL = `Bracketed ids in reflections and observations connect to their source session entries. These are condensed memories from earlier in this session.
When entries conflict, the most recent observation reflects the latest known state.
Use \`recall\` with an id to retrieve original context, or \`#N:path\` drill-down to explore file content from referenced entries.
When exact source context is needed for precision or traceability, use the \`recall\` tool with the relevant observation or reflection id. This is especially useful when a reflection materially affects a decision or is too compressed to continue confidently.`;

const OM_INSTRUCTIONS_BASIC = `Use \`recall\` with an id to retrieve original context, or \`#N:path\` drill-down to explore file content from referenced entries.
When entries conflict, the most recent entry reflects the latest known state.`;

export const OM_FOOTER_FULL = `----\n${OM_INSTRUCTIONS_FULL}\n----`;
export const OM_FOOTER_BASIC = `----\n${OM_INSTRUCTIONS_BASIC}\n----`;

export function observationToSummaryLine(observation: Observation): string {
  return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`;
}

/** Score an observation for cap/trim selection.
 *  Relevance tier dominates: medium (5+) always outranks low (max 2).
 *  Recency is based on position in the flat-mapped array (0 = oldest, N-1 = newest),
 *  avoiding wall-clock dependency that punishes sessions spanning days or weeks. */
export function scoreObservation(obs: Observation, index: number, total: number): number {
  const base =
    obs.relevance === "high" || obs.relevance === "critical"
      ? 10
      : obs.relevance === "medium"
        ? 5
        : 1;
  const recency = total > 1 ? index / (total - 1) : 1;
  return base + recency;
}

/** Select observations up to a token budget, keeping high-relevance items
 *  first and filling the remaining budget with the best-scoring medium and
 *  low observations (relevance-tiered + recency).
 *
 *  The budget is a hard cap: when high/critical items alone exceed it, the
 *  newest are kept and the oldest are sacrificed (sessions can accumulate
 *  hundreds of high-relevance observations, which previously pushed the
 *  rendered pool far past the budget).
 *
 *  Observations stay in the branch either way; this only caps what is rendered
 *  in the compaction summary output. */
export function selectPriorObservations(
  observations: Observation[],
  maxTokens: number,
): Observation[] {
  const ranked = observations.map((obs, index) => ({
    obs,
    index,
    score: scoreObservation(obs, index, observations.length),
  }));
  ranked.sort((a, b) => b.score - a.score);
  const selected: typeof ranked = [];
  let rendered = "";
  for (const item of ranked) {
    const next = rendered + (selected.length ? "\n" : "") + observationToSummaryLine(item.obs);
    if (estimateStringTokens(next) > maxTokens) continue;
    selected.push(item);
    rendered = next;
  }
  return selected.sort((a, b) => a.index - b.index).map((item) => item.obs);
}

export function reflectionToSummaryLine(reflection: Reflection): string {
  return `[${reflection.id}] ${reflection.content}`;
}

/** Bound compaction output only; worker reflection prompts stay unchanged. */
export function selectPriorReflections(reflections: Reflection[], maxTokens: number): Reflection[] {
  const selected: Reflection[] = [];
  let rendered = "";
  for (let i = reflections.length - 1; i >= 0; i--) {
    const reflection = reflections[i]!;
    const next = rendered + (selected.length ? "\n" : "") + reflectionToSummaryLine(reflection);
    if (estimateStringTokens(next) > maxTokens) continue;
    selected.push(reflection);
    rendered = next;
  }
  return selected.reverse();
}

export function renderSummary(reflections: Reflection[], observations: Observation[]): string {
  const hasContent = reflections.length > 0 || observations.length > 0;

  const parts: string[] = [];
  if (reflections.length > 0) {
    parts.push(`## Reflections\n${reflections.map(reflectionToSummaryLine).join("\n")}`);
  }
  if (observations.length > 0) {
    parts.push(`## Observations\n${observations.map(observationToSummaryLine).join("\n")}`);
  }

  const footer = hasContent ? OM_FOOTER_FULL : OM_FOOTER_BASIC;
  if (parts.length > 0) {
    parts.push(footer);
    return parts.join("\n\n");
  }
  return footer;
}
