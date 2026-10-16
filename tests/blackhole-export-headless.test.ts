/**
 * Tests for the headless `--blackhole-export "<args>"` flag (plan-extract-timeline §14).
 *
 * The flag path reuses the slash-command core (`runBlackholeExport`) through a
 * `session_start` hook. Fixtures are inline JSONL v3 sessions under a temp
 * agentDir; no network, no real sessions, no real `pi` binary (the sandbox
 * probe against the real binary is manual evidence, not committed here).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testRoot = join(tmpdir(), `pi-blackhole-export-headless-test-${process.pid}-${Date.now()}`);
const agentDir = join(testRoot, "agent");
const projectCwd = join(testRoot, "proj");

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => agentDir,
}));

import {
  registerBlackholeExportFlag,
  runBlackholeExport,
} from "../src/commands/blackhole-export.js";
import { encodeScopeDir } from "../src/project-recall/corpus.js";

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

function writeSessionFile(lines: string[]): void {
  const dir = join(agentDir, "sessions", encodeScopeDir(projectCwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "seed.jsonl"), lines.join("\n") + "\n", "utf-8");
}

function seedMemory(): void {
  mkdirSync(projectCwd, { recursive: true });
  writeSessionFile([
    JSON.stringify({
      type: "session",
      version: 3,
      id: "ses-headless",
      timestamp: daysAgo(2),
      cwd: projectCwd,
    }),
    JSON.stringify({
      type: "message",
      id: "m1",
      timestamp: daysAgo(1),
      message: { role: "user", content: "hello" },
    }),
    JSON.stringify({
      type: "custom",
      id: "cust-1",
      timestamp: daysAgo(1),
      customType: "om.observations.recorded",
      data: {
        observations: [
          {
            id: "aaaa00000001",
            content: "Headless probe fact",
            relevance: "high",
            timestamp: daysAgo(1),
            sourceEntryIds: ["m1"],
            tokenCount: 5,
          },
        ],
        coversUpToId: "m1",
      },
    }),
  ]);
}

interface FlagHarness {
  pi: {
    registerFlag: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    getFlag: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
  };
  flagName: string;
  sessionStartHandler: (event: unknown, ctx: unknown) => unknown;
  ctx: {
    cwd: string;
    ui: { notify: ReturnType<typeof vi.fn> };
    sessionManager: { getSessionFile: () => undefined };
    shutdown: ReturnType<typeof vi.fn>;
  };
}

function createFlagHarness(flagValue: unknown): FlagHarness {
  const pi = {
    registerFlag: vi.fn(),
    on: vi.fn(),
    getFlag: vi.fn(() => flagValue),
    sendMessage: vi.fn(),
  };
  registerBlackholeExportFlag(pi as never);
  const flagName = pi.registerFlag.mock.calls[0]?.[0] as string;
  const sessionStartHandler = pi.on.mock.calls.find((c) => c[0] === "session_start")?.[1] as (
    event: unknown,
    ctx: unknown,
  ) => unknown;
  const ctx = {
    cwd: projectCwd,
    ui: { notify: vi.fn() },
    sessionManager: { getSessionFile: () => undefined },
    shutdown: vi.fn(),
  };
  return { pi, flagName, sessionStartHandler, ctx };
}

describe("headless --blackhole-export flag", () => {
  let prevExitCode: number | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
    mkdirSync(testRoot, { recursive: true });
    prevExitCode = process.exitCode;
    process.exitCode = undefined;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    try {
      process.exitCode = prevExitCode;
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("registers a string flag named blackhole-export", () => {
    const { pi, flagName } = createFlagHarness(undefined);
    expect(flagName).toBe("blackhole-export");
    expect(pi.registerFlag).toHaveBeenCalledWith(
      "blackhole-export",
      expect.objectContaining({ type: "string" }),
    );
  });

  it("does nothing when the flag is absent", async () => {
    seedMemory();
    const { sessionStartHandler, ctx, pi } = createFlagHarness(undefined);
    expect(sessionStartHandler).toBeDefined();
    await sessionStartHandler({}, ctx);
    expect(readdirSync(projectCwd).filter((f) => f.endsWith(".md"))).toHaveLength(0);
    expect(ctx.shutdown).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("does nothing when the flag is an empty string", async () => {
    seedMemory();
    const { sessionStartHandler, ctx } = createFlagHarness("");
    await sessionStartHandler({}, ctx);
    expect(readdirSync(projectCwd).filter((f) => f.endsWith(".md"))).toHaveLength(0);
    expect(ctx.shutdown).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("runs the shared routine with the verbatim flag string, writes the file, then shuts down", async () => {
    seedMemory();
    const args = "days:7 mode:timeline out:headless-weekly.md";
    const { sessionStartHandler, ctx, pi } = createFlagHarness(args);
    await sessionStartHandler({}, ctx);
    const md = readFileSync(join(projectCwd, "headless-weekly.md"), "utf-8");
    expect(md).toContain("# Project memory timeline");
    expect(md).toContain("Headless probe fact");
    expect(ctx.shutdown).toHaveBeenCalledOnce();
    // Headless has no transcript to update, and the receipt must not litter
    // the session file on every cron run — the .md file is the artifact.
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    // The summary must reach a durable observable: headless has no TUI, so
    // the hook prints it to stdout for cron logs to capture.
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("headless-weekly.md"));
  });

  it("surfaces parse failures with a non-zero exit and no rejection", async () => {
    seedMemory();
    const { sessionStartHandler, ctx } = createFlagHarness("days:wat");
    await expect(sessionStartHandler({}, ctx)).resolves.toBeUndefined();
    expect(readdirSync(projectCwd).filter((f) => f.endsWith(".md"))).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    expect(ctx.shutdown).toHaveBeenCalledOnce();
  });

  it("runBlackholeExport reports parse errors without writing", async () => {
    seedMemory();
    const result = await runBlackholeExport("days:wat", {
      cwd: projectCwd,
      agentDir,
      notify: () => {},
      sendMessage: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("Invalid days");
    expect(readdirSync(projectCwd).filter((f) => f.endsWith(".md"))).toHaveLength(0);
  });

  it("runBlackholeExport tolerates a missing session-file lookup", async () => {
    seedMemory();
    const result = await runBlackholeExport("days:7 mode:timeline out:no-session-file.md", {
      cwd: projectCwd,
      agentDir,
      notify: () => {},
      sendMessage: () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.outPath).toContain("no-session-file.md");
    expect(readFileSync(join(projectCwd, "no-session-file.md"), "utf-8")).toContain(
      "Headless probe fact",
    );
  });
});
