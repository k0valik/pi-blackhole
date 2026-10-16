/**
 * Tests for /blackhole-export command — distilled project-memory export.
 * Fixtures are inline JSONL v3 sessions + OM pending buffers under a temp
 * agentDir; no network, no real sessions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testRoot = join(tmpdir(), `pi-blackhole-export-test-${process.pid}-${Date.now()}`);
const agentDir = join(testRoot, "agent");
const projectCwd = join(testRoot, "proj");

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => agentDir,
}));

import { registerBlackholeExportCommand } from "../src/commands/blackhole-export.js";
import { relativeTime } from "../src/project-recall/format-export.js";
import { encodeScopeDir } from "../src/project-recall/corpus.js";

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

function sessionHeader(id: string): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: daysAgo(10),
    cwd: projectCwd,
  });
}

function messageEntry(id: string, role: string, text: string): string {
  return JSON.stringify({
    type: "message",
    id,
    timestamp: daysAgo(5),
    message: { role, content: text },
  });
}

let custCounter = 0;
function customEntry(customType: string, data: Record<string, unknown>, ts: string): string {
  return JSON.stringify({
    type: "custom",
    id: `cust-${++custCounter}`,
    timestamp: ts,
    customType,
    data,
  });
}

const obsRecorded = (
  observations: Array<Record<string, unknown>>,
  coversUpToId: string,
  ts: string,
) => customEntry("om.observations.recorded", { observations, coversUpToId }, ts);

function writeSession(scope: string, file: string, lines: string[]): void {
  const dir = join(agentDir, "sessions", scope);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), lines.join("\n") + "\n", "utf-8");
}

const PNPM = "Use pnpm for all package installs in this repo";
const FUZZY_A = "the export command writes a markdown file to disk";
const FUZZY_B = "the export command writes a markdown file too disk";

function createFixtures(): void {
  mkdirSync(projectCwd, { recursive: true });
  const scope = encodeScopeDir(projectCwd);

  writeSession(scope, "s1.jsonl", [
    sessionHeader("ses-1"),
    messageEntry("m1", "user", "hello"),
    obsRecorded(
      [
        {
          id: "aaaa00000001",
          content: PNPM,
          relevance: "high",
          timestamp: daysAgo(4),
          sourceEntryIds: ["m1"],
          tokenCount: 12,
        },
        {
          id: "aaaa00000002",
          content: "User prefers terse answers",
          relevance: "low",
          timestamp: daysAgo(4),
          sourceEntryIds: ["m1"],
          tokenCount: 6,
        },
      ],
      "m1",
      daysAgo(4),
    ),
    JSON.stringify({
      type: "compaction",
      id: "comp-1",
      timestamp: daysAgo(3),
      summary: "compact",
      firstKeptEntryId: "m1",
    }),
    messageEntry("m2", "assistant", "after compaction"),
    obsRecorded(
      [
        {
          id: "aaaa00000003",
          content: "Ship releases only on Fridays",
          relevance: "critical",
          timestamp: daysAgo(2),
          sourceEntryIds: ["m1", "m2"],
          tokenCount: 9,
        },
        {
          id: "aaaa00000004",
          content: FUZZY_A,
          relevance: "high",
          timestamp: daysAgo(2),
          sourceEntryIds: ["m2"],
          tokenCount: 11,
        },
      ],
      "m2",
      daysAgo(2),
    ),
  ]);

  writeSession(scope, "s2.jsonl", [
    sessionHeader("ses-2"),
    messageEntry("k1", "user", "more"),
    obsRecorded(
      [
        {
          id: "bbbb00000001",
          content: PNPM,
          relevance: "high",
          timestamp: daysAgo(1),
          sourceEntryIds: ["k1"],
          tokenCount: 12,
        },
        {
          id: "bbbb00000002",
          content: FUZZY_B,
          relevance: "high",
          timestamp: daysAgo(1),
          sourceEntryIds: ["k1"],
          tokenCount: 11,
        },
      ],
      "k1",
      daysAgo(1),
    ),
    customEntry(
      "om.reflections.recorded",
      {
        reflections: [
          {
            id: "cccc00000001",
            content: "Build tooling hygiene is settled",
            supportingObservationIds: ["aaaa00000001", "bbbb00000001"],
            tokenCount: 8,
          },
        ],
        coversUpToId: "k1",
      },
      daysAgo(1),
    ),
    customEntry(
      "om.observations.dropped",
      { observationIds: ["aaaa00000002"], coversUpToId: "k1" },
      daysAgo(1),
    ),
  ]);

  writeSession(scope, "nomarkers.jsonl", [
    sessionHeader("ses-3"),
    messageEntry("n1", "user", "no memory here"),
  ]);
  writeSession("--elsewhere--", "other.jsonl", [
    sessionHeader("ses-x"),
    messageEntry("x1", "user", "unrelated"),
    obsRecorded(
      [
        {
          id: "dddd00000001",
          content: "Foreign project memory should never appear",
          relevance: "critical",
          timestamp: daysAgo(1),
          sourceEntryIds: ["x1"],
          tokenCount: 9,
        },
      ],
      "x1",
      daysAgo(1),
    ),
  ]);

  const bhDir = join(agentDir, "pi-blackhole");
  mkdirSync(bhDir, { recursive: true });
  writeFileSync(
    join(bhDir, "ses-1-pending.json"),
    JSON.stringify({
      observationBatches: [
        {
          coversUpToId: "m2",
          data: {
            observations: [
              {
                id: "eeee00000001",
                content: "Pending insight about export ranking",
                relevance: "critical",
                timestamp: daysAgo(1),
              },
            ],
          },
        },
      ],
    }),
    "utf-8",
  );
  writeFileSync(
    join(bhDir, "orphan123-pending.json"),
    JSON.stringify({
      observationBatches: [
        {
          coversUpToId: "gone",
          data: {
            observations: [
              {
                id: "ffff00000001",
                content: "Orphan memory recovered from lost session",
                relevance: "medium",
                timestamp: daysAgo(30),
              },
            ],
          },
        },
      ],
    }),
    "utf-8",
  );
  writeFileSync(
    join(bhDir, "cursoronly-pending.json"),
    JSON.stringify({
      cursors: { observer: { entryId: "m1", state: "recorded" } },
    }),
    "utf-8",
  );
  writeFileSync(
    join(bhDir, "orphan456-pending.json"),
    JSON.stringify({
      observationBatches: [
        {
          coversUpToId: "gone2",
          data: {
            observations: [
              {
                id: "ffff00000002",
                content: "Orphan memory recovered from lost session",
                relevance: "medium",
                timestamp: daysAgo(20),
              },
            ],
          },
        },
      ],
    }),
    "utf-8",
  );
}

function createMockEnv() {
  const sentMessages: Array<{ content: string; customType: string }> = [];
  const handlerMap = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const pi: any = {
    registerCommand: vi.fn(
      (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        handlerMap.set(name, def.handler);
      },
    ),
    sendMessage: vi.fn((msg: { content: string; customType: string }) => {
      sentMessages.push(msg);
    }),
  };
  const ctx: any = {
    cwd: projectCwd,
    ui: { notify: vi.fn() },
    sessionManager: { getSessionFile: () => undefined },
  };
  return { pi, handlerMap, sentMessages, ctx };
}

describe("/blackhole-export", () => {
  beforeEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
    mkdirSync(testRoot, { recursive: true });
    createFixtures();
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("exports tiers, dedup, reflections, dropper notes and orphans to markdown", async () => {
    const env = createMockEnv();
    registerBlackholeExportCommand(env.pi);
    const handler = env.handlerMap.get("blackhole-export");
    expect(handler).toBeDefined();
    await handler!("", env.ctx);

    const outFile = readdirSync(projectCwd).find(
      (f) => f.startsWith("memory-export-") && f.endsWith(".md"),
    );
    expect(outFile).toBeDefined();
    const md = readFileSync(join(projectCwd, outFile!), "utf-8");

    expect(md).toContain("# Project memory export — proj");
    expect(md).toContain("## Critical");
    expect(md).toContain("Ship releases only on Fridays");
    expect(md).toContain("Pending insight about export ranking");
    expect(md).not.toContain("Foreign project memory");

    expect(md).toContain("## High");
    expect(md).toContain(`- ${PNPM}`);
    expect(md.match(/Use pnpm for all package installs/g)?.length).toBe(1);
    expect(md).toContain("across 2 sessions");
    // Fuzzy near-dupe collapses to one bullet with a hidden-variant count.
    expect(md.match(/markdown file to(o)? disk/g)?.length).toBe(1);
    expect(md).toContain("+1 variant");

    expect(md).not.toContain("User prefers terse answers");
    expect(md).toContain("dropper pipeline");

    expect(md).toContain("## Reflections");
    expect(md).toContain("Build tooling hygiene is settled");
    // Reflector-curated insights outrank raw observations (author note, §19.6)
    expect(md.indexOf("## Reflections")).toBeLessThan(md.indexOf("## Critical"));

    expect(md).toContain("## Unattributed pending memory");
    expect(md).toContain("Orphan memory recovered from lost session");

    expect(env.sentMessages).toHaveLength(1);
    expect(env.sentMessages[0].customType).toBe("blackhole-export");
    expect(env.sentMessages[0].content).toContain(outFile!);
    expect(env.sentMessages[0].content).toContain("duplicates collapsed");
  });

  it("honors out:<path> argument", async () => {
    const env = createMockEnv();
    registerBlackholeExportCommand(env.pi);
    await env.handlerMap.get("blackhole-export")!("out:custom-export.md", env.ctx);
    expect(readFileSync(join(projectCwd, "custom-export.md"), "utf-8")).toContain(
      "# Project memory export",
    );
  });

  it("rejects out:<path> that escapes current directory", async () => {
    const env = createMockEnv();
    registerBlackholeExportCommand(env.pi);
    await env.handlerMap.get("blackhole-export")!("out:../escape.md", env.ctx);
    expect(readdirSync(projectCwd).filter((f) => f.endsWith(".md"))).toHaveLength(0);
    expect(env.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("escapes current directory"),
      "error",
    );
  });

  it("allows absolute out:<path> on any platform", async () => {
    const env = createMockEnv();
    registerBlackholeExportCommand(env.pi);
    const absPath = join(tmpdir(), `blackhole-export-${Date.now()}.md`);
    await env.handlerMap.get("blackhole-export")!(`out:${absPath}`, env.ctx);
    expect(readFileSync(absPath, "utf-8")).toContain("# Project memory export");
    try {
      rmSync(absPath);
    } catch {
      /* best-effort cleanup */
    }
  });

  it("rejects out:<path> without .md extension", async () => {
    const env = createMockEnv();
    registerBlackholeExportCommand(env.pi);
    await env.handlerMap.get("blackhole-export")!("out:export.txt", env.ctx);
    expect(readdirSync(projectCwd).filter((f) => f.endsWith(".txt"))).toHaveLength(0);
    expect(env.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("must be a markdown file"),
      "error",
    );
  });

  it("notifies without writing when the project has no memory", async () => {
    rmSync(agentDir, { recursive: true, force: true });
    mkdirSync(agentDir, { recursive: true });
    const emptyScope = encodeScopeDir(projectCwd);
    writeSession(emptyScope, "plain.jsonl", [
      sessionHeader("ses-9"),
      messageEntry("z1", "user", "nothing"),
    ]);

    const env = createMockEnv();
    registerBlackholeExportCommand(env.pi);
    await env.handlerMap.get("blackhole-export")!("", env.ctx);

    expect(env.sentMessages).toHaveLength(0);
    expect(env.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No observational memory"),
      "warning",
    );
    expect(readdirSync(projectCwd).filter((f) => f.endsWith(".md"))).toHaveLength(0);
  });

  it("inferReflectionTier falls back to medium when no observation resolves", async () => {
    const { buildProjectMemoryCorpusAsync } = await import("../src/project-recall/corpus.js");
    const { buildExportMarkdown } = await import("../src/project-recall/format-export.js");

    const scope = encodeScopeDir(projectCwd);
    writeSession(scope, "refl-only.jsonl", [
      sessionHeader("ses-refl"),
      messageEntry("mr1", "user", "test"),
      JSON.stringify({
        type: "custom",
        id: "cust-refl",
        timestamp: daysAgo(1),
        customType: "om.reflections.recorded",
        data: {
          reflections: [
            {
              id: "refl-1",
              content: "Unsupported reflection",
              supportingObservationIds: ["nonexistent-id"],
              tokenCount: 5,
            },
          ],
          coversUpToId: "mr1",
        },
      }),
    ]);

    const corpus = await buildProjectMemoryCorpusAsync({ cwd: projectCwd, agentDir });
    const { markdown } = buildExportMarkdown(corpus, {
      now: Date.now(),
      title: "proj",
    });
    expect(markdown).toContain("### Medium reflections");
    expect(markdown).not.toContain("### Low reflections");
  });

  it("includes branch unanchored markers as kept facts", async () => {
    const { buildProjectMemoryCorpusAsync } = await import("../src/project-recall/corpus.js");

    const scope = encodeScopeDir(projectCwd);
    writeSession(scope, "unanchored.jsonl", [
      sessionHeader("ses-unanchored"),
      messageEntry("u1", "user", "tail work"),
      customEntry(
        "om.observations.unanchored",
        {
          observations: [
            {
              id: "eeee00000009",
              content: "Kept tail fact without coverage claim",
              relevance: "high",
              timestamp: daysAgo(1),
              sourceEntryIds: ["u1"],
              tokenCount: 9,
            },
          ],
        },
        daysAgo(1),
      ),
    ]);

    const corpus = await buildProjectMemoryCorpusAsync({ cwd: projectCwd, agentDir });
    // Coverage-inert markers are still facts: recall/export must serve them.
    expect(corpus.observations.map((o) => o.content)).toContain(
      "Kept tail fact without coverage claim",
    );
  });

  it("includes pending unanchored batches, including unanchored-only files", async () => {
    const { buildProjectMemoryCorpusAsync } = await import("../src/project-recall/corpus.js");

    const bhDir = join(agentDir, "pi-blackhole");
    // Known session: kept facts join its attributed pending memory.
    writeFileSync(
      join(bhDir, "ses-2-pending.json"),
      JSON.stringify({
        unanchoredBatches: [
          {
            data: {
              observations: [
                {
                  id: "eeee00000009",
                  content: "Pending kept tail fact",
                  relevance: "medium",
                  timestamp: daysAgo(1),
                },
              ],
            },
          },
        ],
      }),
      "utf-8",
    );
    // Unknown session with nothing but unanchored batches: still orphaned
    // memory, not a skipped file.
    writeFileSync(
      join(bhDir, "orphan789-pending.json"),
      JSON.stringify({
        unanchoredBatches: [
          {
            data: {
              observations: [
                {
                  id: "ffff00000009",
                  content: "Orphan kept tail fact",
                  relevance: "medium",
                  timestamp: daysAgo(2),
                },
              ],
            },
          },
        ],
      }),
      "utf-8",
    );

    const corpus = await buildProjectMemoryCorpusAsync({ cwd: projectCwd, agentDir });
    const contents = corpus.observations.map((o) => o.content);
    expect(contents).toContain("Pending kept tail fact");
    expect(contents).toContain("Orphan kept tail fact");
    expect(corpus.orphanedSessions).toBe(3);
  });

  it("relativeTime formats sensibly", () => {
    const now = Date.now();
    expect(relativeTime(new Date(now - 30 * 1000).toISOString(), now)).toBe("just now");
    expect(relativeTime(new Date(now - 5 * 60000).toISOString(), now)).toBe("5m ago");
    expect(relativeTime(new Date(now - 3 * 3600000).toISOString(), now)).toBe("3h ago");
    expect(relativeTime(new Date(now - 3 * 86400000).toISOString(), now)).toBe("3d ago");
    expect(relativeTime(new Date(now - 21 * 86400000).toISOString(), now)).toBe("3w ago");
    expect(relativeTime(null, now)).toBeNull();
  });

  it("prefilter keeps marker-less sessions cheap but counted", async () => {
    const { buildProjectMemoryCorpusAsync } = await import("../src/project-recall/corpus.js");
    const corpus = await buildProjectMemoryCorpusAsync({ cwd: projectCwd, agentDir });
    expect(corpus.sessionsConsidered).toBe(3);
    expect(corpus.filesWithMarkers).toBe(2);
    expect(corpus.knownSessionIds.has("ses-1")).toBe(true);
    expect(corpus.orphanedSessions).toBe(2);
  });
});

