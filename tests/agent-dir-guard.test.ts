/**
 * Tests for the test-only agent-dir guard (tests/agent-dir-guard.ts) that
 * keeps suites from writing to or deleting a real ~/.pi/agent inherited from
 * a Pi session through PI_CODING_AGENT_DIR.
 */

import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertSafeTestAgentDir, isSafeTestAgentDir } from "./agent-dir-guard.js";

const REAL_AGENT_DIR = join(homedir(), ".pi", "agent");
const OUTSIDE_DIR = join(parse(resolve(tmpdir())).root, "pi-blackhole-outside-agent");

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-blackhole-guard-"));
  cleanup.push(dir);
  return dir;
}

describe("isSafeTestAgentDir", () => {
  it("rejects paths outside the temp dir", () => {
    expect(isSafeTestAgentDir(OUTSIDE_DIR)).toBe(false);
    if (!resolve(REAL_AGENT_DIR).startsWith(resolve(tmpdir()) + sep)) {
      expect(isSafeTestAgentDir(REAL_AGENT_DIR)).toBe(false);
    }
  });

  it("rejects unset and empty values", () => {
    expect(isSafeTestAgentDir(undefined)).toBe(false);
    expect(isSafeTestAgentDir("")).toBe(false);
  });

  it("rejects the temp root itself", () => {
    expect(isSafeTestAgentDir(tmpdir())).toBe(false);
  });

  it("accepts existing and not-yet-created dirs inside the temp dir", () => {
    const dir = scratch();
    expect(isSafeTestAgentDir(dir)).toBe(true);
    expect(isSafeTestAgentDir(join(dir, "not-created-yet"))).toBe(true);
  });

  it("rejects paths that only look like they are under the temp dir", () => {
    expect(isSafeTestAgentDir(`${tmpdir()}-sibling/agent`)).toBe(false);
    expect(isSafeTestAgentDir(join(tmpdir(), "..", "agent"))).toBe(false);
  });

  it("rejects real-layout .pi/agent paths even under the temp root", () => {
    const dir = scratch();
    expect(isSafeTestAgentDir(join(dir, ".pi", "agent"))).toBe(false);
    expect(isSafeTestAgentDir(join(dir, ".pi", "agent", "pi-blackhole"))).toBe(false);
    expect(isSafeTestAgentDir(join(dir, ".pi", "other-pi-state"))).toBe(false);
    expect(isSafeTestAgentDir(join(dir, "agent"))).toBe(true);
    expect(isSafeTestAgentDir(join(dir, "pi-blackhole-test-agent-x"))).toBe(true);
  });

  it("rejects a symlink in the temp dir (and missing children beneath it) that points outside", () => {
    const outer = scratch();
    const innerTmp = join(outer, "tmp");
    const outsideTarget = join(outer, "outside");
    mkdirSync(innerTmp);
    mkdirSync(outsideTarget);
    const link = join(innerTmp, "agent");
    symlinkSync(outsideTarget, link);
    expect(isSafeTestAgentDir(link, innerTmp)).toBe(false);
    expect(isSafeTestAgentDir(join(link, "missing-child"), innerTmp)).toBe(false);
  });

  it("honors an explicit temp root", () => {
    const root = scratch();
    const innerTmp = join(root, "tmp");
    mkdirSync(innerTmp);
    mkdirSync(join(innerTmp, "agent"));
    expect(isSafeTestAgentDir(join(innerTmp, "agent"), innerTmp)).toBe(true);
    expect(isSafeTestAgentDir(join(root, "outside"), innerTmp)).toBe(false);
  });
});

describe("assertSafeTestAgentDir", () => {
  it("throws for an outside dir instead of letting a suite delete it", () => {
    expect(() => assertSafeTestAgentDir(OUTSIDE_DIR)).toThrow(/refusing to use test agent dir/);
  });

  it("returns a safe dir unchanged", () => {
    const dir = scratch();
    expect(assertSafeTestAgentDir(dir)).toBe(dir);
  });
});
