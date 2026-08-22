import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `pi-blackhole-append-config-${Date.now()}`);
const writeConfig = (data: unknown) => {
  const dir = join(testDir, "pi-blackhole");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "pi-blackhole-config.json"),
    JSON.stringify(data, null, 2),
  );
};

beforeEach(() => {
  process.env.PI_CODING_AGENT_DIR = testDir;
  mkdirSync(testDir, { recursive: true });
});
afterEach(() => {
  delete process.env.PI_BLACKHOLE_COMPACTION_SUMMARY_MODE;
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(testDir, { recursive: true, force: true });
});

describe("compactionSummaryMode configuration", () => {
  it("defaults to default", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    expect(loadUnifiedConfig(testDir).compactionSummaryMode).toBe("default");
  });

  it("accepts append from the unified config", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ compactionSummaryMode: "append" });
    expect(loadUnifiedConfig(testDir).compactionSummaryMode).toBe("append");
  });

  it("ignores an invalid file value and keeps the default", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ compactionSummaryMode: "unsafe" });
    expect(loadUnifiedConfig(testDir).compactionSummaryMode).toBe("default");
  });

  it("lets the environment override the file", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ compactionSummaryMode: "default" });
    process.env.PI_BLACKHOLE_COMPACTION_SUMMARY_MODE = "append";
    expect(loadUnifiedConfig(testDir).compactionSummaryMode).toBe("append");
  });

  it("ignores an invalid environment value", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ compactionSummaryMode: "append" });
    process.env.PI_BLACKHOLE_COMPACTION_SUMMARY_MODE = "unsafe";
    expect(loadUnifiedConfig(testDir).compactionSummaryMode).toBe("append");
  });
});