describe("reflection export timestamps", () => {
  afterEach(() => rmSync(testRoot, { recursive: true, force: true }));
  it.each([
    ["2026-10-03 14:05", "2026-10-03 14:05"],
    [undefined, "2026-10-04T00:00:00.000Z"],
    ["42", "2026-10-04T00:00:00.000Z"],
    ["2026-02-29 14:05", "2026-10-04T00:00:00.000Z"],
    ["2026-04-31T12:00:00.000Z", "2026-10-04T00:00:00.000Z"],
    ["2026-10-03 24:00", "2026-10-04T00:00:00.000Z"],
    ["2024-02-29T14:05:00.000Z", "2024-02-29T14:05:00.000Z"],
    ["2026-05-02 10:00 PST", "2026-10-04T00:00:00.000Z"],
    ["2026-10-03 14:05 junk", "2026-10-04T00:00:00.000Z"],
    ["2026-10-03 14:05 +02:00", "2026-10-04T00:00:00.000Z"],
  ])("uses evidence time or entry fallback: %s", async (timestamp, expected) => {
    const { buildProjectMemoryCorpusAsync } = await import("../src/project-recall/corpus.js");
    writeSession(encodeScopeDir(projectCwd), "reflection-time.jsonl", [
      sessionHeader("reflection-time"),
      customEntry(
        "om.reflections.recorded",
        {
          reflections: [{ content: "Evidence time test", timestamp }],
        },
        "2026-10-04T00:00:00.000Z",
      ),
    ]);
    const options = { cwd: projectCwd, agentDir };
    const corpus = await buildProjectMemoryCorpusAsync(options);
    expect(corpus.reflections[0]?.timestamp).toEqual(expected);
  });
});

