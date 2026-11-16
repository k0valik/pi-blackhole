/**
 * Guards the vitest agent-dir isolation contract.
 *
 * `getAgentDir()` (src/core/unified-config.ts) honors PI_CODING_AGENT_DIR and
 * otherwise falls back to the host's ~/.pi/agent. Unlike pi-base's
 * `getExtensionsDir()`, it does NOT self-isolate under vitest, so
 * tests/setup.ts unconditionally pins the variable to a per-process temp dir.
 * A vitest process never trusts a filesystem path from its environment: Pi
 * exports the real ~/.pi/agent to every child process, so a run started inside
 * a Pi session inherits it (#202) — and several suites delete their agent dir
 * after each test.
 *
 * Without that pinning, any test that forgets `__setTestConfigDir()` or an
 * explicit `configDir` resolves `configPath()` into the developer's real
 * ~/.pi/agent — reading their settings and, via scaffoldConfig(), writing
 * DEFAULTS over them. A fresh install or test run must never be able to
 * replace an existing user config. This file never touches or reads the real
 * home: every assertion is path-based.
 */

import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configPath, getAgentDir, scaffoldConfig } from "../src/core/unified-config.js";

const REAL_AGENT_DIR = join(homedir(), ".pi", "agent");

describe("vitest agent-dir isolation", () => {
  it("pins PI_CODING_AGENT_DIR to a temp dir regardless of inherited value", () => {
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    expect(agentDir).toBeTypeOf("string");
    expect(agentDir?.startsWith(tmpdir())).toBe(true);
    expect(agentDir).not.toBe(REAL_AGENT_DIR);
  });

  it("resolves the agent dir away from the real home", () => {
    expect(getAgentDir()).not.toBe(REAL_AGENT_DIR);
    expect(getAgentDir().startsWith(tmpdir())).toBe(true);
  });

  it("resolves the config path away from the real home", () => {
    expect(configPath().startsWith(REAL_AGENT_DIR)).toBe(false);
  });

  it("scaffolding without a test-dir override never touches the real config", () => {
    // Prove the scaffold lands somewhere we own *before* calling it. This test
    // performs no destructive filesystem operation — and, per the isolation
    // contract, it does not read the real home either: the path check alone
    // guarantees the real config cannot be affected. (Earlier versions read
    // the real file to compare contents, and an even earlier one cleaned up
    // with rmSync(configPath()), which deleted a real user config the moment
    // the isolation pin was absent.) If the path is not provably ours, fail
    // here rather than write anywhere.
    const realConfigPath = join(REAL_AGENT_DIR, "pi-blackhole", "pi-blackhole-config.json");
    const scaffolded = configPath();
    if (!scaffolded.startsWith(tmpdir() + "/") || scaffolded === realConfigPath) {
      throw new Error(`refusing to scaffold: ${scaffolded} is not under ${tmpdir()}`);
    }

    scaffoldConfig();

    expect(existsSync(scaffolded)).toBe(true);
  });
});
