/** Per-cause cooldown duration and persistence policy. */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = join(tmpdir(), `pi-blackhole-cooldown-policy-${Date.now()}`);

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => testDir,
}));

import {
  DEFAULT_TRANSIENT_COOLDOWN_MINUTES,
  cooldownDurationMs,
  recordCooldown,
} from "../src/om/cooldown.js";
import type { CooldownCause } from "../src/om/retryable-error.js";

const file = join(testDir, "pi-blackhole", "pi-blackhole-cooldown.json");
const identity = { provider: "probe", id: "compactor" };
const key = "probe/compactor";
const now = new Date("2026-11-21T00:00:00.000Z");

function cooldowns(): Record<
  string,
  { until: string; reason: string; stage: string; cause?: string }
> {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(testDir, { recursive: true, force: true });
});

describe("cooldownDurationMs", () => {
  test("defaults transient failures to five minutes", () => {
    expect(DEFAULT_TRANSIENT_COOLDOWN_MINUTES).toBe(5);
    expect(cooldownDurationMs(identity, "provider_transient")).toBe(5 * 60_000);
  });

  test("honors a per-model transient duration", () => {
    expect(
      cooldownDurationMs({ ...identity, cooldownMinutesTransient: 12 }, "provider_transient"),
    ).toBe(12 * 60_000);
  });

  test("transient duration 0 means in-cycle only", () => {
    expect(
      cooldownDurationMs({ ...identity, cooldownMinutesTransient: 0 }, "provider_transient"),
    ).toBeUndefined();
  });

  test("rate-limit, configuration and unknown causes use cooldownHours", () => {
    for (const cause of ["provider_rate_limit", "provider_configuration", "unknown"] as const) {
      expect(cooldownDurationMs(identity, cause)).toBe(3_600_000);
      expect(cooldownDurationMs({ ...identity, cooldownHours: 4 }, cause)).toBe(4 * 3_600_000);
    }
  });

  test("non-persistent causes return undefined", () => {
    for (const cause of ["local_execution", "request_local", "content_refusal"] as const) {
      expect(cooldownDurationMs(identity, cause)).toBeUndefined();
    }
  });

  test("cooldownHours 0 is the master kill switch for every cause", () => {
    const disabled = { ...identity, cooldownHours: 0, cooldownMinutesTransient: 30 };
    const causes: CooldownCause[] = [
      "provider_transient",
      "provider_rate_limit",
      "provider_configuration",
      "unknown",
    ];
    for (const cause of causes) expect(cooldownDurationMs(disabled, cause)).toBeUndefined();
  });
});

describe("recordCooldown persistence", () => {
  test("writes the transient duration and cause", () => {
    recordCooldown(identity, "HTTP 503 Service Unavailable", "observer", "provider_transient");
    expect(cooldowns()[key]).toEqual({
      until: "2026-11-21T00:05:00.000Z",
      reason: "HTTP 503 Service Unavailable",
      stage: "observer",
      cause: "provider_transient",
    });
  });

  test("does not shorten an active longer cooldown", () => {
    recordCooldown(
      { ...identity, cooldownHours: 2 },
      "429 Too Many Requests",
      "observer",
      "provider_rate_limit",
    );
    recordCooldown(identity, "HTTP 503 Service Unavailable", "observer", "provider_transient");
    expect(cooldowns()[key]).toEqual({
      until: "2026-11-21T02:00:00.000Z",
      reason: "429 Too Many Requests",
      stage: "observer",
      cause: "provider_rate_limit",
    });
  });

  test("extends a shorter active cooldown", () => {
    recordCooldown(identity, "HTTP 503 Service Unavailable", "observer", "provider_transient");
    recordCooldown(
      { ...identity, cooldownHours: 2 },
      "429 Too Many Requests",
      "dropper",
      "provider_rate_limit",
    );
    expect(cooldowns()[key]).toEqual({
      until: "2026-11-21T02:00:00.000Z",
      reason: "429 Too Many Requests",
      stage: "dropper",
      cause: "provider_rate_limit",
    });
  });

  test("transient duration 0 does not write", () => {
    recordCooldown(
      { ...identity, cooldownMinutesTransient: 0 },
      "HTTP 503 Service Unavailable",
      "observer",
      "provider_transient",
    );
    expect(cooldowns()).toEqual({});
  });

  test("keeps legacy entries without a cause readable and expires them lazily", () => {
    mkdirSync(join(testDir, "pi-blackhole"), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        [key]: {
          until: "2026-11-21T01:00:00.000Z",
          reason: "legacy",
          stage: "observer",
        },
      }),
    );
    recordCooldown(identity, "HTTP 503 Service Unavailable", "observer", "provider_transient");
    expect(cooldowns()[key]?.reason).toBe("legacy");
  });
});
