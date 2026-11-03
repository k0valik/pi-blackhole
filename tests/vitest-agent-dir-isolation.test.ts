/**
 * Guards the vitest agent-dir isolation contract.
 *
 * `getAgentDir()` (src/core/unified-config.ts) honors PI_CODING_AGENT_DIR and
 * otherwise falls back to the host's ~/.pi/agent. Unlike pi-base's
 * `getExtensionsDir()`, it does NOT self-isolate under vitest, so
 * tests/setup.ts must pin the variable to a per-process temp dir.
 *
 * Without that pinning, any test that forgets `__setTestConfigDir()` or an
 * explicit `configDir` resolves `configPath()` into the developer's real
 * ~/.pi/agent — reading their settings and, via scaffoldConfig(), writing
 * DEFAULTS over them. A fresh install or test run must never be able to
 * replace an existing user config.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configPath, getAgentDir, scaffoldConfig } from "../src/core/unified-config.js";

const REAL_AGENT_DIR = join(homedir(), ".pi", "agent");

describe("vitest agent-dir isolation", () => {
  it("pins PI_CODING_AGENT_DIR to a temp dir when the runner left it unset", () => {
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    expect(agentDir).toBeTypeOf("string");
    expect(agentDir?.startsWith(tmpdir())).toBe(true);
  });

  it("resolves the agent dir away from the real home", () => {
    expect(getAgentDir()).not.toBe(REAL_AGENT_DIR);
    expect(getAgentDir().startsWith(tmpdir())).toBe(true);
  });

  it("resolves the config path away from the real home", () => {
    expect(configPath().startsWith(REAL_AGENT_DIR)).toBe(false);
  });

  it("scaffolding without a test-dir override never touches the real config", () => {
    const realConfig = join(REAL_AGENT_DIR, "pi-blackhole", "pi-blackhole-config.json");
    const before = existsSync(realConfig) ? readFileSync(realConfig) : null;

    // Prove the scaffold lands somewhere we own *before* calling it. This test
    // deliberately performs no destructive filesystem operation at all: the
    // previous version cleaned up with rmSync(configPath()), which deleted a
    // real user config the moment the isolation pin was absent. If the path is
    // not provably ours, fail here rather than write anywhere.
    const scaffolded = configPath();
    if (!scaffolded.startsWith(tmpdir() + "/") || scaffolded === realConfig) {
      throw new Error(`refusing to scaffold: ${scaffolded} is not under ${tmpdir()}`);
    }

    scaffoldConfig();

    expect(existsSync(scaffolded)).toBe(true);
    // The developer's file is neither created nor rewritten.
    expect(existsSync(realConfig) ? readFileSync(realConfig) : null).toEqual(before);
  });
});
