/**
 * Project memory corpus — walks past-session JSONL files + OM pending buffers
 * and extracts the observational-memory corpus for project-wide features
 * (export now, project recall later).
 *
 * Design receipts: work_docs/plan-07-project-recall.md §17, §19.
 *
 * Walk strategy (one scope folder = one project):
 *  1. Candidate selection visits ONLY the cwd-encoded scope dir under
 *     ~/.pi/agent/sessions/ plus, when different, the git-root-encoded dir —
 *     sessions from other projects are never opened.
 *  2. Attributed files get a cheap substring prefilter (`om.`) before any
 *     JSON line parsing — marker-less sessions cost one buffered read.
 *  3. Compaction NEVER removes entries (append-only trees, verified in §19.2):
 *     whole-file scanning sees the full history; only the actively-written
 *     session file is excluded (race safety, D7).
 */
import {
  existsSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  OM_OBSERVATIONS_RECORDED,
  OM_REFLECTIONS_RECORDED,
  OM_OBSERVATIONS_DROPPED,
  RELEVANCE_VALUES,
  type Relevance,
} from "../om/ledger/types.js";

const LEGACY_OM_OBSERVATION = "om.observation";
const PENDING_DIR = "pi-blackhole";
const PENDING_SUFFIX = "-pending.json";
const STALE_SUFFIX = "-pending.stale.json";
const HEADER_CHUNK = 4096;
const HEADER_MAX = 65536;

export type MemorySource = "branch" | "pending" | "orphan";

export interface CorpusObservation {
  /** Observation memory id (12-hex) when present — links against droppedIds. */
  id: string | null;
  content: string;
  relevance: Relevance;
  /** Observation-local timestamp when parseable, else null. */
  timestamp: string | null;
  sessionId: string;
  source: MemorySource;
}

export interface CorpusReflection {
  content: string;
  supportingObservationIds: string[];
  timestamp: string | null;
  sessionId: string;
  source: MemorySource;
}

export interface ProjectCorpus {
  projectRoot: string;
  /** Attributed session files inspected (marker-bearing + marker-less). */
  sessionsConsidered: number;
  /** Attributed session files that actually carried om markers. */
  filesWithMarkers: number;
  observations: CorpusObservation[];
  reflections: CorpusReflection[];
  droppedIds: Set<string>;
  /** Session ids seen in attributed project files (for pending attribution). */
  knownSessionIds: Set<string>;
  /** Pending-buffer sessions that no longer exist on disk. */
  orphanedSessions: number;
}

/**
 * pi's exact session-scope encoding: /home/u/proj → --home-u-proj--
 * (leading slash stripped, separators/colons → single dash, double-dash wrap).
 */
export function encodeScopeDir(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export interface BuildCorpusOptions {
  /** Launch directory whose scope folder identifies "the project". */
  cwd: string;
  /** Enclosing git root when available — scanned as a secondary candidate. */
  gitRoot?: string | null;
  /** Actively-written session file to exclude (D7 race safety). */
  activeSessionFile?: string;
  agentDir?: string;
}

function normalizeRelevance(value: unknown): Relevance {
  return typeof value === "string" &&
    (RELEVANCE_VALUES as readonly string[]).includes(value)
    ? (value as Relevance)
    : "low";
}

function parseTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  if (Number.isNaN(Date.parse(value))) {
    // Legacy format: "2026-05-11 19:01" (no timezone/seconds)
    const patched = value.replace(" ", "T") + ":00Z";
    return Number.isNaN(Date.parse(patched)) ? null : patched;
  }
  return value;
}

/** Read just the first line of a file (the session header). */
function readFirstLine(filePath: string): string | null {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(HEADER_MAX);
    let total = 0;
    while (total < HEADER_MAX) {
      const n = readSync(
        fd,
        buf,
        total,
        Math.min(HEADER_CHUNK, HEADER_MAX - total),
        total,
      );
      if (n <= 0) break;
      const slice = buf.subarray(total, total + n);
      const nl = slice.indexOf(0x0a);
      if (nl !== -1) return buf.subarray(0, total + nl).toString("utf-8");
      total += n;
    }
    return total > 0 ? buf.subarray(0, total).toString("utf-8") : null;
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* best-effort */
    }
  }
}

interface SessionHeaderInfo {
  id: string;
  cwd: string | null;
}

