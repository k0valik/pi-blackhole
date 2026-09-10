import type { PiVccCompactionDetailsV2, PiVccSegment, PiVccSegmentCoverage } from "../details.js";
import { isPiVccCompactionDetailsV2 } from "../details.js";
import {
  applyRetainedToolOutputProjection,
  isRetainedToolOutputProjection,
  type RetainedToolOutputProjection,
} from "./tool-output-budget.js";
import {
  buildSessionContext,
  convertToLlm,
  estimateTokens,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { getUsageTokens } from "../om/tokens.js";

export interface SessionEntryLike {
  id?: string;
  parentId?: string | null;
  firstKeptEntryId?: string;
  provider?: string;
  modelId?: string;
  type?: string;
  timestamp?: string | number;
  message?: unknown;
  summary?: string;
  tokensBefore?: number;
  details?: unknown;
}

export interface ActiveSegment {
  entry: SessionEntryLike;
  details: PiVccCompactionDetailsV2;
  segment: PiVccSegment;
}

export type ActiveSegmentChain =
  | { ok: true; segments: ActiveSegment[] }
  | {
      ok: false;
      reason:
        | "no-compaction"
        | "latest-not-append"
        | "invalid-chain-entry"
        | "invalid-sequence"
        | "missing-chain-start";
    };

export interface BuildAppendOnlyDetailsInput {
  branchEntries: SessionEntryLike[];
  manualRebase: boolean;
  freshSummary: string;
  aggregateSummary: string;
  trailingSummary: string;
  currentCoverage: PiVccSegmentCoverage;
  tokensBefore: number;
  sections: string[];
  previousSummaryUsed: boolean;
  retainedToolOutputProjection?: RetainedToolOutputProjection;
  /** Supplied effective model window, never an inferred fallback capacity. */
  contextWindowTokens?: number;
  model?: { provider: string; id: string };
  reserveTokens?: number;
  overflow?: boolean;
}

export interface ChainProjection {
  appendChain: number;
  rebaseChain: number;
  trailingTokens: number;
  saving: number;
  appendTotal?: number;
  rebaseTotal?: number;
  method: "usage-residual" | "chain-only";
  estimateReason?: string;
}

export interface ChainDecision extends ChainProjection {
  rebase: boolean;
  reason: string;
  chainThreshold: number;
  contextThreshold?: number;
  minimumSaving: number;
  capacity?: number;
  insufficientRecovery: boolean;
}

/** Estimate actual provider-visible content, including host summary wrappers. */
const visibleTokens = (messages: any[]): number =>
  convertToLlm(messages).reduce((total, message) => total + estimateTokens(message), 0);

export function projectChainTokens(
  input: BuildAppendOnlyDetailsInput,
  append: PiVccCompactionDetailsV2,
  rebase: PiVccCompactionDetailsV2,
): ChainProjection {
  const entries = input.branchEntries;
  // Synthetic checkpoint is local only. Both candidates use the same current cut.
  let id = "blackhole-candidate";
  while (entries.some((entry) => entry.id === id)) id += "-";
  const candidateBranch = (details: PiVccCompactionDetailsV2): SessionEntryLike[] => [
    ...entries,
    {
      id,
      parentId: entries.at(-1)?.id ?? null,
      type: "compaction",
      timestamp: 0,
      firstKeptEntryId: input.currentCoverage.firstKeptEntryId,
      summary: "blackhole candidate fallback",
      tokensBefore: input.tokensBefore,
      details,
    },
  ];
  const projected = (details: PiVccCompactionDetailsV2) =>
    projectAppendOnlyContext(
      [{ role: "compactionSummary", summary: "blackhole candidate fallback" }],
      candidateBranch(details),
    );
  const appendMessages = projected(append);
  const rebaseMessages = projected(rebase);
  const appendChain = visibleTokens(
    appendMessages.filter((message) => message.role === "compactionSummary"),
  );
  const rebaseChain = visibleTokens(
    rebaseMessages.filter((message) => message.role === "compactionSummary"),
  );
  const result: ChainProjection = {
    appendChain,
    rebaseChain,
    saving: appendChain - rebaseChain,
    trailingTokens: visibleTokens(appendMessages.filter((message) => message.role === "custom")),
    method: "chain-only",
  };
  const unknown = (estimateReason: string): ChainProjection => ({
    ...result,
    estimateReason,
  });
  const latest = findLatestCompactionEntry(entries);
  if (!latest) return unknown("no-prior-compaction");
  if (!input.model?.provider || !input.model.id) return unknown("missing-model-identity");

  const indexes = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (!entry.id || indexes.has(entry.id) || entry.parentId !== (entries[i - 1]?.id ?? null)) {
      return unknown("incomplete-branch");
    }
    indexes.set(entry.id, i);
    if (
      entry.type === "compaction" &&
      (typeof entry.summary !== "string" ||
        typeof entry.firstKeptEntryId !== "string" ||
        (entry.firstKeptEntryId !== "" && (indexes.get(entry.firstKeptEntryId) ?? i) >= i))
    ) {
      return unknown("missing-compaction-boundary");
    }
  }
  const coverage = input.currentCoverage;
  const first = indexes.get(coverage.firstCoveredEntryId);
  const last = indexes.get(coverage.lastCoveredEntryId);
  const kept =
    coverage.firstKeptEntryId === "" ? entries.length : indexes.get(coverage.firstKeptEntryId);
  if (
    first === undefined ||
    last === undefined ||
    kept === undefined ||
    last < first ||
    kept <= last ||
    entries[first]?.type !== "message" ||
    entries[last]?.type !== "message" ||
    entries.slice(first, last + 1).filter((entry) => entry.type === "message").length !==
      coverage.sourceMessageCount
  ) {
    return unknown("missing-current-coverage");
  }
  const latestIndex = indexes.get(latest.id!)!;
  let baselineIndex = -1;
  let usage: number | undefined;
  for (let i = entries.length - 1; i > latestIndex; i--) {
    usage = getUsageTokens(entries[i]?.message);
    if (usage !== undefined) {
      baselineIndex = i;
      break;
    }
  }
  if (baselineIndex < 0 || usage === undefined) return unknown("no-trusted-usage-after-compaction");
  const baselineMessage = entries[baselineIndex]!.message as {
    provider?: string;
    model?: string;
  };
  if (
    baselineMessage.provider !== input.model.provider ||
    baselineMessage.model !== input.model.id
  ) {
    return unknown("incompatible-model");
  }
  // A model switch after the baseline makes its fixed overhead untrustworthy.
  for (const entry of entries.slice(baselineIndex + 1)) {
    if (
      entry.type === "model_change" &&
      (entry.provider !== input.model.provider || entry.modelId !== input.model.id)
    ) {
      return unknown("incompatible-model");
    }
  }
  const contextTokens = (branch: SessionEntryLike[]) => {
    const messages = buildSessionContext(branch as SessionEntry[]).messages;
    let projected = projectAppendOnlyContext(messages, branch);
    const latest = findLatestCompactionEntry(branch);
    if (isPiVccCompactionDetailsV2(latest?.details) && projected === messages) {
      return visibleTokens(messages);
    }
    const persisted = (latest?.details as { retainedToolOutputProjection?: unknown } | undefined)
      ?.retainedToolOutputProjection;
    if (isRetainedToolOutputProjection(persisted)) {
      projected = applyRetainedToolOutputProjection(projected, branch, persisted);
    }
    return visibleTokens(projected);
  };
  try {
    // Usage already includes baseline assistant output. Include it here exactly once.
    const residual = usage - contextTokens(entries.slice(0, baselineIndex + 1));
    if (!Number.isFinite(residual) || residual < 0) return unknown("invalid-fixed-residual");
    const appendTotal = residual + contextTokens(candidateBranch(append));
    const rebaseTotal = residual + contextTokens(candidateBranch(rebase));
    if (!Number.isFinite(appendTotal) || !Number.isFinite(rebaseTotal))
      return unknown("invalid-candidate-total");
    return { ...result, appendTotal, rebaseTotal, method: "usage-residual" };
  } catch {
    return unknown("context-reconstruction-failed");
  }
}