describe("pending reflection timestamps", () => {
  afterEach(() => rmSync(testRoot, { recursive: true, force: true }));
  it.each(["2026-10-03 14:05", undefined, "invalid", "2026-10-03 14:05 PST"])(
    "prefers own timestamp or legacy fallback %s",
    async (timestamp) => {
      const { buildProjectMemoryCorpusAsync } = await import("../src/project-recall/corpus.js");
      writeSession(encodeScopeDir(projectCwd), "pending-time.jsonl", [
        sessionHeader("pending-time"),
      ]);
      const dir = join(agentDir, "pi-blackhole");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "pending-time-pending.json"),
        JSON.stringify({
          observationBatches: [
            {
              data: {
                observations: [{ content: "Evidence", timestamp: "2026-10-04T00:00:00.000Z" }],
              },
            },
          ],
          reflectionBatches: [
            {
              data: {
                reflections: [
                  { content: "Pending durable fact", timestamp, supersedes: ["aaaaaaaaaaaa"] },
                ],
              },
            },
          ],
        }),
      );
      expect(
        (await buildProjectMemoryCorpusAsync({ cwd: projectCwd, agentDir })).reflections[0]
          ?.timestamp,
      ).toBe(timestamp === "2026-10-03 14:05" ? timestamp : "2026-10-04T00:00:00.000Z");
    },
  );
});