function parseSessionHeader(line: string | null): SessionHeaderInfo | null {
  if (!line) return null;
  try {
    const header = JSON.parse(line);
    if (header?.type !== "session") return null;
    return {
      id: typeof header.id === "string" ? header.id : "",
      cwd: typeof header.cwd === "string" ? header.cwd : null,
    };
  } catch {
    return null;
  }
}

interface RawMarkerData {
  observations?: Array<{
    content?: unknown;
    relevance?: unknown;
    timestamp?: unknown;
  }>;
  records?: Array<{
    content?: unknown;
    relevance?: unknown;
    timestamp?: unknown;
  }>;
  reflections?: Array<{
    content?: unknown;
    supportingObservationIds?: unknown;
  }>;
  observationIds?: unknown;
}

function extractFromEntries(
  entries: Array<Record<string, unknown>>,
  sessionId: string,
  observations: CorpusObservation[],
  reflections: CorpusReflection[],
  droppedIds: Set<string>,
): void {
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    const customType = entry.customType;
    const data = (entry.data ?? {}) as RawMarkerData;
    const entryTs = parseTimestamp(entry.timestamp);
    if (
      customType === OM_OBSERVATIONS_RECORDED ||
      customType === LEGACY_OM_OBSERVATION
    ) {
      const list =
        customType === LEGACY_OM_OBSERVATION
          ? (data.records ?? [])
          : (data.observations ?? []);
      for (const o of list) {
        if (typeof o.content !== "string" || !o.content.trim()) continue;
        observations.push({
          id:
            typeof (o as { id?: unknown }).id === "string"
              ? ((o as { id: string }).id as string)
              : null,
          content: o.content,
          relevance: normalizeRelevance(o.relevance),
          timestamp: parseTimestamp(o.timestamp) ?? entryTs,
          sessionId,
          source: "branch",
        });
      }
    } else if (customType === OM_REFLECTIONS_RECORDED) {
      for (const r of data.reflections ?? []) {
        if (typeof r.content !== "string" || !r.content.trim()) continue;
        reflections.push({
          content: r.content,
          supportingObservationIds: Array.isArray(r.supportingObservationIds)
            ? (r.supportingObservationIds as string[])
            : [],
          timestamp: entryTs,
          sessionId,
          source: "branch",
        });
      }
    } else if (customType === OM_OBSERVATIONS_DROPPED) {
      if (Array.isArray(data.observationIds)) {
        for (const id of data.observationIds) {
          if (typeof id === "string") droppedIds.add(id);
        }
      }
    }
  }
}

interface PendingBatch {
  data?: RawMarkerData;
}

interface PendingState {
  observationBatches?: PendingBatch[];
  reflectionBatches?: PendingBatch[];
  droppedBatches?: PendingBatch[];
}

function extractFromPendingState(
  state: PendingState,
  sessionId: string,
  source: MemorySource,
  observations: CorpusObservation[],
  reflections: CorpusReflection[],
  droppedIds: Set<string>,
): void {
  for (const batch of state.observationBatches ?? []) {
    for (const o of batch.data?.observations ?? []) {
      if (typeof o.content !== "string" || !o.content.trim()) continue;
      observations.push({
        id:
          typeof (o as { id?: unknown }).id === "string"
            ? ((o as { id: string }).id as string)
            : null,
        content: o.content,
        relevance: normalizeRelevance(o.relevance),
        timestamp: parseTimestamp(o.timestamp),
        sessionId,
        source,
      });
    }
  }
  for (const batch of state.reflectionBatches ?? []) {
    for (const r of batch.data?.reflections ?? []) {
      if (typeof r.content !== "string" || !r.content.trim()) continue;
      reflections.push({
        content: r.content,
        supportingObservationIds: Array.isArray(r.supportingObservationIds)
          ? (r.supportingObservationIds as string[])
          : [],
        timestamp: null,
        sessionId,
        source,
      });
    }
  }
  for (const batch of state.droppedBatches ?? []) {
    if (Array.isArray(batch.data?.observationIds)) {
      for (const id of batch.data.observationIds as unknown[]) {
        if (typeof id === "string") droppedIds.add(id);
      }
    }
  }
}

