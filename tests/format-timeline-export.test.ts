/**
 * Timeline renderer tests (plan-extract-timeline Phase 3, §8 + §16).
 *
 * The timeline renderer is a chronological, exact-dedup-only alternative to
 * the distilled export: no relevance ranking, no viability gate, no fuzzy
 * merging. Small ProjectCorpus literals plus one end-to-end case through
 * buildProjectMemoryCorpusAsync with real fixtures.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildTimelineExportMarkdown,
  buildTimelineExportMarkdownAsync,
} from "../src/project-recall/format-timeline-export.js";
import { buildExportMarkdown } from "../src/project-recall/format-export.js";
import type {
  CorpusObservation,
  CorpusReflection,
  MemorySource,
  ProjectCorpus,
} from "../src/project-recall/corpus.js";
import type { Relevance } from "../src/om/ledger/types.js";

const NOW = Date.parse("2026-10-16T00:40:00.000Z");
const TITLE = "proj";

let obsCounter = 0;

function makeObs(
  content: string,
  opts?: {
    id?: string | null;
    relevance?: Relevance;
    timestamp?: string | null;
    sessionId?: string;
    source?: MemorySource;
  },
): CorpusObservation {
  return {
    id: opts?.id ?? `obs-${++obsCounter}`,
    content,
    relevance: opts?.relevance ?? "high",
    // NB: `??` would swallow an explicit null timestamp, so test the key.
    timestamp: opts?.timestamp === undefined ? "2026-10-12T10:00:00.000Z" : opts.timestamp,
    sessionId: opts?.sessionId ?? "ses-a",
    source: opts?.source ?? "branch",
  };
}

function makeRefl(
  content: string,
  opts?: {
    timestamp?: string | null;
    sessionId?: string;
    source?: MemorySource;
    supportingObservationIds?: string[];
  },
): CorpusReflection {
  return {
    content,
    supportingObservationIds: opts?.supportingObservationIds ?? [],
    // NB: `??` would swallow an explicit null timestamp, so test the key.
    timestamp: opts?.timestamp === undefined ? "2026-10-12T10:00:00.000Z" : opts.timestamp,
    sessionId: opts?.sessionId ?? "ses-a",
    source: opts?.source ?? "branch",
  };
}

function makeCorpus(opts?: {
  observations?: CorpusObservation[];
  reflections?: CorpusReflection[];
  droppedIds?: string[];
  orphanedSessions?: number;
  sessionsDiscovered?: number;
  sessionsConsidered?: number;
  filesWithMarkers?: number;
  sessionsSkippedByWindow?: number;
  entriesOutsideWindow?: number;
  entriesWithoutTimestamp?: number;
}): ProjectCorpus {
  const observations = opts?.observations ?? [];
  const reflections = opts?.reflections ?? [];
  return {
    projectRoot: "/tmp/proj",
    sessionsConsidered: opts?.sessionsConsidered ?? 1,
    sessionsDiscovered: opts?.sessionsDiscovered ?? 1,
    sessionsSkippedByWindow: opts?.sessionsSkippedByWindow ?? 0,
    entriesOutsideWindow: opts?.entriesOutsideWindow ?? 0,
    entriesWithoutTimestamp: opts?.entriesWithoutTimestamp ?? 0,
    filesWithMarkers: opts?.filesWithMarkers ?? 1,
    observations,
    reflections,
    droppedIds: new Set(opts?.droppedIds ?? []),
    knownSessionIds: new Set([...observations, ...reflections].map((e) => e.sessionId)),
    orphanedSessions: opts?.orphanedSessions ?? 0,
  };
}

function render(corpus: ProjectCorpus): string {
  return buildTimelineExportMarkdown(corpus, { now: NOW, title: TITLE }).markdown;
}

const e2eRoot = join(tmpdir(), `pi-timeline-export-test-${process.pid}`);

afterEach(() => {
  rmSync(e2eRoot, { recursive: true, force: true });
});

describe("timeline header", () => {
  it("renders title, generated time, all-history window and mode lines", () => {
    const md = render(makeCorpus());
    expect(md).toContain("# Project memory timeline — proj");
    expect(md).toContain("_Generated 2026-10-16 00:40 UTC_");
    expect(md).toContain("_Window: all history_");
    expect(md).toContain("_Mode: chronological · exact duplicates only_");
  });

  it("never renders relative ages", () => {
    const md = render(
      makeCorpus({
        observations: [makeObs("Stable technical fact about the build")],
      }),
    );
    expect(md).not.toMatch(/\d+[mhdw] ago/);
    expect(md).not.toContain("just now");
  });
});

describe("timeline ordering", () => {
  it("orders a 10:00 low before an 11:00 critical across sessions", () => {
    const md = render(
      makeCorpus({
        observations: [
          makeObs("Critical deploy freeze in effect", {
            id: "crit-1",
            relevance: "critical",
            timestamp: "2026-10-12T11:00:00.000Z",
            sessionId: "ses-a",
          }),
          makeObs("Minor note about prompt wording", {
            id: "low-1",
            relevance: "low",
            timestamp: "2026-10-12T10:00:00.000Z",
            sessionId: "ses-b",
          }),
        ],
      }),
    );
    expect(md.indexOf("Minor note about prompt wording")).toBeLessThan(
      md.indexOf("Critical deploy freeze in effect"),
    );
    expect(md).toContain("**[observation/low]**");
    expect(md).toContain("**[observation/critical]**");
    expect(md).toContain("`10:00:00Z`");
    expect(md).toContain("`11:00:00Z`");
    expect(md).toContain("`(session ses-b)`");
  });

  it("interleaves observations and reflections strictly by timestamp", () => {
    const md = render(
      makeCorpus({
        observations: [
          makeObs("Morning build fact", {
            id: "o1",
            timestamp: "2026-10-12T10:00:00.000Z",
            sessionId: "ses-a",
          }),
          makeObs("Evening build fact", {
            id: "o2",
            timestamp: "2026-10-12T11:00:00.000Z",
            sessionId: "ses-a",
          }),
        ],
        reflections: [
          makeRefl("Midday synthesis of the build", {
            timestamp: "2026-10-12T10:30:00.000Z",
            sessionId: "ses-b",
          }),
        ],
      }),
    );
    expect(md.indexOf("Morning build fact")).toBeLessThan(
      md.indexOf("Midday synthesis of the build"),
    );
    expect(md.indexOf("Midday synthesis of the build")).toBeLessThan(
      md.indexOf("Evening build fact"),
    );
    expect(md).toContain("**[reflection]**");
  });

  it("groups bullets under ascending UTC date headers", () => {
    const md = render(
      makeCorpus({
        observations: [
          makeObs("Just after midnight fact", {
            id: "o2",
            timestamp: "2026-10-13T00:10:00.000Z",
            sessionId: "ses-a",
          }),
          makeObs("Just before midnight fact", {
            id: "o1",
            timestamp: "2026-10-12T23:50:00.000Z",
            sessionId: "ses-a",
          }),
        ],
      }),
    );
    expect(md.indexOf("## 2026-10-12")).toBeLessThan(md.indexOf("## 2026-10-13"));
    const day12 = md.slice(md.indexOf("## 2026-10-12"), md.indexOf("## 2026-10-13"));
    expect(day12).toContain("Just before midnight fact");
    expect(day12).not.toContain("Just after midnight fact");
    expect(md.slice(md.indexOf("## 2026-10-13"))).toContain("Just after midnight fact");
  });
});

describe("timeline async variant", () => {
  it("matches the sync renderer byte for byte", async () => {
    const corpus = makeCorpus({
      observations: [
        makeObs("Async parity observation", {
          timestamp: "2026-10-12T10:00:00.000Z",
          sessionId: "ses-a",
        }),
      ],
      reflections: [
        makeRefl("Async parity reflection", {
          timestamp: "2026-10-12T10:30:00.000Z",
          sessionId: "ses-b",
        }),
      ],
    });
    const sync = buildTimelineExportMarkdown(corpus, { now: NOW, title: TITLE });
    const asyncResult = await buildTimelineExportMarkdownAsync(corpus, {
      now: NOW,
      title: TITLE,
    });
    expect(asyncResult.markdown).toBe(sync.markdown);
    expect(asyncResult.stats).toEqual(sync.stats);
  });
});

describe("timeline exact duplicates", () => {
  const count = (md: string, s: string): number => md.split(s).length - 1;

  it("collapses byte-identical repeats into one bullet at the earliest timestamp", () => {
    const md = render(
      makeCorpus({
        observations: [
          makeObs("Repeated exact fact about the cache", {
            id: "d1",
            timestamp: "2026-10-12T11:00:00.000Z",
            sessionId: "ses-a",
          }),
          makeObs("Repeated exact fact about the cache", {
            id: "d2",
            timestamp: "2026-10-12T09:00:00.000Z",
            sessionId: "ses-a",
          }),
          makeObs("Repeated exact fact about the cache", {
            id: "d3",
            timestamp: "2026-10-12T10:00:00.000Z",
            sessionId: "ses-b",
          }),
        ],
      }),
    );
    expect(count(md, "Repeated exact fact about the cache")).toBe(1);
    expect(md).toContain("recorded 3×");
    expect(md).toContain("across 2 sessions");
    expect(md).toContain("`09:00:00Z`");
    expect(md).not.toContain("`10:00:00Z`");
    expect(md).not.toContain("`11:00:00Z`");
  });

  it("counts collapsed members in stats", () => {
    const { stats } = buildTimelineExportMarkdown(
      makeCorpus({
        observations: [
          makeObs("Repeated exact fact about the cache", {
            id: "d1",
            timestamp: "2026-10-12T09:00:00.000Z",
            sessionId: "ses-a",
          }),
          makeObs("Repeated exact fact about the cache", {
            id: "d2",
            timestamp: "2026-10-12T10:00:00.000Z",
            sessionId: "ses-b",
          }),
          makeObs("A distinct surviving fact", {
            id: "d3",
            timestamp: "2026-10-12T11:00:00.000Z",
            sessionId: "ses-a",
          }),
        ],
      }),
      { now: NOW, title: TITLE },
    );
    expect(stats.observationsExported).toBe(2);
    expect(stats.duplicatesCollapsed).toBe(1);
  });

  it("keeps fuzzy one-word-difference pairs both alive", () => {
    const md = render(
      makeCorpus({
        observations: [
          makeObs("the export command writes a markdown file to disk", {
            id: "f1",
            timestamp: "2026-10-12T10:00:00.000Z",
            sessionId: "ses-a",
          }),
          makeObs("the export command writes a markdown file too disk", {
            id: "f2",
            timestamp: "2026-10-12T11:00:00.000Z",
            sessionId: "ses-b",
          }),
        ],
      }),
    );
    expect(md).toContain("writes a markdown file to disk");
    expect(md).toContain("writes a markdown file too disk");
    expect(md).not.toContain("recorded");
  });

  it("does not collapse case or punctuation-only variants", () => {
    const md = render(
      makeCorpus({
        observations: [
          makeObs("User wants caching enabled.", {
            id: "c1",
            timestamp: "2026-10-12T10:00:00.000Z",
            sessionId: "ses-a",
          }),
          makeObs("user wants caching enabled.", {
            id: "c2",
            timestamp: "2026-10-12T10:01:00.000Z",
            sessionId: "ses-a",
          }),
          makeObs("User wants caching enabled!", {
            id: "c3",
            timestamp: "2026-10-12T10:02:00.000Z",
            sessionId: "ses-a",
          }),
        ],
      }),
    );
    expect(count(md, "caching enabled")).toBe(3);
    expect(md).not.toContain("recorded");
  });

  it("never collapses observations into reflections", () => {
    const md = render(
      makeCorpus({
        observations: [
          makeObs("Shared wording fact", {
            id: "s1",
            timestamp: "2026-10-12T10:00:00.000Z",
            sessionId: "ses-a",
          }),
        ],
        reflections: [
          makeRefl("Shared wording fact", {
            timestamp: "2026-10-12T10:30:00.000Z",
            sessionId: "ses-a",
          }),
        ],
      }),
    );
    expect(count(md, "Shared wording fact")).toBe(2);
    expect(md).toContain("**[observation/high]**");
    expect(md).toContain("**[reflection]**");
  });

  it("excludes dropper-pruned observations and notes the count", () => {
    const md = render(
      makeCorpus({
        observations: [
          makeObs("Pruned fact that must not render", {
            id: "dead-1",
            timestamp: "2026-10-12T10:00:00.000Z",
            sessionId: "ses-a",
          }),
          makeObs("Surviving fact that must render", {
            id: "live-1",
            timestamp: "2026-10-12T11:00:00.000Z",
            sessionId: "ses-a",
          }),
        ],
        droppedIds: ["dead-1"],
      }),
    );
    expect(md).not.toContain("Pruned fact that must not render");
    expect(md).toContain("Surviving fact that must render");
    expect(md).toContain("## Notes");
    expect(md).toContain("1 observation ids were pruned by the dropper pipeline");
  });

  it("omits the Notes section when nothing was pruned", () => {
    const md = render(
      makeCorpus({
        observations: [makeObs("Ordinary surviving fact")],
      }),
    );
    expect(md).not.toContain("## Notes");
  });

  it("notes rolling-snapshot semantics for windowed exports even without drops", () => {
    const md = buildTimelineExportMarkdown(
      makeCorpus({
        observations: [makeObs("Ordinary surviving fact")],
      }),
      { now: NOW, title: TITLE, sinceMs: NOW - 7 * 86400000, untilMs: NOW },
    ).markdown;
    expect(md).toContain("## Notes");
    expect(md).toContain("rolling snapshot");
  });

  it("combines snapshot and dropper notes for windowed exports with drops", () => {
    const md = buildTimelineExportMarkdown(
      makeCorpus({
        observations: [makeObs("Surviving fact that must render", { id: "live-1" })],
        droppedIds: ["dead-1"],
      }),
      { now: NOW, title: TITLE, sinceMs: NOW - 7 * 86400000, untilMs: NOW },
    ).markdown;
    expect(md).toContain("rolling snapshot");
    expect(md).toContain("1 observation ids were pruned by the dropper pipeline");
  });
});

describe("timeline unknown timestamps", () => {
  it("renders timeless entries last without a time part", () => {
    const md = render(
      makeCorpus({
        observations: [
          makeObs("Dated fact with a clock", {
            id: "k1",
            timestamp: "2026-10-12T10:00:00.000Z",
            sessionId: "ses-a",
          }),
          makeObs("Timeless branch fact", {
            id: "k2",
            timestamp: null,
            sessionId: "ses-u1",
          }),
          makeObs("Garbled timestamp fact", {
            id: "k3",
            timestamp: "not-a-date",
            sessionId: "ses-u2",
          }),
        ],
        reflections: [makeRefl("Timeless reflection", { timestamp: null, sessionId: "ses-u1" })],
        entriesWithoutTimestamp: 3,
      }),
    );
    const tailAt = md.indexOf("## Unknown timestamp");
    expect(tailAt).toBeGreaterThan(-1);
    expect(tailAt).toBeGreaterThan(md.indexOf("## 2026-10-12"));
    const tail = md.slice(tailAt);
    expect(tail).toContain("Timeless branch fact");
    expect(tail).toContain("Garbled timestamp fact");
    expect(tail).toContain("Timeless reflection");
    expect(tail).not.toMatch(/`\d{2}:\d{2}:\d{2}Z`/);
    expect(md.slice(0, tailAt)).not.toContain("Timeless branch fact");
  });

  it("sorts the unknown tail by session id, then kind, then content", () => {
    const md = render(
      makeCorpus({
        observations: [
          makeObs("Zulu observation content", {
            id: "u1",
            timestamp: null,
            sessionId: "ses-u2",
          }),
          makeObs("Alpha observation content", {
            id: "u2",
            timestamp: null,
            sessionId: "ses-u1",
          }),
        ],
        reflections: [
          makeRefl("Middle reflection content", { timestamp: null, sessionId: "ses-u1" }),
        ],
        entriesWithoutTimestamp: 3,
      }),
    );
    const tail = md.slice(md.indexOf("## Unknown timestamp"));
    expect(tail.indexOf("Alpha observation content")).toBeLessThan(
      tail.indexOf("Middle reflection content"),
    );
    expect(tail.indexOf("Middle reflection content")).toBeLessThan(
      tail.indexOf("Zulu observation content"),
    );
  });
});

describe("timeline orphans", () => {
  it("renders orphans inline chronologically with orphan provenance", () => {
    const md = render(
      makeCorpus({
        observations: [
          makeObs("Branch morning fact", {
            id: "o1",
            timestamp: "2026-10-12T10:00:00.000Z",
            sessionId: "ses-a",
            source: "branch",
          }),
          makeObs("Orphan midday fact", {
            id: "o2",
            timestamp: "2026-10-12T10:30:00.000Z",
            sessionId: "xyz",
            source: "orphan",
          }),
          makeObs("Pending evening fact", {
            id: "o3",
            timestamp: "2026-10-12T11:00:00.000Z",
            sessionId: "ses-a",
            source: "pending",
          }),
          makeObs("Branch night fact", {
            id: "o4",
            timestamp: "2026-10-12T12:00:00.000Z",
            sessionId: "ses-a",
            source: "branch",
          }),
        ],
        orphanedSessions: 1,
      }),
    );
    expect(md.indexOf("Branch morning fact")).toBeLessThan(md.indexOf("Orphan midday fact"));
    expect(md.indexOf("Orphan midday fact")).toBeLessThan(md.indexOf("Pending evening fact"));
    expect(md.indexOf("Pending evening fact")).toBeLessThan(md.indexOf("Branch night fact"));
    expect(md).toContain("`(orphan session xyz)`");
    expect(md).toContain("`(session ses-a)`");
    expect(md).not.toContain("Unattributed");
  });

  it("counts orphaned entries in stats", () => {
    const { stats } = buildTimelineExportMarkdown(
      makeCorpus({
        observations: [
          makeObs("Orphan observation one", {
            id: "oo1",
            timestamp: "2026-10-12T10:00:00.000Z",
            sessionId: "gone-1",
            source: "orphan",
          }),
        ],
        reflections: [
          makeRefl("Orphan reflection one", {
            timestamp: "2026-10-12T10:30:00.000Z",
            sessionId: "gone-2",
            source: "orphan",
          }),
        ],
        orphanedSessions: 2,
      }),
      { now: NOW, title: TITLE },
    );
    expect(stats.orphanedObservations).toBe(1);
    expect(stats.orphanedReflections).toBe(1);
    expect(stats.orphanedSessions).toBe(2);
  });
});

describe("timeline tie-breaks", () => {
  it("breaks timestamp ties by session, kind, then content — byte-identically", () => {
    const corpus = makeCorpus({
      observations: [
        makeObs("Tie bravo observation", {
          id: "t1",
          timestamp: "2026-10-12T10:00:00.000Z",
          sessionId: "ses-b",
        }),
        makeObs("Tie alpha observation", {
          id: "t2",
          timestamp: "2026-10-12T10:00:00.000Z",
          sessionId: "ses-a",
        }),
      ],
      reflections: [
        makeRefl("Tie alpha reflection", {
          timestamp: "2026-10-12T10:00:00.000Z",
          sessionId: "ses-a",
        }),
      ],
    });
    const first = render(corpus);
    expect(first.indexOf("Tie alpha observation")).toBeLessThan(
      first.indexOf("Tie alpha reflection"),
    );
    expect(first.indexOf("Tie alpha reflection")).toBeLessThan(
      first.indexOf("Tie bravo observation"),
    );
    expect(render(corpus)).toBe(first);
  });
});

describe("timeline keeps what distilled filters", () => {
  it("survives a single-session low that the viability gate removes", () => {
    const corpus = makeCorpus({
      observations: [
        makeObs("Lone low whisper about keybindings", {
          id: "solo-1",
          relevance: "low",
          timestamp: "2026-10-12T10:00:00.000Z",
          sessionId: "ses-solo",
        }),
      ],
    });
    const distilled = buildExportMarkdown(corpus, { now: NOW, title: TITLE });
    expect(distilled.markdown).not.toContain("Lone low whisper about keybindings");
    expect(render(corpus)).toContain("Lone low whisper about keybindings");
  });
});

describe("timeline stats", () => {
  it("reports every TimelineExportStats field", () => {
    const { stats } = buildTimelineExportMarkdown(
      makeCorpus({
        observations: [
          makeObs("Stat fact one", {
            id: "s1",
            timestamp: "2026-10-12T10:00:00.000Z",
            sessionId: "ses-a",
          }),
          makeObs("Stat fact one", {
            id: "s2",
            timestamp: "2026-10-12T11:00:00.000Z",
            sessionId: "ses-b",
          }),
          makeObs("Stat orphan fact", {
            id: "s3",
            timestamp: "2026-10-12T12:00:00.000Z",
            sessionId: "gone-1",
            source: "orphan",
          }),
          makeObs("Stat dropped fact", {
            id: "x",
            timestamp: "2026-10-12T13:00:00.000Z",
            sessionId: "ses-a",
          }),
        ],
        reflections: [
          makeRefl("Stat reflection", {
            timestamp: "2026-10-12T10:30:00.000Z",
            sessionId: "ses-a",
          }),
          makeRefl("Stat orphan reflection", {
            timestamp: null,
            sessionId: "gone-2",
            source: "orphan",
          }),
        ],
        droppedIds: ["x"],
        orphanedSessions: 2,
        sessionsDiscovered: 5,
        sessionsConsidered: 3,
        filesWithMarkers: 2,
        sessionsSkippedByWindow: 2,
        entriesOutsideWindow: 4,
        entriesWithoutTimestamp: 1,
      }),
      { now: NOW, title: TITLE },
    );
    expect(stats).toEqual({
      sessionsDiscovered: 5,
      sessionsScanned: 3,
      filesWithMarkers: 2,
      observationsExported: 2,
      reflectionsExported: 2,
      duplicatesCollapsed: 1,
      entriesOutsideWindow: 4,
      entriesWithoutTimestamp: 1,
      droppedExcluded: 1,
      orphanedObservations: 1,
      orphanedReflections: 1,
      orphanedSessions: 2,
      windowLabel: "all history",
    });
  });

  it("labels a bounded window with ISO bounds", () => {
    const sinceMs = Date.parse("2026-10-09T00:00:00.000Z");
    const untilMs = Date.parse("2026-10-16T00:00:00.000Z");
    const { markdown, stats } = buildTimelineExportMarkdown(makeCorpus(), {
      now: NOW,
      title: TITLE,
      sinceMs,
      untilMs,
    });
    expect(stats.windowLabel).toBe("2026-10-09T00:00:00.000Z → 2026-10-16T00:00:00.000Z");
    expect(markdown).toContain("_Window: 2026-10-09T00:00:00.000Z → 2026-10-16T00:00:00.000Z_");
  });
});

describe("timeline end to end", () => {
  function sessionHeader(id: string): string {
    return JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: "2026-10-12T09:00:00.000Z",
      cwd: join(e2eRoot, "proj"),
    });
  }

  function messageEntry(id: string): string {
    return JSON.stringify({
      type: "message",
      id,
      timestamp: "2026-10-12T09:30:00.000Z",
      message: { role: "user", content: "work" },
    });
  }

  function obsRecorded(
    observations: Array<Record<string, unknown>>,
    reflections: Array<Record<string, unknown>>,
    entryTs: string,
  ): string[] {
    const lines = [
      JSON.stringify({
        type: "custom",
        id: `cust-${entryTs}`,
        timestamp: entryTs,
        customType: "om.observations.recorded",
        data: { observations, coversUpToId: "m1" },
      }),
    ];
    if (reflections.length > 0) {
      lines.push(
        JSON.stringify({
          type: "custom",
          id: `cust-refl-${entryTs}`,
          timestamp: entryTs,
          customType: "om.reflections.recorded",
          data: { reflections, coversUpToId: "m1" },
        }),
      );
    }
    return lines;
  }

  it("builds a chronological timeline from real session files", async () => {
    const { buildProjectMemoryCorpusAsync, encodeScopeDir } =
      await import("../src/project-recall/corpus.js");
    const projectCwd = join(e2eRoot, "proj");
    const agentDir = join(e2eRoot, "agent");
    const scopeDir = join(agentDir, "sessions", encodeScopeDir(projectCwd));
    mkdirSync(scopeDir, { recursive: true });
    const write = (file: string, sessionId: string, lines: string[]): void => {
      writeFileSync(
        join(scopeDir, file),
        [sessionHeader(sessionId), messageEntry("m1"), ...lines].join("\n") + "\n",
        "utf-8",
      );
    };
    const o = (
      id: string,
      content: string,
      relevance: string,
      timestamp: string,
    ): Record<string, unknown> => ({ id, content, relevance, timestamp });
    try {
      write("s1.jsonl", "ses-e2e-1", [
        ...obsRecorded(
          [o("e1", "E2E low early note", "low", "2026-10-12T10:00:00.000Z")],
          [
            {
              content: "E2E midday synthesis",
              timestamp: "2026-10-12T10:30:00.000Z",
              supportingObservationIds: [],
            },
          ],
          "2026-10-12T10:30:00.000Z",
        ),
      ]);
      write("s2.jsonl", "ses-e2e-2", [
        ...obsRecorded(
          [
            o("e2", "E2E critical late note", "critical", "2026-10-12T11:00:00.000Z"),
            o(
              "e3",
              "the export command writes a markdown file to disk",
              "high",
              "2026-10-12T11:30:00.000Z",
            ),
            o(
              "e4",
              "the export command writes a markdown file too disk",
              "high",
              "2026-10-12T11:35:00.000Z",
            ),
          ],
          [],
          "2026-10-12T11:35:00.000Z",
        ),
      ]);

      const corpus = await buildProjectMemoryCorpusAsync({ cwd: projectCwd, agentDir });
      const { markdown } = buildTimelineExportMarkdown(corpus, { now: NOW, title: TITLE });

      expect(markdown).toContain("# Project memory timeline — proj");
      const order = [
        "E2E low early note",
        "E2E midday synthesis",
        "E2E critical late note",
        "writes a markdown file to disk",
      ];
      for (let i = 0; i < order.length - 1; i++) {
        expect(markdown.indexOf(order[i])).toBeLessThan(markdown.indexOf(order[i + 1]));
      }
      // The fuzzy pair differs by one word: both survive timeline mode.
      expect(markdown).toContain("writes a markdown file too disk");
    } finally {
      rmSync(e2eRoot, { recursive: true, force: true });
    }
  });
});
