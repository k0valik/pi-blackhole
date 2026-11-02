import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  EXTRA_MARKERS_ENV,
  ROOT_SESSIONS_ENV,
  SUBAGENT_ENV_MARKERS,
} from "../src/core/subagent-detector.js";

describe("test environment isolation", () => {
  it("does not inherit root session ancestry", () => {
    expect(process.env[ROOT_SESSIONS_ENV]).toBeUndefined();
  });

  it("does not inherit custom subagent marker configuration", () => {
    expect(process.env[EXTRA_MARKERS_ENV]).toBeUndefined();
  });

  it("clears inherited markers in a fresh Vitest process", () => {
    const result = spawnSync(
      process.execPath,
      [
        "./node_modules/vitest/vitest.mjs",
        "run",
        "tests/test-environment.test.ts",
        "-t",
        "does not inherit",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PI_SUBAGENT_CHILD: "1",
          [ROOT_SESSIONS_ENV]: "parent-session",
          [EXTRA_MARKERS_ENV]: "CUSTOM_CHILD_MARKER",
          CUSTOM_CHILD_MARKER: "1",
        },
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it.each(SUBAGENT_ENV_MARKERS.map(({ name }) => name))(
    "does not inherit the %s subagent marker",
    (name) => {
      expect(process.env[name]).toBeUndefined();
    },
  );
});
