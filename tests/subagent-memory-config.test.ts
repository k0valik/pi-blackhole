/**
 * subagentMemory config knob: defaults, file, and env precedence.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// Honor the vitest agent-dir isolation pin (tests/setup.ts) so the mocked
// host and the on-disk config resolve to the same place.
const testDir =
  process.env.PI_CODING_AGENT_DIR ??
  join(tmpdir(), `pi-blackhole-subagent-memory-config-${Date.now()}`);

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => testDir,
}));

function writeConfig(data: unknown): void {
  const path = join(testDir, "pi-blackhole", "pi-blackhole-config.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

const ENV_KEY = "PI_BLACKHOLE_SUBAGENT_MEMORY";

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
  delete process.env[ENV_KEY];
  delete process.env.PI_BLACKHOLE_MEMORY;
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env[ENV_KEY];
  delete process.env.PI_BLACKHOLE_MEMORY;
  vi.resetAllMocks();
});

describe("subagentMemory defaults", () => {
  it("defaults to off so subagents do not run OM after upgrade", async () => {
    const { loadUnifiedConfig, DEFAULTS } = await import("../src/core/unified-config.js");
    expect(DEFAULTS.subagentMemory).toBe("off");
    expect(loadUnifiedConfig(testDir).subagentMemory).toBe("off");
  });
});

describe("subagentMemory from file", () => {
  it("accepts inherit", async () => {
    writeConfig({ subagentMemory: "inherit" });
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    expect(loadUnifiedConfig(testDir).subagentMemory).toBe("inherit");
  });

  it("accepts off", async () => {
    writeConfig({ subagentMemory: "off" });
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    expect(loadUnifiedConfig(testDir).subagentMemory).toBe("off");
  });

  it("ignores an invalid value and keeps the default", async () => {
    writeConfig({ subagentMemory: "sometimes" });
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    expect(loadUnifiedConfig(testDir).subagentMemory).toBe("off");
  });
});

describe("subagentMemory from env", () => {
  it("PI_BLACKHOLE_SUBAGENT_MEMORY=inherit overrides the file", async () => {
    writeConfig({ subagentMemory: "off" });
    process.env[ENV_KEY] = "inherit";
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    expect(loadUnifiedConfig(testDir).subagentMemory).toBe("inherit");
  });

  it("PI_BLACKHOLE_SUBAGENT_MEMORY=OFF is case-insensitive", async () => {
    writeConfig({ subagentMemory: "inherit" });
    process.env[ENV_KEY] = "OFF";
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    expect(loadUnifiedConfig(testDir).subagentMemory).toBe("off");
  });

  it("an invalid env value is ignored", async () => {
    writeConfig({ subagentMemory: "inherit" });
    process.env[ENV_KEY] = "nope";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    expect(loadUnifiedConfig(testDir).subagentMemory).toBe("inherit");
    expect(warn).toHaveBeenCalledWith(
      'blackhole: invalid PI_BLACKHOLE_SUBAGENT_MEMORY value "nope"; ignoring',
    );
  });

  it("does not warn for an empty env value", async () => {
    writeConfig({ subagentMemory: "inherit" });
    process.env[ENV_KEY] = "   ";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    expect(loadUnifiedConfig(testDir).subagentMemory).toBe("inherit");
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("PI_BLACKHOLE_SUBAGENT_MEMORY"));
  });

  it("PI_BLACKHOLE_MEMORY=true does not re-enable memory for subagents", async () => {
    process.env.PI_BLACKHOLE_MEMORY = "true";
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    const config = loadUnifiedConfig(testDir);

    expect(config.memory).toBe(true);
    expect(config.subagentMemory).toBe("off");
  });
});