/** Internal first-trial policy; never schedules a compaction or changes cadence. */
export function decideChainRebase(
  projection: ChainProjection,
  input: Pick<
    BuildAppendOnlyDetailsInput,
    "manualRebase" | "contextWindowTokens" | "reserveTokens" | "overflow"
  >,
): ChainDecision {
  const supplied = input.contextWindowTokens;
  const window =
    supplied !== undefined && Number.isFinite(supplied) && supplied > 0 ? supplied : undefined;
  const chainThreshold = window === undefined ? 34000 : Math.floor(window / 8);
  const contextThreshold = window === undefined ? undefined : Math.floor(window / 2);
  const minimumSaving =
    window === undefined
      ? 24000
      : Math.max(1, Math.min(24000, Math.floor((24000 * window) / 272000)));
  const capacity =
    window !== undefined &&
    input.reserveTokens !== undefined &&
    Number.isFinite(input.reserveTokens) &&
    input.reserveTokens >= 0
      ? window - input.reserveTokens
      : undefined;
  const capacityPressure =
    capacity !== undefined &&
    projection.appendTotal !== undefined &&
    projection.appendTotal > capacity;
  const pressure =
    projection.appendChain > chainThreshold ||
    (contextThreshold !== undefined &&
      projection.appendTotal !== undefined &&
      projection.appendTotal > contextThreshold);
  let rebase = false;
  let reason: string;
  if (input.manualRebase) {
    rebase = true;
    reason = "manual-rebase";
  } else if (input.overflow || capacityPressure) {
    rebase = projection.saving > 0;
    reason = rebase
      ? input.overflow
        ? "overflow-smaller-rebase"
        : "capacity-smaller-rebase"
      : "ineffective-reduction";
  } else if (pressure && projection.saving >= minimumSaving) {
    rebase = true;
    reason = "pressure-useful-saving";
  } else {
    reason =
      projection.saving <= 0
        ? "ineffective-reduction"
        : pressure
          ? "insufficient-saving"
          : "below-pressure";
  }
  const selectedTotal = rebase ? projection.rebaseTotal : projection.appendTotal;
  return {
    ...projection,
    rebase,
    reason,
    chainThreshold,
    contextThreshold,
    minimumSaving,
    capacity,
    insufficientRecovery:
      capacity !== undefined && selectedTotal !== undefined && selectedTotal > capacity,
  };
}

