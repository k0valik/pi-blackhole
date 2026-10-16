/**
 * Corpus time-window tests (plan-extract-timeline Phase 2, corpus side).
 *
 * Covers BuildCorpusOptions sinceMs/untilMs: Stage A mtime prefilter
 * (skip + header still read + fail-open), Stage B per-entry filtering,
 * timeless drops, pending filtering/attribution, unknown timestamps,
 * active-session exclusion, and the empty-window case.
 *
 * The node:fs mock below wraps only readFileSync (full-parse detection)
 * and statSync (failure injection); everything else passes through to the
 * real implementation, so fixture setup behaves normally.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { buildProjectMemoryCorpusAsync, encodeScopeDir } from "../src/project-recall/corpus.js";

const { fullReadCounts, statFailures } = vi.hoisted(() => ({
  fullReadCounts: new Map<string, number>(),
  statFailures: new Set<string>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  type ReadFileSync = typeof actual.readFileSync;
  type StatSync = typeof actual.statSync;
  const readFileSyncWrapper = (...args: Parameters<ReadFileSync>): ReturnType<ReadFileSync> => {
    const key = String(args[0]);
    fullReadCounts.set(key, (fullReadCounts.get(key) ?? 0) + 1);
    return (actual.readFileSync as (...a: Parameters<ReadFileSync>) => ReturnType<ReadFileSync>)(
      ...args,
    );
  };
  const statSyncWrapper = (...args: Parameters<StatSync>): ReturnType<StatSync> => {
    if (statFailures.has(String(args[0]))) throw new Error("injected stat failure");
    return (actual.statSync as (...a: Parameters<StatSync>) => ReturnType<StatSync>)(...args);
  };
  return { ...actual, readFileSync: readFileSyncWrapper, statSync: statSyncWrapper };
});

const DAY_MS = 86400000;
const PENDING_DIR = "pi-blackhole";

const baseRoot = join(tmpdir(), `pi-corpus-window-test-${process.pid}`);
let agentDir: string;
let projectCwd: string;
let scopeDir: string;
let custCounter: number;

const iso = (ms: number): string => new Date(ms).toISOString();

function sessionHeader(id: string): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: iso(Date.now()),
    cwd: projectCwd,
  });
}

function messageEntry(id: string): string {
  return JSON.stringify({
    type: "message",
    id,
    timestamp: iso(Date.now()),
    message: { role: "user", content: "work" },
  });
}

function obsRecorded(observations: Array<Record<string, unknown>>, entryTs: string): string {
  return JSON.stringify({
    type: "custom",
    id: `cust-${++custCounter}`,
    timestamp: entryTs,
    customType: "om.observations.recorded",
    data: { observations, coversUpToId: "m1" },
  });
}

function reflectionsRecorded(reflections: Array<Record<string, unknown>>, entryTs: string): string {
  return JSON.stringify({
    type: "custom",
    id: `cust-${++custCounter}`,
    timestamp: entryTs,
    customType: "om.reflections.recorded",
    data: { reflections, coversUpToId: "m1" },
  });
}

function dropsRecorded(ids: string[], entryTs: string): string {
  return JSON.stringify({
    type: "custom",
    id: `cust-${++custCounter}`,
    timestamp: entryTs,
    customType: "om.observations.dropped",
    data: { observationIds: ids, coversUpToId: "m1" },
  });
}

function obs(id: string, content: string, ts: string | undefined): Record<string, unknown> {
  const o: Record<string, unknown> = {
    id,
    content,
    relevance: "high",
    sourceEntryIds: ["m1"],
    tokenCount: 8,
  };
  if (ts !== undefined) o.timestamp = ts;
  return o;
}

function writeSession(file: string, sessionId: string, lines: string[]): string {
  const p = join(scopeDir, file);
  writeFileSync(
    join(scopeDir, file),
    [sessionHeader(sessionId), messageEntry("m1"), ...lines].join("\n") + "\n",
    "utf-8",
  );
  return p;
}

function setMtimeDaysAgo(path: string, days: number, now: number): void {
  const t = new Date(now - days * DAY_MS);
  utimesSync(path, t, t);
}

function writePending(sessionId: string, state: unknown): void {
  const dir = join(agentDir, PENDING_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}-pending.json`), JSON.stringify(state), "utf-8");
}

function contents(corpus: { observations: Array<{ content: string }> }): string[] {
  return corpus.observations.map((o) => o.content);
}

beforeEach(() => {
  rmSync(baseRoot, { recursive: true, force: true });
  projectCwd = join(baseRoot, "proj");
  agentDir = join(baseRoot, "agent");
  scopeDir = join(agentDir, "sessions", encodeScopeDir(projectCwd));
  mkdirSync(scopeDir, { recursive: true });
  fullReadCounts.clear();
  statFailures.clear();
  custCounter = 0;
});

afterEach(() => {
  rmSync(baseRoot, { recursive: true, force: true });
});

describe("corpus time window", () => {
  it("skips old-mtime sessions without parsing their entries", async () => {
    const now = Date.now();
    const sinceMs = now - 7 * DAY_MS;
    const oldPath = writeSession("old.jsonl", "ses-old", [
      obsRecorded([obs("a1", "Old project fact", iso(now - 30 * DAY_MS))], iso(now - 30 * DAY_MS)),
    ]);
    setMtimeDaysAgo(oldPath, 30, now);
    writeSession("recent.jsonl", "ses-recent", [
      obsRecorded([obs("b1", "Recent project fact", iso(now - 1 * DAY_MS))], iso(now - 1 * DAY_MS)),
    ]);

    const corpus = await buildProjectMemoryCorpusAsync({ cwd: projectCwd, agentDir, sinceMs });

    expect(corpus.sessionsDiscovered).toBe(2);
    expect(corpus.sessionsSkippedByWindow).toBe(1);
    expect(corpus.sessionsConsidered).toBe(1);
    expect(contents(corpus)).toContain("Recent project fact");
    expect(contents(corpus)).not.toContain("Old project fact");
    expect(corpus.entriesOutsideWindow).toBe(0);
  });

  it("never fully reads a window-skipped session file", async () => {
    const now = Date.now();
    const sinceMs = now - 7 * DAY_MS;
    const oldPath = writeSession("old.jsonl", "ses-old", [
      obsRecorded([obs("a1", "Old project fact", iso(now - 30 * DAY_MS))], iso(now - 30 * DAY_MS)),
    ]);
    setMtimeDaysAgo(oldPath, 30, now);
    const recentPath = writeSession("recent.jsonl", "ses-recent", [
      obsRecorded([obs("b1", "Recent project fact", iso(now - 1 * DAY_MS))], iso(now - 1 * DAY_MS)),
    ]);

    await buildProjectMemoryCorpusAsync({ cwd: projectCwd, agentDir, sinceMs });

    expect(fullReadCounts.get(oldPath) ?? 0).toBe(0);
    expect(fullReadCounts.get(recentPath) ?? 0).toBeGreaterThan(0);
  });

  it("parses the file when its stat fails (fail open, never lose memory)", async () => {
    const now = Date.now();
    const flakyPath = writeSession("flaky.jsonl", "ses-flaky", [
      obsRecorded([obs("f1", "Recent project fact", iso(now - 1 * DAY_MS))], iso(now - 1 * DAY_MS)),
    ]);
    statFailures.add(flakyPath);

    const corpus = await buildProjectMemoryCorpusAsync({
      cwd: projectCwd,
      agentDir,
      sinceMs: now - 7 * DAY_MS,
    });

    expect(contents(corpus)).toContain("Recent project fact");
    expect(corpus.sessionsSkippedByWindow).toBe(0);
    expect(fullReadCounts.get(flakyPath) ?? 0).toBeGreaterThan(0);
  });

  it("filters old entries out of a recently-written (resumed) session", async () => {
    const now = Date.now();
    writeSession("resumed.jsonl", "ses-resumed", [
      obsRecorded(
        [
          obs("r1", "Month-old fact in resumed session", iso(now - 30 * DAY_MS)),
          obs("r2", "Two-day-old fact in resumed session", iso(now - 2 * DAY_MS)),
        ],
        iso(now - 1 * DAY_MS),
      ),
    ]);

    const corpus = await buildProjectMemoryCorpusAsync({
      cwd: projectCwd,
      agentDir,
      sinceMs: now - 7 * DAY_MS,
    });

    expect(contents(corpus)).toContain("Two-day-old fact in resumed session");
    expect(contents(corpus)).not.toContain("Month-old fact in resumed session");
    expect(corpus.entriesOutsideWindow).toBe(1);
    expect(corpus.sessionsSkippedByWindow).toBe(0);
    expect(corpus.sessionsConsidered).toBe(1);
  });

  it("excludes entries newer than untilMs", async () => {
    const now = Date.now();
    writeSession("s.jsonl", "ses-s", [
      obsRecorded(
        [
          obs("u1", "Month-old fact", iso(now - 30 * DAY_MS)),
          obs("u2", "Yesterday fact", iso(now - 1 * DAY_MS)),
        ],
        iso(now - 1 * DAY_MS),
      ),
    ]);

    const corpus = await buildProjectMemoryCorpusAsync({
      cwd: projectCwd,
      agentDir,
      untilMs: now - 7 * DAY_MS,
    });

    expect(contents(corpus)).toContain("Month-old fact");
    expect(contents(corpus)).not.toContain("Yesterday fact");
    expect(corpus.entriesOutsideWindow).toBe(1);
  });

  it("keeps entries exactly on the window bounds (both inclusive)", async () => {
    const now = Date.now();
    const sinceMs = now - 7 * DAY_MS;
    const untilMs = now - 1 * DAY_MS;
    writeSession("s.jsonl", "ses-s", [
      obsRecorded(
        [
          obs("e1", "Lower-bound fact", iso(sinceMs)),
          obs("e2", "Mid-window fact", iso(now - 3 * DAY_MS)),
          obs("e3", "Upper-bound fact", iso(untilMs)),
        ],
        iso(now),
      ),
    ]);

    const corpus = await buildProjectMemoryCorpusAsync({
      cwd: projectCwd,
      agentDir,
      sinceMs,
      untilMs,
    });

    expect(contents(corpus)).toContain("Lower-bound fact");
    expect(contents(corpus)).toContain("Mid-window fact");
    expect(contents(corpus)).toContain("Upper-bound fact");
    expect(corpus.entriesOutsideWindow).toBe(0);
  });

  it("keeps everything without a window and reports zero window counters", async () => {
    const now = Date.now();
    writeSession("old.jsonl", "ses-old", [
      obsRecorded([obs("a1", "Old project fact", iso(now - 30 * DAY_MS))], iso(now - 30 * DAY_MS)),
    ]);
    writeSession("recent.jsonl", "ses-recent", [
      obsRecorded([obs("b1", "Recent project fact", iso(now - 1 * DAY_MS))], iso(now - 1 * DAY_MS)),
    ]);

    const corpus = await buildProjectMemoryCorpusAsync({ cwd: projectCwd, agentDir });

    expect(contents(corpus)).toContain("Old project fact");
    expect(contents(corpus)).toContain("Recent project fact");
    expect(corpus.sessionsDiscovered).toBe(2);
    expect(corpus.sessionsConsidered).toBe(2);
    expect(corpus.sessionsSkippedByWindow).toBe(0);
    expect(corpus.entriesOutsideWindow).toBe(0);
    expect(corpus.entriesWithoutTimestamp).toBe(0);
  });

  it("retains and counts branch entries with unusable timestamps under a window", async () => {
    const now = Date.now();
    // Neither the observation nor the entry carries any timestamp, so the
    // stored timestamp resolves to null (a garbage entry timestamp would
    // instead take the legacy patch path — see parseTimestamp).
    const timelessEntry = JSON.stringify({
      type: "custom",
      id: "cust-1",
      customType: "om.observations.recorded",
      data: {
        observations: [{ id: "t1", content: "Timeless project fact", relevance: "high" }],
        coversUpToId: "m1",
      },
    });
    writeSession("timeless.jsonl", "ses-timeless", [timelessEntry]);

    const corpus = await buildProjectMemoryCorpusAsync({
      cwd: projectCwd,
      agentDir,
      sinceMs: now - 7 * DAY_MS,
    });

    expect(corpus.observations[0]?.timestamp).toBeNull();
    expect(contents(corpus)).toContain("Timeless project fact");
    expect(corpus.entriesWithoutTimestamp).toBe(1);
    expect(corpus.entriesOutsideWindow).toBe(0);
  });

  it("excludes reflections outside the window", async () => {
    const now = Date.now();
    writeSession("s.jsonl", "ses-s", [
      reflectionsRecorded(
        [
          {
            content: "Month-old reflection",
            timestamp: iso(now - 30 * DAY_MS),
            supportingObservationIds: [],
          },
          {
            content: "Recent reflection",
            timestamp: iso(now - 1 * DAY_MS),
            supportingObservationIds: [],
          },
        ],
        iso(now - 1 * DAY_MS),
      ),
    ]);

    const corpus = await buildProjectMemoryCorpusAsync({
      cwd: projectCwd,
      agentDir,
      sinceMs: now - 7 * DAY_MS,
    });

    expect(corpus.reflections.map((r) => r.content)).toContain("Recent reflection");
    expect(corpus.reflections.map((r) => r.content)).not.toContain("Month-old reflection");
    expect(corpus.entriesOutsideWindow).toBe(1);
  });

  it("keeps drop markers effective when the drop entry is outside the window", async () => {
    const now = Date.now();
    writeSession("a.jsonl", "ses-a", [
      obsRecorded(
        [obs("deadbeef0001", "In-window fact", iso(now - 1 * DAY_MS))],
        iso(now - 1 * DAY_MS),
      ),
    ]);
    writeSession("b.jsonl", "ses-b", [dropsRecorded(["deadbeef0001"], iso(now - 30 * DAY_MS))]);

    const corpus = await buildProjectMemoryCorpusAsync({
      cwd: projectCwd,
      agentDir,
      sinceMs: now - 7 * DAY_MS,
    });

    expect(corpus.droppedIds.has("deadbeef0001")).toBe(true);
    expect(contents(corpus)).toContain("In-window fact");
  });

  it("filters pending observations by the window", async () => {
    const now = Date.now();
    writeSession("p.jsonl", "ses-p", [
      obsRecorded([obs("p0", "Branch fact", iso(now - 1 * DAY_MS))], iso(now - 1 * DAY_MS)),
    ]);
    writePending("ses-p", {
      observationBatches: [
        {
          coversUpToId: "m1",
          data: {
            observations: [
              {
                id: "p1",
                content: "Old pending fact",
                relevance: "high",
                timestamp: iso(now - 30 * DAY_MS),
              },
              {
                id: "p2",
                content: "Recent pending fact",
                relevance: "high",
                timestamp: iso(now - 1 * DAY_MS),
              },
            ],
          },
        },
      ],
    });

    const corpus = await buildProjectMemoryCorpusAsync({
      cwd: projectCwd,
      agentDir,
      sinceMs: now - 7 * DAY_MS,
    });

    const pending = corpus.observations.filter((o) => o.source === "pending");
    expect(pending.map((o) => o.content)).toContain("Recent pending fact");
    expect(pending.map((o) => o.content)).not.toContain("Old pending fact");
    expect(corpus.entriesOutsideWindow).toBe(1);
  });

  it("retains and counts pending observations without timestamps", async () => {
    const now = Date.now();
    writeSession("p.jsonl", "ses-p", [
      obsRecorded([obs("p0", "Branch fact", iso(now - 1 * DAY_MS))], iso(now - 1 * DAY_MS)),
    ]);
    writePending("ses-p", {
      observationBatches: [
        {
          coversUpToId: "m1",
          data: {
            observations: [{ id: "p9", content: "Timeless pending fact", relevance: "medium" }],
          },
        },
      ],
    });

    const corpus = await buildProjectMemoryCorpusAsync({
      cwd: projectCwd,
      agentDir,
      sinceMs: now - 7 * DAY_MS,
    });

    expect(contents(corpus)).toContain("Timeless pending fact");
    expect(corpus.entriesWithoutTimestamp).toBe(1);
  });

  it("filters pending reflections through their observation-timestamp fallback", async () => {
    const now = Date.now();
    writeSession("p.jsonl", "ses-p", [
      obsRecorded([obs("p0", "Branch fact", iso(now - 1 * DAY_MS))], iso(now - 1 * DAY_MS)),
    ]);
    writePending("ses-p", {
      observationBatches: [
        {
          coversUpToId: "m1",
          data: {
            observations: [
              {
                id: "p1",
                content: "Old pending fact",
                relevance: "high",
                timestamp: iso(now - 30 * DAY_MS),
              },
            ],
          },
        },
      ],
      reflectionBatches: [
        {
          data: {
            reflections: [{ content: "Fallback-dated pending reflection" }],
          },
        },
      ],
    });

    const corpus = await buildProjectMemoryCorpusAsync({
      cwd: projectCwd,
      agentDir,
      sinceMs: now - 7 * DAY_MS,
    });

    expect(contents(corpus)).not.toContain("Old pending fact");
    expect(corpus.reflections.map((r) => r.content)).not.toContain(
      "Fallback-dated pending reflection",
    );
    expect(corpus.entriesOutsideWindow).toBe(2);
  });

  it("still attributes pending buffers of window-skipped sessions", async () => {
    const now = Date.now();
    const oldPath = writeSession("old.jsonl", "ses-old", [
      obsRecorded([obs("a1", "Old branch fact", iso(now - 30 * DAY_MS))], iso(now - 30 * DAY_MS)),
    ]);
    setMtimeDaysAgo(oldPath, 30, now);
    writePending("ses-old", {
      observationBatches: [
        {
          coversUpToId: "m1",
          data: {
            observations: [
              {
                id: "p1",
                content: "Recent pending fact",
                relevance: "high",
                timestamp: iso(now - 1 * DAY_MS),
              },
            ],
          },
        },
      ],
    });

    const corpus = await buildProjectMemoryCorpusAsync({
      cwd: projectCwd,
      agentDir,
      sinceMs: now - 7 * DAY_MS,
    });

    const match = corpus.observations.find((o) => o.content === "Recent pending fact");
    expect(match?.source).toBe("pending");
    expect(corpus.orphanedSessions).toBe(0);
    expect(corpus.sessionsSkippedByWindow).toBe(1);
  });

  it("excludes the active session before windowing", async () => {
    const now = Date.now();
    const activePath = writeSession("active.jsonl", "ses-active", [
      obsRecorded([obs("x1", "Active-session fact", iso(now - 1 * DAY_MS))], iso(now - 1 * DAY_MS)),
    ]);
    writeSession("other.jsonl", "ses-other", [
      obsRecorded([obs("x2", "Other-session fact", iso(now - 1 * DAY_MS))], iso(now - 1 * DAY_MS)),
    ]);

    const corpus = await buildProjectMemoryCorpusAsync({
      cwd: projectCwd,
      agentDir,
      activeSessionFile: activePath,
      sinceMs: now - 7 * DAY_MS,
    });

    expect(contents(corpus)).not.toContain("Active-session fact");
    expect(contents(corpus)).toContain("Other-session fact");
    expect(corpus.sessionsDiscovered).toBe(2);
    expect(corpus.sessionsSkippedByWindow).toBe(0);
    expect(corpus.knownSessionIds.has("ses-active")).toBe(false);
  });

  it("yields no entries when the window excludes all memory", async () => {
    const now = Date.now();
    writeSession("old.jsonl", "ses-old", [
      obsRecorded([obs("a1", "Old project fact", iso(now - 30 * DAY_MS))], iso(now - 30 * DAY_MS)),
    ]);

    const corpus = await buildProjectMemoryCorpusAsync({
      cwd: projectCwd,
      agentDir,
      sinceMs: now - 7 * DAY_MS,
    });

    expect(corpus.observations).toHaveLength(0);
    expect(corpus.reflections).toHaveLength(0);
    expect(corpus.entriesOutsideWindow).toBe(1);
  });
});
