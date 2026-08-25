/**
 * Tests for /blackhole-export command — distilled project-memory export.
 * Fixtures are inline JSONL v3 sessions + OM pending buffers under a temp
 * agentDir; no network, no real sessions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testRoot = join(
  tmpdir(),
  `pi-blackhole-export-test-${process.pid}-${Date.now()}`,
);
const agentDir = join(testRoot, "agent");
const projectCwd = join(testRoot, "proj");

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => agentDir,
}));

import { registerBlackholeExportCommand } from "../src/commands/blackhole-export.js";
import { relativeTime } from "../src/project-recall/format-export.js";
import { encodeScopeDir } from "../src/project-recall/corpus.js";

const daysAgo = (n: number) =>
  new Date(Date.now() - n * 86400000).toISOString();

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
function customEntry(
  customType: string,
  data: Record<string, unknown>,
  ts: string,
): string {
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
) =>
  customEntry("om.observations.recorded", { observations, coversUpToId }, ts);

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
}

function createMockEnv() {
  const sentMessages: Array<{ content: string; customType: string }> = [];
  const handlerMap = new Map<
    string,
    (args: string, ctx: unknown) => Promise<void>
  >();
  const pi: any = {
    registerCommand: vi.fn(
      (
        name: string,
        def: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) => {
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
    expect(md).toContain("seen across 2 sessions");
    // Fuzzy near-dupe renders as rep + one capped variant (plan A.1: at most 2-3)
    expect(md.match(/markdown file to(o)? disk/g)?.length).toBe(2);

    expect(md).not.toContain("User prefers terse answers");
    expect(md).toContain("dropper pipeline");

    expect(md).toContain("## Reflections");
    expect(md).toContain("Build tooling hygiene is settled");
    // Reflector-curated insights outrank raw observations (author note, §19.6)
    expect(md.indexOf("## Reflections")).toBeLessThan(
      md.indexOf("## Critical"),
    );

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
    await env.handlerMap.get("blackhole-export")!(
      "out:custom-export.md",
      env.ctx,
    );
    expect(
      readFileSync(join(projectCwd, "custom-export.md"), "utf-8"),
    ).toContain("# Project memory export");
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
    expect(
      readdirSync(projectCwd).filter((f) => f.endsWith(".md")),
    ).toHaveLength(0);
  });

  it("relativeTime formats sensibly", () => {
    const now = Date.now();
    expect(relativeTime(new Date(now - 30 * 1000).toISOString(), now)).toBe(
      "just now",
    );
    expect(relativeTime(new Date(now - 5 * 60000).toISOString(), now)).toBe(
      "5m ago",
    );
    expect(relativeTime(new Date(now - 3 * 3600000).toISOString(), now)).toBe(
      "3h ago",
    );
    expect(relativeTime(new Date(now - 3 * 86400000).toISOString(), now)).toBe(
      "3d ago",
    );
    expect(relativeTime(new Date(now - 21 * 86400000).toISOString(), now)).toBe(
      "3w ago",
    );
    expect(relativeTime(null, now)).toBeNull();
  });

  it("prefilter keeps marker-less sessions cheap but counted", async () => {
    const { buildProjectMemoryCorpus } =
      await import("../src/project-recall/corpus.js");
    const corpus = buildProjectMemoryCorpus({ cwd: projectCwd, agentDir });
    expect(corpus.sessionsConsidered).toBe(3);
    expect(corpus.filesWithMarkers).toBe(2);
    expect(corpus.knownSessionIds.has("ses-1")).toBe(true);
    expect(corpus.orphanedSessions).toBe(1);
  });
});
