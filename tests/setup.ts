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
// The pin is unconditional: a vitest process never trusts a filesystem path
// received from its environment. Pi exports the real ~/.pi/agent to every
// child process, so `pnpm test` started inside a Pi session inherits it (#202)
// — and several suites recursively delete their agent dir after each test. The
// inherited value is always discarded and replaced with a fresh mkdtemp dir
// under the OS temp folder. Suites that set their own temp agent dir in
// beforeEach/beforeAll still win for their own tests: the hooks below only pin
// while the variable is unset.

let pinnedDir: string | undefined;

/** Point PI_CODING_AGENT_DIR at an isolated dir; returns the pinned dir. */
function pinIsolatedAgentDir(): string {
  if (pinnedDir === undefined) {
    // Fail loudly instead of scaffolding if the OS temp dir itself sits inside
    // a real-layout agent dir (e.g. a runner pointed TMPDIR at ~/.pi/agent):
    // creating — and later deleting — scratch dirs there is exactly what must
    // never happen.
    if (!isSafeTestAgentDir(join(tmpdir(), "pi-blackhole-test-agent-probe"))) {
      throw new Error(`refusing to scaffold test agent dir: ${tmpdir()} is not a safe temp root`);
    }
    const dir = mkdtempSync(join(tmpdir(), "pi-blackhole-test-agent-"));
    process.once("exit", () => {
      rmSync(dir, { recursive: true, force: true });
    });
    pinnedDir = dir;
  }
  process.env.PI_CODING_AGENT_DIR = pinnedDir;
  return pinnedDir;
}

// Runs before any test-file hook, so overwriting here is safe: a file that sets
// its own agent dir in beforeEach/beforeAll still wins for its own tests. This
// also clears any value a previous test file in the same worker left behind.
const isolatedAgentDir = pinIsolatedAgentDir();

// Tripwire: if the pin ever fails to hold, abort the run before any test can
// reach the user's real config. The per-suite guard (tests/agent-dir-guard.ts)
// backs this up at the deletion sites; this catches it at the resolution site.
if (process.env.PI_CODING_AGENT_DIR !== isolatedAgentDir || !isSafeTestAgentDir(isolatedAgentDir)) {
  throw new Error(
    "agent-dir isolation is broken: the pinned test agent dir is not a safe " +
      "temp dir. Refusing to run tests that could reach the user's ~/.pi/agent.",
  );
}

// A test that saves/restores the variable by hand (deleting it in afterEach)
// would otherwise leave it unset for the rest of the file, sending later reads
// to the real home. Re-pin only while unset, so an explicit per-file value is
// never clobbered.
function ensureIsolatedAgentDir(): void {
  // Trim-check: getAgentDir() trims too, so a whitespace value would
  // otherwise fall through to the real home fallback.
  if (process.env.PI_CODING_AGENT_DIR?.trim()) return;
  pinIsolatedAgentDir();
}

beforeEach(ensureIsolatedAgentDir);
afterEach(ensureIsolatedAgentDir);
