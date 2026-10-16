/**
 * Chronological timeline renderer — the incremental-export alternative to
 * the distilled export in `format-export.ts`.
 *
 * Deliberately bypassed: relevance scoring, recency decay, recurrence
 * boosting, consensus rerank, coverage boosting, viability gate, fuzzy
 * clustering, reflection-wins suppression, topic discovery. An observation
 * never moves earlier because an algorithm finds it important.
 *
 * Retained: project attribution, pending/orphan attribution, dropper
 * exclusion (timeless, identical to distilled), UTC ISO display/grouping,
 * deterministic ordering, exact-duplicate collapsing, relevance-as-metadata,
 * observation/reflection distinction, session provenance.
 *
 * Zero pi imports: this module stays unit-testable and lazy-import-safe.
 */
import type { ProjectCorpus } from "./corpus.js";

export interface TimelineExportStats {
  sessionsDiscovered: number;
  /** Project session files fully parsed (= corpus.sessionsConsidered). */
  sessionsScanned: number;
  filesWithMarkers: number;
  observationsExported: number;
  reflectionsExported: number;
  /** Exact-duplicate members folded into representatives. */
  duplicatesCollapsed: number;
  entriesOutsideWindow: number;
  entriesWithoutTimestamp: number;
  /** Dropper-pruned id count (= corpus.droppedIds.size). */
  droppedExcluded: number;
  orphanedObservations: number;
  orphanedReflections: number;
  orphanedSessions: number;
  /** "all history" or "<sinceISO> → <untilISO>". */
  windowLabel: string;
}

export interface TimelineExportOptions {
  now?: number;
  title?: string;
  sinceMs?: number;
  untilMs?: number;
}