export const findLatestCompactionEntry = (
  branchEntries: SessionEntryLike[],
): SessionEntryLike | undefined => {
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    if (branchEntries[index]?.type === "compaction") {
      return branchEntries[index];
    }
  }
  return undefined;
};

/**
 * Read the active append chain from the current root-first Pi branch.
 * Any version or sequence gap fails closed, so the normal fallback summary stays active.
 */
export function collectActiveSegments(branchEntries: SessionEntryLike[]): ActiveSegmentChain {
  let latestIndex = -1;
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    if (branchEntries[index]?.type === "compaction") {
      latestIndex = index;
      break;
    }
  }
  if (latestIndex < 0) return { ok: false, reason: "no-compaction" };

  const latest = branchEntries[latestIndex];
  if (!isPiVccCompactionDetailsV2(latest?.details)) {
    return { ok: false, reason: "latest-not-append" };
  }

  const reversed: ActiveSegment[] = [];
  let expectedSequence = latest.details.segment.sequence;

  for (let index = latestIndex; index >= 0; index -= 1) {
    const entry = branchEntries[index];
    if (entry?.type !== "compaction") continue;
    if (!isPiVccCompactionDetailsV2(entry.details)) {
      return { ok: false, reason: "invalid-chain-entry" };
    }
    if (entry.details.segment.sequence !== expectedSequence) {
      return { ok: false, reason: "invalid-sequence" };
    }

    reversed.push({
      entry,
      details: entry.details,
      segment: entry.details.segment,
    });

    if (entry.details.chainStart) {
      if (entry.details.segment.sequence !== 1) {
        return { ok: false, reason: "invalid-sequence" };
      }
      return { ok: true, segments: reversed.reverse() };
    }

    expectedSequence -= 1;
    if (expectedSequence < 1) {
      return { ok: false, reason: "invalid-sequence" };
    }
  }

  return { ok: false, reason: "missing-chain-start" };
}

/**
 * Map selected session entry ids back to the covered branch window.
 * Matching is id-based so coverage survives serialization, cloning, or reloads.
 */
