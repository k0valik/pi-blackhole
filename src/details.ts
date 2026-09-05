/**
 * Blackhole compaction details persisted in Pi session entries.
 *
 * Version 1 is the existing rewrite format. Version 2 stores one immutable
 * append segment plus the current mutable recall/OM suffix.
 */
import type { RetainedToolOutputProjection } from "./core/tool-output-budget.js";

export interface PiVccCompactionDetailsV1 {
  compactor: "blackhole";
  version: 1;
  sections: string[];
  sourceMessageCount: number;
  previousSummaryUsed: boolean;
  retainedToolOutputProjection?: RetainedToolOutputProjection;
}

export interface PiVccSegmentCoverage {
  /** First source message entry summarized by this segment. */
  firstCoveredEntryId: string;
  /** Last source message entry summarized by this segment. */
  lastCoveredEntryId: string;
  /** Pi entry kept immediately after the covered range. Empty means compact-all. */
  firstKeptEntryId: string;
  /** Number of source messages represented by this segment. */
  sourceMessageCount: number;
  /** True when a legacy aggregate summary was folded into this chain start. */
  includesLegacySummary?: boolean;
  /** Real session compaction entry whose legacy summary was folded in. */
  rebasedFromCompactionId?: string;
}

export interface PiVccSegment {
  /** One-based position inside the current append chain. */
  sequence: number;
  /** Final provider-visible segment content. Never rewrite this after creation. */
  summary: string;
  coverage: PiVccSegmentCoverage;
  /** Token count recorded when this segment was created. */
  tokensBefore: number;
}

export interface PiVccCompactionDetailsV2 {
  compactor: "blackhole";
  version: 2;
  summaryMode: "append";
  /** True when this compaction replaces the active chain with one clean segment. */
  chainStart: boolean;
  segment: PiVccSegment;
  /** Current recall note plus current observational-memory projection. */
  trailingSummary: string;
  sections: string[];
  sourceMessageCount: number;
  previousSummaryUsed: boolean;
  retainedToolOutputProjection?: RetainedToolOutputProjection;
}

export type PiVccCompactionDetails = PiVccCompactionDetailsV1 | PiVccCompactionDetailsV2;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Fail-closed validator for persisted append details. */
export function isPiVccCompactionDetailsV2(value: unknown): value is PiVccCompactionDetailsV2 {
  if (!isRecord(value)) return false;
  if (
    value.compactor !== "blackhole" ||
    value.version !== 2 ||
    value.summaryMode !== "append" ||
    typeof value.chainStart !== "boolean" ||
    typeof value.trailingSummary !== "string" ||
    !isStringArray(value.sections) ||
    !Number.isInteger(value.sourceMessageCount) ||
    (value.sourceMessageCount as number) < 1 ||
    typeof value.previousSummaryUsed !== "boolean"
  ) {
    return false;
  }

  if (!isRecord(value.segment)) return false;
  const segment = value.segment;
  if (
    !Number.isInteger(segment.sequence) ||
    (segment.sequence as number) < 1 ||
    typeof segment.summary !== "string" ||
    segment.summary.trim().length === 0 ||
    !Number.isFinite(segment.tokensBefore) ||
    (segment.tokensBefore as number) < 0 ||
    !isRecord(segment.coverage)
  ) {
    return false;
  }

  const sequence = segment.sequence as number;
  if ((value.chainStart && sequence !== 1) || (!value.chainStart && sequence === 1)) {
    return false;
  }

  const coverage = segment.coverage;
  if (
    typeof coverage.firstCoveredEntryId !== "string" ||
    coverage.firstCoveredEntryId.length === 0 ||
    typeof coverage.lastCoveredEntryId !== "string" ||
    coverage.lastCoveredEntryId.length === 0 ||
    typeof coverage.firstKeptEntryId !== "string" ||
    !Number.isInteger(coverage.sourceMessageCount) ||
    (coverage.sourceMessageCount as number) < 1
  ) {
    return false;
  }
  if (
    coverage.includesLegacySummary !== undefined &&
    typeof coverage.includesLegacySummary !== "boolean"
  ) {
    return false;
  }
  if (
    coverage.rebasedFromCompactionId !== undefined &&
    (typeof coverage.rebasedFromCompactionId !== "string" ||
      coverage.rebasedFromCompactionId.length === 0)
  ) {
    return false;
  }

  return true;
}
