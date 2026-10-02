/**
 * Cooldown fold-on-read: files written before modelKey normalization keep
 * case-preserved keys. A still-active legacy entry must cool the folded
 * lookup (not be silently retried), and an expired legacy entry must be
 * lazily deleted rather than lingering under its stale key.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `pi-blackhole-cooldown-fold-${Date.now()}`);

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => testDir,
  estimateTokens: () => 250,
}));

import { isCooldownActive } from "../src/om/cooldown.js";

function writeCooldownFile(data: Record<string, unknown>): void {
  mkdirSync(join(testDir, "pi-blackhole"), { recursive: true });
  writeFileSync(
    join(testDir, "pi-blackhole", "pi-blackhole-cooldown.json"),
    JSON.stringify(data, null, 2),
  );
}

const model = {
  id: "gpt-4",
  name: "gpt-4",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
} as any;

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("cooldown fold-on-read", () => {
  it("honors an active legacy mixed-case entry", () => {
    writeCooldownFile({
      "OpenAI/GPT-4": {
        until: new Date(Date.now() + 3_600_000).toISOString(),
        reason: "429",
        stage: "observer",
      },
    });
    expect(isCooldownActive(model)).toBe(true);
  });

  it("lazily deletes an expired legacy entry instead of lingering", async () => {
    writeCooldownFile({
      "OpenAI/GPT-4": {
        until: new Date(Date.now() - 3_600_000).toISOString(),
        reason: "429",
        stage: "observer",
      },
    });
    expect(isCooldownActive(model)).toBe(false);
    const { readFileSync } = await import("node:fs");
    const raw = JSON.parse(
      readFileSync(join(testDir, "pi-blackhole", "pi-blackhole-cooldown.json"), "utf-8"),
    );
    expect(raw["OpenAI/GPT-4"]).toBeUndefined();
  });
});
