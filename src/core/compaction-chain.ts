import type {
  PiVccCompactionDetailsV2,
  PiVccSegment,
  PiVccSegmentCoverage,
} from "../details.js";
import { isPiVccCompactionDetailsV2 } from "../details.js";
import { estimateEntryTokens, getUsageTokens } from "../om/tokens.js";

export interface SessionEntryLike {
  id?: string;
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
  /** Session model context window; when set, an overgrown chain auto-rebases. */
  contextWindowTokens?: number;
}

/** Auto-rebase once the projected injected chain passes this fraction of the window. */
export const MAX_CHAIN_WINDOW_RATIO = 0.5;

/** chars/4 estimate of the provider-visible chain plus the incoming segment content. */
export function estimateChainTokens(
  segments: ActiveSegment[],
  freshSummary: string,
  trailingSummary: string,
): number {
  const chars = segments.reduce(
    (total, item) => total + item.segment.summary.length,
    0,
  );
  return Math.ceil((chars + freshSummary.length + trailingSummary.length) / 4);
}

/** Source entry types counted toward context size (mirrors ledger progress). */
const SOURCE_ENTRY_TYPES = new Set([
  "message",
  "custom_message",
  "branch_summary",
]);

/**
 * Project the next provider-visible chain size for the growth governor.
 *
 * Anchors on the latest trusted provider usage when a valid assistant
 * response exists after the newest chain entry: its measured context already
 * contains every active segment plus system/tool/trailing overhead, so only
 * the covered range leaving context and the fresh segment entering it are
 * chars/4-estimated. Falls back to the plain estimate whenever no usable
 * usage baseline exists or the data is inconsistent.
 */
export function projectChainTokens(
  segments: ActiveSegment[],
  freshSummary: string,
  trailingSummary: string,
  branchEntries: SessionEntryLike[],
  coverage: Pick<
    PiVccSegmentCoverage,
    "firstCoveredEntryId" | "lastCoveredEntryId"
  >,
): number {
  const fallback = estimateChainTokens(segments, freshSummary, trailingSummary);
  const latestEntry = segments[segments.length - 1]?.entry;
  if (!latestEntry || segments.length === 0) return fallback;

  let latestIndex = -1;
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    if (branchEntries[index] === latestEntry) {
      latestIndex = index;
      break;
    }
  }
  if (latestIndex < 0) return fallback;

  let usageTokens: number | undefined;
  for (let index = branchEntries.length - 1; index > latestIndex; index -= 1) {
    const candidate = getUsageTokens(branchEntries[index]?.message);
    if (candidate !== undefined) {
      usageTokens = candidate;
      break;
    }
  }
  if (usageTokens === undefined) return fallback;

  let firstIndex = -1;
  let lastIndex = -1;
  for (let index = latestIndex + 1; index < branchEntries.length; index += 1) {
    const id = branchEntries[index]?.id;
    if (id === coverage.firstCoveredEntryId) firstIndex = index;
    if (id === coverage.lastCoveredEntryId) lastIndex = index;
  }
  if (firstIndex < 0 || lastIndex < firstIndex) return fallback;

  let coveredTokens = 0;
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    const entry = branchEntries[index];
    if (
      !entry ||
      typeof entry.type !== "string" ||
      !SOURCE_ENTRY_TYPES.has(entry.type)
    ) {
      continue;
    }
    const { type, message, summary } = entry;
    coveredTokens += estimateEntryTokens({ type, message, summary });
  }
  const projected =
    usageTokens - coveredTokens + Math.ceil(freshSummary.length / 4);
  if (!Number.isFinite(projected) || projected < 0) return fallback;
  return projected;
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
export function collectActiveSegments(
  branchEntries: SessionEntryLike[],
): ActiveSegmentChain {
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
    firstCoveredEntryId:
      firstPrior?.firstCoveredEntryId ?? current.firstCoveredEntryId,
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
        coverage.rebasedFromCompactionId
          ? `; rebasedFrom=${coverage.rebasedFromCompactionId}`
          : ""
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
export function buildAppendOnlyDetails(
  input: BuildAppendOnlyDetailsInput,
): PiVccCompactionDetailsV2 {
  const chain = collectActiveSegments(input.branchEntries);
  const latestCompaction = findLatestCompactionEntry(input.branchEntries);

  // A version-2 entry must always carry a complete fallback summary. A prior
  // compaction without preparation.previousSummary cannot meet that contract.
  if (latestCompaction && !input.previousSummaryUsed) {
    throw new Error(
      "append compaction requires the previous complete fallback summary",
    );
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

  const chainOvergrown =
    chain.ok &&
    input.contextWindowTokens !== undefined &&
    projectChainTokens(
      chain.segments,
      input.freshSummary,
      input.trailingSummary,
      input.branchEntries,
      input.currentCoverage,
    ) > Math.floor(input.contextWindowTokens * MAX_CHAIN_WINDOW_RATIO);

  const mustRebase = input.manualRebase || !chain.ok || chainOvergrown;
  let segment: PiVccSegment;
  let chainStart: boolean;

  if (mustRebase) {
    const activeSegments = chain.ok ? chain.segments : [];
    // A summary inherited from off-chain state (fork/branch switch, or a legacy
    // compaction outside the version-2 chain) must brand the new chain start,
    // even when no on-branch compaction entry exists to reference by id.
    const inheritedOffChain = !chain.ok && input.previousSummaryUsed;
    const legacyCompactionId =
      inheritedOffChain && latestCompaction?.id
        ? latestCompaction.id
        : undefined;
    const coverage = mergeRebaseCoverage(
      activeSegments,
      input.currentCoverage,
      legacyCompactionId,
      inheritedOffChain,
    );
    segment = createSegment(
      1,
      input.aggregateSummary,
      coverage,
      input.tokensBefore,
    );
    chainStart = true;
  } else {
    const last = chain.segments[chain.segments.length - 1];
    if (!last) throw new Error("append chain has no active segment");
    segment = createSegment(
      last.segment.sequence + 1,
      input.freshSummary,
      input.currentCoverage,
      input.tokensBefore,
    );
    chainStart = false;
  }

  return {
    compactor: "blackhole",
    version: 2,
    summaryMode: "append",
    chainStart,
    segment,
    trailingSummary: input.trailingSummary,
    sections: input.sections,
    sourceMessageCount: input.currentCoverage.sourceMessageCount,
    previousSummaryUsed: input.previousSummaryUsed,
  };
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
      message?.role === "compactionSummary" &&
      message?.summary === latest.summary
        ? index
        : -1,
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
