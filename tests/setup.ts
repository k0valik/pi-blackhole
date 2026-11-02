import {
  EXTRA_MARKERS_ENV,
  ROOT_SESSIONS_ENV,
  SUBAGENT_ENV_MARKERS,
} from "../src/core/subagent-detector.js";

// Tests start as a normal session even when Vitest was launched by a Pi child.
// Individual tests can still set these markers to exercise subagent detection.
for (const { name } of SUBAGENT_ENV_MARKERS) delete process.env[name];
delete process.env[ROOT_SESSIONS_ENV];
delete process.env[EXTRA_MARKERS_ENV];
