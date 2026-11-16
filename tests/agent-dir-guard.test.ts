/**
 * Tests for the test-only agent-dir guard (tests/agent-dir-guard.ts) that
 * keeps suites from writing to or deleting a real ~/.pi/agent inherited from
 * a Pi session through PI_CODING_AGENT_DIR.
 */

import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertSafeTestAgentDir, isSafeTestAgentDir } from "./agent-dir-guard.js";

const REAL_AGENT_DIR = join(homedir(), ".pi", "agent");

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
  it("rejects the user's real agent dir", () => {
    expect(isSafeTestAgentDir(REAL_AGENT_DIR)).toBe(false);
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

  it("rejects a symlink in the temp dir that points outside it", () => {
    const root = scratch();
    const link = join(root, "agent");
    // Points at the home dir without writing anything there.
    symlinkSync(homedir(), link);
    expect(isSafeTestAgentDir(link)).toBe(false);
  });

  it("honors an explicit temp root", () => {
    const root = scratch();
    mkdirSync(join(root, "agent"));
    expect(isSafeTestAgentDir(join(root, "agent"), root)).toBe(true);
    expect(isSafeTestAgentDir(REAL_AGENT_DIR, root)).toBe(false);
  });
});

describe("assertSafeTestAgentDir", () => {
  it("throws for the real agent dir instead of letting a suite delete it", () => {
    expect(() => assertSafeTestAgentDir(REAL_AGENT_DIR)).toThrow(/refusing to use test agent dir/);
  });

  it("returns a safe dir unchanged", () => {
    const dir = scratch();
    expect(assertSafeTestAgentDir(dir)).toBe(dir);
  });
});