describe("blackhole-export days/mode wiring (Phase 4)", () => {
  beforeEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
    mkdirSync(testRoot, { recursive: true });
    createFixtures();
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it.each(["days:0", "days:-5", "days:wat", "mode:foo"])(
    "rejects invalid args %s without writing",
    async (args) => {
      const env = createMockEnv();
      registerBlackholeExportCommand(env.pi);
      await env.handlerMap.get("blackhole-export")!(args, env.ctx);
      expect(env.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Invalid"), "error");
      expect(env.sentMessages).toHaveLength(0);
      expect(readdirSync(projectCwd).filter((f) => f.endsWith(".md"))).toHaveLength(0);
    },
  );

  it("days:7 distilled excludes out-of-window orphan memory but keeps recent facts", async () => {
    const env = createMockEnv();
    registerBlackholeExportCommand(env.pi);
    await env.handlerMap.get("blackhole-export")!("days:7 out:windowed-distilled.md", env.ctx);
    const md = readFileSync(join(projectCwd, "windowed-distilled.md"), "utf-8");
    expect(md).toContain("# Project memory export");
    expect(md).toContain("Ship releases only on Fridays");
    expect(md).not.toContain("Orphan memory recovered from lost session");
  });

  it("mode:timeline writes a chronological timeline file", async () => {
    const env = createMockEnv();
    registerBlackholeExportCommand(env.pi);
    await env.handlerMap.get("blackhole-export")!(
      "days:7 mode:timeline out:timeline-weekly.md",
      env.ctx,
    );
    const md = readFileSync(join(projectCwd, "timeline-weekly.md"), "utf-8");
    expect(md).toContain("# Project memory timeline");
    expect(md).toContain("exact duplicates only");
    expect(md).toContain("Ship releases only on Fridays");
    expect(md).not.toContain("Orphan memory recovered from lost session");
  });

  it("mode:timeline summary reports Window without ranking lines", async () => {
    const env = createMockEnv();
    registerBlackholeExportCommand(env.pi);
    await env.handlerMap.get("blackhole-export")!(
      "days:7 mode:timeline out:timeline-summary.md",
      env.ctx,
    );
    expect(env.sentMessages).toHaveLength(1);
    const content = env.sentMessages[0].content;
    expect(content).toContain("Window:");
    expect(content).toContain("Sessions:");
    expect(content).toContain("Observations:");
    expect(content).toContain("Reflections:");
    expect(content).not.toContain("viability gate");
    expect(content).not.toContain("topic groups");
  });

  it("days:7 with no memory notifies the windowed empty message and writes nothing", async () => {
    rmSync(agentDir, { recursive: true, force: true });
    mkdirSync(agentDir, { recursive: true });
    const emptyScope = encodeScopeDir(projectCwd);
    writeSession(emptyScope, "plain.jsonl", [
      sessionHeader("ses-9"),
      messageEntry("z1", "user", "nothing"),
    ]);

    const env = createMockEnv();
    registerBlackholeExportCommand(env.pi);
    await env.handlerMap.get("blackhole-export")!("days:7", env.ctx);

    expect(env.sentMessages).toHaveLength(0);
    expect(env.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("in the last 7 days"),
      "warning",
    );
    expect(readdirSync(projectCwd).filter((f) => f.endsWith(".md"))).toHaveLength(0);
  });
});
