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
  return typeof value === "string" && (RELEVANCE_VALUES as readonly string[]).includes(value)
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
      const n = readSync(fd, buf, total, Math.min(HEADER_CHUNK, HEADER_MAX - total), total);
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
    if (customType === OM_OBSERVATIONS_RECORDED || customType === LEGACY_OM_OBSERVATION) {
      const list =
        customType === LEGACY_OM_OBSERVATION ? (data.records ?? []) : (data.observations ?? []);
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
  observation?: PendingBatch;
  reflection?: PendingBatch;
  dropped?: PendingBatch;
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
  // Reflections in pending files have no individual timestamp; fall back
  // to the newest observation timestamp in the same file so they render
  // with a useful (N ago) suffix in the export.
  // Consider both batched and singular observation forms for timestamp fallback.
  const allObsBatches: PendingBatch[] =
    state.observationBatches && state.observationBatches.length > 0
      ? state.observationBatches
      : state.observation
        ? [state.observation]
        : [];
  const allReflBatches: PendingBatch[] =
    state.reflectionBatches && state.reflectionBatches.length > 0
      ? state.reflectionBatches
      : state.reflection
        ? [state.reflection]
        : [];
  const allDroppedBatches: PendingBatch[] =
    state.droppedBatches && state.droppedBatches.length > 0
      ? state.droppedBatches
      : state.dropped
        ? [state.dropped]
        : [];

  let maxObsTs: number | null = null;
  for (const batch of allObsBatches) {
    for (const o of batch.data?.observations ?? []) {
      const ts = parseTimestamp((o as { timestamp?: unknown }).timestamp);
      if (ts != null) {
        const ms = Date.parse(ts);
        if (!Number.isNaN(ms) && (maxObsTs === null || ms > maxObsTs)) {
          maxObsTs = ms;
        }
      }
    }
  }
  const reflectionTimestamp = maxObsTs != null ? new Date(maxObsTs).toISOString() : null;

  for (const batch of allObsBatches) {
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
  for (const batch of allReflBatches) {
    for (const r of batch.data?.reflections ?? []) {
      if (typeof r.content !== "string" || !r.content.trim()) continue;
      reflections.push({
        content: r.content,
        supportingObservationIds: Array.isArray(r.supportingObservationIds)
          ? (r.supportingObservationIds as string[])
          : [],
        timestamp: reflectionTimestamp,
        sessionId,
        source,
      });
    }
  }
  for (const batch of allDroppedBatches) {
    if (Array.isArray(batch.data?.observationIds)) {
      for (const id of batch.data?.observationIds as unknown[]) {
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
export function buildProjectMemoryCorpus(options: BuildCorpusOptions): ProjectCorpus {
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
  // Pending files are global (one dir for all projects). A pending file
  // whose sessionId is not in the project-scoped knownSessionIds may be:
  //  - foreign: session still exists under another project's scope dir
  //  - truly orphaned: no session JSONL exists anywhere
  // Only the latter should appear in the "Unattributed" section; foreign
  // pending files are ignored for this project's export.
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

    // Build a global session-id index for orphan vs foreign disambiguation.
    // This is a single scan of ~/.pi/agent/sessions/*/*.jsonl — cheap
    // (~1k files) and only needed when pending files exist.
    let globalSessionIds: Set<string> | null = null;
    const ensureGlobalIds = (): Set<string> => {
      if (globalSessionIds) return globalSessionIds;
      globalSessionIds = new Set<string>(corpus.knownSessionIds);
      const sessionsRoot = join(agentDir, "sessions");
      let scopes: string[];
      try {
        scopes = readdirSync(sessionsRoot);
      } catch {
        return globalSessionIds;
      }
      for (const scope of scopes) {
        const scopePath = join(sessionsRoot, scope);
        let st: ReturnType<typeof statSync> | null = null;
        try {
          st = statSync(scopePath);
        } catch {
          continue;
        }
        if (!st.isDirectory()) continue;
        // Skip already-scanned project scopes to avoid re-reading
        // headers — we already have those ids in knownSessionIds.
        const isProjectScope =
          scope === encodeScopeDir(options.cwd) ||
          (options.gitRoot &&
            options.gitRoot !== options.cwd &&
            scope === encodeScopeDir(options.gitRoot));
        if (isProjectScope) continue;
        let scopeFiles: string[];
        try {
          scopeFiles = readdirSync(scopePath);
        } catch {
          continue;
        }
        for (const f of scopeFiles) {
          if (!f.endsWith(".jsonl")) continue;
          const header = parseSessionHeader(readFirstLine(join(scopePath, f)));
          const sid =
            header?.id || (f.includes("_") ? f.slice(f.lastIndexOf("_") + 1, -6) : f.slice(0, -6));
          if (sid) globalSessionIds.add(sid);
        }
      }
      return globalSessionIds;
    };

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
        (Array.isArray(state.observationBatches) && state.observationBatches.length > 0) ||
        (Array.isArray(state.reflectionBatches) && state.reflectionBatches.length > 0) ||
        (Array.isArray(state.droppedBatches) && state.droppedBatches.length > 0) ||
        // Legacy / singular form: older pending files may only have the
        // singular observation/reflection/dropped keys without batch arrays.
        (typeof (state as Record<string, unknown>).observation === "object" &&
          (state as Record<string, unknown>).observation !== null) ||
        (typeof (state as Record<string, unknown>).reflection === "object" &&
          (state as Record<string, unknown>).reflection !== null) ||
        (typeof (state as Record<string, unknown>).dropped === "object" &&
          (state as Record<string, unknown>).dropped !== null);
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
        // Distinguish foreign (session exists elsewhere) from truly orphaned
        // (no session file anywhere). Only the latter is rendered as
        // "Unattributed pending memory"; foreign pending is ignored.
        const gids = ensureGlobalIds();
        if (gids.has(sessionId)) continue;
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

export interface CorpusProgress {
  scanned: number;
  total: number;
  phase: "scanning" | "pending";
}

const YIELD_EVERY_FILES = 10;

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Async variant that yields to the event loop every few files so the TUI
 * can paint progress notifies. Sync version is kept for tests / callers
 * that need zero overhead on small corpora.
 */
export async function buildProjectMemoryCorpusAsync(
  options: BuildCorpusOptions,
  onProgress?: (p: CorpusProgress) => void,
): Promise<ProjectCorpus> {
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

  // Enumerate candidates up-front so we can report the total.
  const candidateFiles: string[] = [];
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
      candidateFiles.push(filePath);
    }
  }

  const total = candidateFiles.length;
  if (onProgress && total > 0) {
    onProgress({ scanned: 0, total, phase: "scanning" });
  }

  let scanned = 0;
  for (const filePath of candidateFiles) {
    scanned++;
    const file = filePath.slice(filePath.lastIndexOf("/") + 1);
    corpus.sessionsConsidered++;
    const header = parseSessionHeader(readFirstLine(filePath));
    const sessionId = header?.id || file.slice(0, -6);
    corpus.knownSessionIds.add(sessionId);

    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      if (scanned % YIELD_EVERY_FILES === 0) await yieldToEventLoop();
      if (onProgress && scanned % 25 === 0) {
        onProgress({ scanned, total, phase: "scanning" });
      }
      continue;
    }
    if (!raw.includes("om.")) {
      if (scanned % YIELD_EVERY_FILES === 0) await yieldToEventLoop();
      if (onProgress && scanned % 25 === 0) {
        onProgress({ scanned, total, phase: "scanning" });
      }
      continue;
    }
    corpus.filesWithMarkers++;

    const entries: Array<Record<string, unknown>> = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        /* corrupt lines silently dropped */
      }
    }
    extractFromEntries(
      entries,
      sessionId,
      corpus.observations,
      corpus.reflections,
      corpus.droppedIds,
    );

    if (scanned % YIELD_EVERY_FILES === 0) await yieldToEventLoop();
    if (onProgress && scanned % 25 === 0) {
      onProgress({ scanned, total, phase: "scanning" });
    }
  }
  if (onProgress && total > 0) {
    onProgress({ scanned: total, total, phase: "scanning" });
  }

  // Phase 2b: pending buffers (global). Yields periodically.
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

    let globalSessionIds: Set<string> | null = null;
    const ensureGlobalIds = (): Set<string> => {
      if (globalSessionIds) return globalSessionIds;
      globalSessionIds = new Set<string>(corpus.knownSessionIds);
      const sessionsRoot = join(agentDir, "sessions");
      let scopes: string[];
      try {
        scopes = readdirSync(sessionsRoot);
      } catch {
        return globalSessionIds;
      }
      for (const scope of scopes) {
        const scopePath = join(sessionsRoot, scope);
        let st: ReturnType<typeof statSync> | null = null;
        try {
          st = statSync(scopePath);
        } catch {
          continue;
        }
        if (!st.isDirectory()) continue;
        const isProjectScope =
          scope === encodeScopeDir(options.cwd) ||
          (options.gitRoot &&
            options.gitRoot !== options.cwd &&
            scope === encodeScopeDir(options.gitRoot));
        if (isProjectScope) continue;
        let scopeFiles: string[];
        try {
          scopeFiles = readdirSync(scopePath);
        } catch {
          continue;
        }
        for (const f of scopeFiles) {
          if (!f.endsWith(".jsonl")) continue;
          const header = parseSessionHeader(readFirstLine(join(scopePath, f)));
          const sid =
            header?.id || (f.includes("_") ? f.slice(f.lastIndexOf("_") + 1, -6) : f.slice(0, -6));
          if (sid) globalSessionIds.add(sid);
        }
      }
      return globalSessionIds;
    };

    let pendingProcessed = 0;
    for (const file of files) {
      const isMain = file.endsWith(PENDING_SUFFIX);
      const isStale = file.endsWith(STALE_SUFFIX);
      if (!isMain && !isStale) continue;
      const sessionId = isMain
        ? file.slice(0, -PENDING_SUFFIX.length)
        : file.slice(0, -STALE_SUFFIX.length);
      if (!sessionId) continue;
      if (isStale && mains.has(sessionId)) continue;

      let state: PendingState;
      try {
        state = JSON.parse(readFileSync(join(pendingDir, file), "utf-8"));
      } catch {
        continue;
      }

      const hasBatches =
        (Array.isArray(state.observationBatches) && state.observationBatches.length > 0) ||
        (Array.isArray(state.reflectionBatches) && state.reflectionBatches.length > 0) ||
        (Array.isArray(state.droppedBatches) && state.droppedBatches.length > 0) ||
        (typeof (state as Record<string, unknown>).observation === "object" &&
          (state as Record<string, unknown>).observation !== null) ||
        (typeof (state as Record<string, unknown>).reflection === "object" &&
          (state as Record<string, unknown>).reflection !== null) ||
        (typeof (state as Record<string, unknown>).dropped === "object" &&
          (state as Record<string, unknown>).dropped !== null);
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
        const gids = ensureGlobalIds();
        if (gids.has(sessionId)) continue;
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
      pendingProcessed++;
      if (pendingProcessed % 10 === 0) await yieldToEventLoop();
    }
  }

  return corpus;
}