/**
 * Build the observational-memory corpus for one project.
 * Scoping: one scope folder = one project (plan-07 §19.5 author note) — the
 * cwd-encoded scope dir is primary; the git-root-encoded dir is a secondary
 * candidate when it differs (catches sessions launched from the repo root).
 * Sync by design — bounded by those project-owned files only.
 */
export function buildProjectMemoryCorpus(
  options: BuildCorpusOptions,
): ProjectCorpus {
  const agentDir = options.agentDir ?? getAgentDir();
  const projectRoot = options.gitRoot || options.cwd;
  const activeSessionFile = options.activeSessionFile
    ? existsSync(options.activeSessionFile)
      ? options.activeSessionFile
      : undefined
    : undefined;

  const corpus: ProjectCorpus = {
    projectRoot,
    sessionsConsidered: 0,
    filesWithMarkers: 0,
    observations: [],
    reflections: [],
    droppedIds: new Set<string>(),
    knownSessionIds: new Set<string>(),
    orphanedSessions: 0,
  };

  const candidateDirs = [
    ...new Set([
      encodeScopeDir(options.cwd),
      ...(options.gitRoot && options.gitRoot !== options.cwd
        ? [encodeScopeDir(options.gitRoot)]
        : []),
    ]),
  ].map((scope) => join(agentDir, "sessions", scope));
  const seenFiles = new Set<string>();

  for (const scopeDir of candidateDirs) {
    let files: string[];
    try {
      if (!statSync(scopeDir).isDirectory()) continue;
      files = readdirSync(scopeDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      if (seenFiles.has(file)) continue;
      seenFiles.add(file);
      const filePath = join(scopeDir, file);
      if (activeSessionFile && filePath === activeSessionFile) continue;

      corpus.sessionsConsidered++;
      const header = parseSessionHeader(readFirstLine(filePath));
      const sessionId = header?.id || file.slice(0, -6);
      corpus.knownSessionIds.add(sessionId);

      let raw: string;
      try {
        raw = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      if (!raw.includes("om.")) continue;
      corpus.filesWithMarkers++;

      const entries: Array<Record<string, unknown>> = [];
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          entries.push(JSON.parse(trimmed));
        } catch {
          // corrupt lines are silently dropped by pi too
        }
      }
      extractFromEntries(
        entries,
        sessionId,
        corpus.observations,
        corpus.reflections,
        corpus.droppedIds,
      );
    }
  }

  // Phase 2b: pending buffers, attributed or orphaned
  const pendingDir = join(agentDir, PENDING_DIR);
  if (existsSync(pendingDir)) {
    let files: string[];
    try {
      files = readdirSync(pendingDir);
    } catch {
      files = [];
    }
    const mains = new Set<string>();
    for (const file of files) {
      if (file.endsWith(PENDING_SUFFIX)) {
        mains.add(file.slice(0, -PENDING_SUFFIX.length));
      }
    }
    for (const file of files) {
      const isMain = file.endsWith(PENDING_SUFFIX);
      const isStale = file.endsWith(STALE_SUFFIX);
      if (!isMain && !isStale) continue;
      const sessionId = isMain
        ? file.slice(0, -PENDING_SUFFIX.length)
        : file.slice(0, -STALE_SUFFIX.length);
      if (!sessionId) continue;
      // Prefer the main file; only fall back to the stale backup when absent.
      if (isStale && mains.has(sessionId)) continue;

      let state: PendingState;
      try {
        state = JSON.parse(readFileSync(join(pendingDir, file), "utf-8"));
      } catch {
        continue;
      }

      const hasBatches =
        (Array.isArray(state.observationBatches) &&
          state.observationBatches.length > 0) ||
        (Array.isArray(state.reflectionBatches) &&
          state.reflectionBatches.length > 0) ||
        (Array.isArray(state.droppedBatches) &&
          state.droppedBatches.length > 0);
      if (!hasBatches) continue;

      if (corpus.knownSessionIds.has(sessionId)) {
        extractFromPendingState(
          state,
          sessionId,
          "pending",
          corpus.observations,
          corpus.reflections,
          corpus.droppedIds,
        );
      } else {
        corpus.orphanedSessions++;
        extractFromPendingState(
          state,
          sessionId,
          "orphan",
          corpus.observations,
          corpus.reflections,
          corpus.droppedIds,
        );
      }
    }
  }

  return corpus;
}