export function coverageForMessages(
  branchEntries: SessionEntryLike[],
  selectedIds: string[],
  firstKeptEntryId: string,
): PiVccSegmentCoverage | undefined {
  if (selectedIds.length === 0) return undefined;
  const wanted = new Set(selectedIds);
  // Duplicates would silently shrink the matched window — fail closed.
  if (wanted.size !== selectedIds.length) return undefined;
  const covered = branchEntries.filter(
    (entry) => entry.type === "message" && entry.id && wanted.has(entry.id),
  );
  if (covered.length !== wanted.size) return undefined;
  const first = covered[0]?.id;
  const last = covered[covered.length - 1]?.id;
  if (!first || !last) return undefined;
  return {
    firstCoveredEntryId: first,
    lastCoveredEntryId: last,
    firstKeptEntryId,
    sourceMessageCount: covered.length,
  };
}

const mergeRebaseCoverage = (
  activeSegments: ActiveSegment[],
  current: PiVccSegmentCoverage,
  legacyCompactionId?: string,
  markLegacy: boolean = Boolean(legacyCompactionId),
): PiVccSegmentCoverage => {
  const firstPrior = activeSegments[0]?.segment.coverage;
  const priorCount = activeSegments.reduce(
    (total, item) => total + item.segment.coverage.sourceMessageCount,
    0,
  );
  const inheritedLegacy = activeSegments.some(
    (item) => item.segment.coverage.includesLegacySummary === true,
  );
  const inheritedLegacyId = activeSegments
    .map((item) => item.segment.coverage.rebasedFromCompactionId)
    .find((id): id is string => typeof id === "string" && id.length > 0);

  return {
    firstCoveredEntryId: firstPrior?.firstCoveredEntryId ?? current.firstCoveredEntryId,
    lastCoveredEntryId: current.lastCoveredEntryId,
    firstKeptEntryId: current.firstKeptEntryId,
    sourceMessageCount: priorCount + current.sourceMessageCount,
    ...(inheritedLegacy || markLegacy ? { includesLegacySummary: true } : {}),
    ...(inheritedLegacyId || legacyCompactionId
      ? {
          rebasedFromCompactionId: inheritedLegacyId ?? legacyCompactionId,
        }
      : {}),
  };
};

export function renderSegmentCoverageMarker(
  sequence: number,
  coverage: PiVccSegmentCoverage,
): string {
  const firstKept = coverage.firstKeptEntryId || "<compact-all>";
  const legacy = coverage.includesLegacySummary
    ? `; legacySummary=true${
        coverage.rebasedFromCompactionId ? `; rebasedFrom=${coverage.rebasedFromCompactionId}` : ""
      }`
    : "";
  return [
    `[Blackhole Append Segment ${sequence}]`,
    `Coverage: ${coverage.firstCoveredEntryId}..${coverage.lastCoveredEntryId}; firstKept=${firstKept}; sourceMessages=${coverage.sourceMessageCount}${legacy}`,
    "Read segments in sequence. Later segments override earlier conflicting state.",
  ].join("\n");
}

const createSegment = (
  sequence: number,
  vccSummary: string,
  coverage: PiVccSegmentCoverage,
  tokensBefore: number,
): PiVccSegment => {
  const content = vccSummary.trim();
  if (!content) throw new Error("append segment summary is empty");
  return {
    sequence,
    summary: `${renderSegmentCoverageMarker(sequence, coverage)}\n\n${content}`,
    coverage,
    tokensBefore,
  };
};

/**
 * Build the version-2 details for one compaction.
 *
 * Automatic compaction appends when the prior chain is valid. Manual /blackhole
 * and a legacy checkpoint create one new chain-start segment. A malformed version-2
 * chain throws so the caller keeps the complete rewrite-compatible fallback.
 */
