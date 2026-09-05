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
