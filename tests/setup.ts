import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import {
  EXTRA_MARKERS_ENV,
  ROOT_SESSIONS_ENV,
  SUBAGENT_ENV_MARKERS,
} from "../src/core/subagent-detector.js";
import { isSafeTestAgentDir } from "./agent-dir-guard.js";

// Tests start as a normal session even when Vitest was launched by a Pi child.
// Individual tests can still set these markers to exercise subagent detection.
for (const { name } of SUBAGENT_ENV_MARKERS) delete process.env[name];
delete process.env[ROOT_SESSIONS_ENV];
delete process.env[EXTRA_MARKERS_ENV];

// ── Agent-dir isolation ──────────────────────────────────────────────────────
//
// unified-config's getAgentDir() honors PI_CODING_AGENT_DIR and otherwise falls
// back to the host's ~/.pi/agent. Unlike pi-base's getExtensionsDir(), it does
// NOT self-isolate under vitest, so a test that forgets __setTestConfigDir() or
// an explicit configDir would read the developer's real config and, through
// scaffoldConfig(), write DEFAULTS over it. A fresh install or test run must
// never be able to replace an existing user config.
//
// Contract: keep a runner-supplied value only when it is inside the OS temp
// dir. Pi exports PI_CODING_AGENT_DIR (normally ~/.pi/agent) to every child
// process, so `pnpm test` started by a Pi agent inherits the user's real agent
// dir — and several suites recursively delete their agent dir after each test.
// Any other inherited value is ignored and replaced with an isolated temp dir.

// The runner's value has to survive across test files, but module state does
// not (vitest re-evaluates this setup file per test file), so keep it on the
// worker's globalThis instead.
const runnerState = globalThis as { __piBlackholeRunnerAgentDir?: string };
if (!("__piBlackholeRunnerAgentDir" in runnerState)) {
  const inherited = process.env.PI_CODING_AGENT_DIR;
  runnerState.__piBlackholeRunnerAgentDir =
    inherited && isSafeTestAgentDir(inherited) ? inherited : "";
}
const runnerAgentDir = runnerState.__piBlackholeRunnerAgentDir || undefined;

let pinnedDir: string | undefined;

/** Point PI_CODING_AGENT_DIR at an isolated dir, reusing this file's pin. */
function pinIsolatedAgentDir(): void {
  if (pinnedDir === undefined) {
    const dir = mkdtempSync(join(tmpdir(), "pi-blackhole-test-agent-"));
    process.once("exit", () => {
      rmSync(dir, { recursive: true, force: true });
    });
    pinnedDir = dir;
  }
  process.env.PI_CODING_AGENT_DIR = pinnedDir;
}

// Runs before any test-file hook, so overwriting here is safe: a file that sets
// its own agent dir in beforeEach/beforeAll still wins for its own tests. This
// also clears any value a previous test file in the same worker left behind.
if (runnerAgentDir === undefined) {
  pinIsolatedAgentDir();
}

// A test that saves/restores the variable by hand (deleting it in afterEach)
// would otherwise leave it unset for the rest of the file, sending later reads
// to the real home. Re-pin only while unset, so an explicit per-file value is
// never clobbered.
function ensureIsolatedAgentDir(): void {
  if (process.env.PI_CODING_AGENT_DIR) return;
  if (runnerAgentDir === undefined) pinIsolatedAgentDir();
}

beforeEach(ensureIsolatedAgentDir);
afterEach(ensureIsolatedAgentDir);
