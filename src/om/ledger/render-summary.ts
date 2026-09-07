/**
 * Summary rendering — formats observations/reflections for compaction output.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (src/session-ledger/render-summary.ts)
 * Unmodified.
 */
import type { Observation, Reflection } from "./types.js";

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
 *  The returned lines never exceed the budget: when high/critical items
 *  alone exceed it, the newest are kept within budget and the rest are
 *  dropped from the output. (Reflections are capped separately in
 *  buildCompactionProjection.) Observations stay in the branch either way;
 *  this only caps what is rendered in the compaction summary output. */
export function selectPriorObservations(
  observations: Observation[],
  maxTokens: number,
): Observation[] {
  // Track original indices so we can restore chronological order after scoring
  const indexed = observations.map((obs, i) => ({ obs, originalIndex: i }));
  const high = indexed.filter(
    (item) => item.obs.relevance === "high" || item.obs.relevance === "critical",
  );
  const rest = indexed.filter(
    (item) => item.obs.relevance !== "high" && item.obs.relevance !== "critical",
  );

  let budget = maxTokens;
  const selected = new Set<{ obs: Observation; originalIndex: number }>();
  if (high.length > 0 && budget > 0) {
    const highTokens = high.reduce((total, item) => total + observationRenderedTokens(item.obs), 0);
    if (highTokens <= budget) {
      // High fits — keep all of it, consume budget first (previous behavior).
      for (const item of high) {
        selected.add(item);
        budget -= observationRenderedTokens(item.obs);
      }
    } else {
      // High alone exceeds the budget — keep newest-first within budget.
      // A single item larger than the whole budget ends the selection so the
      // output never exceeds the cap.
      const newestFirst = [...high].sort((a, b) => b.originalIndex - a.originalIndex);
      for (const item of newestFirst) {
        const lineTokens = observationRenderedTokens(item.obs);
        if (budget - lineTokens < 0) break;
        selected.add(item);
        budget -= lineTokens;
      }
      // Restore original chronological order before returning
      return Array.from(selected)
        .sort((a, b) => a.originalIndex - b.originalIndex)
        .map((item) => item.obs);
    }
  }

  // Score medium + low and select best within remaining budget
  if (rest.length > 0 && budget > 0) {
    const scored = rest.map((item, i) => ({
      item,
      score: scoreObservation(item.obs, i, rest.length),
    }));
    scored.sort((a, b) => b.score - a.score); // highest score first
    for (const { item } of scored) {
      const lineTokens = observationRenderedTokens(item.obs);
      if (budget - lineTokens < 0) break;
      selected.add(item);
      budget -= lineTokens;
    }
  }

  // Restore original chronological order before returning
  return Array.from(selected)
    .sort((a, b) => a.originalIndex - b.originalIndex)
    .map((item) => item.obs);
}

/** Token estimate for one rendered observation line (chars/4). This is the
 *  measure the pool cap budgets against, so the gate and the fitting step
 *  stay on the same scale. */
export function observationRenderedTokens(observation: Observation): number {
  return Math.ceil(observationToSummaryLine(observation).length / 4);
}

export function reflectionToSummaryLine(reflection: Reflection): string {
  return `[${reflection.id}] ${reflection.content}`;
}

/** Token estimate for one rendered reflection line (chars/4). */
export function reflectionRenderedTokens(reflection: Reflection): number {
  return Math.ceil(reflectionToSummaryLine(reflection).length / 4);
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