export function buildAppendOnlyDetails(input: BuildAppendOnlyDetailsInput): {
  details: PiVccCompactionDetailsV2;
  decision: ChainDecision;
} {
  const chain = collectActiveSegments(input.branchEntries);
  const latestCompaction = findLatestCompactionEntry(input.branchEntries);

  // A version-2 entry must always carry a complete fallback summary. A prior
  // compaction without preparation.previousSummary cannot meet that contract.
  if (latestCompaction && !input.previousSummaryUsed) {
    throw new Error("append compaction requires the previous complete fallback summary");
  }

  const latestDetails = latestCompaction?.details;
  const latestClaimsAppendOnly =
    typeof latestDetails === "object" &&
    latestDetails !== null &&
    ((latestDetails as Record<string, unknown>).version === 2 ||
      (latestDetails as Record<string, unknown>).summaryMode === "append");
  if (
    !chain.ok &&
    (chain.reason === "invalid-chain-entry" ||
      chain.reason === "invalid-sequence" ||
      chain.reason === "missing-chain-start" ||
      (chain.reason === "latest-not-append" && latestClaimsAppendOnly))
  ) {
    throw new Error(`append chain is invalid: ${chain.reason}`);
  }

  const activeSegments = chain.ok ? chain.segments : [];
  const inheritedOffChain = !chain.ok && input.previousSummaryUsed;
  const aggregateCoverage = mergeRebaseCoverage(
    activeSegments,
    input.currentCoverage,
    inheritedOffChain ? latestCompaction?.id : undefined,
    inheritedOffChain,
  );
  const detailsFor = (segment: PiVccSegment, chainStart: boolean): PiVccCompactionDetailsV2 => ({
    compactor: "blackhole",
    version: 2,
    summaryMode: "append",
    chainStart,
    segment,
    trailingSummary: input.trailingSummary,
    sections: input.sections,
    sourceMessageCount: input.currentCoverage.sourceMessageCount,
    previousSummaryUsed: input.previousSummaryUsed,
    ...(input.retainedToolOutputProjection
      ? { retainedToolOutputProjection: input.retainedToolOutputProjection }
      : {}),
  });
  const rebase = detailsFor(
    createSegment(1, input.aggregateSummary, aggregateCoverage, input.tokensBefore),
    true,
  );
  const append = chain.ok
    ? detailsFor(
        createSegment(
          activeSegments.at(-1)!.segment.sequence + 1,
          input.manualRebase && !input.freshSummary.trim()
            ? input.aggregateSummary
            : input.freshSummary,
          input.currentCoverage,
          input.tokensBefore,
        ),
        false,
      )
    : rebase;
  const projection = projectChainTokens(input, append, rebase);
  const decision = decideChainRebase(projection, input);
  if (!chain.ok) {
    decision.rebase = true;
    decision.reason = inheritedOffChain ? "legacy-chain-start" : "first-chain-start";
  }
  return { details: decision.rebase ? rebase : append, decision };
}

const timestampOf = (entry: SessionEntryLike, fallback: number): number => {
  if (typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)) {
    return entry.timestamp;
  }
  if (typeof entry.timestamp === "string") {
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

/**
 * Replace only the exact latest fallback summary. If any stored detail is
 * invalid, return the original messages unchanged.
 */
export function projectAppendOnlyContext(
  messages: any[],
  branchEntries: SessionEntryLike[],
): any[] {
  const latest = findLatestCompactionEntry(branchEntries);
  if (!latest || !isPiVccCompactionDetailsV2(latest.details)) return messages;
  if (typeof latest.summary !== "string") return messages;

  const chain = collectActiveSegments(branchEntries);
  if (!chain.ok) return messages;

  const fallbackIndexes = messages
    .map((message, index) =>
      message?.role === "compactionSummary" && message?.summary === latest.summary ? index : -1,
    )
    .filter((index) => index >= 0);
  if (fallbackIndexes.length !== 1) return messages;
  const fallbackIndex = fallbackIndexes[0]!;

  const segmentMessages = chain.segments.map((item, index) => ({
    role: "compactionSummary",
    summary: item.segment.summary,
    tokensBefore: item.segment.tokensBefore,
    timestamp: timestampOf(item.entry, index),
  }));

  const trailing = latest.details.trailingSummary.trim();
  const tailMessages = trailing
    ? [
        {
          role: "custom",
          customType: "blackhole-compaction-tail",
          content: trailing,
          display: false,
          details: { compactor: "blackhole", version: 2 },
          timestamp: timestampOf(latest, segmentMessages.length),
        },
      ]
    : [];

  return [
    ...messages.slice(0, fallbackIndex),
    ...segmentMessages,
    ...tailMessages,
    ...messages.slice(fallbackIndex + 1),
  ];
}
