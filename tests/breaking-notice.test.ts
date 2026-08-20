/**
 * Breaking-notice tests — one-time warning gating and persistence order
 * (plan-03 D10).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(
  tmpdir(),
  `pi-blackhole-breaking-notice-test-${Date.now()}`,
);

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => testDir,
  estimateTokens: () => 250,
}));

import {
  BREAKING_SINCE,
  registerBreakingNotice,
} from "../src/om/breaking-notice.js";

const statePath = join(testDir, "pi-blackhole", "last-seen-version.json");

function lastSeenVersion(): string | undefined {
  if (!existsSync(statePath)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(statePath, "utf-8"));
  return (parsed as { version?: string }).version;
}

type AgentStartHandler = (event: unknown, ctx: any) => void;

describe("registerBreakingNotice", () => {
  const handlers: Record<string, AgentStartHandler[]> = {};
  const fakePi = {
    on: (event: string, handler: AgentStartHandler) => {
      (handlers[event] ??= []).push(handler);
    },
  };

  function fireAgentStart(ctx: unknown): void {
    for (const h of handlers.agent_start ?? []) h({}, ctx);
  }

  beforeEach(() => {
    for (const k of Object.keys(handlers)) delete handlers[k];
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("does not persist the version on a headless run (notice repeats later)", () => {
    registerBreakingNotice(fakePi as any);
    fireAgentStart({});
    expect(existsSync(statePath)).toBe(false);
  });

  it("notifies once and persists only after the notice was shown", () => {
    const notify = vi.fn();
    registerBreakingNotice(fakePi as any);
    fireAgentStart({ hasUI: true, ui: { notify } });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toBe("warning");
    expect(lastSeenVersion()).toBe(BREAKING_SINCE);
    // Second start: version persisted → no repeat.
    fireAgentStart({ hasUI: true, ui: { notify } });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("does not notify when the last-seen version already crosses BREAKING_SINCE", () => {
    mkdirSync(join(testDir, "pi-blackhole"), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ version: BREAKING_SINCE }));
    const notify = vi.fn();
    registerBreakingNotice(fakePi as any);
    fireAgentStart({ hasUI: true, ui: { notify } });
    expect(notify).not.toHaveBeenCalled();
  });

  it("leaves no state behind when notify throws (stale ctx)", () => {
    const notify = vi.fn(() => {
      throw new Error("stale context");
    });
    registerBreakingNotice(fakePi as any);
    expect(() => fireAgentStart({ hasUI: true, ui: { notify } })).not.toThrow();
    expect(existsSync(statePath)).toBe(false);
  });
});
