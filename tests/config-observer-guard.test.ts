/**
 * Tier-1 config guard (work_docs/plan-observer-coverage-completion.md).
 *
 * When `observeAfterTokens` exceeds `observerChunkMaxTokens`, no single batch
 * can hold a trigger-worth of content: every observation cycle runs capped and
 * drained across batches. That combination is loss-free after the F1 drain, so
 * the loader WARNS (via onWarn, falling back to console.warn) instead of
 * silently clamping the user's threshold.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testDir = join(tmpdir(), `pi-blackhole-observer-guard-${Date.now()}`);

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => testDir,
}));

function writeConfig(data: unknown): void {
  const path = join(testDir, "pi-blackhole", "pi-blackhole-config.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("observer threshold config guard", () => {
  it("warns through onWarn when observeAfterTokens exceeds observerChunkMaxTokens", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ observeAfterTokens: 90_000, observerChunkMaxTokens: 10_000 });
    const warn = vi.fn();

    loadUnifiedConfig(testDir, warn);

    // T4: the message must name BOTH keys so it is traceable to this guard.
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain("observeAfterTokens");
    expect(msg).toContain("observerChunkMaxTokens");
  });

  it("keeps both user values untouched — warn, not clamp", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ observeAfterTokens: 90_000, observerChunkMaxTokens: 10_000 });

    const config = loadUnifiedConfig(testDir, vi.fn());

    expect(config.observeAfterTokens).toBe(90_000);
    expect(config.observerChunkMaxTokens).toBe(10_000);
  });

  it("does not warn when observeAfterTokens equals observerChunkMaxTokens", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ observeAfterTokens: 10_000, observerChunkMaxTokens: 10_000 });
    const warn = vi.fn();

    loadUnifiedConfig(testDir, warn);

    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn when observeAfterTokens is below observerChunkMaxTokens", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ observeAfterTokens: 5_000, observerChunkMaxTokens: 10_000 });
    const warn = vi.fn();

    loadUnifiedConfig(testDir, warn);

    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to console.warn when no onWarn is provided", async () => {
    const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
    writeConfig({ observeAfterTokens: 90_000, observerChunkMaxTokens: 10_000 });
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    loadUnifiedConfig(testDir);

    expect(spy).toHaveBeenCalledTimes(1);
    const msg = String(spy.mock.calls[0][0]);
    expect(msg).toContain("observeAfterTokens");
    expect(msg).toContain("observerChunkMaxTokens");
  });
});
