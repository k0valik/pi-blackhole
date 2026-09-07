/**
 * Regression test: openSettings must forward globalConfigDir through the
 * canonical config-flow, not the removed openSettingsModal path.
 *
 * In the canonical flow, configDir is threaded through layerValues/inspect/
 * save/resetScope/deleteScope callbacks rather than passed as a modal option.
 */

import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const capturedParams = vi.hoisted<Record<string, unknown>[]>(() => []);

vi.mock("../src/pi-base/settings/config-flow.js", () => ({
  openConfigFlow: async (params: unknown) => {
    capturedParams.push(params as Record<string, unknown>);
    // Do not actually mount a UI; just resolve.
  },
}));

import { ConfigManager } from "../src/pi-base/config-manager.js";

const testDir = join(tmpdir(), `pi-blackhole-modal-test-${Date.now()}`);

const DEFAULTS = {
  compaction: "auto",
  compactAfterTokens: 81_000,
  observeAfterTokens: 15_000,
  memory: true,
} as const;

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = testDir;
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
});

describe("openSettings configDir forwarding (canonical config-flow)", () => {
  beforeEach(() => {
    capturedParams.length = 0;
  });

  it("forwards the ConfigManager configDir through openConfigFlow callbacks", async () => {
    const cm = new ConfigManager<Record<string, unknown>>({
      id: "test",
      label: "test",
      filename: "pi-blackhole-config.json",
      defaults: DEFAULTS,
      fields: () => [],
    });

    const configDir = join(testDir, "pi-blackhole");
    await cm.openSettings(
      { cwd: testDir, ui: { notify: vi.fn() } } as any,
      testDir,
      () => {},
      configDir,
    );

    expect(capturedParams).toHaveLength(1);
    const params = capturedParams[0];

    // The callbacks that consume configDir must reference it.
    expect(typeof params.layerValues).toBe("function");
    expect(typeof params.save).toBe("function");
    expect(typeof params.scopeSources).toBe("function");

    // layerValues should be able to resolve a global scope path under configDir.
    const globalValues = await params.layerValues("global");
    expect(globalValues).toEqual(expect.objectContaining(DEFAULTS));
  });

  it("openBlackholeSettings resolves GLOBAL_CONFIG_DIR under the agent dir", async () => {
    const { openBlackholeSettings } = await import("../src/pi-base/blackhole-settings.js");

    await openBlackholeSettings({
      cwd: testDir,
      ui: { notify: vi.fn() },
    } as any);

    expect(capturedParams).toHaveLength(1);
    const params = capturedParams[0];

    // Verify the callbacks are wired (same as above).
    expect(typeof params.layerValues).toBe("function");
    expect(typeof params.save).toBe("function");
  });

  it("validates retainedToolOutputMaxTokens through ConfigManager", async () => {
    const { config, GLOBAL_CONFIG_DIR } = await import("../src/pi-base/blackhole-settings.js");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
    writeFileSync(
      join(GLOBAL_CONFIG_DIR, "pi-blackhole-config.json"),
      JSON.stringify({ retainedToolOutputMaxTokens: 0 }),
    );

    expect(config.load(testDir, GLOBAL_CONFIG_DIR).retainedToolOutputMaxTokens).toBe(20_000);
  });
});

