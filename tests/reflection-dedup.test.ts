/**
 * Failing-first tests for export dedup improvements:
 * fuzzy reflection clustering, hidden (non-rendered) variants,
 * reflection-wins cross-section suppression, and coverage that
 * survives variant hiding.
 *
 * Pure unit tests over buildExportMarkdown — no fs, no network.
 */
import { describe, it, expect } from "vitest";
import { clusterReflections } from "../src/project-recall/dedup.js";
import { buildExportMarkdown } from "../src/project-recall/format-export.js";
import type {
  CorpusObservation,
  CorpusReflection,
  ProjectCorpus,
} from "../src/project-recall/corpus.js";
import type { Relevance } from "../src/om/ledger/types.js";

const NOW = Date.parse("2026-09-10T08:23:00.000Z");
const DAY = "2026-09-08T00:00:00.000Z";
const OLDER = "2026-09-07T00:00:00.000Z";

// Verbatim near-duplicate pair from memory-export-202609100823.md (L155-156):
// single-word diff ("and replaces" vs ", replacing").
const RECALL_A =
  "feat/recall-progressive-discovery branch has a minor breaking change: removes files:[...] suffix from recall output format and replaces it with richer fileMatches section";
const RECALL_B =
  "feat/recall-progressive-discovery branch has a minor breaking change: removes files:[...] suffix from recall output format, replacing it with richer fileMatches section";

function obs(
  id: string,
  content: string,
  relevance: Relevance = "high",
  timestamp: string = DAY,
  sessionId = "s1",
): CorpusObservation {
  return { id, content, relevance, timestamp, sessionId, source: "branch" };
}

function refl(
  content: string,
  supportingObservationIds: string[] = [],
  timestamp: string = DAY,
  sessionId = "s1",
): CorpusReflection {
  return { content, supportingObservationIds, timestamp, sessionId, source: "branch" };
}

function corpus(observations: CorpusObservation[], reflections: CorpusReflection[]): ProjectCorpus {
  return {
    projectRoot: "/tmp/proj",
    sessionsConsidered: 2,
    filesWithMarkers: 2,
    observations,
    reflections,
    droppedIds: new Set<string>(),
    knownSessionIds: new Set(["s1", "s2"]),
    orphanedSessions: 0,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("reflection fuzzy clustering", () => {
  it("merges a one-word reflection paraphrase into one cluster", () => {
    const clusters = clusterReflections(
      [refl(RECALL_A, [], OLDER, "s1"), refl(RECALL_B, [], DAY, "s2")],
      {
        fuzzy: true,
        sorensen: true,
      },
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0].occurrences).toBe(2);
    expect(clusters[0].distinctSessions).toBe(2);
  });

  it("keeps exact-only grouping when no opts are passed", () => {
    const clusters = clusterReflections([
      refl(RECALL_A, [], OLDER, "s1"),
      refl(RECALL_B, [], DAY, "s2"),
    ]);
    expect(clusters).toHaveLength(2);
  });

  it("keeps topically related but distinct reflections separate", () => {
    const clusters = clusterReflections(
      [
        refl(
          "completed: merged PR #8 (lockstep sync) into main, tagged v0.2.3, and pushed to origin triggering CI publish workflow",
        ),
        refl(
          "completed: deleted feat/compaction-output-cap branch (34c6c66) as dead weight since its feature work was already recovered through lockstep PR",
        ),
      ],
      { fuzzy: true, sorensen: true },
    );
    expect(clusters).toHaveLength(2);
  });
});

describe("export variant hiding", () => {
  const pair = () => [
    obs("aaaa00000001", "the export command writes a markdown file to disk", "high", OLDER, "s1"),
    obs("aaaa00000002", "the export command writes a markdown file too disk", "high", DAY, "s2"),
  ];

  it("renders a fuzzy observation pair as a single bullet", () => {
    const { markdown } = buildExportMarkdown(corpus(pair(), []), { now: NOW, title: "proj" });
    // Rep is the newest member ("too disk" variant); the older text is hidden.
    expect(countOccurrences(markdown, "markdown file too disk")).toBe(1);
    expect(countOccurrences(markdown, "markdown file to disk")).toBe(0);
  });

  it("records the hidden variant count instead of a sub-bullet", () => {
    const { markdown } = buildExportMarkdown(corpus(pair(), []), { now: NOW, title: "proj" });
    expect(markdown).toContain("+1 variant");
    const subBullets = markdown.split("\n").filter((l) => l.startsWith("  - "));
    expect(subBullets).toHaveLength(0);
  });
});

describe("reflection-wins cross-section suppression", () => {
  it("suppresses an observation that restates a rendered reflection", () => {
    const { markdown } = buildExportMarkdown(
      corpus([obs("aaaa00000001", RECALL_B)], [refl(RECALL_B)]),
      {
        now: NOW,
        title: "proj",
      },
    );
    // Exactly one rendering survives: the reflection.
    expect(countOccurrences(markdown, "richer fileMatches section")).toBe(1);
    expect(markdown).toContain("## Reflections");
  });

  it("keeps an observation that merely shares topic vocabulary with a reflection", () => {
    const distinct =
      "completed: deleted feat/compaction-output-cap branch (34c6c66) as dead weight since its feature work was already recovered through lockstep PR";
    const { markdown } = buildExportMarkdown(
      corpus(
        [obs("aaaa00000001", distinct)],
        [
          refl(
            "completed: merged PR #8 (lockstep sync) into main, tagged v0.2.3, and pushed to origin triggering CI publish workflow",
          ),
        ],
      ),
      { now: NOW, title: "proj" },
    );
    expect(countOccurrences(markdown, "deleted feat/compaction-output-cap branch")).toBe(1);
    expect(markdown).toContain("## High");
  });
});

describe("coverage survives variant hiding", () => {
  it("keeps a single-session medium cluster cited only through a non-rep variant id", () => {
    // Four distinct single-word variants; the cited member (m3) falls beyond
    // the old extras cap, so only uncapped member-id tracking preserves coverage.
    const members = [
      obs(
        "aaaa00000001",
        "the export writes markdown to disk",
        "medium",
        "2026-09-05T00:00:00.000Z",
      ),
      obs(
        "aaaa00000002",
        "the export writes markdown too disk",
        "medium",
        "2026-09-06T00:00:00.000Z",
      ),
      obs(
        "aaaa00000003",
        "the export writes markdown two disk",
        "medium",
        "2026-09-06T12:00:00.000Z",
      ),
      obs("aaaa00000004", "the export writes markdown 2 disk", "medium", DAY),
    ];
    const { markdown } = buildExportMarkdown(
      corpus(members, [refl("Export behavior is verified", ["aaaa00000003"])]),
      { now: NOW, title: "proj" },
    );
    // Rep is the newest member; the cluster survives via m3's citation.
    expect(markdown).toContain("the export writes markdown 2 disk");
  });
});