/** Collapse runs of whitespace (mirrors the distilled renderer's flatten). */
function flatten(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

/** Resolved timestamp in ms, or null when missing/unparseable (never throws). */
function resolveMs(timestamp: string | null): number | null {
  if (timestamp == null) return null;
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? null : ms;
}

/** Byte-stable string comparison (no locale dependence in tie-breaks). */
function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

type TimelineKind = "observation" | "reflection";

const KIND_RANK: Record<TimelineKind, number> = { observation: 0, reflection: 1 };

interface TimelineMember {
  /** Absolute timestamp in ms; null when the entry has no usable timestamp. */
  ms: number | null;
  sessionId: string;
  /** True for orphan-pending entries (inline `(orphan session …)` provenance). */
  orphan: boolean;
  /** Observation relevance tier (badge metadata only); null for reflections. */
  relevance: string | null;
}

interface TimelineGroup {
  kind: TimelineKind;
  /** Raw content; the group key is `kind + "\0" + content` (raw `===`). */
  content: string;
  members: TimelineMember[];
  /** Earliest absolute timestamp in ms; null when every member is timeless. */
  earliestMs: number | null;
  /** Canonical UTC ISO form of earliestMs; null for fully-timeless groups. */
  earliestIso: string | null;
  /** Session of the earliest member (ties broken by session id). */
  repSessionId: string;
  /** Orphan flag of the earliest member. */
  repOrphan: boolean;
  /** Relevance of the earliest observation member; null for reflections. */
  repRelevance: string | null;
  occurrences: number;
  distinctSessions: number;
}

function windowLabelFor(sinceMs?: number, untilMs?: number): string {
  if (sinceMs == null && untilMs == null) return "all history";
  const since = sinceMs != null ? new Date(sinceMs).toISOString() : "beginning";
  const until = untilMs != null ? new Date(untilMs).toISOString() : "now";
  return `${since} → ${until}`;
}

/**
 * Exact-only grouping on raw content identity. The Map key holds the
 * original string untouched: no lowercasing, no punctuation/whitespace
 * normalization, no length cap. Observations and reflections carry
 * different kind prefixes and never collapse into each other.
 */
function toGroups(corpus: ProjectCorpus): { timed: TimelineGroup[]; unknown: TimelineGroup[] } {
  const byKey = new Map<
    string,
    { kind: TimelineKind; content: string; members: TimelineMember[] }
  >();
  // Dropper exclusion identical to distilled: unlinkable (id-less)
  // observations can never match a drop marker and always survive.
  // Reflections carry no observation-id linkage, so markers never apply.
  const collect = (
    kind: TimelineKind,
    content: string,
    timestamp: string | null,
    sessionId: string,
    orphan: boolean,
    relevance: string | null,
  ): void => {
    const key = `${kind}\0${content}`;
    let group = byKey.get(key);
    if (!group) {
      group = { kind, content, members: [] };
      byKey.set(key, group);
    }
    group.members.push({ ms: resolveMs(timestamp), sessionId, orphan, relevance });
  };
  for (const o of corpus.observations) {
    if (o.id && corpus.droppedIds.has(o.id)) continue;
    collect("observation", o.content, o.timestamp, o.sessionId, o.source === "orphan", o.relevance);
  }
  for (const r of corpus.reflections) {
    collect("reflection", r.content, r.timestamp, r.sessionId, r.source === "orphan", null);
  }

  const timed: TimelineGroup[] = [];
  const unknown: TimelineGroup[] = [];
  for (const { kind, content, members } of byKey.values()) {
    // The representative is the earliest member (timestamp, then session
    // id): the group renders once, at its earliest timestamp, with the
    // earliest occurrence's session provenance and relevance badge.
    const ranked = [...members].sort(
      (a, b) =>
        (a.ms ?? Number.POSITIVE_INFINITY) - (b.ms ?? Number.POSITIVE_INFINITY) ||
        compareBytes(a.sessionId, b.sessionId),
    );
    const rep = ranked[0];
    const earliestMs = rep.ms;
    const sessions = new Set(members.map((m) => m.sessionId));
    const group: TimelineGroup = {
      kind,
      content,
      members,
      earliestMs,
      earliestIso: earliestMs == null ? null : new Date(earliestMs).toISOString(),
      repSessionId: rep.sessionId,
      repOrphan: rep.orphan,
      repRelevance: rep.relevance,
      occurrences: members.length,
      distinctSessions: sessions.size,
    };
    (earliestMs == null ? unknown : timed).push(group);
  }
  // Chronological stream, ascending. Deterministic tie-breaks with no
  // extraction ordinal: timestamp → session id → kind → content.
  const byTime = (a: TimelineGroup, b: TimelineGroup): number =>
    (a.earliestMs as number) - (b.earliestMs as number) ||
    compareBytes(a.repSessionId, b.repSessionId) ||
    KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
    compareBytes(a.content, b.content);
  // Timestamp-less groups render last, ordered by the same tie-breaks
  // from session id onward.
  const byUnknown = (a: TimelineGroup, b: TimelineGroup): number =>
    compareBytes(a.repSessionId, b.repSessionId) ||
    KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
    compareBytes(a.content, b.content);
  timed.sort(byTime);
  unknown.sort(byUnknown);
  return { timed, unknown };
}

function renderBullet(g: TimelineGroup): string {
  const badge =
    g.kind === "observation" ? `**[observation/${g.repRelevance}]**` : "**[reflection]**";
  const provenance = g.repOrphan
    ? `(orphan session ${g.repSessionId})`
    : `(session ${g.repSessionId})`;
  // HH:MM:SS in UTC (slice(11, 19) drops the ".sss" millis tail).
  // Unknown-section bullets omit the time part (there is nothing to show).
  const time = g.earliestIso != null ? `\`${g.earliestIso.slice(11, 19)}Z\` ` : "";
  const meta: string[] = [];
  if (g.distinctSessions > 1) meta.push(`across ${g.distinctSessions} sessions`);
  if (g.occurrences > 1) meta.push(`recorded ${g.occurrences}×`);
  const suffix = meta.length > 0 ? ` *(${meta.join(" · ")})*` : "";
  return `- ${time}${badge} \`${provenance}\` ${flatten(g.content)}${suffix}`;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

export function buildTimelineExportMarkdown(
  corpus: ProjectCorpus,
  opts?: TimelineExportOptions,
): { markdown: string; stats: TimelineExportStats } {
  const now = opts?.now ?? Date.now();
  const title =
    opts?.title ?? corpus.projectRoot.split("/").filter(Boolean).pop() ?? corpus.projectRoot;
  const windowLabel = windowLabelFor(opts?.sinceMs, opts?.untilMs);

  const { timed, unknown } = toGroups(corpus);

  const sections: string[] = [];
  let currentDay = "";
  let dayLines: string[] = [];
  const flushDay = (): void => {
    if (dayLines.length > 0) sections.push([`## ${currentDay}`, "", ...dayLines, ""].join("\n"));
    dayLines = [];
  };
  for (const g of timed) {
    const day = (g.earliestIso as string).slice(0, 10);
    if (day !== currentDay) {
      flushDay();
      currentDay = day;
    }
    dayLines.push(renderBullet(g));
  }
  flushDay();

  if (unknown.length > 0) {
    sections.push(["## Unknown timestamp", "", ...unknown.map(renderBullet), ""].join("\n"));
  }

  const notes: string[] = [];
  if (opts?.sinceMs != null) {
    notes.push(
      "- This export is a rolling snapshot, not exactly-once replication: the still-active session stays excluded and its memory can age out of the window before it becomes eligible.",
    );
  }
  if (corpus.droppedIds.size > 0) {
    notes.push(
      `- ${corpus.droppedIds.size} observation ids were pruned by the dropper pipeline; entries carrying those ids are excluded from this export.`,
    );
  }
  if (notes.length > 0) {
    sections.push(["## Notes", "", ...notes, ""].join("\n"));
  }

  const countKind = (groups: TimelineGroup[], kind: TimelineKind): number =>
    groups.filter((g) => g.kind === kind).length;
  const memberCount = (groups: TimelineGroup[]): number =>
    groups.reduce((n, g) => n + g.occurrences, 0);
  const stats: TimelineExportStats = {
    sessionsDiscovered: corpus.sessionsDiscovered,
    sessionsScanned: corpus.sessionsConsidered,
    filesWithMarkers: corpus.filesWithMarkers,
    observationsExported: countKind(timed, "observation") + countKind(unknown, "observation"),
    reflectionsExported: countKind(timed, "reflection") + countKind(unknown, "reflection"),
    duplicatesCollapsed: memberCount(timed) + memberCount(unknown) - timed.length - unknown.length,
    entriesOutsideWindow: corpus.entriesOutsideWindow,
    entriesWithoutTimestamp: corpus.entriesWithoutTimestamp,
    droppedExcluded: corpus.droppedIds.size,
    orphanedObservations: corpus.observations.filter(
      (o) => o.source === "orphan" && (!o.id || !corpus.droppedIds.has(o.id)),
    ).length,
    orphanedReflections: corpus.reflections.filter((r) => r.source === "orphan").length,
    orphanedSessions: corpus.orphanedSessions,
    windowLabel,
  };

  const header = [
    `# Project memory timeline — ${title}`,
    "",
    `_Generated ${new Date(now).toISOString().slice(0, 16).replace("T", " ")} UTC_`,
    `_Window: ${windowLabel}_`,
    `_Mode: chronological · exact duplicates only_`,
    "",
  ].join("\n");

  return { markdown: header + sections.join("\n"), stats };
}

export async function buildTimelineExportMarkdownAsync(
  corpus: ProjectCorpus,
  opts?: TimelineExportOptions,
): Promise<{ markdown: string; stats: TimelineExportStats }> {
  // Yield around the render so the TUI can paint (same pattern as
  // buildExportMarkdownAsync). The timeline pass is linear (no similarity
  // clustering), so boundary yields suffice.
  await yieldToEventLoop();
  const result = buildTimelineExportMarkdown(corpus, opts);
  await yieldToEventLoop();
  return result;
}