describe("window-derived threshold fields in the settings modal (issue #60)", () => {
  it("always exposes compactAfterRatio and compactReserveTokens rows (0 = not set)", async () => {
    const { config } = await import("../src/pi-base/blackhole-settings.js");
    const { DEFAULTS } = await import("../src/core/unified-config.js");

    const base = { ...DEFAULTS } as Record<string, unknown>;
    const unsetFields = config.opts.fields(base as never);
    const ratio = unsetFields.find((f: { key: string }) => f.key === "compactAfterRatio");
    const reserve = unsetFields.find((f: { key: string }) => f.key === "compactReserveTokens");

    expect(ratio).toBeDefined();
    expect(reserve).toBeDefined();
    // Unset values surface as 0 (the modal's "off" convention), not hidden.
    expect(ratio.value).toBe(0);
    expect(ratio.min).toBe(0);
    expect(ratio.max).toBe(1);
    expect(reserve.value).toBe(0);
    expect(reserve.min).toBe(0);
    expect(reserve.max).toBe(2_000_000);

    // Configured values surface verbatim for editing.
    base.compactAfterRatio = 0.65;
    base.compactReserveTokens = 32_768;
    const setFields = config.opts.fields(base as never);
    expect(setFields.find((f: { key: string }) => f.key === "compactAfterRatio").value).toBe(0.65);
    expect(setFields.find((f: { key: string }) => f.key === "compactReserveTokens").value).toBe(
      32_768,
    );
  });

  it("persists ratio/reserve edits through ConfigManager.save (keys are DEFAULTS members)", async () => {
    // Regression: ConfigManager.save() diffs against Object.keys(DEFAULTS), so
    // the window-derived knobs must be DEFAULTS members or a UI edit would be
    // silently dropped and never reach the config file.
    const { config } = await import("../src/pi-base/blackhole-settings.js");
    const { DEFAULTS } = await import("../src/core/unified-config.js");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    const cfgDir = join(testDir, "pi-blackhole-save");
    mkdirSync(cfgDir, { recursive: true });

    const cfg = { ...DEFAULTS, compactAfterRatio: 0.65, compactReserveTokens: 32_768 } as Record<
      string,
      unknown
    >;
    config.save(cfg as never, "global", undefined, cfgDir);

    const written = JSON.parse(
      readFileSync(join(cfgDir, "pi-blackhole-config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(written.compactAfterRatio).toBe(0.65);
    expect(written.compactReserveTokens).toBe(32_768);

    // Untouched knobs are NOT written as 0 — only real edits land in the file.
    const cfg2 = { ...DEFAULTS } as Record<string, unknown>;
    config.save(cfg2 as never, "global", undefined, cfgDir);
    const written2 = JSON.parse(
      readFileSync(join(cfgDir, "pi-blackhole-config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect("compactAfterRatio" in written2).toBe(false);
    expect("compactReserveTokens" in written2).toBe(false);
  });
});

describe("preset-curve select + hand-edited preset definitions (window curve)", () => {
  it("exposes the compactAfterPreset select with built-in + user preset names", async () => {
    const { config } = await import("../src/pi-base/blackhole-settings.js");
    const { DEFAULTS } = await import("../src/core/unified-config.js");

    const base = { ...DEFAULTS } as Record<string, unknown>;
    const fields = config.opts.fields(base as never);
    const select = fields.find((f: { key: string }) => f.key === "compactAfterPreset");
    expect(select).toBeDefined();
    expect(select.type).toBe("enum");
    // Built-in "default" preset is always offered; default value governs.
    expect(select.options).toContain("default");
    expect(select.value).toBe("default");

    // A user-added preset name joins the options (same merge the resolver uses).
    base.compactAfterPresets = { "early-1m": [{ window: 131_072, ratio: 0.6 }] };
    const fields2 = config.opts.fields(base as never);
    const select2 = fields2.find((f: { key: string }) => f.key === "compactAfterPreset");
    expect(select2.options).toEqual(["default", "early-1m"]);
  });

  it("compactAfterPresets is NOT a DEFAULTS member (save() must carry it verbatim)", async () => {
    const { DEFAULTS } = await import("../src/core/unified-config.js");
    expect(Object.keys(DEFAULTS)).not.toContain("compactAfterPresets");
  });

  it("persists a knob edit whose definition exists in the file; definitions survive verbatim", async () => {
    const { config } = await import("../src/pi-base/blackhole-settings.js");
    const { DEFAULTS } = await import("../src/core/unified-config.js");
    const { writeFileSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    const cfgDir = join(testDir, "pi-blackhole-preset-save");
    const mkdir = await import("node:fs");
    mkdir.mkdirSync(cfgDir, { recursive: true });
    const file = join(cfgDir, "pi-blackhole-config.json");

    // User hand-added a preset definition to the file; the modal loads it.
    const defs = { "early-1m": [{ window: 131_072, ratio: 0.6 }] };
    writeFileSync(file, JSON.stringify({ compactAfterPresets: defs }, null, 2));

    // Modal selects "early-1m" (valid: it is in the effective option list).
    const modalCfg = {
      ...DEFAULTS,
      compactAfterPreset: "early-1m",
      compactAfterPresets: defs,
    } as Record<string, unknown>;
    config.save(modalCfg as never, "global", undefined, cfgDir);

    const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(written.compactAfterPreset).toBe("early-1m");
    // The hand-edited definition is preserved byte-for-byte (no normalization).
    expect(written.compactAfterPresets).toEqual(defs);
  });

  it("a stale modal snapshot cannot clobber a mid-modal hand edit (R1)", async () => {
    const { config } = await import("../src/pi-base/blackhole-settings.js");
    const { DEFAULTS } = await import("../src/core/unified-config.js");
    const { writeFileSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    const cfgDir = join(testDir, "pi-blackhole-preset-preserve");
    const mkdir = await import("node:fs");
    mkdir.mkdirSync(cfgDir, { recursive: true });
    const file = join(cfgDir, "pi-blackhole-config.json");

    const v1 = { "early-1m": [{ window: 131_072, ratio: 0.6 }] };
    writeFileSync(file, JSON.stringify({ compactAfterPresets: v1 }, null, 2));
    // Modal snapshot taken at open (carries v1), then the user hand-edits the
    // file WHILE the modal is open:
    const v2 = {
      "early-1m": [{ window: 262_144, ratio: 0.55 }],
      default: [{ window: 32_768, ratio: 0.85 }],
    };
    writeFileSync(file, JSON.stringify({ compactAfterPresets: v2 }, null, 2));

    // …and saves an unrelated field (ratio). save() re-reads the file, so the
    // hand edit must survive; the stale v1 snapshot must NOT be written back.
    const modalCfg = { ...DEFAULTS, compactAfterRatio: 0.5 } as Record<string, unknown>;
    config.save(modalCfg as never, "global", undefined, cfgDir);

    const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(written.compactAfterPresets).toEqual(v2);
    expect(written.compactAfterRatio).toBe(0.5);
  });
});
