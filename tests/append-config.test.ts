import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `pi-blackhole-append-config-${Date.now()}`);
const writeConfig = (data: unknown) => {
  const dir = join(testDir, "pi-blackhole");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pi-blackhole-config.json"), JSON.stringify(data, null, 2));
};

beforeEach(() => {
  process.env.PI_CODING_AGENT_DIR = testDir;
  mkdirSync(testDir, { recursive: true });
});
afterEach(() => {
  delete process.env.PI_BLACKHOLE_COMPACTION_SUMMARY_MODE;
  delete process.env.PI_BLACKHOLE_REFLECTIONS_POOL_MAX_TOKENS;
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

describe("reflection output configuration", () => {
  it.each([undefined, 12000, 0, -1, 1.5, "8000", null])(
    "runtime and modal agree on file value %s without rewriting cadence",
    async (value) => {
      const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
      const { config } = await import("../src/pi-base/blackhole-settings.js");
      writeConfig({
        reflectionsPoolMaxTokens: value,
        compactAfterTokens: 168000,
        custom: "keep",
      });
      const path = join(testDir, "pi-blackhole", "pi-blackhole-config.json");
      const before = readFileSync(path, "utf8");
      const expected = value === 12000 || value === 0 ? value : 8000;
      expect(loadUnifiedConfig(testDir).reflectionsPoolMaxTokens).toBe(expected);
      expect(config.load(testDir, join(testDir, "pi-blackhole")).reflectionsPoolMaxTokens).toBe(
        expected,
      );
      expect(loadUnifiedConfig(testDir).compactAfterTokens).toBe(168000);
      expect(readFileSync(path, "utf8")).toBe(before);
    },
  );

  it("project then env win in both loaders; scoped save preserves unrelated values", async () => {
    const { loadUnifiedConfig, saveUnifiedConfigScoped, DEFAULTS } =
      await import("../src/core/unified-config.js");
    const { config } = await import("../src/pi-base/blackhole-settings.js");
    writeConfig({ reflectionsPoolMaxTokens: 9000, compactAfterTokens: 168000 });
    mkdirSync(join(testDir, ".pi"), { recursive: true });
    writeFileSync(
      join(testDir, ".pi/pi-blackhole-config.json"),
      JSON.stringify({ reflectionsPoolMaxTokens: 11000, custom: "keep" }),
    );
    const readBoth = () => [
      loadUnifiedConfig(testDir),
      config.load(testDir, join(testDir, "pi-blackhole")),
    ];
    for (const cfg of readBoth()) expect(cfg.reflectionsPoolMaxTokens).toBe(11000);
    process.env.PI_BLACKHOLE_REFLECTIONS_POOL_MAX_TOKENS = "13000";
    for (const cfg of readBoth()) expect(cfg.reflectionsPoolMaxTokens).toBe(13000);
    for (const invalid of ["-1", "1.5", "Infinity", "invalid"]) {
      process.env.PI_BLACKHOLE_REFLECTIONS_POOL_MAX_TOKENS = invalid;
      for (const cfg of readBoth()) expect(cfg.reflectionsPoolMaxTokens).toBe(11000);
    }
    process.env.PI_BLACKHOLE_REFLECTIONS_POOL_MAX_TOKENS = "0";
    for (const cfg of readBoth()) expect(cfg.reflectionsPoolMaxTokens).toBe(0);
    delete process.env.PI_BLACKHOLE_REFLECTIONS_POOL_MAX_TOKENS;
    expect(saveUnifiedConfigScoped({ reflectionsPoolMaxTokens: 14000 }, "project", testDir)).toBe(
      true,
    );
    expect(
      JSON.parse(readFileSync(join(testDir, ".pi/pi-blackhole-config.json"), "utf8")),
    ).toMatchObject({ reflectionsPoolMaxTokens: 14000, custom: "keep" });
    for (const cfg of readBoth())
      expect(cfg).toMatchObject({
        reflectionsPoolMaxTokens: 14000,
        compactAfterTokens: 168000,
      });
    expect(DEFAULTS.compactAfterTokens).toBeUndefined();
    expect(DEFAULTS.compactAfterPreset).toBe("default");
  });
});
