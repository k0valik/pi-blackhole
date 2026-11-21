/**
 * Summary rendering — formats observations/reflections for compaction output.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (src/session-ledger/render-summary.ts)
 * Modified: separator-aware whole-record caps and configurable reflection annotations.
 */
import type { Observation, Reflection, Relevance } from "./types.js";
import { MEMORY_ID_PATTERN } from "./types.js";
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

export interface ReflectionRenderOptions {
  timestamps: boolean;
  supersedes: boolean;
}

export function renderOptionsFromConfig(config: {
  reflectionTimestamps?: boolean;
  reflectionSupersedes?: boolean;
}): ReflectionRenderOptions {
  return {
    timestamps: config.reflectionTimestamps === true,
    supersedes: config.reflectionSupersedes === true,
  };
}

/** Persisted annotations are optional and must never invalidate a legacy record. */
export function isReflectionTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) return false;
  // UTC is only a calendar-validation frame, not a timezone conversion. Round-trip
  // to reject Date.parse rollover (February 30, 24:00) without consulting now.
  const isoMinute = value.replace(" ", "T");
  const date = new Date(`${isoMinute}:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 16) === isoMinute;
}

export function makeReflectionRenderer(opts: ReflectionRenderOptions): (r: Reflection) => string {
  return (r) => {
    const time = opts.timestamps && isReflectionTimestamp(r.timestamp) ? `${r.timestamp} ` : "";
    const ids =
      opts.supersedes && Array.isArray(r.supersedes)
        ? r.supersedes.filter(
            (id): id is string => typeof id === "string" && MEMORY_ID_PATTERN.test(id),
          )
        : [];
    return `[${r.id}] ${time}${r.content}${ids.length ? ` (supersedes ${ids.join(", ")})` : ""}`;
  };
}

export function reflectionToSummaryLine(reflection: Reflection): string {
  return `[${reflection.id}] ${reflection.content}`;
}

/** Bound compaction output only; worker reflection prompts stay unchanged. */
export function selectPriorReflections(
  reflections: Reflection[],
  maxTokens: number,
  render = reflectionToSummaryLine,
): Reflection[] {
  return selectReflectionPool(reflections, maxTokens, new Map<string, Relevance>(), render)
    .selected;
}

/**
 * Marker tier (#208): the reflection's own optional relevance, authoritative
 * when present. critical (2) beats high (1); low/medium deliberately downgrade
 * to ordinary (0) — a model that marked a reflection unimportant is not
 * overridden by its support observations.
 */
function markerTier(reflection: Reflection): 0 | 1 | 2 | undefined {
  if (reflection.relevance === undefined) return undefined;
  if (reflection.relevance === "critical") return 2;
  if (reflection.relevance === "high") return 1;
  return 0;
}

/**
 * Fallback tier from live support (#208): live critical support (2) beats live
 * high support (1); everything else is ordinary (0). Support must be live in
 * the same projection — an observation that was superseded, dropped, or lies
 * outside the boundary never promotes a reflection, so tiering cannot
 * resurrect stale facts.
 */
function supportTier(
  reflection: Reflection,
  supportRelevance: ReadonlyMap<string, Relevance>,
): 0 | 1 | 2 {
  let tier: 0 | 1 | 2 = 0;
  for (const id of reflection.supportingObservationIds) {
    const relevance = supportRelevance.get(id);
    if (relevance === "critical") return 2;
    if (relevance === "high") tier = 1;
  }
  return tier;
}

/** Fraction of the pool priority reflections may claim before ordinary fill. */
const PRIORITY_RESERVE_FRACTION = 0.5;

export type ReflectionPoolSelection = {
  selected: Reflection[];
  /** Priority reflections that never fit the whole pool, records whole. */
  overflow: Reflection[];
};

/**
 * Bounded reflection pool selection (#208).
 *
 * Priority reflections (critical/high marker, else live critical/high
 * pool first — the bounded allocation that leaves room for ordinary memory —
 * then ordinary reflections fill newest-first, and any leftover budget spills
 * back to remaining priority reflections so the pool is never wasted. Whole
 * records only; output is restored to source order; priority reflections that
 * still cannot fit are reported as overflow instead of silently evicted by
 * newer noise.
 *
 * An empty support lookup degrades to the legacy newest-first fill, so worker
 * prompt paths (observer preamble) keep their exact previous behavior.
 */
export function selectReflectionPool(
  reflections: Reflection[],
  maxTokens: number,
  supportRelevance: ReadonlyMap<string, Relevance>,
  render = reflectionToSummaryLine,
): ReflectionPoolSelection {
  const items = reflections.map((r, i) => ({
    r,
    i,
    // Marker first, live support as the fallback for marker-less records.
    tier: markerTier(r) ?? supportTier(r, supportRelevance),
  }));
  // Newest-first within each group; critical before high across tiers.
  const priority = items
    .filter((item) => item.tier > 0)
    .sort((a, b) => b.tier - a.tier || b.i - a.i);
  const ordinary = items.filter((item) => item.tier === 0).sort((a, b) => b.i - a.i);
  const selected: typeof items = [];
  const selectedIds = new Set<string>();
  let rendered = "";
  const tryAdd = (item: (typeof items)[number], budget: number): void => {
    const next = rendered + (selected.length ? "\n" : "") + render(item.r);
    if (estimateStringTokens(next) > budget) return;
    selected.push(item);
    selectedIds.add(item.r.id);
    rendered = next;
  };
  // Pass 1: bounded priority allocation (the fixed reserve).
  const reserve = Math.floor(maxTokens * PRIORITY_RESERVE_FRACTION);
  for (const item of priority) tryAdd(item, reserve);
  // Pass 2: ordinary fill of the full budget, newest-first.
  for (const item of ordinary) tryAdd(item, maxTokens);
  // Pass 3: spill leftover budget back to priority.
  for (const item of priority) if (!selectedIds.has(item.r.id)) tryAdd(item, maxTokens);
  const bySource = (a: (typeof items)[number], b: (typeof items)[number]): number => a.i - b.i;
  return {
    selected: selected.sort(bySource).map((item) => item.r),
    overflow: priority
      .filter((item) => !selectedIds.has(item.r.id))
      .sort(bySource)
      .map((item) => item.r),
  };
}

/**
 * One-line compaction-output notice when priority reflections could not fit
 * the pool (#208 reporting). Footer-style: not counted against pool budgets.
 */
export function priorityOverflowNote(overflow: Reflection[]): string | undefined {
  if (overflow.length === 0) return undefined;
  const ids = overflow.map((r) => `[${r.id}]`).join(", ");
  const plural = overflow.length === 1 ? "" : "s";
  return (
    `Priority memory notice: ${overflow.length} priority reflection${plural} (${ids}) ` +
    "did not fit the reflection pool budget. " +
    "Use recall with an id if a needed user restriction is missing above."
  );
}

export function renderSummary(
  reflections: Reflection[],
  observations: Observation[],
  opts: ReflectionRenderOptions = { timestamps: false, supersedes: false },
): string {
  const hasContent = reflections.length > 0 || observations.length > 0;

  const parts: string[] = [];
  if (reflections.length > 0) {
    parts.push(`## Reflections\n${reflections.map(makeReflectionRenderer(opts)).join("\n")}`);
  }
  if (observations.length > 0) {
    parts.push(`## Observations\n${observations.map(observationToSummaryLine).join("\n")}`);
  }

  let fullFooter = OM_FOOTER_FULL;
  if (opts.timestamps)
    fullFooter = fullFooter.replace(
      "When entries conflict, the most recent observation reflects the latest known state.",
      "When entries conflict, the entry with the latest timestamp reflects the latest known state.",
    );
  if (opts.supersedes)
    fullFooter = fullFooter.replace(
      "\n----",
      "\nSupersedes notes identify earlier reflections replaced by this entry; replaced reflections are retired from this summary.\n----",
    );
  const footer = hasContent ? fullFooter : OM_FOOTER_BASIC;
  if (parts.length > 0) {
    parts.push(footer);
    return parts.join("\n\n");
  }
  return footer;
}
